/** Package-owned invariant companion for `@deepseek-ai/dsh-llm-zcode`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'llm-zcode-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-llm-zcode', install))
