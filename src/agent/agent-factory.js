/**
 * AgentFactory — routes agent creation by type.
 *
 * Supported types:
 *   - 'claude' (default) → WrappedAgent (Claude Code CLI)
 *   - 'codex'            → CodexAgent (OpenAI Codex CLI)
 *   - 'gemini'           → GeminiAgent (Google Gemini CLI)
 *   - 'opencode'         → OpencodeAgent (OpenCode CLI)
 *   - 'pi'               → PiAgent (Pi coding agent RPC mode)
 */

function createAgent(type, options) {
  if (type === 'codex') {
    const { CodexAgent } = require('./codex-agent');
    return new CodexAgent(options);
  }
  if (type === 'gemini') {
    const { GeminiAgent } = require('./gemini-agent');
    return new GeminiAgent(options);
  }
  if (type === 'opencode') {
    const { OpencodeAgent } = require('./opencode-agent');
    return new OpencodeAgent(options);
  }
  if (type === 'pi') {
    const { PiAgent } = require('./pi-agent');
    return new PiAgent(options);
  }
  const { WrappedAgent } = require('./wrapped');
  return new WrappedAgent(options);
}

module.exports = { createAgent };
