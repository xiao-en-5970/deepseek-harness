/** Deterministic, bounded image encoding for DeepSeek vision requests. */

import { createHash } from 'node:crypto'
import sharp, { type Sharp } from 'sharp'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Maximum pixels in one image sent to DeepSeek. */
export const MAX_REQUEST_IMAGE_PIXELS = 640_000
/** Maximum encoded bytes in one image sent to DeepSeek. */
export const MAX_REQUEST_IMAGE_BYTES = 1024 * 1024
const TRANSFORM_VERSION = 'deepseek-vision-v1'
const QUALITIES = [85, 80] as const
const CACHE_ENTRIES = 128

/** Deterministic provider-ready image variant. */
export interface RequestImage {
  variantId: string
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

const cache = new Map<string, Promise<RequestImage>>()

/**
 * Scale image dimensions to an exact pixel ceiling without enlargement.
 * @param width - source width in pixels.
 * @param height - source height in pixels.
 * @param maxPixels - maximum output pixel count.
 * @returns bounded integer dimensions preserving aspect ratio.
 */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels = MAX_REQUEST_IMAGE_PIXELS,
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

async function hasLowColourCount(image: Sharp): Promise<boolean> {
  const { data, info } = await image.clone().resize({
    width: 128,
    height: 128,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: sharp.kernel.nearest,
  }).raw().toBuffer({ resolveWithObject: true })
  const colours = new Set<number>()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const alpha = info.channels === 4 ? data.readUInt8(offset + 3) : 255
    colours.add(
      ((data.readUInt8(offset) >> 3) << 15)
      | ((data.readUInt8(offset + 1) >> 3) << 10)
      | ((data.readUInt8(offset + 2) >> 3) << 5)
      | (alpha >> 3),
    )
    if (colours.size > 256) return false
  }
  return true
}

async function encode(
  image: Sharp,
  mediaType: Exclude<ImageMediaType, 'image/gif'>,
  quality?: number,
  palette = true,
): Promise<Omit<RequestImage, 'variantId'>> {
  const output = mediaType === 'image/png'
    ? image.png({ compressionLevel: 9, palette })
    : mediaType === 'image/webp'
      ? image.webp({ quality })
      : image.jpeg({ quality })
  const { data, info } = await output.toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height }
}

async function createRequestImage(stored: StoredImageAttachment, variantId: string): Promise<RequestImage> {
  try {
    const source = sharp(stored.data, { failOn: 'error', limitInputPixels: false }).rotate().toColourspace('srgb')
    const metadata = await source.clone().metadata()
    const sourceWidth = metadata.autoOrient.width ?? metadata.width ?? stored.ref.width
    const sourceHeight = metadata.autoOrient.height ?? metadata.height ?? stored.ref.height
    const hasAlpha = metadata.hasAlpha === true
    const lowColour = await hasLowColourCount(source)
    let dimensions = requestImageDimensions(sourceWidth, sourceHeight)

    for (;;) {
      const prepared = source.clone().resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
      const attempts = lowColour
        ? [
          () => encode(prepared.clone(), 'image/png', undefined, !hasAlpha),
          ...QUALITIES.map(quality => () => encode(prepared.clone(), 'image/webp', quality)),
        ]
        : hasAlpha
          ? QUALITIES.map(quality => () => encode(prepared.clone(), 'image/webp', quality))
          : QUALITIES.map(quality => () => encode(prepared.clone(), 'image/jpeg', quality))
      let smallest: Omit<RequestImage, 'variantId'> | undefined
      for (const attempt of attempts) {
        const candidate = await attempt()
        if (candidate.data.byteLength <= MAX_REQUEST_IMAGE_BYTES) return { variantId, ...candidate }
        if (smallest === undefined || candidate.data.byteLength < smallest.data.byteLength) smallest = candidate
      }
      if (dimensions.width === 1 && dimensions.height === 1) break
      const scale = Math.min(0.9, Math.sqrt(MAX_REQUEST_IMAGE_BYTES / (smallest?.data.byteLength ?? 1)) * 0.95)
      dimensions = {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale)),
      }
    }
  } catch (error: unknown) {
    if (error instanceof LlmError) throw error
    throw new LlmError('DeepSeek could not prepare an image for the vision request.', 'INVALID_REQUEST', { cause: error })
  }
  throw new LlmError('DeepSeek image cannot fit the 1 MiB request limit.', 'INVALID_REQUEST')
}

/**
 * Prepare and share one immutable attachment variant across concurrent requests.
 * @param stored - validated durable image attachment.
 * @returns deterministic provider-ready image bytes.
 */
export function prepareRequestImage(stored: StoredImageAttachment): Promise<RequestImage> {
  const variantId = `sha256:${createHash('sha256')
    .update(`${TRANSFORM_VERSION}\0${stored.ref.attachmentId}`)
    .digest('hex')}`
  const existing = cache.get(variantId)
  if (existing !== undefined) {
    cache.delete(variantId)
    cache.set(variantId, existing)
    return existing
  }
  const created = createRequestImage(stored, variantId).catch((error: unknown) => {
    cache.delete(variantId)
    throw error
  })
  cache.set(variantId, created)
  if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string)
  return created
}
