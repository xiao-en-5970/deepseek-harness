/**
 * Host-side text-to-image proxy backed by a durable filesystem queue that a
 * separately authenticated local Codex worker claims through `bohr sandbox`.
 * @module @deepseek-ai/dsh-codex-image-proxy
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codexImageProxy: CodexImageProxy
  }
}

/** Stable route prefix used to display completed images through the selected tenant child. */
export const IMAGE_ROUTE = '/api/codex-image-proxy/image'
/** Queue protocol version shared with the local worker. */
export const QUEUE_PROTOCOL_VERSION = 1
/** Default worker heartbeat freshness window. */
export const DEFAULT_WORKER_FRESHNESS_MS = 35_000
/** Default interval between result probes. */
export const DEFAULT_RESULT_POLL_INTERVAL_MS = 500
/** Default foreground generation budget. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
/** Default maximum returned image bytes. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TENANT_KEY = /^(?:default|[0-9a-f]{64})$/u
const MIME_TO_EXTENSION = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

type ImageMimeType = keyof typeof MIME_TO_EXTENSION

/** Deployment configuration for the queue, browser URL, and bounded waits. */
export interface Config {
  /** Shared absolute queue root; omitted uses this process's DSH_HOME. */
  queueRoot?: string
  /** Stable tenant directory key supplied by the tenant launcher. */
  tenantKey?: string
  /** Browser-visible HTTP(S) origin used in the generated Markdown URL. */
  publicBaseUrl?: string
  /** Maximum age of the local worker heartbeat. */
  workerFreshnessMs?: number
  /** Interval between durable result probes. */
  resultPollIntervalMs?: number
  /** Maximum duration of one generation request. */
  requestTimeoutMs?: number
  /** Maximum accepted generated-image bytes. */
  maxImageBytes?: number
}

export const Config: z<Config> = z.object({
  queueRoot: z.string(),
  tenantKey: z.string().default('default'),
  publicBaseUrl: z.string().default(''),
  workerFreshnessMs: z.number().default(DEFAULT_WORKER_FRESHNESS_MS),
  resultPollIntervalMs: z.number().default(DEFAULT_RESULT_POLL_INTERVAL_MS),
  requestTimeoutMs: z.number().default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES),
})

interface ResolvedConfig {
  queueRoot: string
  tenantKey: string
  publicBaseUrl: string
  workerFreshnessMs: number
  resultPollIntervalMs: number
  requestTimeoutMs: number
  maxImageBytes: number
}

/** Canonical queue request consumed by the local worker. */
export interface ImageProxyRequest {
  version: typeof QUEUE_PROTOCOL_VERSION
  requestId: string
  tenantKey: string
  prompt: string
  context: string
  createdAt: number
  expiresAt: number
}

interface WorkerHeartbeat {
  version: number
  workerId: string
  updatedAt: number
}

interface CompletedResult {
  version: number
  requestId: string
  status: 'completed'
  mimeType: ImageMimeType
  bytes: number
  sha256: string
  completedAt: number
}

interface FailedResult {
  version: number
  requestId: string
  status: 'failed'
  message: string
  completedAt: number
}

type QueueResult = CompletedResult | FailedResult

export type ImageProxyResult =
  | {
    status: 'generated'
    requestId: string
    imageUrl: string
    imagePath: string
    mimeType: ImageMimeType
    bytes: number
    sha256: string
  }
  | { status: 'offline' | 'failed'; requestId: string; message: string }

export interface ImageGenerationRequest {
  prompt: string
  context: string
}

interface QueueLayout {
  root: string
  tenantRoot: string
  pending: string
  results: string
  images: string
  cancelled: string
  heartbeat: string
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`codex-image-proxy: ${label} must be a positive integer`)
  }
  return value
}

function normalizePublicBaseUrl(value: string): string {
  if (value.trim() === '') return ''
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('codex-image-proxy: publicBaseUrl must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('codex-image-proxy: publicBaseUrl must be an origin or pathname without credentials, query, or fragment')
  }
  return url.toString().replace(/\/$/u, '')
}

/** Resolve and validate configuration at the plugin boundary. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const tenantKey = config.tenantKey ?? 'default'
  if (!TENANT_KEY.test(tenantKey)) {
    throw new Error('codex-image-proxy: tenantKey must be "default" or a lowercase SHA-256 hex digest')
  }
  return {
    queueRoot: resolve(config.queueRoot ?? join(resolveDshHome(), 'codex-image-proxy', 'v1')),
    tenantKey,
    publicBaseUrl: normalizePublicBaseUrl(config.publicBaseUrl ?? ''),
    workerFreshnessMs: positiveInteger('workerFreshnessMs', config.workerFreshnessMs ?? DEFAULT_WORKER_FRESHNESS_MS),
    resultPollIntervalMs: positiveInteger('resultPollIntervalMs', config.resultPollIntervalMs ?? DEFAULT_RESULT_POLL_INTERVAL_MS),
    requestTimeoutMs: positiveInteger('requestTimeoutMs', config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    maxImageBytes: positiveInteger('maxImageBytes', config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES),
  }
}

function queueLayout(config: ResolvedConfig): QueueLayout {
  const tenantRoot = join(config.queueRoot, 'tenants', config.tenantKey)
  return {
    root: config.queueRoot,
    tenantRoot,
    pending: join(tenantRoot, 'pending'),
    results: join(tenantRoot, 'results'),
    images: join(tenantRoot, 'images'),
    cancelled: join(tenantRoot, 'cancelled'),
    heartbeat: join(config.queueRoot, 'heartbeat.json'),
  }
}

async function ensureQueue(layout: QueueLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.pending, { recursive: true, mode: 0o700 }),
    mkdir(layout.results, { recursive: true, mode: 0o700 }),
    mkdir(layout.images, { recursive: true, mode: 0o700 }),
    mkdir(layout.cancelled, { recursive: true, mode: 0o700 }),
  ])
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function heartbeatFrom(value: unknown): WorkerHeartbeat | undefined {
  const input = record(value)
  if (input === undefined
    || input.version !== QUEUE_PROTOCOL_VERSION
    || typeof input.workerId !== 'string'
    || typeof input.updatedAt !== 'number'
    || !Number.isFinite(input.updatedAt)) return undefined
  return { version: input.version, workerId: input.workerId, updatedAt: input.updatedAt }
}

/** Return whether the durable heartbeat belongs to a recently live worker. */
export function workerIsFresh(value: unknown, now: number, freshnessMs: number): boolean {
  const heartbeat = heartbeatFrom(value)
  return heartbeat !== undefined && heartbeat.updatedAt <= now + 5_000 && now - heartbeat.updatedAt <= freshnessMs
}

function queueResultFrom(value: unknown, requestId: string): QueueResult | undefined {
  const input = record(value)
  if (input === undefined
    || input.version !== QUEUE_PROTOCOL_VERSION
    || input.requestId !== requestId
    || typeof input.completedAt !== 'number') return undefined
  if (input.status === 'failed' && typeof input.message === 'string') {
    return {
      version: input.version,
      requestId,
      status: 'failed',
      message: input.message,
      completedAt: input.completedAt,
    }
  }
  if (input.status !== 'completed'
    || typeof input.mimeType !== 'string'
    || !(input.mimeType in MIME_TO_EXTENSION)
    || typeof input.bytes !== 'number'
    || !Number.isSafeInteger(input.bytes)
    || input.bytes < 1
    || typeof input.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(input.sha256)) return undefined
  return {
    version: input.version,
    requestId,
    status: 'completed',
    mimeType: input.mimeType as ImageMimeType,
    bytes: input.bytes,
    sha256: input.sha256,
    completedAt: input.completedAt,
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(signal.reason instanceof Error ? signal.reason : new Error('image generation aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolveDelay()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      rejectDelay(signal.reason instanceof Error ? signal.reason : new Error('image generation aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function cancelRequest(layout: QueueLayout, requestId: string, reason: string): Promise<void> {
  await atomicWriteJson(join(layout.cancelled, `${requestId}.json`), {
    version: QUEUE_PROTOCOL_VERSION,
    requestId,
    reason,
    cancelledAt: Date.now(),
  })
}

async function verifyCompletedImage(
  layout: QueueLayout,
  result: CompletedResult,
  maxImageBytes: number,
): Promise<{ path: string; bytes: number; sha256: string }> {
  if (result.bytes > maxImageBytes) {
    throw new Error(`worker returned ${String(result.bytes)} bytes; limit is ${String(maxImageBytes)}`)
  }
  const extension = MIME_TO_EXTENSION[result.mimeType]
  const path = join(layout.images, `${result.requestId}.${extension}`)
  const info = await stat(path)
  if (!info.isFile() || info.size !== result.bytes || info.size > maxImageBytes) {
    throw new Error('worker image metadata does not match the durable image file')
  }
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== result.sha256) throw new Error('worker image checksum mismatch')
  return { path, bytes: bytes.byteLength, sha256 }
}

async function waitForResult(
  layout: QueueLayout,
  requestId: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<ImageProxyResult> {
  const deadline = Date.now() + config.requestTimeoutMs
  const resultPath = join(layout.results, `${requestId}.json`)
  for (;;) {
    if (signal.aborted) throw signal.reason
    const rawResult = await readJson(resultPath)
    if (rawResult !== undefined) {
      const result = queueResultFrom(rawResult, requestId)
      if (result === undefined) return { status: 'failed', requestId, message: 'Local Codex worker returned an invalid result record.' }
      if (result.status === 'failed') return { status: 'failed', requestId, message: result.message }
      try {
        const verified = await verifyCompletedImage(layout, result, config.maxImageBytes)
        const imageUrl = `${config.publicBaseUrl}${IMAGE_ROUTE}/${requestId}`
        return {
          status: 'generated',
          requestId,
          imageUrl,
          imagePath: verified.path,
          mimeType: result.mimeType,
          bytes: verified.bytes,
          sha256: verified.sha256,
        }
      } catch (error) {
        return {
          status: 'failed',
          requestId,
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }
    const now = Date.now()
    if (now >= deadline) {
      await cancelRequest(layout, requestId, 'request-timeout')
      return { status: 'failed', requestId, message: 'Local Codex image generation timed out.' }
    }
    if (!workerIsFresh(await readJson(layout.heartbeat), now, config.workerFreshnessMs)) {
      await cancelRequest(layout, requestId, 'worker-offline')
      return { status: 'offline', requestId, message: 'Local Codex is offline; image generation is unavailable.' }
    }
    await delay(Math.min(config.resultPollIntervalMs, deadline - now), signal)
  }
}

async function serveImage(layout: QueueLayout, requestId: string, method: string | undefined, res: import('node:http').ServerResponse): Promise<void> {
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (!REQUEST_ID.test(requestId)) {
    res.writeHead(400, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const result = queueResultFrom(await readJson(join(layout.results, `${requestId}.json`)), requestId)
  if (result === undefined || result.status !== 'completed') {
    res.writeHead(404, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const path = join(layout.images, `${requestId}.${MIME_TO_EXTENSION[result.mimeType]}`)
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    throw error
  }
  if (!info.isFile() || info.size !== result.bytes) {
    res.writeHead(409, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': result.mimeType,
    'content-length': info.size,
    'content-disposition': `inline; filename="generated-${requestId}.${MIME_TO_EXTENSION[result.mimeType]}"`,
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(createReadStream(path), res)
}

/** Host service owning the shared queue and the browser image route. */
export class CodexImageProxy extends Service {
  static inject = ['webServer']
  static Config = Config

  readonly requestTimeoutMs: number
  private readonly config: ResolvedConfig
  private readonly layout: QueueLayout

  constructor(ctx: Context, rawConfig: Config = {}) {
    super(ctx, 'codexImageProxy')
    this.config = resolveConfig(rawConfig)
    this.layout = queueLayout(this.config)
    this.requestTimeoutMs = this.config.requestTimeoutMs
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: IMAGE_ROUTE,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://image-proxy').pathname
        const suffix = pathname.slice(IMAGE_ROUTE.length)
        const requestId = suffix.startsWith('/') ? suffix.slice(1) : ''
        await serveImage(this.layout, requestId, req.method, res)
      },
    }), `codex-image-proxy: ${IMAGE_ROUTE} route`)
  }

  /**
   * Enqueue one bounded model request and wait for the authenticated worker's durable result.
   * @param input - Complete visual prompt and bounded relevant context.
   * @param signal - Caller cancellation propagated through durable cancellation markers.
   * @returns A generated image reference, offline status, or bounded failure.
   */
  async generate(input: ImageGenerationRequest, signal: AbortSignal): Promise<ImageProxyResult> {
    const requestId = randomUUID()
    if (this.config.publicBaseUrl === '') {
      return {
        status: 'failed',
        requestId,
        message: 'Image proxy publicBaseUrl is not configured, so the browser cannot display generated images.',
      }
    }
    await ensureQueue(this.layout)
    if (!workerIsFresh(await readJson(this.layout.heartbeat), Date.now(), this.config.workerFreshnessMs)) {
      return { status: 'offline', requestId, message: 'Local Codex is offline; image generation is unavailable.' }
    }
    const now = Date.now()
    const request: ImageProxyRequest = {
      version: QUEUE_PROTOCOL_VERSION,
      requestId,
      tenantKey: this.config.tenantKey,
      prompt: input.prompt,
      context: input.context,
      createdAt: now,
      expiresAt: now + this.config.requestTimeoutMs,
    }
    await atomicWriteJson(join(this.layout.pending, `${requestId}.json`), request)
    try {
      return await waitForResult(this.layout, requestId, this.config, signal)
    } catch (error) {
      await cancelRequest(this.layout, requestId, 'caller-aborted').catch(() => undefined)
      throw error
    }
  }
}

export default CodexImageProxy
