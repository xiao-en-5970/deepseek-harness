/** Current-Workspace file tree and its non-destructive creation/upload actions. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutline14, IconChevronRightOutline14, IconCodeOutline16,
  IconDownloadOutline16, IconFolderClose16, IconPaperclipOutline16, IconPlusOutline16, IconProjectAddOutline16,
  IconRefreshOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceFileEntry, WorkspaceFileListing, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceFilesInjected, WorkspaceFilesPanelProps } from './contract/slots.ts'
import css from './WorkspaceFiles.module.css'

type FileActions = WorkspaceFilesInjected & Pick<WorkspaceFilesPanelProps, 't'>

/** Props supplied by the persistent right-side panel. */
export type WorkspaceFilesProps = FileActions & {
  workspace: WorkspaceView
}

interface LevelState {
  status: 'loading' | 'ready' | 'error'
  listing?: WorkspaceFileListing
  error?: string
}

interface DraftState {
  kind: 'file' | 'directory'
  parentPath: string
  value: string
  busy: boolean
  error: string | null
}

/** Unknown rejection text for the visible file-tree alert. */
function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Standard base64 for one bounded browser file chunk. */
function chunkBase64(bytes: Uint8Array): string {
  let binary = ''
  const block = 0x8000
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block))
  }
  return btoa(binary)
}

/** Same-origin GET route for one Host-authorized Workspace entry. */
export function workspaceDownloadUrl(path: string): string {
  return `/api/workspace.download?path=${encodeURIComponent(path)}`
}

/**
 * Current-Workspace file tree. Directories load lazily; mutations refresh only
 * their parent level, so a large Workspace never becomes one recursive RPC.
 * @param props - current Workspace and Host file actions.
 * @returns the file toolbar, tree, and inline creation form.
 */
export function WorkspaceFiles({
  workspace,
  listWorkspaceFiles,
  createFile,
  createDirectory,
  beginFileUpload,
  writeFileUpload,
  completeFileUpload,
  abortFileUpload,
  t,
}: WorkspaceFilesProps) {
  const root = workspace.path
  const [levels, setLevels] = useState<Record<string, LevelState>>({})
  const [expanded, setExpanded] = useState<string[]>([])
  const [selectedDirectory, setSelectedDirectory] = useState(root)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const controllers = useRef(new Map<string, AbortController>())
  const uploadInput = useRef<HTMLInputElement | null>(null)

  const load = useCallback((path: string): void => {
    controllers.current.get(path)?.abort()
    const controller = new AbortController()
    controllers.current.set(path, controller)
    setLevels((previous) => {
      const listing = previous[path]?.listing
      return {
        ...previous,
        [path]: listing === undefined ? { status: 'loading' } : { status: 'loading', listing },
      }
    })
    void listWorkspaceFiles(path, controller.signal).then(
      (listing) => {
        if (controller.signal.aborted) return
        controllers.current.delete(path)
        setLevels(previous => ({ ...previous, [path]: { status: 'ready', listing } }))
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        controllers.current.delete(path)
        setLevels(previous => ({ ...previous, [path]: { status: 'error', error: failureText(reason) } }))
      },
    )
  }, [listWorkspaceFiles])

  useEffect(() => {
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    setLevels({})
    setExpanded([root])
    setSelectedDirectory(root)
    setDraft(null)
    setOperationError(null)
    load(root)
    return () => {
      for (const controller of controllers.current.values()) controller.abort()
      controllers.current.clear()
    }
  }, [load, root])

  const refresh = (): void => {
    setOperationError(null)
    for (const path of expanded) load(path)
  }

  const toggleDirectory = (entry: WorkspaceFileEntry): void => {
    setSelectedDirectory(entry.path)
    setOperationError(null)
    const open = expanded.includes(entry.path)
    setExpanded(open ? expanded.filter(path => path !== entry.path) : [...expanded, entry.path])
    if (!open) load(entry.path)
  }

  const openDraft = (kind: DraftState['kind']): void => {
    setDraft({ kind, parentPath: selectedDirectory, value: '', busy: false, error: null })
    setOperationError(null)
  }

  const commitDraft = (): void => {
    if (draft === null || draft.busy || draft.value.trim() === '') return
    setDraft({ ...draft, busy: true, error: null })
    const operation = draft.kind === 'file'
      ? createFile(draft.parentPath, draft.value)
      : createDirectory(draft.parentPath, draft.value)
    void operation.then(() => {
      const parentPath = draft.parentPath
      setDraft(null)
      load(parentPath)
    }, (reason: unknown) => {
      setDraft(current => current === null ? null : { ...current, busy: false, error: failureText(reason) })
    })
  }

  const uploadFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || uploadProgress !== null) return
    setOperationError(null)
    const uploadTarget = selectedDirectory
    setUploadProgress({ done: 0, total: files.length })
    try {
      for (const [index, file] of files.entries()) {
        let uploadId: string | undefined
        try {
          const session = await beginFileUpload({
            parentPath: uploadTarget,
            name: file.name,
            totalBytes: file.size,
          })
          uploadId = session.uploadId
          let offset = 0
          if (file.size === 0) {
            offset = await writeFileUpload({ uploadId, offset: 0, data: '', done: true })
          } else {
            while (offset < file.size) {
              const end = Math.min(offset + session.maxChunkBytes, file.size)
              const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
              const acknowledged = await writeFileUpload({
                uploadId,
                offset,
                data: chunkBase64(bytes),
                done: end === file.size,
              })
              if (acknowledged !== end) throw new Error(`upload offset mismatch for ${file.name}`)
              offset = acknowledged
            }
          }
          if (offset !== file.size) throw new Error(`upload size mismatch for ${file.name}`)
          await completeFileUpload(uploadId)
          uploadId = undefined
          setUploadProgress({ done: index + 1, total: files.length })
        } catch (reason: unknown) {
          if (uploadId !== undefined) {
            try {
              await abortFileUpload(uploadId)
            } catch {
              // The original upload failure remains actionable; Host expiry is the cleanup backstop.
            }
          }
          throw reason
        }
      }
      load(uploadTarget)
    } catch (reason: unknown) {
      setOperationError(failureText(reason))
    } finally {
      setUploadProgress(null)
    }
  }

  const renderLevel = (path: string, depth: number): ReactNode => {
    const level = levels[path]
    if (level?.status === 'loading' && level.listing === undefined) {
      return <div className={css.status} style={{ paddingLeft: 12 + depth * 16 }}>{t('files.loading')}</div>
    }
    if (level?.status === 'error') {
      return (
        <button type="button" className={css.retry} onClick={() => { load(path) }}>
          {t('files.retry')}: {level.error}
        </button>
      )
    }
    const listing = level?.listing
    if (listing === undefined) return null
    return (
      <>
        {listing.entries.map((entry) => {
          const directory = entry.kind === 'directory'
          const open = directory && expanded.includes(entry.path)
          return (
            <div key={entry.path}>
              <div className={css.entry}>
                <button
                  type="button"
                  role="treeitem"
                  aria-expanded={directory ? open : undefined}
                  aria-selected={directory && selectedDirectory === entry.path}
                  className={clsx(css.row, directory && selectedDirectory === entry.path && css.selected)}
                  style={{ paddingLeft: 8 + depth * 16 }}
                  onClick={() => { if (directory) toggleDirectory(entry) }}
                >
                  <span className={css.twist} aria-hidden="true">
                    {directory ? (open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />) : null}
                  </span>
                  {directory ? <IconFolderClose16 size={16} /> : <IconCodeOutline16 size={16} />}
                  <span className={css.name}>{entry.name}</span>
                </button>
                <Tooltip label={t('files.download', { name: entry.name })}>
                  <a
                    className={css.download}
                    href={workspaceDownloadUrl(entry.path)}
                    download
                    aria-label={t('files.download', { name: entry.name })}
                    onClick={(event) => { event.stopPropagation() }}
                  ><IconDownloadOutline16 /></a>
                </Tooltip>
              </div>
              {open && renderLevel(entry.path, depth + 1)}
            </div>
          )
        })}
        {listing.entries.length === 0 && (
          <div className={css.status} style={{ paddingLeft: 12 + depth * 16 }}>{t('files.empty')}</div>
        )}
        {listing.truncated && (
          <div className={css.status} style={{ paddingLeft: 12 + depth * 16 }}>{t('files.truncated')}</div>
        )}
      </>
    )
  }

  return (
    <div className={css.root}>
      <div className={css.workspaceTitle} title={root}>{workspace.title}</div>
      <div className={css.toolbar}>
        <Tooltip label={t('files.newFile')}>
          <button type="button" aria-label={t('files.newFile')} onClick={() => { openDraft('file') }}><IconPlusOutline16 /></button>
        </Tooltip>
        <Tooltip label={t('files.newFolder')}>
          <button type="button" aria-label={t('files.newFolder')} onClick={() => { openDraft('directory') }}><IconProjectAddOutline16 /></button>
        </Tooltip>
        <input
          ref={uploadInput}
          className={css.fileInput}
          type="file"
          multiple
          onChange={(event) => {
            const files = event.currentTarget.files === null ? [] : Array.from(event.currentTarget.files)
            event.currentTarget.value = ''
            void uploadFiles(files)
          }}
        />
        <Tooltip label={t('files.upload')}>
          <button
            type="button"
            aria-label={t('files.upload')}
            disabled={uploadProgress !== null}
            onClick={() => { uploadInput.current?.click() }}
          ><IconPaperclipOutline16 /></button>
        </Tooltip>
        <Tooltip label={t('files.refresh')}>
          <button type="button" aria-label={t('files.refresh')} onClick={refresh}><IconRefreshOutline16 /></button>
        </Tooltip>
      </div>
      <div className={css.target} title={selectedDirectory}>
        {t('files.target', { name: selectedDirectory === root ? workspace.title : selectedDirectory.split(/[/\\]/).at(-1) ?? selectedDirectory })}
      </div>
      {draft !== null && (
        <div className={css.createForm}>
          <input
            autoFocus
            aria-label={draft.kind === 'file' ? t('files.fileName') : t('files.folderName')}
            value={draft.value}
            disabled={draft.busy}
            onChange={(event) => { setDraft({ ...draft, value: event.target.value, error: null }) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitDraft()
              else if (event.key === 'Escape' && !draft.busy) setDraft(null)
            }}
          />
          <Button size="sm" disabled={draft.busy || draft.value.trim() === ''} onClick={commitDraft}>{t('files.create')}</Button>
          <Button size="sm" variant="outline" disabled={draft.busy} onClick={() => { setDraft(null) }}>{t('files.cancel')}</Button>
          {draft.error !== null && <div className={css.error} role="alert">{draft.error}</div>}
        </div>
      )}
      {uploadProgress !== null && (
        <div className={css.status} role="status">{t('files.uploading', uploadProgress)}</div>
      )}
      {operationError !== null && <div className={css.error} role="alert">{operationError}</div>}
      <div className={css.tree} role="tree" aria-label={t('files.tree.aria')}>
        {renderLevel(root, 0)}
      </div>
    </div>
  )
}
