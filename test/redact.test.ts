import { describe, expect, it } from 'vitest'
import { redactLine, redactTranscript } from '../src/lib/redact'

describe('redactLine', () => {
  it('redacts GitHub tokens', () => {
    const line = 'set GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 done'
    expect(redactLine(line)).toBe('set GH_TOKEN=[REDACTED] done')
    expect(
      redactLine('github_pat_11ABCDEFG0abcdefghijklmnopqrstuv'),
    ).toBe('[REDACTED]')
  })

  it('redacts AWS access key ids and sk- keys', () => {
    expect(redactLine('key AKIAIOSFODNN7EXAMPLE end')).toBe('key [REDACTED] end')
    expect(redactLine('sk-ant-api03-averyveryverylongkeyvalue')).toBe('[REDACTED]')
  })

  it('redacts Authorization headers but keeps the scheme', () => {
    expect(redactLine('"Authorization": "Bearer abc.def-ghi"')).toContain(
      'Bearer [REDACTED]',
    )
  })

  it('redacts PEM private key blocks including JSON-escaped ones', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIEow…\\n-----END RSA PRIVATE KEY-----'
    expect(redactLine(pem)).toBe('[REDACTED]')
  })

  it('redacts JWTs', () => {
    expect(
      redactLine(
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-abcDEF123',
      ),
    ).toBe('[REDACTED]')
  })

  it('leaves ordinary text alone', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'
    expect(redactLine(line)).toBe(line)
  })
})

describe('redactTranscript', () => {
  it('redacts per line and preserves line structure', () => {
    const text = 'a\nxoxb-123456789012-abcdefghijkl\nb'
    expect(redactTranscript(text)).toBe('a\n[REDACTED]\nb')
  })
})
