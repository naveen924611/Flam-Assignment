'use strict';

// this file just opens the db connection and makes sure the tables exist

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_DIR = path.join(__dirname, '..', 'DB');
const DB_PATH = path.join(DB_DIR, 'queuectl.db');
const SCHEMA_PATH = path.join(DB_DIR, 'schema.sql');

let db = null;

function getDb() {
  if (db) return db;

  // make sure the DB folder exists before opening the file
  fs.mkdirSync(DB_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);

  // WAL mode lets multiple workers read/write without locking each other out
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // run schema.sql once on startup so the tables always exist
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  return db;
}

module.exports = { getDb };