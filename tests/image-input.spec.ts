import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

// Valid opaque 1x1 red PNG, shared with tests/images.mjs.
const red = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const CTRL_V = '\x16'

let root: string
let workspace: string
let originalEnv: NodeJS.ProcessEnv
const sessions: Array<Awaited<ReturnType<typeof createTuiTestHarness>>> = []

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in image input tests') }))
  originalEnv = { ...process.env }
  root = mkdtempSync(join(tmpdir(), 'dsh-image-input-'))
  workspace = join(root, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'red.png'), red)
  writeFileSync(join(workspace, 'shot one.png'), red)
  writeFileSync(join(workspace, 'fake.png'), 'not an image')
})

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await disposeTuiTestHarness(session)
    await session.terminal.dispose()
  }
  process.env = originalEnv
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function start(model: 'vision' | 'text' = 'vision') {
  const terminal = new HeadlessTerminal(110, 32)
  const session = await createTuiTestHarness(terminal, vi.fn(), {
    cwd: workspace,
    omitInitialLifecycle: true,
    agentOptions: { provider: 'image-test', model },
    catalog: {
      providers: [{ id: 'image-test', name: 'Image test' }],
      models: [
        { provider: 'image-test', id: 'vision', name: 'Vision' },
        { provider: 'image-test', id: 'text', name: 'Text' },
      ],
      resolveModelInfo: (async (_provider: string, id: string) => ({
        context: { contextWindow: 128_000 },
        inputModalities: id === 'vision' ? ['text', 'image'] : ['text'],
      })) as never,
    },
    async configureContext(ctx: Context) {
      await ctx.plugin(ToolRegistry)
      await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, 'dsh') })
    },
  })
  sessions.push(session)
  await terminal.waitForFrame(0)
  return session
}

const screen = (session: Awaited<ReturnType<typeof start>>) => session.terminal.snapshot()

async function staged(session: Awaited<ReturnType<typeof start>>, placeholder = '[image #1 (1×1)]') {
  await vi.waitFor(async () => expect(await screen(session)).toContain(placeholder))
}

function expectRedImage(block: unknown, name?: string) {
  expect(block).toMatchObject({
    type: 'image',
    attachment: {
      mediaType: 'image/png', width: 1, height: 1,
      attachmentId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      ...name === undefined ? {} : { name },
    },
  })
}

interface StoredImages {
  readImage(ref: unknown): Promise<{ data: Uint8Array }>
}

it('attaches /image files as ordered image blocks through the attachment store', async () => {
  const session = await start()
  session.terminal.send('/image ./red.png')
  session.terminal.send('\r')
  await staged(session)
  session.terminal.send('what color is this?')
  session.terminal.send('\r')
  await vi.waitFor(() => expect(session.agent.sent).toHaveLength(1))
  const [image, text] = session.agent.sent[0]!
  expectRedImage(image, 'red.png')
  expect(text).toEqual({ type: 'text', text: ' what color is this?' })
  // The block addresses the durable bytes the attachment store committed.
  const attachments = session.ctx.get('attachments' as never) as StoredImages
  const stored = await attachments.readImage((image as { attachment: unknown }).attachment)
  expect(Buffer.from(stored.data)).toEqual(red)
})

it('stages terminal drag-and-drop paths, including quoted names with spaces', async () => {
  const session = await start()
  session.terminal.send(`${PASTE_START}'${join(workspace, 'shot one.png')}' ${join(workspace, 'red.png')}${PASTE_END}`)
  await staged(session, '[image #2 (1×1)]')
  expect(await screen(session)).toContain('[image #1 (1×1)]')
  session.terminal.send('\r')
  await vi.waitFor(() => expect(session.agent.sent).toHaveLength(1))
  const blocks = session.agent.sent[0]!.filter(block => block.type === 'image')
  expect(blocks).toHaveLength(2)
  expectRedImage(blocks[0], 'shot one.png')
  expectRedImage(blocks[1], 'red.png')
})

it('keeps ordinary pastes and missing paths as text', async () => {
  const session = await start()
  session.terminal.send(`${PASTE_START}hello there${PASTE_END}`)
  session.terminal.send(`${PASTE_START} ${join(workspace, 'missing.png')}${PASTE_END}`)
  session.terminal.send('\r')
  await vi.waitFor(() => expect(session.agent.sent).toHaveLength(1))
  expect(session.agent.sent[0]).toEqual([{ type: 'text', text: `hello there ${join(workspace, 'missing.png')}` }])
})

it('rejects undecodable files and text-only routes without sending, keeping the draft', async () => {
  const text = await start('text')
  text.terminal.send('/image fake.png')
  text.terminal.send('\r')
  await vi.waitFor(async () => expect(await screen(text)).toContain('Unsupported image format'))
  text.terminal.send('/image red.png')
  text.terminal.send('\r')
  await staged(text)
  text.terminal.send('\r')
  await vi.waitFor(async () => expect(await screen(text)).toContain('does not support image input'))
  expect(text.agent.sent).toHaveLength(0)
  // The failed submission restores its placeholder with the draft still staged.
  expect(await screen(text)).toContain('[image #1 (1×1)]')
})

it('pastes clipboard images with Ctrl+V and falls back to clipboard text', async () => {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const clipboard = join(root, 'clipboard')
  writeFileSync(clipboard, red)
  const types = join(root, 'types')
  writeFileSync(types, 'image/png\ntext/plain\n')
  // Minimal wl-paste: list types, or print the clipboard file for any read.
  const wlPaste = join(bin, 'wl-paste')
  writeFileSync(wlPaste, `#!${process.execPath}
const { readFileSync } = require('node:fs')
process.stdout.write(readFileSync(process.argv.includes('--list-types') ? ${JSON.stringify(types)} : ${JSON.stringify(clipboard)}))
`)
  chmodSync(wlPaste, 0o755)
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  process.env.WAYLAND_DISPLAY = 'wayland-test'

  const session = await start()
  session.terminal.send(CTRL_V)
  await staged(session)
  await vi.waitFor(async () => expect(await screen(session)).toContain('from the clipboard'))

  writeFileSync(types, 'text/plain\n')
  writeFileSync(clipboard, ' and text')
  session.terminal.send(CTRL_V)
  await vi.waitFor(async () => expect(await screen(session)).toContain('and text'))
  session.terminal.send('\r')
  await vi.waitFor(() => expect(session.agent.sent).toHaveLength(1))
  expectRedImage(session.agent.sent[0]![0])
  expect(session.agent.sent[0]![1]).toEqual({ type: 'text', text: '  and text' })
})
