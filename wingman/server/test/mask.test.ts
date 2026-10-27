import { describe, expect, it } from 'vitest';
import { capText, maskSecrets, safeSummary } from '../src/mask.js';

const x = (n: number) => 'x'.repeat(n);
const b64 = (n: number) => 'A1b2'.repeat(n);

describe('maskSecrets', () => {
  it('masks bearer tokens', () => {
    const out = maskSecrets(`Authorization: Bearer ${b64(8)}.abc end`);
    expect(out).toContain('Bearer [MASKED]');
    expect(out).not.toContain(b64(8));
  });

  it('masks JWTs', () => {
    const jwt = ['eyJ' + b64(5), b64(6), b64(4)].join('.');
    const out = maskSecrets(`got ${jwt} here`);
    expect(out).toBe('got [MASKED] here');
  });

  it.each([
    ['anthropic', 'sk-ant-' + x(30)],
    ['openai', 'sk-' + x(30)],
    ['ghp', 'ghp_' + x(30)],
    ['github_pat', 'github_pat_' + x(30)],
    ['gitlab', 'glpat-' + x(25)],
    ['slack', 'xoxb-' + '1234567890-' + x(12)],
    ['aws', 'AKIA' + 'ABCDEFGH12345678'],
  ])('masks %s key shape', (_n, secret) => {
    const out = maskSecrets(`value ${secret} done`);
    expect(out).toBe('value [MASKED] done');
  });

  it('masks key=value, key: value and JSON assignments but keeps the key', () => {
    expect(maskSecrets('password=hunter2x')).toBe('password=[MASKED]');
    expect(maskSecrets('API_KEY: abc123def')).toBe('API_KEY: [MASKED]');
    expect(maskSecrets('{"token":"abc123","other":"ok"}')).toBe(
      '{"token":"[MASKED]","other":"ok"}',
    );
    expect(maskSecrets('my_secret = "two words"')).toBe('my_secret = "[MASKED]"');
    expect(maskSecrets('passwd:pw1; api-key=k1')).toBe('passwd:[MASKED]; api-key=[MASKED]');
  });

  it('masks URL credentials', () => {
    const out = maskSecrets('clone https://user:pw0rd@host.example/repo.git now');
    expect(out).toBe('clone https://[MASKED]@host.example/repo.git now');
  });

  it('masks token-only userinfo and passwords that contain @, :, or other characters', () => {
    const tok = 'ghp_' + x(30);
    expect(maskSecrets(`git clone https://${tok}@github.example/o/r.git`)).toBe(
      'git clone https://[MASKED]@github.example/o/r.git',
    );
    expect(maskSecrets('url postgres://admin:p@ss:w0rd!@db.example:5432/app ok')).toBe(
      'url postgres://[MASKED]@db.example:5432/app ok',
    );
    expect(maskSecrets('see https://host.example/path@notcreds and https://h.example:8080/x')).toBe(
      'see https://host.example/path@notcreds and https://h.example:8080/x',
    );
  });

  it('masks Authorization: Basic values and keeps the scheme', () => {
    const out = maskSecrets(`Authorization: Basic ${b64(6)}== then`);
    expect(out).toBe('Authorization: Basic [MASKED] then');
    expect(maskSecrets(`{"Authorization":"Basic ${b64(6)}"}`)).toBe(
      '{"Authorization":"Basic [MASKED]"}',
    );
  });

  it('masks auth, credential and private_key assignments, but not author', () => {
    expect(maskSecrets('auth=abc123')).toBe('auth=[MASKED]');
    expect(maskSecrets('x-auth: v1')).toBe('x-auth: [MASKED]');
    expect(maskSecrets('GOOGLE_CREDENTIALS=file1')).toBe('GOOGLE_CREDENTIALS=[MASKED]');
    expect(maskSecrets('credential: c1')).toBe('credential: [MASKED]');
    expect(maskSecrets('private_key: "k1"')).toBe('private_key: "[MASKED]"');
    expect(maskSecrets('privateKey=k2 PRIVATE-KEY=k3')).toBe(
      'privateKey=[MASKED] PRIVATE-KEY=[MASKED]',
    );
    expect(maskSecrets('author: Ada, authority=none, authored=yes')).toBe(
      'author: Ada, authority=none, authored=yes',
    );
  });

  it('masks PEM private key blocks', () => {
    const pem = `-----BEGIN ${'RSA '}PRIVATE KEY-----\n${b64(10)}\n${b64(10)}\n-----END ${'RSA '}PRIVATE KEY-----`;
    const out = maskSecrets(`before\n${pem}\nafter`);
    expect(out).toBe('before\n[MASKED]\nafter');
  });

  it('masks an unterminated PEM block to the end', () => {
    const out = maskSecrets(`-----BEGIN ${''}PRIVATE KEY-----\n${b64(10)}`);
    expect(out).toBe('[MASKED]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Updated src/foo.ts and ran 12 tests; token count unchanged';
    expect(maskSecrets(text)).toBe(text);
  });
});

describe('capText', () => {
  it('leaves short text alone', () => {
    expect(capText('abc', 10)).toBe('abc');
  });
  it('truncates and appends a marker', () => {
    expect(capText('abcdefghij', 4)).toBe('abcd… [truncated 6 chars]');
  });
});

describe('safeSummary', () => {
  it('masks before capping so a secret straddling the cap is not leaked', () => {
    const secret = 'sk-ant-' + x(30);
    const text = 'a'.repeat(94) + ' ' + secret + ' tail';
    const out = safeSummary(text, 110);
    expect(out).not.toContain('sk-ant');
    expect(out).not.toContain('xxxx');
    expect(out.startsWith('a'.repeat(94) + ' [MASKED]')).toBe(true);
  });

  it('would leak if capped first (control)', () => {
    const secret = 'sk-ant-' + x(30);
    const text = 'a'.repeat(94) + ' ' + secret;
    expect(maskSecrets(capText(text, 110))).toContain('sk-ant-xxxx');
  });

  it('caps at 4000 by default', () => {
    expect(safeSummary('z'.repeat(5000)).length).toBeLessThan(4100);
  });
});
