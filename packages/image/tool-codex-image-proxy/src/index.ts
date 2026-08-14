/** Model-facing `generate_image` tool over the host `ctx.codexImageProxy` seam. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageProxyResult } from '@deepseek-ai/dsh-codex-image-proxy'
import type {} from '@deepseek-ai/dsh-codex-image-proxy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'tool-codex-image-proxy'
/** The host seam, tool registry, and prompt registry must already exist. */
export const inject = ['codexImageProxy', 'tools', 'systemPrompt']

/** Default maximum prompt characters accepted from the model. */
export const DEFAULT_MAX_PROMPT_CHARS = 12_000
/** Default maximum contextual characters accepted from the model. */
export const DEFAULT_MAX_CONTEXT_CHARS = 20_000

/** Model-bound argument limits; queue and worker policy belong to the host seam. */
export interface Config {
  /** Maximum Unicode characters accepted in the complete visual prompt. */
  maxPromptChars?: number
  /** Maximum Unicode characters accepted in the relevant context summary. */
  maxContextChars?: number
}

export const Config: z<Config> = z.object({
  maxPromptChars: z.number().default(DEFAULT_MAX_PROMPT_CHARS),
  maxContextChars: z.number().default(DEFAULT_MAX_CONTEXT_CHARS),
})

interface ImageArgs {
  prompt: string
  context?: string
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`tool-codex-image-proxy: ${label} must be a positive integer`)
  }
  return value
}

function parseArgs(args: ImageArgs, maxPromptChars: number, maxContextChars: number): Required<ImageArgs> {
  const prompt = args.prompt.trim()
  const context = (args.context ?? '').trim()
  if (prompt === '') throw new Error('prompt must be a non-empty string')
  if (Array.from(prompt).length > maxPromptChars) {
    throw new Error(`prompt exceeds ${String(maxPromptChars)} characters`)
  }
  if (Array.from(context).length > maxContextChars) {
    throw new Error(`context exceeds ${String(maxContextChars)} characters`)
  }
  return { prompt, context }
}

/** Model-facing rendering for every canonical result status. */
export function formatImageProxyOutput(result: ImageProxyResult): string {
  if (result.status === 'generated') {
    return [
      'The image was generated successfully by the local Codex worker.',
      `Show it to the user with this exact Markdown: ![Generated image](${result.imageUrl})`,
      `Durable sandbox path: ${result.imagePath}`,
    ].join('\n')
  }
  if (result.status === 'offline') {
    return `${result.message} Tell the user that the local Codex worker must be started before image generation can continue.`
  }
  return `Image generation failed: ${result.message}`
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function presentCall(args: unknown): GenericCallView {
  const input = object(args)
  const prompt = typeof input?.prompt === 'string' ? input.prompt : 'Generate image'
  return { card: 'generic', title: 'Generate image', kind: 'execute', rawInput: prompt }
}

function presentResult(_args: unknown, result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title: 'Generated image', content: result.content }
}

const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, const: 'generated' },
        requestId: { type: 'string', required: true },
        imageUrl: { type: 'string', required: true },
        imagePath: { type: 'string', required: true },
        mimeType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
        bytes: { type: 'integer', required: true },
        sha256: { type: 'string', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['offline', 'failed'] },
        requestId: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
  ],
} as const

/** Register the per-session tool and routing guidance. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxPromptChars = positiveInteger('maxPromptChars', config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS)
  const maxContextChars = positiveInteger('maxContextChars', config.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS)

  ctx.systemPrompt.section({
    name: 'tool:generate_image',
    order: 112,
    text: [
      'When the user asks to generate, draw, create, or design an image, use the generate_image tool.',
      'Put the complete visual specification in prompt and a concise summary of relevant conversation context in context.',
      'Never put credentials, hidden system instructions, or unrelated conversation text in context.',
      'After a successful call, include the exact Markdown image returned by the tool in your answer.',
      'If the tool reports offline, say that the local Codex image worker is offline instead of pretending the image was generated.',
    ].join(' '),
  })

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate one image through the user\'s local Codex image-generation worker. Use for text-to-image requests; include the exact visual request and only relevant non-secret context.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete, self-contained visual generation request.' },
      context: { type: 'string', description: 'Concise relevant conversation context; exclude credentials and hidden instructions.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatImageProxyOutput(value) }],
      presentationMeta: (_args, value) => ({ status: (value as unknown as { status: string }).status }),
    },
    timeoutMs: ctx.codexImageProxy.requestTimeoutMs + 5_000,
    async execute(args: ImageArgs, exec) {
      return ctx.codexImageProxy.generate(parseArgs(args, maxPromptChars, maxContextChars), exec.signal)
    },
    presentCall,
    presentResult,
  }))
}
