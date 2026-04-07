/**
 * Telegram bot creation and lifecycle.
 *
 * Uses grammY with sequentialize (per-chat ordering) and API throttling.
 */

const { Bot } = require('grammy');
const { sequentialize } = require('@grammyjs/runner');
const { apiThrottler } = require('@grammyjs/transformer-throttler');

/**
 * Create and configure a Telegram bot.
 * @param {object} config - { token }
 * @returns {{ bot: Bot, start: () => void, stop: () => Promise<void> }}
 */
function createTelegramBot(config) {
  if (!config.token) {
    throw new Error('Telegram bot token is required');
  }

  var bot = new Bot(config.token);

  // Throttle outbound API calls to avoid Telegram rate limits
  bot.api.config.use(apiThrottler());

  // Process updates sequentially per chat to avoid race conditions
  bot.use(sequentialize(function (ctx) {
    var chatId = ctx.chat ? String(ctx.chat.id) : '';
    return chatId ? [chatId] : undefined;
  }));

  // Global error handler — log and continue
  bot.catch(function (err) {
    console.error('[pa-telegram] Bot error:', err.message || err);
  });

  var started = false;

  return {
    bot: bot,

    start: function () {
      if (started) return;
      started = true;
      // Long-polling (no webhook setup needed)
      bot.start({
        onStart: function () {
          console.log('[pa-telegram] Bot started polling');
        },
      });
    },

    stop: async function () {
      if (!started) return;
      started = false;
      await bot.stop();
    },
  };
}

module.exports = { createTelegramBot };
