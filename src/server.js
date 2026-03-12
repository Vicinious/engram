#!/usr/bin/env node
/**
 * Engram Server - Persistent Memory Service
 * 
 * Main daemon process that maintains agent memory state.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Configuration
const CONFIG = {
  port: parseInt(process.env.ENGRAM_PORT || '18850'),
  socketPath: process.env.ENGRAM_SOCKET || '/var/run/engram/engram.sock',
  dbPath: process.env.ENGRAM_DB || '/var/lib/engram/brain.db',
  logPath: process.env.ENGRAM_LOG || '/var/log/engram/engram.log',
  maxInjectionTokens: 1500,  // Approximate token limit for context injection
  maxInjectionBytes: 6000    // ~4 chars per token
};

// Ensure directories exist
const ensureDir = (filepath) => {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Initialize database
let db;
const initDatabase = () => {
  ensureDir(CONFIG.dbPath);
  db = new Database(CONFIG.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  // Run schema
  const schemaPath = path.join(__dirname, '..', 'schemas', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  }
  
  console.log(`[engram] Database initialized: ${CONFIG.dbPath}`);
};

// Express app
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

// Status endpoint
app.get('/api/v1/status', (req, res) => {
  const agents = db.prepare('SELECT COUNT(*) as count FROM agents WHERE is_active = 1').get();
  const memories = db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_active = 1').get();
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE state = ?').get('active');
  
  res.json({
    version: '0.1.0',
    status: 'running',
    agents: agents.count,
    memories: memories.count,
    activeSessions: sessions.count,
    dbPath: CONFIG.dbPath,
    uptime: process.uptime()
  });
});

// Wake endpoint - get context injection for agent
app.post('/api/v1/wake', (req, res) => {
  const { agent, session_id } = req.body;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    // Update agent last_seen
    db.prepare('UPDATE agents SET last_seen = CURRENT_TIMESTAMP, current_session_id = ? WHERE id = ?')
      .run(session_id, agent);
    
    // Get active tasks
    const tasks = db.prepare(`
      SELECT content, priority, created_at 
      FROM memories 
      WHERE agent_id = ? AND type = 'task' AND is_active = 1
      ORDER BY priority DESC, created_at DESC
      LIMIT 5
    `).all(agent);
    
    // Get recent decisions
    const decisions = db.prepare(`
      SELECT content, metadata_json, created_at
      FROM memories
      WHERE agent_id = ? AND type = 'decision' AND is_active = 1
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT 5
    `).all(agent);
    
    // Get active corrections
    const corrections = db.prepare(`
      SELECT original_behavior, corrected_behavior, severity
      FROM corrections
      WHERE agent_id = ? AND is_active = 1
      ORDER BY severity DESC, created_at DESC
      LIMIT 5
    `).all(agent);
    
    // Get forgotten tools
    const forgottenTools = db.prepare(`
      SELECT tool_name, 
             CAST(julianday('now') - julianday(last_used) AS INTEGER) as days_ago
      FROM tool_usage
      WHERE agent_id = ? 
        AND expected_frequency IN ('session_start', 'daily')
        AND julianday('now') - julianday(last_used) > 1
      ORDER BY days_ago DESC
      LIMIT 5
    `).all(agent);
    
    // Build injection
    let injection = `## 🧠 Engram Context Injection\n`;
    injection += `*Sync: ${new Date().toISOString()} | Agent: ${agent}*\n\n`;
    
    if (tasks.length > 0) {
      injection += `### Active Tasks (${tasks.length})\n`;
      tasks.forEach((t, i) => {
        const priority = t.priority >= 8 ? 'HIGH' : t.priority >= 5 ? 'MED' : 'LOW';
        injection += `${i+1}. [${priority}] ${t.content}\n`;
      });
      injection += '\n';
    }
    
    if (decisions.length > 0) {
      injection += `### Recent Decisions\n`;
      decisions.forEach(d => {
        const meta = d.metadata_json ? JSON.parse(d.metadata_json) : {};
        const date = d.created_at.split('T')[0];
        injection += `- **${d.content}** ${meta.reason ? `— ${meta.reason}` : ''} (${date})\n`;
      });
      injection += '\n';
    }
    
    if (corrections.length > 0) {
      injection += `### Active Corrections\n`;
      corrections.forEach(c => {
        const icon = c.severity === 'critical' ? '🔴' : c.severity === 'high' ? '🟠' : '⚠️';
        injection += `${icon} ${c.corrected_behavior}\n`;
      });
      injection += '\n';
    }
    
    if (forgottenTools.length > 0) {
      injection += `### Tools You Keep Forgetting\n`;
      forgottenTools.forEach(t => {
        injection += `- \`${t.tool_name}\` (${t.days_ago}d since use)\n`;
      });
      injection += '\n';
    }
    
    // Record injection
    const stmt = db.prepare(`
      INSERT INTO injections (agent_id, session_id, injection_content, memory_count, token_estimate)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(agent, session_id, injection, tasks.length + decisions.length + corrections.length, Math.ceil(injection.length / 4));
    
    res.json({
      injection,
      memories_count: tasks.length + decisions.length + corrections.length,
      injection_tokens: Math.ceil(injection.length / 4)
    });
    
  } catch (err) {
    console.error('[engram] Wake error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remember endpoint - store a memory
app.post('/api/v1/remember', (req, res) => {
  const { agent, type, content, priority, metadata, tags, expires_in } = req.body;
  
  if (!agent || !type || !content) {
    return res.status(400).json({ error: 'agent, type, and content are required' });
  }
  
  try {
    const stmt = db.prepare(`
      INSERT INTO memories (agent_id, type, content, priority, metadata_json, tags, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    let expiresAt = null;
    if (expires_in) {
      const now = new Date();
      now.setSeconds(now.getSeconds() + parseInt(expires_in));
      expiresAt = now.toISOString();
    }
    
    const result = stmt.run(
      agent,
      type,
      content,
      priority || 5,
      metadata ? JSON.stringify(metadata) : null,
      tags ? JSON.stringify(tags) : null,
      expiresAt
    );
    
    res.json({ id: result.lastInsertRowid, stored: true });
    
  } catch (err) {
    console.error('[engram] Remember error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Decide endpoint - record a decision
app.post('/api/v1/decide', (req, res) => {
  const { agent, decision, reason, alternatives } = req.body;
  
  if (!agent || !decision) {
    return res.status(400).json({ error: 'agent and decision are required' });
  }
  
  try {
    const stmt = db.prepare(`
      INSERT INTO memories (agent_id, type, content, priority, metadata_json)
      VALUES (?, 'decision', ?, 8, ?)
    `);
    
    const result = stmt.run(
      agent,
      decision,
      JSON.stringify({ reason, alternatives })
    );
    
    res.json({ id: result.lastInsertRowid, stored: true });
    
  } catch (err) {
    console.error('[engram] Decide error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Correct endpoint - log a correction
app.post('/api/v1/correct', (req, res) => {
  const { agent, original, corrected, reason, severity } = req.body;
  
  if (!agent || !original || !corrected) {
    return res.status(400).json({ error: 'agent, original, and corrected are required' });
  }
  
  try {
    const stmt = db.prepare(`
      INSERT INTO corrections (agent_id, original_behavior, corrected_behavior, reason, severity)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(agent, original, corrected, reason, severity || 'medium');
    
    res.json({ id: result.lastInsertRowid, stored: true });
    
  } catch (err) {
    console.error('[engram] Correct error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Recall endpoint - search memories
app.get('/api/v1/recall', (req, res) => {
  const { q, agent, type, limit } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'query (q) is required' });
  }
  
  try {
    let sql = `
      SELECT m.id, m.agent_id, m.type, m.content, m.priority, m.created_at, m.metadata_json,
             highlight(memories_fts, 0, '<mark>', '</mark>') as highlight
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.id
      WHERE memories_fts MATCH ?
        AND m.is_active = 1
    `;
    const params = [q];
    
    if (agent) {
      sql += ' AND m.agent_id = ?';
      params.push(agent);
    }
    
    if (type) {
      sql += ' AND m.type = ?';
      params.push(type);
    }
    
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(parseInt(limit) || 10);
    
    const results = db.prepare(sql).all(...params);
    
    res.json({ results, count: results.length });
    
  } catch (err) {
    console.error('[engram] Recall error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Log tool usage
app.post('/api/v1/tool-used', (req, res) => {
  const { agent, tool } = req.body;
  
  if (!agent || !tool) {
    return res.status(400).json({ error: 'agent and tool are required' });
  }
  
  try {
    const stmt = db.prepare(`
      INSERT INTO tool_usage (agent_id, tool_name, invocation_count, last_used)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(agent_id, tool_name) DO UPDATE SET
        invocation_count = invocation_count + 1,
        last_used = CURRENT_TIMESTAMP
    `);
    
    stmt.run(agent, tool);
    res.json({ logged: true });
    
  } catch (err) {
    console.error('[engram] Tool usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List memories for an agent
app.get('/api/v1/agent/:id/memories', (req, res) => {
  const { id } = req.params;
  const { type, active, limit, offset } = req.query;
  
  try {
    let sql = 'SELECT * FROM memories WHERE agent_id = ?';
    const params = [id];
    
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    
    if (active !== undefined) {
      sql += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }
    
    sql += ' ORDER BY priority DESC, created_at DESC';
    sql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);
    
    const memories = db.prepare(sql).all(...params);
    res.json({ memories, count: memories.length });
    
  } catch (err) {
    console.error('[engram] List memories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete/deactivate a memory
app.delete('/api/v1/memory/:id', (req, res) => {
  const { id } = req.params;
  const { hard } = req.query;
  
  try {
    if (hard === 'true') {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    } else {
      db.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(id);
    }
    
    res.json({ deleted: true });
    
  } catch (err) {
    console.error('[engram] Delete memory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const startServer = () => {
  initDatabase();
  
  app.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`[engram] Server running on http://127.0.0.1:${CONFIG.port}`);
    console.log(`[engram] Database: ${CONFIG.dbPath}`);
  });
};

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[engram] Shutting down...');
  if (db) db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[engram] Interrupted, shutting down...');
  if (db) db.close();
  process.exit(0);
});

startServer();
