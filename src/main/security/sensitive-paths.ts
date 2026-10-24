// Denylist of files that must never be read into a preview, a context pack or a prompt (ARCHITECTURE.md section 7).
// Later steps (scanner, context packs, PathPolicy) reuse isSensitivePath; a denied file can't be added even by hand.

const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.pfx', '.p12', '.kdbx', '.keystore'];
const SENSITIVE_NAMES = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials']);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.azure']);
const SENSITIVE_SUFFIXES = ['.docker/config.json', '.claude/.credentials.json', '.codex/auth.json'];

/** True if the project-relative (or absolute) path names a file that may hold credentials. Case-insensitive; either slash. */
export function isSensitivePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter((segment) => segment !== '');
  const name = segments.at(-1);
  if (name === undefined) return false;

  if (name === '.env' || name.startsWith('.env.')) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  if (SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (/^id_(rsa|ecdsa|ed25519)/.test(name)) return true;
  if (/^credentials.*\.json$/.test(name)) return true;
  if (name.includes('secret') || name.includes('password')) return true;
  if (segments.slice(0, -1).some((segment) => SENSITIVE_DIRECTORIES.has(segment))) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`/${suffix}`));
}
