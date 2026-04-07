const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ReminderService, parseRelativeTime, formatDueTime } = require('../src/pa/reminders');

describe('ReminderService', () => {
  let db;
  let service;
  let fired;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    fired = [];
    service = new ReminderService({
      db: db,
      onDue: function (r) { fired.push(r); },
    });
  });

  afterEach(() => {
    service.stop();
    db.close();
  });

  it('adds a reminder', () => {
    var r = service.add('chat1', 'Test reminder', Date.now() + 60000);
    assert.ok(r.id > 0);
    assert.equal(r.text, 'Test reminder');
  });

  it('rejects past due time', () => {
    assert.throws(() => service.add('chat1', 'Late', Date.now() - 1000), /future/);
  });

  it('lists pending reminders', () => {
    service.add('chat1', 'First', Date.now() + 60000);
    service.add('chat1', 'Second', Date.now() + 120000);
    service.add('chat2', 'Other chat', Date.now() + 60000);
    var list = service.list('chat1');
    assert.equal(list.length, 2);
    assert.equal(list[0].text, 'First');
  });

  it('removes a reminder', () => {
    var r = service.add('chat1', 'To remove', Date.now() + 60000);
    assert.equal(service.remove(r.id), true);
    assert.equal(service.list('chat1').length, 0);
  });

  it('remove returns false for nonexistent', () => {
    assert.equal(service.remove(999), false);
  });

  it('fires due reminders', () => {
    // Insert a reminder already past-due via SQL directly
    db.prepare(
      'INSERT INTO reminders (chat_id, text, due_at, created_at, fired) VALUES (?, ?, ?, ?, 0)'
    ).run('chat1', 'Due now', Date.now() - 1000, Date.now() - 2000);
    service._checkDue();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].text, 'Due now');
  });

  it('does not fire future reminders', () => {
    service.add('chat1', 'Future', Date.now() + 60000);
    service._checkDue();
    assert.equal(fired.length, 0);
  });

  it('does not double-fire', () => {
    db.prepare(
      'INSERT INTO reminders (chat_id, text, due_at, created_at, fired) VALUES (?, ?, ?, ?, 0)'
    ).run('chat1', 'Once', Date.now() - 1000, Date.now() - 2000);
    service._checkDue();
    service._checkDue();
    assert.equal(fired.length, 1);
  });

  it('cleanup removes old fired reminders', () => {
    db.prepare(
      'INSERT INTO reminders (chat_id, text, due_at, created_at, fired) VALUES (?, ?, ?, ?, 0)'
    ).run('chat1', 'Old', Date.now() - 1000, Date.now() - 2000);
    service._checkDue(); // Fire it
    assert.equal(fired.length, 1);
    // Set due_at to 8 days ago so cleanup picks it up
    db.prepare('UPDATE reminders SET due_at = ? WHERE id = 1').run(Date.now() - 8 * 86400000);
    service.cleanup();
    var rows = db.prepare('SELECT * FROM reminders WHERE id = 1').all();
    assert.equal(rows.length, 0);
  });
});

describe('parseRelativeTime', () => {
  it('parses "30m"', () => {
    var t = parseRelativeTime('30m');
    assert.ok(t);
    var diff = t - Date.now();
    assert.ok(diff > 29 * 60000 && diff < 31 * 60000);
  });

  it('parses "2h"', () => {
    var t = parseRelativeTime('2h');
    assert.ok(t);
    var diff = t - Date.now();
    assert.ok(diff > 119 * 60000 && diff < 121 * 60000);
  });

  it('parses "1d"', () => {
    var t = parseRelativeTime('1d');
    assert.ok(t);
    var diff = t - Date.now();
    assert.ok(diff > 23 * 3600000 && diff < 25 * 3600000);
  });

  it('parses "in 5 minutes"', () => {
    var t = parseRelativeTime('in 5 minutes');
    assert.ok(t);
    var diff = t - Date.now();
    assert.ok(diff > 4 * 60000 && diff < 6 * 60000);
  });

  it('parses "in 1 hour"', () => {
    var t = parseRelativeTime('in 1 hour');
    assert.ok(t);
  });

  it('returns null for unparseable', () => {
    assert.equal(parseRelativeTime('blah'), null);
    assert.equal(parseRelativeTime(''), null);
    assert.equal(parseRelativeTime(null), null);
  });
});

describe('formatDueTime', () => {
  it('formats seconds', () => {
    assert.equal(formatDueTime(Date.now() + 30000), '30s');
  });

  it('formats minutes', () => {
    assert.equal(formatDueTime(Date.now() + 5 * 60000), '5min');
  });

  it('formats hours and minutes', () => {
    var result = formatDueTime(Date.now() + 90 * 60000);
    assert.ok(result.includes('1h'));
  });

  it('formats days', () => {
    assert.equal(formatDueTime(Date.now() + 2 * 86400000), '2d');
  });

  it('formats now for past time', () => {
    assert.equal(formatDueTime(Date.now() - 1000), 'now');
  });
});
