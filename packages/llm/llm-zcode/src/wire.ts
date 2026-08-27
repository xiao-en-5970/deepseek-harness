/** Minimal newline-delimited ZCode Protocol client. */

import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

type JsonObject = Record<string, unknown>

/** Session event published by ZCode's app-server protocol. */
export interface ZCodeEvent extends JsonObject {
  type: string
  payload?: JsonObject
}

function asObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`llm-zcode: invalid ${label}`)
  }
  return value as JsonObject
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  const error = asObject(value, 'protocol error')
  const result = new Error(`llm-zcode: ${String(error.message ?? 'ZCode request failed')}`)
  Object.assign(result, { code: error.code, data: error.data })
  return result
}

/** One app-server connection; ZCode deliberately omits the JSON-RPC `jsonrpc` field. */
export class ZCodeWire {
  private readonly lines: Interface
  private readonly pending = new Map<string, PromiseWithResolvers<unknown>>()
  private readonly events: ZCodeEvent[] = []
  private readonly waiters: PromiseWithResolvers<ZCodeEvent>[] = []
  private nextId = 0
  private failure: Error | undefined

  constructor(input: Readable, private readonly output: Writable) {
    this.lines = createInterface({ input })
    this.lines.on('line', this.onLine)
    input.on('error', this.fail)
    input.on('end', this.onEnd)
    output.on('error', this.fail)
  }

  /**
   * Sends one protocol request and resolves with its response result.
   * @param method ZCode protocol method.
   * @param params Method parameters.
   * @returns The response result.
   */
  request(method: string, params: JsonObject): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = String(++this.nextId)
    const pending = Promise.withResolvers<unknown>()
    this.pending.set(id, pending)
    this.write({ id, method, params })
    return pending.promise
  }

  /**
   * Returns the next published session event.
   * @param signal Optional cancellation signal.
   * @returns The next ZCode event.
   */
  async event(signal?: AbortSignal): Promise<ZCodeEvent> {
    if (this.events.length > 0) return this.events.shift() as ZCodeEvent
    if (this.failure !== undefined) throw this.failure
    const waiter = Promise.withResolvers<ZCodeEvent>()
    this.waiters.push(waiter)
    if (signal === undefined) return waiter.promise
    if (signal.aborted) {
      this.removeWaiter(waiter)
      throw signal.reason instanceof Error ? signal.reason : new Error('llm-zcode: aborted')
    }
    const onAbort = (): void => {
      this.removeWaiter(waiter)
      waiter.reject(signal.reason instanceof Error ? signal.reason : new Error('llm-zcode: aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return waiter.promise.finally(() => signal.removeEventListener('abort', onAbort))
  }

  /** Closes the protocol reader and rejects outstanding work. */
  close(): void {
    this.lines.close()
    this.fail(new Error('llm-zcode: app-server connection closed'))
  }

  private readonly onLine = (line: string): void => {
    let frame: JsonObject
    try {
      frame = asObject(JSON.parse(line), 'protocol frame')
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (frame.id !== undefined && typeof frame.method === 'string') {
      if (frame.method === 'session/requestRuntimePreferences') {
        this.write({ id: frame.id, result: { nativeSearchEnhancementsEnabled: false } })
      } else {
        this.write({ id: frame.id, error: { code: -32601, message: `Unsupported reverse request: ${frame.method}` } })
      }
      return
    }
    if (frame.id !== undefined) {
      const id = String(frame.id)
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      if (frame.error !== undefined) pending.reject(asError(frame.error))
      else pending.resolve(frame.result)
      return
    }
    if (frame.method !== 'session/event') return
    const event = asObject(frame.params, 'session event') as ZCodeEvent
    if (typeof event.type !== 'string') return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.events.push(event)
    else waiter.resolve(event)
  }

  private readonly onEnd = (): void => this.fail(new Error('llm-zcode: app-server exited'))

  private readonly fail = (error: Error): void => {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.length = 0
  }

  private removeWaiter(waiter: PromiseWithResolvers<ZCodeEvent>): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
  }

  private write(frame: JsonObject): void {
    this.output.write(`${JSON.stringify(frame)}\n`)
  }
}
