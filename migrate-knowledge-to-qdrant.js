#!/usr/bin/env node

/**
 * Migrate Knowledge Entries from MongoDB to Qdrant
 *
 * This script:
 * 1. Connects to MongoDB Atlas
 * 2. Reads all knowledge_entries
 * 3. Creates vector embeddings and stores in Qdrant via MCP tools
 */

const http = require('http');

const MCP_BRIDGE_URL = 'http://localhost:7779';
let requestId = 0;

// Call MCP tool via HTTP bridge
async function callMCPTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      name: toolName,
      arguments: args
    });

    const options = {
      hostname: 'localhost',
      port: 7779,
      path: '/api/mcp/tools/call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': `migrate-${++requestId}`,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(result);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Get all knowledge entries from MongoDB
async function getKnowledgeEntries() {
  const { MongoClient } = require('mongodb');

  const uri = 'mongodb+srv://dev:fvOKzv9enD8CSVwD@devdb.yqf8f8r.mongodb.net/?retryWrites=true&w=majority&appName=devDB';
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('coordinator_db_max');
    const entries = await db.collection('knowledge_entries').find({}).toArray();
    console.log(`Found ${entries.length} knowledge entries in MongoDB`);
    return entries;
  } finally {
    await client.close();
  }
}

// Migrate single entry to Qdrant with retry logic
async function migrateEntry(entry, retryCount = 0) {
  const maxRetries = 3;
  const baseDelay = 2000; // 2 seconds base delay

  try {
    console.log(`Migrating: ${entry.collection} - ${entry.entryId} (attempt ${retryCount + 1}/${maxRetries + 1})`);

    const result = await callMCPTool('qdrant_store', {
      collectionName: entry.collection,
      information: entry.text,
      metadata: entry.metadata || {}
    });

    console.log(`✓ Migrated: ${entry.entryId}`);
    return { success: true, entryId: entry.entryId };
  } catch (error) {
    // Retry with exponential backoff for socket hang up errors
    if (error.message.includes('socket hang up') && retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount); // 2s, 4s, 8s
      console.log(`⚠ Retry after ${delay}ms: ${entry.entryId}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return migrateEntry(entry, retryCount + 1);
    }

    console.error(`✗ Failed: ${entry.entryId} - ${error.message}`);
    return { success: false, entryId: entry.entryId, error: error.message };
  }
}

// Main migration function
async function migrateAll() {
  console.log('=== Knowledge Migration: MongoDB → Qdrant ===\n');

  try {
    // Get entries from MongoDB
    const entries = await getKnowledgeEntries();

    if (entries.length === 0) {
      console.log('No entries to migrate');
      return;
    }

    console.log(`\nStarting migration of ${entries.length} entries...\n`);
    console.log(`⚠ Using SEQUENTIAL processing to avoid OpenAI rate limits\n`);

    // Migrate SEQUENTIALLY (no parallel batches) to respect OpenAI rate limits
    const results = [];
    const delayBetweenEntries = 2000; // 2 seconds delay between each entry

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      console.log(`\n[${i + 1}/${entries.length}] Migrating: ${entry.collection} - ${entry.entryId}`);

      const result = await migrateEntry(entry);
      results.push(result);

      // Wait 2 seconds between entries to avoid rate limits
      if (i < entries.length - 1) {
        console.log(`Waiting ${delayBetweenEntries / 1000}s before next entry...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenEntries));
      }
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log('\n=== Migration Complete ===');
    console.log(`Total: ${entries.length}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
      console.log('\nFailed entries:');
      results.filter(r => !r.success).forEach(r => {
        console.log(`  - ${r.entryId}: ${r.error}`);
      });
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
if (require.main === module) {
  migrateAll()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { migrateAll, callMCPTool };
