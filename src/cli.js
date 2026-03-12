#!/usr/bin/env node
/**
 * Engram CLI - Agent Memory Interface
 * 
 * Lightweight client for agents to interact with Engram service.
 */

const { program } = require('commander');
const http = require('http');

const BASE_URL = process.env.ENGRAM_URL || 'http://127.0.0.1:18850';

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
  .version('0.1.0');

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

// Remember command - store a memory
program
  .command('remember <content>')
  .description('Store a memory')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-t, --type <type>', 'Memory type (task, decision, fact, preference, learning)', 'fact')
  .option('-p, --priority <n>', 'Priority 1-10', '5')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--expires <seconds>', 'Expire after N seconds')
  .action(async (content, options) => {
    try {
      const result = await request('POST', '/api/v1/remember', {
        agent: options.agent,
        type: options.type,
        content,
        priority: parseInt(options.priority),
        tags: options.tags ? options.tags.split(',') : null,
        expires_in: options.expires
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Stored memory #${result.id} (${options.type})`);
    } catch (err) {
      console.error('Failed to store memory:', err.message);
      process.exit(1);
    }
  });

// Decide command - record a decision
program
  .command('decide <decision>')
  .description('Record a decision')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .option('-r, --reason <reason>', 'Reason for decision')
  .action(async (decision, options) => {
    try {
      const result = await request('POST', '/api/v1/decide', {
        agent: options.agent,
        decision,
        reason: options.reason
      });
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`✓ Recorded decision #${result.id}`);
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
  .action(async (options) => {
    try {
      const result = await request('POST', '/api/v1/correct', {
        agent: options.agent,
        original: options.original,
        corrected: options.corrected,
        reason: options.reason,
        severity: options.severity
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

// Recall command - search memories
program
  .command('recall <query>')
  .description('Search memories')
  .option('-a, --agent <name>', 'Filter by agent')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query, options) => {
    try {
      const params = new URLSearchParams({
        q: query,
        limit: options.limit
      });
      if (options.agent) params.set('agent', options.agent);
      if (options.type) params.set('type', options.type);
      
      const result = await request('GET', `/api/v1/recall?${params}`);
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      if (result.results.length === 0) {
        console.log('No memories found matching query.');
        return;
      }
      
      console.log(`Found ${result.count} memories:\n`);
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

// Tool-used command - log tool usage
program
  .command('tool-used <tool>')
  .description('Log that a tool was used (for tracking forgotten tools)')
  .option('-a, --agent <name>', 'Agent name', process.env.ENGRAM_AGENT || 'kevin')
  .action(async (tool, options) => {
    try {
      const result = await request('POST', '/api/v1/tool-used', {
        agent: options.agent,
        tool
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
  .action(async () => {
    try {
      const result = await request('GET', '/api/v1/status');
      
      if (result.error) {
        console.error('Error:', result.error);
        process.exit(1);
      }
      
      console.log(`Engram v${result.version} | Status: ${result.status.toUpperCase()}`);
      console.log(`Agents: ${result.agents} | Memories: ${result.memories} | Active Sessions: ${result.activeSessions}`);
      console.log(`Uptime: ${Math.floor(result.uptime / 60)} minutes`);
      console.log(`Database: ${result.dbPath}`);
    } catch (err) {
      console.error('Engram service is not running');
      console.error(`Connection failed: ${err.message}`);
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

program.parse();
