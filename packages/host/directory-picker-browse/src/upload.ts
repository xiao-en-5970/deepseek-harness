import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryUploadChunk, DirectoryUploadProgress, DirectoryUploadSession, DirectoryUploadStart,
} from '@deepseek-ai/dsh-host-directory-picker'
import { fullyQualified, insidePath } from './path.ts'

/** Runtime limits for browser-to-host directory uploads. */
export interface DirectoryUploadConfig {
  /** Fully qualified subtree in which uploads may create their root; blank means the Host account's home directory. */
  uploadRoot: string
  /** Maximum decoded bytes in one RPC chunk. */
  maxUploadChunkBytes: number
  /** Maximum decoded bytes in one uploaded file. */
  maxUploadFileBytes: number
  /** Maximum decoded bytes in one directory upload. */
  maxUploadBytes: number
  /** Maximum files in one directory upload. */
  maxUploadFiles: number
  /** Idle lifetime before an incomplete upload and its isolated root are removed. */
  uploadLifetimeMs: number
}

interface UploadFile {
  readonly target: string
  readonly temporary: string
  offset: number
}

interface UploadState {
  readonly uploadId: string
  readonly staging: string
  readonly root: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly files: Map<string, UploadFile>
  readonly seenPaths: Set<string>
  completedFiles: number
  receivedBytes: number
  expiresAt: number
  busy: boolean
}

/** Unknown thrown value as operator-facing text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a filesystem failure carries a specific Node error code. */
function errorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** One path segment accepted from a browser directory manifest. */
function validSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\0') && !/[/\\]/.test(segment)
}

/** Parse a browser-standard slash-separated relative path without normalizing attacker-controlled segments. */
function relativeSegments(path: string): string[] {
  const segments = path.split('/')
  if (segments.length === 0 || segments.some(segment => !validSegment(segment))) {
    throw new DirectoryPickerError('directory-upload-failed', path, `cannot upload "${path}": expected a safe relative file path`)
  }
  return segments
}

/** A canonical base64 chunk, including the empty terminal chunk used for an empty file. */
function decodeChunk(data: string, path: string): Buffer {
  const decoded = Buffer.from(data, 'base64')
  if (decoded.toString('base64') !== data) {
    throw new DirectoryPickerError('directory-upload-failed', path, `cannot upload ${path}: chunk is not canonical base64`)
  }
  return decoded
}

/** Write every byte at the declared offset; FileHandle.write may settle partially. */
async function writeAll(path: string, offset: number, data: Buffer): Promise<void> {
  const handle = await open(path, offset === 0 ? 'wx' : 'r+')
  try {
    let written = 0
    while (written < data.byteLength) {
      const result = await handle.write(data, written, data.byteLength - written, offset + written)
      if (result.bytesWritten === 0) throw new Error('filesystem write made no progress')
      written += result.bytesWritten
    }
  } finally {
    await handle.close()
  }
}

/**
 * Stateful upload owner for the browse backend. A hidden staging root is
 * created exclusively before its id is returned; chunks stay in hidden
 * temporary files, and the requested root appears only at complete-time.
 */
export class DirectoryUploadManager {
  private readonly states = new Map<string, UploadState>()
  private readonly configuredRoot: string

  constructor(private readonly config: DirectoryUploadConfig) {
    const root = config.uploadRoot === '' ? homedir() : config.uploadRoot
    if (!fullyQualified(root)) throw new Error(`directory upload root must be fully qualified: ${root}`)
    this.configuredRoot = resolve(root)
  }

  /**
   * Begin one bounded upload under an existing authorized parent.
   * @param input - Requested parent/root name and exact manifest totals.
   * @returns Opaque upload identity, eventual root, and decoded chunk bound.
   */
  async begin(input: DirectoryUploadStart): Promise<DirectoryUploadSession> {
    if (!fullyQualified(input.parentPath)) {
      throw new DirectoryPickerError('directory-upload-failed', input.parentPath, `cannot upload under "${input.parentPath}": not a fully qualified parent path`)
    }
    if (!validSegment(input.name)) {
      throw new DirectoryPickerError('directory-upload-failed', input.name, `cannot upload "${input.name}": not a single path segment`)
    }
    if (input.fileCount < 1 || input.fileCount > this.config.maxUploadFiles) {
      throw new DirectoryPickerError('directory-upload-failed', input.name, `directory upload has ${String(input.fileCount)} files; the limit is ${String(this.config.maxUploadFiles)}`)
    }
    if (input.totalBytes > this.config.maxUploadBytes) {
      throw new DirectoryPickerError('directory-upload-failed', input.name, `directory upload has ${String(input.totalBytes)} bytes; the limit is ${String(this.config.maxUploadBytes)}`)
    }
    let allowed: string
    let parent: string
    try {
      [allowed, parent] = await Promise.all([realpath(this.configuredRoot), realpath(input.parentPath)])
    } catch (error: unknown) {
      throw new DirectoryPickerError('directory-upload-failed', input.parentPath, `cannot start directory upload: ${messageOf(error)}`)
    }
    if (!insidePath(allowed, parent)) {
      throw new DirectoryPickerError('directory-upload-failed', parent, `cannot upload outside ${allowed}`)
    }
    const root = join(parent, input.name)
    try {
      await lstat(root)
      throw new DirectoryPickerError('directory-exists', root, `${root} already exists`)
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      if (!errorCode(error, 'ENOENT')) {
        throw new DirectoryPickerError('directory-upload-failed', root, `cannot inspect upload root ${root}: ${messageOf(error)}`)
      }
    }
    const uploadId = randomUUID()
    const staging = join(parent, `.${input.name}.dsh-upload-${uploadId}`)
    try {
      await mkdir(staging)
    } catch (error: unknown) {
      throw new DirectoryPickerError('directory-upload-failed', root, `cannot create upload staging root: ${messageOf(error)}`)
    }
    this.states.set(uploadId, {
      uploadId,
      staging,
      root,
      fileCount: input.fileCount,
      totalBytes: input.totalBytes,
      files: new Map(),
      seenPaths: new Set(),
      completedFiles: 0,
      receivedBytes: 0,
      expiresAt: Date.now() + this.config.uploadLifetimeMs,
      busy: false,
    })
    return { uploadId, path: root, maxChunkBytes: this.config.maxUploadChunkBytes }
  }

  /**
   * Append one ordered chunk and atomically publish the file on its terminal chunk.
   * @param input - Upload identity, safe relative file path, offset, bytes, and terminal marker.
   * @returns The next acknowledged byte offset for that file.
   */
  async write(input: DirectoryUploadChunk): Promise<DirectoryUploadProgress> {
    const state = this.require(input.uploadId)
    if (state.busy) throw this.failure(state.root, 'another operation is already writing this upload')
    state.busy = true
    try {
      state.expiresAt = Date.now() + this.config.uploadLifetimeMs
      const segments = relativeSegments(input.path)
      const data = decodeChunk(input.data, input.path)
      const stagingInfo = await lstat(state.staging)
      if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
        throw this.failure(state.root, 'upload staging root is not a plain directory')
      }
      if (data.byteLength > this.config.maxUploadChunkBytes) {
        throw this.failure(input.path, `chunk has ${String(data.byteLength)} bytes; the limit is ${String(this.config.maxUploadChunkBytes)}`)
      }
      if (data.byteLength === 0 && !input.done) throw this.failure(input.path, 'an empty non-terminal chunk makes no progress')
      let file = state.files.get(input.path)
      if (file === undefined) {
        if (input.offset !== 0) throw this.failure(input.path, `first chunk offset must be 0, got ${String(input.offset)}`)
        if (state.seenPaths.has(input.path) || state.seenPaths.size >= state.fileCount) {
          throw this.failure(input.path, 'file path is duplicated or exceeds the declared file count')
        }
        let parent = state.staging
        for (const segment of segments.slice(0, -1)) {
          parent = join(parent, segment)
          try {
            await mkdir(parent)
          } catch (error: unknown) {
            if (!errorCode(error, 'EEXIST')) throw error
          }
          const info = await lstat(parent)
          if (!info.isDirectory() || info.isSymbolicLink()) throw this.failure(parent, 'upload parent is not a plain directory')
        }
        const filename = segments.at(-1)
        /* v8 ignore next -- relativeSegments always returns at least one valid segment. */
        if (filename === undefined) throw this.failure(input.path, 'upload path has no file name')
        const target = join(parent, filename)
        try {
          await lstat(target)
          throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
        } catch (error: unknown) {
          if (error instanceof DirectoryPickerError) throw error
          if (!errorCode(error, 'ENOENT')) throw error
        }
        file = { target, temporary: join(parent, `.${basename(target)}.dsh-upload-${randomUUID()}.part`), offset: 0 }
        state.files.set(input.path, file)
        state.seenPaths.add(input.path)
      }
      if (input.offset !== file.offset) {
        throw this.failure(input.path, `chunk offset ${String(input.offset)} does not match ${String(file.offset)}`)
      }
      if (file.offset + data.byteLength > this.config.maxUploadFileBytes) {
        throw this.failure(input.path, `file exceeds the ${String(this.config.maxUploadFileBytes)} byte limit`)
      }
      if (state.receivedBytes + data.byteLength > state.totalBytes) {
        throw this.failure(input.path, 'received bytes exceed the declared directory total')
      }
      await writeAll(file.temporary, file.offset, data)
      file.offset += data.byteLength
      state.receivedBytes += data.byteLength
      if (input.done) {
        await link(file.temporary, file.target)
        await unlink(file.temporary)
        state.files.delete(input.path)
        state.completedFiles += 1
      }
      return { offset: file.offset }
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw this.failure(input.path, `cannot write directory upload: ${messageOf(error)}`)
    } finally {
      state.busy = false
    }
  }

  /**
   * Commit an upload only when its declared file and byte totals match.
   * @param uploadId - Opaque identity returned by {@link begin}.
   * @returns The newly published absolute directory root.
   */
  async complete(uploadId: string): Promise<string> {
    const state = this.require(uploadId)
    if (state.busy) throw this.failure(state.root, 'another operation is already writing this upload')
    state.busy = true
    try {
      if (state.files.size !== 0 || state.completedFiles !== state.fileCount || state.receivedBytes !== state.totalBytes) {
        throw this.failure(state.root, `upload is incomplete: ${String(state.completedFiles)}/${String(state.fileCount)} files, ${String(state.receivedBytes)}/${String(state.totalBytes)} bytes`)
      }
      const stagingInfo = await lstat(state.staging)
      if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink()) {
        throw this.failure(state.root, 'upload staging root is not a plain directory')
      }
      try {
        await lstat(state.root)
        throw new DirectoryPickerError('directory-exists', state.root, `${state.root} already exists`)
      } catch (error: unknown) {
        if (error instanceof DirectoryPickerError) throw error
        if (!errorCode(error, 'ENOENT')) throw this.failure(state.root, `cannot inspect upload destination: ${messageOf(error)}`)
      }
      await rename(state.staging, state.root)
      this.states.delete(uploadId)
      return state.root
    } catch (error: unknown) {
      if (error instanceof DirectoryPickerError) throw error
      throw this.failure(state.root, `cannot publish directory upload: ${messageOf(error)}`)
    } finally {
      state.busy = false
    }
  }

  /**
   * Abort is idempotent; only a root minted by this manager can be removed.
   * @param uploadId - Opaque active or already-retired upload identity.
   */
  async abort(uploadId: string): Promise<void> {
    const state = this.states.get(uploadId)
    if (state === undefined) return
    if (state.busy) throw this.failure(state.root, 'another operation is already writing this upload')
    state.busy = true
    try {
      await rm(state.staging, { recursive: true, force: true })
      this.states.delete(uploadId)
    } catch (error: unknown) {
      state.expiresAt = Date.now() + this.config.uploadLifetimeMs
      throw this.failure(state.root, `cannot remove aborted upload: ${messageOf(error)}`)
    } finally {
      state.busy = false
    }
  }

  /**
   * Remove idle incomplete roots; cleanup failures are retried by the next sweep.
   * @param now - Sweep time, injectable for deterministic expiry tests.
   */
  async expire(now = Date.now()): Promise<void> {
    for (const state of [...this.states.values()]) {
      if (state.busy || state.expiresAt > now) continue
      try {
        await this.abort(state.uploadId)
      } catch {
        state.expiresAt = now + this.config.uploadLifetimeMs
      }
    }
  }

  /** Remove every incomplete root on plugin teardown. */
  async dispose(): Promise<void> {
    for (const state of [...this.states.values()]) {
      try {
        await this.abort(state.uploadId)
      } catch {
        // Teardown has no caller to recover through; roots retain the hidden
        // temporary suffix and the next process never treats them as complete.
      }
    }
  }

  private require(uploadId: string): UploadState {
    const state = this.states.get(uploadId)
    if (state === undefined) throw this.failure(uploadId, 'directory upload is unknown or expired')
    return state
  }

  private failure(path: string, message: string): DirectoryPickerError {
    return new DirectoryPickerError('directory-upload-failed', path, message)
  }
}
