export const MASK = '[MASKED]';

const PEM =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
// Greedy up to the last "@" before a "/" so a password that itself contains "@" is covered, and a
// token-only userinfo (https://<token>@host) is masked as well.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,39}:\/\/)[^\s/]+@/gi;
const AUTH_SCHEME =
  /(\bAuthorization["']?\s*[:=]\s*["']?)(Basic|Digest|Negotiate|NTLM)\s+[^\s"',;]+/gi;
// Starts only at the beginning of a base64url run (not at every "-" inside one), so a long run
// without a dot is scanned once instead of once per "eyJ" in it.
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];
// No key prefix in the pattern: it would be rescanned from every start of a long keyword-free run
// (quadratic), and the text before the keyword is kept as is anyway. The tail is bounded for the same
// reason. "auth" only as a whole word, so "author" and "Authorization" (handled above) are left alone.
const ASSIGNMENT =
  /((?:password|passwd|secret|token|api[_-]?key|credentials?|private[_-]?key|(?<![A-Za-z])auth(?![A-Za-z]))[A-Za-z0-9_.-]{0,128})(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}]+)/gi;

export function maskSecrets(text: string): string {
  let out = text.replace(PEM, MASK);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
  out = out.replace(AUTH_SCHEME, `$1$2 ${MASK}`);
  out = out.replace(JWT, MASK);
  out = out.replace(BEARER, `$1 ${MASK}`);
  for (const re of KEY_SHAPES) out = out.replace(re, MASK);
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string, value: string) => {
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    return `${key}${sep}${quote}${MASK}${quote}`;
  });
  return out;
}

export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/** Mask before capping: capping first could split a secret so that no pattern matches the remainder. */
export function safeSummary(text: string, max = 4000): string {
  return capText(maskSecrets(text), max);
}
