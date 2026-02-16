# Codebase Report: Wilco Improvement Engine & Learning Storage
Generated: 2026-02-13

## Summary

The Wilco improvement engine captures learnings from Claude Code sessions using a TypeScript SessionEnd hook that:
1. Extracts learnings via LLM (Claude Haiku) with Socratic prompting
2. Parses session metrics via regex (commits, retries, tool usage, etc.)
3. Stores both in a local PostgreSQL database (wilco-postgres)
4. Runs a daily analysis script to detect behavioral anti-patterns and generate rule candidates

**Key Finding:** Learnings are stored locally in Docker postgres, embeddings column exists but is **not populated**. No sync/export mechanism exists yet.

---

## Database Architecture

### Connection Details

```bash
# Container: wilco-postgres (pgvector/pgvector:pg16)
# Credentials
DATABASE_URL=postgresql://claude:claude_dev@localhost:5432/continuous_claude

# Access
docker exec wilco-postgres psql -U claude -d continuous_claude -c "SQL"
```

### Schema: archival_memory

**Primary learning storage table.**

```sql
CREATE TABLE archival_memory (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  text NOT NULL,
    agent_id    text,
    content     text NOT NULL,         -- The learning content
    metadata    jsonb DEFAULT '{}',     -- Type, tags, confidence, context
    embedding   vector(1024),          -- pgvector (1024-dim for bge-large-en-v1.5)
    created_at  timestamp DEFAULT now()
);
```

**Indexes:**
| Index | Type | Purpose |
|-------|------|---------|
| `archival_memory_pkey` | btree (id) | Primary key |
| `idx_archival_session` | btree (session_id) | Session lookup |
| `idx_archival_created` | btree (created_at DESC) | Time-based queries |
| `idx_archival_content_fts` | gin (to_tsvector) | Full-text search |
| `idx_archival_embedding` | ivfflat (cosine) | Vector similarity search |
| `idx_archival_metadata_type` | btree (metadata->>'type') | Type filtering |

**Current Status:**
- 27 learnings stored
- **Embeddings NOT populated** (all NULL)
- Full-text search index ready
- Vector index ready but unused

**Metadata Structure:**
```json
{
  "learning_type": "WORKING_SOLUTION | FAILED_APPROACH | CODEBASE_PATTERN | ...",
  "context": "description of what area this relates to",
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": "high | medium | low",
  "source": "llm-extraction"
}
```

### Related Tables

| Table | Purpose |
|-------|---------|
| `session_metrics` | Session statistics (commits, retries, tool usage, quality scores) |
| `improvement_candidates` | Generated rule candidates from pattern detection |
| `sessions` | Active session registry (cross-terminal coordination) |
| `file_claims` | File locking for concurrent sessions |
| `memory_tags` | Tag index (foreign key to archival_memory) |
| `core_memory` | Short-term working memory (not learnings) |
| `discord_sessions` | Discord integration metadata |
| `discord_developers` | Developer profiles |
| `discord_migrations` | Schema migration tracking |

---

## How Learnings Are Written

### Entry Point: SessionEnd Hook

**Location:** `/home/kev/.claude/hooks/src/session-end-learnings.ts`

**Trigger:** Runs automatically when any Claude Code session ends (logout, clear, exit).

**Process Flow:**

```
Session End Event
     │
     ├─→ Read transcript file
     │
     ├─→ Extract Metrics (regex-based, free)
     │    - commit count
     │    - avg diff lines
     │    - fix retry loops
     │    - architect escalations
     │    - tool usage counts
     │    - concurrent session count
     │
     ├─→ Extract Learnings (LLM-based, for sessions >500 chars)
     │    └─→ claude --print --model haiku --max-turns 1
     │         - Uses Socratic prompting template
     │         - Returns JSON array of learnings
     │         - Max 5 learnings per session
     │
     ├─→ Assess Quality (LLM-based, for sessions >1000 chars)
     │    └─→ claude --print --model haiku --max-turns 1
     │         - Detects anti-patterns (idle time, scope drift, etc.)
     │         - Returns quality score (1-10) + suggestions
     │
     └─→ Store in PostgreSQL
          ├─→ INSERT INTO archival_memory (learnings)
          └─→ INSERT INTO session_metrics (metrics + quality)
```

### Key Code Snippets

**Learning Extraction:**
```typescript
function storeLearnings(learnings: ExtractedLearning[], sessionId: string, container: string): number {
  const values = learnings.map(l => {
    const content = l.content.replace(/'/g, "''");
    const metadata = JSON.stringify({
      learning_type: l.type,
      context: l.context,
      tags: l.tags,
      confidence: l.confidence,
      source: 'llm-extraction',
    }).replace(/'/g, "''");

    return `('${sessionId.replace(/'/g, "''")}', '${content}', '${metadata}'::jsonb)`;
  }).join(',\n');

  const sql = `INSERT INTO archival_memory (session_id, content, metadata) VALUES ${values};`;
  const { ok, stdout } = execSql(container, sql);
  // ...
}
```

**Metrics Storage:**
```typescript
function storeMetrics(metrics: SessionMetrics, quality: SessionQuality | null, sessionId: string, container: string): boolean {
  const sql = `INSERT INTO session_metrics (
    session_id, commit_count, avg_diff_lines, fix_retry_loops,
    architect_escalations, tools_used, transcript_length, learning_count,
    concurrent_sessions, quality_assessment
  ) VALUES (
    '${sessionId}', ${metrics.commit_count}, ${metrics.avg_diff_lines},
    ${metrics.fix_retry_loops}, ${metrics.architect_escalations},
    '${toolsJson}'::jsonb, ${metrics.transcript_length}, ${metrics.learning_count},
    ${metrics.concurrent_sessions}, '${qualityJson}'::jsonb
  );`;
  // ...
}
```

### Learning Types

```typescript
type LearningType =
  | 'WORKING_SOLUTION'         // A fix/solution that worked
  | 'FAILED_APPROACH'          // Something that didn't work (avoid repeating)
  | 'CODEBASE_PATTERN'         // Discovered code pattern
  | 'ARCHITECTURAL_DECISION'   // Design choice made
  | 'ERROR_FIX'                // How a specific error was resolved
  | 'USER_PREFERENCE'          // User's preferred approach
  | 'ASSUMPTION_CORRECTION';   // Wrong assumption corrected
```

---

## Docker & Database Configuration

### Setup Scripts

**Server Setup:** `/home/kev/wilco/scripts/setup-server.sh`
- Starts `docker-compose up -d` (postgres + redis)
- Creates tables with `CREATE TABLE IF NOT EXISTS`
- Enables pgvector extension
- Binds to `127.0.0.1:5432` (localhost only, Tailscale access)

**User Setup:** `/home/kev/wilco/scripts/setup-user.sh`
- Installs hooks via symlinks
- Configures OTEL telemetry
- Installs ccusage (usage tracking)

### Docker Compose

**File:** `/home/kev/wilco/docker-compose.yml`

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: wilco-postgres
    environment:
      POSTGRES_USER: claude
      POSTGRES_PASSWORD: claude_dev
      POSTGRES_DB: continuous_claude
    ports:
      - '127.0.0.1:5432:5432'
    volumes:
      - wilco-pgdata:/var/lib/postgresql/data
    restart: unless-stopped
```

**Data Persistence:** Docker volume `wilco-pgdata`

---

## Improvement Engine

**Script:** `/home/kev/wilco/scripts/improve.sh`

**Trigger:** Manual or daily cron (`wilco improve`)

**What It Does:**

1. **Detects Gratuitous Commits** - Sessions with 5+ commits averaging <15 lines each
2. **Tracks Architect Escalations** - How often Claude escalates to GPT experts
3. **Finds Learning Clusters** - Repeated learning types (e.g., 3+ ASSUMPTION_CORRECTION learnings)
4. **Analyzes Quality Patterns** - Recurring quality issues from LLM assessments
5. **Detects Idle Sessions** - Concurrent sessions with no commits/activity
6. **Generates Rule Candidates** - Creates markdown files in `rules/candidates/`

**Example Query:**
```sql
-- Find sessions with gratuitous commits
SELECT session_id, commit_count, avg_diff_lines
FROM session_metrics
WHERE created_at > NOW() - INTERVAL '7 days'
  AND commit_count >= 5
  AND avg_diff_lines < 15
ORDER BY commit_count DESC;
```

**Output:** Rule candidates in `~/wilco/rules/candidates/` (e.g., `commit-batching.md`, `session-hygiene.md`)

---

## Embedding System (Not Yet Implemented)

### Current State
- **embedding column:** EXISTS (vector(1024))
- **Vector index:** EXISTS (ivfflat, cosine similarity)
- **Embeddings:** NOT POPULATED (all NULL)

### Expected Implementation (based on opc/ references in instructions)

The user's `.claude/rules/dynamic-recall.md` mentions:
- Backend: PostgreSQL with BGE embeddings (bge-large-en-v1.5)
- Dimension: 1024
- Model: BGE-large-en-v1.5
- Recall script: `opc/scripts/core/recall_learnings.py` (not in wilco repo)

**Likely Implementation Path:**
1. Batch embedding generation script (Python + sentence-transformers)
2. Updates archival_memory.embedding for all rows
3. Recall script queries via vector similarity + full-text hybrid search

---

## Export/Import Mechanisms

### Current Status: **NONE**

**No scripts found for:**
- Exporting learnings to JSON/YAML
- Importing learnings from files
- Syncing between databases
- Backing up learnings
- Migrating data between instances

### Manual Export Options

**Export all learnings as JSON:**
```bash
docker exec wilco-postgres psql -U claude -d continuous_claude -c \
  "SELECT json_agg(row_to_json(t)) FROM (
    SELECT id, session_id, content, metadata, created_at
    FROM archival_memory ORDER BY created_at
  ) t;" > learnings-export.json
```

**Export as CSV:**
```bash
docker exec wilco-postgres psql -U claude -d continuous_claude -c \
  "COPY (SELECT * FROM archival_memory ORDER BY created_at) TO STDOUT WITH CSV HEADER" \
  > learnings-export.csv
```

**pg_dump full backup:**
```bash
docker exec wilco-postgres pg_dump -U claude -d continuous_claude \
  --table=archival_memory --data-only > learnings-backup.sql
```

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `/home/kev/.claude/hooks/src/session-end-learnings.ts` | Learning capture hook (TypeScript) |
| `/home/kev/wilco/scripts/improve.sh` | Improvement engine (daily analysis) |
| `/home/kev/wilco/scripts/setup-server.sh` | Database initialization |
| `/home/kev/wilco/docker-compose.yml` | PostgreSQL container config |
| `/home/kev/wilco/.env` | DATABASE_URL connection string |

---

## Questions & Gaps

### Q: How are embeddings generated?
**A:** Not yet implemented. Column exists but is unpopulated. Likely needs:
- Python script with sentence-transformers
- Batch processing of existing learnings
- Background job to generate embeddings on insert

### Q: How to sync learnings between machines?
**A:** No mechanism exists. Options:
1. **pg_dump/restore** - Full backup/restore of archival_memory table
2. **JSON export/import** - Custom scripts (see manual export above)
3. **PostgreSQL replication** - Streaming replication to remote instance
4. **Application-level sync** - REST API + sync daemon (not built)

### Q: How to backfill embeddings?
**A:** Would need to write a script:
```python
import psycopg
from sentence_transformers import SentenceTransformer

model = SentenceTransformer('BAAI/bge-large-en-v1.5')
conn = psycopg.connect(DATABASE_URL)

# Fetch all learnings without embeddings
rows = conn.execute("SELECT id, content FROM archival_memory WHERE embedding IS NULL")

for row in rows:
    embedding = model.encode(row['content'])
    conn.execute(
        "UPDATE archival_memory SET embedding = %s WHERE id = %s",
        (embedding.tolist(), row['id'])
    )
conn.commit()
```

### Q: Where is the recall script?
**A:** Referenced in rules as `opc/scripts/core/recall_learnings.py` but not found in wilco repo. Likely in a separate `opc/` repository or not yet ported to wilco.

---

## Recommendations

1. **Implement Embedding Generation**
   - Add batch script to populate embeddings
   - Hook into SessionEnd to generate embeddings on insert
   - Test vector similarity search

2. **Build Export/Import Tools**
   - JSON export script for portability
   - Import script with deduplication
   - Document sync workflows

3. **Add Recall Interface**
   - Port or build recall_learnings.py script
   - Support hybrid search (vector + full-text)
   - Integrate with Claude Code via skill/MCP

4. **Database Replication** (for multi-machine sync)
   - Set up PostgreSQL streaming replication
   - Or build application-level sync service
   - Handle conflict resolution

5. **Documentation**
   - Document embedding generation process
   - Add migration guide for new team members
   - Create backup/restore runbook

---

## Sample Learnings

```json
[
  {
    "id": "80a615ad-4ba9-4da1-8fd9-1179044d8bc2",
    "session_id": "darena-scraper-timing",
    "content": "When accumulating timing values across multiple batches in a loop, JS timing variables extracted from...",
    "metadata": {
      "learning_type": "ERROR_FIX",
      "context": "mexico_scraper_html_capture.py timing system, multi-batch tab capture",
      "tags": ["timing", "javascript", "accumulation", "scraper"],
      "confidence": "high"
    },
    "created_at": "2026-02-12T12:25:09.982497"
  },
  {
    "id": "e2751562-fe9c-4623-86a8-a30388637f31",
    "session_id": "darena-scraper-dedup",
    "content": "Filter Google Maps feed URLs by hex data_id (0x...:0x... pattern) BEFORE opening tabs. Previously, d...",
    "metadata": {
      "learning_type": "WORKING_SOLUTION",
      "context": "mexico_scraper_html_capture.py search_and_capture, tab deduplication",
      "tags": ["scraper", "dedup", "performance", "google-maps"],
      "confidence": "high"
    },
    "created_at": "2026-02-12T12:25:09.982497"
  }
]
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code Session                                     │
│                                                          │
│  ~/.claude/hooks/src/session-end-learnings.ts           │
│                                                          │
│   SessionEnd Event                                       │
│        │                                                │
│        ├─→ Transcript Analysis (regex)                  │
│        │    - Session Metrics                           │
│        │                                                │
│        ├─→ Learning Extraction (Claude Haiku)           │
│        │    - Socratic Prompting                        │
│        │    - Max 5 learnings                           │
│        │                                                │
│        └─→ Quality Assessment (Claude Haiku)            │
│             - Anti-pattern detection                    │
│             - Quality score (1-10)                      │
│                                                          │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Docker: wilco-postgres (pgvector/pgvector:pg16)        │
│                                                          │
│  Database: continuous_claude                             │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ archival_memory                                 │    │
│  │  - id (uuid)                                    │    │
│  │  - session_id (text)                            │    │
│  │  - content (text)                               │    │
│  │  - metadata (jsonb)                             │    │
│  │  - embedding (vector(1024)) [NOT POPULATED]    │    │
│  │  - created_at (timestamp)                       │    │
│  │                                                 │    │
│  │ Indexes:                                        │    │
│  │  - Full-text search (gin)                      │    │
│  │  - Vector similarity (ivfflat) [UNUSED]        │    │
│  │  - Session, created_at, metadata->type         │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │ session_metrics                                 │    │
│  │  - commit_count, avg_diff_lines                │    │
│  │  - fix_retry_loops, architect_escalations      │    │
│  │  - tools_used (jsonb)                          │    │
│  │  - quality_assessment (jsonb)                  │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  Volume: wilco-pgdata (persistent)                       │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Improvement Engine (wilco improve)                      │
│                                                          │
│  /home/kev/wilco/scripts/improve.sh                      │
│                                                          │
│  Daily Analysis:                                         │
│   - Gratuitous commit patterns                           │
│   - Architect escalation frequency                       │
│   - Learning type clustering                             │
│   - Quality pattern detection                            │
│   - Idle concurrent sessions                             │
│                                                          │
│  Output: rules/candidates/*.md                           │
└─────────────────────────────────────────────────────────┘
```

---

## Open Questions

1. **Where is the opc/ repo?** - References in rules point to `opc/scripts/core/recall_learnings.py` which doesn't exist in wilco repo.
2. **Embedding generation plan?** - Column exists, needs implementation.
3. **Multi-user sync strategy?** - How to share learnings across team?
4. **Backup strategy?** - No automated backups mentioned.
5. **Migration from companion?** - If companion has learnings, how to import?

