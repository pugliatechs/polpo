/**
 * Markdown-to-Telegram-HTML converter.
 *
 * Telegram supports a subset of HTML: <b>, <i>, <s>, <u>, <code>, <pre>,
 * <a href="">, <blockquote>. This converts common markdown patterns.
 */

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Handles code blocks, inline code, bold, italic, strikethrough, links.
 */
function markdownToHtml(text) {
  if (!text) return '';

  // Extract code blocks first to protect their content
  var codeBlocks = [];
  var withPlaceholders = text.replace(/```(\w*)\n?([\s\S]*?)```/g, function (match, lang, code) {
    var idx = codeBlocks.length;
    var langAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    codeBlocks.push('<pre><code' + langAttr + '>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    return '\x00CODEBLOCK' + idx + '\x00';
  });

  // Extract inline code
  var inlineCodes = [];
  withPlaceholders = withPlaceholders.replace(/`([^`\n]+)`/g, function (match, code) {
    var idx = inlineCodes.length;
    inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
    return '\x00INLINE' + idx + '\x00';
  });

  // Escape HTML in the remaining text
  var escaped = escapeHtml(withPlaceholders);

  // Bold: **text** or __text__
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  escaped = escaped.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words like file_name)
  escaped = escaped.replace(/(?<!\w)\*([^\s*][^*]*?)\*(?!\w)/g, '<i>$1</i>');
  escaped = escaped.replace(/(?<!\w)_([^\s_][^_]*?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  escaped = escaped.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code
  escaped = escaped.replace(/\x00INLINE(\d+)\x00/g, function (match, idx) {
    return inlineCodes[Number(idx)] || match;
  });

  // Restore code blocks
  escaped = escaped.replace(/\x00CODEBLOCK(\d+)\x00/g, function (match, idx) {
    return codeBlocks[Number(idx)] || match;
  });

  return escaped;
}

module.exports = { markdownToHtml, escapeHtml };
