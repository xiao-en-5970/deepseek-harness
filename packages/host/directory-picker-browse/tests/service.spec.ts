/** Behavior of the browse backend over a real temporary directory tree. */

import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerBrowseCapability } from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker, { boundedInsert, fullyQualified, raceAbort } from '../src/index.ts'
import type { ListingCandidate } from '../src/index.ts'

let root: string
let capability: DirectoryPickerBrowseCapability
let dispose: () => Promise<void>

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browse-'))
  await mkdir(join(root, 'projects'))
  await mkdir(join(root, 'projects', 'harness'))
  await mkdir(join(root, '.hidden-dir'))
  await writeFile(join(root, 'notes.txt'), 'not a directory')
  await symlink(join(root, 'projects'), join(root, 'linked'), 'junction')
  await symlink(join(root, 'gone'), join(root, 'broken'), 'junction')
  try {
    await symlink(join(root, 'notes.txt'), join(root, 'file-link'))
  } catch {
    // Windows denies unprivileged file symlinks; the file-link row only
    // feeds the POSIX lanes' coverage of the symlink-to-file arm, and every
    // assertion below expects it to be filtered out anyway.
  }

  const ctx = new Context()
  const fiber = ctx.plugin(BrowseDirectoryPicker)
  await fiber.await()
  const picked = ctx.get('directoryPicker')!.capability()
  if (picked.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
  capability = picked
  dispose = () => fiber.dispose()
})

afterAll(async () => {
  await dispose()
  await rm(root, { recursive: true, force: true })
})

describe('BrowseDirectoryPicker', () => {
  it('lists directories only, flags hidden rows, follows symlinks, skips broken links, sorts by name', async () => {
    const listing = await capability.list(root)
    expect(listing.path).toBe(root)
    expect(listing.home).toBe(homedir())
    expect(listing.entries.map(entry => entry.name)).toEqual(['.hidden-dir', 'linked', 'projects'])
    expect(listing.entries.map(entry => entry.hidden)).toEqual([true, false, false])
    // Every entry path is absolute and host-joined — clients never join segments.
    expect(listing.entries.every(entry => entry.path === join(root, entry.name))).toBe(true)
    // Well under the default bound: the complete level, not a cut one.
    expect(listing.truncated).toBe(false)
  })

  it('cuts a level at maxEntries keeping the name-sorted head, and flags the cut', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({ maxEntries: 1 }))
    await fiber.await()
    const bounded = ctx.get('directoryPicker')!.capability()
    if (bounded.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const cut = await bounded.list(root)
      expect(cut.entries.map(entry => entry.name)).toEqual(['.hidden-dir'])
      expect(cut.truncated).toBe(true)
      // Exactly at the bound is complete, not truncated.
      const exact = await bounded.list(join(root, 'projects'))
      expect(exact.entries.map(entry => entry.name)).toEqual(['harness'])
      expect(exact.truncated).toBe(false)
      // A level that fits the window but exceeds the bound (two rows, bound
      // one): the in-window extra row proves the cut without any eviction.
      await mkdir(join(root, 'projects', 'harness', 'a'))
      await mkdir(join(root, 'projects', 'harness', 'b'))
      const inWindow = await bounded.list(join(root, 'projects', 'harness'))
      expect(inWindow.entries.map(entry => entry.name)).toEqual(['a'])
      expect(inWindow.truncated).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('stops the scan with the caller: an aborted signal rejects with its own reason', async () => {
    const gone = new AbortController()
    gone.abort(new Error('caller left'))
    // The abort surfaces as-is, not dressed as an unreadable directory —
    // and rejects even before any level row is read.
    await expect(capability.list(root, gone.signal)).rejects.toThrow('caller left')
    // The abandoned open that still succeeds is closed, not leaked.
    await new Promise(resolve => setTimeout(resolve, 10))
    // Aborted against a missing target: the abandoned open rejects on its
    // own and there is nothing to close.
    await expect(capability.list(join(root, 'no-such-dir'), gone.signal)).rejects.toThrow('caller left')
    await new Promise(resolve => setTimeout(resolve, 10))
    // A live signal leaves a normal listing untouched — the reads and the
    // symlink probes race it without ever losing.
    const live = new AbortController()
    const complete = await capability.list(root, live.signal)
    expect(complete.truncated).toBe(false)
    expect(complete.entries.map(entry => entry.name)).toContain('linked')
    // A live signal changes nothing about ordinary failures.
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing, live.signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
  })

  it('raceAbort follows the operation until the signal wins, and swallows the abandoned settlement', async () => {
    // No signal / settled operations: plain passthrough, listener removed.
    await expect(raceAbort(Promise.resolve('ok'), undefined)).resolves.toBe('ok')
    const live = new AbortController()
    await expect(raceAbort(Promise.resolve('ok'), live.signal)).resolves.toBe('ok')
    // Failure passthrough keeps the operation's own error.
    await expect(raceAbort(Promise.reject(new Error('raw failure')), live.signal)).rejects.toThrow('raw failure')
    // The abort wins over a pending operation and carries its own reason;
    // the operation's late rejection is swallowed, never unhandled.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectLate!: (reason: unknown) => void
      const pending = new Promise<never>((_resolve, reject) => { rejectLate = reject })
      const controller = new AbortController()
      const raced = raceAbort(pending, controller.signal)
      // A bare-string abort reason exercises the Error wrap.
      controller.abort('caller left')
      await expect(raced).rejects.toThrow('caller left')
      rejectLate(new Error('late read failure'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('boundedInsert keeps the window name-sorted and bounded, reporting evictions', () => {
    const candidate = (name: string): ListingCandidate => ({ name, isDirectory: true, isSymbolicLink: false })
    const window: ListingCandidate[] = []
    expect(boundedInsert(window, candidate('m'), 2)).toBe(false)
    expect(boundedInsert(window, candidate('z'), 2)).toBe(false)
    // A smaller name lands in place and pushes the current largest out.
    expect(boundedInsert(window, candidate('a'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    // A name at or beyond the full window's tail rejects on one comparison.
    expect(boundedInsert(window, candidate('t'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
    expect(boundedInsert(window, candidate('m'), 2)).toBe(true)
    expect(window.map(entry => entry.name)).toEqual(['a', 'm'])
  })

  it('reports the ancestry as jump-target crumbs ending at the listed directory', async () => {
    const listing = await capability.list(join(root, 'projects'))
    const tail = listing.crumbs.at(-1)!
    expect(tail).toMatchObject({ name: 'projects', path: join(root, 'projects'), hidden: false })
    expect(listing.crumbs.at(-2)!.path).toBe(root)
    expect(listing.crumbs.at(-2)!.name).toBe(basename(root))
    // The chain starts at the filesystem root, whose crumb is labeled by its full path.
    expect(listing.crumbs[0]!.name).toBe(listing.crumbs[0]!.path)
  })

  it('lists the home directory when no path is given', async () => {
    const listing = await capability.list()
    expect(listing.path).toBe(homedir())
  })

  it('confines listing, creation, and default uploads to a configured browse root', async () => {
    const browseRoot = join(root, 'projects')
    const canonicalRoot = await realpath(browseRoot)
    await symlink(root, join(browseRoot, 'escape-link'), 'junction')
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({ maxEntries: 1000, browseRoot }))
    await fiber.await()
    const confined = ctx.get('directoryPicker')!.capability()
    if (confined.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const home = await confined.list()
      expect(home.home).toBe(canonicalRoot)
      expect(home.path).toBe(canonicalRoot)
      expect(home.crumbs.map(crumb => crumb.path)).toEqual([canonicalRoot])
      await expect(confined.list(root)).rejects.toMatchObject({ code: 'directory-unreadable' })
      await expect(confined.list(join(browseRoot, 'escape-link'))).rejects.toMatchObject({ code: 'directory-unreadable' })
      await expect(confined.createDirectory(root, 'outside')).rejects.toMatchObject({ code: 'directory-create-failed' })
      await expect(confined.beginDirectoryUpload({
        parentPath: root, name: 'outside-upload', fileCount: 1, totalBytes: 1,
      })).rejects.toMatchObject({ code: 'directory-upload-failed' })
      await expect(confined.createDirectory(browseRoot, 'inside')).resolves.toBe(join(canonicalRoot, 'inside'))
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a relative browse root during activation', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({ maxEntries: 1000, browseRoot: 'relative' }))
    await expect(fiber.await()).rejects.toThrow('directory browse root must be fully qualified')
    await fiber.dispose()
  })

  it('defaults decoded upload chunks below a one-mebibyte JSON transport body', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({
      maxEntries: 1000,
      uploadRoot: root,
    }))
    await fiber.await()
    const uploader = ctx.get('directoryPicker')!.capability()
    if (uploader.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const session = await uploader.beginDirectoryUpload({
        parentPath: root, name: 'default-chunk-upload', fileCount: 1, totalBytes: 1,
      })
      expect(session.maxChunkBytes).toBe(512 * 1024)
      // Base64 stays near 683 KiB, leaving the remainder of a 1 MiB request
      // for the RPC envelope and file metadata.
      expect(Math.ceil(session.maxChunkBytes / 3) * 4).toBeLessThan(700 * 1024)
      await uploader.abortDirectoryUpload(session.uploadId)
    } finally {
      await fiber.dispose()
    }
  })

  it('throws directory-unreadable for a missing target', async () => {
    const missing = join(root, 'no-such-dir')
    const failure = await capability.list(missing).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-unreadable')
    expect((failure as DirectoryPickerError).path).toBe(missing)
  })

  it('classifies fully qualified paths per platform (drive-less rooted Windows forms rejected)', () => {
    expect(fullyQualified('/home/x', 'linux')).toBe(true)
    expect(fullyQualified('x/y', 'darwin')).toBe(false)
    expect(fullyQualified('C:\\projects', 'win32')).toBe(true)
    expect(fullyQualified('C:/projects', 'win32')).toBe(true)
    expect(fullyQualified('\\\\server\\share', 'win32')).toBe(true)
    expect(fullyQualified('//server/share/deep', 'win32')).toBe(true)
    // Rooted but drive-less: isAbsolute accepts these, yet resolve() would
    // inject the process's current drive.
    expect(fullyQualified('\\foo', 'win32')).toBe(false)
    expect(fullyQualified('/foo', 'win32')).toBe(false)
    expect(fullyQualified('C:relative', 'win32')).toBe(false)
    // Incomplete UNC prefixes collapse to drive-relative roots under resolve().
    expect(fullyQualified('\\\\', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server', 'win32')).toBe(false)
    expect(fullyQualified('\\\\server\\', 'win32')).toBe(false)
  })

  it('rejects non-absolute paths instead of rebasing them under the process cwd', async () => {
    for (const relative of ['', 'projects', './projects', '..']) {
      const listFailure = await capability.list(relative).catch((error: unknown) => error)
      expect(listFailure).toBeInstanceOf(DirectoryPickerError)
      expect((listFailure as DirectoryPickerError).code).toBe('directory-unreadable')
      expect((listFailure as DirectoryPickerError).path).toBe(relative)
      const createFailure = await capability.createDirectory(relative, 'child').catch((error: unknown) => error)
      expect(createFailure).toBeInstanceOf(DirectoryPickerError)
      expect((createFailure as DirectoryPickerError).code).toBe('directory-create-failed')
      expect((createFailure as DirectoryPickerError).path).toBe(relative)
    }
  })

  it('creates one child directory and surfaces it in the next listing', async () => {
    const created = await capability.createDirectory(root, 'fresh')
    expect(created).toBe(join(root, 'fresh'))
    const listing = await capability.list(root)
    expect(listing.entries.map(entry => entry.name)).toContain('fresh')
  })

  it('refuses an existing child with directory-exists', async () => {
    const failure = await capability.createDirectory(root, 'projects').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DirectoryPickerError)
    expect((failure as DirectoryPickerError).code).toBe('directory-exists')
  })

  it('refuses non-segment names and other filesystem failures with directory-create-failed', async () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\\b']) {
      const failure = await capability.createDirectory(root, name).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DirectoryPickerError)
      expect((failure as DirectoryPickerError).code).toBe('directory-create-failed')
    }
    // Missing parent is a real failure, not a level to invent.
    const missingParent = await capability.createDirectory(join(root, 'no-such-dir'), 'child').catch((error: unknown) => error)
    expect((missingParent as DirectoryPickerError).code).toBe('directory-create-failed')
  })

  it('uploads nested files in bounded chunks and publishes only completed files', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({
      maxEntries: 1000,
      uploadRoot: root,
      maxUploadChunkBytes: 2,
      maxUploadFileBytes: 8,
      maxUploadBytes: 8,
      maxUploadFiles: 3,
    }))
    await fiber.await()
    const uploader = ctx.get('directoryPicker')!.capability()
    if (uploader.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const session = await uploader.beginDirectoryUpload({
        parentPath: root, name: 'browser-upload', fileCount: 2, totalBytes: 5,
      })
      expect(session.maxChunkBytes).toBe(2)
      await expect(uploader.writeDirectoryUpload({
        uploadId: session.uploadId, path: 'src/main.txt', offset: 0,
        data: Buffer.from('he').toString('base64'), done: false,
      })).resolves.toEqual({ offset: 2 })
      // The target stays absent until the terminal chunk publishes it.
      await expect(stat(session.path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(uploader.writeDirectoryUpload({
        uploadId: session.uploadId, path: 'src/main.txt', offset: 2,
        data: Buffer.from('ll').toString('base64'), done: false,
      })).resolves.toEqual({ offset: 4 })
      await expect(uploader.writeDirectoryUpload({
        uploadId: session.uploadId, path: 'src/main.txt', offset: 4,
        data: Buffer.from('o').toString('base64'), done: true,
      })).resolves.toEqual({ offset: 5 })
      await uploader.writeDirectoryUpload({
        uploadId: session.uploadId, path: 'empty.txt', offset: 0, data: '', done: true,
      })
      await expect(uploader.completeDirectoryUpload(session.uploadId)).resolves.toBe(session.path)
      await expect(readFile(join(session.path, 'src', 'main.txt'), 'utf8')).resolves.toBe('hello')
      await expect(readFile(join(session.path, 'empty.txt'))).resolves.toHaveLength(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects traversal, unordered or oversized chunks and abort removes the isolated root', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({
      maxEntries: 1000,
      uploadRoot: root,
      maxUploadChunkBytes: 2,
      maxUploadFileBytes: 3,
      maxUploadBytes: 4,
      maxUploadFiles: 1,
    }))
    await fiber.await()
    const uploader = ctx.get('directoryPicker')!.capability()
    if (uploader.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      const session = await uploader.beginDirectoryUpload({
        parentPath: root, name: 'rejected-upload', fileCount: 1, totalBytes: 3,
      })
      for (const input of [
        { path: '../escape.txt', offset: 0, data: Buffer.from('a').toString('base64'), done: true },
        { path: 'file.txt', offset: 1, data: Buffer.from('a').toString('base64'), done: false },
        { path: 'file.txt', offset: 0, data: Buffer.from('abc').toString('base64'), done: true },
      ]) {
        await expect(uploader.writeDirectoryUpload({ uploadId: session.uploadId, ...input }))
          .rejects.toMatchObject({ code: 'directory-upload-failed' })
      }
      await uploader.abortDirectoryUpload(session.uploadId)
      await expect(stat(session.path)).rejects.toMatchObject({ code: 'ENOENT' })
      // A second abort is deliberately idempotent for UI error cleanup.
      await expect(uploader.abortDirectoryUpload(session.uploadId)).resolves.toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('follows the configured upload-root fence and refuses a symlink parent inside an upload', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BrowseDirectoryPicker, BrowseDirectoryPicker.Config({
      maxEntries: 1000,
      uploadRoot: join(root, 'projects'),
    }))
    await fiber.await()
    const uploader = ctx.get('directoryPicker')!.capability()
    if (uploader.kind !== 'browse') throw new Error('browse backend must advertise the browse capability')
    try {
      await expect(uploader.beginDirectoryUpload({
        parentPath: root, name: 'outside-fence', fileCount: 1, totalBytes: 1,
      })).rejects.toMatchObject({ code: 'directory-upload-failed' })
      const session = await uploader.beginDirectoryUpload({
        parentPath: join(root, 'projects'), name: 'symlink-fence', fileCount: 1, totalBytes: 1,
      })
      const staging = join(join(root, 'projects'), `.symlink-fence.dsh-upload-${session.uploadId}`)
      await symlink(root, join(staging, 'escape'), 'junction')
      await expect(uploader.writeDirectoryUpload({
        uploadId: session.uploadId, path: 'escape/file.txt', offset: 0,
        data: Buffer.from('x').toString('base64'), done: true,
      })).rejects.toMatchObject({ code: 'directory-upload-failed' })
      await uploader.abortDirectoryUpload(session.uploadId)
      // Removing the isolated upload unlinks the junction; it never follows
      // it into the pre-existing configured tree.
      await expect(stat(root)).resolves.toBeTruthy()
    } finally {
      await fiber.dispose()
    }
  })
})
