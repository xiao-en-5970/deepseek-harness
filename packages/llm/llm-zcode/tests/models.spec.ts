import { describe, expect, it } from 'vitest'
import { assertZCodeModel, ZCODE_MODELS } from '../src/models.ts'

describe('ZCode model routes', () => {
  it('offers only the GLM 5.3 series', () => {
    expect(ZCODE_MODELS).toEqual(['glm-5.3-flash', 'glm-5.3'])
    for (const model of ZCODE_MODELS) expect(() => assertZCodeModel(model)).not.toThrow()
    expect(() => assertZCodeModel('glm-5')).toThrow(expect.objectContaining({ code: 'UNKNOWN_MODEL' }))
  })
})
