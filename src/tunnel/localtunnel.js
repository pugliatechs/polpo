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
  };
}

module.exports = { name, isAvailable, start };
