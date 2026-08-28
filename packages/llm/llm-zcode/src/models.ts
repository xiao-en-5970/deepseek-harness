/** Supported ZCode model ids and exact-route validation. */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Models available through the ZCode agent integration. */
export const ZCODE_MODELS = ['glm-5.3-flash', 'glm-5.3'] as const

/**
 * Reject a model that this ZCode integration does not expose.
 * @param model - Exact ZCode model id.
 */
export function assertZCodeModel(model: string): void {
  if (!ZCODE_MODELS.some(candidate => candidate === model)) {
    throw new LlmError(`llm-zcode: unsupported model "${model}"`, 'UNKNOWN_MODEL')
  }
}
