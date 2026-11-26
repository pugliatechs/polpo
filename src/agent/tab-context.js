'use strict';

/**
 * The "Tab Context" block of a Claude in Chrome tool result:
 *
 *   Tab Context:
 *   - Executed on tabId: 249338243
 *   - Available tabs:
 *     • tabId 249338242: "New tab" ("chrome://newtab/")
 *     • tabId 249338243: "Example Domain" ("https://example.com/")
 *
 * It is how polpo follows the page each tab of a browser session shows,
 * after a click that navigated as well. Read from the full tool result:
 * the copy forwarded to the dashboard is cut to 2000 characters.
 *
 * The browser tool sends the block as a text part of its own, after the
 * part with the tool's output (where page text lands). Only a part that is
 * entirely a well-formed block counts, and the last such part wins: a page
 * that prints something looking like a block inside its own text cannot
 * move polpo's idea of where a tab is.
 */

const MAX_TABS = 50;
const MAX_URL_CHARS = 4096;
const TAB_LINE_RE = /^\s*•\s*tabId\s+(\d{1,16}):\s*"(.*)"\s*\("([^"]*)"\)\s*$/;
const EXECUTED_RE = /^\s*-\s*Executed on tabId:\s*\d{1,16}\s*$/;
const AVAILABLE_RE = /^\s*-\s*Available tabs:\s*$/;

/** The text parts of a tool result's content. */
function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
}

/** The text parts joined, for callers that want the result as one string. */
function resultText(content) {
  return textParts(content).join('\n');
}

/**
 * Parse one text part that must be exactly a Tab Context block.
 * @returns {?Array<{tabId: number, url: string}>}
 */
function parseBlock(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length || lines[i].trim() !== 'Tab Context:') return null;
  i++;
  if (i < lines.length && EXECUTED_RE.test(lines[i])) i++;
  if (i >= lines.length || !AVAILABLE_RE.test(lines[i])) return null;
  i++;
  const tabs = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    const m = TAB_LINE_RE.exec(line);
    if (!m) return null;
    const tabId = Number(m[1]);
    if (!Number.isSafeInteger(tabId) || m[3].length > MAX_URL_CHARS) return null;
    if (tabs.length < MAX_TABS) tabs.push({ tabId, url: m[3] });
  }
  // Nothing but blank lines may follow the list.
  for (; i < lines.length; i++) if (lines[i].trim()) return null;
  return tabs;
}

/**
 * @param {string|Array} content - a tool result's content
 * @returns {?Array<{tabId: number, url: string}>} null when no text part
 *   is a well-formed block; otherwise every tab the last one lists
 *   (closed tabs are left out)
 */
function parseTabContext(content) {
  let found = null;
  for (const part of textParts(content)) {
    const tabs = parseBlock(part);
    if (tabs) found = tabs;
  }
  return found;
}

module.exports = { parseTabContext, resultText };
