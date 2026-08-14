import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import CodexImageProxy from '@deepseek-ai/dsh-codex-image-proxy'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolCodexImageProxy from '@deepseek-ai/dsh-tool-codex-image-proxy'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function mount(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-codex-image-'))
  ctx = new Context()
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(CodexImageProxy, {
    queueRoot: join(root, 'queue'), tenantKey: 'default', publicBaseUrl: 'http://example.test',
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolCodexImageProxy)
  return ctx
}

describe('generate_image tool', () => {
  it('keeps Loader metadata and registers one model-visible tool', async () => {
    const mounted = await mount()
    expect(ToolCodexImageProxy.inject).toEqual(['codexImageProxy', 'tools', 'systemPrompt'])
    expect(mounted.tools.schemas().map(schema => schema.name)).toEqual(['generate_image'])
    const prompt = await mounted.systemPrompt.assemble()
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('use the generate_image tool')
  })

  it('surfaces an offline worker as a usable model result', async () => {
    const mounted = await mount()
    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-offline'),
      name: 'generate_image',
      arguments: { prompt: 'a blue circle', context: 'flat icon' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('offline') as unknown as string }])
  })

  it('rejects a blank prompt before touching the host queue', async () => {
    const mounted = await mount()
    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-invalid'),
      name: 'generate_image',
      arguments: { prompt: '   ' },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('non-empty') as unknown as string }])
  })
})
