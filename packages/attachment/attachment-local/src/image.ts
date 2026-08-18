/** Raster inspection: full decode at admission, header-only probe on verified reads. */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  width: number
  height: number
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function detectNonRasterMedia(data: Uint8Array): DetectedImage | undefined {
  if (data.length >= 4) {
    // PDF magic bytes: %PDF
    if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
      return { mediaType: 'application/pdf', width: 0, height: 0 }
    }
    // WAV magic bytes: RIFF....WAVE
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
      return { mediaType: 'audio/wav', width: 0, height: 0 }
    }
    // OGG magic bytes: OggS
    if (data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
      return { mediaType: 'audio/ogg', width: 0, height: 0 }
    }
    // MP3 magic bytes: ID3 or 0xFF, 0xFB / 0xF3 / 0xF2
    const isId3 = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33
    const isMpegSync = data[0] === 0xff && data[1] !== undefined && (data[1] & 0xe0) === 0xe0
    if (isId3 || isMpegSync) {
      return { mediaType: 'audio/mpeg', width: 0, height: 0 }
    }
    // MP4 magic bytes: ....ftyp
    if (data.length >= 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
      return { mediaType: 'video/mp4', width: 0, height: 0 }
    }
  }
  return undefined
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  return { mediaType, width: metadata.width, height: metadata.height }
}

/**
 * Parse a supported media's header and return its intrinsic metadata without
 * decoding pixels. Digest-verified reads use this: admission already proved
 * that these exact bytes decode completely, so the read path only re-derives
 * the reference fields instead of paying the full-raster decode again.
 * @param data - complete encoded image or document/audio bytes.
 * @returns verified format and dimensions.
 */
export async function probeImage(data: Uint8Array): Promise<DetectedImage> {
  const nonRaster = detectNonRasterMedia(data)
  if (nonRaster !== undefined) return nonRaster

  try {
    return await imageMetadata(sharp(data, { failOn: 'error', limitInputPixels: false }))
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}

/**
 * Fully decode a supported media and return its intrinsic metadata.
 * @param data - complete encoded image or document/audio bytes.
 * @param maxPixels - decoded-pixel admission limit.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, maxPixels?: number): Promise<DetectedImage> {
  const nonRaster = detectNonRasterMedia(data)
  if (nonRaster !== undefined) return nonRaster

  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: false })
    const detected = await imageMetadata(image)
    if (maxPixels !== undefined && detected.width * detected.height > maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    await image.raw().toBuffer()
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
