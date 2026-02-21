#!/usr/bin/env node

/**
 * Polpo UserPromptSubmit Hook
 *
 * Called by Claude Code when the user submits a prompt in the terminal.
 * Forwards the prompt text to the bridge so the phone sees it.
 *
 * Stdin format (from Claude Code):
 *   { "session_id": "...", "transcript_path": "...", "prompt": "..." }
 *
 * This hook is fire-and-forget — it never blocks.
 */

const { ensureBridge, send, readStdin } = require('./client');

(async () => {
  try {
    const hookData = await readStdin();
    if (!hookData || !hookData.prompt) {
      process.exit(0);
    }

    const socketPath = await ensureBridge({ cwd: process.cwd() });

    await send(socketPath, {
      type: 'user_prompt',
      prompt: hookData.prompt,
      sessionId: hookData.session_id || null,
      transcriptPath: hookData.transcript_path || null,
    });
  } catch (e) {
    // Never block Claude Code on errors
  }

  process.exit(0);
})();
