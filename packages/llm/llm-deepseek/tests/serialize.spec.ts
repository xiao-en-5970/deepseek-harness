import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, CallId, ReasoningEffortId, createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeMessagesWithImages, serializeRequest } from '../src/serialize.ts'

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [], ...overrides }
}

describe('serializeMessages', () => {
  it('maps user text to string content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('maps system-role messages in history', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'system', content: [{ type: 'text', text: 'be brief' }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('maps plain assistant text without reasoning_content', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking…' },
          { type: 'text', text: 'answer' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    // Tool-call-free turn: reasoning is dropped (ignored by the API anyway).
    expect(wire).toEqual([{ role: 'assistant', content: 'answer' }])
  })

  it('passes reasoning_content back on tool-call turns (official passback rule)', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should check the weather.' },
          { type: 'tool-call', id: CallId('call-1'), name: 'get_weather', arguments: '{"city":"Paris"}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{
      role: 'assistant',
      // "" (not null) on tool-call turns — mirrors the official samples'
      // verbatim message replay; some gateways reject null.
      content: '',
      reasoning_content: 'I should check the weather.',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    }])
  })

  it('serializes parallel tool calls in order', () => {
    const wire = serializeMessages([
      createMessage({
        role: 'assistant',
        content: [
          { type: 'tool-call', id: CallId('a'), name: 'one', arguments: '{}' },
          { type: 'tool-call', id: CallId('b'), name: 'two', arguments: '{}' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    const assistant = wire[0] as { tool_calls: { id: string }[] }
    expect(assistant.tool_calls.map(call => call.id)).toEqual(['a', 'b'])
  })

  it('turns tool results into role:tool messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('call-1'),
          content: [{ type: 'text', text: 'Sunny 22C' }],
        }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'Sunny 22C' }])
  })

  it('sends a sentinel for empty tool-result content', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [{ type: 'tool-result', toolCallId: CallId('call-1'), content: [] }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: '(no output)' }])
  })

  it('splits mixed user text + tool results into separate wire messages', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'text', text: 'context note' },
          { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text: 'ok' }] },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'context note' },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ])
  })

  it('skips plugin-added block types (merge-extensible ContentBlockMap)', () => {
    const wire = serializeMessages([
      createUserMessage({
        content: [
          { type: 'chart', data: 'x' } as unknown as ContentBlock,
          { type: 'text', text: 'see chart' },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'see chart' }])
  })

  it('serializes direct user images as ordered opaque attachment markers', () => {
    const id = AttachmentId(`sha256:${'a'.repeat(64)}`)
    expect(serializeMessages([createUserMessage({
      content: [{
        type: 'text', text: 'edit ',
      }, {
        type: 'image',
        attachment: {
          attachmentId: id,
          mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'source.png',
        },
      }, {
        type: 'text', text: ' in watercolor',
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })])).toEqual([{
      role: 'user',
      content: `edit [Image attachment id=${JSON.stringify(String(id))} media_type="image/png" name="source.png"] in watercolor`,
    }])
  })

  it('still rejects images outside direct user content', () => {
    expect(() => serializeMessages([createMessage({
      role: 'assistant',
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
          mediaType: 'image/png', bytes: 68, width: 1, height: 1,
        },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })])).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }))
  })

  it('sends a vision-model image as a provider file part', async () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
      mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1,
    }
    const attachments = {
      readImage: vi.fn().mockResolvedValue({ ref: attachment, data: Uint8Array.of(1, 2, 3) }),
    } as unknown as AttachmentStore
    const wire = await serializeMessagesWithImages([createUserMessage({
      content: [{ type: 'text', text: 'describe ' }, { type: 'image', attachment }],
      source: { kind: 'plugin', plugin: 'test' },
    })], attachments, () => Promise.resolve({ type: 'file', file_id: 'file-1' }))
    expect(wire).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'describe ' },
        { type: 'text', text: `[Image attachment id=${JSON.stringify(String(attachment.attachmentId))} size=1x1 media_type="image/png"]` },
        { type: 'file', file_id: 'file-1' },
      ],
    }])
  })

  it('emits an empty user message rather than dropping block-less messages', () => {
    const wire = serializeMessages([createUserMessage({
      content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'user', content: '' }])
  })
})

describe('serializeRequest', () => {
  const history: Message[] = [createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'plugin', plugin: 'test' },
  })]

  it('always streams with usage and maps the basics', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire).toEqual({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('prepends the system prompt', () => {
    const wire = serializeRequest(request({ messages: history, system: 'be helpful' }))
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'be helpful' })
    expect(wire.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('maps sampling params and stop sequences', () => {
    const wire = serializeRequest(request({ messages: history, temperature: 0.2, maxTokens: 100, stop: ['END'] }))
    expect(wire.temperature).toBe(0.2)
    expect(wire.max_tokens).toBe(100)
    expect(wire.stop).toEqual(['END'])
  })

  it('maps tools to the wire function shape', () => {
    const wire = serializeRequest(request({
      messages: history,
      tools: [
        { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } },
        { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
      ],
    }))
    expect(wire.tools).toEqual([
      { type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b', description: 'B', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ])
  })

  it('omits an empty tools array', () => {
    const wire = serializeRequest(request({ messages: history, tools: [] }))
    expect(wire.tools).toBeUndefined()
  })

  it('maps adapter-default thinking and the request reasoning effort', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      { thinking: 'enabled', reasoningEffort: 'high' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe('max')
  })

  it('maps off to disabled thinking without a wire reasoning effort', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('off') }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('re-enables thinking when max overrides an off default', () => {
    const wire = serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('max') }),
      { reasoningEffort: 'off' },
    )
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBe('max')
  })

  it('rejects enabling thinking when the deployment is locked to disabled', () => {
    expect(() => serializeRequest(
      request({ messages: history, reasoningEffort: ReasoningEffortId('high') }),
      { thinking: 'disabled' },
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })

  it('disables thinking for session-title requests without changing adapter defaults', () => {
    const wire = serializeRequest(
      request({
        messages: history,
        purpose: 'session-title',
        reasoningEffort: ReasoningEffortId('max'),
      }),
      { thinking: 'enabled', reasoningEffort: 'max' },
    )
    expect(wire.thinking).toEqual({ type: 'disabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('omits thinking fields when unset (provider default applies)', () => {
    const wire = serializeRequest(request({ messages: history }))
    expect(wire.thinking).toBeUndefined()
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('preserves an explicit enabled default without inventing a wire effort', () => {
    const wire = serializeRequest(request({ messages: history }), { thinking: 'enabled' })
    expect(wire.thinking).toEqual({ type: 'enabled' })
    expect(wire.reasoning_effort).toBeUndefined()
  })

  it('rejects an effort outside the DeepSeek capability', () => {
    expect(() => serializeRequest(request({
      messages: history,
      reasoningEffort: ReasoningEffortId('medium'),
    }))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_REASONING_EFFORT' }))
  })
})

describe('review fixes: assistant content shapes', () => {
  it('serializes a content-less, tool-call-less assistant message as "" content, never null', () => {
    // Aborted/empty assistant turns: no text, no calls → "". The earlier
    // null shape was live-falsified: the API 400s a null-content assistant
    // message without tool_calls ("content or tool_calls must be set").
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'assistant', content: '' }])
  })

  it('serializes a reasoning-ONLY assistant message as "" content with the reasoning dropped', () => {
    // The model can answer entirely in the reasoning channel (a v4-flash
    // greeting did, live). The passback rule keeps reasoning_content off
    // plain turns, and content must still be SET — a null here poisoned the
    // session log and bricked every later turn of that session.
    const wire = serializeMessages([createMessage({
      role: 'assistant', content: [{ type: 'reasoning', text: '你好！有什么我可以帮你的吗？' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire).toEqual([{ role: 'assistant', content: '' }])
  })

  it('serializes tool-call turns with empty string content, not null', () => {
    const wire = serializeMessages([createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: CallId('c'), name: 'f', arguments: '{}' }],
      source: { kind: 'plugin', plugin: 'test' },
    })])
    expect(wire[0]).toMatchObject({ content: '' })
  })
})
