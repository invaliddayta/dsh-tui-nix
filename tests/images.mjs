// node tests/images.mjs RUNTIME_ROOT
// Exercise installed upstream tools/services, not source helpers or a provider API.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

assert(process.argv[2], 'Expected installed RUNTIME_ROOT (for example result/libexec/dsh)')
const requireRuntime = createRequire(join(resolve(process.argv[2]), 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const root = await mkdtemp(join(tmpdir(), 'dsh-images-'))
const originalEnv = process.env
const originalFetch = globalThis.fetch
const originalConnect = Socket.prototype.connect
let ctx
let networkAttempts = 0
process.env = { HOME: root, DSH_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root }
const noNetwork = () => {
  networkAttempts++
  throw new Error('Network forbidden in image regression tests')
}
globalThis.fetch = noNetwork
Socket.prototype.connect = noNetwork

// Valid opaque red PNG, shared with upstream read-image.spec.ts.
const red = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('')
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

// Build the large fixture using only Node: RGB scanlines, zlib, PNG chunks/CRC.
function png(width, height) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 8-bit samples
  header[9] = 2 // RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row[1 + x * 3] = 255
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

try {
  const { Context } = await load('@deepseek-ai/cordis')
  const { LlmAdapter, LlmRuntime, ToolCallId } = await load('@deepseek-ai/dsh-llm')
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools')
  const { default: LocalFileSystem } = await load('@deepseek-ai/dsh-fs-local')
  const FsPolicy = await load('@deepseek-ai/dsh-fs-observation-policy')
  const { default: LocalAttachmentStore } = await load('@deepseek-ai/dsh-attachment-local')
  const ToolFs = await load('@deepseek-ai/dsh-tool-fs')
  const yaml = await load('js-yaml')
  // Preserve Cordis expressions as inert data; these two mounts must be unconditionally enabled.
  const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' }))
  const base = yaml.load(await readFile(requireRuntime.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8'), { schema })
  const entries = base.flatMap(patch => patch.insert ?? [])
  for (const name of ['@deepseek-ai/dsh-attachment-local', '@deepseek-ai/dsh-tool-fs']) {
    assert(entries.some(entry => entry.name === name && !entry.disabled), `${name} must be enabled in packaged base`)
  }
  console.log('PASS: packaged base enables upstream attachment-local and tool-fs')
  // Use the attachment package's installed decoder to inspect actual output pixels.
  const requireAttachments = createRequire(requireRuntime.resolve('@deepseek-ai/dsh-attachment-local'))
  const sharp = requireAttachments('sharp')

  // Only the model catalog is synthetic. All filesystem, attachment, normalization,
  // tool execution and image-block rendering paths are the packaged implementations.
  class CatalogAdapter extends LlmAdapter {
    async listModels() { return [] }
    async resolveModel(provider, id) {
      return {
        provider, id, name: id,
        ...(id === 'vision' ? { inputModalities: ['text', 'image'] }
          : id === 'text' ? { inputModalities: ['text'] } : {}),
      }
    }
    stream() { throw new Error('Image tests must never invoke a provider') }
  }
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['image-test'], new CatalogAdapter())
  await ctx.plugin(ToolFs)
  const attachments = ctx.get('attachments')
  assert(attachments, 'Real attachment service must be mounted')
  let counter = 0
  const agentOn = model => ({
    options: {},
    session: {
      header: { cwd: root },
      requestHeader: () => ({ config: { provider: 'image-test', model } }),
      deriveMessages: () => [],
      append: () => undefined,
    },
  })
  const call = (name, file_path, model = 'vision') => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`image-regression-${++counter}`),
    name, arguments: { file_path }, agent: agentOn(model),
  })
  const readImage = (file, model) => call('read_image', file, model)
  async function checkedImage(result, sourcePath, expectedBytes) {
    assert.equal(result.isError, false, text(result))
    assert.equal(result.content.length, 2, 'Tool must return text plus a real image block')
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[1].type, 'image')
    assert(text(result).includes(`<path>${resolve(root, sourcePath)}</path>`))
    assert.match(text(result), /<type>image<\/type>/)
    const ref = result.content[1].attachment
    assert.match(ref.attachmentId, /^sha256:[0-9a-f]{64}$/)
    const stored = await attachments.readImage(ref)
    const bytes = Buffer.from(stored.data)
    assert.equal(bytes.length, ref.bytes)
    assert.equal(digest(bytes), ref.attachmentId, 'Image block must address its actual bytes')
    const hostPath = attachments.imageHostPath(ref)
    assert(hostPath, 'Attachment must be committed to the local filesystem')
    assert.deepEqual(await readFile(hostPath), bytes, 'Durable attachment bytes must match')
    if (expectedBytes) assert.deepEqual(bytes, expectedBytes)
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, ref.width)
    assert.equal(info.height, ref.height)
    assert.equal(data.length, info.width * info.height * info.channels)
    return { ref, bytes, hostPath, pixels: data, channels: info.channels }
  }
  function rejected(result, message) {
    assert.equal(result.isError, true, 'Expected a tool error')
    assert(result.content.every(block => block.type === 'text'), 'Refusals must not emit images')
    assert.match(text(result), message)
  }

  await writeFile(join(root, 'red.png'), red)
  const first = await checkedImage(await readImage('red.png'), 'red.png', red)
  assert.equal(first.ref.mediaType, 'image/png')
  assert.equal(first.ref.name, 'red.png')
  assert.equal(first.ref.width, 1)
  assert.equal(first.ref.height, 1)
  assert.deepEqual([...first.pixels], [255, 0, 0])
  console.log('PASS: real PNG tool result, decoded red pixel, content hash and durable attachment bytes')

  await writeFile(join(root, 'avatar'), red)
  const extensionless = await checkedImage(await readImage('avatar'), 'avatar', red)
  assert.equal(extensionless.ref.attachmentId, first.ref.attachmentId)
  assert.equal(extensionless.ref.name, 'avatar')
  assert.equal(extname(first.hostPath), '')
  const reread = await checkedImage(await readImage(first.hostPath), first.hostPath, red)
  assert.equal(reread.ref.attachmentId, first.ref.attachmentId)
  console.log('PASS: extensionless image and normalized attachment object path sniffing/deduplication')

  await writeFile(join(root, 'red.gif'), gif)
  const normalized = await checkedImage(await readImage('red.gif'), 'red.gif')
  assert.equal(normalized.ref.width, 1)
  assert.equal(normalized.ref.height, 1)
  assert.equal(normalized.ref.mediaType, 'image/webp')
  assert.notDeepEqual(normalized.bytes, gif)
  console.log('PASS: real GIF normalized to a decodable stored WebP image')

  rejected(await readImage('missing.png'), /ENOENT|not found|does not exist/i)
  await writeFile(join(root, 'invalid.png'), 'not an image')
  rejected(await readImage('invalid.png'), /do not decode|not a supported image|invalid image|Unsupported or malformed image data/i)
  await writeFile(join(root, 'invalid'), 'not an image')
  rejected(await readImage('invalid'), /not a supported image format/)
  await writeFile(join(root, 'truncated.png'), red.subarray(0, 16))
  rejected(await readImage('truncated.png'), /do not decode|Unsupported or malformed image data/)
  await writeFile(join(root, 'wrong.jpg'), red)
  rejected(await readImage('wrong.jpg'), /extension declares image\/jpeg/)
  for (const model of ['text', 'undeclared']) {
    rejected(await readImage('red.png', model), /does not declare image input/)
  }
  console.log('PASS: missing, invalid, truncated, mislabeled images and non-image-capable models rejected')

  const textRead = await call('read', 'red.png')
  assert(textRead.content.every(block => block.type === 'text'), 'read must remain text-only')
  assert.equal(textRead.isError, true)
  assert.match(text(textRead), /binary file|read_image/)
  console.log('PASS: text read preserves its text-only contract and refuses binary PNG')

  const large = png(4096, 2048) // 8 MP: admitted but over the default 4 MP normalization budget.
  await writeFile(join(root, 'large.png'), large)
  const resized = await checkedImage(await readImage('large.png'), 'large.png')
  assert.deepEqual(resized.ref.originalDimensions, { width: 4096, height: 2048 })
  assert(resized.ref.width < 4096 && resized.ref.height < 2048, 'Large image must actually shrink')
  assert(resized.ref.width * resized.ref.height <= attachments.normalizationPolicy.maxPixels)
  assert(Math.abs(resized.ref.width / resized.ref.height - 2) < 0.01, 'Resize preserves aspect ratio')
  assert.notDeepEqual(resized.bytes, large)
  assert(resized.pixels[0] >= 250 && resized.pixels[1] <= 5 && resized.pixels[2] <= 5,
    'Normalized image must retain the red source pixels')
  console.log(`PASS: large PNG resized from 4096x2048 to ${resized.ref.width}x${resized.ref.height}, stored and decoded`)
  // This is the exact attachment API used by pi-ai context conversion before
  // base64 serialization. Exercise a tighter model-route policy without a provider.
  const request = await attachments.readImageRequest(resized.ref, { maxPixels: 512 * 512, maxBytes: 1024 * 1024 })
  assert.equal(request.attachment.attachmentId, resized.ref.attachmentId)
  assert.equal(request.data.length, request.bytes)
  assert(request.width * request.height <= 512 * 512)
  assert(request.width < resized.ref.width && request.height < resized.ref.height)
  assert.equal(request.depth, 'uchar')
  assert.equal(request.space, 'srgb')
  const serialized = Buffer.from(request.data).toString('base64')
  const { data: requestPixels, info: requestInfo } = await sharp(Buffer.from(serialized, 'base64'))
    .raw().toBuffer({ resolveWithObject: true })
  assert.equal(requestInfo.width, request.width)
  assert.equal(requestInfo.height, request.height)
  assert(requestPixels[0] >= 250 && requestPixels[1] <= 5 && requestPixels[2] <= 5)
  console.log(`PASS: provider-ready request bytes resized to ${request.width}x${request.height} and decoded after base64 round-trip`)
  assert.equal(networkAttempts, 0, 'No network/provider credentials required')
  console.log('PASS: packaged image regression suite (offline)')
} finally {
  try {
    if (ctx) await ctx.fiber.dispose()
  } finally {
    process.env = originalEnv
    globalThis.fetch = originalFetch
    Socket.prototype.connect = originalConnect
    await rm(root, { recursive: true, force: true })
  }
}
