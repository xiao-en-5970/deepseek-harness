import { useMemo } from 'react'
import type { WorkspaceFilesPanelProps } from './contract/slots.ts'
import { WorkspaceFiles } from './WorkspaceFiles.tsx'

/** Persistent right-side file explorer for the current Workspace. */
export function WorkspaceFilesPanel({
  useSessions,
  useWorkspaces,
  listWorkspaceFiles,
  createFile,
  createDirectory,
  beginFileUpload,
  writeFileUpload,
  completeFileUpload,
  abortFileUpload,
  t,
}: WorkspaceFilesPanelProps) {
  const workspaces = useWorkspaces(state => state.items)
  const currentSessionId = useSessions(state => state.current)
  const currentSessionCwd = useSessions(state => state.current === undefined ? undefined : state.byId[state.current]?.cwd)
  const currentWorkspace = useMemo(
    () => workspaces.find(workspace => (
      currentSessionId !== undefined && workspace.sessionIds.includes(currentSessionId)
    ) || workspace.path === currentSessionCwd),
    [currentSessionCwd, currentSessionId, workspaces],
  )
  if (currentWorkspace === undefined) return null
  return (
    <WorkspaceFiles
      workspace={currentWorkspace}
      listWorkspaceFiles={listWorkspaceFiles}
      createFile={createFile}
      createDirectory={createDirectory}
      beginFileUpload={beginFileUpload}
      writeFileUpload={writeFileUpload}
      completeFileUpload={completeFileUpload}
      abortFileUpload={abortFileUpload}
      t={t}
    />
  )
}
