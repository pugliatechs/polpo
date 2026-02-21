#!/usr/bin/env node

/**
 * Polpo Notification Hook
 *
 * Called by Claude Code when it wants to notify the user.
 * Forwards the notification to the phone via the bridge.
 *
 * Stdin format (from Claude Code):
 *   { "message": "Task completed successfully" }
 *
 * This hook is fire-and-forget — it never blocks.
 */

const { ensureBridge, send, readStdin } = require('./client');

(async () => {
  try {
    const hookData = await readStdin();
    if (!hookData) {
      process.exit(0);
    }

    const content = hookData.message || hookData.title || JSON.stringify(hookData);
    const sessionId = hookData.session_id || null;
    const transcriptPath = hookData.transcript_path || null;

    const socketPath = await ensureBridge({ cwd: process.cwd() });

    await send(socketPath, {
      type: 'notification',
      content,
      sessionId,
      transcriptPath,
    });

    // Claude Code is idle when it sends a notification (task finished)
    await send(socketPath, {
      type: 'status',
      status: 'idle',
    });
  } catch (e) {
    // Never block Claude Code on errors
  }

  process.exit(0);
})();
