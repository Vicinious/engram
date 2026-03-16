#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ENGRAM_DB || '/var/lib/engram/brain.db';
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function runMigrations() {
  console.log('[migrate] Database:', DB_PATH);
  console.log('[migrate] Migrations:', MIGRATIONS_DIR);
  
  const db = new Database(DB_PATH);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );
  
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('[migrate] No migrations directory found');
    db.close();
    return;
  }
  
  const migrations = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  if (migrations.length === 0) {
    console.log('[migrate] No migrations found');
    db.close();
    return;
  }
  
  let applied_count = 0;
  for (const file of migrations) {
    const version = file.replace('.sql', '');
    
    if (applied.has(version)) {
      console.log(`[migrate] ✓ ${version} (already applied)`);
      continue;
    }
    
    console.log(`[migrate] Applying ${version}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
      console.log(`[migrate] ✓ Applied ${version}`);
      applied_count++;
    } catch (err) {
      console.error(`[migrate] ✗ Failed ${version}:`, err.message);
      db.close();
      process.exit(1);
    }
  }
  
  if (applied_count === 0) {
    console.log('[migrate] All migrations already applied');
  } else {
    console.log(`[migrate] Applied ${applied_count} migration(s)`);
  }
  
  db.close();
}

runMigrations();
