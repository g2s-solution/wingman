import { z } from 'zod';

const SUGGEST_DISTANCE = 2;

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

/** Closest known key: a near spelling, or a known key contained in the unknown one ("result_offset" → "offset"). */
export function closestKey(unknown: string, known: readonly string[]): string | undefined {
  const contained = known
    .filter((k) => k.length >= 3 && unknown.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (contained !== undefined) return contained;
  let best: string | undefined;
  let bestDistance = SUGGEST_DISTANCE + 1;
  for (const k of known) {
    const d = distance(unknown, k);
    if (d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

export function unknownParameterMessage(
  tool: string,
  keys: readonly string[],
  known: readonly string[],
): string {
  return keys
    .map((key) => {
      const guess = closestKey(key, known);
      const shown = JSON.stringify(key.slice(0, 60));
      return `unknown parameter ${shown} for ${tool}${guess === undefined ? '' : ` (did you mean "${guess}"?)`}`;
    })
    .join('; ');
}

/** Input schema that rejects unknown keys with a message naming the key (the SDK would silently drop them). */
export function strictInput<S extends z.ZodRawShape>(tool: string, shape: S) {
  const known = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? unknownParameterMessage(tool, issue.keys, known)
        : undefined,
  });
}
