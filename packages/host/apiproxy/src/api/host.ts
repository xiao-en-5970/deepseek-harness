/**
 * host domain contract. No protocol version: client and host ship
 * together; introduce protocolVersion only when an independently released client appears.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One directory row of a listing: a child entry or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a browser row (a root crumb carries its full path). */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  /** Hidden by the host platform's convention (dot-prefixed on POSIX); the client owns whether to show it. */
  hidden: boolean
}

/** host.listDirectory response value: one directory level plus its ancestry. */
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
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** One direct child in the current Workspace file tree. */
export interface WorkspaceFileEntry {
  /** Base name shown in the file tree. */
  name: string
  /** Absolute Host path returned verbatim to later file operations. */
  path: string
  /** Whether this row is expandable or a leaf. */
  kind: 'directory' | 'file'
  /** Hidden by the Host platform's convention. */
  hidden: boolean
}

/** One bounded level of the current Workspace file tree. */
export interface WorkspaceFileListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Direct children in name order. */
  entries: WorkspaceFileEntry[]
  /** True when the provider cut the name-sorted tail at its result bound. */
  truncated: boolean
}

/** Manifest totals and destination for one browser-to-host directory upload. */
export interface DirectoryUploadStart {
  parentPath: string
  name: string
  fileCount: number
  totalBytes: number
}

/** Server-owned upload identity and its decoded chunk-size bound. */
export interface DirectoryUploadSession {
  uploadId: string
  path: string
  maxChunkBytes: number
}

/** One ordered base64 file chunk; path is slash-separated and relative to the upload root. */
export interface DirectoryUploadChunk {
  uploadId: string
  path: string
  offset: number
  data: string
  done: boolean
}

/** Destination and exact byte total of one local-file upload. */
export interface FileUploadStart {
  /** Fully qualified existing directory that receives the file. */
  parentPath: string
  /** Single destination file-name segment. */
  name: string
  /** Exact decoded byte total expected before publication. */
  totalBytes: number
}

/** Server-owned file-upload identity and decoded chunk bound. */
export interface FileUploadSession {
  /** Opaque identity used by later upload operations. */
  uploadId: string
  /** Eventual absolute destination path. */
  path: string
  /** Maximum decoded bytes accepted in one write request. */
  maxChunkBytes: number
}

/** One ordered base64 chunk of an active file upload. */
export interface FileUploadChunk {
  /** Opaque identity returned by begin. */
  uploadId: string
  /** Exact next byte offset expected before this chunk. */
  offset: number
  /** Canonical standard-base64 decoded and appended by the Host. */
  data: string
  /** True for the final chunk, including the empty chunk of an empty file. */
  done: boolean
}

/** Host-level unary methods. */
export interface HostApi {
  /**
   * One-shot host snapshot. Empty payload uses the literal `{}` (extend in place when fields arrive).
   * version = the host app's (apps/cli) package.json version; cwd = the host process working
   * directory (root for session persistence and tool execution); provider/model = the defaults
   * applied when a new agent doesn't specify them explicitly, absent when the host configures
   * no explicit default (the adapter falls back internally);
   * attachedSessions = count of currently attached sessions (those with a live agent);
   * canOpenPath = whether this deployment can hand a path to a user-visible native desktop.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    canOpenPath: boolean
  }>>

  /**
   * Open the operating system's single-directory picker; cancellation returns
   * null. Only served under the `native` capability.
   */
  pickDirectory(
    request: RpcRequest<{}>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ path: string | null }>>

  /**
   * List one directory level for the in-app browser; an absent path lists the
   * host account's home directory. Only served under the `browse` capability;
   * unreadable or missing targets fail with `directory-unreadable`. The
   * carrier's request signal follows the caller, stopping the backend's scan
   * on disconnect or timeout.
   */
  listDirectory(
    request: RpcRequest<{ path?: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<DirectoryListing>>

  /**
   * Create one child directory under an existing parent (the browser's
   * "New folder"). Only served under the `browse` capability; an existing
   * child fails with `directory-exists`, every other filesystem failure with
   * `directory-create-failed`.
   */
  createDirectory(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /** List files and directories in one current-Workspace tree level. */
  listWorkspaceFiles(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<WorkspaceFileListing>>

  /** Create one exclusive empty file under an existing directory. */
  createFile(
    request: RpcRequest<{ path: string; name: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /** Create an isolated root and begin one bounded local-directory upload. */
  beginDirectoryUpload(
    request: RpcRequest<DirectoryUploadStart>,
  ): Promise<RpcResponse<DirectoryUploadSession>>

  /** Append one ordered chunk to a file in an active directory upload. */
  writeDirectoryUpload(
    request: RpcRequest<DirectoryUploadChunk>,
  ): Promise<RpcResponse<{ offset: number }>>

  /** Publish an upload only after its declared file and byte totals match. */
  completeDirectoryUpload(
    request: RpcRequest<{ uploadId: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /** Remove an incomplete upload; the operation is idempotent for unknown ids. */
  abortDirectoryUpload(
    request: RpcRequest<{ uploadId: string }>,
  ): Promise<RpcResponse<{ aborted: true }>>

  /** Begin one bounded local-file upload. */
  beginFileUpload(
    request: RpcRequest<FileUploadStart>,
  ): Promise<RpcResponse<FileUploadSession>>

  /** Append one ordered chunk to an active file upload. */
  writeFileUpload(
    request: RpcRequest<FileUploadChunk>,
  ): Promise<RpcResponse<{ offset: number }>>

  /** Publish one complete file upload. */
  completeFileUpload(
    request: RpcRequest<{ uploadId: string }>,
  ): Promise<RpcResponse<{ path: string }>>

  /** Remove one incomplete file upload. */
  abortFileUpload(
    request: RpcRequest<{ uploadId: string }>,
  ): Promise<RpcResponse<{ aborted: true }>>

  /**
   * Open a filesystem path with the operating system's default application
   * (Finder / Explorer / xdg-open hand-off). The browser carrier's
   * prefix-wide trust fence covers this privileged method like every other
   * `/api` request.
   */
  openPath(
    request: RpcRequest<{ path: string }>,
    signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>
}
