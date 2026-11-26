'use strict';

/**
 * Reading the screenshot an agent attaches to a browser plan.
 *
 * The browser tool saves one with computer {action: "screenshot",
 * save_to_disk: true} into <tmpdir>/claude-chrome-screenshots-<id>/. The
 * agent only hands polpo the path, so polpo checks it is exactly such a
 * file before showing it to the operator: anything else on the machine
 * (a key, a document) must never be relayed as "the screenshot".
 *
 *   - the folder is a direct child of the temp dir, named
 *     claude-chrome-screenshots-<id>, not a link, owned by polpo's user and
 *     not writable by anyone else (/tmp is shared: another local user
 *     could otherwise plant an image there)
 *   - the file is named screenshot-<n>-<n>.jpg or .png, is a regular file
 *     and not a link, owned by polpo's user, at most maxBytes
 *   - its first bytes are a JPEG or PNG signature matching the extension
 *
 * The bytes are read once, through a descriptor opened without following
 * links, and kept in memory: what the operator is shown cannot be swapped
 * after the check.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_RE = /^claude-chrome-screenshots-[A-Za-z0-9_-]{1,64}$/;
const FILE_RE = /^screenshot-[0-9]{1,20}-[0-9]{1,6}\.(jpg|jpeg|png)$/;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_BYTES_CEILING = 20 * 1024 * 1024;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(error, message) {
  return { ok: false, error, message };
}

/** POLPO_BROWSER_SCREENSHOT_MAX_BYTES, checked; a bad value stops polpo. */
function parseMaxBytes(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_MAX_BYTES;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > MAX_BYTES_CEILING) {
    throw new Error('POLPO_BROWSER_SCREENSHOT_MAX_BYTES must be a whole number from 1024 to ' + MAX_BYTES_CEILING + '.');
  }
  return n;
}

/**
 * @param {string} p - the path the agent gave
 * @param {object} [opts] - { maxBytes, tmpdir, uid }
 * @returns {{ok: true, buffer: Buffer, mime: string} | {ok: false, error: string, message: string}}
 */
function readScreenshot(p, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) {
    return fail('invalid_screenshot_path', 'screenshotPath must be the absolute path the screenshot tool reported.');
  }
  const resolved = path.resolve(p);
  const name = path.basename(resolved);
  const dir = path.dirname(resolved);
  if (!FILE_RE.test(name) || !DIR_RE.test(path.basename(dir))) {
    return fail('invalid_screenshot_path', 'screenshotPath must be a screenshot saved by computer {action: "screenshot", save_to_disk: true}.');
  }

  let tmpReal;
  try { tmpReal = fs.realpathSync(o.tmpdir || os.tmpdir()); } catch { return fail('screenshot_unreadable', 'The temp folder cannot be read.'); }
  let dirStat;
  try { dirStat = fs.lstatSync(dir); } catch { return fail('screenshot_not_found', 'No screenshot at that path.'); }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return fail('invalid_screenshot_path', 'The screenshot folder must not be a link.');
  let dirReal;
  try { dirReal = fs.realpathSync(dir); } catch { return fail('screenshot_not_found', 'No screenshot at that path.'); }
  if (path.dirname(dirReal) !== tmpReal) {
    return fail('invalid_screenshot_path', 'The screenshot must be in the temp folder the browser tool saves to.');
  }
  if (uid !== null && dirStat.uid !== uid) return fail('invalid_screenshot_path', 'The screenshot folder belongs to another user.');
  if ((dirStat.mode & 0o022) !== 0) return fail('invalid_screenshot_path', 'The screenshot folder is writable by other users.');

  let st;
  try { st = fs.lstatSync(resolved); } catch { return fail('screenshot_not_found', 'No screenshot at that path.'); }
  if (st.isSymbolicLink() || !st.isFile()) return fail('invalid_screenshot_path', 'The screenshot must be a regular file, not a link.');
  if (uid !== null && st.uid !== uid) return fail('invalid_screenshot_path', 'The screenshot belongs to another user.');
  if (st.size > maxBytes) return fail('screenshot_too_large', 'The screenshot is larger than ' + maxBytes + ' bytes.');
  if (st.size < 16) return fail('invalid_screenshot', 'The file is too small to be a screenshot.');

  let fd;
  let buffer;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const fst = fs.fstatSync(fd);
    // The file opened is the one checked above, not a replacement.
    if (fst.ino !== st.ino || fst.dev !== st.dev || !fst.isFile() || fst.size > maxBytes) {
      return fail('invalid_screenshot_path', 'The screenshot changed while polpo read it.');
    }
    buffer = Buffer.alloc(fst.size);
    let off = 0;
    while (off < fst.size) {
      const n = fs.readSync(fd, buffer, off, fst.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    buffer = buffer.subarray(0, off);
  } catch {
    return fail('screenshot_unreadable', 'The screenshot cannot be read.');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  const ext = path.extname(name).toLowerCase();
  const isPng = buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
  const isJpeg = buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
  if (ext === '.png' && isPng) return { ok: true, buffer, mime: 'image/png' };
  if ((ext === '.jpg' || ext === '.jpeg') && isJpeg) return { ok: true, buffer, mime: 'image/jpeg' };
  return fail('invalid_screenshot', 'The file is not a JPEG or PNG image matching its name.');
}

module.exports = { readScreenshot, parseMaxBytes, DEFAULT_MAX_BYTES };
