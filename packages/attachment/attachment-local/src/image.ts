/** Raster inspection: full decode at admission, header-only probe on verified reads. */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Decoded metadata from a supported image. */
export interface DetectedImage {
  mediaType: ImageMediaType
  /** Intrinsic width with EXIF orientation applied — the width a viewer perceives. */
  width: number
  /** Intrinsic height with EXIF orientation applied — the height a viewer perceives. */
  height: number
  /** Whether the container carries more than one frame. */
  animated: boolean
  /** Whether the bytes carry descriptive metadata, a color profile, or orientation. */
  carriesMetadata: boolean
  /** Sharp sample depth reported for the decoded channels. */
  depth: string
  /** Sharp colour space reported for the decoded pixels. */
  space: string
  /** Whether decoded pixels carry an alpha channel. */
  hasAlpha: boolean
}

/**
 * Check alpha metadata for bytes produced by this package's encoders.
 * Sharp/libvips may omit an all-opaque alpha plane from WebP output; every
 * other addition or removal indicates that the encoded result is incompatible
 * with its source facts.
 * @param sourceHasAlpha - whether the source bytes declare an alpha plane, or undefined when the source frame is unspecified.
 * @param output - decoded media type and alpha metadata from the encoded result.
 * @returns whether the output alpha metadata is compatible with the source.
 */
export function encodedAlphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DetectedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return sourceHasAlpha === undefined
    || output.hasAlpha === sourceHasAlpha
    || (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function nonRasterResult(mediaType: ImageMediaType): DetectedImage {
  return {
    mediaType,
    width: 0,
    height: 0,
    animated: false,
    carriesMetadata: false,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

function detectNonRasterMedia(data: Uint8Array): DetectedImage | undefined {
  if (data.length >= 4) {
    // PDF magic bytes: %PDF
    if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
      return nonRasterResult('application/pdf')
    }
    // WAV magic bytes: RIFF....WAVE
    if (
      data.length >= 12
      && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45
    ) {
      return nonRasterResult('audio/wav')
    }
    // OGG magic bytes: OggS
    if (data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) {
      return nonRasterResult('audio/ogg')
    }
    // FLAC magic bytes: fLaC
    if (data[0] === 0x66 && data[1] === 0x4c && data[2] === 0x61 && data[3] === 0x43) {
      return nonRasterResult('audio/flac')
    }
    // WebM / Matroska magic bytes: 0x1A 0x45 0xDF 0xA3
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
      return nonRasterResult('video/webm')
    }
    // MP3 magic bytes: ID3 or 0xFF, 0xFB / 0xF3 / 0xF2
    const isId3 = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33
    const isMpegSync = data[0] === 0xff && data[1] !== undefined && (data[1] & 0xe0) === 0xe0
    if (isId3 || isMpegSync) {
      return nonRasterResult('audio/mpeg')
    }
    // MP4 / QuickTime MOV / M4A: ....ftyp
    if (data.length >= 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
      if (data.length >= 12 && data[8] !== undefined && data[9] !== undefined && data[10] !== undefined && data[11] !== undefined) {
        const brand = String.fromCharCode(data[8], data[9], data[10], data[11])
        if (brand === 'qt  ') return nonRasterResult('video/quicktime')
        if (brand === 'M4A ' || brand === 'm4a ') return nonRasterResult('audio/mp4')
      }
      return nonRasterResult('video/mp4')
    }
    // QuickTime movie atom headers without ftyp: wide, moov, mdat, free, skip
    if (data.length >= 8 && data[4] !== undefined && data[5] !== undefined && data[6] !== undefined && data[7] !== undefined) {
      const atom = String.fromCharCode(data[4], data[5], data[6], data[7])
      if (atom === 'wide' || atom === 'moov' || atom === 'mdat' || atom === 'free' || atom === 'skip') {
        return nonRasterResult('video/quicktime')
      }
    }
  }
  return undefined
}

function carriesRetainedMetadata(metadata: Awaited<ReturnType<Sharp['metadata']>>): boolean {
  return metadata.exif !== undefined
    || metadata.xmp !== undefined
    || metadata.iptc !== undefined
    || metadata.icc !== undefined
    || metadata.hasProfile
    || metadata.tifftagPhotoshop !== undefined
    || metadata.comments !== undefined
    || metadata.orientation !== undefined
}

async function imageMetadata(image: Sharp): Promise<DetectedImage> {
  const metadata = await image.metadata()
  const mediaType = MEDIA_TYPES[metadata.format as string]
  if (mediaType === undefined) {
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE')
  }
  // EXIF orientations 5-8 transpose the stored raster; report the perceived
  // axes so limits, source facts, and coordinate advice all share them.
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5
  return {
    mediaType,
    width: transposed ? metadata.height : metadata.width,
    height: transposed ? metadata.width : metadata.height,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carriesRetainedMetadata(metadata),
    depth: metadata.depth,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
  }
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

/** Admission limits applied to a decoded raster's intrinsic dimensions. */
export interface DecodedImageLimits {
  /** Decoded-pixel (width times height) admission limit. */
  maxPixels?: number
  /** Per-side admission limit applied to width and height independently. */
  maxDimension?: number
}

/**
 * Fully decode a supported media and return its intrinsic metadata.
 * @param data - complete encoded image or document/audio bytes.
 * @param limits - intrinsic-dimension admission limits.
 * @returns verified format and dimensions.
 */
export async function detectImage(data: Uint8Array, limits?: DecodedImageLimits): Promise<DetectedImage> {
  const nonRaster = detectNonRasterMedia(data)
  if (nonRaster !== undefined) return nonRaster
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: false })
    const detected = await imageMetadata(image)
    if (limits?.maxPixels !== undefined && detected.width * detected.height > limits.maxPixels) {
      throw new AttachmentError('Image exceeds the configured decoded-pixel limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
    if (limits?.maxDimension !== undefined && Math.max(detected.width, detected.height) > limits.maxDimension) {
      throw new AttachmentError('Image exceeds the configured per-side pixel limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    await image.raw().toBuffer()
    return detected
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unsupported or malformed image data.', 'INVALID_IMAGE', { cause: error })
  }
}
