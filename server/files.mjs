// Serves one file of a session's folder to the FILES viewer. Trust boundary: nothing outside cwd.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, extname } from 'node:path';

export const MAX_BYTES = 50 * 1024 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };

/* -> { file, size, type } or throws Error with .status (400 refused, 404 missing, 413 too big). */
export function resolveInside(cwd, rel) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!rel || typeof rel !== 'string' || rel.includes('\0') || isAbsolute(rel)) throw fail(400, 'bad path');
  let root, file;
  try { root = realpathSync(cwd); } catch { throw fail(404, 'no such folder'); }
  try { file = realpathSync(resolve(root, rel)); } catch { throw fail(404, 'not found'); }   // realpath follows symlinks
  const r = relative(root, file);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw fail(400, 'outside the session folder');
  const st = statSync(file);
  if (!st.isFile()) throw fail(404, 'not a file');
  if (st.size > MAX_BYTES) throw fail(413, 'file too large (50 MB max)');
  const ext = extname(file).slice(1).toLowerCase();
  /* svg can carry script: the route adds a CSP sandbox; everything unknown is plain text. */
  return { file, size: st.size, type: TYPES[ext] || 'text/plain; charset=utf-8' };
}

/* A picture or media file an agent named in its answer, wherever it saved it (its own cache, /tmp).
   Served only when: an absolute path, a media type (no svg: it can carry script), and that exact
   path appears in this session's own messages. -> { file, size, type } or throws like resolveInside. */
const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' };
export function mentionedMedia(path, texts) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!path || typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) throw fail(400, 'bad path');
  const type = MEDIA[extname(path).slice(1).toLowerCase()];
  if (!type) throw fail(400, 'only pictures, pdf, audio and video');
  const norm = (s) => String(s).replace(/\\+/g, '/').toLowerCase();   // C:\a, C:\\a (JSON) and C:/a are one path
  const want = norm(path);
  if (!texts.some((t) => norm(t).includes(want))) throw fail(403, 'the agent did not name this file in this session');
  let file;
  try { file = realpathSync(path); } catch { throw fail(404, 'not found'); }
  const st = statSync(file);
  if (!st.isFile()) throw fail(404, 'not a file');
  if (st.size > MAX_BYTES) throw fail(413, 'file too large (50 MB max)');
  return { file, size: st.size, type };
}
