import { describe, expect, it } from 'vitest'
import type { Profile } from '@deepseek-ai/dsh-app-boot'
import { profileSkinsDirectory, resolveTelemetryPatch } from '../src/profile-boot.ts'

describe('resolveTelemetryPatch', () => {
  it('preserves the configured telemetry mode when the hard-disable switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    }
  })

  it('is trivially satisfied by a composition without the telemetry row', () => {
    // A custom profile need not mount telemetry: nothing exports, so the
    // privacy switch has nothing to disable and generates no patch.
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
    expect(resolveTelemetryPatch(undefined, false)).toBeUndefined()
  })
})

describe('profileSkinsDirectory', () => {
  const profile = (layers: Profile['layers']): Profile => ({
    name: 'web',
    dir: '/profile',
    layers,
    patchPath: '/profile/cordis.patch.yml',
    patches: [],
  })

  it('derives the aggregate scope directory without guessing a package-manager layout', () => {
    expect(profileSkinsDirectory(profile([]))).toBeUndefined()
    expect(profileSkinsDirectory(profile([{
      packageName: '@linxin666/dsh-skins',
      packageDir: '/install/node_modules/@linxin666/dsh-skins',
      patchPath: '/install/node_modules/@linxin666/dsh-skins/cordis.patch.yml',
      patches: [],
    }]))).toBe('/install/node_modules/@linxin666')
  })
})
