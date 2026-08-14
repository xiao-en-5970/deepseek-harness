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
    expect(workerIsFresh({ version: 1, workerId: 'w', updatedAt: 1_000 }, 1_500, 1_000)).toBe(true)
    expect(workerIsFresh({ version: 1, workerId: 'w', updatedAt: 1_000 }, 2_001, 1_000)).toBe(false)
    expect(workerIsFresh({ version: 2, workerId: 'w', updatedAt: 1_000 }, 1_500, 1_000)).toBe(false)
  })

  it('returns offline without creating a request when no worker heartbeat exists', async () => {
    const { queueRoot, proxy } = await mount()
    const result = await proxy.generate({ prompt: 'a blue circle', context: '' }, new AbortController().signal)
    expect(result.status).toBe('offline')
    if (result.status !== 'generated') expect(result.message).toContain('offline')
    expect(await readdir(join(queueRoot, 'tenants', 'default', 'pending'))).toEqual([])
  })

  it('round-trips a durable request, validates the image, and serves it through the host route', async () => {
    const { queueRoot, proxy } = await mount()
    await mkdir(queueRoot, { recursive: true })
    await writeFile(join(queueRoot, 'heartbeat.json'), JSON.stringify({
      version: QUEUE_PROTOCOL_VERSION,
      workerId: 'test-worker',
      updatedAt: Date.now(),
    }))
    const generation = proxy.generate({ prompt: 'a blue circle', context: 'flat icon' }, new AbortController().signal)
    const pending = await pendingRequest(queueRoot)
    const request: unknown = JSON.parse(await readFile(pending.path, 'utf8'))
    expect(request).toMatchObject({
      version: 1,
      requestId: pending.requestId,
      tenantKey: 'default',
      prompt: 'a blue circle',
      context: 'flat icon',
    })

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const tenant = join(queueRoot, 'tenants', 'default')
    await Promise.all([
      mkdir(join(tenant, 'images'), { recursive: true }),
      mkdir(join(tenant, 'results'), { recursive: true }),
    ])
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(tenant, 'images', `${pending.requestId}.png`), bytes)
    await writeFile(join(tenant, 'results', `${pending.requestId}.json`), JSON.stringify({
      version: 1,
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
  })
})
