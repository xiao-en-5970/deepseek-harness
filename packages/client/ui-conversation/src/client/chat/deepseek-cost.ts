/** Browser-local DeepSeek price calculation; client plugins cannot value-import token-meter. */

import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'

const PEAK = {
  'deepseek-v4-flash': { hit: 0.1, miss: 3, output: 9 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, output: 27 },
} as const

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function peak(timestamp: number): boolean {
  const parts = CLOCK.formatToParts(new Date(timestamp))
  const minutes = Number(parts.find(part => part.type === 'hour')?.value) * 60
    + Number(parts.find(part => part.type === 'minute')?.value)
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1_080)
}

function modelRate(model: string): typeof PEAK[keyof typeof PEAK] | undefined {
  if (model === 'deepseek-chat' || model === 'deepseek-reasoner') return PEAK['deepseek-v4-flash']
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro') return PEAK[model]
  return undefined
}

/**
 * Price one DeepSeek model request in CNY from disjoint provider usage.
 * @param provider - provider route used for the request.
 * @param model - provider model id used for the request.
 * @param timestamp - request start time in Unix milliseconds.
 * @param usage - disjoint token counters reported by the provider.
 * @returns estimated CNY cost, or undefined for an unknown route or model.
 */
export function deepSeekRequestCny(
  provider: string, model: string, timestamp: number, usage: Readonly<TokenUsage>,
): number | undefined {
  if (provider !== 'deepseek-official' && provider !== 'deepseek') return undefined
  const rate = modelRate(model)
  if (rate === undefined) return undefined
  const factor = peak(timestamp) ? 1 : 0.5
  return (
    usage.inputTokens * rate.miss
    + (usage.cacheReadTokens ?? 0) * rate.hit
    + (usage.cacheWriteTokens ?? 0) * rate.miss
    + usage.outputTokens * rate.output
  ) * factor / 1_000_000
}

/**
 * Format low-value replies without rounding them to zero.
 * @param cny - estimated cost in CNY.
 * @returns compact currency text.
 */
export function formatDeepSeekCost(cny: number): string {
  if (cny >= 1) return `¥${cny.toFixed(2)}`
  if (cny >= 0.01) return `¥${cny.toFixed(3)}`
  if (cny >= 0.0001) return `¥${cny.toFixed(4)}`
  return `¥${cny.toFixed(6)}`
}
