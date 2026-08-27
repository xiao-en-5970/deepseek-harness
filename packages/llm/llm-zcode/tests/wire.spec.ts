import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ZCodeWire } from '@deepseek-ai/dsh-llm-zcode'

describe('ZCodeWire', () => {
  it('uses ZCode NDJSON framing, answers runtime preferences, and streams session events', async () => {
    const fromServer = new PassThrough()
    const toServer = new PassThrough()
    const written: string[] = []
    toServer.setEncoding('utf8')
    toServer.on('data', chunk => written.push(String(chunk)))
    const wire = new ZCodeWire(fromServer, toServer)

    const request = wire.request('session/send', { sessionId: 'sess_test', content: 'hello' })
    expect(JSON.parse(written.join('').trim())).toEqual({
      id: '1',
      method: 'session/send',
      params: { sessionId: 'sess_test', content: 'hello' },
    })
    expect(written.join('')).not.toContain('jsonrpc')

    fromServer.write(`${JSON.stringify({
      id: 'server-1',
      method: 'session/requestRuntimePreferences',
      params: { sessionId: 'sess_test', scope: 'user-execution' },
    })}\n`)
    await new Promise(resolve => setImmediate(resolve))
    expect(JSON.parse(written.at(-1)!.trim())).toEqual({
      id: 'server-1',
      result: { nativeSearchEnhancementsEnabled: false },
    })

    fromServer.write(`${JSON.stringify({ id: '1', result: { accepted: true } })}\n`)
    await expect(request).resolves.toEqual({ accepted: true })

    const event = wire.event()
    fromServer.write(`${JSON.stringify({
      method: 'session/event',
      params: { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: 'thinking' } },
    })}\n`)
    await expect(event).resolves.toEqual({
      type: 'model.streaming',
      payload: { kind: 'reasoning_delta', delta: 'thinking' },
    })
    wire.close()
  })
})
