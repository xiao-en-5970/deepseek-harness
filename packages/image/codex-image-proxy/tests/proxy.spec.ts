import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodexImageProxy, { QUEUE_PROTOCOL_VERSION, workerIsFresh } from '@deepseek-ai/dsh-codex-image-proxy'
import WebServer from '@deepseek-ai/dsh-host-webserver'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function mount(publicBaseUrl = 'http://127.0.0.1'): Promise<{ queueRoot: string; proxy: CodexImageProxy }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-image-proxy-'))
  const queueRoot = join(root, 'queue')
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(CodexImageProxy, {
    queueRoot,
    tenantKey: 'default',
    publicBaseUrl,
    workerFreshnessMs: 1_000,
    resultPollIntervalMs: 10,
    requestTimeoutMs: 2_000,
  })
  return { queueRoot, proxy: ctx.codexImageProxy }
}

async function pendingRequest(queueRoot: string): Promise<{ requestId: string; path: string }> {
  const directory = join(queueRoot, 'tenants', 'default', 'pending')
  for (let attempt = 0; attempt < 100; attempt++) {
    const [name] = await readdir(directory).catch(() => [])
    if (name !== undefined) return { requestId: name.slice(0, -5), path: join(directory, name) }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('request was not enqueued')
}

describe('Codex image proxy service', () => {
  it('treats only a bounded, well-shaped heartbeat as live', () => {
    expect(workerIsFresh({ version: QUEUE_PROTOCOL_VERSION, workerId: 'w', updatedAt: 1_000 }, 1_500, 1_000)).toBe(true)
    expect(workerIsFresh({ version: QUEUE_PROTOCOL_VERSION, workerId: 'w', updatedAt: 1_000 }, 2_001, 1_000)).toBe(false)
    expect(workerIsFresh({ version: 1, workerId: 'w', updatedAt: 1_000 }, 1_500, 1_000)).toBe(false)
  })

  it('returns offline without creating a request when no worker heartbeat exists', async () => {
    const { queueRoot, proxy } = await mount()
    const result = await proxy.generate({ prompt: 'a blue circle', context: '' }, new AbortController().signal)
    expect(result.status).toBe('offline')
    if (result.status !== 'generated') expect(result.message).toContain('offline')
    expect(await readdir(join(queueRoot, 'tenants', 'default', 'pending'))).toEqual([])
  })

  it('round-trips with no publicBaseUrl and returns a same-origin image path', async () => {
    const { queueRoot, proxy } = await mount('')
    await mkdir(queueRoot, { recursive: true })
    await writeFile(join(queueRoot, 'heartbeat.json'), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      workerId: 'test-worker',
      updatedAt: Date.now(),
    }))
    const generation = proxy.generate({ prompt: 'a blue circle', context: '' }, new AbortController().signal)
    const pending = await pendingRequest(queueRoot)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9])
    const tenant = join(queueRoot, 'tenants', 'default')
    await Promise.all([
      mkdir(join(tenant, 'images'), { recursive: true }),
      mkdir(join(tenant, 'results'), { recursive: true }),
    ])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(tenant, 'images', `${pending.requestId}.png`), bytes)
    await writeFile(join(tenant, 'results', `${pending.requestId}.json`), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      requestId: pending.requestId,
      status: 'completed',
      mimeType: 'image/png',
      bytes: bytes.byteLength,
      sha256,
      completedAt: Date.now(),
    }))
    await expect(generation).resolves.toMatchObject({
      status: 'generated',
      imageUrl: `/api/codex-image-proxy/image/${pending.requestId}`,
      bytes: bytes.byteLength,
      sha256,
    })
  })

  it('round-trips a durable request, validates the image, and serves it through the host route', async () => {
    const { queueRoot, proxy } = await mount()
    await mkdir(queueRoot, { recursive: true })
    await writeFile(join(queueRoot, 'heartbeat.json'), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      workerId: 'test-worker',
      updatedAt: Date.now(),
    }))
    const referenceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6])
    const generation = proxy.generate({
      prompt: 'turn the circle green',
      context: 'flat icon',
      referenceImages: [{ data: referenceBytes, mimeType: 'image/png', name: '../source.png' }],
    }, new AbortController().signal)
    const pending = await pendingRequest(queueRoot)
    const request: unknown = JSON.parse(await readFile(pending.path, 'utf8'))
    expect(request).toMatchObject({
      version: QUEUE_PROTOCOL_VERSION,
      requestId: pending.requestId,
      tenantKey: 'default',
      prompt: 'turn the circle green',
      context: 'flat icon',
      referenceImages: [{
        index: 0,
        mimeType: 'image/png',
        bytes: referenceBytes.byteLength,
        sha256: createHash('sha256').update(referenceBytes).digest('hex'),
        name: 'source.png',
      }],
    })
    expect(await readFile(join(
      queueRoot, 'tenants', 'default', 'references', pending.requestId, '00.png',
    ))).toEqual(referenceBytes)

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const tenant = join(queueRoot, 'tenants', 'default')
    await Promise.all([
      mkdir(join(tenant, 'images'), { recursive: true }),
      mkdir(join(tenant, 'results'), { recursive: true }),
    ])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(tenant, 'images', `${pending.requestId}.png`), bytes)
    await writeFile(join(tenant, 'results', `${pending.requestId}.json`), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      requestId: pending.requestId,
      status: 'completed',
      mimeType: 'image/png',
      bytes: bytes.byteLength,
      sha256,
      completedAt: Date.now(),
    }))

    const result = await generation
    expect(result).toMatchObject({ status: 'generated', requestId: pending.requestId, bytes: bytes.byteLength, sha256 })
    if (result.status !== 'generated' || ctx === undefined) throw new Error('expected generated image')
    const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/api/codex-image-proxy/image/${pending.requestId}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    await expect(readFile(join(
      queueRoot, 'tenants', 'default', 'references', pending.requestId, '00.png',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans staged reference bytes when the worker fails or the caller aborts', async () => {
    const { queueRoot, proxy } = await mount()
    await mkdir(queueRoot, { recursive: true })
    await writeFile(join(queueRoot, 'heartbeat.json'), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      workerId: 'test-worker',
      updatedAt: Date.now(),
    }))
    const reference = { data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47), mimeType: 'image/png' as const }

    const failed = proxy.generate({ prompt: 'edit', context: '', referenceImages: [reference] }, new AbortController().signal)
    const failedPending = await pendingRequest(queueRoot)
    await mkdir(join(queueRoot, 'tenants', 'default', 'results'), { recursive: true })
    await writeFile(join(queueRoot, 'tenants', 'default', 'results', `${failedPending.requestId}.json`), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      requestId: failedPending.requestId,
      status: 'failed',
      message: 'test failure',
      completedAt: Date.now(),
    }))
    await rm(failedPending.path)
    await expect(failed).resolves.toMatchObject({ status: 'failed', message: 'test failure' })
    await expect(readFile(join(
      queueRoot, 'tenants', 'default', 'references', failedPending.requestId, '00.png',
    ))).rejects.toMatchObject({ code: 'ENOENT' })

    const controller = new AbortController()
    const aborted = proxy.generate({ prompt: 'edit', context: '', referenceImages: [reference] }, controller.signal)
    const abortedPending = await pendingRequest(queueRoot)
    controller.abort(new Error('test abort'))
    await expect(aborted).rejects.toThrow('test abort')
    await expect(readFile(join(
      queueRoot, 'tenants', 'default', 'references', abortedPending.requestId, '00.png',
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
