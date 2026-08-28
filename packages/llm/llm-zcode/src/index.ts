/** ZCode app-server agent proxy for the Harness LLM seam. */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Message, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey, attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { ZCodeWire, type ZCodeEvent } from './wire.ts'

export { ZCodeWire } from './wire.ts'

export const name = 'llm-zcode'
export const inject = ['agents', 'credentials', 'llm', 'subprocess']
const PROVIDER = 'zcode'
const CHILD_KEY = 'ZCODE_HARNESS_API_KEY'

/** ZCode executable, provider endpoint, credential, and model defaults. */
export interface Config {
  /** ZCode CLI command or absolute executable path. */
  command?: string
  /** Harness credential reference containing the provider API key. */
  apiKeyEnv?: string
  /** OpenAI-compatible endpoint used by ZCode. */
  baseURL?: string
  /** Optional persistent ZCode state directory. */
  dataDir?: string
  /** Model offered when no explicit model is selected. */
  defaultModel?: string
  /** Context window reported to Harness and ZCode. */
  contextWindow?: number
  /** Maximum output token count reported to Harness and ZCode. */
  maxOutputTokens?: number
  /** Native ZCode permission mode. */
  mode?: 'build' | 'edit' | 'plan' | 'yolo'
}

const MODELS = ['glm-5', 'glm-5.3-flash', 'glm-5.3'] as const

type ResolvedConfig = Required<Omit<Config, 'dataDir'>> & { dataDir: string | undefined }

export const Config: z<Config> = z.object({
  command: z.string().default('zcode'),
  apiKeyEnv: z.string().role('credential-ref').default('ZAI_API_KEY'),
  baseURL: z.string().default('https://open.bigmodel.cn/api/paas/v4'),
  dataDir: z.string(),
  defaultModel: z.string().default('glm-5'),
  contextWindow: z.number().step(1).min(1).default(202_752),
  maxOutputTokens: z.number().step(1).min(1).default(65_536),
  mode: z.union(['build', 'edit', 'plan', 'yolo']).default('yolo'),
})

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function text(message: Message): string {
  return message.content.flatMap((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'tool-result') {
      return [block.content.filter(part => part.type === 'text').map(part => part.text).join('\n')]
    }
    return []
  }).filter(Boolean).join('\n')
}

function inputOf(options: GenerateOptions): { input: string; history: Array<{ role: 'user' | 'assistant'; content: string }> } {
  let inputIndex = -1
  for (let index = options.messages.length - 1; index >= 0; index--) {
    const message = options.messages[index]
    if (message?.role === 'user' && message.source.kind === 'user') {
      inputIndex = index
      break
    }
  }
  if (inputIndex < 0) throw new LlmError('llm-zcode: no user message to forward', 'UNSUPPORTED_OPTION')
  const input = text(options.messages[inputIndex] as Message)
  if (input.trim().length === 0) throw new LlmError('llm-zcode: image-only input is not supported yet', 'UNSUPPORTED_OPTION')
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (options.system?.trim()) history.push({ role: 'user', content: `[Harness instructions]\n${options.system}` })
  for (const message of options.messages.slice(0, inputIndex)) {
    const content = text(message)
    if (content.trim()) history.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
  }
  if (history.length === 0) history.push({ role: 'user', content: 'DeepSeek Harness session initialized.' })
  return { input, history }
}

function runtimeModel(config: Required<Omit<Config, 'dataDir'>>, model: string): Record<string, unknown> {
  const providerId = 'harness-zcode'
  return {
    revision: hash(`${config.baseURL}\0${model}`).slice(0, 24),
    generatedAt: Date.now(),
    model: { providerId, modelId: model },
    provider: {
      providerId,
      kind: 'openai-compatible',
      apiFormat: 'openai-chat-completions',
      source: 'ephemeral',
      baseURL: config.baseURL,
      apiKey: { source: 'env', name: CHILD_KEY },
      apiKeyRequired: true,
      headers: attributionHeaders(),
      models: [{
        modelId: model,
        label: model,
        contextWindow: config.contextWindow,
        maxOutputTokens: config.maxOutputTokens,
        supportsTools: true,
      }],
    },
  }
}

function usageOf(event: ZCodeEvent): TokenUsage {
  const usage = event.payload?.usage
  const row = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
    ? usage as Record<string, unknown>
    : {}
  return {
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheReadTokens: Number(row.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
    reasoningTokens: Number(row.reasoningTokens ?? 0),
  }
}

async function dispose(wire: ZCodeWire, child: SubprocessHandle): Promise<void> {
  wire.close()
  try { child.stdin?.end() } catch {}
  child.terminate()
  await child.waitForExit()
  await child.done.catch(() => {})
}

class ZCodeAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly current: () => ResolvedConfig,
    private readonly resolveApiKey: () => Promise<string>,
  ) { super() }

  override providerInfo(): { id: string; name: string } {
    return { id: PROVIDER, name: 'ZCode Agent' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MODELS.map(id => ({ provider: PROVIDER, id, name: id, inputModalities: ['text'] })))
  }

  override resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const config = this.current()
    return Promise.resolve({
      provider: PROVIDER,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: config.contextWindow },
      defaultMaxTokens: config.maxOutputTokens,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.tools?.length) {
      throw new LlmError('llm-zcode: select the "ZCode 代理" preset; ZCode executes its own tools', 'UNSUPPORTED_OPTION')
    }
    if (options.stop !== undefined || options.temperature !== undefined || options.purpose !== undefined) {
      throw new LlmError('llm-zcode: stop, temperature, and auxiliary calls are not supported', 'UNSUPPORTED_OPTION')
    }
    if (options.sessionId === undefined) throw new LlmError('llm-zcode: a Harness session id is required', 'UNSUPPORTED_OPTION')
    const config = this.current()
    const apiKey = await this.resolveApiKey()
    const cwd = this.ctx.agents.get(options.sessionId)?.session.header.cwd ?? process.cwd()
    const sessionId = `sess_dsh_${hash(String(options.sessionId)).slice(0, 32)}`
    const workspace = { workspacePath: cwd, workspaceKey: hash(cwd).slice(0, 24) }
    const model = runtimeModel(config, options.model)
    const request = inputOf(options)
    const child = this.ctx.subprocess.spawn({
      argv: [config.command, 'app-server', '--surface', 'terminal', '--no-color'],
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: 3_000,
      signal: options.signal,
      env: {
        [CHILD_KEY]: apiKey,
        ZCODE_DATA_BASE_DIR: config.dataDir ?? join(process.env.DSH_HOME ?? cwd, 'zcode'),
      },
    })
    const wire = new ZCodeWire(
      child.stdout as NonNullable<SubprocessHandle['stdout']>,
      child.stdin as NonNullable<SubprocessHandle['stdin']>,
    )
    try {
      try {
        await wire.request('session/resume', { sessionId, workspace, runtimeModel: model })
      } catch (error) {
        if ((error as { code?: unknown }).code !== -32004) throw error
        await wire.request('session/create', {
          sessionId,
          workspace,
          mode: config.mode,
          runtimeModel: model,
          importedHistory: { source: 'claudeCode', messages: request.history },
        })
      }
      await wire.request('session/subscribe', {
        sessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: false,
      })
      await wire.request('session/send', { sessionId, content: request.input, runtimeModel: model })

      let reasoning = ''
      let answer = ''
      let reasoningStarted = false
      let textStarted = false
      for (;;) {
        const event = await wire.event(options.signal)
        if (event.type === 'model.streaming') {
          const kind = event.payload?.kind
          const delta = typeof event.payload?.delta === 'string' ? event.payload.delta : ''
          if (kind === 'reasoning_delta' && delta !== '') {
            if (!reasoningStarted) {
              reasoningStarted = true
              yield { type: 'block-start', index: 0, blockType: 'reasoning' }
            }
            reasoning += delta
            yield { type: 'reasoning-delta', index: 0, text: delta }
          } else if (kind === 'text_delta' && delta !== '') {
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: 1, blockType: 'text' }
            }
            answer += delta
            yield { type: 'text-delta', index: 1, text: delta }
          }
          continue
        }
        if (event.type === 'turn.failed') {
          throw new Error(`llm-zcode: ZCode turn failed: ${String(event.payload?.error ?? 'unknown error')}`)
        }
        if (event.type !== 'turn.completed') continue
        const finalAnswer = typeof event.payload?.response === 'string' ? event.payload.response : ''
        if (!textStarted && finalAnswer !== '') {
          textStarted = true
          answer = finalAnswer
          yield { type: 'block-start', index: 1, blockType: 'text' }
          yield { type: 'text-delta', index: 1, text: finalAnswer }
        }
        if (reasoningStarted) yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
        if (textStarted) yield { type: 'block-end', index: 1, block: { type: 'text', text: answer } }
        yield { type: 'usage', usage: usageOf(event) }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
    } finally {
      if (options.signal?.aborted) void wire.request('session/stop', { sessionId }).catch(() => {})
      await dispose(wire, child)
    }
  }
}

function resolved(config: Config): ResolvedConfig {
  return {
    command: config.command ?? 'zcode',
    apiKeyEnv: config.apiKeyEnv ?? 'ZAI_API_KEY',
    baseURL: config.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: config.defaultModel ?? 'glm-5',
    contextWindow: config.contextWindow ?? 202_752,
    maxOutputTokens: config.maxOutputTokens ?? 65_536,
    mode: config.mode ?? 'yolo',
    dataDir: config.dataDir,
  }
}

export function apply(ctx: Context, config: Config): void {
  let source = (): Config => config
  const current = (): ReturnType<typeof resolved> => resolved(source())
  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(current().apiKeyEnv)
    const credential = await ctx.credentials.resolve(ref)
    if (credential !== undefined) return assertUsableApiKey(credential.value, name, ref)
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined) return assertUsableApiKey(ambient.value, name, ref)
    throw new LlmError(`llm-zcode: no API key for ${ref}`, 'MISSING_CREDENTIAL')
  }
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'ZCode Agent', settingsNs: settingsNamespace(name), settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], new ZCodeAdapter(ctx, current, resolveApiKey))
  installSettingsSection(ctx, settingsNamespace(name), Config, config, {
    setSource: (next) => { source = next },
    onChange: () => {},
  })
}
