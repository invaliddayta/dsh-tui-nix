/**
 * Prompt image input for the dsh-tui chat: Ctrl+V clipboard images,
 * `/image <path>`, and drag-and-dropped image paths become
 * `[image #N (W×H)]` draft placeholders in the editor; submitting admits the
 * referenced drafts through `ctx.attachments` as ordered image content blocks.
 *
 * The draft store, file/clipboard intake, attachment admission, and model
 * capability gate are XMoon/dsh-pi-tui's `src/image/*` modules (MIT), copied
 * verbatim by the Nix build. This file only adapts them to this TUI's editor,
 * notices, and model selection.
 * @module @dsh-tui/dsh-tui/chat/image-input
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { admitDraftImages, type AttachmentsLike } from '../image/admission.ts'
import { assertModelSupportsImages, type LlmLike } from '../image/capability.ts'
import {
  commandOnPath,
  createClipboardRunner,
  readClipboardImage,
  type ClipboardEnvironment,
  type RunCommand,
} from '../image/clipboard.ts'
import { DraftImageStore } from '../image/draft-store.ts'
import { ImageAdmissionError, ImageInputError } from '../image/errors.ts'
import { checkImageLimits, expandHome, readImageFile, type ImageLimitsLike } from '../image/intake.ts'
import { expandImagePlaceholders } from '../image/placeholder.ts'
import type { DraftImageSource, ImageMediaType } from '../image/types.ts'

/** Extensions that make a pasted path an image candidate; bytes stay the MIME authority. */
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif)$/iu
/** Longest paste inspected as a path list; anything larger is ordinary text. */
const MAX_PATH_PASTE = 16 * 1024
const NO_ATTACHMENT_STORE = 'Image attachments are unavailable: this profile does not mount an attachment store.'

/** The live provider/model route the next request will use. */
export interface ImageRoute {
  readonly provider: string
  readonly model: string
}

/** Host surface the image input drives. */
export interface ImageInputOptions {
  readonly ctx: Context
  /** Session working directory for relative paths. */
  readonly cwd: string
  /** Insert text at the editor cursor. */
  insert(text: string): void
  /** Current editor text, used to drop drafts whose placeholder was deleted. */
  draft(): string
  /** The route selected for the next request, re-read at submit time. */
  route(): ImageRoute | undefined
  notify(message: string, kind?: 'info' | 'warning' | 'error'): void
  requestRender(): void
  /** Test seam: clipboard command runner and platform facts. */
  readonly clipboard?: {
    readonly run: RunCommand
    environment(): ClipboardEnvironment
  }
}

/** Image input bound to one mounted chat. */
export interface ImageInput {
  /** Ctrl+V: stage a clipboard image, or paste clipboard text when it holds none. */
  pasteClipboard(): void
  /** `/image <path>`: stage one image file. Rejects with an actionable error. */
  attachPath(raw: string): Promise<string>
  /**
   * Bracketed paste: claim a paste made only of existing image paths
   * (terminal drag-and-drop) and stage them asynchronously.
   * @returns true when the paste was claimed and must not reach the editor.
   */
  claimPastedPaths(pasted: string): boolean
  /** Whether submitted text references a staged image. */
  hasImages(text: string): boolean
  /** Reserve the drafts one submission references; call the release in `finally`. */
  pin(text: string): () => void
  /**
   * Gate the current route and admit the referenced drafts.
   * @returns content blocks in draft order (text and images interleaved).
   */
  prepare(text: string): Promise<ContentBlock[]>
  /** Drop the drafts a successful submission consumed. */
  consume(text: string): void
  dispose(): void
}

/** Structural lookup for a service this package does not declare on `Context`. */
function service<T>(ctx: Context, name: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
}

/** Notice text for an image error; the vendored errors already carry user-facing messages. */
export function imageErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Split pasted text into shell-style words: whitespace separates, quotes group,
 * and backslash escapes the next character outside single quotes. This covers
 * how terminals insert dropped files (quoted, backslash-escaped, or file URIs).
 * @param text - one bracketed paste payload.
 * @returns the words, or undefined when quoting is unbalanced.
 */
export function splitPastedWords(text: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let active = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      current += text[++index]!
      active = true
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      active = true
      continue
    }
    if (/\s/u.test(char)) {
      if (active) words.push(current)
      current = ''
      active = false
      continue
    }
    current += char
    active = true
  }
  if (quote !== undefined) return undefined
  if (active) words.push(current)
  return words
}

/**
 * Interpret a paste as dropped image files.
 * @param pasted - bracketed paste payload.
 * @returns image path arguments, or undefined when the paste is ordinary text.
 */
export function pastedImagePaths(pasted: string): string[] | undefined {
  if (pasted.length > MAX_PATH_PASTE) return undefined
  const words = splitPastedWords(pasted.trim())
  if (words === undefined || words.length === 0) return undefined
  const paths: string[] = []
  for (const word of words) {
    let path = word
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        return undefined
      }
    }
    const pathLike = isAbsolute(path) || path.startsWith('~/') || path.startsWith('./') || path.startsWith('../')
    if (!pathLike || !IMAGE_PATH.test(path)) return undefined
    paths.push(path)
  }
  return paths
}

/**
 * Parse the `/image` argument: one path, optionally quoted or escaped.
 * @param raw - raw command input.
 */
export function imageCommandPath(raw: string): string {
  const trimmed = raw.trim()
  const words = splitPastedWords(trimmed)
  if (words?.length === 1) {
    const word = words[0]!
    if (!word.startsWith('file://')) return word
    try {
      return fileURLToPath(word)
    } catch {
      return word
    }
  }
  // An unquoted path with spaces is still one path.
  return trimmed
}

/** Real clipboard environment, read per paste so PATH/display changes apply. */
function liveClipboardEnvironment(): ClipboardEnvironment {
  const env = process.env
  return {
    platform: process.platform,
    env,
    exists: command => commandOnPath(command, env.PATH, process.platform),
  }
}

/**
 * Create the image input for one mounted chat.
 * @param options - editor, notice, and model-route boundary.
 */
export function createImageInput(options: ImageInputOptions): ImageInput {
  const store = new DraftImageStore()
  const run = options.clipboard?.run ?? createClipboardRunner()
  const environment = options.clipboard?.environment ?? liveClipboardEnvironment
  let generation = 0
  let disposed = false

  const attachments = (): AttachmentsLike | undefined => service<AttachmentsLike>(options.ctx, 'attachments')
  const limits = (): ImageLimitsLike | undefined => attachments()?.imageLimits

  /** Drop drafts whose placeholders left the editor and no submission holds. */
  const prune = (): void => {
    const referenced = new Set<number>()
    for (const segment of expandImagePlaceholders(options.draft(), store)) {
      if (segment.type === 'image') referenced.add(segment.image.id)
    }
    for (const image of store.values()) {
      if (!referenced.has(image.id) && !store.isPinned(image.id)) store.remove(image.id)
    }
  }

  const stage = (input: {
    bytes: Uint8Array
    mediaType: ImageMediaType
    width: number
    height: number
    source: DraftImageSource
    name?: string
  }): string => {
    prune()
    const draft = store.add(input)
    options.insert(`${draft.placeholder} `)
    options.requestRender()
    return draft.placeholder
  }

  const readPath = async (raw: string): Promise<string> => {
    if (attachments() === undefined) {
      throw new ImageInputError(NO_ATTACHMENT_STORE)
    }
    const expected = generation
    const file = await readImageFile(raw, options.cwd, limits(), store.remainingBytes())
    if (disposed || expected !== generation) throw new ImageInputError('The chat closed while the image was loading.')
    return stage({
      bytes: file.bytes,
      mediaType: file.mediaType,
      width: file.width,
      height: file.height,
      source: { type: 'path', path: file.path },
      name: file.name,
    })
  }

  return {
    pasteClipboard() {
      const expected = generation
      void readClipboardImage(run, environment()).then((result) => {
        if (disposed || expected !== generation) return
        if (result.kind === 'image') {
          if (attachments() === undefined) {
            options.notify(NO_ATTACHMENT_STORE, 'error')
            return
          }
          checkImageLimits(result, result.bytes.byteLength, limits())
          const placeholder = stage({ ...result, source: { type: 'clipboard' } })
          options.notify(`Attached ${placeholder} from the clipboard — Enter to send.`)
        } else if (result.kind === 'text') {
          if (result.text !== '') {
            options.insert(result.text)
            options.requestRender()
          }
        } else {
          options.notify('Clipboard image paste needs wl-paste (Wayland) or xclip (X11). Use /image <path> instead.', 'warning')
        }
      }).catch((error: unknown) => {
        if (!disposed && expected === generation) options.notify(`Clipboard paste failed: ${imageErrorMessage(error)}`, 'error')
      })
    },

    attachPath(raw) {
      const path = imageCommandPath(raw)
      if (path === '') return Promise.reject(new ImageInputError('Usage: /image <path>'))
      return readPath(path)
    },

    claimPastedPaths(pasted) {
      const paths = pastedImagePaths(pasted)
      if (paths === undefined) return false
      const absolute = paths.map(path => {
        const expanded = expandHome(path)
        return isAbsolute(expanded) ? expanded : resolve(options.cwd, expanded)
      })
      if (!absolute.every(path => existsSync(path))) return false
      void (async () => {
        for (const [index, path] of paths.entries()) {
          try {
            await readPath(absolute[index]!)
          } catch (error: unknown) {
            if (disposed) return
            options.notify(`Image not attached: ${imageErrorMessage(error)}`, 'error')
            // Keep the user's paste: fall back to the path as plain text.
            options.insert(`${path} `)
            options.requestRender()
          }
        }
      })()
      return true
    },

    hasImages(text) {
      return expandImagePlaceholders(text, store).some(segment => segment.type === 'image')
    },

    pin(text) {
      return store.pinReferenced(text)
    },

    async prepare(text) {
      const segments = expandImagePlaceholders(text, store)
      if (!segments.some(segment => segment.type === 'image')) return [{ type: 'text', text }]
      const attachmentStore = attachments()
      if (attachmentStore === undefined) {
        throw new ImageAdmissionError(NO_ATTACHMENT_STORE)
      }
      const route = options.route()
      const llm = service<LlmLike>(options.ctx, 'llm')
      if (route !== undefined && llm !== undefined) {
        await assertModelSupportsImages(llm, route.provider, route.model)
      }
      const { blocks } = await admitDraftImages(segments, attachmentStore)
      return [...blocks]
    },

    consume(text) {
      for (const segment of expandImagePlaceholders(text, store)) {
        if (segment.type === 'image') store.remove(segment.image.id)
      }
    },

    dispose() {
      disposed = true
      generation++
      store.clear()
    },
  }
}
