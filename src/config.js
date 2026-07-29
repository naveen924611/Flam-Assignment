'use strict';

// simple key/value settings, stored in the config table. anything not set
// yet falls back to these defaults.

const { getDb } = require('./db');

const DEFAULTS = {
  'max-retries': '3',
  'backoff-base': '2',
};

function getConfig(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULTS[key];
}

function getAllConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM config').all();
  const merged = { ...DEFAULTS };
  for (const row of rows) merged[row.key] = row.value;
  return merged;
}

function setConfig(key, value) {
  if (!(key in DEFAULTS)) {
    throw new Error(`unknown config key "${key}". known keys: ${Object.keys(DEFAULTS).join(', ')}`);
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

module.exports = { getConfig, getAllConfig, setConfig, DEFAULTS };
