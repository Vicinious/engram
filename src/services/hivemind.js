/**
 * Hive-Mind Service - Cross-Agent Knowledge Propagation
 * 
 * When one agent learns something valuable, propagate it to others.
 * Handles:
 * - Knowledge routing based on agent specialization
 * - Fleet-wide corrections
 * - Cross-agent pattern sharing
 * - Priority-based propagation
 */

// Agent specializations for smart routing
const AGENT_SPECIALIZATIONS = {
  kevin: ['orchestration', 'strategy', 'infrastructure', 'memory', 'general'],
  bigbrain: ['architecture', 'design', 'sdlc', 'planning'],
  monkey: ['implementation', 'coding', 'debugging', 'testing'],
  dumdum: ['testing', 'qa', 'validation', 'bugs'],
  boss: ['deployment', 'operations', 'sqt', 'production'],
  minion: ['coding', 'tasks', 'implementation'],
  watcher: ['monitoring', 'fleet', 'health', 'alerts'],
  scribe: ['content', 'writing', 'publishing'],
  maester: ['email', 'communication', 'drafts'],
  chronicler: ['events', 'logging', 'history'],
  scholar: ['research', 'analysis', 'documentation']
};

// Knowledge types and their default propagation scope
const KNOWLEDGE_SCOPE = {
  correction: 'fleet',        // Corrections apply to everyone
  pattern: 'similar',         // Patterns go to similar agents
  discovery: 'relevant',      // Discoveries route by topic
  preference: 'self',         // Preferences stay with originator
  tool_trick: 'fleet',        // Tool tricks help everyone
  warning: 'fleet',           // Warnings are fleet-wide
  best_practice: 'fleet'      // Best practices are universal
};

class HiveMindService {
  constructor(db) {
    this.db = db;
    this.ensureTables();
  }

  ensureTables() {
    // Propagation queue - knowledge waiting to be distributed
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS propagation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_agent_id TEXT NOT NULL,
        knowledge_type TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT DEFAULT 'medium',
        scope TEXT DEFAULT 'fleet',
        target_agents TEXT,
        topics TEXT,
        propagated_to TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        propagated_at TIMESTAMP
      )
    `);

    // Subscriptions - agents subscribe to topics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        priority_threshold TEXT DEFAULT 'low',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, topic)
      )
    `);

    // Cross-agent memory links
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_memory_id INTEGER NOT NULL,
        target_agent_id TEXT NOT NULL,
        link_type TEXT DEFAULT 'propagated',
        accepted BOOLEAN DEFAULT 0,
        rejected BOOLEAN DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (source_memory_id) REFERENCES memories(id)
      )
    `);

    // Initialize default subscriptions based on specializations
    this.initializeSubscriptions();
  }

  initializeSubscriptions() {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO agent_subscriptions (agent_id, topic, priority_threshold)
      VALUES (?, ?, ?)
    `);

    for (const [agent, topics] of Object.entries(AGENT_SPECIALIZATIONS)) {
      for (const topic of topics) {
        stmt.run(agent, topic, 'low');
      }
      // Everyone subscribes to 'fleet' topic for universal knowledge
      stmt.run(agent, 'fleet', 'low');
    }
  }

  /**
   * Share knowledge from one agent to the hive
   */
  share(sourceAgent, knowledgeType, content, options = {}) {
    const {
      priority = 'medium',
      topics = [],
      targetAgents = null,
      immediate = false
    } = options;

    // Determine scope based on knowledge type
    const scope = KNOWLEDGE_SCOPE[knowledgeType] || 'relevant';

    // Calculate target agents based on scope
    let targets;
    if (targetAgents) {
      targets = targetAgents;
    } else if (scope === 'fleet') {
      targets = Object.keys(AGENT_SPECIALIZATIONS).filter(a => a !== sourceAgent);
    } else if (scope === 'similar') {
      targets = this.findSimilarAgents(sourceAgent);
    } else if (scope === 'relevant') {
      targets = this.findRelevantAgents(topics);
    } else {
      targets = [];  // self only
    }

    // Insert into propagation queue
    const result = this.db.prepare(`
      INSERT INTO propagation_queue 
      (source_agent_id, knowledge_type, content, priority, scope, target_agents, topics, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceAgent,
      knowledgeType,
      content,
      priority,
      scope,
      JSON.stringify(targets),
      JSON.stringify(topics),
      immediate ? 'processing' : 'pending'
    );

    const queueId = result.lastInsertRowid;

    // If immediate, propagate now
    if (immediate) {
      return this.propagate(queueId);
    }

    return {
      queued: true,
      id: queueId,
      targets: targets.length,
      scope
    };
  }

  /**
   * Propagate a queued knowledge item to target agents
   */
  propagate(queueId) {
    const item = this.db.prepare('SELECT * FROM propagation_queue WHERE id = ?').get(queueId);
    if (!item) return { error: 'Queue item not found' };

    const targets = JSON.parse(item.target_agents || '[]');
    const propagatedTo = [];

    for (const targetAgent of targets) {
      try {
        // Create memory for target agent
        // Note: source must be 'agent'|'user'|'system'|'inferred' per schema
        // We use 'system' for hive propagated knowledge and track source in metadata
        const memResult = this.db.prepare(`
          INSERT INTO memories (agent_id, type, content, priority, source, metadata_json)
          VALUES (?, ?, ?, ?, 'system', ?)
        `).run(
          targetAgent,
          this.mapKnowledgeToMemoryType(item.knowledge_type),
          `[From ${item.source_agent_id}] ${item.content}`,
          this.priorityToNumber(item.priority),
          JSON.stringify({
            source_agent: item.source_agent_id,
            knowledge_type: item.knowledge_type,
            propagation_id: queueId,
            from_hive: true
          })
        );

        // Create link
        this.db.prepare(`
          INSERT INTO memory_links (source_memory_id, target_agent_id, link_type)
          VALUES (?, ?, 'propagated')
        `).run(memResult.lastInsertRowid, targetAgent);

        propagatedTo.push(targetAgent);
      } catch (err) {
        console.error(`[hivemind] Failed to propagate to ${targetAgent}:`, err.message);
      }
    }

    // Update queue item
    this.db.prepare(`
      UPDATE propagation_queue 
      SET status = 'completed', propagated_to = ?, propagated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(propagatedTo), queueId);

    return {
      propagated: true,
      id: queueId,
      recipients: propagatedTo.length,
      targets: propagatedTo
    };
  }

  /**
   * Process all pending propagations
   */
  processPendingPropagations() {
    const pending = this.db.prepare(`
      SELECT id FROM propagation_queue WHERE status = 'pending'
      ORDER BY 
        CASE priority 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'medium' THEN 3 
          ELSE 4 
        END,
        created_at ASC
    `).all();

    const results = [];
    for (const item of pending) {
      results.push(this.propagate(item.id));
    }

    return {
      processed: results.length,
      results
    };
  }

  /**
   * Get knowledge for an agent (their memories + propagated from hive)
   */
  getKnowledgeForAgent(agentId, options = {}) {
    const { limit = 20, type = null, includeHive = true } = options;

    let sql = `
      SELECT m.*, 
        CASE WHEN json_extract(m.metadata_json, '$.from_hive') = 1 THEN 1 ELSE 0 END as from_hive,
        json_extract(m.metadata_json, '$.source_agent') as source_agent
      FROM memories m
      WHERE m.agent_id = ? AND m.is_active = 1
    `;
    const params = [agentId];

    if (type) {
      sql += ' AND m.type = ?';
      params.push(type);
    }

    if (!includeHive) {
      sql += " AND json_extract(m.metadata_json, '$.from_hive') IS NOT 1";
    }

    sql += ' ORDER BY m.priority DESC, m.created_at DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Broadcast a correction to all agents (immediate, fleet-wide)
   */
  broadcastCorrection(sourceAgent, original, corrected, reason) {
    const content = `CORRECTION: "${original}" → "${corrected}". Reason: ${reason}`;
    
    return this.share(sourceAgent, 'correction', content, {
      priority: 'high',
      topics: ['fleet', 'corrections'],
      immediate: true
    });
  }

  /**
   * Share a pattern discovery
   */
  sharePattern(sourceAgent, patternDescription, topics = []) {
    return this.share(sourceAgent, 'pattern', patternDescription, {
      priority: 'medium',
      topics: [...topics, 'patterns']
    });
  }

  /**
   * Share a tool trick
   */
  shareToolTrick(sourceAgent, tool, trick) {
    return this.share(sourceAgent, 'tool_trick', `${tool}: ${trick}`, {
      priority: 'medium',
      topics: ['tools', tool]
    });
  }

  /**
   * Share a warning
   */
  shareWarning(sourceAgent, warning, severity = 'medium') {
    return this.share(sourceAgent, 'warning', warning, {
      priority: severity === 'critical' ? 'critical' : 'high',
      topics: ['warnings', 'fleet'],
      immediate: severity === 'critical'
    });
  }

  /**
   * Find agents with similar specializations
   */
  findSimilarAgents(sourceAgent) {
    const sourceTopics = AGENT_SPECIALIZATIONS[sourceAgent] || [];
    const similar = [];

    for (const [agent, topics] of Object.entries(AGENT_SPECIALIZATIONS)) {
      if (agent === sourceAgent) continue;
      
      const overlap = topics.filter(t => sourceTopics.includes(t));
      if (overlap.length > 0) {
        similar.push(agent);
      }
    }

    return similar;
  }

  /**
   * Find agents relevant to specific topics
   */
  findRelevantAgents(topics) {
    if (!topics.length) return Object.keys(AGENT_SPECIALIZATIONS);

    const relevant = new Set();

    for (const [agent, agentTopics] of Object.entries(AGENT_SPECIALIZATIONS)) {
      for (const topic of topics) {
        if (agentTopics.includes(topic)) {
          relevant.add(agent);
        }
      }
    }

    return Array.from(relevant);
  }

  /**
   * Subscribe an agent to a topic
   */
  subscribe(agentId, topic, priorityThreshold = 'low') {
    this.db.prepare(`
      INSERT OR REPLACE INTO agent_subscriptions (agent_id, topic, priority_threshold)
      VALUES (?, ?, ?)
    `).run(agentId, topic, priorityThreshold);

    return { subscribed: true, agent: agentId, topic };
  }

  /**
   * Get an agent's subscriptions
   */
  getSubscriptions(agentId) {
    return this.db.prepare(`
      SELECT topic, priority_threshold FROM agent_subscriptions WHERE agent_id = ?
    `).all(agentId);
  }

  /**
   * Get propagation stats
   */
  getStats() {
    const pending = this.db.prepare(`SELECT COUNT(*) as c FROM propagation_queue WHERE status = 'pending'`).get();
    const completed = this.db.prepare(`SELECT COUNT(*) as c FROM propagation_queue WHERE status = 'completed'`).get();
    const links = this.db.prepare(`SELECT COUNT(*) as c FROM memory_links`).get();
    const hiveMemories = this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE json_extract(metadata_json, '$.from_hive') = 1`).get();

    return {
      pendingPropagations: pending.c,
      completedPropagations: completed.c,
      memoryLinks: links.c,
      hiveMemories: hiveMemories.c
    };
  }

  /**
   * Get recent propagations
   */
  getRecentPropagations(limit = 10) {
    return this.db.prepare(`
      SELECT * FROM propagation_queue 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(limit);
  }

  // Helper: Map knowledge type to memory type
  mapKnowledgeToMemoryType(knowledgeType) {
    const mapping = {
      correction: 'correction',
      pattern: 'pattern',
      discovery: 'learning',
      preference: 'preference',
      tool_trick: 'learning',
      warning: 'fact',
      best_practice: 'learning'
    };
    return mapping[knowledgeType] || 'learning';
  }

  // Helper: Convert priority string to number
  priorityToNumber(priority) {
    const mapping = { low: 3, medium: 5, high: 7, critical: 10 };
    return mapping[priority] || 5;
  }
}

module.exports = { HiveMindService, AGENT_SPECIALIZATIONS, KNOWLEDGE_SCOPE };
