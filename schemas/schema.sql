-- Engram Database Schema
-- Version: 1.0.0
-- Last Updated: 2026-03-12

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Core agent registry
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME,
    config_json TEXT,
    current_session_id TEXT,
    is_active BOOLEAN DEFAULT 1
);

-- Memory storage
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('task','decision','fact','preference','correction','pattern','context','learning')),
    content TEXT NOT NULL,
    metadata_json TEXT,
    priority INTEGER DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    source TEXT DEFAULT 'agent' CHECK(source IN ('agent','user','system','inferred')),
    confidence REAL DEFAULT 1.0 CHECK(confidence BETWEEN 0.0 AND 1.0),
    tags TEXT  -- JSON array of tags
);

-- Session tracking
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    compacted_at DATETIME,
    ended_at DATETIME,
    initial_context_size INTEGER,
    final_context_size INTEGER,
    message_count INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active' CHECK(state IN ('active','compacted','ended'))
);

-- Behavioral patterns (v0.3.0 - pattern learning)
CREATE TABLE IF NOT EXISTS patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    type TEXT NOT NULL,
    pattern_json TEXT NOT NULL,
    description TEXT,
    confidence REAL DEFAULT 0.5 CHECK(confidence BETWEEN 0.0 AND 1.0),
    occurrence_count INTEGER DEFAULT 1,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT DEFAULT 'learned',
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Corrections (user feedback)
CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    original_behavior TEXT NOT NULL,
    corrected_behavior TEXT NOT NULL,
    reason TEXT,
    severity TEXT DEFAULT 'medium' CHECK(severity IN ('low','medium','high','critical')),
    applied_count INTEGER DEFAULT 0,
    last_applied DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
);

-- Cross-agent shared knowledge (hive-mind integration)
CREATE TABLE IF NOT EXISTS shared_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    knowledge_type TEXT NOT NULL,
    content TEXT NOT NULL,
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
    propagated_to TEXT,  -- JSON array of agent IDs that received this
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active BOOLEAN DEFAULT 1
);

-- Tool usage tracking (detect forgotten tools)
CREATE TABLE IF NOT EXISTS tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    invocation_count INTEGER DEFAULT 1,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    expected_frequency TEXT,  -- 'session_start', 'daily', 'weekly', 'as_needed'
    UNIQUE(agent_id, tool_name)
);

-- Injection history (track what was injected when)
CREATE TABLE IF NOT EXISTS injections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    injection_content TEXT NOT NULL,
    memory_count INTEGER,
    token_estimate INTEGER,
    injected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memories_agent_type ON memories(agent_id, type, is_active);
CREATE INDEX IF NOT EXISTS idx_memories_active_priority ON memories(is_active, priority DESC);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_agent_state ON sessions(agent_id, state);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_agent ON patterns(agent_id, type, is_active);
CREATE INDEX IF NOT EXISTS idx_corrections_agent ON corrections(agent_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tool_usage_agent ON tool_usage(agent_id, last_used DESC);

-- Full-text search for semantic recall
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content=memories,
    content_rowid=id,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Auto-update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS memories_updated AFTER UPDATE ON memories
BEGIN
    UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Views for common queries
CREATE VIEW IF NOT EXISTS active_tasks AS
SELECT m.*, a.name as agent_name
FROM memories m
JOIN agents a ON m.agent_id = a.id
WHERE m.type = 'task' AND m.is_active = 1
ORDER BY m.priority DESC, m.created_at DESC;

CREATE VIEW IF NOT EXISTS recent_decisions AS
SELECT m.*, a.name as agent_name
FROM memories m
JOIN agents a ON m.agent_id = a.id
WHERE m.type = 'decision' AND m.is_active = 1
  AND m.created_at > datetime('now', '-7 days')
ORDER BY m.created_at DESC;

CREATE VIEW IF NOT EXISTS active_corrections AS
SELECT c.*, a.name as agent_name
FROM corrections c
JOIN agents a ON c.agent_id = a.id
WHERE c.is_active = 1
ORDER BY c.severity DESC, c.created_at DESC;

CREATE VIEW IF NOT EXISTS forgotten_tools AS
SELECT t.*, a.name as agent_name,
       julianday('now') - julianday(t.last_used) as days_since_use
FROM tool_usage t
JOIN agents a ON t.agent_id = a.id
WHERE t.expected_frequency IN ('session_start', 'daily')
  AND julianday('now') - julianday(t.last_used) > 1
ORDER BY days_since_use DESC;

-- Seed data: Register known agents
INSERT OR IGNORE INTO agents (id, name, display_name) VALUES
    ('kevin', 'Kevin', 'Kevin, Hand of the King'),
    ('bigbrain', 'BigBrain', 'BigBrain (Architect)'),
    ('minion', 'Minion', 'Kevin''s Minion'),
    ('monkey', 'CodingMonkey', 'CodingMonkey (Implementer)'),
    ('dumdum', 'DumDum', 'DumDum (SIT Tester)'),
    ('boss', 'Boss', 'KevinBoss (SQT/Deploy)'),
    ('watcher', 'Watcher', 'The Watcher (Fleet Monitor)'),
    ('scribe', 'Scribe', 'The Scribe (Content)'),
    ('maester', 'Maester', 'The Maester (Email)'),
    ('chronicler', 'Chronicler', 'The Chronicler (Events)'),
    ('scholar', 'Scholar', 'The Scholar (Research)');

-- Seed data: Expected tool usage patterns
INSERT OR IGNORE INTO tool_usage (agent_id, tool_name, expected_frequency, invocation_count) VALUES
    ('kevin', 'kt sync', 'session_start', 0),
    ('kevin', 'kt log task-start', 'session_start', 0),
    ('kevin', 'kt log task-end', 'session_start', 0),
    ('kevin', 'kt learn', 'as_needed', 0),
    ('kevin', 'engram wake', 'session_start', 0),
    ('kevin', 'brain status', 'daily', 0);
