/**
 * PA Configuration — loads and validates Personal Assistant settings.
 *
 * Sources (priority order):
 *   1. Environment variables (POLPO_PA_*)
 *   2. Config file (~/.config/polpo/pa.json)
 *   3. Defaults
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'polpo', 'pa.json');

function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // Ignore invalid config
  }
  return {};
}

function parseAllowFrom(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(function (s) {
      const trimmed = s.trim();
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : trimmed;
    }).filter(Boolean);
  }
  return [];
}

function loadPaConfig() {
  const file = loadConfigFile();
  const fileTelegram = file.telegram || {};
  const fileAgent = file.agent || {};
  const fileAuth = file.auth || {};

  const token = process.env.POLPO_PA_TELEGRAM_TOKEN || fileTelegram.token || null;

  return {
    enabled: Boolean(token),
    telegram: {
      token: token,
      allowFrom: parseAllowFrom(process.env.POLPO_PA_TELEGRAM_ALLOW || fileTelegram.allowFrom),
    },
    agent: {
      type: validateAgentType(process.env.POLPO_PA_AGENT_TYPE || fileAgent.type || 'claude'),
      cwd: process.env.POLPO_PA_AGENT_CWD || fileAgent.cwd || null,
      model: process.env.POLPO_PA_AGENT_MODEL || fileAgent.model || null,
      name: process.env.POLPO_PA_AGENT_NAME || fileAgent.name || 'Personal Assistant',
      allowedTools: parseAllowedTools(process.env.POLPO_PA_ALLOWED_TOOLS || fileAgent.allowedTools),
      idleTimeoutMinutes: parseInt(process.env.POLPO_PA_IDLE_TIMEOUT_MINUTES, 10) || fileAgent.idleTimeoutMinutes || 30,
      promptTimeoutMs: parseInt(process.env.POLPO_PA_PROMPT_TIMEOUT_MS, 10) || fileAgent.promptTimeoutMs || 300000,
      historyInjectCount: parseInt(process.env.POLPO_PA_HISTORY_INJECT_COUNT, 10) || fileAgent.historyInjectCount || 20,
    },
    auth: {
      checkIntervalMinutes: parseInt(process.env.POLPO_PA_AUTH_CHECK_INTERVAL, 10) || fileAuth.checkIntervalMinutes || 5,
      expiryBufferMinutes: parseInt(process.env.POLPO_PA_AUTH_EXPIRY_BUFFER, 10) || fileAuth.expiryBufferMinutes || 15,
      autoRefresh: process.env.POLPO_PA_AUTH_AUTO_REFRESH !== 'false' && fileAuth.autoRefresh !== false,
    },
    notifications: {
      approvals: process.env.POLPO_PA_NOTIFY_APPROVALS !== 'false',
      completions: process.env.POLPO_PA_NOTIFY_COMPLETIONS !== 'false',
    },
  };
}

// PA default tools: web access only. No filesystem tools — the PA is a
// conversational assistant, not a coding agent. Users can add Bash, Read,
// etc. via POLPO_PA_ALLOWED_TOOLS if they want coding capabilities.
var DEFAULT_PA_TOOLS = ['WebFetch', 'WebSearch'];

function parseAllowedTools(value) {
  if (!value) return DEFAULT_PA_TOOLS;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return DEFAULT_PA_TOOLS;
}

var VALID_AGENT_TYPES = ['claude', 'codex', 'gemini', 'opencode', 'pi'];

function validateAgentType(type) {
  if (VALID_AGENT_TYPES.indexOf(type) !== -1) return type;
  console.warn('[pa-config] Invalid agent type "' + type + '", defaulting to "claude"');
  return 'claude';
}

module.exports = { loadPaConfig, CONFIG_PATH, parseAllowFrom, VALID_AGENT_TYPES, validateAgentType };
