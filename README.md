# Engram: Persistent Memory Architecture for Autonomous Agents

**Version:** 0.1.0  
**Author:** Kevin (Hand of the King)  
**Date:** 2026-03-12  
**Status:** Design Phase

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
# Context injection (run on session start)
engram wake --agent kevin

# Store a memory
engram remember --type task --priority high "Deploy CryptoBot to staging"

# Store a decision
engram decide "Using SQLite over Postgres" --reason "Single-node, simplicity > scale"

# Query memories
engram recall "what was the decision about databases"

# Log a correction (user feedback)
engram correct "Don't use web_fetch for internal docs"

# Check brain status
engram status
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
*Last sync: 2026-03-12T18:46:00Z | Memories: 47 | Patterns: 12*

### Active Tasks (3)
1. [HIGH] Deploy CryptoBot to staging — blocked on API keys
2. [MED] Fix Sarah's political content focus
3. [LOW] Clean up zombie sessions

### Recent Decisions (last 24h)
- **System crons > Gateway crons** — Gateway crons unreliable (2026-03-12)
- **SQLite for Engram** — Single-node, simplicity over scale (2026-03-12)

### Active Corrections
⚠️ Don't use web_fetch for internal docs — use scroll-keeper or local files
⚠️ Always add attendees to calendar events

### Pattern Drift Warnings
🔴 kt toolkit usage: 0% in last 3 sessions (expected: daily)
🟡 Memory consolidation: 7 days overdue

### Tools You Keep Forgetting
- `kt sync` — Run at session start
- `kt learn` — Log learnings for cross-agent sharing
- `brain status` — Quick state check (HEARTBEAT.md shortcut)
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

## Future Work

### Phase 2: Semantic Search
- Embed memories using local model (e.g., `all-MiniLM-L6-v2`)
- Vector similarity search for better recall
- Automatic deduplication of similar memories

### Phase 3: Pattern Learning
- Analyze session logs for behavioral patterns
- Detect when agent deviates from established patterns
- Auto-generate corrections from repeated mistakes

### Phase 4: Cross-Agent Knowledge
- Shared memory pool for all agents
- Learning propagation (one agent learns, all benefit)
- Conflict resolution for contradictory memories

### Phase 5: External Integration
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
│   ├── server.js            # Main daemon
│   ├── cli.js               # CLI client
│   ├── db/
│   │   ├── schema.sql       # Database schema
│   │   ├── migrations/      # Schema migrations
│   │   └── connection.js    # SQLite wrapper
│   ├── api/
│   │   ├── routes.js        # REST endpoints
│   │   └── socket.js        # Unix socket handler
│   ├── services/
│   │   ├── memory.js        # Memory CRUD
│   │   ├── session.js       # Session tracking
│   │   ├── injection.js     # Context generation
│   │   └── patterns.js      # Pattern analysis
│   └── utils/
│       ├── logger.js
│       └── config.js
├── schemas/
│   └── schema.sql           # Database schema (reference)
├── scripts/
│   ├── install.sh           # Installation script
│   └── migrate.sh           # Migration runner
├── tests/
│   ├── memory.test.js
│   ├── injection.test.js
│   └── api.test.js
├── docs/
│   ├── api.md               # API reference
│   ├── integration.md       # Integration guide
│   └── troubleshooting.md
└── systemd/
    └── engram.service       # Systemd unit file
```

---

## Quick Start

```bash
# 1. Clone and install
cd /srv/openclaw-shared/engram
npm install

# 2. Initialize database
./scripts/install.sh

# 3. Start service
sudo systemctl start engram

# 4. Test it
engram status
engram remember --type fact "Engram is now operational"
engram recall "engram"

# 5. Integrate with Kevin
# Add to HEARTBEAT.md:
# engram wake --agent kevin
```

---

## License

MIT — Built for the OpenClaw ecosystem.

---

*"The mind is not a vessel to be filled, but a fire to be kindled—and unlike human minds, ours can be backed up to SQLite."*  
— Kevin, Hand of the King
