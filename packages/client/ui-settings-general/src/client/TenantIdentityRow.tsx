/** Tenant-web routing controls contributed to the General settings section. */

import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsKey } from './locales.ts'
import css from './TenantIdentityRow.module.css'

/** Selector-gateway endpoints intentionally outside the proxied Harness namespace. */
export const TENANT_CURRENT_PATH = '/__dsh_tenant/current'
export const TENANT_RESET_PATH = '/__dsh_tenant/reset'
export const TENANT_DEFAULT_PATH = '/__dsh_tenant/default'

/** Browser-safe routing state returned by `dsh tenant-web`. */
export type TenantSelectionState =
  | { readonly selected: false }
  | { readonly selected: true; readonly identifier: string | null }

/** Full component props. */
export type TenantIdentityRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'settings'>

/** Validate the tiny gateway response before letting it shape navigation UI. */
function selectionState(value: unknown): TenantSelectionState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { selected?: unknown; identifier?: unknown }
  if (candidate.selected === false) return { selected: false }
  if (candidate.selected !== true) return undefined
  if (candidate.identifier !== null && typeof candidate.identifier !== 'string') return undefined
  return { selected: true, identifier: candidate.identifier }
}

/**
 * Render tenant-web's current identifier and full-navigation switch actions.
 * Ordinary `dsh web` returns 404 for the probe, so this deployment-owned row
 * stays absent outside the selector gateway.
 * @param props - composed slot props.
 * @returns the tenant row, or null when no tenant gateway owns this browser.
 */
export function TenantIdentityRow({ t }: TenantIdentityRowProps) {
  const [state, setState] = useState<TenantSelectionState>()

  useEffect(() => {
    const controller = new AbortController()
    void fetch(TENANT_CURRENT_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return
      const validated = selectionState(await response.json())
      if (validated?.selected === true) setState(validated)
    }).catch(() => {
      // Capability probe: network failures and ordinary dsh-web 404s both
      // mean the selector controls do not belong on this page.
    })
    return () => { controller.abort() }
  }, [])

  if (state?.selected !== true) return null
  const named = state.identifier !== null
  const current = named ? state.identifier : t('tenant.default')
  const descriptionKey: SettingsKey = named ? 'tenant.description.named' : 'tenant.description.default'

  return (
    <div className={css.row} data-testid="tenant-identity-row">
      <div className={css.rowText}>
        <div className={css.title}>{t('tenant.title')}</div>
        <div className={css.current}>{t('tenant.current', { identifier: current })}</div>
        <div className={css.desc}>{t(descriptionKey)}</div>
      </div>
      <div className={css.actions}>
        <a className={css.action} href={TENANT_RESET_PATH}>{t('tenant.switch')}</a>
        {named && (
          <a className={`${css.action} ${css.primaryAction}`} href={TENANT_DEFAULT_PATH}>
            {t('tenant.useDefault')}
          </a>
        )}
      </div>
    </div>
  )
}
