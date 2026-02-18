const { spawn, execFileSync } = require('child_process');

const name = 'cloudflared';

function isAvailable() {
  try {
    execFileSync('which', ['cloudflared'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function start(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGTERM');
        reject(new Error('cloudflared: timed out waiting for tunnel URL (30s)'));
      }
    }, 30000);

    function onData(data) {
      const line = data.toString();
      const match = line.match(urlPattern);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          url: match[0],
          close: () => killChild(child),
        });
      }
    }

    // cloudflared logs the URL to stderr
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

function killChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000);
}

module.exports = { name, isAvailable, start };
