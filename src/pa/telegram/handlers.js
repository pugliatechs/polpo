/**
 * Telegram bot handlers — message routing, commands, inline buttons.
 *
 * Wires Telegram events to the agent bridge: user text → agent prompt,
 * agent response → Telegram message, approval requests → inline buttons.
 */

const { isSenderAllowed } = require('./access');
const { sendMessage } = require('./send');
const { generatePKCEVerifier, buildAuthURL, parseCallbackURL, parseRawCode, exchangeCode,
  CALLBACK_URL_PATTERN, RAW_CODE_PATTERN } = require('../auth/oauth');
const { setPendingFlow, getPendingVerifier, getMostRecentVerifier } = require('../auth/state');
const { VALID_AGENT_TYPES } = require('../config');
const { setCurrentTokens, formatTimeRemaining } = require('../auth/token-monitor');
const { downloadTelegramFile, getBestPhoto, detectMediaType } = require('./media');
const { downloadAndTranscribe, isTranscriptionAvailable } = require('./voice');

/**
 * Register all handlers on the bot.
 * @param {import('grammy').Bot} bot
 * @param {object} config - PA config (telegram.allowFrom, etc.)
 * @param {object} deps - { agentBridge, instanceManager, memory }
 */
function registerHandlers(bot, config, deps) {
  var agentBridge = deps.agentBridge;
  var instanceManager = deps.instanceManager;
  var allowFrom = config.telegram.allowFrom;

  // /start — welcome message
  bot.command('start', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    await sendMessage(bot, ctx.chat.id,
      '<b>Welcome to your Personal Assistant.</b>\n\n' +
      'Send any message and I will process it.\n\n' +
      '<b>Session</b>\n' +
      '<code>/status</code> — Active instances\n' +
      '<code>/instances</code> — Detailed instance list\n' +
      '<code>/new</code> — Start PA agent\n' +
      '<code>/stop</code> — Stop PA agent\n' +
      '<code>/abort</code> — Abort current task\n\n' +
      '<b>Actions</b>\n' +
      '<code>/approve</code> &lt;id&gt; — Approve pending action\n' +
      '<code>/reject</code> &lt;id&gt; — Reject pending action\n' +
      '<code>/agent</code> &lt;type&gt; — Switch agent\n\n' +
      '<b>Tools</b>\n' +
      '<code>/web</code> &lt;query&gt; — Web research\n' +
      '<code>/remind</code> &lt;time&gt; &lt;text&gt; — Set reminder (30m, 2h, 1d)\n' +
      '<code>/reminders</code> — List pending reminders\n' +
      '<code>/cancel</code> &lt;id&gt; — Cancel a reminder\n\n' +
      '<b>Memory</b>\n' +
      '<code>/remember</code> &lt;key&gt; &lt;text&gt; — Save\n' +
      '<code>/forget</code> &lt;key&gt; — Remove\n' +
      '<code>/memories</code> — List all\n' +
      '<code>/search</code> &lt;query&gt; — Search\n\n' +
      '<b>Auth</b>\n' +
      '<code>/renew_token</code> — Renew token',
      { html: true }
    );
  });

  // /renew_token — initiate auth renewal (agent-type aware)
  bot.command('renew_token', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    var currentType = agentBridge.getAgentType() || config.agent.type || 'claude';

    if (currentType === 'claude') {
      // Anthropic OAuth PKCE flow
      var verifier = generatePKCEVerifier();
      var authUrl = buildAuthURL(verifier);
      var senderId = String(ctx.from.id);
      setPendingFlow(senderId, verifier);

      await sendMessage(bot, ctx.chat.id,
        'Open this URL to authenticate:\n\n' +
        authUrl + '\n\n' +
        'After signing in, paste either:\n' +
        '- The full callback URL, or\n' +
        '- Just the authorization code shown on the page',
        { html: false }
      );
    } else if (currentType === 'codex') {
      await sendMessage(bot, ctx.chat.id,
        'Codex uses an OpenAI API key. Set <code>OPENAI_API_KEY</code> in your environment and restart the server.',
        { html: true });
    } else if (currentType === 'gemini') {
      await sendMessage(bot, ctx.chat.id,
        'Gemini uses Google authentication. Run <code>gemini</code> in a terminal to re-authenticate.',
        { html: true });
    } else {
      await sendMessage(bot, ctx.chat.id,
        'Token renewal for <b>' + escapeHtmlSafe(currentType) + '</b> is not yet supported. Check your API key or credentials manually.',
        { html: true });
    }
  });

  // /agent <type> — switch agent type at runtime
  bot.command('agent', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var newType = (ctx.match || '').trim().toLowerCase();

    if (!newType) {
      var currentType = agentBridge.getAgentType() || config.agent.type || 'claude';
      await sendMessage(bot, ctx.chat.id,
        'Current agent: <b>' + escapeHtmlSafe(currentType) + '</b>\n' +
        'Available: ' + VALID_AGENT_TYPES.join(', ') + '\n' +
        'Usage: /agent &lt;type&gt;',
        { html: true });
      return;
    }

    if (VALID_AGENT_TYPES.indexOf(newType) === -1) {
      await sendMessage(bot, ctx.chat.id,
        'Invalid agent type. Available: ' + VALID_AGENT_TYPES.join(', '),
        { html: true });
      return;
    }

    // Stop current agent if running
    if (agentBridge.getInstanceId()) {
      agentBridge.stopAgent();
    }

    // Update config and spawn new agent
    config.agent.type = newType;
    try {
      await agentBridge.spawnAgent();
      await sendMessage(bot, ctx.chat.id,
        '🔄 Switched to <b>' + escapeHtmlSafe(newType) + '</b> agent.',
        { html: true });
    } catch (err) {
      await sendMessage(bot, ctx.chat.id,
        'Failed to start ' + escapeHtmlSafe(newType) + ' agent: ' + escapeHtmlSafe(err.message),
        { html: true });
    }
  });

  // /status — list active instances
  bot.command('status', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    var instances = instanceManager.getAll();
    if (instances.length === 0) {
      await sendMessage(bot, ctx.chat.id, 'No active instances.', { html: true });
      return;
    }

    var lines = instances.map(function (inst) {
      var status = inst.status || 'unknown';
      var icon = status === 'busy' ? '🔄' : status === 'idle' ? '✅' : status === 'waiting' ? '⏳' : '⚪';
      var name = inst.name || inst.project || inst.id;
      return icon + ' <b>' + escapeHtmlSafe(name) + '</b> — ' + escapeHtmlSafe(status);
    });

    await sendMessage(bot, ctx.chat.id, lines.join('\n'), { html: true });
  });

  // /new — spawn a new PA agent session
  bot.command('new', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    if (agentBridge.getInstanceId()) {
      await sendMessage(bot, ctx.chat.id, 'PA agent is already running. Use /stop first.', { html: true });
      return;
    }

    try {
      await agentBridge.spawnAgent();
      await sendMessage(bot, ctx.chat.id, 'PA agent started.', { html: true });
    } catch (err) {
      await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
    }
  });

  // /instances — list all active instances with status
  bot.command('instances', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    var instances = agentBridge.listAllInstances();
    if (instances.length === 0) {
      await sendMessage(bot, ctx.chat.id, 'No active instances.', { html: true });
      return;
    }

    var lines = instances.map(function (inst) {
      var icon = inst.status === 'busy' ? '🔄'
        : inst.status === 'idle' ? '✅'
        : inst.status === 'waiting' ? '⏳'
        : inst.status === 'disconnected' ? '🔴'
        : '⚪';
      var paTag = inst.isPa ? ' [PA]' : '';
      return icon + ' <b>' + escapeHtmlSafe(inst.name) + '</b>' + paTag +
        ' — ' + escapeHtmlSafe(inst.status) +
        '\n   <code>' + escapeHtmlSafe(inst.id.slice(0, 8)) + '</code> · ' + escapeHtmlSafe(inst.agentType);
    });

    await sendMessage(bot, ctx.chat.id, lines.join('\n\n'), { html: true });
  });

  // /approve <id> — approve pending action on any instance
  bot.command('approve', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var idPrefix = (ctx.match || '').trim();
    if (!idPrefix) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /approve &lt;instance-id-prefix&gt;', { html: true });
      return;
    }
    var target = findInstanceByPrefix(instanceManager, idPrefix);
    if (!target) {
      await sendMessage(bot, ctx.chat.id, 'Instance not found.', { html: true });
      return;
    }
    agentBridge.approveInstance(target.id);
    await sendMessage(bot, ctx.chat.id, '✅ Approved <b>' + escapeHtmlSafe(target.name || target.id) + '</b>.', { html: true });
  });

  // /reject <id> — reject pending action on any instance
  bot.command('reject', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var idPrefix = (ctx.match || '').trim();
    if (!idPrefix) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /reject &lt;instance-id-prefix&gt;', { html: true });
      return;
    }
    var target = findInstanceByPrefix(instanceManager, idPrefix);
    if (!target) {
      await sendMessage(bot, ctx.chat.id, 'Instance not found.', { html: true });
      return;
    }
    agentBridge.rejectInstance(target.id);
    await sendMessage(bot, ctx.chat.id, '❌ Rejected <b>' + escapeHtmlSafe(target.name || target.id) + '</b>.', { html: true });
  });

  // /abort — abort the current PA agent task
  bot.command('abort', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    if (!agentBridge.getInstanceId()) {
      await sendMessage(bot, ctx.chat.id, 'No PA agent is running.', { html: true });
      return;
    }
    agentBridge.abort();
    await sendMessage(bot, ctx.chat.id, '🛑 Task aborted.', { html: true });
  });

  // /remember <key> <content> — save a memory
  bot.command('remember', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var memory = deps.memory;
    if (!memory) {
      await sendMessage(bot, ctx.chat.id, 'Memory system not available.', { html: true });
      return;
    }
    var input = (ctx.match || '').trim();
    if (!input) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /remember &lt;key&gt; &lt;content&gt;', { html: true });
      return;
    }
    // Split on first space: key is the first word, content is the rest
    var spaceIdx = input.indexOf(' ');
    if (spaceIdx === -1) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /remember &lt;key&gt; &lt;content&gt;', { html: true });
      return;
    }
    var key = input.slice(0, spaceIdx);
    var content = input.slice(spaceIdx + 1).trim();
    if (!content) {
      await sendMessage(bot, ctx.chat.id, 'Content cannot be empty.', { html: true });
      return;
    }
    try {
      await memory.addMemory(key, content);
      await sendMessage(bot, ctx.chat.id, '💾 Remembered <b>' + escapeHtmlSafe(key) + '</b>.', { html: true });
    } catch (err) {
      await sendMessage(bot, ctx.chat.id, 'Failed to save: ' + escapeHtmlSafe(err.message), { html: true });
    }
  });

  // /forget <key> — remove a memory
  bot.command('forget', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var memory = deps.memory;
    if (!memory) {
      await sendMessage(bot, ctx.chat.id, 'Memory system not available.', { html: true });
      return;
    }
    var key = (ctx.match || '').trim();
    if (!key) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /forget &lt;key&gt;', { html: true });
      return;
    }
    var removed = memory.removeMemory(key);
    if (removed) {
      await sendMessage(bot, ctx.chat.id, '🗑 Forgot <b>' + escapeHtmlSafe(key) + '</b>.', { html: true });
    } else {
      await sendMessage(bot, ctx.chat.id, 'No memory found with key <b>' + escapeHtmlSafe(key) + '</b>.', { html: true });
    }
  });

  // /memories — list all memories
  bot.command('memories', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var memory = deps.memory;
    if (!memory) {
      await sendMessage(bot, ctx.chat.id, 'Memory system not available.', { html: true });
      return;
    }
    var list = memory.listMemories(20);
    if (list.length === 0) {
      await sendMessage(bot, ctx.chat.id, 'No memories stored.', { html: true });
      return;
    }
    var lines = list.map(function (m) {
      var preview = m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content;
      return '• <b>' + escapeHtmlSafe(m.key) + '</b> — ' + escapeHtmlSafe(preview);
    });
    await sendMessage(bot, ctx.chat.id, lines.join('\n'), { html: true });
  });

  // /search <query> — search memories
  bot.command('search', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var memory = deps.memory;
    if (!memory) {
      await sendMessage(bot, ctx.chat.id, 'Memory system not available.', { html: true });
      return;
    }
    var query = (ctx.match || '').trim();
    if (!query) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /search &lt;query&gt;', { html: true });
      return;
    }
    try {
      var results = await memory.search(query, 10);
      if (results.length === 0) {
        await sendMessage(bot, ctx.chat.id, 'No matching memories.', { html: true });
        return;
      }
      var lines = results.map(function (r) {
        var preview = r.content.length > 100 ? r.content.slice(0, 100) + '...' : r.content;
        return '• <b>' + escapeHtmlSafe(r.key) + '</b> (' + Math.round(r.score * 100) + '%)\n  ' + escapeHtmlSafe(preview);
      });
      await sendMessage(bot, ctx.chat.id, lines.join('\n\n'), { html: true });
    } catch (err) {
      await sendMessage(bot, ctx.chat.id, 'Search failed: ' + escapeHtmlSafe(err.message), { html: true });
    }
  });

  // /stop — stop the current PA agent
  bot.command('stop', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    if (!agentBridge.getInstanceId()) {
      await sendMessage(bot, ctx.chat.id, 'No PA agent is running.', { html: true });
      return;
    }

    agentBridge.stopAgent();
    await sendMessage(bot, ctx.chat.id, 'PA agent stopped.', { html: true });
  });

  // /web <query> — ask the agent to do web research
  bot.command('web', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var query = (ctx.match || '').trim();
    if (!query) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /web &lt;search query&gt;', { html: true });
      return;
    }

    if (!agentBridge.getInstanceId()) {
      try { await agentBridge.spawnAgent(); } catch (err) {
        await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
        return;
      }
    }

    try { await ctx.api.sendChatAction(ctx.chat.id, 'typing'); } catch {}

    // Wrap query with an instruction for the agent to search the web
    agentBridge.sendPrompt(
      'Search the web for: ' + query + '\n\nSummarize the key findings concisely.'
    );
  });

  // /remind <time> <text> — set a real reminder with timer
  bot.command('remind', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var reminderService = deps.reminderService;
    if (!reminderService) {
      await sendMessage(bot, ctx.chat.id, 'Reminder service not available.', { html: true });
      return;
    }
    var input = (ctx.match || '').trim();
    if (!input) {
      await sendMessage(bot, ctx.chat.id,
        'Usage: /remind &lt;time&gt; &lt;text&gt;\n\n' +
        'Examples:\n' +
        '<code>/remind 30m Check the build</code>\n' +
        '<code>/remind 2h Call the dentist</code>\n' +
        '<code>/remind 1d Review PR</code>',
        { html: true });
      return;
    }

    // Try to split time and text — first token is time, rest is text
    var parts = input.match(/^(\S+)\s+(.+)$/);
    if (!parts) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /remind &lt;time&gt; &lt;text&gt; (e.g., /remind 30m Call John)', { html: true });
      return;
    }

    var parseRelativeTime = require('../reminders').parseRelativeTime;
    var formatDueTime = require('../reminders').formatDueTime;
    var dueAt = parseRelativeTime(parts[1]);
    if (!dueAt) {
      await sendMessage(bot, ctx.chat.id,
        'Could not parse time: <code>' + escapeHtmlSafe(parts[1]) + '</code>\n' +
        'Try: 30m, 2h, 1d, or an ISO date.',
        { html: true });
      return;
    }

    try {
      var reminder = reminderService.add(String(ctx.chat.id), parts[2], dueAt);
      await sendMessage(bot, ctx.chat.id,
        '⏰ Reminder set — <b>' + escapeHtmlSafe(parts[2]) + '</b> in ' + formatDueTime(dueAt),
        { html: true });
    } catch (err) {
      await sendMessage(bot, ctx.chat.id, 'Failed: ' + escapeHtmlSafe(err.message), { html: true });
    }
  });

  // /reminders — list pending reminders
  bot.command('reminders', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var reminderService = deps.reminderService;
    if (!reminderService) {
      await sendMessage(bot, ctx.chat.id, 'Reminder service not available.', { html: true });
      return;
    }
    var formatDueTime = require('../reminders').formatDueTime;
    var list = reminderService.list(String(ctx.chat.id));
    if (list.length === 0) {
      await sendMessage(bot, ctx.chat.id, 'No pending reminders.', { html: true });
      return;
    }
    var lines = list.map(function (r) {
      return '⏰ [#' + r.id + '] <b>' + escapeHtmlSafe(r.text) + '</b> — in ' + formatDueTime(r.due_at);
    });
    await sendMessage(bot, ctx.chat.id, lines.join('\n'), { html: true });
  });

  // /cancel <id> — cancel a reminder
  bot.command('cancel', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;
    var reminderService = deps.reminderService;
    if (!reminderService) {
      await sendMessage(bot, ctx.chat.id, 'Reminder service not available.', { html: true });
      return;
    }
    var id = parseInt((ctx.match || '').trim(), 10);
    if (!id) {
      await sendMessage(bot, ctx.chat.id, 'Usage: /cancel &lt;reminder-id&gt;', { html: true });
      return;
    }
    if (reminderService.remove(id)) {
      await sendMessage(bot, ctx.chat.id, '🗑 Reminder #' + id + ' cancelled.', { html: true });
    } else {
      await sendMessage(bot, ctx.chat.id, 'Reminder not found.', { html: true });
    }
  });

  // Photo messages — download and forward as image attachment for Claude vision
  bot.on('message:photo', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    if (!agentBridge.getInstanceId()) {
      try { await agentBridge.spawnAgent(); } catch (err) {
        await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
        return;
      }
    }

    try { await ctx.api.sendChatAction(ctx.chat.id, 'typing'); } catch {}

    var caption = ctx.message.caption || 'Analyze this image.';
    var bestPhoto = getBestPhoto(ctx.message.photo);
    if (!bestPhoto) {
      agentBridge.sendPrompt(caption + '\n\n(Photo could not be processed.)');
      return;
    }

    try {
      var filePath = await downloadTelegramFile(bot, bestPhoto.file_id, 'photo.jpg');
      // Send prompt with image attachment — WrappedAgent converts to base64
      instanceManager.sendToAgent(agentBridge.getInstanceId(), {
        type: 'prompt',
        text: caption,
        attachments: [{
          path: filePath,
          filename: 'photo.jpg',
          mediaType: 'image/jpeg',
        }],
      });
    } catch (err) {
      agentBridge.sendPrompt(caption + '\n\n(Failed to download photo: ' + err.message + ')');
    }

    if (deps.memory) {
      try { deps.memory.saveMessage(String(ctx.chat.id), 'user', '[photo] ' + caption); } catch {}
    }
  });

  // Voice messages — transcribe via Whisper and forward as text
  bot.on('message:voice', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    if (!agentBridge.getInstanceId()) {
      try { await agentBridge.spawnAgent(); } catch (err) {
        await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
        return;
      }
    }

    if (!isTranscriptionAvailable()) {
      await sendMessage(bot, ctx.chat.id,
        'Voice transcription requires an OpenAI API key. Set <code>OPENAI_API_KEY</code> or <code>POLPO_PA_WHISPER_API_KEY</code>.',
        { html: true });
      return;
    }

    try { await ctx.api.sendChatAction(ctx.chat.id, 'typing'); } catch {}

    try {
      var transcript = await downloadAndTranscribe(bot, ctx.message.voice.file_id);
      if (!transcript) {
        await sendMessage(bot, ctx.chat.id, '(Could not transcribe voice note.)', { html: true });
        return;
      }

      // Show transcription to user
      await sendMessage(bot, ctx.chat.id, '🎤 <i>' + escapeHtmlSafe(transcript) + '</i>', { html: true });

      if (deps.memory) {
        try { deps.memory.saveMessage(String(ctx.chat.id), 'user', '[voice] ' + transcript); } catch {}
      }

      agentBridge.sendPrompt(transcript);
    } catch (err) {
      await sendMessage(bot, ctx.chat.id, 'Transcription failed: ' + escapeHtmlSafe(err.message), { html: true });
    }
  });

  // Document messages — download and forward as attachment
  bot.on('message:document', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    if (!agentBridge.getInstanceId()) {
      try { await agentBridge.spawnAgent(); } catch (err) {
        await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
        return;
      }
    }

    var doc = ctx.message.document;
    var filename = doc ? doc.file_name || 'document' : 'document';
    var caption = ctx.message.caption || 'The user sent a file: ' + filename;
    var mediaType = doc ? detectMediaType(filename) : 'application/octet-stream';

    try { await ctx.api.sendChatAction(ctx.chat.id, 'typing'); } catch {}

    // Only download files under 20MB (Telegram bot API limit)
    var fileSize = doc ? doc.file_size || 0 : 0;
    if (fileSize > 20 * 1024 * 1024) {
      agentBridge.sendPrompt(caption + '\n\n(File too large to process — ' + Math.round(fileSize / 1024 / 1024) + 'MB)');
      return;
    }

    try {
      var filePath = await downloadTelegramFile(bot, doc.file_id, filename);
      instanceManager.sendToAgent(agentBridge.getInstanceId(), {
        type: 'prompt',
        text: caption,
        attachments: [{
          path: filePath,
          filename: filename,
          mediaType: mediaType,
        }],
      });
    } catch (err) {
      agentBridge.sendPrompt(caption + '\n\n(Failed to download file: ' + err.message + ')');
    }

    if (deps.memory) {
      try { deps.memory.saveMessage(String(ctx.chat.id), 'user', '[file: ' + filename + '] ' + caption); } catch {}
    }
  });

  // Callback query handler — inline button presses (approve/reject)
  bot.on('callback_query:data', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized' });
      return;
    }

    await ctx.answerCallbackQuery();

    var data = ctx.callbackQuery.data;
    var parts = data.split(':');
    var action = parts[0];
    var targetId = parts[1];

    // Validate targetId exists in InstanceManager before acting
    if (!targetId || !instanceManager.get(targetId)) {
      await sendMessage(bot, ctx.chat.id, 'Instance not found.', { html: true });
      return;
    }

    if (action === 'approve') {
      instanceManager.sendToAgent(targetId, { type: 'approve' });
      instanceManager.clearPendingApproval(targetId);
      await sendMessage(bot, ctx.chat.id, '✅ Approved.', { html: true });
    } else if (action === 'reject') {
      instanceManager.sendToAgent(targetId, { type: 'reject' });
      instanceManager.clearPendingApproval(targetId);
      await sendMessage(bot, ctx.chat.id, '❌ Rejected.', { html: true });
    }
  });

  // Text messages — forward to agent as prompts
  bot.on('message:text', async function (ctx) {
    if (!isSenderAllowed(ctx.from, allowFrom)) return;

    // Skip if it's a command (already handled above)
    if (ctx.message.text.startsWith('/')) return;

    var text = ctx.message.text.trim();

    // --- Auth code interception ---
    // Detect pasted callback URLs (from Anthropic OAuth redirect)
    var callbackParsed = parseCallbackURL(text);
    if (callbackParsed) {
      var verifier = getPendingVerifier(callbackParsed.state);
      if (verifier) {
        try {
          var tokens = await exchangeCode(callbackParsed.code, callbackParsed.state, verifier);
          setCurrentTokens(tokens);
          var expiresIn = tokens.expiresAt - Date.now();
          await sendMessage(bot, ctx.chat.id,
            '✅ Token renewed. Expires in ' + formatTimeRemaining(expiresIn) + '.', { html: true });
        } catch (err) {
          await sendMessage(bot, ctx.chat.id,
            'Token renewal failed: ' + escapeHtmlSafe(err.message), { html: true });
        }
        return; // Don't send to agent
      }
    }

    // Detect raw authorization codes (20+ chars alphanumeric, optionally code#state)
    if (RAW_CODE_PATTERN.test(text)) {
      var parsed = parseRawCode(text);
      var rawVerifier = parsed.state
        ? getPendingVerifier(parsed.state)
        : getMostRecentVerifier();
      if (rawVerifier) {
        try {
          var rawTokens = await exchangeCode(parsed.code, rawVerifier, rawVerifier);
          setCurrentTokens(rawTokens);
          var rawExpiresIn = rawTokens.expiresAt - Date.now();
          await sendMessage(bot, ctx.chat.id,
            '✅ Token renewed. Expires in ' + formatTimeRemaining(rawExpiresIn) + '.', { html: true });
        } catch (err) {
          await sendMessage(bot, ctx.chat.id,
            'Token renewal failed: ' + escapeHtmlSafe(err.message), { html: true });
        }
        return; // Don't send to agent
      }
    }

    if (!agentBridge.getInstanceId()) {
      // Auto-spawn agent on first message
      try {
        await agentBridge.spawnAgent();
      } catch (err) {
        await sendMessage(bot, ctx.chat.id, 'Failed to start agent: ' + escapeHtmlSafe(err.message), { html: true });
        return;
      }
    }

    // Send typing indicator
    try {
      await ctx.api.sendChatAction(ctx.chat.id, 'typing');
    } catch {
      // Ignore typing indicator errors
    }

    // Persist user message to memory
    if (deps.memory) {
      try { deps.memory.saveMessage(String(ctx.chat.id), 'user', ctx.message.text); } catch {}
    }

    agentBridge.sendPrompt(ctx.message.text);
  });
}

/**
 * Find an instance by ID prefix (first 8+ chars).
 */
function findInstanceByPrefix(instanceManager, prefix) {
  if (!prefix) return null;
  var lowerPrefix = prefix.toLowerCase();
  var all = instanceManager.getAll();
  for (var i = 0; i < all.length; i++) {
    if (all[i].id.toLowerCase().startsWith(lowerPrefix)) return all[i];
  }
  return null;
}

function escapeHtmlSafe(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { registerHandlers };
