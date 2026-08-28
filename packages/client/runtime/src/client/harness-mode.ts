/** Browser-local shell mode. The URL keeps refresh/back behavior explicit without touching tenant data. */
export type HarnessMode = 'standard' | 'zcode'

const MODE_PARAM = 'agent'
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
 * Current shell mode; absence keeps the ordinary Harness experience.
 * @returns mode encoded in the current URL.
 */
export function currentHarnessMode(): HarnessMode {
  if (typeof window === 'undefined') return 'standard'
  return new URL(window.location.href).searchParams.get(MODE_PARAM) === 'zcode' ? 'zcode' : 'standard'
}

/**
 * Subscribe to mode changes made by the toggle or browser navigation.
 * @param listener - callback invoked after the URL mode changes.
 * @returns subscription disposer.
 */
export function subscribeHarnessMode(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(MODE_EVENT, listener)
  window.addEventListener('popstate', listener)
  return () => {
    window.removeEventListener(MODE_EVENT, listener)
    window.removeEventListener('popstate', listener)
  }
}

/**
 * Replace the current URL's mode marker and notify mounted views.
 * @param mode - mode to encode in the current URL.
 */
export function publishHarnessMode(mode: HarnessMode): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (mode === 'zcode') url.searchParams.set(MODE_PARAM, 'zcode')
  else url.searchParams.delete(MODE_PARAM)
  window.history.replaceState(window.history.state, '', url)
  window.dispatchEvent(new Event(MODE_EVENT))
}
