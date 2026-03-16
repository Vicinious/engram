#!/usr/bin/env node
/**
 * Engram CLI - Agent Memory Interface
 * 
 * Lightweight client for agents to interact with Engram service.
 * v0.2.0 - Added semantic search
 * v0.3.0 - Added pattern learning
 * v0.4.0 - Added hive-mind cross-agent knowledge propagation
 */

const { program } = require('commander');
const http = require('http');

const BASE_URL = process.env.ENGRAM_URL || 'http://127.0.0.1:18850';

function detectChannel() {
  const label = process.env.OPENCLAW_CONVERSATION_LABEL;
  if (label) {
    const match = label.match(/channel id:(\d+)/);
    if (match) return `discord:${match[1]}`;
  }

  if (process.env.ENGRAM_CHANNEL) {
    return process.env.ENGRAM_CHANNEL;
  }

  return null;
}

// HTTP request helper
const request = (method, path, data = null) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
};

program
  .name('engram')
  .description('Persistent memory for autonomous agents')
  .version('0.4.0');

// Wake command - get context injection
program
  .command('wake')
  .description('Get context injection for agent session start')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-s, --session <id>', 'Session ID')
  .option('-q, --quiet', 'Only output injection, no metadata')
  .action(async (options) => {
    try {
      const result = await request('POST', '/api/v1/wake', {
        agent: options.agent,
        session_id: options.session
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (options.quiet) {
        console.log(result.injection);
      } else {
        console.log(result.injection);
        console.log(`---`);
        console.log(`Memories: ${result.memories_count} | Tokens: ~${result.injection_tokens}`);
      }
    } catch (err) {
      console.error('Failed to connect to Engram:', err.message);
      process.exit(1);
    }
  });

// Remember command - store a memory (with deduplication)
program
  .command('remember <content>')
  .description('Store a memory (auto-deduplicates similar memories)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Memory type (task, decision, fact, preference, learning)', 'fact')
  .option('-p, --priority <n>', 'Priority 1-10', '5')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--expires <seconds>', 'Expire after N seconds')
  .option('--channel <channel>', 'Channel context (e.g., discord:1467909068189335552)')
  .option('--force', 'Skip deduplication check')
  .action(async (content, options) => {
    try {
      const channel = options.channel || detectChannel() || 'default';
      const result = await request('POST', '/api/v1/remember', {
        agent: options.agent,
        type: options.type,
        content,
        priority: parseInt(options.priority),
        tags: options.tags ? options.tags.split(',') : null,
        expires_in: options.expires,
        channel,
        skipDedupe: options.force
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.deduplicated) {
        console.log(`⚠️ Similar memory exists (${(result.similarity * 100).toFixed(0)}% match)`);
        console.log(`   Existing: ${result.existingContent}`);
        console.log(`   Use --force to store anyway`);
      } else {
        console.log(`✓ Stored memory #${result.id} (${options.type}, embedded)`);
      }
    } catch (err) {
      console.error('Failed to store memory:', err.message);
      process.exit(1);
    }
  });

// Decide command - record a decision (with deduplication)
program
  .command('decide <decision>')
  .description('Record a decision (auto-deduplicates)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-r, --reason <reason>', 'Reason for decision')
  .option('--channel <channel>', 'Channel context (e.g., discord:1467909068189335552)')
  .action(async (decision, options) => {
    try {
      const channel = options.channel || detectChannel() || 'default';
      const result = await request('POST', '/api/v1/decide', {
        agent: options.agent,
        decision,
        reason: options.reason,
        channel
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.deduplicated) {
        console.log(`⚠️ Similar decision exists (${(result.similarity * 100).toFixed(0)}% match)`);
      } else {
        console.log(`✓ Recorded decision #${result.id} (embedded)`);
      }
    } catch (err) {
      console.error('Failed to record decision:', err.message);
      process.exit(1);
    }
  });

// Correct command - log a correction
program
  .command('correct')
  .description('Log a behavioral correction')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .requiredOption('-o, --original <behavior>', 'Original incorrect behavior')
  .requiredOption('-c, --corrected <behavior>', 'Corrected behavior')
  .option('-r, --reason <reason>', 'Reason for correction')
  .option('-s, --severity <level>', 'Severity (low, medium, high, critical)', 'medium')
  .option('--channel <channel>', 'Channel context (e.g., discord:1467909068189335552)')
  .action(async (options) => {
    try {
      const channel = options.channel || detectChannel() || 'default';
      const result = await request('POST', '/api/v1/correct', {
        agent: options.agent,
        original: options.original,
        corrected: options.corrected,
        reason: options.reason,
        severity: options.severity,
        channel
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Logged correction #${result.id}`);
    } catch (err) {
      console.error('Failed to log correction:', err.message);
      process.exit(1);
    }
  });

// Recall command - FTS search (keyword-based)
program
  .command('recall <query>')
  .description('Search memories (keyword/FTS)')
  .option('-a, --agent <name>', 'Filter by agent')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('--channel <channel>', 'Filter to specific channel')
  .action(async (query, options) => {
    try {
      const params = new URLSearchParams({
        q: query,
        limit: options.limit
      });
      if (options.agent) params.set('agent', options.agent);
      if (options.type) params.set('type', options.type);
      if (options.channel) params.set('channel', options.channel);
      
      const result = await request('GET', `/api/v1/recall?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.results.length === 0) {
        console.log('No memories found matching query.');
        return;
      }
      
      console.log(`Found ${result.count} memories (FTS search):\n`);
      result.results.forEach((m, i) => {
        console.log(`${i+1}. [${m.type}] ${m.content}`);
        console.log(`   Agent: ${m.agent_id} | Priority: ${m.priority} | ${m.created_at}`);
        console.log();
      });
    } catch (err) {
      console.error('Failed to search memories:', err.message);
      process.exit(1);
    }
  });

// Search command - semantic search (vector similarity)
program
  .command('search <query>')
  .description('Semantic search memories (vector similarity)')
  .option('-a, --agent <name>', 'Filter by agent')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-m, --min-score <score>', 'Minimum similarity score (0-1)', '0.4')
  .action(async (query, options) => {
    try {
      const params = new URLSearchParams({
        q: query,
        limit: options.limit,
        minScore: options.minScore
      });
      if (options.agent) params.set('agent', options.agent);
      if (options.type) params.set('type', options.type);
      
      const result = await request('GET', `/api/v1/search?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.results.length === 0) {
        console.log('No semantically similar memories found.');
        return;
      }
      
      console.log(`Found ${result.count} memories (semantic search):\n`);
      result.results.forEach((m, i) => {
        const score = (m.score * 100).toFixed(0);
        console.log(`${i+1}. [${score}%] [${m.type}] ${m.content}`);
        console.log(`   Agent: ${m.agent_id} | Priority: ${m.priority} | ${m.created_at}`);
        console.log();
      });
    } catch (err) {
      console.error('Failed to search memories:', err.message);
      process.exit(1);
    }
  });

// Embed-backlog command - embed existing memories
program
  .command('embed-backlog')
  .description('Embed existing memories that lack embeddings')
  .option('-l, --limit <n>', 'Batch size', '50')
  .action(async (options) => {
    try {
      const result = await request('POST', '/api/v1/embed-backlog', {
        limit: parseInt(options.limit)
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.embedded === 0) {
        console.log('✓ All memories are already embedded');
      } else {
        console.log(`✓ Embedded ${result.embedded} memories`);
        if (result.remaining > 0) {
          console.log(`  ${result.remaining} remaining — run again to continue`);
        }
      }
    } catch (err) {
      console.error('Failed to embed backlog:', err.message);
      process.exit(1);
    }
  });

// Tool-used command - log tool usage
program
  .command('tool-used <tool>')
  .description('Log that a tool was used (for tracking forgotten tools)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('--channel <channel>', 'Channel context (e.g., discord:1467909068189335552)')
  .action(async (tool, options) => {
    try {
      const channel = options.channel || detectChannel() || 'default';
      const result = await request('POST', '/api/v1/tool-used', {
        agent: options.agent,
        tool,
        channel
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Logged tool usage: ${tool}`);
    } catch (err) {
      console.error('Failed to log tool usage:', err.message);
      process.exit(1);
    }
  });

// Status command - check service health
program
  .command('status')
  .description('Check Engram service status')
  .option('--channel <channel>', 'Filter status to specific channel context')
  .action(async (options) => {
    try {
      const params = new URLSearchParams();
      if (options.channel) params.set('channel', options.channel);
      const path = params.toString() ? `/api/v1/status?${params}` : '/api/v1/status';
      const result = await request('GET', path);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`Engram v${result.version} | Status: ${result.status.toUpperCase()}`);
      console.log(`Agents: ${result.agents} | Memories: ${result.memories} | Embedded: ${result.embeddedMemories || 0}`);
      console.log(`Patterns: ${result.patterns || 0} | Pending Corrections: ${result.pendingAutoCorrections || 0} | Deviations: ${result.unresolvedDeviations || 0}`);
      console.log(`Semantic Search: ${result.semanticSearch ? '✓' : '✗'} | Pattern Learning: ${result.patternLearning ? '✓' : '✗'}`);
      console.log(`Uptime: ${Math.floor(result.uptime / 60)} minutes`);
      console.log(`Database: ${result.dbPath}`);
    } catch (err) {
      console.error('Engram service is not running');
      console.error(`Connection failed: ${err.message}`);
      process.exit(1);
    }
  });

// Patterns command - list learned patterns
program
  .command('patterns')
  .description('List learned behavioral patterns')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Filter by pattern type')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({ agent: options.agent });
      if (options.type) params.set('type', options.type);
      
      const result = await request('GET', `/api/v1/patterns?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log('No patterns learned yet.');
        return;
      }
      
      console.log(`Learned Patterns (${result.count}):\n`);
      result.patterns.forEach((p, i) => {
        const confidence = (p.confidence * 100).toFixed(0);
        console.log(`${i+1}. [${p.type}] ${p.description} (${confidence}% confidence)`);
        console.log(`   Occurrences: ${p.occurrence_count} | Source: ${p.source}`);
      });
    } catch (err) {
      console.error('Failed to get patterns:', err.message);
      process.exit(1);
    }
  });

// Deviations command - list behavioral deviations
program
  .command('deviations')
  .description('List recent deviations from patterns')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-h, --hours <n>', 'Hours to look back', '24')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({
        agent: options.agent,
        hours: options.hours
      });
      
      const result = await request('GET', `/api/v1/deviations?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log('✓ No deviations detected in the last ' + options.hours + ' hours');
        return;
      }
      
      console.log(`Deviations (${result.count}):\n`);
      result.deviations.forEach((d, i) => {
        const icon = d.severity === 'high' ? '🔴' : d.severity === 'medium' ? '🟠' : '🟡';
        console.log(`${icon} ${d.description}`);
        if (d.pattern_description) {
          console.log(`   Expected: ${d.pattern_description}`);
        }
      });
    } catch (err) {
      console.error('Failed to get deviations:', err.message);
      process.exit(1);
    }
  });

// Auto-corrections command - list pending auto-corrections
program
  .command('auto-corrections')
  .description('List pending auto-generated corrections (repeated mistakes)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({ agent: options.agent });
      const result = await request('GET', `/api/v1/auto-corrections?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log('✓ No pending auto-corrections');
        return;
      }
      
      console.log(`Pending Auto-Corrections (${result.count}):\n`);
      result.autoCorrections.forEach((c, i) => {
        console.log(`${i+1}. [${c.occurrence_count}x] ${c.mistake_pattern.slice(0, 80)}...`);
        console.log(`   Suggested: ${c.suggested_correction.slice(0, 80)}...`);
        if (c.occurrence_count >= 3) {
          console.log(`   ⚠️ Will auto-promote to correction on next occurrence`);
        }
      });
    } catch (err) {
      console.error('Failed to get auto-corrections:', err.message);
      process.exit(1);
    }
  });

// Analyze command - analyze session or memory file
program
  .command('analyze <source>')
  .description('Analyze session history or memory file for patterns')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Source type: session or memory', 'memory')
  .action(async (source, options) => {
    try {
      const fs = require('fs');
      
      if (!fs.existsSync(source)) {
        console.error(`File not found: ${source}`);
        process.exit(1);
      }
      
      const content = fs.readFileSync(source, 'utf8');
      const date = source.match(/\d{4}-\d{2}-\d{2}/)?.[0] || 'unknown';
      
      let result;
      if (options.type === 'memory') {
        result = await request('POST', '/api/v1/ingest-memory', {
          agent: options.agent,
          content,
          date
        });
      } else {
        const events = JSON.parse(content);
        result = await request('POST', '/api/v1/analyze-session', {
          agent: options.agent,
          events
        });
      }
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Analyzed ${source}`);
      console.log(`  Events extracted: ${result.eventsExtracted || 'N/A'}`);
      console.log(`  Tools recorded: ${result.toolsUsed || 0}`);
      console.log(`  Sequences learned: ${result.sequencesLearned || 0}`);
      console.log(`  Mistakes processed: ${result.mistakesProcessed || 0}`);
    } catch (err) {
      console.error('Failed to analyze:', err.message);
      process.exit(1);
    }
  });

// Learn command - manually add a pattern
program
  .command('learn <description>')
  .description('Manually add a behavioral pattern')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Pattern type (session_start, tool_frequency, tool_sequence)', 'tool_frequency')
  .option('-p, --pattern <pattern>', 'Pattern data (tool name, sequence, etc.)')
  .option('-c, --confidence <n>', 'Confidence 0-1', '0.8')
  .action(async (description, options) => {
    try {
      const result = await request('POST', '/api/v1/patterns', {
        agent: options.agent,
        type: options.type,
        pattern: options.pattern || description,
        description,
        confidence: parseFloat(options.confidence)
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Added pattern #${result.id}`);
    } catch (err) {
      console.error('Failed to add pattern:', err.message);
      process.exit(1);
    }
  });

// Ingest command - analyze daily memory markdown files
program
  .command('ingest <file>')
  .description('Ingest a daily memory markdown file for pattern analysis')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-d, --date <date>', 'Date of the memory file (YYYY-MM-DD)')
  .action(async (file, options) => {
    try {
      const fs = require('fs');
      const content = fs.readFileSync(file, 'utf8');
      
      // Auto-detect date from filename
      let date = options.date;
      if (!date) {
        const match = file.match(/(\d{4}-\d{2}-\d{2})/);
        if (match) date = match[1];
      }
      
      const result = await request('POST', '/api/v1/ingest-memory', {
        agent: options.agent,
        content,
        date
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Ingested ${file}`);
      console.log(`  Events extracted: ${result.eventsExtracted}`);
      console.log(`  Tools: ${result.toolsUsed} | Sequences: ${result.sequencesLearned} | Mistakes: ${result.mistakesProcessed}`);
    } catch (err) {
      console.error('Failed to ingest memory file:', err.message);
      process.exit(1);
    }
  });

// Pattern stats command
program
  .command('pattern-stats')
  .description('Show pattern learning statistics')
  .option('-a, --agent <name>', 'Filter by agent')
  .action(async (options) => {
    try {
      const params = new URLSearchParams();
      if (options.agent) params.set('agent', options.agent);
      
      const result = await request('GET', `/api/v1/pattern-stats?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log('Pattern Learning Stats:');
      console.log(`  Patterns learned: ${result.patterns}`);
      console.log(`  Unresolved deviations: ${result.unresolvedDeviations}`);
      console.log(`  Pending auto-corrections: ${result.pendingAutoCorrections}`);
      console.log(`  Promoted corrections: ${result.promotedCorrections}`);
    } catch (err) {
      console.error('Failed to get pattern stats:', err.message);
      process.exit(1);
    }
  });

// Init command - placeholder for database initialization
program
  .command('init')
  .description('Initialize Engram database (run once on first install)')
  .option('--db <path>', 'Database path', '/var/lib/engram/brain.db')
  .action(async (options) => {
    console.log(`To initialize the database, start the engram service:`);
    console.log(`  sudo systemctl start engram`);
    console.log(`\nOr run manually:`);
    console.log(`  ENGRAM_DB=${options.db} node /srv/openclaw-shared/engram/src/server.js`);
  });

// ============================================
// HIVE-MIND COMMANDS (v0.4.0)
// ============================================

// Share knowledge to the hive
program
  .command('share <content>')
  .description('Share knowledge with other agents')
  .option('-a, --agent <name>', 'Source agent', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Knowledge type (correction, pattern, discovery, tool_trick, warning, best_practice)', 'discovery')
  .option('-p, --priority <level>', 'Priority (low, medium, high, critical)', 'medium')
  .option('--topics <topics>', 'Comma-separated topics')
  .option('--targets <agents>', 'Comma-separated target agents (default: auto-route)')
  .option('-i, --immediate', 'Propagate immediately')
  .action(async (content, options) => {
    try {
      const result = await request('POST', '/api/v1/hive/share', {
        agent: options.agent,
        type: options.type,
        content,
        priority: options.priority,
        topics: options.topics ? options.topics.split(',') : [],
        targets: options.targets ? options.targets.split(',') : null,
        immediate: options.immediate || false
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.propagated) {
        console.log(`✓ Shared and propagated to ${result.recipients} agents`);
      } else {
        console.log(`✓ Queued for propagation to ${result.targets} agents (ID: ${result.id})`);
      }
    } catch (err) {
      console.error('Failed to share:', err.message);
      process.exit(1);
    }
  });

// Broadcast a correction fleet-wide
program
  .command('broadcast <original> <corrected>')
  .description('Broadcast a correction to all agents immediately')
  .option('-a, --agent <name>', 'Source agent', process.env.ENGRAM_AGENT || 'kevin')
  .option('-r, --reason <reason>', 'Reason for correction')
  .action(async (original, corrected, options) => {
    try {
      const result = await request('POST', '/api/v1/hive/broadcast-correction', {
        agent: options.agent,
        original,
        corrected,
        reason: options.reason
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`📢 Correction broadcast to ${result.recipients} agents`);
    } catch (err) {
      console.error('Failed to broadcast:', err.message);
      process.exit(1);
    }
  });

// Process pending propagations
program
  .command('propagate')
  .description('Process all pending knowledge propagations')
  .action(async () => {
    try {
      const result = await request('POST', '/api/v1/hive/propagate', {});
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Processed ${result.processed} propagations`);
    } catch (err) {
      console.error('Failed to propagate:', err.message);
      process.exit(1);
    }
  });

// Get hive knowledge for an agent
program
  .command('hive-knowledge')
  .description('Get all knowledge for an agent (including from hive)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Filter by memory type')
  .option('-l, --limit <n>', 'Limit results', '20')
  .option('--no-hive', 'Exclude hive-propagated knowledge')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({
        agent: options.agent,
        limit: options.limit,
        includeHive: options.hive !== false ? 'true' : 'false'
      });
      if (options.type) params.set('type', options.type);
      
      const result = await request('GET', `/api/v1/hive/knowledge?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log('No knowledge found.');
        return;
      }
      
      console.log(`Knowledge for ${options.agent} (${result.count} items):\n`);
      result.knowledge.forEach((k, i) => {
        const hiveIcon = k.from_hive ? '🐝' : '📝';
        const source = k.source_agent ? ` (from ${k.source_agent})` : '';
        console.log(`${hiveIcon} [${k.type}] ${k.content.slice(0, 80)}...${source}`);
      });
    } catch (err) {
      console.error('Failed to get knowledge:', err.message);
      process.exit(1);
    }
  });

// View propagation history
program
  .command('propagations')
  .description('View recent knowledge propagations')
  .option('-l, --limit <n>', 'Limit results', '10')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({ limit: options.limit });
      const result = await request('GET', `/api/v1/hive/propagations?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log('No propagations yet.');
        return;
      }
      
      console.log(`Recent Propagations (${result.count}):\n`);
      result.propagations.forEach((p, i) => {
        const status = p.status === 'completed' ? '✓' : '⏳';
        const targets = JSON.parse(p.propagated_to || '[]');
        console.log(`${status} [${p.priority}] ${p.source_agent_id}: ${p.content.slice(0, 60)}...`);
        console.log(`   Type: ${p.knowledge_type} | Recipients: ${targets.length}`);
      });
    } catch (err) {
      console.error('Failed to get propagations:', err.message);
      process.exit(1);
    }
  });

// Hive stats
program
  .command('hive-stats')
  .description('Show hive-mind statistics')
  .action(async () => {
    try {
      const result = await request('GET', '/api/v1/hive/stats');
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log('🐝 Hive-Mind Stats:');
      console.log(`  Pending propagations: ${result.pendingPropagations}`);
      console.log(`  Completed propagations: ${result.completedPropagations}`);
      console.log(`  Memory links: ${result.memoryLinks}`);
      console.log(`  Hive memories: ${result.hiveMemories}`);
    } catch (err) {
      console.error('Failed to get hive stats:', err.message);
      process.exit(1);
    }
  });

// Subscribe to a topic
program
  .command('subscribe <topic>')
  .description('Subscribe an agent to a knowledge topic')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-p, --priority <level>', 'Minimum priority to receive (low, medium, high)', 'low')
  .action(async (topic, options) => {
    try {
      const result = await request('POST', '/api/v1/hive/subscribe', {
        agent: options.agent,
        topic,
        priorityThreshold: options.priority
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ ${options.agent} subscribed to topic: ${topic}`);
    } catch (err) {
      console.error('Failed to subscribe:', err.message);
      process.exit(1);
    }
  });

// List subscriptions
program
  .command('subscriptions')
  .description('List agent topic subscriptions')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .action(async (options) => {
    try {
      const params = new URLSearchParams({ agent: options.agent });
      const result = await request('GET', `/api/v1/hive/subscriptions?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.count === 0) {
        console.log(`${options.agent} has no subscriptions.`);
        return;
      }
      
      console.log(`Subscriptions for ${options.agent} (${result.count}):\n`);
      result.subscriptions.forEach(s => {
        console.log(`  - ${s.topic} (min priority: ${s.priority_threshold})`);
      });
    } catch (err) {
      console.error('Failed to get subscriptions:', err.message);
      process.exit(1);
    }
  });

program.parse();
