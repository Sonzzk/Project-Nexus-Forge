// Secret redaction shared by the logger, the activity log and (later) previews, context packs and session output.
// Patterns and rules: ARCHITECTURE.md section 7, "Path policy and sensitive files".

export interface Redactor {
  /** Replaces secret patterns and shows the home folder as `~`. */
  redact(text: string): string;
  /** Deep copy with redacted strings, and the string values of secret-named keys replaced. */
  redactValue<T>(value: T): T;
}

const REDACTED = '[redacted]';
const SECRET_NAME = String.raw`(?:pass(?:word|wd|phrase)|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|session[_-]?id)`;
const SECRET_KEY = new RegExp(SECRET_NAME, 'i');

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted private key]',
  ],
  // URLs with embedded credentials: https://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+(?::[^\s/@]*)?@/gi, `$1${REDACTED}@`],
  // Authorization: Bearer <token>, and a bare "Bearer <token>"
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/g, `Basic ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Common token formats
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // key=value, key: value and "key": "value" where the key names a secret
  [
    new RegExp(
      String.raw`(["']?[\w.-]*${SECRET_NAME}[\w.-]*["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&"'}\]]+)`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

export function createRedactor(options: { homeDir?: string } = {}): Redactor {
  const home = options.homeDir?.replace(/[\\/]+$/, '');
  const homePattern =
    home === undefined || home === ''
      ? undefined
      : new RegExp(escapeRegExp(home).replace(/\\\\|\//g, '[\\\\/]') + '(?![\\w-])', 'gi');

  const redact = (text: string): string => {
    let result = text;
    for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
    return homePattern === undefined ? result : result.replace(homePattern, '~');
  };

  const redactValue = <T>(value: T, seen: WeakSet<object> = new WeakSet()): T => {
    if (typeof value === 'string') return redact(value) as T;
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]' as T;
    seen.add(value);
    if (value instanceof Error) return redactError(value, seen) as T;
    if (Array.isArray(value)) return value.map((item) => redactValue(item as unknown, seen)) as T;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = typeof item === 'string' && SECRET_KEY.test(key) ? REDACTED : redactValue(item, seen);
    }
    return copy as T;
  };

  const redactError = (error: Error, seen: WeakSet<object>): Record<string, unknown> => ({
    name: error.name,
    message: redact(error.message),
    ...(error.stack === undefined ? {} : { stack: redact(error.stack) }),
    ...(error.cause === undefined ? {} : { cause: redactValue(error.cause, seen) }),
  });

  return { redact, redactValue: (value) => redactValue(value) };
}
