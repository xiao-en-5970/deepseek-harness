/**
 * Service Definition for the `ctx.directoryPicker` capability seam: how the web-GUI host lets an operator
 * select a workspace directory. Backends differ in interaction shape, not
 * just mechanism, so the service exposes a discriminated capability instead
 * of one method set: a `native` backend opens one OS chooser on the
 * host's display, while a `browse` backend serves listing, creation, and
 * transactional directory-upload primitives for an in-app browser (and
 * thereby works for remote clients no OS dialog can reach). Consumers switch
 * on `capability().kind`; the union is
 * merge-extensible, and the documented default for an unknown kind is to
 * hide the picking affordance rather than fail.
 * @module @deepseek-ai/dsh-host-directory-picker
 */

import { Context, Service } from '@deepseek-ai/cordis'

/** The native interaction: one OS directory chooser on the host display. */
export interface DirectoryPickerNativeCapability {
  kind: 'native'
  /**
   * Open the chooser and wait for the operator.
   * @param signal - caller/connection lifetime; abort terminates the chooser.
   * @returns the chosen absolute path, or null when the operator cancels.
   */
  pick(signal: AbortSignal): Promise<string | null>
}

/** One directory row: a listing child or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — clients never join path segments themselves. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** One directory level plus its ancestry, as a browse backend reports it. */
export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string
  /** The host account's home directory (breadcrumb "Home" rooting). */
  home: string
  /**
   * Ancestor chain from the filesystem root to the listed directory
   * inclusive; every crumb is a jump target (crumb `hidden` is always false).
   */
  crumbs: DirectoryEntry[]
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[]
  /**
   * True when the backend cut `entries` at its complete-result bound: the
   * level has more child directories than reported, and the missing rows are
   * the name-sorted tail (hidden rows count toward the bound).
   */
  truncated: boolean
}

/** One child shown in the current Workspace's file tree. */
export interface WorkspaceFileEntry {
  /** Base name shown in the tree. */
  name: string
  /** Absolute Host path returned verbatim to later browse operations. */
  path: string
  /** Whether the entry can be expanded as a directory. */
  kind: 'directory' | 'file'
  /** Hidden by the Host platform's convention. */
  hidden: boolean
}

/** One bounded directory level for the current Workspace file tree. */
export interface WorkspaceFileListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Direct children, name-sorted. */
  entries: WorkspaceFileEntry[]
  /** True when the name-sorted tail was cut at the provider's result bound. */
  truncated: boolean
}

/** One canonical, browse-root-confined target approved for download. */
export interface WorkspaceDownloadTarget {
  /** Canonical Host path; consumers must not resolve the browser value again. */
  path: string
  /** Safe attachment display name derived from the canonical target. */
  name: string
  /** Whether the carrier should stream one file or build one directory archive. */
  kind: 'directory' | 'file'
}

/**
 * The browse interaction: listing/creation/upload primitives an in-app browser
 * drives one level at a time. Works for remote clients — nothing renders on
 * the host display.
 */
export interface DirectoryPickerBrowseCapability {
  kind: 'browse'
  /**
   * List one directory level.
   * @param path - absolute directory to list; absent lists the home directory.
   * @param signal - caller lifetime; abort stops the scan (a stalled network
   * directory must not outlive a disconnected caller) and rejects with the
   * abort reason.
   * @returns the level's listing with ancestry; backends bound the complete
   * result, and a cut level reports `truncated`.
   * @throws {DirectoryPickerError} `directory-unreadable` when the target is not fully
   * qualified (a wire value must never resolve against the host cwd or, on
   * Windows, its current drive) or cannot be listed.
   */
  list(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * Create one child directory under an existing parent.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment (no separators, not `.`/`..`).
   * @returns the created directory's absolute path.
   * @throws {DirectoryPickerError} `directory-exists` for an existing child,
   * `directory-create-failed` for a parent that is not fully qualified or any other failure.
   */
  createDirectory(path: string, name: string): Promise<string>
  /**
   * List files and directories for a Workspace file-tree level.
   * @param path - fully qualified directory inside the provider's browse root.
   * @param signal - caller lifetime; abort stops the scan.
   * @returns the bounded direct-child listing.
   */
  listWorkspaceFiles(path: string, signal?: AbortSignal): Promise<WorkspaceFileListing>
  /**
   * Resolve one file-tree entry for a read-only download through the same
   * realpath and browse-root fence as listing. Providers that predate the
   * download surface may omit this optional capability; callers then report
   * download unavailable instead of weakening confinement.
   */
  resolveWorkspaceDownload?(path: string, signal?: AbortSignal): Promise<WorkspaceDownloadTarget>
  /**
   * Create one empty file without replacing an existing entry.
   * @param path - fully qualified existing parent directory.
   * @param name - single non-blank path segment.
   * @returns the created file's absolute path.
   */
  createFile(path: string, name: string): Promise<string>
  /** Begin a bounded browser-to-host directory upload under an existing parent. */
  beginDirectoryUpload(input: DirectoryUploadStart): Promise<DirectoryUploadSession>
  /** Append one ordered base64 chunk to a file in an active upload. */
  writeDirectoryUpload(input: DirectoryUploadChunk): Promise<DirectoryUploadProgress>
  /** Commit an upload after every declared file and byte has landed. */
  completeDirectoryUpload(uploadId: string): Promise<string>
  /** Remove an incomplete upload root; unknown/expired ids are an idempotent no-op. */
  abortDirectoryUpload(uploadId: string): Promise<void>
  /** Begin one bounded browser-to-host file upload under an existing parent. */
  beginFileUpload(input: FileUploadStart): Promise<FileUploadSession>
  /** Append one ordered base64 chunk to an active file upload. */
  writeFileUpload(input: FileUploadChunk): Promise<DirectoryUploadProgress>
  /** Publish the file after its declared bytes have landed. */
  completeFileUpload(uploadId: string): Promise<string>
  /** Remove an incomplete file upload; unknown/expired ids are an idempotent no-op. */
  abortFileUpload(uploadId: string): Promise<void>
}

/** Manifest totals and destination for one local-directory upload. */
export interface DirectoryUploadStart {
  parentPath: string
  name: string
  fileCount: number
  totalBytes: number
}

/** Server-owned upload identity and chunk bound. */
export interface DirectoryUploadSession {
  uploadId: string
  path: string
  maxChunkBytes: number
}

/** One ordered base64 file chunk; paths are slash-separated and relative to the upload root. */
export interface DirectoryUploadChunk {
  uploadId: string
  path: string
  offset: number
  data: string
  done: boolean
}

/** Next byte offset acknowledged after one chunk. */
export interface DirectoryUploadProgress {
  offset: number
}

/** Destination and exact byte total of one local-file upload. */
export interface FileUploadStart {
  parentPath: string
  name: string
  totalBytes: number
}

/** Server-owned file-upload identity and decoded chunk bound. */
export interface FileUploadSession {
  uploadId: string
  path: string
  maxChunkBytes: number
}

/** One ordered base64 chunk of an active file upload. */
export interface FileUploadChunk {
  uploadId: string
  offset: number
  data: string
  done: boolean
}

/**
 * Merge-extensible registry of interaction shapes keyed by capability kind: a
 * new backend declaration-merges its shape here (the entry's `kind` literal
 * must equal its key) instead of editing this package.
 */
export interface DirectoryPickerCapabilities {
  native: DirectoryPickerNativeCapability
  browse: DirectoryPickerBrowseCapability
}

/** Union of interaction shapes a backend can provide, derived from the merge-extensible {@link DirectoryPickerCapabilities} map. */
export type DirectoryPickerCapability = DirectoryPickerCapabilities[keyof DirectoryPickerCapabilities]

/** Closed failure vocabulary of the browse primitives (mirrored onto the wire by consumers). */
export type DirectoryPickerErrorCode =
  | 'directory-unreadable'
  | 'directory-exists'
  | 'directory-create-failed'
  | 'directory-upload-failed'

/** Typed failure thrown by browse primitives so consumers can map business codes without string matching. */
export class DirectoryPickerError extends Error {
  /**
   * @param code - closed business code of the failure.
   * @param path - the absolute path the failure is about.
   * @param message - operator-facing description.
   */
  constructor(readonly code: DirectoryPickerErrorCode, readonly path: string, message: string) {
    super(message)
    this.name = 'DirectoryPickerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    directoryPicker: DirectoryPicker
  }
}

/**
 * Abstract directory-picking service. Subclass, implement `capability()`, and
 * load the subclass as a plugin — it registers as `ctx.directoryPicker` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior). The capability object must be stable for the
 * service lifetime: consumers may capture it across calls.
 */
export abstract class DirectoryPicker extends Service {
  constructor(ctx: Context) {
    super(ctx, 'directoryPicker')
  }

  /**
   * The backend's interaction capability.
   * @returns the discriminated capability consumers switch on.
   */
  abstract capability(): DirectoryPickerCapability
}

export default DirectoryPicker
