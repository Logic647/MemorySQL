import { describe, expect, it } from 'vitest'
import { redactWithCount } from '../src/main/core/redact'

describe('redact (出口脱敏)', () => {
  it('redacts provider API keys', () => {
    const r = redactWithCount('key is sk-abc123def456ghi789jk end')
    expect(r.text).toContain('[REDACTED:api-key]')
    expect(r.text).not.toContain('sk-abc123')
    expect(r.hits).toBe(1)
  })

  it('redacts keyword=value credentials', () => {
    const r = redactWithCount("s.connect('1.2.3.4', password='Logic647')")
    expect(r.text).toContain("[REDACTED:credential]")
    expect(r.text).not.toContain('Logic647')
  })

  it('redacts user:pass@host URLs entirely', () => {
    const r = redactWithCount('ssh://root:s3cret@10.0.0.1/x')
    expect(r.text).toContain('[REDACTED-credentials]@')
    expect(r.text).not.toContain('s3cret')
  })

  it('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----'
    const r = redactWithCount(`before ${pem} after`)
    expect(r.text).toContain('[REDACTED:private-key]')
    expect(r.text).not.toContain('MIIEowIBAAKCAQEA')
  })

  it('redacts JWTs and AWS keys', () => {
    const r = redactWithCount(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c and AKIAIOSFODNN7EXAMPLE'
    )
    expect(r.text).toContain('[REDACTED:jwt]')
    expect(r.text).toContain('[REDACTED:aws-key]')
  })

  it('does not touch normal prose or token counts', () => {
    const text = 'the token count is 4096 and password policy requires 12 chars minimum'
    const r = redactWithCount(text)
    expect(r.text).toBe(text)
    expect(r.hits).toBe(0)
  })
})
