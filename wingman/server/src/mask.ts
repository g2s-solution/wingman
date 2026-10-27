export const MASK = '[MASKED]';

const PEM =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
];
const ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}]+)/gi;

export function maskSecrets(text: string): string {
  let out = text.replace(PEM, MASK);
  out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
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
