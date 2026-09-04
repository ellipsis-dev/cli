import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { ImageAttachment } from './types'

// Images on a message — the Claude Code paste model. `agent session start
// --image shot.png` and the connect composer's `/image shot.png` read the
// file here, and it rides the request inline (base64) as `images`; the server
// appends one `[Image #N]` placeholder per image to the message body and the
// model sees the picture as a content block on the turn that message opens.
//
// Client-side mirrors of the server limits (session_message_image.py), so a
// wrong file fails fast with a clear message instead of a base64-inflated
// round trip to a 400. The server re-validates; these are UX, not enforcement.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 10

type ImageMediaType = ImageAttachment['media_type']

// What the bytes prove themselves to be; the extension is never consulted.
export function sniffImageType(bytes: Buffer): ImageMediaType | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  const head6 = bytes.subarray(0, 6).toString('ascii')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return null
}

// One attachment from a file's bytes, throwing the fast client-side errors
// (empty, oversized, not an image we take). Exported for tests.
export function buildImageAttachment(path: string, bytes: Buffer): ImageAttachment {
  if (bytes.length === 0) throw new Error(`${path} is empty`)
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `${path} is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB; the limit is 5 MiB per image`,
    )
  }
  const media_type = sniffImageType(bytes)
  if (media_type === null) {
    throw new Error(`${path} is not a PNG, JPEG, GIF, or WebP image`)
  }
  return { media_type, data: bytes.toString('base64') }
}

export type StagedImage = { name: string; attachment: ImageAttachment }

export function readImageAttachment(path: string): StagedImage {
  return { name: basename(path), attachment: buildImageAttachment(path, readFileSync(path)) }
}

// The `[Image #N]` placeholders the server appends to the stored body, mirrored
// here so a local echo reads exactly like the row that replaces it.
export function withImagePlaceholders(text: string, count: number): string {
  if (count === 0) return text
  const placeholders = Array.from({ length: count }, (_, i) => `[Image #${i + 1}]`).join(' ')
  return text ? `${text}\n\n${placeholders}` : placeholders
}
