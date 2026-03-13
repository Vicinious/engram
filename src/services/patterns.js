/**
 * Pattern Learning Service - Behavioral pattern detection and deviation alerts
 * 
 * Analyzes session logs to learn:
 * - Tool usage patterns (what tools are used together, frequency)
 * - Response patterns (how agent typically handles certain requests)
 * - Temporal patterns (time-of-day behaviors)
 * - Mistake patterns (repeated errors that should become corrections)
 */

const fs = require('fs');
const path = require('path');

// Pattern types
const PATTERN_TYPES = {
  TOOL_SEQUENCE: 'tool_sequence',      // Tools used together in sequence
  TOOL_FREQUENCY: 'tool_frequency',     // Expected tool usage frequency
  SESSION_START: 'session_start',       // What happens at session start
  RESPONSE_STYLE: 'response_style',     // How certain requests are handled
  MISTAKE_REPEAT: 'mistake_repeat',     // Repeated mistakes
  TEMPORAL: 'temporal'                  // Time-based patterns
};

// Default patterns (bootstrap)
const DEFAULT_PATTERNS = [
  {
    type: PATTERN_TYPES.SESSION_START,
    agent: '*',
    pattern: 'engram wake',
    description: 'Run engram wake at session start',
    confidence: 1.0,
    source: 'bootstrap'
  },
  {
    type: PATTERN_TYPES.TOOL_FREQUENCY,
    agent: 'kevin',
    pattern: 'kt sync',
    expectedFrequency: 'daily',
    description: 'Run kt sync daily',
    confidence: 0.9,
    source: 'bootstrap'
  }
];

/**
 * Pattern Analyzer - Extracts patterns from session logs
 */
class PatternAnalyzer {
  constructor(db) {
    this.db = db;
    this.ensureTables();
  }

  ensureTables() {
    // Add columns to existing patterns table from main schema (if missing)
    const migrations = [
      'ALTER TABLE patterns ADD COLUMN pattern_json TEXT',
      'ALTER TABLE patterns ADD COLUMN occurrence_count INTEGER DEFAULT 1',
      'ALTER TABLE patterns ADD COLUMN last_seen TIMESTAMP',
      'ALTER TABLE patterns ADD COLUMN source TEXT DEFAULT \'learned\''
    ];
    
    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch (e) {
        // Column already exists or other non-fatal error
      }
    }

    // Deviations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deviations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        pattern_id INTEGER,
        deviation_type TEXT NOT NULL,
        description TEXT NOT NULL,
        severity TEXT DEFAULT 'low',
        session_id TEXT,
        resolved BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (pattern_id) REFERENCES patterns(id)
      )
    `);

    // Session analysis table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        tools_used TEXT,
        patterns_matched TEXT,
        deviations_detected TEXT,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Auto-corrections table (generated from repeated mistakes)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        mistake_pattern TEXT NOT NULL,
        suggested_correction TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        promoted_to_correction BOOLEAN DEFAULT 0,
        correction_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (correction_id) REFERENCES corrections(id)
      )
    `);

    // Add source column to corrections if missing
    try {
      this.db.exec('ALTER TABLE corrections ADD COLUMN source TEXT DEFAULT \'user\'');
    } catch (e) { /* exists */ }

    // Insert default patterns if not exist
    const existing = this.db.prepare('SELECT COUNT(*) as c FROM patterns WHERE source = ?').get('bootstrap');
    if (existing.c === 0) {
      const stmt = this.db.prepare(`
        INSERT INTO patterns (agent_id, pattern_type, description, confidence, source, pattern_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const p of DEFAULT_PATTERNS) {
        stmt.run(p.agent, p.type, p.description, p.confidence, p.source, JSON.stringify(p.pattern));
      }
    }
  }

  /**
   * Analyze a session log and extract patterns
   */
  analyzeSession(agentId, sessionId, sessionLog) {
    const toolsUsed = [];
    const sequences = [];
    const mistakes = [];
    
    let lastTool = null;

    for (const event of sessionLog) {
      // Extract tool usage
      if (event.type === 'tool_call') {
        toolsUsed.push(event.tool);
        
        // Track sequences
        if (lastTool) {
          sequences.push([lastTool, event.tool]);
        }
        lastTool = event.tool;
      }

      // Extract mistakes (from corrections or errors)
      if (event.type === 'error' || event.type === 'correction') {
        mistakes.push({
          description: event.description || event.content,
          context: event.context
        });
      }
    }

    // Learn tool sequences
    this.learnToolSequences(agentId, sequences);

    // Track tool frequencies
    this.updateToolFrequencies(agentId, toolsUsed);

    // Process mistakes for auto-correction
    this.processMistakes(agentId, mistakes);

    // Store analysis
    this.db.prepare(`
      INSERT INTO session_analysis (agent_id, session_id, tools_used, patterns_matched, deviations_detected)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      agentId,
      sessionId,
      JSON.stringify(toolsUsed),
      JSON.stringify([]),
      JSON.stringify([])
    );

    return {
      toolsUsed: toolsUsed.length,
      sequencesLearned: sequences.length,
      mistakesProcessed: mistakes.length
    };
  }

  /**
   * Learn tool usage sequences (what tools are used together)
   */
  learnToolSequences(agentId, sequences) {
    const seqCounts = {};
    for (const [tool1, tool2] of sequences) {
      const key = `${tool1}→${tool2}`;
      seqCounts[key] = (seqCounts[key] || 0) + 1;
    }

    for (const [seq, count] of Object.entries(seqCounts)) {
      const existing = this.db.prepare(`
        SELECT id, occurrence_count FROM patterns
        WHERE agent_id = ? AND pattern_type = ? AND json_extract(pattern_json, '$.sequence') = ?
      `).get(agentId, PATTERN_TYPES.TOOL_SEQUENCE, seq);

      if (existing) {
        this.db.prepare(`
          UPDATE patterns SET occurrence_count = occurrence_count + ?, last_seen = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(count, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO patterns (agent_id, pattern_type, pattern_json, description, confidence)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          agentId,
          PATTERN_TYPES.TOOL_SEQUENCE,
          JSON.stringify({ sequence: seq, count }),
          `Tool sequence: ${seq}`,
          0.3
        );
      }
    }
  }

  /**
   * Update tool usage frequencies
   */
  updateToolFrequencies(agentId, tools) {
    for (const tool of tools) {
      this.db.prepare(`
        INSERT INTO tool_usage (agent_id, tool_name, invocation_count, last_used)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(agent_id, tool_name) DO UPDATE SET
          invocation_count = invocation_count + 1,
          last_used = CURRENT_TIMESTAMP
      `).run(agentId, tool);
    }
  }

  /**
   * Process mistakes to detect patterns and generate auto-corrections
   */
  processMistakes(agentId, mistakes) {
    for (const mistake of mistakes) {
      const description = mistake.description;
      if (!description) continue;

      // Check if similar mistake exists
      const existing = this.db.prepare(`
        SELECT id, occurrence_count FROM auto_corrections
        WHERE agent_id = ? AND mistake_pattern LIKE ?
      `).get(agentId, `%${description.slice(0, 50)}%`);

      if (existing) {
        const newCount = existing.occurrence_count + 1;
        this.db.prepare(`
          UPDATE auto_corrections SET occurrence_count = ? WHERE id = ?
        `).run(newCount, existing.id);

        // If mistake repeated 3+ times, promote to correction
        if (newCount >= 3 && !this.isPromoted(existing.id)) {
          this.promoteToCorrection(agentId, existing.id, description);
        }
      } else {
        this.db.prepare(`
          INSERT INTO auto_corrections (agent_id, mistake_pattern, suggested_correction)
          VALUES (?, ?, ?)
        `).run(
          agentId,
          description,
          `Avoid: ${description}`
        );
      }
    }
  }

  isPromoted(autoCorrectId) {
    const row = this.db.prepare('SELECT promoted_to_correction FROM auto_corrections WHERE id = ?').get(autoCorrectId);
    return row && row.promoted_to_correction;
  }

  /**
   * Promote a repeated mistake to an official correction
   */
  promoteToCorrection(agentId, autoCorrectId, mistakePattern) {
    const result = this.db.prepare(`
      INSERT INTO corrections (agent_id, original_behavior, corrected_behavior, reason, severity, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      mistakePattern,
      `Do not: ${mistakePattern}`,
      'Auto-generated from repeated pattern',
      'medium',
      'pattern_learning'
    );

    this.db.prepare(`
      UPDATE auto_corrections SET promoted_to_correction = 1, correction_id = ? WHERE id = ?
    `).run(result.lastInsertRowid, autoCorrectId);

    console.log(`[patterns] Auto-promoted correction for ${agentId}: ${mistakePattern.slice(0, 50)}...`);

    return result.lastInsertRowid;
  }

  /**
   * Detect deviations from established patterns
   */
  detectDeviations(agentId, currentSession) {
    const deviations = [];

    // Check session start patterns
    const sessionStartPatterns = this.db.prepare(`
      SELECT * FROM patterns 
      WHERE (agent_id = ? OR agent_id = '*') AND pattern_type = ? AND is_active = 1
    `).all(agentId, PATTERN_TYPES.SESSION_START);

    for (const pattern of sessionStartPatterns) {
      const expected = pattern.pattern_json ? JSON.parse(pattern.pattern_json) : pattern.description;
      const expectedTool = typeof expected === 'string' ? expected : expected.tool;
      
      // Check if expected tool was used in first 3 actions
      const firstTools = (currentSession || []).slice(0, 3).filter(e => e.type === 'tool_call').map(e => e.tool);
      if (!firstTools.some(t => t.includes(expectedTool))) {
        deviations.push({
          type: 'missing_session_start',
          pattern: pattern,
          description: `Expected "${expectedTool}" at session start, but not found`,
          severity: 'medium'
        });
      }
    }

    // Check tool frequency patterns
    const freqPatterns = this.db.prepare(`
      SELECT * FROM patterns 
      WHERE agent_id = ? AND pattern_type = ? AND is_active = 1
    `).all(agentId, PATTERN_TYPES.TOOL_FREQUENCY);

    for (const pattern of freqPatterns) {
      const data = pattern.pattern_json ? JSON.parse(pattern.pattern_json) : {};
      const toolName = data.tool || data;
      const usage = this.db.prepare(`
        SELECT last_used FROM tool_usage WHERE agent_id = ? AND tool_name = ?
      `).get(agentId, toolName);

      if (usage) {
        const daysSince = (Date.now() - new Date(usage.last_used).getTime()) / (1000 * 60 * 60 * 24);
        if (data.expectedFrequency === 'daily' && daysSince > 1) {
          deviations.push({
            type: 'tool_frequency',
            pattern: pattern,
            description: `"${toolName}" expected daily, last used ${Math.floor(daysSince)} days ago`,
            severity: 'low'
          });
        }
      }
    }

    // Store deviations
    for (const dev of deviations) {
      this.db.prepare(`
        INSERT INTO deviations (agent_id, pattern_id, deviation_type, description, severity)
        VALUES (?, ?, ?, ?, ?)
      `).run(agentId, dev.pattern?.id, dev.type, dev.description, dev.severity);
    }

    return deviations;
  }

  /**
   * Get active patterns for an agent
   */
  getPatterns(agentId, type = null) {
    let sql = "SELECT * FROM patterns WHERE (agent_id = ? OR agent_id = '*') AND is_active = 1";
    const params = [agentId];
    
    if (type) {
      sql += ' AND pattern_type = ?';
      params.push(type);
    }
    
    sql += ' ORDER BY confidence DESC, occurrence_count DESC';
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get pending auto-corrections (not yet promoted)
   */
  getPendingAutoCorrections(agentId) {
    return this.db.prepare(`
      SELECT * FROM auto_corrections
      WHERE agent_id = ? AND promoted_to_correction = 0
      ORDER BY occurrence_count DESC
    `).all(agentId);
  }

  /**
   * Get recent deviations for an agent
   */
  getRecentDeviations(agentId, hours = 24) {
    return this.db.prepare(`
      SELECT d.*, p.description as pattern_description
      FROM deviations d
      LEFT JOIN patterns p ON d.pattern_id = p.id
      WHERE d.agent_id = ? AND d.resolved = 0
        AND d.created_at > datetime('now', '-' || ? || ' hours')
      ORDER BY d.created_at DESC
    `).all(agentId, hours);
  }

  /**
   * Manually add a pattern
   */
  addPattern(agentId, type, pattern, description, confidence = 0.8) {
    const result = this.db.prepare(`
      INSERT INTO patterns (agent_id, pattern_type, pattern_json, description, confidence, source)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `).run(agentId, type, JSON.stringify(pattern), description, confidence);
    
    return result.lastInsertRowid;
  }

  /**
   * Get pattern statistics
   */
  getStats(agentId = null) {
    const where = agentId ? 'WHERE agent_id = ?' : '';
    const params = agentId ? [agentId] : [];
    
    const patterns = this.db.prepare(`SELECT COUNT(*) as c FROM patterns ${where}`).get(...params);
    const deviations = this.db.prepare(`SELECT COUNT(*) as c FROM deviations ${agentId ? 'WHERE agent_id = ? AND' : 'WHERE'} resolved = 0`).get(...params);
    const autoCorrections = this.db.prepare(`SELECT COUNT(*) as c FROM auto_corrections ${agentId ? 'WHERE agent_id = ? AND' : 'WHERE'} promoted_to_correction = 0`).get(...params);
    const promoted = this.db.prepare(`SELECT COUNT(*) as c FROM auto_corrections ${agentId ? 'WHERE agent_id = ? AND' : 'WHERE'} promoted_to_correction = 1`).get(...params);
    
    return {
      patterns: patterns.c,
      unresolvedDeviations: deviations.c,
      pendingAutoCorrections: autoCorrections.c,
      promotedCorrections: promoted.c
    };
  }
}

/**
 * Session Log Parser - Extracts events from various log formats
 */
class SessionLogParser {
  /**
   * Parse OpenClaw session history JSON
   */
  static parseOpenClawHistory(history) {
    const events = [];
    
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const call of msg.tool_calls) {
          events.push({
            type: 'tool_call',
            tool: call.function?.name || call.name,
            timestamp: msg.timestamp
          });
        }
      }
      
      if (msg.role === 'system' && msg.content?.includes('error')) {
        events.push({
          type: 'error',
          description: msg.content,
          timestamp: msg.timestamp
        });
      }
    }
    
    return events;
  }

  /**
   * Parse daily memory markdown files
   */
  static parseDailyMemory(content) {
    const events = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
      // Look for error mentions
      if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
        events.push({
          type: 'error',
          description: line.replace(/^[-*]\s*/, '').trim()
        });
      }
      
      // Look for tool mentions
      const toolMatch = line.match(/`(\w+(?:\s+\w+)?)`/g);
      if (toolMatch) {
        for (const match of toolMatch) {
          const tool = match.replace(/`/g, '');
          if (['engram', 'kt', 'awp', 'fleet', 'gog'].some(t => tool.startsWith(t))) {
            events.push({
              type: 'tool_call',
              tool: tool
            });
          }
        }
      }
    }
    
    return events;
  }
}

module.exports = {
  PatternAnalyzer,
  SessionLogParser,
  PATTERN_TYPES
};
