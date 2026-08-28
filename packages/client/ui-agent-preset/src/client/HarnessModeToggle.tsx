import { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import {
  currentHarnessMode, subscribeHarnessMode, type HarnessMode,
} from '@deepseek-ai/dsh-client-runtime/client'
import css from './HarnessModeToggle.module.css'

export type HarnessModeToggleInjected = {
  switchMode: (mode: HarnessMode) => void
}

export type HarnessModeToggleProps = PropsRuntime<'sidebar.footer.action'> & HarnessModeToggleInjected

/** Sidebar-wide mode switch; the rail keeps the same action as a compact Z/D glyph. */
export function HarnessModeToggle({ wide, switchMode }: HarnessModeToggleProps) {
  const mode = useSyncExternalStore(subscribeHarnessMode, currentHarnessMode, () => 'standard')
  const next = mode === 'zcode' ? 'standard' : 'zcode'
  const label = mode === 'zcode' ? '切回标准 Harness' : '切换 ZCode 模式'
  return (
    <button type="button" className={css.toggle} aria-label={label} onClick={() => { switchMode(next) }}>
      <span className={css.mark}>{mode === 'zcode' ? 'Z' : 'D'}</span>
      {wide && <span>{mode === 'zcode' ? 'ZCode 模式' : '标准 Harness'}</span>}
    </button>
  )
}
