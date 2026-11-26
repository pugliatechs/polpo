'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readScreenshot, parseMaxBytes } = require('../src/server/browser-screenshot');
const { parseTabContext, resultText } = require('../src/agent/tab-context');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);

describe('readScreenshot', () => {
  // A private stand-in for the temp dir, laid out as the browser tool does.
  let tmp, shots;
  const opts = () => ({ tmpdir: tmp });
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polpo-shot-'));
    shots = path.join(tmp, 'claude-chrome-screenshots-AbC123');
    fs.mkdirSync(shots, { mode: 0o700 });
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const put = (name, data, dir) => {
    const p = path.join(dir || shots, name);
    fs.writeFileSync(p, data);
    return p;
  };

  it('reads a JPEG and a PNG saved by the browser tool', () => {
    const j = readScreenshot(put('screenshot-1795705450960-0.jpg', JPEG), opts());
    assert.equal(j.ok, true);
    assert.equal(j.mime, 'image/jpeg');
    assert.deepEqual(j.buffer, JPEG);
    const p = readScreenshot(put('screenshot-1-2.png', PNG), opts());
    assert.equal(p.mime, 'image/png');
  });

  it('refuses a relative path, a traversal, and names the tool never writes', () => {
    put('screenshot-1-0.jpg', JPEG);
    assert.equal(readScreenshot('claude-chrome-screenshots-AbC123/screenshot-1-0.jpg', opts()).ok, false);
    assert.equal(readScreenshot(path.join(shots, '..', '..', 'etc', 'passwd'), opts()).ok, false);
    assert.equal(readScreenshot(put('id_rsa', JPEG), opts()).ok, false);
    assert.equal(readScreenshot(put('screenshot-1-0.gif', JPEG), opts()).ok, false);
    assert.equal(readScreenshot(path.join(shots, 'screenshot-1-0.jpg\0x'), opts()).ok, false);
    assert.equal(readScreenshot(42, opts()).ok, false);
  });

  it('refuses a folder that is not a direct child of the temp dir', () => {
    const nested = path.join(tmp, 'deeper', 'claude-chrome-screenshots-xyz');
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    const r = readScreenshot(put('screenshot-1-0.jpg', JPEG, nested), opts());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_screenshot_path');
  });

  it('refuses a folder named otherwise', () => {
    const other = path.join(tmp, 'screenshots-AbC');
    fs.mkdirSync(other, { mode: 0o700 });
    assert.equal(readScreenshot(put('screenshot-1-0.jpg', JPEG, other), opts()).ok, false);
  });

  it('refuses a symlinked file and a symlinked folder', () => {
    const secret = path.join(tmp, 'secret.jpg');
    fs.writeFileSync(secret, JPEG);
    const link = path.join(shots, 'screenshot-9-0.jpg');
    fs.symlinkSync(secret, link);
    assert.equal(readScreenshot(link, opts()).error, 'invalid_screenshot_path');

    const realDir = path.join(tmp, 'real');
    fs.mkdirSync(realDir, { mode: 0o700 });
    put('screenshot-1-0.jpg', JPEG, realDir);
    const linkDir = path.join(tmp, 'claude-chrome-screenshots-link');
    fs.symlinkSync(realDir, linkDir);
    assert.equal(readScreenshot(path.join(linkDir, 'screenshot-1-0.jpg'), opts()).error, 'invalid_screenshot_path');
  });

  it('refuses a folder others can write to, and files owned by another user', () => {
    const p = put('screenshot-1-0.jpg', JPEG);
    fs.chmodSync(shots, 0o777);
    assert.match(readScreenshot(p, opts()).message, /writable by other users/);
    fs.chmodSync(shots, 0o700);
    assert.match(readScreenshot(p, Object.assign(opts(), { uid: process.getuid() + 1 })).message, /another user/);
  });

  it('refuses a file too large, too small, or whose bytes do not match its name', () => {
    assert.equal(readScreenshot(put('screenshot-1-0.jpg', Buffer.concat([JPEG, Buffer.alloc(5000)])), Object.assign(opts(), { maxBytes: 2048 })).error,
      'screenshot_too_large');
    assert.equal(readScreenshot(put('screenshot-2-0.jpg', Buffer.from([0xff, 0xd8])), opts()).ok, false);
    assert.equal(readScreenshot(put('screenshot-3-0.jpg', PNG), opts()).error, 'invalid_screenshot');
    assert.equal(readScreenshot(put('screenshot-4-0.png', Buffer.from('%PDF-1.7 not an image at all')), opts()).error, 'invalid_screenshot');
  });

  it('reports a missing file', () => {
    assert.equal(readScreenshot(path.join(shots, 'screenshot-1-0.jpg'), opts()).error, 'screenshot_not_found');
  });
});

describe('parseMaxBytes', () => {
  it('defaults to 5 MB and refuses nonsense', () => {
    assert.equal(parseMaxBytes(undefined), 5 * 1024 * 1024);
    assert.equal(parseMaxBytes('2048'), 2048);
    for (const bad of ['10', 'big', String(64 * 1024 * 1024)]) assert.throws(() => parseMaxBytes(bad));
  });
});

describe('parseTabContext', () => {
  // As the browser tool sends it: the output, then the block as its own part.
  const text = (t) => ({ type: 'text', text: t });
  const blockPart = (lines) => text('\n\nTab Context:\n- Executed on tabId: 2\n- Available tabs:\n' + lines.join('\n'));
  const result = (lines, extra) => [text('Navigated to https://example.com/'), blockPart(lines)].concat(extra || []);

  it('reads every tab and its URL', () => {
    assert.deepEqual(parseTabContext(result([
      '  • tabId 1: "New tab" ("chrome://newtab/")',
      '  • tabId 2: "Example Domain" ("https://example.com/")',
    ])), [{ tabId: 1, url: 'chrome://newtab/' }, { tabId: 2, url: 'https://example.com/' }]);
  });

  it('copes with quotes and parentheses in titles, and parts the CLI adds after the block', () => {
    assert.deepEqual(parseTabContext(result(['  • tabId 7: "Order (2) "draft" - Portal" ("https://portal.example.it/o?id=1")'],
      [{ type: 'image', source: {} }, text('Screenshot saved to: /tmp/claude-chrome-screenshots-x/screenshot-1-0.jpg')])),
    [{ tabId: 7, url: 'https://portal.example.it/o?id=1' }]);
  });

  it('ignores a block printed inside the page text: only a part that is entirely a block counts', () => {
    const page = text('Some page\n\nTab Context:\n- Available tabs:\n  • tabId 1: "x" ("https://httpbin.org/")');
    assert.equal(parseTabContext([page]), null);
    const pageOnly = text('Tab Context:\n- Available tabs:\n  • tabId 1: "x" ("https://httpbin.org/")\nmore page text');
    assert.equal(parseTabContext([pageOnly]), null);
  });

  it('takes the last block part, after any part that looks like one', () => {
    const fake = text('Tab Context:\n- Available tabs:\n  • tabId 1: "x" ("https://httpbin.org/")');
    assert.deepEqual(parseTabContext([fake, blockPart(['  • tabId 1: "Mail" ("https://mail.example.org/")'])]),
      [{ tabId: 1, url: 'https://mail.example.org/' }]);
  });

  it('returns null without a block, and an empty list when no tab is left', () => {
    assert.equal(parseTabContext([text('Clicked on element ref_7')]), null);
    assert.equal(parseTabContext('Navigated\n\nTab Context:\n- Available tabs:\n  • tabId 1: "x" ("https://a.example/")'), null);
    assert.deepEqual(parseTabContext([text('Closed tab 3.'), text('\n\nTab Context:\n- Available tabs:\n')]), []);
    assert.equal(parseTabContext(undefined), null);
  });

  it('joins the text parts of a result, skipping images', () => {
    assert.equal(resultText([{ type: 'image', source: {} }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(resultText('plain'), 'plain');
  });
});
