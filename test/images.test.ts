import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_BYTES,
  buildImageAttachment,
  sniffImageType,
  withImagePlaceholders,
} from '../src/lib/images'

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8, 1),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8, 1)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(8, 1)])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4, 0),
  Buffer.from('WEBPVP8 ', 'ascii'),
  Buffer.alloc(8, 1),
])

describe('sniffImageType', () => {
  it('names each supported format from its bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
  })

  it('refuses a RIFF that is not WebP, and anything else', () => {
    const wav = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVE', 'ascii')])
    expect(sniffImageType(wav)).toBeNull()
    expect(sniffImageType(Buffer.from('%PDF-1.4', 'ascii'))).toBeNull()
  })
})

describe('buildImageAttachment', () => {
  it('builds the inline request shape from a valid image', () => {
    expect(buildImageAttachment('shot.png', PNG)).toEqual({
      media_type: 'image/png',
      data: PNG.toString('base64'),
    })
  })

  it('rejects empty, oversized, and non-image files with the path named', () => {
    expect(() => buildImageAttachment('empty.png', Buffer.alloc(0))).toThrow(/empty\.png is empty/)
    expect(() => buildImageAttachment('big.png', Buffer.alloc(MAX_IMAGE_BYTES + 1, 1))).toThrow(
      /limit is 5 MiB/,
    )
    expect(() => buildImageAttachment('notes.txt', Buffer.from('hello'))).toThrow(
      /notes\.txt is not a PNG, JPEG, GIF, or WebP/,
    )
  })
})

describe('withImagePlaceholders', () => {
  it('appends one [Image #N] per image, the way the server stores the body', () => {
    expect(withImagePlaceholders('fix it', 0)).toBe('fix it')
    expect(withImagePlaceholders('fix it', 2)).toBe('fix it\n\n[Image #1] [Image #2]')
    expect(withImagePlaceholders('', 1)).toBe('[Image #1]')
  })
})
