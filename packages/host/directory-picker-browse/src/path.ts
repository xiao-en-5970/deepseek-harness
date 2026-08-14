import { posix, sep, win32 } from 'node:path'

/**
 * True when the path names one fixed filesystem location regardless of
 * process state: POSIX-absolute on POSIX; on Windows only drive-qualified
 * (`C:\\…`) or complete UNC (`\\\\server\\share…`) forms. Rooted drive-less
 * forms and incomplete UNC prefixes still depend on the current drive.
 * @param path - candidate path.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the path is fully qualified on the platform.
 */
export function fullyQualified(path: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
    ? win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path)
    : posix.isAbsolute(path)
}

/**
 * Platform-aware subtree membership after both paths have been canonicalized.
 * @param root - canonical subtree root.
 * @param candidate - canonical path tested against the root.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns whether the candidate is the root or one of its descendants.
 */
export function insidePath(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (value: string): string => platform === 'win32' ? value.toLowerCase() : value
  const base = fold(root)
  const target = fold(candidate)
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}
