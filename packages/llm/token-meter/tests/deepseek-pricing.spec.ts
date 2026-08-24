import { describe, expect, it } from 'vitest'
import {
  calculateDeepSeekRequestCost, deepSeekBillingPeriod, formatDeepSeekCost,
} from '../src/deepseek-pricing.ts'

const beijing = (clock: string): number => Date.parse(`2026-08-17T${clock}:00+08:00`)

describe('DeepSeek pricing', () => {
  it.each([
    ['08:59', 'off-peak'], ['09:00', 'peak'], ['11:59', 'peak'], ['12:00', 'off-peak'],
    ['13:59', 'off-peak'], ['14:00', 'peak'], ['17:59', 'peak'], ['18:00', 'off-peak'],
  ] as const)('selects the Beijing billing period at %s', (clock, period) => {
    expect(deepSeekBillingPeriod(beijing(clock))).toBe(period)
  })

  it('prices disjoint cache-hit, cache-miss, cache-write, and output tokens', () => {
    expect(calculateDeepSeekRequestCost(
      'deepseek-official', 'deepseek-v4-flash', beijing('09:30'),
      { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 },
    )).toEqual({
      cny: 15.1,
      period: 'peak',
      prices: { cacheHitInput: 0.1, cacheMissInput: 3, output: 9 },
    })
  })

  it('halves every token rate off peak and does not double-count reasoning', () => {
    expect(calculateDeepSeekRequestCost(
      'deepseek', 'deepseek-v4-pro', beijing('12:30'),
      { inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 1_000_000 },
    )).toEqual({
      cny: 18,
      period: 'off-peak',
      prices: { cacheHitInput: 0.15, cacheMissInput: 4.5, output: 13.5 },
    })
  })

  it('keeps compatibility aliases billable and ignores unrelated routes', () => {
    expect(calculateDeepSeekRequestCost(
      'deepseek-official', 'deepseek-chat', beijing('09:30'),
      { inputTokens: 1_000_000, outputTokens: 0 },
    )?.cny).toBe(3)
    expect(calculateDeepSeekRequestCost(
      'openai', 'deepseek-v4-flash', beijing('09:30'),
      { inputTokens: 1_000_000, outputTokens: 0 },
    )).toBeUndefined()
  })

  it('formats low-cost replies without rounding them to zero', () => {
    expect(formatDeepSeekCost(2)).toBe('¥2.00')
    expect(formatDeepSeekCost(0.23456)).toBe('¥0.235')
    expect(formatDeepSeekCost(0.00456)).toBe('¥0.0046')
    expect(formatDeepSeekCost(0.0000123)).toBe('¥0.000012')
  })
})
