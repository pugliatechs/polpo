const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { markdownToHtml, escapeHtml } = require('../src/pa/telegram/format');

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  });

  it('returns empty string for non-string', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });
});

describe('markdownToHtml', () => {
  it('returns empty for falsy input', () => {
    assert.equal(markdownToHtml(''), '');
    assert.equal(markdownToHtml(null), '');
  });

  it('converts bold **text**', () => {
    assert.equal(markdownToHtml('hello **world**'), 'hello <b>world</b>');
  });

  it('converts bold __text__', () => {
    assert.equal(markdownToHtml('hello __world__'), 'hello <b>world</b>');
  });

  it('converts italic *text*', () => {
    const result = markdownToHtml('hello *world*');
    assert.ok(result.includes('<i>world</i>'));
  });

  it('converts strikethrough ~~text~~', () => {
    assert.equal(markdownToHtml('hello ~~world~~'), 'hello <s>world</s>');
  });

  it('converts inline code', () => {
    const result = markdownToHtml('use `console.log`');
    assert.ok(result.includes('<code>console.log</code>'));
  });

  it('converts code blocks', () => {
    const result = markdownToHtml('```js\nconsole.log("hi")\n```');
    assert.ok(result.includes('<pre><code'));
    assert.ok(result.includes('console.log'));
  });

  it('escapes HTML in code blocks', () => {
    const result = markdownToHtml('```\n<script>alert(1)</script>\n```');
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!result.includes('<script>'));
  });

  it('escapes HTML in inline code', () => {
    const result = markdownToHtml('use `<b>tag</b>`');
    assert.ok(result.includes('&lt;b&gt;'));
  });

  it('converts links', () => {
    const result = markdownToHtml('[click](https://example.com)');
    assert.ok(result.includes('<a href="https://example.com">click</a>'));
  });

  it('does not convert non-http links', () => {
    const result = markdownToHtml('[click](javascript:alert(1))');
    assert.ok(!result.includes('<a'));
  });

  it('escapes HTML in regular text', () => {
    const result = markdownToHtml('a <b> tag');
    assert.ok(result.includes('&lt;b&gt;'));
  });
});
