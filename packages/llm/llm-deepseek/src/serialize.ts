/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call turns, as required by
 * thinking-mode passback. Direct user image blocks become opaque attachment markers for a registered
 * image-tool bridge; no bytes, Host paths, or internal URLs enter this text-only wire route. Images in
 * every other role remain rejected.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireMessage, WireRequest, WireTool, WireUserContentPart } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Stable text marker that lets a model route a durable user attachment to a tool. */
function imageMarker(block: Extract<ContentBlock, { type: 'image' }>): string {
  const ref = block.attachment
  const fields = [
    `id=${JSON.stringify(String(ref.attachmentId))}`,
    `media_type=${JSON.stringify(ref.mediaType)}`,
  ]
  if (ref.name !== undefined) fields.push(`name=${JSON.stringify(ref.name)}`)
  return `[Image attachment ${fields.join(' ')}]`
}

/** Preserve direct user text/image order while omitting unrelated extension blocks. */
function flattenUserContent(blocks: ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return imageMarker(block)
    return ''
  }).join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Resolve one durable image into the representation selected by the adapter. */
export type SerializeImage = (
  stored: StoredImageAttachment,
  signal?: AbortSignal,
) => Promise<Extract<WireUserContentPart, { type: 'file' | 'image_url' }>>

async function contentParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
  serializeImage: SerializeImage,
  signal?: AbortSignal,
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const stored = await attachments.readImage(block.attachment, signal)
      parts.push({
        type: 'text',
        text: `[Image attachment id=${JSON.stringify(String(stored.ref.attachmentId))} size=${stored.ref.width}x${stored.ref.height} media_type=${JSON.stringify(stored.ref.mediaType)}]`,
      })
      parts.push(await serializeImage(stored, signal))
    }
  }
  return parts
}

function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  return parts.every(part => part.type === 'text')
    ? parts.map(part => (part as { type: 'text'; text: string }).text).join('')
    : [...parts]
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // Official passback rule (guides/thinking_mode.mdx): reasoning_content
    // must return on tool-call turns; it is ignored on plain turns, so we
    // drop it there to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenUserContent(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      assertTextOnly(result.content)
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Serialize image-capable history without putting attachment bytes into durable messages.
 * @param messages - durable harness conversation history.
 * @param attachments - durable attachment storage.
 * @param serializeImage - provider image preparation function.
 * @param signal - optional request cancellation.
 * @returns provider wire messages with resolved image content.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  attachments: AttachmentStore,
  serializeImage: SerializeImage,
  signal?: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertTextOnly(message.content)
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertTextOnly(message.content)
      wire.push(serializeAssistant(message))
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result')
    const content = userContent(await contentParts(regular, attachments, serializeImage, signal))
    if (content.length > 0 || toolResults.length === 0) wire.push({ role: 'user', content })
    for (const result of toolResults) {
      const parts = await contentParts(result.content, attachments, serializeImage, signal)
      const text = parts.filter((part): part is Extract<WireUserContentPart, { type: 'text' }> => part.type === 'text')
        .map(part => part.text).join('')
      const images = parts.filter((part): part is Exclude<WireUserContentPart, { type: 'text' }> => part.type !== 'text')
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: text || '(no output)' })
      if (images.length > 0) wire.push({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...images] })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/**
 * Build a request after resolving durable images for a vision-capable model.
 * @param options - harness request containing image references.
 * @param attachments - durable attachment storage.
 * @param serializeImage - provider image preparation function.
 * @param defaults - adapter-level request defaults.
 * @returns complete provider wire request.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  serializeImage: SerializeImage,
  defaults: RequestDefaults = {},
): Promise<WireRequest> {
  const request = serializeRequest({ ...options, messages: [] }, defaults)
  if (options.system !== undefined) request.messages.push({ role: 'system', content: options.system })
  request.messages.push(...await serializeMessagesWithImages(options.messages, attachments, serializeImage, options.signal))
  return request
}
