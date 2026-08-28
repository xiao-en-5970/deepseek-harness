/**
 * Agent-preset surface plugin, browser half — settings controls for DSH
 * presets plus the homepage DSH/ZCode engine switch.
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset). That is what splits
 * the choice from the display: the General row and the hero chip are both
 * before-the-fact, while the header only reports what a session already runs.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the settings invalidation rides the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetRow } from './AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from './AgentPresetRow.tsx'
import { AgentPresetSection } from './AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from './AgentPresetSection.tsx'
import { AgentPresetSeatController } from './seat-store.ts'
import type { SeatSessionSummary } from './seat-store.ts'
import { AgentPresetSectionController } from './section-store.ts'
import { en, zh } from './locales.ts'
import { AGENT_PRESET_SETTINGS_NS, AgentPresetSettingsController } from './settings-store.ts'
import { HarnessModeToggle } from './HarnessModeToggle.tsx'
import type { HarnessModeToggleInjected } from './HarnessModeToggle.tsx'
import {
  currentHarnessMode, matchesHarnessMode, publishHarnessMode, subscribeHarnessMode, type HarnessMode,
} from '@deepseek-ai/dsh-client-runtime/client'

export type { AgentPresetLabelInjected, AgentPresetLabelProps } from './AgentPresetLabel.tsx'
export type { AgentPresetRowInjected, AgentPresetRowProps } from './AgentPresetRow.tsx'
export type { AgentPresetSeatInjected, AgentPresetSeatProps } from './AgentPresetSeat.tsx'
export type { AgentPresetSectionInjected, AgentPresetSectionProps } from './AgentPresetSection.tsx'
export type { AgentPresetSeatState, SeatSessionSummary } from './seat-store.ts'
export {
  draftBlocker, type AgentPresetSectionState, type CopyDraft, type PresetRow, type PresetView,
} from './section-store.ts'
export type { AgentPresetOption, AgentPresetSettingsState } from './settings-store.ts'
export { AGENT_PRESET_SETTINGS_NS, writeDefaultPreset } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Mount the General-settings row.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const controller = new AgentPresetSettingsController(api)
  const section = new AgentPresetSectionController(api, () => {
    void controller.load()
  })
  ctx.inject(['sessions', 'workspaces'], (scope: ClientContext) => {
    const remembered = new Map<HarnessMode, string>()
    const presetFor = (mode: HarnessMode): string => mode === 'zcode' ? 'zcode' : 'standard'
    const navigateMode = (mode: HarnessMode, updateUrl = true): void => {
      const sessions = scope.sessions.list.getSnapshot()
      const workspaces = scope.workspaces.list.getSnapshot()
      const current = sessions.current
      if (current !== undefined) {
        const summary = sessions.byId[current]
        remembered.set(summary?.agentPreset === 'zcode' ? 'zcode' : 'standard', current)
      }
      const workspace = current === undefined
        ? workspaces.items.find(item => item.workspaceId === workspaces.recentWorkspaceId)
        : workspaces.items.find(item => item.sessionIds.includes(current))
      scope.workspaces.setSessionCreatePreset(presetFor(mode))
      scope.sessions.clear()
      if (workspace !== undefined) {
        const archived = new Set(workspaces.archivedSessionIds)
        const rememberedId = remembered.get(mode)
        const candidates = workspace.sessionIds
          .map(id => sessions.byId[id])
          .filter((summary): summary is NonNullable<typeof summary> => summary !== undefined
            && !archived.has(summary.id) && matchesHarnessMode(summary.agentPreset, mode))
          .sort((left, right) => right.updatedAt - left.updatedAt)
        const target = candidates.find(summary => summary.id === rememberedId) ?? candidates[0]
        if (target !== undefined) scope.sessions.open(target.id)
        else scope.workspaces.startSession(workspace.workspaceId)
      }
      if (updateUrl) publishHarnessMode(mode)
    }

    scope.effect(() => {
      if (typeof window === 'undefined') return () => {}
      const reconcile = (): void => {
        const mode = currentHarnessMode()
        scope.workspaces.setSessionCreatePreset(presetFor(mode))
        const sessions = scope.sessions.list.getSnapshot()
        const current = sessions.current
        if (current !== undefined && !matchesHarnessMode(sessions.byId[current]?.agentPreset, mode)
          && scope.workspaces.list.getSnapshot().baselinesReady) navigateMode(mode, false)
      }
      const disposers = [
        subscribeHarnessMode(reconcile),
        scope.sessions.list.subscribe(reconcile),
        scope.workspaces.list.subscribe(reconcile),
      ]
      reconcile()
      return () => { for (const dispose of disposers) dispose() }
    }, 'ui-agent-preset: mode-aware session creation')

    scope.effect(() => scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
      name: 'sidebar.footer.action',
      id: 'harness-mode',
      order: -20,
      inject: (): HarnessModeToggleInjected => ({ switchMode: navigateMode }),
    }, HarnessModeToggle)), 'ui-agent-preset: Harness/ZCode mode switch')
  })

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en }), 'ui-agent-preset: settings row dictionaries')

  const injected = (): AgentPresetRowInjected => ({
    hooks: { agentPreset: controller.store },
    load: () => controller.load(),
    select: (id: string) => controller.select(id),
  })

  ctx.effect(() => {
    // The roster is a live directory and the default is a settings field, so
    // both an external settings edit and a reconnect can move this row.
    const refresh = (): void => {
      void controller.load()
      // The section reads the same roster and marks the same default, so a
      // change made from either surface converges both.
      if (section.store.getSnapshot().status !== 'idle') void section.load()
    }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== AGENT_PRESET_SETTINGS_NS) return
        refresh()
      }),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-agent-preset: settings refresh')

  // The settings section's conversational authoring entry: stage the
  // self-referential preset and land a new session on it. Bound inside the
  // conversation scope below (the seat and the session flow live there) and
  // unbound with it, so the section's face reads the current binding per
  // render and simply hides the button while no flow exists.
  let creatorDraft: (() => void) | undefined

  // Creator mode still stages its DSH preset onto the blank session started
  // from settings; ordinary engine switching belongs only to the homepage.
  ctx.inject(['conversation', 'sessions', 'workspaces'], (scope: ClientContext) => {
    const api = (scope.get('connection') as ConnectionHandle).api
    const seat = new AgentPresetSeatController(api, (): SeatSessionSummary | undefined => {
      const state = scope.sessions.list.getSnapshot()
      const summary = state.current === undefined ? undefined : state.byId[state.current]
      return summary === undefined
        ? undefined
        : {
          id: summary.id,
          blank: summary.blank,
          ...summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset },
        }
    }, (sessionId, agentPreset) => {
      scope.sessions.noteAgentPreset(sessionId as never, agentPreset)
    })

    scope.effect(() => {
      // Connecting a workspace either creates or reuses a blank session, so
      // the settings-owned Creator stage applies when that session arrives.
      const stop = scope.sessions.list.subscribe(() => { void seat.apply() })
      // Every tab folds the committed preset into the shared session row; the
      // initiating tab may already have applied the RPC echo, which is idempotent.
      const presetSelected = scope.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
        scope.sessions.noteAgentPreset(sessionId, agentPreset)
      })
      // Stage without applying to the still-running session, then start the
      // blank session that accepts the Creator composition.
      creatorDraft = () => {
        seat.stage('cordis')
        scope.workspaces.startSession()
      }
      return () => {
        stop()
        presetSelected()
        creatorDraft = undefined
      }
    }, 'ui-agent-preset: Creator preset staging')
  })

  const sectionInjected = (): AgentPresetSectionInjected => ({
    hooks: { agentPresetSection: section.store },
    load: () => section.load(),
    view: (id: string) => section.view(id),
    closeView: () => { section.closeView() },
    beginCopy: (from: string) => { section.beginCopy(from) },
    cancelCopy: () => { section.cancelCopy() },
    setCopyId: (id: string) => { section.setCopyId(id) },
    setCopyName: (name: string) => { section.setCopyName(name) },
    confirmCopy: () => section.confirmCopy(),
    openLocation: (id: string) => section.openLocation(id),
    ...creatorDraft === undefined ? {} : { startCreatorDraft: creatorDraft },
    confirmDelete: (id: string | null) => { section.confirmDelete(id) },
    remove: () => section.remove(),
    makeDefault: (id: string) => section.makeDefault(id),
  })

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'agent-preset',
    order: -25,
    locale: 'settings.agentPreset',
    inject: injected,
  }, AgentPresetRow))
  // Ordered after Models: choosing a model is routine, and composing an
  // agent is the deployment-shaping act behind it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-presets',
    order: 20,
    label: () => ctx.locale.bind('settings.agentPreset')('nav'),
    locale: 'settings.agentPreset',
    inject: sectionInjected,
  }, AgentPresetSection))
}
