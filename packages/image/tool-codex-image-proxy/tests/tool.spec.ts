import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import CodexImageProxy from '@deepseek-ai/dsh-codex-image-proxy'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolCodexImageProxy from '@deepseek-ai/dsh-tool-codex-image-proxy'

let ctx: Context | undefined
let root: string | undefined
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

async function mount(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tool-codex-image-'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.dsh') })
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
    expect(ToolCodexImageProxy.inject).toEqual(['attachments', 'codexImageProxy', 'fs', 'tools', 'systemPrompt'])
    expect(mounted.tools.schemas().map(schema => schema.name)).toEqual(['generate_image'])
    expect(JSON.stringify(mounted.tools.schemas()[0]?.parameters)).toContain('reference_image_paths')
    expect(JSON.stringify(mounted.tools.schemas()[0]?.parameters)).toContain('reference_attachment_ids')
    const prompt = await mounted.systemPrompt.assemble()
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('use the generate_image tool')
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('before attempting any other tool')
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('Never use bash, shell, curl')
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('Do not call read_image first')
    expect(prompt.sections.find(section => section.name === 'tool:generate_image')?.text).toContain('[Image attachment id=')
  })

  it('renders generated images with a browser same-origin URL', () => {
    const requestId = '123e4567-e89b-12d3-a456-426614174000'
    for (const imageUrl of [
      `http://127.0.0.1:3080/api/codex-image-proxy/image/${requestId}`,
      `/api/codex-image-proxy/image/${requestId}`,
    ]) {
      const output = ToolCodexImageProxy.formatImageProxyOutput({
        status: 'generated',
        requestId,
        imageUrl,
        imagePath: `/queue/images/${requestId}.png`,
        mimeType: 'image/png',
        bytes: PNG_1X1.byteLength,
        sha256: '0'.repeat(64),
        workspacePath: `generated-images/generated-${requestId}.png`,
      })
      expect(output).toContain(`![Generated image](/api/codex-image-proxy/image/${requestId})`)
      expect(output).toContain(`Workspace copy: generated-images/generated-${requestId}.png`)
      expect(output).not.toContain('127.0.0.1')
      expect(output).not.toContain('localhost')
    }
  })

  it('copies a verified generated image into the Session workspace without changing its bytes', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const requestId = '123e4567-e89b-42d3-a456-426614174000'
    const workspace = join(root, 'generated-workspace')
    const queueImage = join(root, 'queue-result.png')
    const sha256 = createHash('sha256').update(PNG_1X1).digest('hex')
    await mkdir(workspace)
    await writeFile(queueImage, PNG_1X1)
    vi.spyOn(mounted.codexImageProxy, 'generate').mockResolvedValue({
      status: 'generated',
      requestId,
      imageUrl: `/api/codex-image-proxy/image/${requestId}`,
      imagePath: queueImage,
      mimeType: 'image/png',
      bytes: PNG_1X1.byteLength,
      sha256,
    })

    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-generated-copy'),
      name: 'generate_image',
      arguments: { prompt: 'a blue circle' },
      agent: { session: { header: { cwd: workspace } } } as never,
    })
    const workspacePath = `generated-images/generated-${requestId}.png`
    const copied = await readFile(join(workspace, workspacePath))

    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{
      type: 'text',
      text: expect.stringContaining(`![Generated image](/api/codex-image-proxy/image/${requestId})`) as unknown as string,
    }])
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(`Workspace copy: ${workspacePath}`)
    expect(copied.equals(PNG_1X1)).toBe(true)
    expect(createHash('sha256').update(copied).digest('hex')).toBe(sha256)
  })

  it('never overwrites an existing workspace image', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const requestId = '123e4567-e89b-42d3-a456-426614174000'
    const workspace = join(root, 'no-overwrite-workspace')
    const outputDirectory = join(workspace, 'generated-images')
    const destination = join(outputDirectory, `generated-${requestId}.png`)
    const queueImage = join(root, 'no-overwrite-result.png')
    const existing = Buffer.from('existing user file')
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(destination, existing)
    await writeFile(queueImage, PNG_1X1)
    vi.spyOn(mounted.codexImageProxy, 'generate').mockResolvedValue({
      status: 'generated',
      requestId,
      imageUrl: `/api/codex-image-proxy/image/${requestId}`,
      imagePath: queueImage,
      mimeType: 'image/png',
      bytes: PNG_1X1.byteLength,
      sha256: createHash('sha256').update(PNG_1X1).digest('hex'),
    })

    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-no-overwrite'),
      name: 'generate_image',
      arguments: { prompt: 'a blue circle' },
      agent: { session: { header: { cwd: workspace } } } as never,
    })

    expect(result.isError).toBe(false)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('Workspace copy warning:')
    expect((await readFile(destination)).equals(existing)).toBe(true)
    expect(await readdir(outputDirectory)).toEqual([`generated-${requestId}.png`])
  })

  it('refuses a generated-images symlink that escapes the Session workspace', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const requestId = '123e4567-e89b-42d3-a456-426614174000'
    const workspace = join(root, 'symlink-workspace')
    const outside = join(root, 'outside-generated-images')
    const queueImage = join(root, 'symlink-result.png')
    await mkdir(workspace)
    await mkdir(outside)
    await symlink(outside, join(workspace, 'generated-images'))
    await writeFile(queueImage, PNG_1X1)
    vi.spyOn(mounted.codexImageProxy, 'generate').mockResolvedValue({
      status: 'generated',
      requestId,
      imageUrl: `/api/codex-image-proxy/image/${requestId}`,
      imagePath: queueImage,
      mimeType: 'image/png',
      bytes: PNG_1X1.byteLength,
      sha256: createHash('sha256').update(PNG_1X1).digest('hex'),
    })

    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-symlink-escape'),
      name: 'generate_image',
      arguments: { prompt: 'a blue circle' },
      agent: { session: { header: { cwd: workspace } } } as never,
    })

    expect(result.isError).toBe(false)
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('Workspace copy warning:')
    expect(await readdir(outside)).toEqual([])
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

  it('passes a validated workspace image to the proxy without requiring model image input', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'source.png'), PNG_1X1)
    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-reference'),
      name: 'generate_image',
      arguments: { prompt: 'make it green', reference_image_paths: ['source.png'] },
      agent: { session: { header: { cwd: workspace } } } as never,
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('offline') as unknown as string }])
  })

  it('passes only current-session user attachments and content-dedupes them with workspace references', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const workspace = join(root, 'conversation-workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'same.png'), PNG_1X1)
    const ref = await mounted.attachments.saveImage({
      data: PNG_1X1, mediaType: 'image/png', name: 'direct.png',
    })
    const other = { ...ref, attachmentId: `sha256:${'b'.repeat(64)}` as never }
    const generate = vi.spyOn(mounted.codexImageProxy, 'generate').mockResolvedValue({
      status: 'offline', requestId: '123e4567-e89b-12d3-a456-426614174000', message: 'offline',
    })
    const agent = {
      session: {
        header: { cwd: workspace },
        events: [{
          type: 'user/message',
          data: {
            role: 'user', source: { kind: 'user' },
            content: [{ type: 'image', attachment: ref }],
          },
        }],
      },
    } as never
    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-conversation-reference'),
      name: 'generate_image',
      arguments: {
        prompt: 'make it green',
        reference_image_paths: ['same.png'],
        reference_attachment_ids: [String(ref.attachmentId)],
      },
      agent,
    })
    expect(result.isError).toBe(false)
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]?.[0].referenceImages).toHaveLength(1)
    expect(Buffer.from(generate.mock.calls[0]?.[0].referenceImages?.[0]?.data ?? []).equals(PNG_1X1)).toBe(true)

    const denied = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-other-session-reference'),
      name: 'generate_image',
      arguments: { prompt: 'edit', reference_attachment_ids: [String(other.attachmentId)] },
      agent,
    })
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{
      type: 'text', text: expect.stringContaining('not a direct user image in the current Session') as unknown as string,
    }])
    expect(generate).toHaveBeenCalledOnce()
  })

  it('enforces the five-reference limit across paths and attachment ids', async () => {
    const mounted = await mount()
    const result = await mounted.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('image-reference-limit'),
      name: 'generate_image',
      arguments: {
        prompt: 'edit', reference_image_paths: ['a.png'],
        reference_attachment_ids: ['a', 'b', 'c', 'd', 'e'],
      },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{
      type: 'text', text: expect.stringContaining('at most 5') as unknown as string,
    }])
  })

  it('rejects absolute and symlink reference paths that escape the Session workspace', async () => {
    const mounted = await mount()
    if (root === undefined) throw new Error('missing test root')
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside.png')
    await mkdir(workspace)
    await writeFile(outside, PNG_1X1)
    await symlink(outside, join(workspace, 'linked.png'))
    for (const [path, expected] of [[outside, 'escapes'], ['linked.png', 'symbolic link']] as const) {
      const result = await mounted.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`image-escape-${path}`),
        name: 'generate_image',
        arguments: { prompt: 'edit', reference_image_paths: [path] },
        agent: { session: { header: { cwd: workspace } } } as never,
      })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(expected) as unknown as string }])
    }
  })
})
