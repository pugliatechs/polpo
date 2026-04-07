const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText, MAX_LENGTH } = require('../src/pa/telegram/send');

describe('chunkText', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('hello world');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'hello world');
  });

  it('splits at paragraph boundary', () => {
    const para1 = 'a'.repeat(3500);
    const para2 = 'b'.repeat(1500);
    const text = para1 + '\n\n' + para2;
    const chunks = chunkText(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], para1);
    assert.equal(chunks[1], para2);
  });

  it('splits at newline when no paragraph boundary', () => {
    const line1 = 'a'.repeat(3800);
    const line2 = 'b'.repeat(1500);
    const text = line1 + '\n' + line2;
    const chunks = chunkText(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], line1);
    assert.equal(chunks[1], line2);
  });

  it('hard-cuts when no good split point', () => {
    const text = 'a'.repeat(MAX_LENGTH + 100);
    const chunks = chunkText(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, MAX_LENGTH);
  });

  it('handles empty text', () => {
    const chunks = chunkText('');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], '');
  });

  it('respects custom limit', () => {
    const chunks = chunkText('hello world foo bar', 10);
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 10);
    }
  });

  it('handles text exactly at limit', () => {
    const text = 'a'.repeat(MAX_LENGTH);
    const chunks = chunkText(text);
    assert.equal(chunks.length, 1);
  });
});
