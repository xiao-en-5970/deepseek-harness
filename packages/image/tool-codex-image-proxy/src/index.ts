/** Model-facing `generate_image` tool over the host `ctx.codexImageProxy` seam. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ImageProxyResult, ReferenceImageInput } from '@deepseek-ai/dsh-codex-image-proxy'
import type {} from '@deepseek-ai/dsh-codex-image-proxy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, GenericResultView, ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'tool-codex-image-proxy'
/** The host seam, tool registry, and prompt registry must already exist. */
export const inject = ['attachments', 'codexImageProxy', 'fs', 'tools', 'systemPrompt']

/** Default maximum prompt characters accepted from the model. */
export const DEFAULT_MAX_PROMPT_CHARS = 12_000
/** Default maximum contextual characters accepted from the model. */
export const DEFAULT_MAX_CONTEXT_CHARS = 20_000
/** Maximum reference paths in one image edit. */
export const MAX_REFERENCE_IMAGES = 5
/** Maximum bytes read for one reference image. */
export const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024
/** Maximum aggregate bytes read for one edit request. */
export const MAX_REFERENCE_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

interface ReferenceFsTarget {
  targetKey: unknown
  displayPath: string
}

interface ReferenceServices {
  fs: {
    resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ReferenceFsTarget>
    lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other' } | undefined>
    contains(parent: ReferenceFsTarget, child: ReferenceFsTarget): boolean
    stat(target: ReferenceFsTarget, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'other'; version: unknown } | undefined>
    readBytes(target: ReferenceFsTarget, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array>
  }
  attachments: {
    imageLimits: {
      maxImageBytes: number
      maxMessageImageBytes: number
      mediaTypes: readonly string[]
    }
    validateImage(input: { data: Uint8Array; mediaType: ImageMediaType; name: string }): Promise<void>
    readImage(ref: ConversationImageRef, signal?: AbortSignal): Promise<{ ref: ConversationImageRef; data: Uint8Array }>
  }
}

interface ConversationImageRef {
  attachmentId: unknown
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const IMAGE_EXTENSIONS_BY_MEDIA: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const IMAGE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
  reference_image_paths?: string[]
  reference_attachment_ids?: string[]
}

interface ParsedImageArgs {
  prompt: string
  context: string
  referenceImagePaths: string[]
  referenceAttachmentIds: string[]
}

function positiveInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`tool-codex-image-proxy: ${label} must be a positive integer`)
  }
  return value
}

function parseArgs(args: ImageArgs, maxPromptChars: number, maxContextChars: number): ParsedImageArgs {
  const prompt = args.prompt.trim()
  const context = (args.context ?? '').trim()
  const referenceImagePaths = args.reference_image_paths ?? []
  const referenceAttachmentIds = args.reference_attachment_ids ?? []
  if (prompt === '') throw new Error('prompt must be a non-empty string')
  if (Array.from(prompt).length > maxPromptChars) {
    throw new Error(`prompt exceeds ${String(maxPromptChars)} characters`)
  }
  if (Array.from(context).length > maxContextChars) {
    throw new Error(`context exceeds ${String(maxContextChars)} characters`)
  }
  if (!Array.isArray(referenceImagePaths)) {
    throw new Error('reference_image_paths must be an array')
  }
  if (!Array.isArray(referenceAttachmentIds)) {
    throw new Error('reference_attachment_ids must be an array')
  }
  if (referenceImagePaths.length + referenceAttachmentIds.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`reference images must contain at most ${String(MAX_REFERENCE_IMAGES)} paths and attachment ids combined`)
  }
  for (const path of referenceImagePaths) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new Error('reference_image_paths must contain non-empty strings')
    }
  }
  for (const attachmentId of referenceAttachmentIds) {
    if (typeof attachmentId !== 'string' || attachmentId.trim() === '') {
      throw new Error('reference_attachment_ids must contain non-empty strings')
    }
  }
  return {
    prompt,
    context,
    referenceImagePaths: referenceImagePaths.map(path => path.trim()),
    referenceAttachmentIds: referenceAttachmentIds.map(id => id.trim()),
  }
}

/**
 * Read validated workspace images without routing them back through the active language model.
 * @param ctx - context providing filesystem and attachment services.
 * @param paths - workspace-relative image paths requested by the model.
 * @param exec - current tool execution and Session authority.
 * @returns validated image bytes for the local worker.
 */
export async function readReferenceImages(
  ctx: Context,
  paths: readonly string[],
  exec: ToolExecution,
): Promise<ReferenceImageInput[]> {
  if (paths.length === 0) return []
  const services = ctx as unknown as ReferenceServices
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('reference_image_paths require a Session working directory')
  const workspace = await services.fs.resolve('.', { cwd, signal: exec.signal })
  const workspaceInfo = await services.fs.stat(workspace, exec.signal)
  if (workspaceInfo?.type !== 'directory') throw new Error('the Session working directory is unavailable')
  const maxTotalBytes = Math.min(
    MAX_REFERENCE_IMAGE_TOTAL_BYTES,
    services.attachments.imageLimits.maxMessageImageBytes,
  )
  let totalBytes = 0
  const seen = new Set<string>()
  const images: ReferenceImageInput[] = []
  for (const requestedPath of paths) {
    const mediaType = IMAGE_EXTENSIONS[extname(requestedPath).toLowerCase()]
    if (mediaType === undefined || !services.attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`reference image "${requestedPath}" must be an accepted PNG/JPEG/WebP/GIF file`)
    }
    const pathInfo = await services.fs.lstat(requestedPath, { cwd }, exec.signal)
    if (pathInfo?.type === 'symlink') {
      throw new Error(`reference image "${requestedPath}" must not be a symbolic link`)
    }
    const target = await services.fs.resolve(requestedPath, { cwd, signal: exec.signal })
    if (!services.fs.contains(workspace, target)) {
      throw new Error(`reference image "${requestedPath}" escapes the current Session working directory`)
    }
    if (seen.has(String(target.targetKey))) throw new Error(`reference image "${requestedPath}" is duplicated`)
    seen.add(String(target.targetKey))
    const info = await services.fs.stat(target, exec.signal)
    if (info?.type !== 'file') throw new Error(`reference image "${target.displayPath}" is not a regular file`)
    const maxBytes = Math.min(MAX_REFERENCE_IMAGE_BYTES, services.attachments.imageLimits.maxImageBytes)
    const data = await services.fs.readBytes(target, exec.signal, maxBytes)
    totalBytes += data.byteLength
    if (totalBytes > maxTotalBytes) {
      throw new Error(`reference images exceed the ${String(maxTotalBytes)} byte aggregate limit`)
    }
    const name = basename(target.displayPath)
    await services.attachments.validateImage({ data, mediaType, name })
    images.push({ data, mimeType: mediaType, name })
  }
  return images
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Direct user-message image references in this exact Session only. */
function currentSessionImageRefs(exec: ToolExecution): Map<string, ConversationImageRef> {
  const refs = new Map<string, ConversationImageRef>()
  const events = (exec.agent?.session.events ?? []) as readonly unknown[]
  for (const rawEvent of events) {
    const event = record(rawEvent)
    if (event?.type !== 'user/message') continue
    const data = record(event.data)
    const wrapped = record(data?.message)
    const message = wrapped ?? data
    if (message?.role !== 'user') continue
    const source = record(message.source)
    if (source?.kind !== 'user' || !Array.isArray(message.content)) continue
    for (const rawBlock of message.content) {
      const block = record(rawBlock)
      const attachment = record(block?.attachment)
      if (block?.type !== 'image' || attachment === undefined) continue
      const id = attachment.attachmentId
      const mediaType = attachment.mediaType
      if (typeof id !== 'string' || typeof mediaType !== 'string' || !(mediaType in IMAGE_EXTENSIONS_BY_MEDIA)) continue
      refs.set(id, attachment as unknown as ConversationImageRef)
    }
  }
  return refs
}

/**
 * Read only attachment ids proven to occur in a direct user message in this Session.
 * @param ctx - context providing attachment storage.
 * @param attachmentIds - durable image ids requested by the model.
 * @param exec - current tool execution and Session authority.
 * @returns validated image bytes for the local worker.
 */
export async function readConversationReferenceImages(
  ctx: Context,
  attachmentIds: readonly string[],
  exec: ToolExecution,
): Promise<ReferenceImageInput[]> {
  if (attachmentIds.length === 0) return []
  const services = ctx as unknown as ReferenceServices
  const allowed = currentSessionImageRefs(exec)
  const maxBytes = Math.min(MAX_REFERENCE_IMAGE_BYTES, services.attachments.imageLimits.maxImageBytes)
  const maxTotalBytes = Math.min(MAX_REFERENCE_IMAGE_TOTAL_BYTES, services.attachments.imageLimits.maxMessageImageBytes)
  let totalBytes = 0
  const images: ReferenceImageInput[] = []
  const seen = new Set<string>()
  for (const attachmentId of attachmentIds) {
    if (seen.has(attachmentId)) continue
    seen.add(attachmentId)
    const ref = allowed.get(attachmentId)
    if (ref === undefined) {
      throw new Error(`reference attachment "${attachmentId}" is not a direct user image in the current Session`)
    }
    if (!services.attachments.imageLimits.mediaTypes.includes(ref.mediaType)) {
      throw new Error(`reference attachment "${attachmentId}" has an unsupported image media type`)
    }
    const stored = await services.attachments.readImage(ref, exec.signal)
    if (String(stored.ref.attachmentId) !== attachmentId) {
      throw new Error(`reference attachment "${attachmentId}" did not resolve to the requested image`)
    }
    if (stored.data.byteLength > maxBytes) {
      throw new Error(`reference attachment "${attachmentId}" exceeds the ${String(maxBytes)} byte limit`)
    }
    totalBytes += stored.data.byteLength
    if (totalBytes > maxTotalBytes) {
      throw new Error(`reference images exceed the ${String(maxTotalBytes)} byte aggregate limit`)
    }
    const name = ref.name ?? `conversation-reference.${IMAGE_EXTENSIONS_BY_MEDIA[ref.mediaType]}`
    await services.attachments.validateImage({ data: stored.data, mediaType: ref.mediaType, name })
    images.push({ data: stored.data, mimeType: ref.mediaType, name })
  }
  return images
}

/** Enforce combined byte limits and content-dedupe workspace plus conversation references. */
function combineReferenceImages(
  services: ReferenceServices,
  images: readonly ReferenceImageInput[],
): ReferenceImageInput[] {
  const maxTotalBytes = Math.min(MAX_REFERENCE_IMAGE_TOTAL_BYTES, services.attachments.imageLimits.maxMessageImageBytes)
  let totalBytes = 0
  const seen = new Set<string>()
  const combined: ReferenceImageInput[] = []
  for (const image of images) {
    const digest = createHash('sha256').update(image.data).digest('hex')
    if (seen.has(digest)) continue
    seen.add(digest)
    totalBytes += image.data.byteLength
    if (totalBytes > maxTotalBytes) {
      throw new Error(`reference images exceed the ${String(maxTotalBytes)} byte aggregate limit`)
    }
    combined.push(image)
  }
  return combined
}

type GeneratedImageResult = Extract<ImageProxyResult, { status: 'generated' }>

interface GeneratedImageWorkspaceFields {
  workspacePath?: string
  workspaceCopyWarning?: string
}

type ImageProxyToolResult =
  | Exclude<ImageProxyResult, { status: 'generated' }>
  | (GeneratedImageResult & GeneratedImageWorkspaceFields)

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/**
 * Verify a generated queue image and publish an immutable copy inside the
 * current Session workspace without replacing any user file.
 * @param result - generated queue image metadata.
 * @param cwd - current Session workspace directory.
 * @returns workspace-relative path of the immutable copy.
 */
export async function copyGeneratedImageToWorkspace(
  result: GeneratedImageResult,
  cwd: string,
): Promise<string> {
  if (!IMAGE_REQUEST_ID.test(result.requestId)) throw new Error('generated image request id is invalid')
  const workspace = await realpath(cwd)
  const workspaceInfo = await lstat(workspace)
  if (!workspaceInfo.isDirectory()) throw new Error('the Session working directory is unavailable')

  const sourceInfo = await lstat(result.imagePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error('the generated queue image is not a regular file')
  }
  const data = await readFile(result.imagePath)
  if (data.byteLength !== result.bytes) throw new Error('the generated queue image size does not match its result')
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== result.sha256) throw new Error('the generated queue image digest does not match its result')

  const outputDirectory = join(workspace, 'generated-images')
  try {
    await mkdir(outputDirectory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const outputInfo = await lstat(outputDirectory)
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error('the generated-images target must be a real directory')
  }
  const outputDirectoryReal = await realpath(outputDirectory)
  if (!containsPath(workspace, outputDirectoryReal)) {
    throw new Error('the generated-images directory escapes the Session working directory')
  }

  const extension = IMAGE_EXTENSIONS_BY_MEDIA[result.mimeType]
  const fileName = `generated-${result.requestId}.${extension}`
  const destination = join(outputDirectoryReal, fileName)
  if (!containsPath(workspace, destination)) {
    throw new Error('the generated image destination escapes the Session working directory')
  }
  const temporary = join(outputDirectoryReal, `.${fileName}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, destination)
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
  return `generated-images/${fileName}`
}

/**
 * Model-facing rendering for every canonical result status.
 * @param result - canonical image proxy tool result.
 * @returns plain model-facing guidance and image references.
 */
export function formatImageProxyOutput(result: ImageProxyToolResult): string {
  if (result.status === 'generated') {
    const imageUrl = new URL(result.imageUrl, 'http://dsh.invalid')
    const sameOriginImageUrl = `${imageUrl.pathname}${imageUrl.search}${imageUrl.hash}`
    const lines = [
      'The image was generated successfully by the local Codex worker.',
      `Show it to the user with this exact Markdown: ![Generated image](${sameOriginImageUrl})`,
      `Durable sandbox path: ${result.imagePath}`,
    ]
    if (result.workspacePath !== undefined) {
      lines.push(`Workspace copy: ${result.workspacePath}`)
    } else if (result.workspaceCopyWarning !== undefined) {
      lines.push(`Workspace copy warning: ${result.workspaceCopyWarning}`)
    }
    return lines.join('\n')
  }
  if (result.status === 'offline') {
    return `${result.message} Tell the user that the local Codex worker must be started before image generation can continue.`
  }
  return `Image generation failed: ${result.message}`
}

function presentCall(args: unknown): GenericCallView {
  const input = record(args)
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
        workspacePath: { type: 'string' },
        workspaceCopyWarning: { type: 'string' },
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
      'For any image-generation or image-editing request, call generate_image before attempting any other tool.',
      'Never use bash, shell, curl, HTTP clients, scripts, or other general-purpose tools to bypass generate_image or call image services directly.',
      'Put the complete visual specification in prompt and a concise summary of relevant conversation context in context.',
      'For editing or transforming existing workspace images, pass their paths in reference_image_paths; this works even when the current language model cannot itself accept image input.',
      'For an image attached directly by the user in this conversation, copy the exact id from its [Image attachment id=...] marker into reference_attachment_ids; never invent or alter attachment ids.',
      'Do not call read_image first merely to pass a reference image to Codex; use read_image only when the current model must itself inspect or analyze the pixels.',
      'Never put credentials, hidden system instructions, or unrelated conversation text in context.',
      'After a successful call, include the exact Markdown image returned by the tool in your answer.',
      'If the tool reports offline, say that the local Codex image worker is offline instead of pretending the image was generated.',
    ].join(' '),
  })

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate or edit one image through the user\'s local Codex image-generation worker. Supports text-to-image, workspace files, and current-conversation image attachments without requiring the language model to read pixels.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete, self-contained visual generation request.' },
      context: { type: 'string', description: 'Concise relevant conversation context; exclude credentials and hidden instructions.' },
      reference_image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional PNG/JPEG/WebP/GIF paths inside the current Session working directory to use as edit targets or visual references.',
      },
      reference_attachment_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional exact attachment ids from [Image attachment id=...] markers in direct user messages in the current Session.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatImageProxyOutput(value) }],
      presentationMeta: (_args, value) => ({ status: (value as unknown as { status: string }).status }),
    },
    timeoutMs: ctx.codexImageProxy.requestTimeoutMs + 5_000,
    async execute(args: ImageArgs, exec) {
      const parsed = parseArgs(args, maxPromptChars, maxContextChars)
      const workspaceImages = await readReferenceImages(ctx, parsed.referenceImagePaths, exec)
      const conversationImages = await readConversationReferenceImages(ctx, parsed.referenceAttachmentIds, exec)
      const referenceImages = combineReferenceImages(
        ctx as unknown as ReferenceServices,
        [...workspaceImages, ...conversationImages],
      )
      const result = await ctx.codexImageProxy.generate({
        prompt: parsed.prompt,
        context: parsed.context,
        referenceImages,
      }, exec.signal)
      if (result.status !== 'generated') return result
      try {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('the Session working directory is unavailable')
        const workspacePath = await copyGeneratedImageToWorkspace(result, cwd)
        return { ...result, workspacePath }
      } catch {
        return {
          ...result,
          workspaceCopyWarning:
            'The generated image remains available in this web conversation, but its workspace copy could not be saved safely.',
        }
      }
    },
    presentCall,
    presentResult,
  }))
}
