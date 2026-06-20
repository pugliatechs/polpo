const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeLogger } = require('../src/util/logger');

function captureStream(streamName) {
  const original = console[streamName];
  const captured = [];
  console[streamName] = function (msg, ...args) { captured.push({ msg, args }); };
  return {
    captured,
    restore() { console[streamName] = original; },
  };
}

describe('makeLogger', () => {
  it('rejects an empty or non-string tag', () => {
    assert.throws(() => makeLogger(''), /non-empty string/);
    assert.throws(() => makeLogger(null), /non-empty string/);
    assert.throws(() => makeLogger(42), /non-empty string/);
  });

  it('info prefixes the message with [tag YYYY-MM-DD HH:MM:SS.ffffff]', () => {
    const cap = captureStream('log');
    try {
      const log = makeLogger('test');
      log.info('hello');
      assert.equal(cap.captured.length, 1);
      const { msg } = cap.captured[0];
      assert.match(msg, /^\[test \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\] hello$/);
    } finally {
      cap.restore();
    }
  });

  it('warn writes to stderr', () => {
    const cap = captureStream('warn');
    try {
      const log = makeLogger('test');
      log.warn('careful');
      assert.equal(cap.captured.length, 1);
      assert.ok(cap.captured[0].msg.includes('careful'));
    } finally {
      cap.restore();
    }
  });

  it('error writes to stderr and forwards extra args verbatim', () => {
    const cap = captureStream('error');
    try {
      const log = makeLogger('test');
      const err = new Error('boom');
      log.error('failed:', err);
      assert.equal(cap.captured.length, 1);
      assert.ok(cap.captured[0].msg.includes('failed:'));
      assert.equal(cap.captured[0].args[0], err);
    } finally {
      cap.restore();
    }
  });

  it('sanitizes whitespace in the tag so the prefix stays grep-friendly', () => {
    const cap = captureStream('log');
    try {
      const log = makeLogger('my component');
      log.info('x');
      assert.ok(cap.captured[0].msg.startsWith('[my-component '));
    } finally {
      cap.restore();
    }
  });
});
