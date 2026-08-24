/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { createHash } from 'node:crypto'
import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmAccountBalance,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { prepareRequestImage } from './request-image.ts'
import type { RequestImage } from './request-image.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'

/** One optional model entry advertised by the direct-fetch adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
  /** Input types accepted by this model; omission means text only. */
  inputModalities?: ModelModality[]
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which is what
 * makes a configuration change reach the next request without re-registration.
 */
export interface DeepSeekConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link DeepSeekAdapter}: the operation-local resolution hooks the plugin owns. */
export interface DeepSeekAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions) => Promise<string>
  /** Resolve the harness-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
  /** Resolve durable image bytes only for image-bearing requests. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 256_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const FILE_EXPIRY_SECONDS = 7 * 24 * 60 * 60
const FILE_REFRESH_MARGIN_MS = 60 * 60 * 1000
const MAX_CACHED_FILES = 512
const MAX_REQUEST_IMAGES = 100
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024
const OFF_REASONING_EFFORT = ReasoningEffortId('off')
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const
const OFF_ONLY_REASONING_EFFORTS = [
  { id: OFF_REASONING_EFFORT, name: 'Off' },
] as const

function modelInfo(provider: string, model: DeepSeekCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

function isFileResolutionError(status: number, error?: WireError['error']): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  return /(?:file|file_id).*(?:not found|expired|invalid|missing|does not exist)/iu.test(detail)
    || /(?:not found|expired|invalid|missing).*(?:file|file_id)/iu.test(detail)
}

interface CachedFile {
  fileId: string
  expiresAt: number
}

class FileUploadError extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Files API upload failed.', { cause })
  }
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class DeepSeekAdapter extends LlmAdapter {
  private readonly fileCache = new Map<string, Promise<CachedFile>>()

  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
  }

  private fileCacheKey(connection: DeepSeekConnectionOptions, apiKey: string, image: RequestImage): string {
    const scope = createHash('sha256').update(`${connection.baseURL}\0${apiKey}`).digest('hex')
    return `${scope}\0${image.variantId}`
  }

  private async uploadImage(
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    image: RequestImage,
    signal?: AbortSignal,
  ): Promise<CachedFile> {
    const form = new FormData()
    form.set('purpose', 'user_data')
    form.set('expires_after[anchor]', 'created_at')
    form.set('expires_after[seconds]', String(FILE_EXPIRY_SECONDS))
    form.set('file', new Blob([Uint8Array.from(image.data).buffer], { type: image.mediaType }), `dsh-${image.variantId.slice(7, 31)}`)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, ...attributionHeaders() },
        body: form,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      throw new FileUploadError(error)
    }
    if (!response.ok) throw new FileUploadError(new Error(`HTTP ${response.status}`))
    let result: { id?: unknown; expires_at?: unknown }
    try {
      result = await response.json() as { id?: unknown; expires_at?: unknown }
      if (typeof result.id !== 'string' || result.id.length === 0) throw new Error('missing file id')
    } catch (error: unknown) {
      throw new FileUploadError(error)
    }
    return {
      fileId: result.id,
      expiresAt: typeof result.expires_at === 'number'
        ? result.expires_at * 1000
        : Date.now() + FILE_EXPIRY_SECONDS * 1000,
    }
  }

  private async ensureUploaded(
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    image: RequestImage,
    signal?: AbortSignal,
  ): Promise<{ key: string; file: CachedFile }> {
    const key = this.fileCacheKey(connection, apiKey, image)
    const existing = this.fileCache.get(key)
    if (existing !== undefined) {
      const file = await existing
      if (file.expiresAt - Date.now() > FILE_REFRESH_MARGIN_MS) {
        this.fileCache.delete(key)
        this.fileCache.set(key, existing)
        return { key, file }
      }
      this.fileCache.delete(key)
    }
    const created = this.uploadImage(connection, apiKey, image, signal).catch((error: unknown) => {
      this.fileCache.delete(key)
      throw error
    })
    this.fileCache.set(key, created)
    if (this.fileCache.size > MAX_CACHED_FILES) this.fileCache.delete(this.fileCache.keys().next().value as string)
    return { key, file: await created }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override async accountBalance(provider: string, signal?: AbortSignal): Promise<LlmAccountBalance> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/user/balance`, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...attributionHeaders(),
        },
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      throw new LlmError(`DeepSeek balance request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      throw new LlmError(`DeepSeek balance API error (HTTP ${response.status})`, httpErrorCode(response.status), {
        status: response.status,
      })
    }
    const body = await response.json() as {
      is_available?: unknown
      balance_infos?: Array<Record<string, unknown>>
    }
    if (typeof body.is_available !== 'boolean' || !Array.isArray(body.balance_infos)) {
      throw new LlmError('DeepSeek balance API returned an invalid response', 'INVALID_RESPONSE')
    }
    return {
      provider,
      available: body.is_available,
      balances: body.balance_infos.flatMap((item) => {
        const currency = item.currency
        const totalBalance = item.total_balance
        const grantedBalance = item.granted_balance
        const toppedUpBalance = item.topped_up_balance
        return typeof currency === 'string' && typeof totalBalance === 'string'
          && typeof grantedBalance === 'string' && typeof toppedUpBalance === 'string'
          ? [{ currency, totalBalance, grantedBalance, toppedUpBalance }]
          : []
      }),
    }
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // The chat-completions wire route is text-only regardless of catalog
      // membership, so the uncatalogued fallback declares the same negative
      // capability — "unknown" here would let the host accept and persist
      // images the serializer must then reject.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...connection.defaults.thinking === 'disabled'
        ? {
          reasoning: {
            efforts: OFF_ONLY_REASONING_EFFORTS,
            defaultEffort: OFF_REASONING_EFFORT,
          },
        }
        : {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: connection.defaults.reasoningEffort === 'off'
              ? OFF_REASONING_EFFORT
              : connection.defaults.reasoningEffort === 'max'
                ? MAX_REASONING_EFFORT
                : HIGH_REASONING_EFFORT,
          },
        },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const connection = this.config.options()
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    const model = connection.models.find(entry => entry.id === options.model)
    if (hasImages && model?.inputModalities?.includes('image') !== true) {
      throw new LlmError(`DeepSeek model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = hasImages ? this.config.resolveAttachments?.() : undefined
    if (hasImages && attachments === undefined) {
      throw new LlmError('DeepSeek image conversion requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    attachments: AttachmentStore | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    const buildBody = async (mode: 'file' | 'inline') => {
      if (attachments === undefined) return { body: serializeRequest(options, connection.defaults), cacheKeys: [] as string[] }
      let imageCount = 0
      let inlineBytes = 0
      const cacheKeys: string[] = []
      const serializeImage = async (stored: StoredImageAttachment, uploadSignal?: AbortSignal) => {
        imageCount += 1
        if (imageCount > MAX_REQUEST_IMAGES) {
          throw new LlmError(`DeepSeek vision request exceeds ${MAX_REQUEST_IMAGES} images.`, 'INVALID_REQUEST')
        }
        const image = await prepareRequestImage(stored)
        if (mode === 'inline') {
          inlineBytes += image.data.byteLength
          if (inlineBytes > MAX_INLINE_IMAGE_BYTES) {
            throw new LlmError('DeepSeek inline image fallback exceeds 20 MiB.', 'INVALID_REQUEST')
          }
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}` },
          }
        }
        const uploaded = await this.ensureUploaded(connection, apiKey, image, uploadSignal)
        cacheKeys.push(uploaded.key)
        return { type: 'file' as const, file_id: uploaded.file.fileId }
      }
      return {
        body: await serializeRequestWithImages(options, attachments, serializeImage, connection.defaults),
        cacheKeys,
      }
    }

    let mode: 'file' | 'inline' = 'file'
    let requestBody: Awaited<ReturnType<typeof buildBody>>
    try {
      requestBody = await buildBody(mode)
    } catch (error: unknown) {
      if (!(error instanceof FileUploadError) || signal.aborted) throw error
      mode = 'inline'
      requestBody = await buildBody(mode)
    }
    const send = async (body: WireRequest): Promise<Response> => {
      try {
        return await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(
          `DeepSeek API request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    }

    let response = await send(requestBody.body)
    let message = `DeepSeek API error (HTTP ${response.status})`
    let providerError: WireError['error']
    if (!response.ok) {
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // The HTTP status remains sufficient when a gateway returns malformed JSON.
      }
      if (mode === 'file' && isFileResolutionError(response.status, providerError)) {
        for (const key of requestBody.cacheKeys) this.fileCache.delete(key)
        mode = 'inline'
        requestBody = await buildBody(mode)
        response = await send(requestBody.body)
        message = `DeepSeek API error (HTTP ${response.status})`
        providerError = undefined
        if (!response.ok) {
          try {
            const parsed = await response.json() as WireError
            providerError = parsed.error
            if (providerError?.message) message = providerError.message
          } catch {
            // The retry's HTTP status remains sufficient.
          }
        }
      }
    }
    if (!response.ok) {
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translate(parseSse(response.body, onComment))
  }
}
