/**
 * Registration: DSH preset controls stay in settings. The homepage owns the
 * DSH/ZCode engine switch and does not expose preset chips or labels.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetRow } from '../src/client/AgentPresetRow.tsx'
import type { AgentPresetRowInjected } from '../src/client/AgentPresetRow.tsx'
import { AgentPresetSection } from '../src/client/AgentPresetSection.tsx'
import type { AgentPresetSectionInjected } from '../src/client/AgentPresetSection.tsx'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

const ROSTER_ONE = {
  rpcId: 'r',
  result: {
    ok: true as const,
    value: {
      presets: [{ id: 'standard', trust: 'system', isDefault: true }],
      authorable: true,
      hasDocument: true,
    },
  },
}

/** The roster after this browser copied one preset of its own. */
const ROSTER_AUTHORED = {
  rpcId: 'r',
  result: {
    ok: true as const,
    value: {
      presets: [
        { id: 'standard', trust: 'system', isDefault: true },
        { id: 'mine', trust: 'user', isDefault: false },
      ],
      authorable: true,
      hasDocument: true,
    },
  },
}

async function bench() {
  const ctx = new Context()
  // The host's answer, mutable so a spec can move the default the way the
  // settings surface does and watch who re-reads it.
  let ROSTER: typeof ROSTER_ONE | typeof ROSTER_AUTHORED = ROSTER_ONE
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  // The plugins inject `remote`; forwarded events reach them through the
  // same `$dispatch` handoff the connection sink makes.
  new TestRemote(ctx)
  const calls: string[] = []
  ctx.provide('connection', {
    api: {
      agentPresets: {
        list: () => { calls.push('list'); return Promise.resolve(ROSTER) },
        read: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { agentPreset: 'standard', trust: 'system', content: '' } },
        }),
        copy: (payload: { from: string; agentPreset: string }) => {
          calls.push(`copy:${payload.agentPreset}`)
          // The host's roster now contains it, which is the whole point of the
          // copy and what every surface must converge on.
          ROSTER = ROSTER_AUTHORED
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { agentPreset: payload.agentPreset } } })
        },
        openDocument: (payload: { agentPreset: string }) => {
          calls.push(`openDocument:${payload.agentPreset}`)
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { opened: true as const } } })
        },
        remove: () => Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } }),
        select: (payload: { agentPreset: string }) => {
          calls.push(`select:${payload.agentPreset}`)
          return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { agentPreset: payload.agentPreset } } })
        },
      },
      settings: {
        // The row reads this to learn whether this browser may write at all.
        describe: () => Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
        }),
        update: (payload: { patch: unknown }) => { calls.push(`settings:${JSON.stringify(payload.patch)}`); return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: {} } }) },
      },
    },
  } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, calls }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      conversation: { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
}

/** Conversation declarations remain empty because presets are settings-only. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: {
      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

/** A workspaces double recording new-session starts. */
function workspacesDouble() {
  const starts: unknown[] = []
  return {
    starts,
    startSession: (workspaceId?: unknown) => { starts.push(workspaceId ?? null) },
  }
}

/** A sessions double whose list can be moved and whose changes are pushed. */
function sessionsDouble(state: {
  current?: string
  byId: Record<string, { id: string; blank: boolean; agentPreset?: string }>
}) {
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    noteAgentPreset: (sessionId: string, agentPreset: string) => {
      const summary = state.byId[sessionId]
      if (summary === undefined || summary.agentPreset === agentPreset) return
      summary.agentPreset = agentPreset
      for (const fn of listeners) fn()
    },
    /** Push a list change the way the runtime's store does. */
    notify: () => { for (const fn of listeners) fn() },
  }
}

describe('ui-agent-preset apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote'])
  })

  it('waits for session services before starting browser mode coordination', async () => {
    vi.stubGlobal('window', {})
    try {
      const { ctx, slots } = await bench()
      declareRoot(slots)
      await ctx.plugin({ inject: [...inject], apply }).await()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('registers the General row and the settings section', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = slots.entries('settings.general.item')[0]!
    expect(row.component).toBe(AgentPresetRow)
    expect(row.options).toMatchObject({ id: 'agent-preset', order: -25 })
    const section = slots.entries('settings.section')[0]!
    expect(section.component).toBe(AgentPresetSection)
    expect(section.options).toMatchObject({ id: 'agent-presets', order: 20 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('Agent 预设')
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('hands each surface its own store and actions', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const row = (slots.entries('settings.general.item')[0]!.inject as unknown as () => AgentPresetRowInjected)()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    expect(row.hooks.agentPreset).not.toBe(section.hooks.agentPresetSection)
    // Each thunk reaches its own controller: the row's load fills the row's
    // store, and the section's default write does not go through the row.
    await row.load()
    await row.select('standard')
    await section.makeDefault('standard')
    expect(row.hooks.agentPreset.getSnapshot().options).toEqual([{ id: 'standard', trust: 'system' }])
    expect(section.hooks.agentPresetSection.getSnapshot().rows)
      .toEqual([{ id: 'standard', trust: 'system', isDefault: true }])
  })

  it('routes the section actions to one controller', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()

    await section.load()
    section.beginCopy('standard')
    section.cancelCopy()
    section.beginCopy('standard')
    section.setCopyId('mine')
    section.setCopyName('我的模式')
    await section.confirmCopy()
    await section.view('standard')
    section.closeView()
    section.confirmDelete('mine')
    await Promise.all([section.openLocation('mine'), section.remove()])

    // One controller behind every action: the copy the dialog named is the
    // one the roster re-read reflects, and the delete the section confirmed
    // is the one its remove() sees.
    expect(calls).toContain('copy:mine')
    expect(calls.filter(call => call === 'openDocument:mine').length).toBeGreaterThan(0)
    expect(section.hooks.agentPresetSection.getSnapshot().rows).toHaveLength(2)
  })

  it('refreshes a showing surface when its namespace changes, and ignores others', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.remote.$dispatch('settings/document-updated', ['agent-presets', 1])
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
    const afterRelevant = calls.length

    ctx.remote.$dispatch('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()

    // Both surfaces re-read on their own namespace; an unrelated one moves
    // neither, so this rules out a blanket refresh on every settings write.
    expect(calls.length).toBe(afterRelevant)
  })

  it('re-reads both surfaces when the connection comes back', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    await section.load()
    const before = calls.length

    ctx.emit('connection/reset')

    // A reconnect can land on a host whose roster changed under the browser.
    await vi.waitFor(() => { expect(calls.length).toBe(before + 2) })
  })

  it('leaves the section alone until it has been opened once', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const before = calls.length

    ctx.remote.$dispatch('settings/document-updated', ['agent-presets', 1])
    await vi.waitFor(() => { expect(calls.length).toBeGreaterThan(before) })

    // Only the General row reloads: a section nobody opened has nothing to
    // converge, and reading the roster for it would be a wasted round trip.
    expect(calls.length - before).toBe(1)
  })

  it('does not register preset controls on the homepage or session header', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    ctx.provide('workspaces', workspacesDouble() as never)
    const fiber = ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'workspaces'], apply })
    await fiber.await()

    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
    await fiber.dispose()
    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(slots.entries('settings.section')).toHaveLength(0)
    conversation()
  })

  it('folds a remote preset commit into the shared session row', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state = {
      current: 's1',
      byId: { s1: { id: 's1', blank: true, agentPreset: 'standard' } },
    }
    ctx.provide('sessions', sessionsDouble(state) as never)
    ctx.provide('workspaces', workspacesDouble() as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'workspaces'], apply }).await()

    ctx.remote.$dispatch('agent-preset/selected', ['s1', 'minimal'])

    expect(state.byId.s1.agentPreset).toBe('minimal')
  })

  it('stages the creator preset and starts a session from the section', async () => {
    const { ctx, slots, calls } = await bench()
    declareRoot(slots)
    const conversation = declareConversation(slots)
    ctx.provide('conversation', {} as never)
    const state: {
      current?: string
      byId: Record<string, { id: string; blank: boolean; agentPreset?: string }>
    } = { byId: {} }
    const sessions = sessionsDouble(state)
    ctx.provide('sessions', sessions as never)
    const workspaces = workspacesDouble()
    ctx.provide('workspaces', workspaces as never)
    await ctx.plugin({ inject: [...inject, 'conversation', 'sessions', 'workspaces'], apply }).await()
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    section.startCreatorDraft?.()

    expect(section.startCreatorDraft).toBeDefined()
    expect(workspaces.starts).toHaveLength(1)
    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)

    state.current = 's1'
    state.byId['s1'] = { id: 's1', blank: true }
    sessions.notify()
    await vi.waitFor(() => { expect(calls).toContain('select:cordis') })
    conversation()
  })

  it('offers no creator draft while the conversation flow is absent', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // No conversation scope mounted: the face omits the affordance and the
    // section hides its button rather than staging into nowhere.
    const section = (slots.entries('settings.section')[0]!.inject as unknown as () => AgentPresetSectionInjected)()
    expect(section.startCreatorDraft).toBeUndefined()
  })
})
