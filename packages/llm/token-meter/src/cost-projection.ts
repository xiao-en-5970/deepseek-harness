/** Durable DeepSeek request-cost fold over provider usage records. */

import { z } from 'zod'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { calculateDeepSeekRequestCost, type DeepSeekCostProjection } from './deepseek-pricing.ts'

interface CostSample {
  turn: number
  step: number
  cny: number
}

interface CostState {
  totals: DeepSeekCostProjection
  header?: EpochHeader
  step?: { turn: number; step: number; startedAt: number }
  last: CostSample | null
}

const costSchema = z.object({
  cny: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
}).strict()

function usageEvent(event: SessionEvent): {
  turn: number
  step: number
  usage: TokenUsage
  provider?: string
  model?: string
} | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, usage: event.data.chunk.usage }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    const source = event.data.message.source
    return {
      turn: event.data.turn,
      step: event.data.step,
      usage: event.data.usage,
      ...source.kind === 'model' ? { provider: source.provider, model: source.model } : {},
    }
  }
  return undefined
}

/** Session projection of DeepSeek spend under the current public price schedule. */
export const deepSeekCostProjectionDefinition:
ProjectionDefinition<'deepSeekCost', CostState> = {
  key: 'deepSeekCost',
  schema: costSchema,
  init: () => ({ totals: { cny: 0, requests: 0 }, last: null }),
  apply: (state, event) => {
    if (event.type === 'request/header') return { ...state, header: event.data.header }
    if (event.type === 'step/start') {
      return { ...state, step: { turn: event.data.turn, step: event.data.step, startedAt: event.time } }
    }
    const sample = usageEvent(event)
    if (sample === undefined) return state
    const provider = sample.provider ?? state.header?.config.provider
    const model = sample.model ?? state.header?.config.model
    if (provider === undefined || model === undefined) return state
    const startedAt = state.step?.turn === sample.turn && state.step.step === sample.step
      ? state.step.startedAt
      : event.time
    const calculated = calculateDeepSeekRequestCost(provider, model, startedAt, sample.usage)
    if (calculated === undefined) return state
    const previous = state.last?.turn === sample.turn && state.last.step === sample.step
      ? state.last
      : undefined
    if (previous?.cny === calculated.cny) return state
    return {
      ...state,
      totals: {
        cny: state.totals.cny - (previous?.cny ?? 0) + calculated.cny,
        requests: state.totals.requests + (previous === undefined ? 1 : 0),
      },
      last: { turn: sample.turn, step: sample.step, cny: calculated.cny },
    }
  },
  view: state => state.totals,
  stateVersion: 1,
}
