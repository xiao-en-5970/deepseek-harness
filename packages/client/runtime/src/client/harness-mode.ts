/** Browser-local shell mode. History state preserves reloads without exposing a second URL switch. */
export type HarnessMode = 'standard' | 'zcode'

const MODE_STATE = 'dshHarnessMode'
const MODE_EVENT = 'dsh:harness-mode'

/**
 * Whether a session belongs in one shell mode's conversation list.
 * @param agentPreset - session's composed preset id.
 * @param mode - active shell mode.
 * @returns whether the session is visible in that mode.
 */
export function matchesHarnessMode(agentPreset: string | undefined, mode: HarnessMode): boolean {
  return mode === 'zcode' ? agentPreset === 'zcode' : agentPreset !== 'zcode'
}

/**
 * Current shell mode; absence keeps the DSH experience.
 * @returns mode recorded by the homepage switch.
 */
export function currentHarnessMode(): HarnessMode {
  if (typeof window === 'undefined') return 'standard'
  const state: unknown = window.history.state
  return state !== null && typeof state === 'object'
    && Reflect.get(state, MODE_STATE) === 'zcode' ? 'zcode' : 'standard'
}

/**
 * Subscribe to mode changes made by the homepage toggle.
 * @param listener - callback invoked after the homepage choice changes.
 * @returns subscription disposer.
 */
export function subscribeHarnessMode(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(MODE_EVENT, listener)
  return () => { window.removeEventListener(MODE_EVENT, listener) }
}

/**
 * Record a homepage-toggle choice without changing the visible URL.
 * @param mode - mode selected by the homepage button.
 */
export function publishHarnessMode(mode: HarnessMode): void {
  if (typeof window === 'undefined') return
  const state: unknown = window.history.state
  const previous = state !== null && typeof state === 'object' ? state : {}
  window.history.replaceState({ ...previous, [MODE_STATE]: mode }, '', window.location.href)
  window.dispatchEvent(new Event(MODE_EVENT))
}
