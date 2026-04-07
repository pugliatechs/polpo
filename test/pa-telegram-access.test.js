const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isSenderAllowed } = require('../src/pa/telegram/access');

describe('isSenderAllowed', () => {
  it('denies null from', () => {
    assert.equal(isSenderAllowed(null, [123]), false);
  });

  it('denies with empty allowlist', () => {
    assert.equal(isSenderAllowed({ id: 123 }, []), false);
  });

  it('denies with no allowlist', () => {
    assert.equal(isSenderAllowed({ id: 123 }, null), false);
  });

  it('allows by numeric user ID', () => {
    assert.equal(isSenderAllowed({ id: 12345 }, [12345]), true);
  });

  it('denies non-matching user ID', () => {
    assert.equal(isSenderAllowed({ id: 99999 }, [12345]), false);
  });

  it('allows by string numeric ID', () => {
    assert.equal(isSenderAllowed({ id: 12345 }, ['12345']), true);
  });

  it('allows by username (case-insensitive)', () => {
    assert.equal(isSenderAllowed({ id: 1, username: 'MyUser' }, ['myuser']), true);
  });

  it('allows by username with @ prefix', () => {
    assert.equal(isSenderAllowed({ id: 1, username: 'myuser' }, ['@myuser']), true);
  });

  it('denies non-matching username', () => {
    assert.equal(isSenderAllowed({ id: 1, username: 'other' }, ['myuser']), false);
  });

  it('allows with wildcard', () => {
    assert.equal(isSenderAllowed({ id: 99999 }, ['*']), true);
  });

  it('allows if any entry matches', () => {
    assert.equal(isSenderAllowed({ id: 456, username: 'bob' }, [123, 'alice', 456]), true);
  });

  it('handles from without username for string entries', () => {
    assert.equal(isSenderAllowed({ id: 1 }, ['someuser']), false);
  });
});
