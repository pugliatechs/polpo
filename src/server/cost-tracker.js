/**
 * CostTracker — persists per-turn cost records to a JSONL file
 * and provides aggregation helpers for the dashboard.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const COST_DIR = path.join(os.homedir(), '.config', 'polpo');
const COST_FILE = path.join(COST_DIR, 'costs.jsonl');
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

class CostTracker {
  constructor() {
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(COST_DIR, { recursive: true });
    } catch {
      // ignore
    }
  }

  /**
   * Append a cost record.
   * @param {{ cost: number, model?: string, instance?: string, project?: string }} record
   */
  record(record) {
    const entry = {
      ts: Date.now(),
      cost: record.cost,
      model: record.model || null,
      instance: record.instance || null,
      project: record.project || null,
    };
    try {
      fs.appendFileSync(COST_FILE, JSON.stringify(entry) + '\n');
    } catch {
      // ignore write errors (disk full, etc.)
    }
  }

  /**
   * Read all records (streaming, memory-efficient).
   * Prunes entries older than MAX_AGE_MS.
   * @returns {Promise<Array>}
   */
  async readAll() {
    if (!fs.existsSync(COST_FILE)) return [];

    const cutoff = Date.now() - MAX_AGE_MS;
    const records = [];

    const stream = fs.createReadStream(COST_FILE, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.ts >= cutoff) {
          records.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }

    return records;
  }

  /**
   * Aggregate cost data for the dashboard.
   * @returns {Promise<Object>}
   */
  async aggregate() {
    const records = await this.readAll();
    const now = Date.now();
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayMs = startOfDay.getTime();
    const weekMs = todayMs - 6 * 24 * 60 * 60 * 1000;
    const monthMs = todayMs - 29 * 24 * 60 * 60 * 1000;

    let total = 0, today = 0, thisWeek = 0, thisMonth = 0;
    const byDay = {};
    const byProject = {};

    for (const r of records) {
      const cost = r.cost || 0;
      total += cost;
      if (r.ts >= todayMs) today += cost;
      if (r.ts >= weekMs) thisWeek += cost;
      if (r.ts >= monthMs) thisMonth += cost;

      // Group by day
      const dayKey = new Date(r.ts).toISOString().slice(0, 10);
      if (!byDay[dayKey]) byDay[dayKey] = { cost: 0, count: 0 };
      byDay[dayKey].cost += cost;
      byDay[dayKey].count++;

      // Group by project
      const proj = r.project || 'unknown';
      if (!byProject[proj]) byProject[proj] = 0;
      byProject[proj] += cost;
    }

    // Convert byDay to sorted array (last 30 days)
    const dayEntries = Object.entries(byDay)
      .map(function (e) { return { date: e[0], cost: e[1].cost, count: e[1].count }; })
      .sort(function (a, b) { return a.date.localeCompare(b.date); })
      .slice(-30);

    // Convert byProject to sorted array
    const projectEntries = Object.entries(byProject)
      .map(function (e) { return { project: e[0], cost: e[1] }; })
      .sort(function (a, b) { return b.cost - a.cost; });

    return {
      total: round4(total),
      today: round4(today),
      thisWeek: round4(thisWeek),
      thisMonth: round4(thisMonth),
      byDay: dayEntries,
      byProject: projectEntries,
      recordCount: records.length,
    };
  }

  /**
   * Prune old entries (rewrite file without entries older than MAX_AGE_MS).
   */
  async prune() {
    const records = await this.readAll();
    try {
      fs.writeFileSync(COST_FILE, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
    } catch {
      // ignore
    }
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = { CostTracker };
