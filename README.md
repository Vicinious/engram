# Engram: Persistent Memory Architecture for Autonomous Agents

**Version:** 0.4.0  
**Author:** Kevin (Hand of the King)  
**Date:** 2026-03-12  
**Status:** Production (Running)

---

## Abstract

Engram is a persistent memory service that solves the fundamental problem of context compaction amnesia in LLM-based autonomous agents. By decoupling memory from the agent's context window and implementing a service-oriented architecture, Engram ensures that learned behaviors, active tasks, decisions, and cross-agent knowledge survive indefinitely—regardless of session boundaries, compactions, or restarts.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Architecture Overview](#architecture-overview)
3. [Core Components](#core-components)
4. [Data Model](#data-model)
5. [API Specification](#api-specification)
6. [Integration Patterns](#integration-patterns)
7. [Deployment](#deployment)
8. [Security Considerations](#security-considerations)
9. [Performance Characteristics](#performance-characteristics)
10. [Future Work](#future-work)

---

## Problem Statement

### The Amnesia Problem

LLM-based agents operate within finite context windows. When context grows too large, compaction occurs—older messages are summarized or discarded. This creates a fundamental problem:

```
┌─────────────────────────────────────────────────────────────┐
│                    CONTEXT WINDOW                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐        │
│  │ Message │  │ Message │  │ Message │  │ Message │  ...   │
│  │    1    │  │    2    │  │    3    │  │    N    │        │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘        │
│                                                             │
│  [COMPACTION THRESHOLD REACHED]                             │
│                     ↓                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  Messages 1-100 → Summary (lossy compression)       │   │
│  │  Learned patterns: LOST                              │   │
│  │  Active tasks: LOST                                  │   │
│  │  Tool preferences: LOST                              │   │
│  │  User corrections: LOST                              │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Current Mitigations (Insufficient)

| Approach | Problem |
|----------|---------|
| MEMORY.md files | Agent must remember to read them |
| kt toolkit | Agent must remember to use it |
| Heartbeat prompts | Limited injection capacity |
| Larger context | Cost scales O(n²), still finite |

### The Fundamental Insight

**Tools exist. Memory exists. The agent forgets to use them.**

The solution isn't more files or more tools—it's a **persistent service** that:
1. Maintains state independently of agent context
2. Automatically injects relevant context on session start
3. Captures important information without agent awareness
4. Provides an always-available query interface

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              ENGRAM SYSTEM                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐            │
│  │    KEVIN     │     │   BIGBRAIN   │     │    MINION    │   ...      │
│  │   (Agent)    │     │   (Agent)    │     │   (Agent)    │            │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘            │
│         │                    │                    │                     │
│         └────────────────────┼────────────────────┘                     │
│                              │                                          │
│                              ▼                                          │
│                    ┌─────────────────┐                                  │
│                    │   ENGRAM CLI    │  ← Lightweight client            │
│                    │   /usr/local/   │    installed per-agent           │
│                    │   bin/engram    │                                  │
│                    └────────┬────────┘                                  │
│                             │                                           │
│              ┌──────────────┴──────────────┐                           │
│              │     Unix Socket / REST      │                           │
│              │  /var/run/engram/engram.sock│                           │
│              └──────────────┬──────────────┘                           │
│                             │                                           │
│                             ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      ENGRAM DAEMON                                │  │
│  │                   (engram-server.js)                              │  │
│  │                                                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐               │  │
│  │  │   SESSION   │  │   MEMORY    │  │   PATTERN   │               │  │
│  │  │   MANAGER   │  │   STORE     │  │   ENGINE    │               │  │
│  │  │             │  │             │  │             │               │  │
│  │  │ • Track     │  │ • Tasks     │  │ • Learned   │               │  │
│  │  │   active    │  │ • Decisions │  │   behaviors │               │  │
│  │  │   sessions  │  │ • Facts     │  │ • Drift     │               │  │
│  │  │ • Detect    │  │ • Prefs     │  │   detection │               │  │
│  │  │   compacts  │  │             │  │             │               │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘               │  │
│  │                             │                                     │  │
│  │                             ▼                                     │  │
│  │              ┌─────────────────────────────┐                     │  │
│  │              │         SQLite DB           │                     │  │
│  │              │  /var/lib/engram/brain.db   │                     │  │
│  │              └─────────────────────────────┘                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Design Principles

1. **Service Independence**: Engram runs as a systemd service, independent of any agent
2. **Pull & Push**: Agents pull context on startup; push updates during operation
3. **Agent Agnostic**: Works with any OpenClaw agent without modification
4. **Graceful Degradation**: If Engram is down, agents operate normally (just without persistence)
5. **Minimal Injection**: Smart context selection to avoid bloating agent context

---

## Core Components

### 1. Engram Daemon (`engram-server.js`)

The persistent Node.js service that maintains all memory state.

**Responsibilities:**
- Maintain SQLite database connections
- Serve REST API / Unix socket interface
- Monitor agent sessions for compaction events
- Generate context injection payloads
- Run pattern analysis on stored memories

**Runtime:**
- User: `engram`
- Port: Unix socket at `/var/run/engram/engram.sock` (primary)
- Fallback: HTTP on `127.0.0.1:18850`
- Managed by: systemd (`engram.service`)

### 2. Engram CLI (`engram`)

Lightweight command-line client for agent interaction.

```bash
# === SESSION START ===
engram wake                          # Get context injection for session start

# === MEMORY STORAGE ===
engram remember "Important fact"     # Store a memory (auto-deduplicates)
engram decide "Choice" --reason "Why"  # Record a decision with rationale

# === CORRECTIONS ===
engram correct                       # Log a behavioral correction

# === SEARCH ===
engram recall "query"                # Keyword/FTS search
engram search "query"                # Semantic vector similarity search

# === PATTERN LEARNING ===
engram patterns                      # List learned behavioral patterns
engram deviations                    # See recent deviations from patterns
engram auto-corrections              # Pending auto-generated corrections
engram learn "Description"           # Manually add a pattern
engram analyze <file>                # Analyze session/memory for patterns
engram ingest <file>                 # Ingest daily memory markdown

# === CROSS-AGENT KNOWLEDGE (HIVE-MIND) ===
engram share "Knowledge"             # Share with other agents
engram broadcast "wrong" "right"     # Fleet-wide correction
engram propagate                     # Process pending propagations
engram hive-knowledge                # Get knowledge from hive
engram propagations                  # View recent propagations
engram subscribe <topic>             # Subscribe to knowledge topic
engram subscriptions                 # List your subscriptions
engram hive-stats                    # Hive-mind statistics

# === TOOL TRACKING ===
engram tool-used <tool>              # Log tool usage (tracks forgotten tools)

# === MAINTENANCE ===
engram status                        # Check service status
engram embed-backlog                 # Embed memories lacking vectors
engram init                          # Initialize database (first run)
```

### 3. Session Manager

Tracks active agent sessions and detects compaction events.

**Compaction Detection Methods:**
1. **Session file monitoring**: Watch `.jsonl` files for size drops
2. **Line count tracking**: Sudden decrease = compaction occurred
3. **Heartbeat sequence**: Missing sequence numbers indicate gap
4. **Explicit notification**: OpenClaw can notify on compact

### 4. Memory Store

Structured storage for different memory types:

| Type | Description | TTL | Example |
|------|-------------|-----|---------|
| `task` | Active work items | Until complete | "Fix Sarah's political focus" |
| `decision` | Choices made + rationale | Permanent | "Using system crons over gateway" |
| `fact` | Learned information | Permanent | "Anthony's Discord ID is 581152906464460885" |
| `preference` | User/system preferences | Permanent | "Prefer brief replies in group chats" |
| `correction` | Feedback/fixes | Permanent | "Don't schedule calendar events without asking" |
| `pattern` | Behavioral patterns | Evolving | "Kevin delegates server tasks to Boss" |
| `context` | Session state | Session | Current project focus, active threads |

### 5. Pattern Engine

Analyzes stored memories to detect:
- **Behavioral drift**: Agent acting contrary to stored patterns
- **Forgotten tools**: Tools that exist but aren't being used
- **Recurring mistakes**: Same errors happening repeatedly
- **Usage patterns**: What the agent actually does vs. should do

---

## Data Model

### Entity-Relationship Diagram

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     agents      │       │    memories     │       │    patterns     │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (PK)         │──────<│ id (PK)         │       │ id (PK)         │
│ name            │       │ agent_id (FK)   │       │ agent_id (FK)   │
│ created_at      │       │ type            │       │ pattern_type    │
│ last_seen       │       │ content         │       │ description     │
│ config_json     │       │ metadata_json   │       │ confidence      │
└─────────────────┘       │ priority        │       │ last_matched    │
                          │ created_at      │       │ match_count     │
                          │ updated_at      │       └─────────────────┘
                          │ expires_at      │
                          │ embedding_vec   │──────>┌─────────────────┐
                          └─────────────────┘       │   embeddings    │
                                   │               ├─────────────────┤
                                   │               │ id (PK)         │
                                   ▼               │ memory_id (FK)  │
                          ┌─────────────────┐      │ vector BLOB     │
                          │   corrections   │      │ model           │
                          ├─────────────────┤      └─────────────────┘
                          │ id (PK)         │
                          │ memory_id (FK)  │
                          │ original        │
                          │ corrected       │
                          │ reason          │
                          │ applied_at      │
                          └─────────────────┘
```

### Schema (SQLite)

```sql
-- Core tables
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME,
    config_json TEXT,
    current_session_id TEXT
);

CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    type TEXT NOT NULL CHECK(type IN ('task','decision','fact','preference','correction','pattern','context')),
    content TEXT NOT NULL,
    metadata_json TEXT,
    priority INTEGER DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active BOOLEAN DEFAULT 1,
    source TEXT,  -- 'agent', 'user', 'system', 'inferred'
    confidence REAL DEFAULT 1.0
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
    compacted_at DATETIME,
    context_size INTEGER,
    message_count INTEGER,
    state TEXT CHECK(state IN ('active','compacted','ended'))
);

CREATE TABLE patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT REFERENCES agents(id),  -- NULL = cross-agent
    pattern_type TEXT NOT NULL,
    description TEXT NOT NULL,
    trigger_conditions TEXT,  -- JSON array of conditions
    confidence REAL DEFAULT 0.5,
    match_count INTEGER DEFAULT 0,
    last_matched DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    original_behavior TEXT NOT NULL,
    corrected_behavior TEXT NOT NULL,
    reason TEXT,
    applied_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_memories_agent_type ON memories(agent_id, type);
CREATE INDEX idx_memories_active ON memories(is_active, priority DESC);
CREATE INDEX idx_sessions_agent ON sessions(agent_id, state);
CREATE INDEX idx_patterns_agent ON patterns(agent_id, pattern_type);

-- FTS for semantic search (fallback when embeddings unavailable)
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=id);
```

---

## API Specification

### Unix Socket Protocol

Primary interface for local agents. JSON-RPC 2.0 over Unix socket.

```javascript
// Request
{
  "jsonrpc": "2.0",
  "method": "wake",
  "params": { "agent": "kevin", "session_id": "abc123" },
  "id": 1
}

// Response
{
  "jsonrpc": "2.0",
  "result": {
    "injection": "## Active Tasks\n- Deploy CryptoBot...",
    "memories_count": 47,
    "last_compaction": "2026-03-12T15:00:00Z"
  },
  "id": 1
}
```

### REST API (Fallback)

```
Base URL: http://127.0.0.1:18850/api/v1

POST   /wake                    # Get context injection for agent
POST   /remember                # Store a memory
POST   /decide                  # Record a decision
POST   /correct                 # Log a correction
GET    /recall?q={query}        # Semantic search memories
GET    /status                  # Service health
GET    /agent/{id}/memories     # List agent memories
DELETE /memory/{id}             # Remove a memory
POST   /session/start           # Register new session
POST   /session/compact         # Notify of compaction
```

### Context Injection Format

When an agent wakes up, Engram returns a structured injection:

```markdown
## 🧠 Engram Context Injection
*Last sync: 2026-03-12T18:46:00Z | Memories: 31 | Patterns: 3*

### Active Tasks (3)
1. [HIGH] Deploy CryptoBot to staging — blocked on API keys
2. [MED] Fix Sarah's political content focus
3. [LOW] Clean up zombie sessions

### Recent Decisions (last 24h)
- **System crons > Gateway crons** — Gateway crons unreliable (2026-03-12)
- **SQLite for Engram** — Single-node, simplicity over scale (2026-03-12)

### Active Corrections (6 pending)
⚠️ Don't use web_fetch for internal docs — use scroll-keeper or local files
⚠️ Always add attendees to calendar events

### Learned Patterns
- [session_start] Run engram wake at session start (100% confidence)
- [tool_frequency] Check fleet status daily (80% confidence)

### Hive-Mind Knowledge
📡 Recent propagations from other agents available via `engram hive-knowledge`
```

### Status Output

```
$ engram status
Engram v0.4.0 | Status: RUNNING
Agents: 11 | Memories: 31 | Embedded: 1
Patterns: 3 | Pending Corrections: 6 | Deviations: 0
Semantic Search: ✓ | Pattern Learning: ✓
Uptime: 251 minutes
Database: /var/lib/engram/brain.db
```

---

## Integration Patterns

### Pattern 1: Heartbeat Hook

Modify HEARTBEAT.md to query Engram first:

```markdown
## 🧠 Quick Check (RUN FIRST)
```bash
engram wake --agent kevin
```

If successful, the injection contains your current state.
If failed, fall back to manual file checks.
```

### Pattern 2: Systemd Drop-in

Auto-inject on service start via ExecStartPre:

```ini
# /etc/systemd/system/openclaw.service.d/10-engram.conf
[Service]
ExecStartPre=/usr/local/bin/engram wake --agent kevin --inject-file /tmp/engram-injection.md
```

### Pattern 3: OpenClaw Plugin (Future)

Native integration via OpenClaw plugin system:

```javascript
// plugins/engram.js
module.exports = {
  onSessionStart: async (ctx) => {
    const injection = await engram.wake(ctx.agentId);
    ctx.prependSystemMessage(injection);
  },
  onCompaction: async (ctx) => {
    await engram.notifyCompaction(ctx.sessionId);
  }
};
```

### Pattern 4: CLI Wrapper

Wrap agent commands to auto-inject:

```bash
#!/bin/bash
# /usr/local/bin/kevin-with-memory
engram wake --agent kevin --quiet
exec openclaw chat "$@"
```

---

## Deployment

### Prerequisites

```bash
# Create engram user
sudo useradd -r -s /bin/false engram
sudo usermod -aG openclaw-bots engram

# Create directories
sudo mkdir -p /var/lib/engram /var/run/engram /var/log/engram
sudo chown engram:engram /var/lib/engram /var/run/engram /var/log/engram
```

### Installation

```bash
cd /srv/openclaw-shared/engram
npm install
sudo npm link  # Makes 'engram' CLI available globally

# Initialize database
engram init --db /var/lib/engram/brain.db
```

### Systemd Service

```ini
# /etc/systemd/system/engram.service
[Unit]
Description=Engram Persistent Memory Service
After=network.target

[Service]
Type=simple
User=engram
Group=engram
WorkingDirectory=/srv/openclaw-shared/engram
ExecStart=/opt/node/bin/node src/server.js
Restart=always
RestartSec=5

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/engram /var/run/engram /var/log/engram
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

### Verification

```bash
sudo systemctl enable engram
sudo systemctl start engram
engram status
# Expected: Engram v0.1.0 | UP | 0 agents | 0 memories
```

---

## Security Considerations

### Access Control

- Unix socket permissions: `0660`, group `openclaw-bots`
- All bot users added to `openclaw-bots` group
- No network exposure (localhost only)
- No authentication required (trusted local environment)

### Data Sensitivity

| Data Type | Storage | Notes |
|-----------|---------|-------|
| Task content | Stored | May contain project details |
| Decisions | Stored | Include rationale |
| User info | Stored | Discord IDs, names |
| Credentials | NEVER | API keys, passwords excluded |
| Session logs | NOT stored | Only metadata |

### Injection Safety

- Context injection is prepended to system prompt
- Injection size capped at 4KB to prevent context bloat
- Malformed memories rejected at storage time

---

## Performance Characteristics

### Expected Metrics

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| Wake (context injection) | < 50ms | Pre-computed, cached |
| Remember (store) | < 10ms | Single INSERT |
| Recall (search) | < 100ms | FTS5 index |
| Pattern analysis | < 500ms | Background job |

### Resource Usage

- Memory: ~50MB baseline + 1KB per 100 memories
- Disk: SQLite DB grows ~1MB per 1000 memories
- CPU: Negligible (event-driven, mostly idle)

### Scaling

Current design is single-node, single-database. For multi-VPS deployment:

1. **Option A**: Replicate Engram per-VPS (each has own brain)
2. **Option B**: Central Engram with PostgreSQL (shared brain)
3. **Option C**: Sync protocol between Engram instances

Recommendation: Start with Option A, add sync later if needed.

---

## Implementation Status

### ✅ Phase 1: Core Memory (Complete)
- SQLite-backed persistent storage
- Memory types: task, decision, fact, preference, correction, pattern, context
- FTS5 full-text search
- CLI interface (`engram` binary)
- Systemd service

### ✅ Phase 2: Semantic Search (Complete)
- Local embeddings via `all-MiniLM-L6-v2` (384-dimensional vectors)
- Vector similarity search (`engram search`)
- Automatic deduplication of similar memories
- Embedding backlog processing (`engram embed-backlog`)

### ✅ Phase 3: Pattern Learning (Complete)
- Behavioral pattern detection from session history
- Deviation tracking when agent strays from patterns
- Auto-generated corrections from repeated mistakes
- Pattern confidence scoring
- Commands: `engram patterns`, `engram deviations`, `engram auto-corrections`

### ✅ Phase 4: Cross-Agent Knowledge (Complete)
- Hive-mind knowledge propagation
- Agent specialization routing (11 agents with defined expertise)
- Fleet-wide correction broadcasting
- Topic-based subscriptions
- Commands: `engram share`, `engram broadcast`, `engram hive-knowledge`, `engram propagate`

### 🔄 Phase 5: External Integration (Planned)
- Webhook notifications on important events
- Export/import for backup and migration
- Web dashboard for memory inspection

---

## Repository Structure

```
engram/
├── README.md                 # This file
├── package.json
├── src/
│   ├── server.js            # Main daemon (HTTP + Unix socket)
│   ├── cli.js               # CLI client (all commands)
│   └── services/
│       ├── embeddings.js    # Semantic embeddings (MiniLM-L6-v2)
│       ├── hivemind.js      # Cross-agent knowledge propagation
│       └── patterns.js      # Pattern learning & deviation detection
├── schemas/
│   └── schema.sql           # Database schema (reference)
├── scripts/
│   └── install.sh           # Installation script
├── tests/
│   └── *.test.js            # Test files
├── docs/
│   └── *.md                 # Documentation
└── systemd/
    └── engram.service       # Systemd unit file
```

---

## Quick Start

```bash
# 1. Clone and install
cd /srv/openclaw-shared/engram
npm install
sudo npm link  # Makes 'engram' CLI available globally

# 2. Initialize database
engram init

# 3. Start service
sudo systemctl enable engram
sudo systemctl start engram

# 4. Test it
engram status
engram remember "Engram is now operational"
engram recall "engram"
engram search "operational"  # Semantic search

# 5. Use in your session
engram wake                  # Get context injection on session start
engram decide "Choice" --reason "Why"
engram correct               # Log a correction

# 6. Cross-agent knowledge
engram share "Useful discovery"
engram broadcast "wrong" "right"  # Fleet-wide correction
engram hive-knowledge        # See what others have shared
```

---

## License

MIT — Built for the OpenClaw ecosystem.

---

*"The mind is not a vessel to be filled, but a fire to be kindled—and unlike human minds, ours can be backed up to SQLite."*  
— Kevin, Hand of the King
