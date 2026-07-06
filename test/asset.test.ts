import { describe, expect, it } from 'vitest'
import {
  MAX_ASSET_SIZE_BYTES,
  buildUploadRequest,
  formatSize,
} from '../src/commands/asset'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngBytes(extra = 8): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 1)])
}

describe('buildUploadRequest', () => {
  it('builds the request from a valid PNG', () => {
    const bytes = pngBytes()
    expect(buildUploadRequest('/tmp/shots/settings.png', bytes)).toEqual({
      filename: 'settings.png',
      content_type: 'image/png',
      data_b64: bytes.toString('base64'),
    })
  })

  it('uses the basename, never the full path', () => {
    const req = buildUploadRequest('../deep/nested/shot.png', pngBytes())
    expect(req.filename).toBe('shot.png')
  })

  it('rejects an empty file', () => {
    expect(() => buildUploadRequest('empty.png', Buffer.alloc(0))).toThrow(/is empty/)
  })

  it('rejects files over the 10 MiB cap, with sizes in the message', () => {
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_ASSET_SIZE_BYTES)])
    expect(() => buildUploadRequest('big.png', big)).toThrow(/10\.0 MiB per asset/)
  })

  it('accepts a PNG exactly at the cap', () => {
    const atCap = Buffer.concat([
      PNG_MAGIC,
      Buffer.alloc(MAX_ASSET_SIZE_BYTES - PNG_MAGIC.length),
    ])
    expect(buildUploadRequest('cap.png', atCap).content_type).toBe('image/png')
  })

  it('names the format when the bytes look like a known non-PNG', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(() => buildUploadRequest('shot.png', jpeg)).toThrow(/looks like JPEG/)

    const gif = Buffer.from('GIF89a-------', 'ascii')
    expect(() => buildUploadRequest('shot.png', gif)).toThrow(/looks like GIF/)

    const webp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'ascii'),
      Buffer.alloc(4),
    ])
    expect(() => buildUploadRequest('shot.png', webp)).toThrow(/looks like WebP/)
  })

  it('falls back to a generic message for unrecognized bytes', () => {
    expect(() => buildUploadRequest('shot.png', Buffer.from('hello world'))).toThrow(
      /bytes are not a PNG/,
    )
  })

  it('rejects a truncated PNG magic', () => {
    expect(() => buildUploadRequest('shot.png', PNG_MAGIC.subarray(0, 4))).toThrow(
      /not a PNG/,
    )
  })
})

describe('formatSize', () => {
  it('renders bytes, KiB, and MiB', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KiB')
    expect(formatSize(10 * 1024 * 1024)).toBe('10.0 MiB')
  })

  it('uses binary units at the boundaries', () => {
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KiB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MiB')
  })
})
