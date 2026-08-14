/** Package-owned invariant companion for the Codex image proxy tool. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-codex-image-proxy'

/** Cordis companion plugin name. */
export const name = 'tool-codex-image-proxy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: queue request/result validity is checked at every
// filesystem boundary, and the package owns no independent lifecycle relation.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
