const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'polpo');
const VAPID_PATH = path.join(CONFIG_DIR, 'vapid-keys.json');
const SUBS_PATH = path.join(CONFIG_DIR, 'push-subscriptions.json');

class PushManager {
  constructor() {
    this.webpush = null;
    this.subscriptions = [];
    this.lastPushTimes = new Map(); // tag -> timestamp (rate limit)
    this._init();
  }

  _init() {
    try {
      this.webpush = require('web-push');
    } catch {
      // web-push not installed — push disabled
      return;
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true });

    // Load or generate VAPID keys
    let vapidKeys;
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    } catch {
      vapidKeys = this.webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_PATH, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
    }

    this.webpush.setVapidDetails(
      'mailto:polpo@localhost',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    this.vapidPublicKey = vapidKeys.publicKey;

    // Load persisted subscriptions
    try {
      const raw = fs.readFileSync(SUBS_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.subscriptions = parsed.filter(s => s && s.endpoint && typeof s.endpoint === 'string');
      }
    } catch {
      this.subscriptions = [];
    }
  }

  get available() {
    return !!this.webpush;
  }

  addSubscription(sub) {
    if (!sub || !sub.endpoint || typeof sub.endpoint !== 'string') return false;
    // Validate endpoint is HTTPS
    try {
      const url = new URL(sub.endpoint);
      if (url.protocol !== 'https:') return false;
    } catch {
      return false;
    }
    // Deduplicate by endpoint
    const exists = this.subscriptions.some(s => s.endpoint === sub.endpoint);
    if (!exists) {
      this.subscriptions.push(sub);
      this._persist();
    }
    return true;
  }

  removeSubscription(endpoint) {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter(s => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      this._persist();
      return true;
    }
    return false;
  }

  async sendToAll(title, body, tag) {
    if (!this.webpush || this.subscriptions.length === 0) return;

    // Rate limit: 1 push per tag per 5 seconds
    if (tag) {
      const last = this.lastPushTimes.get(tag) || 0;
      if (Date.now() - last < 5000) return;
      this.lastPushTimes.set(tag, Date.now());
    }

    // Sanitize payload
    const payload = JSON.stringify({
      title: String(title || '').slice(0, 80),
      body: String(body || '').slice(0, 100),
      tag: tag || undefined,
    });

    const stale = [];
    const promises = this.subscriptions.map(async (sub, idx) => {
      try {
        await this.webpush.sendNotification(sub, payload, { TTL: 60 });
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          stale.push(idx);
        }
      }
    });
    await Promise.all(promises);

    // Clean up expired subscriptions
    if (stale.length > 0) {
      this.subscriptions = this.subscriptions.filter((_, i) => !stale.includes(i));
      this._persist();
    }
  }

  _persist() {
    try {
      fs.writeFileSync(SUBS_PATH, JSON.stringify(this.subscriptions, null, 2), { mode: 0o600 });
    } catch {
      // Silently fail — subscriptions are still in memory
    }
  }
}

module.exports = { PushManager };
