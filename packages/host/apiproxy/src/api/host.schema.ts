/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { DirectoryEntry, WorkspaceFileEntry } from './host.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** host.describe request payload (empty object literal). */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe response value. */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attachedSessions: z.number().int().nonnegative(),
  canOpenPath: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>

/** host.pickDirectory request payload (empty object literal). */
export const hostPickDirectoryRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.pickDirectory'>>>

/** host.pickDirectory response value; null means the user cancelled. */
export const hostPickDirectoryValueSchema = z.object({
  path: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.pickDirectory'>>>

/** Directory row shared by listing entries and breadcrumb crumbs. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<DirectoryEntry>>

/** host.listDirectory request payload; an absent path lists the home directory. */
export const hostListDirectoryRequestSchema = z.object({
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listDirectory'>>>

/** host.listDirectory response value. */
export const hostListDirectoryValueSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listDirectory'>>>

/** host.createDirectory request payload: name must be one plain path segment. */
export const hostCreateDirectoryRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !payload.name.includes('\0') && !/[/\\]/.test(payload.name),
  { message: 'host.createDirectory requires a single non-blank path segment name' },
) satisfies z.ZodType<Wire<RequestPayload<'host.createDirectory'>>>

/** host.createDirectory response value: the created directory's absolute path. */
export const hostCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.createDirectory'>>>

/** File-tree row returned by host.listWorkspaceFiles. */
export const workspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['directory', 'file']),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<WorkspaceFileEntry>>

/** host.listWorkspaceFiles request payload. */
export const hostListWorkspaceFilesRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listWorkspaceFiles'>>>

/** host.listWorkspaceFiles response value. */
export const hostListWorkspaceFilesValueSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceFileEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listWorkspaceFiles'>>>

/** host.createFile request payload. */
export const hostCreateFileRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !payload.name.includes('\0') && !/[/\\]/.test(payload.name),
  { message: 'host.createFile requires a single non-blank path segment name' },
) satisfies z.ZodType<Wire<RequestPayload<'host.createFile'>>>

/** host.createFile response value. */
export const hostCreateFileValueSchema = hostCreateDirectoryValueSchema satisfies z.ZodType<Wire<ResponseValue<'host.createFile'>>>

/** host.beginDirectoryUpload request: one root plus manifest totals. */
export const hostBeginDirectoryUploadRequestSchema = z.object({
  parentPath: z.string().min(1),
  name: z.string().min(1),
  fileCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<Wire<RequestPayload<'host.beginDirectoryUpload'>>>

/** host.beginDirectoryUpload response: opaque identity, root path, and chunk bound. */
export const hostBeginDirectoryUploadValueSchema = z.object({
  uploadId: z.uuid(),
  path: z.string(),
  maxChunkBytes: z.number().int().positive(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.beginDirectoryUpload'>>>

/** Canonical standard-base64, allowing the empty terminal chunk for an empty file. */
const canonicalBase64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

/** host.writeDirectoryUpload request: one ordered chunk of one relative file. */
export const hostWriteDirectoryUploadRequestSchema = z.object({
  uploadId: z.uuid(),
  path: z.string().min(1).max(4096),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  data: canonicalBase64Schema,
  done: z.boolean(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.writeDirectoryUpload'>>>

/** host.writeDirectoryUpload response: next acknowledged offset. */
export const hostWriteDirectoryUploadValueSchema = z.object({
  offset: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.writeDirectoryUpload'>>>

/** Upload-id-only request shared by complete and abort. */
const directoryUploadIdSchema = z.object({ uploadId: z.uuid() })

/** host.completeDirectoryUpload request: the active upload identity. */
export const hostCompleteDirectoryUploadRequestSchema = directoryUploadIdSchema satisfies z.ZodType<Wire<RequestPayload<'host.completeDirectoryUpload'>>>
/** host.completeDirectoryUpload response: the atomically published root. */
export const hostCompleteDirectoryUploadValueSchema = z.object({ path: z.string() }) satisfies z.ZodType<Wire<ResponseValue<'host.completeDirectoryUpload'>>>
/** host.abortDirectoryUpload request: the active or already-retired upload identity. */
export const hostAbortDirectoryUploadRequestSchema = directoryUploadIdSchema satisfies z.ZodType<Wire<RequestPayload<'host.abortDirectoryUpload'>>>
/** host.abortDirectoryUpload response: idempotent cleanup acknowledgement. */
export const hostAbortDirectoryUploadValueSchema = z.object({ aborted: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'host.abortDirectoryUpload'>>>

/** host.beginFileUpload request payload. */
export const hostBeginFileUploadRequestSchema = z.object({
  parentPath: z.string().min(1),
  name: z.string().min(1),
  totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}) satisfies z.ZodType<Wire<RequestPayload<'host.beginFileUpload'>>>

/** host.beginFileUpload response value. */
export const hostBeginFileUploadValueSchema = hostBeginDirectoryUploadValueSchema satisfies z.ZodType<Wire<ResponseValue<'host.beginFileUpload'>>>

/** host.writeFileUpload request payload. */
export const hostWriteFileUploadRequestSchema = z.object({
  uploadId: z.uuid(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  data: canonicalBase64Schema,
  done: z.boolean(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.writeFileUpload'>>>

/** host.writeFileUpload response value. */
export const hostWriteFileUploadValueSchema = hostWriteDirectoryUploadValueSchema satisfies z.ZodType<Wire<ResponseValue<'host.writeFileUpload'>>>

/** host.completeFileUpload request payload. */
export const hostCompleteFileUploadRequestSchema = directoryUploadIdSchema satisfies z.ZodType<Wire<RequestPayload<'host.completeFileUpload'>>>
/** host.completeFileUpload response value. */
export const hostCompleteFileUploadValueSchema = z.object({ path: z.string() }) satisfies z.ZodType<Wire<ResponseValue<'host.completeFileUpload'>>>
/** host.abortFileUpload request payload. */
export const hostAbortFileUploadRequestSchema = directoryUploadIdSchema satisfies z.ZodType<Wire<RequestPayload<'host.abortFileUpload'>>>
/** host.abortFileUpload response value. */
export const hostAbortFileUploadValueSchema = z.object({ aborted: z.literal(true) }) satisfies z.ZodType<Wire<ResponseValue<'host.abortFileUpload'>>>
/** host.openPath request payload. */
export const hostOpenPathRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openPath'>>>

/** host.openPath response value. */
export const hostOpenPathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openPath'>>>
