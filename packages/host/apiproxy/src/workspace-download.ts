/** Read-only Workspace file and directory download responses. */

import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Zip, ZipDeflate } from 'fflate'
import type { WorkspaceDownloadTarget } from '@deepseek-ai/dsh-host-directory-picker'

/** Maximum regular-file count in one Workspace directory archive. */
export const MAX_WORKSPACE_ARCHIVE_FILES = 10_000
/** Maximum aggregate regular-file bytes in one Workspace directory archive. */
export const MAX_WORKSPACE_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024

const FILE_CHUNK_BYTES = 1 << 16
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

/** Download failure whose status is safe to expose without a Host path. */
export class WorkspaceDownloadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'WorkspaceDownloadError'
  }
}

interface ArchiveDirectoryEntry {
  kind: 'directory'
  archivePath: string
}

interface ArchiveFileEntry {
  kind: 'file'
  archivePath: string
  path: string
  size: number
  dev: number
  ino: number
}

type ArchiveEntry = ArchiveDirectoryEntry | ArchiveFileEntry

/** Preserve a filesystem name in one ZIP segment without creating Windows separators. */
function zipSegment(name: string): string {
  const encoded = name.replaceAll('%', '%25').replaceAll('\\', '%5C')
  return encoded === '' || encoded === '.' || encoded === '..' ? 'workspace' : encoded
}

/** RFC 5987 attachment disposition with a conservative ASCII fallback. */
function attachmentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\\r\n]/g, '_') || 'download'
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Preflight one directory without following symlinks and enforce archive bounds. */
async function archiveEntries(root: string, rootName: string, signal: AbortSignal): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = []
  const pending: Array<{ path: string; archivePath: string; root: boolean }> = [{
    path: root,
    archivePath: `${zipSegment(rootName)}/`,
    root: true,
  }]
  let files = 0
  let bytes = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    const current = pending.pop()
    if (current === undefined) break
    let info
    try {
      info = await lstat(current.path)
    } catch {
      throw new WorkspaceDownloadError(409, 'Workspace download target changed while preparing the archive.')
    }
    signal.throwIfAborted()
    if (info.isSymbolicLink()) {
      if (current.root) throw new WorkspaceDownloadError(400, 'Symbolic links cannot be downloaded.')
      continue
    }
    if (info.isDirectory()) {
      const directoryArchivePath = current.archivePath.endsWith('/')
        ? current.archivePath
        : `${current.archivePath}/`
      entries.push({ kind: 'directory', archivePath: directoryArchivePath })
      let level
      try {
        level = await opendir(current.path)
      } catch {
        throw new WorkspaceDownloadError(409, 'Workspace directory changed while preparing the archive.')
      }
      const children: string[] = []
      try {
        for await (const dirent of level) children.push(dirent.name)
      } catch {
        throw new WorkspaceDownloadError(409, 'Workspace directory changed while preparing the archive.')
      }
      children.sort((left, right) => left.localeCompare(right))
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const name = children[index]
        if (name === undefined) continue
        pending.push({
          path: join(current.path, name),
          archivePath: `${directoryArchivePath}${zipSegment(name)}`,
          root: false,
        })
      }
      continue
    }
    if (!info.isFile()) continue
    files += 1
    bytes += info.size
    if (files > MAX_WORKSPACE_ARCHIVE_FILES || bytes > MAX_WORKSPACE_ARCHIVE_BYTES) {
      throw new WorkspaceDownloadError(
        413,
        `Workspace archive exceeds ${String(MAX_WORKSPACE_ARCHIVE_FILES)} files or ${String(MAX_WORKSPACE_ARCHIVE_BYTES)} bytes.`,
      )
    }
    entries.push({
      kind: 'file', archivePath: current.archivePath, path: current.path,
      size: info.size, dev: info.dev, ino: info.ino,
    })
  }
  return entries
}

/** Pull-driven response-capacity gate shared by ZIP file chunks. */
class ResponseCapacityGate {
  private releasePending: (() => void) | undefined

  async wait(controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (controller.desiredSize === null || controller.desiredSize > 0) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        this.releasePending = undefined
        signal.removeEventListener('abort', release)
        resolve()
      }
      this.releasePending = release
      signal.addEventListener('abort', release, { once: true })
    })
    signal.throwIfAborted()
  }

  pulled(): void {
    this.releasePending?.()
  }
}

/** Stream one preflighted file into a ZIP entry, refusing symlink/change races. */
async function pushArchiveFile(
  entry: ArchiveFileEntry,
  deflate: ZipDeflate,
  controller: ReadableStreamDefaultController<Uint8Array>,
  capacity: ResponseCapacityGate,
  signal: AbortSignal,
): Promise<void> {
  const handle = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino || current.size !== entry.size) {
      throw new WorkspaceDownloadError(409, 'Workspace file changed while building the archive.')
    }
    const buffer = new Uint8Array(FILE_CHUNK_BYTES)
    let offset = 0
    if (entry.size === 0) {
      deflate.push(buffer.subarray(0, 0), true)
      return
    }
    while (offset < entry.size) {
      signal.throwIfAborted()
      const length = Math.min(buffer.byteLength, entry.size - offset)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      if (bytesRead === 0) throw new WorkspaceDownloadError(409, 'Workspace file changed while building the archive.')
      offset += bytesRead
      deflate.push(buffer.subarray(0, bytesRead), offset === entry.size)
      await capacity.wait(controller, signal)
    }
  } finally {
    await handle.close()
  }
}

/** Build a bounded, streaming ZIP response from a canonical directory target. */
async function directoryResponse(target: WorkspaceDownloadTarget, signal: AbortSignal): Promise<Response> {
  const entries = await archiveEntries(target.path, target.name, signal)
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  const capacity = new ResponseCapacityGate()
  let zip: Zip | undefined
  let terminated = false
  const terminate = (): void => {
    if (zip === undefined || terminated) return
    terminated = true
    zip.terminate()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const archive = new Zip((error, data, final) => {
        if (error) {
          controller.error(error)
          return
        }
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      void (async () => {
        try {
          for (const entry of entries) {
            producerSignal.throwIfAborted()
            const deflate = new ZipDeflate(entry.archivePath, { level: entry.kind === 'directory' ? 0 : 6 })
            archive.add(deflate)
            if (entry.kind === 'directory') deflate.push(new Uint8Array(), true)
            else await pushArchiveFile(entry, deflate, controller, capacity, producerSignal)
          }
          archive.end()
        } catch (error) {
          terminate()
          try {
            controller.error(error instanceof Error ? error : new Error(String(error)))
          } catch {
            // The consumer may already have cancelled the response.
          }
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(reason instanceof Error ? reason : new Error('Workspace archive download cancelled'))
      terminate()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': attachmentDisposition(`${target.name}.zip`),
      'cache-control': 'private, no-store',
    },
  })
}

/** Stream one canonical regular file without following a replacement symlink. */
async function fileResponse(target: WorkspaceDownloadTarget, signal: AbortSignal): Promise<Response> {
  const handle = await open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const info = await handle.stat()
  if (!info.isFile()) {
    await handle.close()
    throw new WorkspaceDownloadError(409, 'Workspace download target is no longer a regular file.')
  }
  const stream = Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>
  signal.addEventListener('abort', () => { void handle.close() }, { once: true })
  return new Response(stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(info.size),
      'content-disposition': attachmentDisposition(target.name),
      'cache-control': 'private, no-store',
    },
  })
}

/**
 * Produce the direct download response for one confined target.
 * @param target - confined file or directory selected for download.
 * @param signal - cancellation for response production and streaming.
 * @returns a file stream or generated directory archive response.
 */
export function workspaceDownloadResponse(target: WorkspaceDownloadTarget, signal: AbortSignal): Promise<Response> {
  return target.kind === 'directory' ? directoryResponse(target, signal) : fileResponse(target, signal)
}
