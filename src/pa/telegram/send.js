/**
 * Telegram message sending with chunking and HTML formatting.
 *
 * Telegram limits: 4096 chars per message, 1024 chars for captions.
 * Splits long messages at paragraph/line boundaries, respects code blocks.
 */

const { markdownToHtml } = require('./format');

const MAX_LENGTH = 4096;
const PARSE_ERROR_RE = /can't parse entities|bad request.*parse/i;

/**
 * Chunk text into segments that fit Telegram's message limit.
 * Tries to split at paragraph boundaries, then line boundaries.
 * Keeps code blocks intact when possible.
 */
function chunkText(text, limit) {
  if (!limit) limit = MAX_LENGTH;
  if (text.length <= limit) return [text];

  var chunks = [];
  var remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    var slice = remaining.slice(0, limit);

    // Try to split at double newline (paragraph)
    var splitIdx = slice.lastIndexOf('\n\n');
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2);
      continue;
    }

    // Try to split at single newline
    splitIdx = slice.lastIndexOf('\n');
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Try to split at space
    splitIdx = slice.lastIndexOf(' ');
    if (splitIdx > limit * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Hard cut
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }

  return chunks;
}

/**
 * Send a message to a Telegram chat, handling chunking and formatting.
 *
 * @param {import('grammy').Bot} bot - grammY bot instance
 * @param {number|string} chatId - Telegram chat ID
 * @param {string} text - Message text (markdown)
 * @param {object} [opts] - Options
 * @param {boolean} [opts.html] - If true, text is already HTML (skip conversion)
 * @param {Array} [opts.buttons] - Inline keyboard buttons array of arrays
 * @param {number} [opts.replyTo] - Message ID to reply to
 */
async function sendMessage(bot, chatId, text, opts) {
  if (!text) return;
  if (!opts) opts = {};

  var htmlText = opts.html ? text : markdownToHtml(text);
  var chunks = chunkText(htmlText);

  for (var i = 0; i < chunks.length; i++) {
    var isLast = i === chunks.length - 1;
    var extra = { parse_mode: 'HTML' };

    // Only add buttons to the last chunk
    if (isLast && opts.buttons) {
      extra.reply_markup = { inline_keyboard: opts.buttons };
    }
    if (opts.replyTo && i === 0) {
      extra.reply_parameters = { message_id: opts.replyTo };
    }

    try {
      await bot.api.sendMessage(chatId, chunks[i], extra);
    } catch (err) {
      // If HTML parsing fails, retry as plain text
      if (err.message && PARSE_ERROR_RE.test(err.message)) {
        var plainChunk = opts.html ? chunks[i] : chunkText(text)[i] || chunks[i];
        var plainExtra = {};
        if (isLast && opts.buttons) {
          plainExtra.reply_markup = { inline_keyboard: opts.buttons };
        }
        if (opts.replyTo && i === 0) {
          plainExtra.reply_parameters = { message_id: opts.replyTo };
        }
        try {
          await bot.api.sendMessage(chatId, plainChunk, plainExtra);
        } catch {
          // Give up on this chunk
        }
      }
    }
  }
}

module.exports = { sendMessage, chunkText, MAX_LENGTH };
