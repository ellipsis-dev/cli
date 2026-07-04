// Client-side redaction for laptop transcript sync (LOCAL_CLAUDE_CODE.md
// §7.1): secrets never leave the laptop unredacted. This runs over the raw
// transcript JSONL text BEFORE gzip/upload, replacing recognizable credential
// material with a marker. Pattern-based, so it is best-effort by construction —
// the point is that the obvious, high-value token shapes (cloud keys, VCS
// tokens, private key blocks, Authorization headers) never reach the server.

const REDACTED = '[REDACTED]'

// Order matters only for overlapping matches (first pattern wins the range);
// each pattern is applied globally to every line.
const SECRET_PATTERNS: RegExp[] = [
  // Private key blocks (PEM), including ones embedded in JSON strings with
  // literal \n escapes.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // GitHub tokens: classic + fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS access key ids (secret keys are unprefixed 40-char base64 — too
  // ambiguous to match without the id, which we do catch).
  /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  // Anthropic / OpenAI / Stripe-style "sk-" keys (covers sk-ant-…, sk-proj-…).
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Slack tokens.
  /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/g,
  // GitLab personal access tokens.
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // npm automation tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // JWTs (three dot-separated base64url segments with the JOSE header prefix).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Authorization headers wherever they appear in tool output.
  /\b(Authorization|authorization)(["']?\s*[:=]\s*["']?)(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]+/g,
]

export function redactLine(line: string): string {
  let out = line
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // The Authorization pattern keeps the header name + scheme so the
      // transcript stays readable; everything else is replaced wholesale.
      if (typeof groups[0] === 'string' && /^authorization$/i.test(groups[0])) {
        return `${groups[0]}${groups[1]}${groups[2]} ${REDACTED}`
      }
      return REDACTED
    })
  }
  return out
}

export function redactTranscript(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? redactLine(line) : line))
    .join('\n')
}
