#!/usr/bin/env node
/**
 * Engram Server - Persistent Memory Service
 * 
 * Main daemon process that maintains agent memory state.
 * v0.2.0 - Added semantic embeddings for vector search
 * v0.3.0 - Added pattern learning and auto-corrections
 * v0.4.0 - Added hive-mind cross-agent knowledge propagation
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Embeddings service (lazy loaded)
let embeddings = null;
const getEmbeddings = () => {
  if (!embeddings) {
    embeddings = require('./services/embeddings');
  }
  return embeddings;
};

// Configuration
const CONFIG = {
  port: parseInt(process.env.ENGRAM_PORT || '18850'),
  socketPath: process.env.ENGRAM_SOCKET || '/var/run/engram/engram.sock',
  dbPath: process.env.ENGRAM_DB || '/var/lib/engram/brain.db',
  logPath: process.env.ENGRAM_LOG || '/var/log/engram/engram.log',
  maxInjectionTokens: 1500,
  maxInjectionBytes: 6000,
  dedupeThreshold: 0.85,  // Similarity threshold for deduplication
  semanticSearchMinScore: 0.4  // Minimum score for semantic search results
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
  
  // Migration: Add embedding column if not exists
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB`);
    console.log('[engram] Added embedding column');
  } catch (e) {
    // Column already exists
  }
  
  // Migration: Add embedded flag
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN is_embedded BOOLEAN DEFAULT 0`);
    console.log('[engram] Added is_embedded column');
  } catch (e) {
    // Column already exists
  }
  
  console.log(`[engram] Database initialized: ${CONFIG.dbPath}`);
};

// Express app
const app = express();
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.4.0' });
});

// Status endpoint
app.get('/api/v1/status', (req, res) => {
  const { channel } = req.query;
  const agents = db.prepare('SELECT COUNT(*) as count FROM agents WHERE is_active = 1').get();
  const memories = channel
    ? db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_active = 1 AND (channel = ? OR channel IS NULL)`).get(channel)
    : db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_active = 1').get();
  const embedded = channel
    ? db.prepare(`SELECT COUNT(*) as count FROM memories WHERE is_embedded = 1 AND is_active = 1 AND (channel = ? OR channel IS NULL)`).get(channel)
    : db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_embedded = 1').get();
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE state = ?').get('active');
  
  // Pattern stats (may fail if tables don't exist yet)
  let patternStats = { patterns: 0, unresolvedDeviations: 0, pendingAutoCorrections: 0 };
  try {
    const analyzer = getPatternAnalyzer();
    patternStats = analyzer.getStats();
  } catch (e) {
    // Pattern tables may not exist yet
  }
  
  // Hive stats (may fail if tables don't exist yet)
  let hiveStats = { pendingPropagations: 0, hiveMemories: 0 };
  try {
    const hive = getHiveMind();
    hiveStats = hive.getStats();
  } catch (e) {
    // Hive tables may not exist yet
  }
  
  res.json({
    version: '0.4.0',
    status: 'running',
    agents: agents.count,
    memories: memories.count,
    embeddedMemories: embedded.count,
    activeSessions: sessions.count,
    patterns: patternStats.patterns,
    pendingAutoCorrections: patternStats.pendingAutoCorrections,
    unresolvedDeviations: patternStats.unresolvedDeviations,
    pendingPropagations: hiveStats.pendingPropagations,
    hiveMemories: hiveStats.hiveMemories,
    channel: channel || null,
    dbPath: CONFIG.dbPath,
    uptime: process.uptime(),
    semanticSearch: true,
    patternLearning: true,
    hiveMind: true
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
    
    // Get recent hive knowledge
    try {
      const hive = getHiveMind();
      const hiveKnowledge = db.prepare(`
        SELECT content, json_extract(metadata_json, '$.source_agent') as source,
               json_extract(metadata_json, '$.knowledge_type') as ktype
        FROM memories 
        WHERE agent_id = ? 
          AND is_active = 1 
          AND json_extract(metadata_json, '$.from_hive') = 1
          AND created_at > datetime('now', '-7 days')
        ORDER BY created_at DESC
        LIMIT 5
      `).all(agent);
      
      if (hiveKnowledge.length > 0) {
        injection += `### 🐝 Recent Hive Knowledge\n`;
        hiveKnowledge.forEach(h => {
          const icon = h.ktype === 'correction' ? '🔴' : h.ktype === 'warning' ? '⚠️' : '💡';
          injection += `${icon} ${h.content.replace(/^\[From \w+\]\s*/, '')} _(via ${h.source})_\n`;
        });
        injection += '\n';
      }
    } catch (e) {
      // Hive not available yet
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

// Check for duplicates using semantic similarity
async function findDuplicates(content, agentId, type) {
  const emb = getEmbeddings();
  
  // Get recent memories of same type for this agent
  const candidates = db.prepare(`
    SELECT id, content, embedding
    FROM memories
    WHERE agent_id = ? AND type = ? AND is_active = 1 AND is_embedded = 1
    ORDER BY created_at DESC
    LIMIT 50
  `).all(agentId, type);
  
  if (candidates.length === 0) return null;
  
  // Embed the new content
  const queryVec = await emb.embed(content);
  
  // Check similarity against candidates
  for (const cand of candidates) {
    if (!cand.embedding) continue;
    const candVec = emb.deserializeEmbedding(cand.embedding);
    const similarity = emb.cosineSimilarity(queryVec, candVec);
    
    if (similarity >= CONFIG.dedupeThreshold) {
      return { id: cand.id, content: cand.content, similarity };
    }
  }
  
  return null;
}

// Remember endpoint - store a memory with embedding
app.post('/api/v1/remember', async (req, res) => {
  const { agent, type, content, priority, metadata, tags, expires_in, skipDedupe, channel } = req.body;
  
  if (!agent || !type || !content) {
    return res.status(400).json({ error: 'agent, type, and content are required' });
  }
  
  try {
    // Check for duplicates (unless skipped)
    if (!skipDedupe) {
      const dupe = await findDuplicates(content, agent, type);
      if (dupe) {
        return res.json({
          id: dupe.id,
          stored: false,
          deduplicated: true,
          similarity: dupe.similarity.toFixed(3),
          existingContent: dupe.content
        });
      }
    }
    
    // Generate embedding
    const emb = getEmbeddings();
    const embedding = await emb.embed(content);
    const embeddingBuffer = emb.serializeEmbedding(embedding);
    
    let expiresAt = null;
    if (expires_in) {
      const now = new Date();
      now.setSeconds(now.getSeconds() + parseInt(expires_in));
      expiresAt = now.toISOString();
    }
    
    const stmt = db.prepare(`
      INSERT INTO memories (agent_id, type, content, priority, metadata_json, tags, expires_at, embedding, is_embedded, channel)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    
    const result = stmt.run(
      agent,
      type,
      content,
      priority || 5,
      metadata ? JSON.stringify(metadata) : null,
      tags ? JSON.stringify(tags) : null,
      expiresAt,
      embeddingBuffer,
      channel || 'default'
    );
    
    res.json({ id: result.lastInsertRowid, stored: true, embedded: true });
    
  } catch (err) {
    console.error('[engram] Remember error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Decide endpoint - record a decision with embedding
app.post('/api/v1/decide', async (req, res) => {
  const { agent, decision, reason, alternatives, channel } = req.body;
  
  if (!agent || !decision) {
    return res.status(400).json({ error: 'agent and decision are required' });
  }
  
  try {
    // Check for duplicate decisions
    const dupe = await findDuplicates(decision, agent, 'decision');
    if (dupe) {
      return res.json({
        id: dupe.id,
        stored: false,
        deduplicated: true,
        similarity: dupe.similarity.toFixed(3)
      });
    }
    
    // Generate embedding
    const emb = getEmbeddings();
    const embedding = await emb.embed(decision);
    const embeddingBuffer = emb.serializeEmbedding(embedding);
    
    const stmt = db.prepare(`
      INSERT INTO memories (agent_id, type, content, priority, metadata_json, embedding, is_embedded, channel)
      VALUES (?, 'decision', ?, 8, ?, ?, 1, ?)
    `);
    
    const result = stmt.run(
      agent,
      decision,
      JSON.stringify({ reason, alternatives }),
      embeddingBuffer,
      channel || 'default'
    );
    
    res.json({ id: result.lastInsertRowid, stored: true, embedded: true });
    
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

// Recall endpoint - FTS search (fallback)
app.get('/api/v1/recall', (req, res) => {
  const { q, agent, type, limit, channel } = req.query;
  
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

    if (channel) {
      sql += ' AND (m.channel = ? OR m.channel IS NULL)';
      params.push(channel);
    }
    
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(parseInt(limit) || 10);
    
    const results = db.prepare(sql).all(...params);
    
    res.json({ results, count: results.length, searchType: 'fts' });
    
  } catch (err) {
    console.error('[engram] Recall error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Semantic search endpoint - vector similarity search
app.get('/api/v1/search', async (req, res) => {
  const { q, agent, type, limit, minScore } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'query (q) is required' });
  }
  
  try {
    const emb = getEmbeddings();
    
    // Get embedded memories
    let sql = `
      SELECT id, agent_id, type, content, priority, created_at, metadata_json, embedding
      FROM memories
      WHERE is_active = 1 AND is_embedded = 1
    `;
    const params = [];
    
    if (agent) {
      sql += ' AND agent_id = ?';
      params.push(agent);
    }
    
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    
    const candidates = db.prepare(sql).all(...params);
    
    if (candidates.length === 0) {
      return res.json({ results: [], count: 0, searchType: 'semantic' });
    }
    
    // Embed query
    const queryVec = await emb.embed(q);
    
    // Score all candidates
    const scored = candidates
      .map(m => ({
        id: m.id,
        agent_id: m.agent_id,
        type: m.type,
        content: m.content,
        priority: m.priority,
        created_at: m.created_at,
        metadata_json: m.metadata_json,
        score: emb.cosineSimilarity(queryVec, emb.deserializeEmbedding(m.embedding))
      }))
      .filter(m => m.score >= (parseFloat(minScore) || CONFIG.semanticSearchMinScore))
      .sort((a, b) => b.score - a.score)
      .slice(0, parseInt(limit) || 10);
    
    // Format scores
    const results = scored.map(m => ({
      ...m,
      score: parseFloat(m.score.toFixed(4))
    }));
    
    res.json({ results, count: results.length, searchType: 'semantic' });
    
  } catch (err) {
    console.error('[engram] Semantic search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Embed existing memories (background task)
app.post('/api/v1/embed-backlog', async (req, res) => {
  const { limit } = req.body;
  const batchSize = parseInt(limit) || 50;
  
  try {
    const emb = getEmbeddings();
    
    // Get unembedded memories
    const memories = db.prepare(`
      SELECT id, content
      FROM memories
      WHERE is_embedded = 0 OR is_embedded IS NULL
      LIMIT ?
    `).all(batchSize);
    
    if (memories.length === 0) {
      return res.json({ embedded: 0, message: 'All memories are embedded' });
    }
    
    const updateStmt = db.prepare(`
      UPDATE memories SET embedding = ?, is_embedded = 1 WHERE id = ?
    `);
    
    let count = 0;
    for (const mem of memories) {
      const embedding = await emb.embed(mem.content);
      const buffer = emb.serializeEmbedding(embedding);
      updateStmt.run(buffer, mem.id);
      count++;
    }
    
    res.json({ embedded: count, remaining: db.prepare('SELECT COUNT(*) as c FROM memories WHERE is_embedded = 0 OR is_embedded IS NULL').get().c });
    
  } catch (err) {
    console.error('[engram] Embed backlog error:', err);
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
    let sql = 'SELECT id, agent_id, type, content, priority, created_at, metadata_json, is_embedded FROM memories WHERE agent_id = ?';
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

// ============================================
// PATTERN LEARNING ENDPOINTS (v0.3.0)
// ============================================

// Lazy load pattern analyzer
let patternAnalyzer = null;
const getPatternAnalyzer = () => {
  if (!patternAnalyzer) {
    const { PatternAnalyzer } = require('./services/patterns');
    patternAnalyzer = new PatternAnalyzer(db);
  }
  return patternAnalyzer;
};

// Analyze a session log
app.post('/api/v1/analyze-session', (req, res) => {
  const { agent, session_id, events } = req.body;
  
  if (!agent || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: 'agent and events array are required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const result = analyzer.analyzeSession(agent, session_id, events);
    
    res.json({
      analyzed: true,
      ...result
    });
  } catch (err) {
    console.error('[engram] Analyze session error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Detect deviations for current session
app.post('/api/v1/detect-deviations', (req, res) => {
  const { agent, session } = req.body;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const deviations = analyzer.detectDeviations(agent, session || []);
    
    res.json({
      deviations,
      count: deviations.length
    });
  } catch (err) {
    console.error('[engram] Detect deviations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get learned patterns for an agent
app.get('/api/v1/patterns', (req, res) => {
  const { agent, type } = req.query;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const patterns = analyzer.getPatterns(agent, type);
    
    res.json({
      patterns,
      count: patterns.length
    });
  } catch (err) {
    console.error('[engram] Get patterns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add a manual pattern
app.post('/api/v1/patterns', (req, res) => {
  const { agent, type, pattern, description, confidence } = req.body;
  
  if (!agent || !type || !pattern) {
    return res.status(400).json({ error: 'agent, type, and pattern are required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const id = analyzer.addPattern(agent, type, pattern, description, confidence);
    
    res.json({ id, stored: true });
  } catch (err) {
    console.error('[engram] Add pattern error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get pending auto-corrections (repeated mistakes not yet promoted)
app.get('/api/v1/auto-corrections', (req, res) => {
  const { agent } = req.query;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const pending = analyzer.getPendingAutoCorrections(agent);
    
    res.json({
      autoCorrections: pending,
      count: pending.length
    });
  } catch (err) {
    console.error('[engram] Get auto-corrections error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get recent deviations
app.get('/api/v1/deviations', (req, res) => {
  const { agent, hours } = req.query;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const analyzer = getPatternAnalyzer();
    const deviations = analyzer.getRecentDeviations(agent, parseInt(hours) || 24);
    
    res.json({
      deviations,
      count: deviations.length
    });
  } catch (err) {
    console.error('[engram] Get deviations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get pattern learning statistics
app.get('/api/v1/pattern-stats', (req, res) => {
  const { agent } = req.query;
  
  try {
    const analyzer = getPatternAnalyzer();
    const stats = analyzer.getStats(agent);
    
    res.json(stats);
  } catch (err) {
    console.error('[engram] Pattern stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ingest daily memory file for pattern analysis
app.post('/api/v1/ingest-memory', (req, res) => {
  const { agent, content, date } = req.body;
  
  if (!agent || !content) {
    return res.status(400).json({ error: 'agent and content are required' });
  }
  
  try {
    const { SessionLogParser } = require('./services/patterns');
    const events = SessionLogParser.parseDailyMemory(content);
    
    const analyzer = getPatternAnalyzer();
    const result = analyzer.analyzeSession(agent, `memory-${date || 'unknown'}`, events);
    
    res.json({
      ingested: true,
      eventsExtracted: events.length,
      ...result
    });
  } catch (err) {
    console.error('[engram] Ingest memory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// HIVE-MIND ENDPOINTS (v0.4.0)
// ============================================

// Lazy load hive-mind service
let hiveMindService = null;
const getHiveMind = () => {
  if (!hiveMindService) {
    const { HiveMindService } = require('./services/hivemind');
    hiveMindService = new HiveMindService(db);
  }
  return hiveMindService;
};

// Share knowledge to the hive
app.post('/api/v1/hive/share', (req, res) => {
  const { agent, type, content, priority, topics, targets, immediate } = req.body;
  
  if (!agent || !type || !content) {
    return res.status(400).json({ error: 'agent, type, and content are required' });
  }
  
  try {
    const hive = getHiveMind();
    const result = hive.share(agent, type, content, {
      priority,
      topics: topics || [],
      targetAgents: targets,
      immediate: immediate || false
    });
    
    res.json(result);
  } catch (err) {
    console.error('[engram] Hive share error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Broadcast a correction fleet-wide
app.post('/api/v1/hive/broadcast-correction', (req, res) => {
  const { agent, original, corrected, reason } = req.body;
  
  if (!agent || !original || !corrected) {
    return res.status(400).json({ error: 'agent, original, and corrected are required' });
  }
  
  try {
    const hive = getHiveMind();
    const result = hive.broadcastCorrection(agent, original, corrected, reason || 'No reason given');
    
    res.json(result);
  } catch (err) {
    console.error('[engram] Broadcast correction error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Process pending propagations
app.post('/api/v1/hive/propagate', (req, res) => {
  try {
    const hive = getHiveMind();
    const result = hive.processPendingPropagations();
    
    res.json(result);
  } catch (err) {
    console.error('[engram] Propagate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get knowledge for an agent (including hive knowledge)
app.get('/api/v1/hive/knowledge', (req, res) => {
  const { agent, type, limit, includeHive } = req.query;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const hive = getHiveMind();
    const knowledge = hive.getKnowledgeForAgent(agent, {
      type,
      limit: parseInt(limit) || 20,
      includeHive: includeHive !== 'false'
    });
    
    res.json({
      knowledge,
      count: knowledge.length
    });
  } catch (err) {
    console.error('[engram] Get knowledge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Subscribe to a topic
app.post('/api/v1/hive/subscribe', (req, res) => {
  const { agent, topic, priorityThreshold } = req.body;
  
  if (!agent || !topic) {
    return res.status(400).json({ error: 'agent and topic are required' });
  }
  
  try {
    const hive = getHiveMind();
    const result = hive.subscribe(agent, topic, priorityThreshold);
    
    res.json(result);
  } catch (err) {
    console.error('[engram] Subscribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get agent subscriptions
app.get('/api/v1/hive/subscriptions', (req, res) => {
  const { agent } = req.query;
  
  if (!agent) {
    return res.status(400).json({ error: 'agent is required' });
  }
  
  try {
    const hive = getHiveMind();
    const subscriptions = hive.getSubscriptions(agent);
    
    res.json({
      subscriptions,
      count: subscriptions.length
    });
  } catch (err) {
    console.error('[engram] Get subscriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get recent propagations
app.get('/api/v1/hive/propagations', (req, res) => {
  const { limit } = req.query;
  
  try {
    const hive = getHiveMind();
    const propagations = hive.getRecentPropagations(parseInt(limit) || 10);
    
    res.json({
      propagations,
      count: propagations.length
    });
  } catch (err) {
    console.error('[engram] Get propagations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get hive stats
app.get('/api/v1/hive/stats', (req, res) => {
  try {
    const hive = getHiveMind();
    const stats = hive.getStats();
    
    res.json(stats);
  } catch (err) {
    console.error('[engram] Hive stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const startServer = () => {
  initDatabase();
  
  // Preload embedding model in background
  console.log('[engram] Preloading embedding model...');
  getEmbeddings().embed('warmup').then(() => {
    console.log('[engram] Embedding model ready');
  }).catch(err => {
    console.error('[engram] Failed to load embedding model:', err);
  });
  
  app.listen(CONFIG.port, '127.0.0.1', () => {
    console.log(`[engram] Server running on http://127.0.0.1:${CONFIG.port}`);
    console.log(`[engram] Database: ${CONFIG.dbPath}`);
    console.log(`[engram] Semantic search: enabled`);
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
