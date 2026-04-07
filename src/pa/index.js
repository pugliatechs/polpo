/**
 * Personal Assistant module — entry point.
 *
 * Wires together: Telegram bot ↔ AgentBridge ↔ InstanceManager.
 * Opt-in: disabled if POLPO_PA_TELEGRAM_TOKEN is not set.
 */

const { loadPaConfig } = require('./config');
const { createTelegramBot } = require('./telegram/bot');
const { registerHandlers } = require('./telegram/handlers');
const { sendMessage } = require('./telegram/send');
const { AgentBridge } = require('./agent-bridge');
const { TokenMonitor } = require('./auth/token-monitor');
const { MemoryManager } = require('./memory/index');
const { ReminderService } = require('./reminders');

/**
 * Create the PA module.
 * @param {object} opts
 * @param {object} opts.instanceManager
 * @param {function} opts.getAuthState
 * @param {object} [opts.pushManager]
 * @param {number} opts.serverPort
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void>, isEnabled: () => boolean }}
 */
function createPA(opts) {
  var config = loadPaConfig();
  var telegramBot = null;
  var agentBridge = null;
  var tokenMonitor = null;
  var memory = null;
  var reminderService = null;
  var chatId = null; // Primary chat ID for notifications (set on first message)

  return {
    isEnabled: function () {
      return config.enabled;
    },

    start: async function () {
      if (!config.enabled) return;

      var authState = typeof opts.getAuthState === 'function' ? opts.getAuthState() : null;
      var authToken = authState && authState.enabled ? authState.token : null;

      // Initialize memory system
      var os = require('os');
      var path = require('path');
      var memoryDbPath = process.env.POLPO_PA_MEMORY_DB ||
        path.join(os.homedir(), '.config', 'polpo', 'pa-memory.db');
      memory = new MemoryManager({
        dbPath: memoryDbPath,
        embedding: {
          provider: process.env.POLPO_PA_EMBEDDING_PROVIDER || 'hash',
          model: process.env.POLPO_PA_EMBEDDING_MODEL || null,
          apiKey: process.env.POLPO_PA_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || null,
        },
      });
      try {
        memory.init();
        console.log('[pa] Memory initialized at ' + memoryDbPath);
      } catch (err) {
        console.error('[pa] Memory init failed, continuing without persistence:', err.message);
        memory = null;
      }

      // Initialize reminder service (uses the same SQLite DB)
      if (memory && memory.db) {
        reminderService = new ReminderService({
          db: memory.db,
          onDue: function (reminder) {
            if (!chatId || !telegramBot) return;
            sendMessage(telegramBot.bot, chatId || reminder.chat_id,
              '⏰ <b>Reminder:</b> ' + escapeHtml(reminder.text),
              { html: true }
            ).catch(function () {});
          },
        });
        reminderService.start();
        reminderService.cleanup(); // Remove old fired reminders
      }

      // Create agent bridge
      agentBridge = new AgentBridge({
        instanceManager: opts.instanceManager,
        serverPort: opts.serverPort,
        authToken: authToken,
        agentConfig: config.agent,
        memory: memory,
      });

      // Wire agent messages → Telegram
      agentBridge.onMessage(function (msg) {
        if (!chatId || !telegramBot) return;

        // Assistant text messages
        if (msg.role === 'assistant' && (!msg.contentType || msg.contentType === 'text') && msg.content) {
          // Persist to memory
          if (memory) {
            try { memory.saveMessage(chatId, 'assistant', msg.content); } catch {}
          }
          sendMessage(telegramBot.bot, chatId, msg.content).catch(function (err) {
            console.error('[pa] Failed to send message to Telegram:', err.message);
          });
          return;
        }

        // Tool use — show what tool the agent is calling
        if (msg.contentType === 'tool_use' && msg.content) {
          try {
            var tool = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
            var toolName = tool.name || 'unknown';
            var toolText = '🔧 <b>' + escapeHtml(toolName) + '</b>';
            // Add a brief summary of the input for common tools
            if (tool.input) {
              if (tool.name === 'Bash' && tool.input.command) {
                toolText += '\n<code>' + escapeHtml(truncate(tool.input.command, 200)) + '</code>';
              } else if (tool.name === 'Read' && tool.input.file_path) {
                toolText += ' ' + escapeHtml(tool.input.file_path);
              } else if (tool.name === 'Write' && tool.input.file_path) {
                toolText += ' ' + escapeHtml(tool.input.file_path);
              } else if (tool.name === 'Edit' && tool.input.file_path) {
                toolText += ' ' + escapeHtml(tool.input.file_path);
              } else if ((tool.name === 'Grep' || tool.name === 'Glob') && tool.input.pattern) {
                toolText += ' <code>' + escapeHtml(truncate(tool.input.pattern, 100)) + '</code>';
              }
            }
            sendMessage(telegramBot.bot, chatId, toolText, { html: true }).catch(function () {});
          } catch {
            // Ignore unparseable tool use
          }
          return;
        }
      });

      // Wire status changes → typing indicator
      agentBridge.onStatusChange(function (status) {
        if (!chatId || !telegramBot) return;
        if (status === 'busy') {
          telegramBot.bot.api.sendChatAction(chatId, 'typing').catch(function () {});
        }
      });

      // Wire approval requests → Telegram inline buttons
      agentBridge.onApproval(function (approval, instanceId) {
        if (!chatId || !telegramBot || !approval) return;
        var toolName = approval.tool || 'action';
        var desc = approval.description || '';
        var text = '⚠️ <b>Approval required:</b> ' + escapeHtml(toolName);
        if (desc) text += '\n' + escapeHtml(desc);

        sendMessage(telegramBot.bot, chatId, text, {
          html: true,
          buttons: [
            [
              { text: '✅ Approve', callback_data: 'approve:' + instanceId },
              { text: '❌ Reject', callback_data: 'reject:' + instanceId },
            ],
          ],
        }).catch(function (err) {
          console.error('[pa] Failed to send approval to Telegram:', err.message);
        });
      });

      // Create and start Telegram bot
      telegramBot = createTelegramBot({ token: config.telegram.token });

      // Track the primary chat ID from first incoming message
      telegramBot.bot.use(function (ctx, next) {
        if (ctx.chat && !chatId) {
          chatId = ctx.chat.id;
          agentBridge.setPrimaryChatId(chatId);
        }
        return next();
      });

      registerHandlers(telegramBot.bot, config, {
        agentBridge: agentBridge,
        instanceManager: opts.instanceManager,
        memory: memory,
        reminderService: reminderService,
      });

      // Subscribe to approval events for ALL instances (not just PA)
      if (config.notifications.approvals) {
        opts.instanceManager.on('instance:approval', function (data) {
          // Skip PA's own approvals (already handled above)
          if (data.id === agentBridge.getInstanceId()) return;
          if (!chatId || !telegramBot || !data.approval) return;

          var inst = opts.instanceManager.get(data.id);
          var name = inst ? (inst.name || inst.project || 'Agent') : 'Agent';
          var toolName = data.approval.tool || 'action';
          var text = '⚠️ <b>' + escapeHtml(name) + '</b> needs approval for <b>' + escapeHtml(toolName) + '</b>';

          sendMessage(telegramBot.bot, chatId, text, {
            html: true,
            buttons: [
              [
                { text: '✅ Approve', callback_data: 'approve:' + data.id },
                { text: '❌ Reject', callback_data: 'reject:' + data.id },
              ],
            ],
          }).catch(function () {});
        });
      }

      // Subscribe to task completion notifications
      if (config.notifications.completions) {
        opts.instanceManager.on('instance:status', function (data) {
          if (data.status !== 'idle') return;
          // Skip PA agent's own status
          if (data.id === agentBridge.getInstanceId()) return;
          if (!chatId || !telegramBot) return;

          var inst = opts.instanceManager.get(data.id);
          var name = inst ? (inst.name || inst.project || 'Agent') : 'Agent';
          sendMessage(telegramBot.bot, chatId, '✅ <b>' + escapeHtml(name) + '</b> finished.', { html: true })
            .catch(function () {});
        });
      }

      telegramBot.start();

      // Start token health monitor
      tokenMonitor = new TokenMonitor({
        checkIntervalMinutes: config.auth.checkIntervalMinutes,
        expiryBufferMinutes: config.auth.expiryBufferMinutes,
        autoRefresh: config.auth.autoRefresh,
        onExpiring: function (authUrl) {
          if (!chatId || !telegramBot) return;
          sendMessage(telegramBot.bot, chatId,
            '⚠️ Anthropic token needs renewal.\n\n' +
            'Open this URL to authenticate:\n' + authUrl + '\n\n' +
            'Then paste either the callback URL or just the authorization code here.',
            { html: false }
          ).catch(function () {});
        },
        onRefreshed: function () {
          if (!chatId || !telegramBot) return;
          sendMessage(telegramBot.bot, chatId, '🔄 Token auto-refreshed.', { html: true })
            .catch(function () {});
        },
        onError: function (err) {
          console.error('[pa-auth] Monitor error:', err.message || err);
        },
      });
      tokenMonitor.start();

      console.log('[pa] Personal Assistant active on Telegram');
    },

    stop: async function () {
      if (reminderService) {
        reminderService.stop();
        reminderService = null;
      }
      if (tokenMonitor) {
        tokenMonitor.stop();
        tokenMonitor = null;
      }
      if (agentBridge) {
        agentBridge.stopAgent();
        agentBridge = null;
      }
      if (telegramBot) {
        await telegramBot.stop();
        telegramBot = null;
      }
      if (memory) {
        try { memory.close(); } catch {}
        memory = null;
      }
    },
  };
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max) + '...';
}

module.exports = { createPA };
