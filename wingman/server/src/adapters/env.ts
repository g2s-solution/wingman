/** Parent environment variables a delegated run may see; everything else (tokens, API keys) is dropped. */
const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'TERM',
  'SHELL',
  'TMPDIR',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]);

export function allowlistedEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (ALLOWED_ENV.has(name) || name.startsWith('LC_')) env[name] = value;
  }
  return env;
}
