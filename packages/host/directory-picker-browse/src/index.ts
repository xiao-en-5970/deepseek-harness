/**
 * Browse backend of the directory-picker seam: registers `ctx.directoryPicker`
 * with the `browse` capability — one-level directory listing, child-directory
 * creation, and bounded directory upload over the host filesystem via Node's
 * stdlib. Nothing renders on the host display, so this backend serves remote
 * clients the dialog backend cannot. Browse policy is recorded in the
 * directory-picker seam Agent Note; upload policy in the browser-directory-
 * upload Agent Note.
 * @module @deepseek-ai/dsh-host-directory-picker-browse
 */

import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, opendir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker, DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry, DirectoryListing, DirectoryPickerCapability, DirectoryUploadChunk,
  DirectoryUploadProgress, DirectoryUploadSession, DirectoryUploadStart,
  FileUploadChunk, FileUploadSession, FileUploadStart, WorkspaceFileEntry, WorkspaceFileListing,
  WorkspaceDownloadTarget,
} from '@deepseek-ai/dsh-host-directory-picker'
import { fullyQualified, insidePath } from './path.ts'
import { DirectoryUploadManager } from './upload.ts'

export { fullyQualified } from './path.ts'

const DEFAULT_UPLOAD_ROOT = ''
// Base64 expands decoded data by 4/3 before the JSON carrier adds its own
// fields. A 512 KiB decoded default keeps the complete request below the
// common 1 MiB reverse-proxy body limit with ample metadata headroom.
const DEFAULT_MAX_UPLOAD_CHUNK_BYTES = 512 * 1024
const DEFAULT_MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_MAX_UPLOAD_FILES = 10_000
const DEFAULT_UPLOAD_LIFETIME_MS = 30 * 60 * 1000

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string, root?: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    // basename of a root is '' — label the root crumb by its full path ('/', 'C:\').
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current, hidden: false })
    if (current === root || parent === current) return crumbs
    current = parent
  }
}

/** One streamed listing candidate: the dirent facts a row needs, nothing else retained. */
export interface ListingCandidate {
  /** Base name within the streamed level. */
  name: string
  /** Dirent says directory (no probe needed). */
  isDirectory: boolean
  /** Dirent says regular file (no probe needed). */
  isFile: boolean
  /** Dirent says symlink (enterability needs a stat probe). */
  isSymbolicLink: boolean
}

/**
 * Insert a streamed candidate into the name-sorted bounded window, evicting
 * the name-largest candidate when the window exceeds `keep`. Memory over an
 * arbitrarily large level therefore stays O(keep) regardless of how many
 * children the directory holds.
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
export function boundedInsert(window: ListingCandidate[], candidate: ListingCandidate, keep: number): boolean {
  // Full window, name at or beyond the tail: one comparison rejects, so an
  // oversized level costs O(1) per candidate past the head instead of a
  // window scan (100k children against a 1,001 window must not approach
  // 10^8 comparisons).
  // oxlint-disable-next-line typescript/no-non-null-assertion -- a full window (length === keep >= 1) has a tail
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1]!.name) >= 0) return true
  // Binary insertion keeps a retained candidate at O(log keep) comparisons.
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (candidate.name.localeCompare(window[mid]!.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. Node's filesystem reads are not retractable, so the operation
 * itself keeps running against a handle the caller then closes — its late
 * settlement is swallowed here so an abandoned read cannot surface as an
 * unhandled rejection.
 * @param operation - the in-flight filesystem step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
export function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {
        // Abandoned read: its handle is being closed by the aborting caller,
        // and the abort reason already carried the outcome.
      })
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/* v8 ignore start -- a close failure of an abandoned handle has no consumer, and forcing one needs a filesystem torn down mid-request. */
/** Swallow the close failure of a handle its caller already departed. */
function swallowCloseFailure(): void {}
/* v8 ignore stop */

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  /* v8 ignore next -- node:fs rejects with Error instances; the String arm only satisfies the unknown narrowing. */
  return error instanceof Error ? error.message : String(error)
}

/** Whether a Node filesystem error carries the requested code. */
function errorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Validate one user-created file or directory name. */
function validSegment(name: string): boolean {
  return name.trim() !== '' && name !== '.' && name !== '..' && !name.includes('\0') && !/[/\\]/.test(name)
}

/**
 * Stream one directory into a bounded, name-sorted candidate window.
 * @param target - canonical directory to scan.
 * @param keep - retained candidate bound (usually result limit + one sentinel).
 * @param signal - caller lifetime.
 * @param accept - cheap dirent-only filter applied before the bounded window.
 * @returns retained candidates and whether a name-sorted tail was evicted.
 */
async function scanCandidates(
  target: string,
  keep: number,
  signal: AbortSignal | undefined,
  accept: (candidate: ListingCandidate) => boolean,
): Promise<{ window: ListingCandidate[]; evicted: boolean }> {
  const window: ListingCandidate[] = []
  let evicted = false
  const opening = opendir(target)
  const level = await raceAbort(opening, signal).catch((error: unknown) => {
    void opening.then(dir => dir.close().catch(swallowCloseFailure), () => {
      // Already rejected: raceAbort surfaced or swallowed it.
    })
    throw error
  })
  try {
    for (;;) {
      const dirent = await raceAbort(level.read(), signal)
      if (dirent === null) break
      const candidate = {
        name: dirent.name,
        isDirectory: dirent.isDirectory(),
        isFile: dirent.isFile(),
        isSymbolicLink: dirent.isSymbolicLink(),
      }
      if (!accept(candidate)) continue
      if (boundedInsert(window, candidate, keep)) evicted = true
    }
  } finally {
    const closing = level.close()
    /* v8 ignore next 3 -- an abort between open and close needs a stalled read; the abandoned-close arm has no observable outcome. */
    if (signal?.aborted) {
      closing.catch(swallowCloseFailure)
    } else {
      await closing
    }
  }
  return { window, evicted }
}

/**
 * One listing row for a dirent, following symlinks to directories; null for
 * non-directories and broken/cyclic links (skipped silently — the browser
 * shows what can be entered, and a broken link cannot).
 */
async function directoryRow(
  parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean, signal: AbortSignal | undefined,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      // The probe races the caller too: a symlink target on a stalled
      // network filesystem must not keep a departed caller's request alive.
      enterable = (await raceAbort(stat(path), signal)).isDirectory()
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check in list covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      // Broken or cyclic symlink: stat is the probe, failure means "not enterable".
      return null
    }
  }
  if (!enterable) return null
  // POSIX hidden convention; Windows' hidden attribute is not exposed by
  // dirents (Known Limitations). The client owns whether hidden rows show.
  return { name, path, hidden: name.startsWith('.') }
}

/** One file-tree row, following symlinks only to classify their targets. */
async function workspaceFileRow(
  parent: string, candidate: ListingCandidate, signal: AbortSignal | undefined,
): Promise<WorkspaceFileEntry | null> {
  const path = join(parent, candidate.name)
  let kind: WorkspaceFileEntry['kind'] | undefined = candidate.isDirectory
    ? 'directory'
    : candidate.isFile ? 'file' : undefined
  if (kind === undefined && candidate.isSymbolicLink) {
    try {
      const info = await raceAbort(stat(path), signal)
      if (info.isDirectory()) kind = 'directory'
      else if (info.isFile()) kind = 'file'
    } catch {
      /* v8 ignore next 2 -- an abort landing mid-probe needs a stalled stat; the per-candidate check covers the settled path. */
      if (signal?.aborted) throw asError(signal.reason)
      return null
    }
  }
  if (kind === undefined) return null
  return { name: candidate.name, path, kind, hidden: candidate.name.startsWith('.') }
}

/** Validated plugin configuration. */
export interface Config {
  /** Complete-result bound of one listing level; see {@link BrowseDirectoryPicker.Config}. */
  maxEntries: number
  /** Fully qualified subtree exposed by listing and directory creation; omitted permits the Host filesystem. */
  browseRoot?: string
  /** Fully qualified subtree accepting uploads; blank follows `browseRoot`, then the Host account's home directory. */
  uploadRoot?: string
  /** Maximum decoded bytes in one upload RPC chunk; defaults to 512 KiB so base64 JSON fits common 1 MiB proxy limits. */
  maxUploadChunkBytes?: number
  /** Maximum decoded bytes in one uploaded file. */
  maxUploadFileBytes?: number
  /** Maximum decoded bytes across one directory upload. */
  maxUploadBytes?: number
  /** Maximum file count across one directory upload. */
  maxUploadFiles?: number
  /** Idle lifetime before an incomplete upload root is removed. */
  uploadLifetimeMs?: number
}

/** One single-file upload layered over the shared directory transaction owner. */
interface FileUploadState {
  /** Final visible file path. */
  target: string
  /** File name inside the hidden transaction root. */
  name: string
}

/** The `ctx.directoryPicker` browse implementation (stable capability object per service life). */
export default class BrowseDirectoryPicker extends DirectoryPicker {
  /**
   * `maxEntries` bounds the complete listing level a single `list` call may
   * materialize and put on the wire: at most this many child-directory rows
   * (hidden rows included), with `truncated` flagging a cut level. The
   * default follows GitHub's web UI, which truncates directory listings at
   * 1,000 entries.
   */
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1000),
    browseRoot: z.string(),
    uploadRoot: z.string().default(DEFAULT_UPLOAD_ROOT),
    maxUploadChunkBytes: z.natural().min(1).default(DEFAULT_MAX_UPLOAD_CHUNK_BYTES),
    maxUploadFileBytes: z.natural().min(1).default(DEFAULT_MAX_UPLOAD_FILE_BYTES),
    maxUploadBytes: z.natural().min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
    maxUploadFiles: z.natural().min(1).default(DEFAULT_MAX_UPLOAD_FILES),
    uploadLifetimeMs: z.natural().min(1).default(DEFAULT_UPLOAD_LIFETIME_MS),
  })

  private readonly uploads: DirectoryUploadManager
  private readonly fileUploads = new Map<string, FileUploadState>()
  private readonly configuredBrowseRoot: string | undefined

  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
    listWorkspaceFiles: (path, signal) => this.listWorkspaceFiles(path, signal),
    resolveWorkspaceDownload: (path, signal) => this.resolveWorkspaceDownload(path, signal),
    createFile: (path, name) => this.createFile(path, name),
    beginDirectoryUpload: input => this.beginDirectoryUpload(input),
    writeDirectoryUpload: input => this.writeDirectoryUpload(input),
    completeDirectoryUpload: uploadId => this.completeDirectoryUpload(uploadId),
    abortDirectoryUpload: uploadId => this.abortDirectoryUpload(uploadId),
    beginFileUpload: input => this.beginFileUpload(input),
    writeFileUpload: input => this.writeFileUpload(input),
    completeFileUpload: uploadId => this.completeFileUpload(uploadId),
    abortFileUpload: uploadId => this.abortFileUpload(uploadId),
  }

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (config.browseRoot !== undefined && !fullyQualified(config.browseRoot)) {
      throw new Error(`directory browse root must be fully qualified: ${config.browseRoot}`)
    }
    this.configuredBrowseRoot = config.browseRoot === undefined ? undefined : resolve(config.browseRoot)
    const uploadConfig = {
      uploadRoot: config.uploadRoot === undefined || config.uploadRoot === DEFAULT_UPLOAD_ROOT
        ? this.configuredBrowseRoot ?? DEFAULT_UPLOAD_ROOT
        : config.uploadRoot,
      maxUploadChunkBytes: config.maxUploadChunkBytes ?? DEFAULT_MAX_UPLOAD_CHUNK_BYTES,
      maxUploadFileBytes: config.maxUploadFileBytes ?? DEFAULT_MAX_UPLOAD_FILE_BYTES,
      maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      maxUploadFiles: config.maxUploadFiles ?? DEFAULT_MAX_UPLOAD_FILES,
      uploadLifetimeMs: config.uploadLifetimeMs ?? DEFAULT_UPLOAD_LIFETIME_MS,
    }
    this.uploads = new DirectoryUploadManager(uploadConfig)
    ctx.effect(() => {
      const sweepMs = Math.min(uploadConfig.uploadLifetimeMs, 60_000)
      const timer = setInterval(() => {
        void this.uploads.expire().then(() => {
          for (const uploadId of this.fileUploads.keys()) {
            if (!this.uploads.has(uploadId)) this.fileUploads.delete(uploadId)
          }
        })
      }, sweepMs)
      timer.unref()
      return async () => {
        clearInterval(timer)
        await this.uploads.dispose()
        this.fileUploads.clear()
      }
    }, 'directory-picker-browse: incomplete upload cleanup')
  }

  /**
   * The browse interaction capability.
   * @returns the stable `browse` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  /** Resolve and confine one listing target; both directory picker and file tree use the same Host path fence. */
  private async resolveListingTarget(path?: string): Promise<{ home: string; target: string }> {
    let home = this.configuredBrowseRoot ?? homedir()
    // The seam contract takes fully qualified paths only; resolve() would
    // silently rebase a relative or empty wire value under the host process
    // cwd (or, for rooted drive-less Windows forms, its current drive).
    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
    }
    let target = resolve(path ?? home)
    if (this.configuredBrowseRoot !== undefined) {
      try {
        const [allowed, candidate] = await Promise.all([realpath(this.configuredBrowseRoot), realpath(target)])
        if (!insidePath(allowed, candidate)) {
          throw new DirectoryPickerError('directory-unreadable', candidate, `cannot list outside ${allowed}`)
        }
        home = allowed
        target = candidate
      } catch (error: unknown) {
        if (error instanceof DirectoryPickerError) throw error
        throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
      }
    }
    return { home, target }
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const { home, target } = await this.resolveListingTarget(path)
    // Stream the level (opendir, one dirent at a time) into a name-sorted
    // window of maxEntries + 1 candidates: memory stays bounded no matter how
    // many children the directory holds, the window keeps the name-sorted
    // head, and the +1 slot lets an in-window extra row prove the cut. A
    // window candidate that turns out non-enterable (broken symlink) is not
    // backfilled from beyond the window — an eviction already marks the
    // level truncated, which stays the honest answer.
    let window: ListingCandidate[]
    let evicted: boolean
    try {
      ({ window, evicted } = await scanCandidates(
        target,
        this.config.maxEntries + 1,
        signal,
        candidate => candidate.isDirectory || candidate.isSymbolicLink,
      ))
    } catch (error: unknown) {
      // An abort is the caller's own reason, not an unreadable directory.
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      // A caller that departed between reads and probes stops before the
      // next probe (each probe's own await is raced inside directoryRow).
      signal?.throwIfAborted()
      const row = await directoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    const crumbRoot = this.configuredBrowseRoot === undefined ? undefined : home
    return { path: target, home, crumbs: ancestryCrumbs(target, crumbRoot), entries, truncated }
  }

  /** List one file-tree level through the same browse-root and abort fences as the directory chooser. */
  private async listWorkspaceFiles(path: string, signal?: AbortSignal): Promise<WorkspaceFileListing> {
    const { target } = await this.resolveListingTarget(path)
    let window: ListingCandidate[]
    let evicted: boolean
    try {
      ({ window, evicted } = await scanCandidates(
        target,
        this.config.maxEntries + 1,
        signal,
        candidate => candidate.isDirectory || candidate.isFile || candidate.isSymbolicLink,
      ))
    } catch (error: unknown) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: WorkspaceFileEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      signal?.throwIfAborted()
      const row = await workspaceFileRow(target, candidate, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return { path: target, entries, truncated }
  }

  /** Resolve one regular file or directory without allowing a symlink download boundary. */
  private async resolveWorkspaceDownload(path: string, signal?: AbortSignal): Promise<WorkspaceDownloadTarget> {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot download "${path}": not a fully qualified path`)
    }
    const requested = resolve(path)
    const { target } = await this.resolveListingTarget(requested)
    signal?.throwIfAborted()
    try {
      // Reject the browser-named entry itself when it is a symlink. The
      // canonical realpath fence above prevents escapes, while this lstat
      // keeps downloads from silently changing meaning after listing.
      const sourceInfo = await raceAbort(lstat(requested), signal)
      if (sourceInfo.isSymbolicLink()) {
        throw new DirectoryPickerError('directory-unreadable', requested, 'symbolic links cannot be downloaded')
      }
      const info = await raceAbort(stat(target), signal)
      const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
      if (kind === undefined) {
        throw new DirectoryPickerError('directory-unreadable', target, 'download target is not a regular file or directory')
      }
      return { path: target, name: basename(target), kind }
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-unreadable', target, `cannot download ${target}: ${messageOf(error)}`)
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    // Same fully-qualified fence as list: never rebase a parent under the
    // cwd or the current drive.
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    let parent = resolve(path)
    if (this.configuredBrowseRoot !== undefined) {
      try {
        const [allowed, candidate] = await Promise.all([realpath(this.configuredBrowseRoot), realpath(parent)])
        if (!insidePath(allowed, candidate)) {
          throw new DirectoryPickerError('directory-create-failed', candidate, `cannot create outside ${allowed}`)
        }
        parent = candidate
      } catch (error: unknown) {
        if (error instanceof DirectoryPickerError) throw error
        throw new DirectoryPickerError('directory-create-failed', parent, `cannot create under ${parent}: ${messageOf(error)}`)
      }
    }
    // The backend owns segment validation (the wire schema also refuses these,
    // but direct service consumers must hit the same fence).
    if (!validSegment(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, name), `"${name}" is not a single path segment`)
    }
    const target = join(parent, name)
    try {
      // Non-recursive: the parent is the directory the browser is showing, so
      // a missing parent is a real failure, not a level to invent.
      await mkdir(target)
      return target
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  /** Create one exclusive empty file under the confined browse root. */
  private async createFile(path: string, name: string): Promise<string> {
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    if (!validSegment(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(path, name), `"${name}" is not a single path segment`)
    }
    const { target: parent } = await this.resolveListingTarget(path)
    const target = join(parent, name)
    try {
      const handle = await open(target, 'wx', 0o600)
      await handle.close()
      return target
    } catch (error: unknown) {
      if (errorCode(error, 'EEXIST')) {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  private beginDirectoryUpload(input: DirectoryUploadStart): Promise<DirectoryUploadSession> {
    return this.uploads.begin(input)
  }

  private writeDirectoryUpload(input: DirectoryUploadChunk): Promise<DirectoryUploadProgress> {
    return this.uploads.write(input)
  }

  private completeDirectoryUpload(uploadId: string): Promise<string> {
    return this.uploads.complete(uploadId)
  }

  private abortDirectoryUpload(uploadId: string): Promise<void> {
    return this.uploads.abort(uploadId)
  }

  /** Begin one file as a one-entry hidden directory transaction. */
  private async beginFileUpload(input: FileUploadStart): Promise<FileUploadSession> {
    if (!validSegment(input.name)) {
      throw new DirectoryPickerError('directory-upload-failed', input.name, `cannot upload "${input.name}": not a single path segment`)
    }
    const hiddenRoot = `.dsh-file-upload-${randomUUID()}`
    const session = await this.uploads.begin({
      parentPath: input.parentPath,
      name: hiddenRoot,
      fileCount: 1,
      totalBytes: input.totalBytes,
    })
    const target = join(dirname(session.path), input.name)
    try {
      await lstat(target)
      await this.uploads.abort(session.uploadId)
      throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      if (!errorCode(error, 'ENOENT')) {
        await this.uploads.abort(session.uploadId)
        throw new DirectoryPickerError('directory-upload-failed', target, `cannot inspect upload destination: ${messageOf(error)}`)
      }
    }
    this.fileUploads.set(session.uploadId, { target, name: input.name })
    return { uploadId: session.uploadId, path: target, maxChunkBytes: session.maxChunkBytes }
  }

  /** Append one ordered chunk through the shared transaction owner. */
  private writeFileUpload(input: FileUploadChunk): Promise<DirectoryUploadProgress> {
    const state = this.fileUploads.get(input.uploadId)
    if (state === undefined) {
      throw new DirectoryPickerError('directory-upload-failed', input.uploadId, 'file upload is unknown or expired')
    }
    return this.uploads.write({ ...input, path: state.name })
  }

  /** Publish the completed one-file transaction without replacing an existing file. */
  private async completeFileUpload(uploadId: string): Promise<string> {
    const state = this.fileUploads.get(uploadId)
    if (state === undefined) {
      throw new DirectoryPickerError('directory-upload-failed', uploadId, 'file upload is unknown or expired')
    }
    const root = await this.uploads.complete(uploadId)
    try {
      await link(join(root, state.name), state.target)
    } catch (error: unknown) {
      this.fileUploads.delete(uploadId)
      await rm(root, { recursive: true, force: true }).catch(() => {
        // The hidden transaction root is never a visible Workspace entry; a later manual cleanup can remove it.
      })
      if (errorCode(error, 'EEXIST')) {
        throw new DirectoryPickerError('directory-exists', state.target, `${state.target} already exists`)
      }
      throw new DirectoryPickerError('directory-upload-failed', state.target, `cannot publish file upload: ${messageOf(error)}`)
    }
    this.fileUploads.delete(uploadId)
    await rm(root, { recursive: true, force: true }).catch(() => {
      // The file is already atomically published; cleanup cannot turn a successful commit into an unknown outcome.
    })
    return state.target
  }

  /** Abort one incomplete file transaction. */
  private async abortFileUpload(uploadId: string): Promise<void> {
    await this.uploads.abort(uploadId)
    this.fileUploads.delete(uploadId)
  }
}
