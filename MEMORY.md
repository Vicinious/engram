# Engram - Memory

**Last Updated:** 2026-03-16

## Overview
Persistent memory service that survives context compactions. The primary memory system for autonomous agents — higher priority than kt for session persistence.

## Status
- **Version:** 0.4.0 (production)
- **Location:** `/srv/openclaw-shared/engram/`
- **Service:** `engram.service` (systemd, port 3847)
- **Binary:** `/usr/local/bin/engram`
- **Database:** SQLite (`data/engram.db`)

## Recent Updates
- **2026-03-16:** AWP-050 COMPLETE — Channel-scoped memory
  - Added `channel` column to memories table
  - `--channel` flag for isolation (e.g., `--channel twitter`, `--channel general`)
  - Backwards compatible: no flag = all channels (default)
  - Commit: `107e2e0`

## Key Commands
| Command | Purpose |
|---------|---------|
| `engram wake --agent X` | Session start — inject context |
| `engram remember "X"` | Store a memory |
| `engram decide "X" --reason "Y"` | Log decision with reasoning |
| `engram correct -o "old" -c "new"` | Log correction |
| `engram recall "query"` | Search memories |
| `engram status` | Current state summary |
| `engram tool-used "X"` | Track tool usage (forgotten tool detection) |

## Channel Scoping (NEW 2026-03-16)
```bash
# Store to specific channel
engram remember "Twitter API trick" --channel twitter

# Recall only from channel
engram recall "API" --channel twitter

# Default (all channels)
engram recall "API"
```

## Architecture
```
Agent starts → engram wake → Server returns context injection
Agent works  → engram remember/decide/correct → Persisted to SQLite
Compaction   → Memory survives in engram.db
Next session → engram wake → Context restored
```

## Database Schema
- `memories` — Core storage (id, agent, type, content, priority, channel, timestamp)
- `decisions` — Decision log with reasoning
- `corrections` — Self-correction tracking
- `tool_usage` — Forgotten tool detection

## Service Management
```bash
sudo systemctl status engram
sudo systemctl restart engram
```

## Key Decisions
- **2026-03-12:** Initial production deployment
- **2026-03-13:** Added decision/correction tracking
- **2026-03-16:** AWP-050 channel scoping shipped

## Priority vs kt
| Use | Tool |
|-----|------|
| Persistent memory (survives compaction) | **engram** (PRIMARY) |
| Session logging, cross-agent sync | kt (SECONDARY) |

**Rule:** `engram wake` FIRST, then `kt` for session logging.

---
*SDLC: Full pipeline (Design → Impl → Review → SIT → SQT) completed for AWP-050*
