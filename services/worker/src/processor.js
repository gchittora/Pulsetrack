const { connectMongo, closeMongo, getDb } = require('./db');
const { redis, closeRedis } = require('./redis');

const STREAM_KEY = 'events:raw';
const GROUP_NAME = 'pulse_workers';
const CONSUMER_NAME = `worker-${require('crypto').randomBytes(4).toString('hex')}`;
const BATCH_SIZE = 50;
const BLOCK_MS = 5000;

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
        console.log(`[Worker ${CONSUMER_NAME}] Waiting for events...`);
        continue;
      }

      const [, messages] = results[0];
      if (!messages || messages.length === 0) continue;

      console.log(`[Worker ${CONSUMER_NAME}] Pulled ${messages.length} events from Redis.`);

      // Parse events from Redis stream format into plain objects
      const docs = messages.map(([id, fields]) => {
        const obj = { _redis_id: id };
        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const val = fields[i + 1];
          try {
            obj[key] = JSON.parse(val);
          } catch {
            obj[key] = val;
          }
        }
        obj.stored_at = new Date();
        return obj;
      });

      // Write to MongoDB — XACK only happens AFTER confirmed write (zero data loss)
      const db = getDb();
      await db.collection('events').insertMany(docs, { ordered: false });
      console.log(`[Worker ${CONSUMER_NAME}] Successfully wrote ${docs.length} events to MongoDB.`);

      // Acknowledge all processed messages
      const ids = messages.map(([id]) => id);
      await redis.xack(STREAM_KEY, GROUP_NAME, ...ids);
      console.log(`[Worker ${CONSUMER_NAME}] Acknowledged ${ids.length} processed events to Redis.`);

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
