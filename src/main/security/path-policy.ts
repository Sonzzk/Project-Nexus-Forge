import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { AppError } from '@shared/errors';

// Every read inside a project goes through here (ARCHITECTURE.md section 7): a project-relative path is resolved against the
// registered root, links and junctions are followed for the check, and anything that lands outside the root is refused.

const outside = (relativePath: string): AppError =>
  new AppError('PATH_OUTSIDE_PROJECT', 'That path is not inside the project folder.', {
    hint: 'Only files of the registered project can be used.',
    details: { relativePath: relativePath.slice(0, 200) },
  });

const sameOrInside = (root: string, target: string): boolean => {
  const fromRoot = relative(root.toLowerCase(), target.toLowerCase());
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
};

/** The real path of the nearest part of `target` that exists, with the rest appended unchanged. */
function realWithMissingTail(target: string): string {
  const missing: string[] = [];
  let current = target;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

/** Resolves `relativePath` inside `root`. Throws PATH_OUTSIDE_PROJECT for `..`, absolute, UNC, device and drive-relative paths, and for links that leave the root. */
export function resolveInside(root: string, relativePath: string): string {
  if (relativePath.includes('\0') || isAbsolute(relativePath) || /^[\\/]{2}/.test(relativePath) || /^[a-zA-Z]:/.test(relativePath) || relativePath.startsWith('\\\\?\\') || relativePath.startsWith('\\\\.\\'))
    throw outside(relativePath);
  const realRoot = realpathSync(resolve(root));
  const candidate = resolve(realRoot, relativePath);
  if (!sameOrInside(realRoot, candidate)) throw outside(relativePath);
  const real = realWithMissingTail(candidate);
  if (!sameOrInside(realRoot, real)) throw outside(relativePath);
  return real;
}
