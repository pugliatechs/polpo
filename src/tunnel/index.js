const cloudflared = require('./cloudflared');
const localtunnel = require('./localtunnel');
const ngrok = require('./ngrok');
const ssh = require('./ssh');
const { makeLogger } = require('../util/logger');

const log = makeLogger('tunnel');

const PROVIDERS = { cloudflared, localtunnel, ngrok, ssh };

// Auto-detect order (ssh and ngrok excluded: require explicit config)
const AUTO_DETECT = [cloudflared, localtunnel];

/**
 * Start a tunnel to expose a local port to the internet.
 *
 * @param {object} opts
 * @param {string|boolean} opts.provider - Provider name or `true` for auto-detect
 * @param {number} opts.port - Local port to tunnel
 * @param {string} [opts.tunnelHost] - SSH host (required for ssh provider)
 * @param {number} [opts.tunnelPort] - Remote port for SSH tunnel (default: 80)
 * @returns {Promise<{ url: string, close: () => void }>}
 */
async function startTunnel(opts) {
  const { provider, port, tunnelHost, tunnelPort } = opts;

  // Explicit provider
  if (typeof provider === 'string') {
    const p = PROVIDERS[provider];
    if (!p) {
      const available = Object.keys(PROVIDERS).join(', ');
      throw new Error(`Unknown tunnel provider "${provider}". Available: ${available}`);
    }
    if (!p.isAvailable()) {
      throw new Error(`${provider} is not available. ${installHint(provider)}`);
    }
    log.info(`Starting ${provider} tunnel...`);
    return p.start(port, { tunnelHost, tunnelPort });
  }

  // Auto-detect
  for (const p of AUTO_DETECT) {
    if (!p.isAvailable()) continue;
    log.info(`Trying ${p.name}...`);
    try {
      const result = await p.start(port, { tunnelHost, tunnelPort });
      return result;
    } catch (err) {
      log.warn(`${p.name} failed: ${err.message}`);
    }
  }

  throw new Error(
    'No tunnel provider available.\n' +
    '  Install one of:\n' +
    '    cloudflared  — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
    '    localtunnel  — bundled (should always work, check npm install)\n' +
    '    ngrok        — https://ngrok.com/download\n' +
    '  Or use SSH:  --tunnel ssh --tunnel-host user@server'
  );
}

function installHint(provider) {
  switch (provider) {
    case 'cloudflared':
      return 'Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
    case 'ngrok':
      return 'Install: https://ngrok.com/download';
    case 'ssh':
      return 'SSH should be available on most systems. Check your PATH.';
    default:
      return '';
  }
}

module.exports = { startTunnel };
