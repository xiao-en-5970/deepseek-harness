/** DeepSeek's current token pricing and Beijing-time peak/off-peak calculation. */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Billing period selected from the request start time. */
export type DeepSeekBillingPeriod = 'peak' | 'off-peak'

/** One model's prices in CNY per million tokens. */
export interface DeepSeekTokenPrices {
  cacheHitInput: number
  cacheMissInput: number
  output: number
}

/** Calculated cost for one provider request. */
export interface DeepSeekRequestCost {
  cny: number
  period: DeepSeekBillingPeriod
  prices: DeepSeekTokenPrices
}

/** Durable aggregate exposed through the session projection registry. */
export interface DeepSeekCostProjection {
  cny: number
  requests: number
}

const PEAK_PRICES: Readonly<Record<'deepseek-v4-flash' | 'deepseek-v4-pro', DeepSeekTokenPrices>> = {
  'deepseek-v4-flash': { cacheHitInput: 0.1, cacheMissInput: 3, output: 9 },
  'deepseek-v4-pro': { cacheHitInput: 0.3, cacheMissInput: 9, output: 27 },
}

const BEIJING_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * Resolve DeepSeek's current billing period. Peak windows are 09:00-12:00 and
 * 14:00-18:00 Beijing time; every other instant is off-peak.
 * @param requestStartedAt - request start time in Unix epoch milliseconds.
 * @returns the price period for that request.
 */
export function deepSeekBillingPeriod(requestStartedAt: number): DeepSeekBillingPeriod {
  const parts = BEIJING_CLOCK.formatToParts(new Date(requestStartedAt))
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  const minute = Number(parts.find(part => part.type === 'minute')?.value)
  const clockMinutes = hour * 60 + minute
  return (clockMinutes >= 9 * 60 && clockMinutes < 12 * 60)
    || (clockMinutes >= 14 * 60 && clockMinutes < 18 * 60)
    ? 'peak'
    : 'off-peak'
}

/** Normalize the two temporary compatibility model names to current V4 billing. */
function pricedModel(model: string): keyof typeof PEAK_PRICES | undefined {
  if (model === 'deepseek-chat' || model === 'deepseek-reasoner') return 'deepseek-v4-flash'
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro') return model
  return undefined
}

/**
 * Calculate one DeepSeek request from provider-reported disjoint token counts.
 * Reasoning tokens are already included in outputTokens and are not added again.
 * @param provider - Harness provider route.
 * @param model - provider model id.
 * @param requestStartedAt - request start time in Unix epoch milliseconds.
 * @param usage - provider-reported token usage.
 * @returns cost and selected prices, or undefined for a non-DeepSeek or unpriced model.
 */
export function calculateDeepSeekRequestCost(
  provider: string,
  model: string,
  requestStartedAt: number,
  usage: Readonly<TokenUsage>,
): DeepSeekRequestCost | undefined {
  if (provider !== 'deepseek-official' && provider !== 'deepseek') return undefined
  const normalized = pricedModel(model)
  if (normalized === undefined) return undefined
  const period = deepSeekBillingPeriod(requestStartedAt)
  const peak = PEAK_PRICES[normalized]
  const factor = period === 'peak' ? 1 : 0.5
  const prices: DeepSeekTokenPrices = {
    cacheHitInput: peak.cacheHitInput * factor,
    cacheMissInput: peak.cacheMissInput * factor,
    output: peak.output * factor,
  }
  const cny = (
    usage.inputTokens * prices.cacheMissInput
    + (usage.cacheReadTokens ?? 0) * prices.cacheHitInput
    + (usage.cacheWriteTokens ?? 0) * prices.cacheMissInput
    + usage.outputTokens * prices.output
  ) / 1_000_000
  return { cny, period, prices }
}

/**
 * Format a small CNY amount without rounding low-cost replies to zero.
 * @param cny - non-negative CNY amount.
 * @returns compact amount prefixed with the yuan symbol.
 */
export function formatDeepSeekCost(cny: number): string {
  if (cny >= 1) return `¥${cny.toFixed(2)}`
  if (cny >= 0.01) return `¥${cny.toFixed(3)}`
  if (cny >= 0.0001) return `¥${cny.toFixed(4)}`
  return `¥${cny.toFixed(6)}`
}
