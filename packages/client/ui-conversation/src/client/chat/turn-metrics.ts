// Latency/throughput folds shared by the settled turn footer and StatsLine.

import type { AssistantMessageNode, ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import { deepSeekRequestCny } from './deepseek-cost.ts'

/** Latency and decode-throughput readings for one turn's footer. */
export interface TurnMetrics {
  /** First-step TTFT in ms; absent when that step carries no recorded timing. */
  ttftMs?: number
  /** Decode throughput over steps carrying both timing and provider usage. */
  tokensPerSecond?: number
  /** Token-priced DeepSeek spend across every completed model step in the turn. */
  costCny?: number
}

/** One assistant step's derivable latency facts; null marks an unrecorded part. */
export interface StepReading {
  /** step/start → first token delta, in ms. */
  ttftMs: number | null
  /** First token delta → final message, in ms. */
  decodeMs: number | null
  /** Provider-reported completion tokens. */
  outputTokens: number | null
}

interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

type AssistantNode = AssistantMessageNode

function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as UsageLike).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function tokenUsage(usage: unknown): TokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const candidate = usage as UsageLike
  if (typeof candidate.inputTokens !== 'number' || !Number.isFinite(candidate.inputTokens) || candidate.inputTokens < 0
    || typeof candidate.outputTokens !== 'number' || !Number.isFinite(candidate.outputTokens) || candidate.outputTokens < 0
    || (candidate.cacheReadTokens !== undefined
      && (!Number.isFinite(candidate.cacheReadTokens) || candidate.cacheReadTokens < 0))
    || (candidate.cacheWriteTokens !== undefined
      && (!Number.isFinite(candidate.cacheWriteTokens) || candidate.cacheWriteTokens < 0))) return undefined
  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    ...candidate.cacheReadTokens === undefined ? {} : { cacheReadTokens: candidate.cacheReadTokens },
    ...candidate.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: candidate.cacheWriteTokens },
  }
}

/** Price one finalized assistant step when it came from a current DeepSeek model. */
function assistantStepCost(node: AssistantMessageNode): number | undefined {
  const usage = tokenUsage(node.usage)
  const route = node.provenance ?? node.requestConfig
  if (usage === undefined || route === undefined) return undefined
  return deepSeekRequestCny(
    route.provider,
    route.model,
    node.timing?.stepStartTime ?? node.time,
    usage,
  )
}

/**
 * Read one assistant node's TTFT, decode wall time, and output tokens.
 * @param node - A settled assistant node.
 * @returns Per-part readings with `null` for unrecorded values.
 */
export function assistantStepReading(node: AssistantNode): StepReading {
  const timing = node.timing
  const ttftMs = timing !== undefined && timing.stepStartTime !== null && timing.firstTokenTime !== null
    ? Math.max(0, timing.firstTokenTime - timing.stepStartTime)
    : null
  const decodeMs = timing !== undefined && timing.firstTokenTime !== null
    ? Math.max(0, timing.completedTime - timing.firstTokenTime)
    : null
  return { ttftMs, decodeMs, outputTokens: usageOutputTokens(node.usage) }
}

interface TurnFold {
  firstStep: number
  firstStepTtftMs: number | null
  decodeMs: number
  outputTokens: number
  sampled: boolean
  costCny: number
  priced: boolean
}

/**
 * Fold assistant nodes into per-turn footer metrics.
 *
 * TTFT is the turn's lowest-step request-dispatch-to-first-token reading, so
 * it is only meaningful when the turn's start is inside
 * the loaded window (the caller gates on `turnTimings`, which shares that
 * window). Throughput divides summed output tokens by summed decode wall time,
 * counting only steps that carry both.
 * @param nodes - Snapshot nodes of the loaded window.
 * @returns Turn number → available metrics; turns with none are absent.
 */
export function deriveTurnMetrics(nodes: readonly ConversationNode[]): Map<number, TurnMetrics> {
  const folds = new Map<number, TurnFold>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const reading = assistantStepReading(node)
    let fold = folds.get(node.turn)
    if (fold === undefined) {
      fold = {
        firstStep: node.step, firstStepTtftMs: reading.ttftMs,
        decodeMs: 0, outputTokens: 0, sampled: false, costCny: 0, priced: false,
      }
      folds.set(node.turn, fold)
    } else if (node.step < fold.firstStep) {
      fold.firstStep = node.step
      fold.firstStepTtftMs = reading.ttftMs
    }
    if (reading.decodeMs !== null && reading.outputTokens !== null) {
      fold.decodeMs += reading.decodeMs
      fold.outputTokens += reading.outputTokens
      fold.sampled = true
    }
    const cost = assistantStepCost(node)
    if (cost !== undefined) {
      fold.costCny += cost
      fold.priced = true
    }
  }
  const metrics = new Map<number, TurnMetrics>()
  for (const [turn, fold] of folds) {
    const entry: TurnMetrics = {}
    if (fold.firstStepTtftMs !== null) entry.ttftMs = fold.firstStepTtftMs
    if (fold.sampled && fold.decodeMs > 0) entry.tokensPerSecond = fold.outputTokens / (fold.decodeMs / 1000)
    if (fold.priced) entry.costCny = fold.costCny
    if (entry.ttftMs !== undefined || entry.tokensPerSecond !== undefined || entry.costCny !== undefined) {
      metrics.set(turn, entry)
    }
  }
  return metrics
}
