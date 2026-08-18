/**
 * The model-facing `read_multimodal` tool: reads PDF documents, audio, and video files,
 * commits their bytes through the attachment service, and returns a multimodal content block.
 *
 * Excludes images (which use `read_image`) and plain text (which uses `read`).
 * Strictly rejects binary archives/executables (ZIP/DMG/TAR/etc.).
 * @module @deepseek-ai/dsh-tool-fs/src/read-multimodal
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveRegularReadTarget } from './read-target.ts'

/** Non-image multimodal extensions accepted by `read_multimodal`. */
const MULTIMODAL_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.pdf': 'application/pdf',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/** Binary archives and executables that should be rejected immediately. */
const REJECTED_BINARY_EXTENSIONS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.dmg', '.pkg', '.iso', '.bin', '.exe', '.dll', '.so', '.dylib',
])

/** Canonical outcome for `read_multimodal`. */
export interface MultimodalReadValue {
  path: string
  media: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    name?: string
  }
}

/**
 * Map a path to its declared media type by extension.
 */
export function multimodalMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return MULTIMODAL_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Format multimodal read output.
 */
export function formatMultimodalReadOutput(displayPath: string, media: MultimodalReadValue['media']): string {
  return `<path>${displayPath}</path>
<type>multimodal</type>
<content>
${media.mediaType} document/media, ${media.bytes} bytes
</content>`
}

/**
 * Project canonical multimodal read into content blocks.
 */
export function multimodalReadContent(value: MultimodalReadValue): ContentBlock[] {
  const ref: ImageAttachmentRef = {
    attachmentId: AttachmentId(value.media.attachmentId),
    mediaType: value.media.mediaType,
    bytes: value.media.bytes,
    width: 0,
    height: 0,
    ...value.media.name === undefined ? {} : { name: value.media.name },
  }
  return [
    { type: 'text', text: formatMultimodalReadOutput(value.path, value.media) },
    { type: 'image', attachment: ref },
  ]
}

/**
 * Register the `read_multimodal` tool into context.
 */
export function applyReadMultimodalTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_multimodal',
    description: 'Read a document (PDF), audio (WAV/OGG/MP3/M4A/FLAC), or video (MP4/WebM/MOV) and return its content block for multimodal understanding. Binary archives (ZIP/DMG/TAR) are not supported.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the document, audio, or video file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          media: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => multimodalReadContent(value as MultimodalReadValue),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolExecution) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      const ext = extname(args.file_path).toLowerCase()
      if (REJECTED_BINARY_EXTENSIONS.has(ext)) {
        throw new Error(`cannot read "${args.file_path}": binary archives and executables (${ext}) cannot be parsed by multimodal models. Use shell tools to inspect or extract.`)
      }

      const mediaType = multimodalMediaTypeForPath(args.file_path)
      if (mediaType === undefined) {
        throw new Error(`cannot read "${args.file_path}": read_multimodal only accepts PDF, audio (WAV/OGG/MP3/M4A/FLAC), and video (MP4/WebM/MOV) files. For images use read_image; for text use read.`)
      }

      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot read "${args.file_path}" as multimodal: no attachment service is mounted`)
      }

      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)
      const byteCap = attachments.imageLimits.maxMessageImageBytes || 100 * 1024 * 1024
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)

      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError) || error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        throw new Error(
          `cannot read "${target.displayPath}": file header does not match expected ${mediaType} format.`,
          { cause: error },
        )
      }

      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const value: MultimodalReadValue = {
        path: target.displayPath,
        media: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      return value
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read multimodal ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
