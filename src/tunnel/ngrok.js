const { spawn, execFileSync } = require('child_process');
const http = require('http');
const readline = require('readline');

const name = 'ngrok';

function isAvailable() {
  try {
    execFileSync('which', ['ngrok'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function start(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('ngrok', ['http', String(port), '--log=stdout', '--log-format=json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        // Last resort: try the local API
        fetchUrlFromApi()
          .then((url) => {
            if (!resolved) {
              resolved = true;
              resolve({ url, close: () => killChild(child) });
            }
          })
          .catch(() => {
            if (!resolved) {
              resolved = true;
              child.kill('SIGTERM');
              reject(new Error('ngrok: timed out waiting for tunnel URL (15s)'));
            }
          });
      }
    }, 12000);

    // Parse JSON log lines from stdout
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (resolved) return;
      try {
        const entry = JSON.parse(line);
        const url = entry.url || (entry.msg && entry.msg.match(/https:\/\/[^\s"]+\.ngrok[^\s"]*/)?.[0]);
        if (url && url.startsWith('https://')) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ url, close: () => killChild(child) });
        }
      } catch {
        // not JSON, skip
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok: ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`ngrok exited with code ${code}`));
      }
    });
  });
}

function fetchUrlFromApi() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          const tunnel = body.tunnels && body.tunnels.find((t) => t.public_url.startsWith('https://'));
          if (tunnel) resolve(tunnel.public_url);
          else reject(new Error('No HTTPS tunnel found'));
        } catch {
          reject(new Error('Failed to parse ngrok API response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('ngrok API timeout'));
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
