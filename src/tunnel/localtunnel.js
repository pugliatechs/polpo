const name = 'localtunnel';

function isAvailable() {
  return true; // bundled dependency, always available
}

async function start(port) {
  const localtunnel = require('localtunnel');
  const tunnel = await localtunnel({ port });

  return {
    url: tunnel.url,
    close: () => tunnel.close(),
    // Uniform post-startup liveness signal (see cloudflared.js). The
    // localtunnel client is an EventEmitter rather than a child
    // process, so we bridge its 'close' event to the same contract
    // TunnelSupervisor expects from the spawn-based providers.
    onExit: (cb) => tunnel.once('close', cb),
  };
}

module.exports = { name, isAvailable, start };
