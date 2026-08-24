import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { MAX_REQUEST_IMAGE_BYTES, MAX_REQUEST_IMAGE_PIXELS, prepareRequestImage } from '../src/request-image.ts'

describe('prepareRequestImage', () => {
  it('bounds a large image and reuses its deterministic transform', async () => {
    const data = new Uint8Array(await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: '#3578e5' },
    }).png().toBuffer())
    const stored = {
      ref: {
        attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png' as const,
        bytes: data.byteLength,
        width: 2400,
        height: 1200,
      },
      data,
    }
    const first = prepareRequestImage(stored)
    const second = prepareRequestImage(stored)
    expect(second).toBe(first)
    const image = await first
    expect(image.width * image.height).toBeLessThanOrEqual(MAX_REQUEST_IMAGE_PIXELS)
    expect(image.width / image.height).toBeCloseTo(2, 2)
    expect(image.data.byteLength).toBeLessThanOrEqual(MAX_REQUEST_IMAGE_BYTES)
  })
})
