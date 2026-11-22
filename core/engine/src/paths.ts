import * as path from 'node:path';

export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

const PROTECTED_DIRS = new Set(['.git', '.proofpatch']);

/** Convert user/agent supplied path into a normalised, workspace-relative POSIX path. Throws if outside. */
export function normalizeRel(root: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new EngineError('BAD_PATH', 'Path must be a non-empty string');
  }
  if (input.includes('\0')) throw new EngineError('BAD_PATH', 'Path contains a NUL byte');
  let p = input;
  if (path.isAbsolute(input)) p = path.relative(root, input);
  p = p.replace(/\\/g, '/');
  p = path.posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '.' || p === '' || p === '..' || p.startsWith('../') || path.posix.isAbsolute(p)) {
    throw new EngineError('PATH_OUTSIDE_WORKSPACE', `Path is outside the workspace: ${input}`);
  }
  return p;
}

export function toAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/** .git and ProofPatch's own state may never be written by the engine. */
export function isProtectedPath(rel: string): boolean {
  return rel.split('/').some((seg) => PROTECTED_DIRS.has(seg));
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.(npmrc|pypirc|netrc|pgpass)$/,
  /(^|\/)credentials(\.(json|ya?ml|ini))?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini)$/i
];

/** Heuristic: files that should stay out of model context and agent edits by default. */
export function isSecretPath(rel: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(rel));
}

/** Small glob -> RegExp (supports **, *, ?). Matches against POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
