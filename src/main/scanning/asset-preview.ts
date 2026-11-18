import { lstatSync } from 'node:fs';
import { MAX_PREVIEW_BYTES, PREVIEW_SCHEME, previewTypeOf } from '@shared/assets';
import type { ProjectRegistry } from '../projects';
import { isSensitivePath, resolveInside } from '../security';

// What a preview request may reach (spec §17). The page asks for `gdcc-asset://preview/<project id>?p=<project-relative path>`; this
// decides whether the request names an image file inside a registered project, and nothing else. Every refusal is a plain "not
// found", so a request cannot be used to learn which paths exist outside the project.

export type PreviewTarget = { ok: true; fullPath: string; mime: string; bytes: number } | { ok: false; reason: string };

export function resolvePreview(requestUrl: string, projects: Pick<ProjectRegistry, 'get'>): PreviewTarget {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (url.protocol !== `${PREVIEW_SCHEME}:` || url.hostname !== 'preview') return { ok: false, reason: 'wrong scheme or host' };
  const projectId = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const rel = url.searchParams.get('p') ?? '';
  if (projectId === '' || rel === '' || rel.length > 400 || rel.includes('\0')) return { ok: false, reason: 'missing project or path' };
  const project = projects.get(projectId);
  if (project === undefined) return { ok: false, reason: 'not a registered project' };
  const mime = previewTypeOf(rel);
  if (mime === undefined) return { ok: false, reason: 'not a previewable image type' };
  if (isSensitivePath(rel)) return { ok: false, reason: 'sensitive name' };
  let fullPath: string;
  try {
    fullPath = resolveInside(project.rootPath, rel);
  } catch {
    return { ok: false, reason: 'outside the project' };
  }
  try {
    const stats = lstatSync(fullPath);
    if (!stats.isFile()) return { ok: false, reason: 'not a regular file' }; // lstat: a link is not a file
    if (stats.size > MAX_PREVIEW_BYTES) return { ok: false, reason: 'too large to preview' };
    return { ok: true, fullPath, mime, bytes: stats.size };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}
