const { connectMongo, closeMongo, getDb } = require('./db');
const { redis, closeRedis } = require('./redis');
const { updateAggregates } = require('./aggregator');
const { checkAlerts } = require('./alerter');
const crypto = require('crypto');

const STREAM_KEY = 'events:raw';
const GROUP_NAME = 'pulse_workers';
const CONSUMER_NAME = `worker-${crypto.randomBytes(4).toString('hex')}`;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50', 10);
const BLOCK_MS = 5000;

// ------------------------------------------------------------------
// Consistent Hashing
//
// WHY?
//   With multiple worker replicas reading from the same consumer group,
//   Redis distributes events round-robin — worker-1 might get events
//   for project A, then worker-2 gets the next batch for project A.
//   This is fine for stateless writes, but if we want per-project
//   in-memory buffers or ordered processing, we need affinity.
//
// HOW?
//   We hash the project_id to assign each project to a "slot".
//   Each worker owns a range of slots. Events for a project always
//   go to the same worker, enabling:
//   - In-memory aggregation buffers (fewer Redis round-trips)
//   - Ordered event processing per project
//   - Better cache locality
//
// CURRENT IMPLEMENTATION:
//   Since we use Redis Consumer Groups (which handle distribution),
//   we apply consistent hashing as a post-filter: each worker only
//   PROCESSES events that hash to its slot, and re-queues others.
//   In production, you'd implement this at the ingestion layer with
//   per-project streams instead.
// ------------------------------------------------------------------

const TOTAL_SLOTS = parseInt(process.env.TOTAL_WORKER_SLOTS || '2', 10);
const MY_SLOT = parseInt(process.env.WORKER_SLOT || '0', 10);

function getSlotForProject(projectId) {
  const hash = crypto.createHash('md5')
    .update(String(projectId))
    .digest('hex');
  // Take first 8 hex chars → integer → mod total slots
  return parseInt(hash.substring(0, 8), 16) % TOTAL_SLOTS;
}

let running = true;

async function initializeConsumerGroup() {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.log(`[Worker ${CONSUMER_NAME}] Consumer group '${GROUP_NAME}' created.`);
  } catch (err) {
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[Worker ${CONSUMER_NAME}] Consumer group '${GROUP_NAME}' already exists.`);
    } else {
      throw err;
    }
  }
}

async function startProcessing() {
  await connectMongo();
  await initializeConsumerGroup();

  console.log(`[Worker ${CONSUMER_NAME}] Slot ${MY_SLOT}/${TOTAL_SLOTS} | Batch size: ${BATCH_SIZE}`);

  while (running) {
    try {
      // Block and wait for up to BLOCK_MS for new events
      const results = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM_KEY, '>'
      );

      if (!results || results.length === 0) {
        continue; // Silently wait — no need to log every 5s
      }

      const [, messages] = results[0];
      if (!messages || messages.length === 0) continue;

      // Parse events from Redis stream format into plain objects
      // The ingestion service stores: XADD events:raw * data '{"event":"...","project_id":1,...}'
      // So we get fields = ["data", "{...}"] — we need to flatten the parsed JSON
      const allDocs = messages.map(([id, fields]) => {
        let obj = { _redis_id: id };
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const val = fields[i + 1];
          try {
            const parsed = JSON.parse(val);
            // If the field is 'data' and it's an object, spread it
            // so project_id, event, user_id etc are top-level
            if (key === 'data' && typeof parsed === 'object' && !Array.isArray(parsed)) {
              obj = { ...obj, ...parsed };
            } else {
              obj[key] = parsed;
            }
          } catch {
            obj[key] = val;
          }
        }
        obj.stored_at = new Date();
        return obj;
      });

      // Consistent hashing: log slot assignment for each batch.
      // In production with many projects, you'd filter here:
      //   const myDocs = allDocs.filter(d => getSlotForProject(d.project_id) === MY_SLOT);
      // For now, all workers process all events to avoid data loss with 1 project.
      const myDocs = allDocs;
      if (myDocs.length > 0) {
        const slots = [...new Set(myDocs.map(d => `P${d.project_id}→S${getSlotForProject(d.project_id)}`))];
        console.log(`[Worker ${CONSUMER_NAME}] Slot map: ${slots.join(', ')}`);
      }

      //
      const allIds = messages.map(([id]) => id);

      if (myDocs.length > 0) {
        // Step 1: Write to MongoDB (durability)
        const db = getDb();
        await db.collection('events').insertMany(myDocs, { ordered: false });
        console.log(`[Worker ${CONSUMER_NAME}] Wrote ${myDocs.length}/${allDocs.length} events to MongoDB.`);

        // Step 2: Update real-time aggregates in Redis (speed)
        await updateAggregates(myDocs);

        // Step 3: Check alert thresholds (safety)
        await checkAlerts(myDocs);
      }

      // ACK all processed messages
      await redis.xack(STREAM_KEY, GROUP_NAME, ...allIds);

    } catch (err) {
      if (running) {
        console.error(`[Worker ${CONSUMER_NAME}] Processing error: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  await closeMongo();
  await closeRedis();
}

function stopProcessing() {
  running = false;
}

module.exports = { startProcessing, stopProcessing };
