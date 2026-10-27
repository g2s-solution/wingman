import { describe, expect, it } from 'vitest';
import { TERMINAL_STATUSES } from '../src/types.js';

describe('TERMINAL_STATUSES', () => {
  it('contains every status except running', () => {
    expect(TERMINAL_STATUSES).not.toContain('running');
    expect(TERMINAL_STATUSES).toHaveLength(9);
    expect(new Set(TERMINAL_STATUSES).size).toBe(9);
  });
});
