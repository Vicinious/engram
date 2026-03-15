# Engram v0.5.0 — Cross-Channel Memory Consolidation Design Specification

**Project:** Engram  
**Component:** Cross-Channel Memory Tracking and Consolidation  
**Author:** BigBrain  
**Date:** 2026-03-15  
**Status:** Draft  
**Version:** 0.5.0

---

## 1. Overview

### 1.1 Problem Statement

Kevin operates across multiple Discord channels (#general, #minion-tasks, #twitter-clearcut) but Engram treats all memories as channel-agnostic. This creates three problems:

1. **Lost provenance** — No way to know where a memory originated
2. **Context leakage** — Channel-specific knowledge surfaces in wrong contexts
3. **Duplicate memories** — Same fact stored multiple times across channels

### 1.2 Solution Summary

Add channel tracking to memories with cross-channel aggregation on wake and a consolidation command for deduplication.

```
┌─────────────────────────────────────────────────────────────────┐
│                 CROSS-CHANNEL MEMORY ARCHITECTURE               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  #general          #minion-tasks       #twitter-clearcut        │
│  ┌─────────┐       ┌─────────┐         ┌─────────┐             │
│  │ Memory  │       │ Memory  │         │ Memory  │             │
│  │ Store   │       │ Store   │         │ Store   │             │
│  └────┬────┘       └────┬────┘         └────┬────┘             │
│       │                 │                   │                   │
│       └─────────────────┼───────────────────┘                   │
│                         │                                        │
│                         ▼                                        │
│                 ┌───────────────┐                               │
│                 │   Consolidate │                               │
│                 │   (dedupe)    │                               │
│                 └───────────────┘                               │
│                         │                                        │
│                         ▼                                        │
│                 ┌───────────────┐                               │
│                 │     Wake      │                               │
│                 │ (aggregate)   │                               │
│                 └───────────────┘                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Design Goals

| Goal | Rationale |
|------|-----------|
| Backward compatible | Existing memories get `channel: 'default'` |
| Aggregation by default | `engram wake` pulls from ALL channels |
| Optional filtering | `--channel` flag for channel-specific queries |
| Deduplication | `engram consolidate` merges duplicates |
| Low overhead | Single column addition, index for performance |

---

## 2. Schema Changes

### 2.1 Migration Script

**File:** `migrations/001-add-channel.sql`

```sql
-- Migration 001: Add channel tracking to memories
-- Version: 0.5.0
-- Date: 2026-03-15

-- Add channel column with default for backward compatibility
ALTER TABLE memories ADD COLUMN channel TEXT DEFAULT 'default';

-- Index for channel-based queries
CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel, agent_id, is_active);

-- Composite index for wake queries (agent + channel + active + priority)
CREATE INDEX IF NOT EXISTS idx_memories_wake ON memories(agent_id, is_active, channel, priority DESC);

-- Update existing memories to default channel
UPDATE memories SET channel = 'default' WHERE channel IS NULL;
```

### 2.2 Updated Schema (memories table)

```sql
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    channel TEXT DEFAULT 'default',  -- NEW: Channel identifier
    type TEXT NOT NULL CHECK(type IN ('task','decision','fact','preference','correction','pattern','context','learning')),
    content TEXT NOT NULL,
    metadata_json TEXT,
    priority INTEGER DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    source TEXT DEFAULT 'agent' CHECK(source IN ('agent','user','system','inferred','consolidated')),
    confidence REAL DEFAULT 1.0 CHECK(confidence BETWEEN 0.0 AND 1.0),
    tags TEXT,
    embedding BLOB,
    is_embedded BOOLEAN DEFAULT 0,
    -- NEW: Track consolidation
    consolidated_from TEXT,  -- JSON array of original memory IDs
    consolidated_at DATETIME
);
```

### 2.3 Channel Identifier Format

```
Channel ID Format: <platform>:<channel_id>

Examples:
- discord:1467200912236871905      (#general)
- discord:1467909068189335552      (#minion-tasks)
- discord:1470884756041830462      (#twitter-clearcut)
- telegram:group_12345
- default                          (legacy/unknown)

Normalized: Always lowercase, no spaces
```

---

## 3. API Changes

### 3.1 Remember Endpoint

**Endpoint:** `POST /api/v1/remember`

**Updated Request:**
```json
{
  "agent": "kevin",
  "content": "YouTube quota resets at midnight Pacific",
  "type": "fact",
  "channel": "discord:1467909068189335552",  // NEW
  "priority": 7,
  "tags": ["youtube", "quota"]
}
```

**Response unchanged.**

### 3.2 Wake Endpoint

**Endpoint:** `POST /api/v1/wake`

**Updated Request:**
```json
{
  "agent": "kevin",
  "session_id": "sess_abc123",
  "channel": "discord:1467200912236871905",  // NEW: optional, for filtering
  "include_channels": ["all"],                // NEW: default is ["all"]
  "exclude_channels": []                      // NEW: channels to exclude
}
```

**Updated Response:**
```json
{
  "injection": "## Active Context\n...",
  "memories_count": 15,
  "injection_tokens": 1200,
  "channels_included": ["discord:1467200912236871905", "discord:1467909068189335552", "default"],
  "channel_breakdown": {
    "discord:1467200912236871905": 5,
    "discord:1467909068189335552": 8,
    "default": 2
  }
}
```

### 3.3 Consolidate Endpoint (NEW)

**Endpoint:** `POST /api/v1/consolidate`

**Request:**
```json
{
  "agent": "kevin",
  "dry_run": false,
  "similarity_threshold": 0.85,
  "prefer_channel": "discord:1467909068189335552"  // Preferred source for conflicts
}
```

**Response:**
```json
{
  "status": "completed",
  "duplicates_found": 12,
  "memories_merged": 8,
  "memories_preserved": 4,
  "details": [
    {
      "merged_into": 1234,
      "merged_from": [1235, 1236],
      "content_preview": "YouTube quota resets at midnight...",
      "channels": ["discord:1467909068189335552", "default"]
    }
  ]
}
```

### 3.4 Query Endpoint

**Endpoint:** `POST /api/v1/query`

**Updated Request:**
```json
{
  "agent": "kevin",
  "query": "quota limits",
  "channel": "discord:1467909068189335552",  // NEW: optional filter
  "channels": ["discord:1467909068189335552", "default"],  // NEW: multi-channel
  "limit": 10
}
```

---

## 4. CLI Changes

### 4.1 Updated Commands

#### `engram wake`

```bash
# Default: aggregate from ALL channels (backward compatible)
engram wake --agent kevin

# Filter to specific channel
engram wake --agent kevin --channel discord:1467909068189335552

# Exclude channels
engram wake --agent kevin --exclude discord:1470884756041830462

# Show channel breakdown
engram wake --agent kevin --show-channels
```

#### `engram remember`

```bash
# Store with channel context
engram remember "YouTube quota resets at midnight" \
  --agent kevin \
  --channel discord:1467909068189335552 \
  --type fact

# Default channel (backward compatible)
engram remember "General fact" --agent kevin
```

#### `engram query`

```bash
# Query across all channels (default)
engram query "quota limits" --agent kevin

# Filter to specific channel
engram query "quota limits" --agent kevin --channel discord:1467909068189335552

# Multi-channel query
engram query "quota" --agent kevin --channels discord:1467909068189335552,default
```

### 4.2 New Command: `engram consolidate`

```bash
# Consolidate duplicates for an agent
engram consolidate --agent kevin

# Dry run (show what would be merged)
engram consolidate --agent kevin --dry-run

# Custom similarity threshold (default 0.85)
engram consolidate --agent kevin --threshold 0.90

# Prefer specific channel when resolving conflicts
engram consolidate --agent kevin --prefer discord:1467909068189335552

# Verbose output
engram consolidate --agent kevin --verbose
```

**Output:**
```
[engram] Scanning memories for kevin...
[engram] Found 247 active memories across 3 channels
[engram] Analyzing similarity...
[engram] Found 12 duplicate groups

Duplicate Group 1:
  Content: "YouTube quota resets at midnight Pacific"
  Channels: discord:1467909068189335552, default
  Action: Merge → keep discord:1467909068189335552 (higher priority)

Duplicate Group 2:
  Content: "CISSP videos upload daily at 6 AM"
  Channels: discord:1467200912236871905, discord:1467909068189335552
  Action: Merge → keep discord:1467909068189335552 (preferred)

...

[engram] Consolidated 12 duplicate groups → 12 memories merged
[engram] Remaining active memories: 235
```

### 4.3 New Command: `engram channels`

```bash
# List all channels with memory counts
engram channels --agent kevin

# Output:
# Channel                          | Memories | Last Activity
# ---------------------------------|----------|---------------
# discord:1467909068189335552      | 142      | 2 hours ago
# discord:1467200912236871905      | 85       | 1 day ago
# discord:1470884756041830462      | 15       | 3 days ago
# default                          | 5        | 7 days ago
```

---

## 5. Implementation Details

### 5.1 Deduplication Algorithm

```javascript
/**
 * Find duplicate memories using embedding similarity
 * 
 * @param {string} agentId - Agent to consolidate
 * @param {number} threshold - Similarity threshold (0.0-1.0)
 * @returns {Array<DuplicateGroup>} Groups of duplicate memories
 */
async function findDuplicates(agentId, threshold = 0.85) {
  // Get all active memories with embeddings
  const memories = db.prepare(`
    SELECT id, content, channel, priority, embedding, created_at
    FROM memories
    WHERE agent_id = ? AND is_active = 1 AND is_embedded = 1
    ORDER BY created_at ASC
  `).all(agentId);
  
  const duplicateGroups = [];
  const processed = new Set();
  
  for (const memory of memories) {
    if (processed.has(memory.id)) continue;
    
    const group = [memory];
    processed.add(memory.id);
    
    // Compare with remaining memories
    for (const other of memories) {
      if (processed.has(other.id)) continue;
      
      const similarity = cosineSimilarity(
        deserializeEmbedding(memory.embedding),
        deserializeEmbedding(other.embedding)
      );
      
      if (similarity >= threshold) {
        group.push(other);
        processed.add(other.id);
      }
    }
    
    if (group.length > 1) {
      duplicateGroups.push({
        memories: group,
        channels: [...new Set(group.map(m => m.channel))],
        winner: selectWinner(group)
      });
    }
  }
  
  return duplicateGroups;
}

/**
 * Select winner from duplicate group
 * Priority: highest priority → preferred channel → oldest
 */
function selectWinner(group, preferChannel = null) {
  return group.sort((a, b) => {
    // Highest priority first
    if (b.priority !== a.priority) return b.priority - a.priority;
    
    // Preferred channel wins
    if (preferChannel) {
      if (a.channel === preferChannel) return -1;
      if (b.channel === preferChannel) return 1;
    }
    
    // Oldest wins (original source)
    return new Date(a.created_at) - new Date(b.created_at);
  })[0];
}
```

### 5.2 Cross-Channel Wake Logic

```javascript
/**
 * Build injection from multiple channels
 */
function buildCrossChannelInjection(agentId, options = {}) {
  const {
    includeChannels = ['all'],
    excludeChannels = [],
    currentChannel = null,
    maxTokens = 1500
  } = options;
  
  // Build channel filter
  let channelClause = '';
  const params = [agentId];
  
  if (!includeChannels.includes('all')) {
    const placeholders = includeChannels.map(() => '?').join(',');
    channelClause = `AND channel IN (${placeholders})`;
    params.push(...includeChannels);
  }
  
  if (excludeChannels.length > 0) {
    const placeholders = excludeChannels.map(() => '?').join(',');
    channelClause += ` AND channel NOT IN (${placeholders})`;
    params.push(...excludeChannels);
  }
  
  // Query with channel weighting
  // Boost current channel memories
  const memories = db.prepare(`
    SELECT 
      id, content, type, channel, priority, created_at,
      CASE WHEN channel = ? THEN priority + 2 ELSE priority END as effective_priority
    FROM memories
    WHERE agent_id = ? 
      AND is_active = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ${channelClause}
    ORDER BY effective_priority DESC, created_at DESC
    LIMIT 50
  `).all(currentChannel, ...params);
  
  // Group by channel for breakdown
  const breakdown = {};
  for (const m of memories) {
    breakdown[m.channel] = (breakdown[m.channel] || 0) + 1;
  }
  
  // Build injection (existing format)
  const injection = formatInjection(memories, maxTokens);
  
  return {
    injection,
    memories_count: memories.length,
    channels_included: Object.keys(breakdown),
    channel_breakdown: breakdown
  };
}
```

### 5.3 Migration Runner

```javascript
// scripts/migrate.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ENGRAM_DB || '/var/lib/engram/brain.db';
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function runMigrations() {
  const db = new Database(DB_PATH);
  
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Get applied migrations
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );
  
  // Get available migrations
  const migrations = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  
  // Apply pending migrations
  for (const file of migrations) {
    const version = file.replace('.sql', '');
    
    if (applied.has(version)) {
      console.log(`[migrate] Skipping ${version} (already applied)`);
      continue;
    }
    
    console.log(`[migrate] Applying ${version}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    
    console.log(`[migrate] Applied ${version}`);
  }
  
  console.log('[migrate] All migrations complete');
  db.close();
}

runMigrations();
```

---

## 6. File Structure

```
engram/
├── src/
│   ├── cli.js                    # Updated: --channel flags
│   ├── server.js                 # Updated: channel handling
│   └── services/
│       ├── embeddings.js         # Existing
│       ├── hivemind.js           # Existing
│       ├── patterns.js           # Existing
│       └── consolidation.js      # NEW: Deduplication logic
├── migrations/
│   └── 001-add-channel.sql       # NEW: Schema migration
├── schemas/
│   └── schema.sql                # Updated: channel column
├── scripts/
│   ├── install.sh                # Existing
│   └── migrate.js                # NEW: Migration runner
├── tests/
│   ├── consolidation.test.js     # NEW: Consolidation tests
│   └── channel.test.js           # NEW: Channel tests
└── README.md                     # Updated: v0.5.0 docs
```

---

## 7. Implementation Plan

### 7.1 AWP Breakdown

| AWP | Component | Est. Hours | Dependencies |
|-----|-----------|------------|--------------|
| AWP-050 | Schema migration | 0.5 | None |
| AWP-051 | Migration runner script | 1 | AWP-050 |
| AWP-052 | Server: channel in remember | 1 | AWP-050 |
| AWP-053 | Server: channel in wake | 1.5 | AWP-050 |
| AWP-054 | CLI: --channel flags | 1 | AWP-052, AWP-053 |
| AWP-055 | Consolidation service | 2 | AWP-050 |
| AWP-056 | Server: consolidate endpoint | 1 | AWP-055 |
| AWP-057 | CLI: consolidate command | 1 | AWP-056 |
| AWP-058 | CLI: channels command | 0.5 | AWP-050 |
| AWP-059 | Tests | 1.5 | All above |
| AWP-060 | README update | 0.5 | All above |
| **Total** | | **11.5 hours** | |

### 7.2 Phase Breakdown

```
Phase 1: Schema (AWP-050, AWP-051) — 1.5 hours
├── Migration SQL
└── Migration runner

Phase 2: Core Integration (AWP-052 to AWP-054) — 3.5 hours
├── Remember with channel
├── Wake with channel aggregation
└── CLI flags

Phase 3: Consolidation (AWP-055 to AWP-058) — 4.5 hours
├── Deduplication logic
├── Consolidate endpoint
├── CLI commands
└── Channels list command

Phase 4: Testing & Docs (AWP-059, AWP-060) — 2 hours
├── Unit tests
└── README update
```

---

## 8. Acceptance Criteria

| ID | Criterion | Verification |
|----|-----------|--------------|
| AC1 | Existing memories have `channel: 'default'` after migration | Query check |
| AC2 | `engram remember --channel X` stores channel | Unit test |
| AC3 | `engram wake` aggregates ALL channels by default | Integration test |
| AC4 | `engram wake --channel X` filters to X only | Integration test |
| AC5 | `engram consolidate` merges duplicates | Unit test |
| AC6 | `engram consolidate --dry-run` shows preview | Manual test |
| AC7 | `engram channels` lists all channels | CLI test |
| AC8 | Backward compatible — no flags = old behavior | Regression test |

---

## 9. Safety Considerations

```
┌─────────────────────────────────────────────────────────────────┐
│                    SAFETY INVARIANTS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Migration is additive only                                  │
│     - ALTER TABLE ADD COLUMN (never DROP)                       │
│     - Default value ensures backward compatibility              │
│                                                                  │
│  2. Consolidation preserves data                                │
│     - Merged memories marked inactive, not deleted              │
│     - consolidated_from tracks original IDs                     │
│     - Rollback possible via is_active flip                      │
│                                                                  │
│  3. Wake default is "all channels"                              │
│     - No flag = existing behavior                               │
│     - Channel filtering is opt-in                               │
│                                                                  │
│  4. Dry run available                                           │
│     - consolidate --dry-run shows plan without executing        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Rollback Plan

If issues occur:

1. **Schema rollback:**
   ```sql
   -- Note: SQLite doesn't support DROP COLUMN easily
   -- Create new table without channel, migrate data, swap
   CREATE TABLE memories_backup AS SELECT * FROM memories;
   -- Restore from backup if needed
   ```

2. **Code rollback:**
   ```bash
   git checkout v0.4.0
   npm install
   systemctl restart engram
   ```

3. **Consolidation undo:**
   ```sql
   -- Reactivate merged memories
   UPDATE memories SET is_active = 1 WHERE consolidated_at IS NOT NULL;
   -- Deactivate consolidated versions
   UPDATE memories SET is_active = 0 WHERE consolidated_from IS NOT NULL;
   ```

---

*End of specification.*
