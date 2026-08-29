/**
 * Outbound (出口) redaction. The ONLY place secrets get scrubbed — local UI
 * and MCP always show raw data; anything leaving the machine (exported MD,
 * shared summaries, future publish) must pass through redact() first.
 */
type Replacement = string | ((match: string) => string)

const RULES: Array<[RegExp, Replacement]> = [
  // PEM private keys (full block)
  [/-{3,}\s*BEGIN [A-Z ]*PRIVATE KEY-{3,}[\s\S]*?-{3,}\s*END [A-Z ]*PRIVATE KEY-{3,}/g, '[REDACTED:private-key]'],
  // provider API keys
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]'],
  // keyword = value credentials (password=, token:, api_key= …)
  [
    /\b(?:password|passwd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token)\b\s*[=:：]\s*["']?([^\s"'`,;)\]}]+)/gi,
    (m) => `${m.slice(0, m.search(/[=:：]/) + 1)} [REDACTED:credential]`
  ],
  // user:pass@host in URLs
  [/(?:https?|ssh|ftp):\/\/([^/\s:@]+):([^@\s]+)@/g, '[REDACTED-credentials]@']
]

export interface RedactResult {
  text: string
  /** number of replacements applied */
  hits: number
}

export function redactWithCount(input: string): RedactResult {
  let text = input
  let hits = 0
  for (const [re, replacement] of RULES) {
    text = text.replace(re, (match: string) => {
      hits++
      if (typeof replacement === 'string') return replacement
      return replacement(match)
    })
  }
  return { text, hits }
}

export function redact(input: string): string {
  return redactWithCount(input).text
}
