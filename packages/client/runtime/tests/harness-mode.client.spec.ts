// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currentHarnessMode, matchesHarnessMode, publishHarnessMode, subscribeHarnessMode,
} from '../src/client/harness-mode.ts'

describe('Harness mode', () => {
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('keeps the mode in the URL, notifies subscribers, and splits ZCode sessions', () => {
    const changed = vi.fn()
    const dispose = subscribeHarnessMode(changed)
    publishHarnessMode('zcode')

    expect(currentHarnessMode()).toBe('zcode')
    expect(window.location.search).toBe('?agent=zcode')
    expect(changed).toHaveBeenCalledOnce()
    expect(matchesHarnessMode('zcode', 'zcode')).toBe(true)
    expect(matchesHarnessMode('standard', 'zcode')).toBe(false)

    dispose()
  })
})
