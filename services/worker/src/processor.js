const { redis } = require('./redis');
const { connectMongo } = require('./db');
const crypto = require('crypto');

const STREAM_NAME = 'events:raw';
const GROUP_NAME = 'pulse_workers';
// Generate a unique name for this worker (e.g., worker-4f9a) so Redis can track it independently
const CONSUMER_NAME = `worker-${crypto.randomBytes(4).toString('hex')}`;

// Ensure the Consumer Group exists before reading from it
async function initializeConsumerGroup() {
  try {
    // '0' means if the group is created, it will start reading from the very beginning of the existing stream
    // MKSTREAM automatically creates the stream 'events:raw' if it is totally empty/doesn't exist yet
    await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM');
    console.log(`[Worker ${CONSUMER_NAME}] Consumer group '${GROUP_NAME}' initialized for stream '${STREAM_NAME}'`);
  } catch (err) {
    // If the group already exists, Redis throws a BUSYGROUP error. This is totally safe and expected!
    if (err.message.includes('BUSYGROUP')) {
      console.log(`[Worker ${CONSUMER_NAME}] Consumer group '${GROUP_NAME}' already exists.`);
    } else {
      console.error(`[Worker ${CONSUMER_NAME}] Failed to create consumer group:`, err);
      process.exit(1);
    }
  }
}

// Parses the flat Redis array `['data', '{"event": "... "}']` back into a JSON object
function parseRedisStreamMessage(messageArray) {
  for (let i = 0; i < messageArray.length; i += 2) {
    const key = messageArray[i];
    const value = messageArray[i + 1];
    
    // In our Ingestion Service, we serialized the entire payload into the 'data' key natively
    if (key === 'data') {
      try {
        return JSON.parse(value);
      } catch (e) {
        console.error('Failed to parse event JSON:', value);
        return null; // Return null if it's corrupted so we can skip it
      }
    }
  }
  return null;
}

let isShuttingDown = false;

async function startProcessing() {
  await initializeConsumerGroup();
  const db = await connectMongo();
  const eventsCollection = db.collection('events');

  console.log(`[Worker ${CONSUMER_NAME}] 🕒 Waiting for events...`);

  // Infinite processing loop polling Redis
  while (!isShuttingDown) {
    try {
      // 1. Read up to 50 events from our specific group.
      // BLOCK 5000: If the queue is empty, wait gracefully for 5 seconds natively inside Redis (efficient)
      // '>': A special Redis ID that means "give me new messages that haven't been locked by any consumer yet"
      const streams = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', 50,
        'BLOCK', 5000,
        'STREAMS', STREAM_NAME, '>'
      );

      // Null means we blocked for 5s but no new events came in. Just loop again!
      if (streams && streams.length > 0) {
        const streamData = streams[0]; // Because we only queried one stream ('events:raw'), it's index 0
        const messages = streamData[1]; // Array of format: [ messageId, [key, val] ]
        
        if (messages.length === 0) continue;

        console.log(`[Worker ${CONSUMER_NAME}] 📥 Pulled ${messages.length} events from Redis.`);

        // 2. Transform the flat array into JSON objects
        const mongoDocs = [];
        const messageIdsToAck = [];

        for (const [messageId, fields] of messages) {
          const parsedData = parseRedisStreamMessage(fields);
          
          if (parsedData) {
            mongoDocs.push({
              _redisId: messageId,      // Keep track of exactly where this came from mapping to Redis IDs
              ...parsedData,            // Dump all the flexible properties dynamically
              processed_at: Date.now()  // Add our worker's processing timestamp
            });
          }
          // We always queue the ID up for clearing (even if parsing failed) to avoid a poisonous message crashing the queue forever
          messageIdsToAck.push(messageId); 
        }

        // 3. STRICT SYNCHRONOUS WRITE to MongoDB
        // We block here. If MongoDB is down, this will throw an error and we WILL NOT trigger step 4.
        if (mongoDocs.length > 0) {
          await eventsCollection.insertMany(mongoDocs);
          console.log(`[Worker ${CONSUMER_NAME}] 💾 Successfully wrote ${mongoDocs.length} events to MongoDB.`);
        }

        // 4. Acknowledge to Redis so they are removed from the pending list safely
        if (messageIdsToAck.length > 0) {
          await redis.xack(STREAM_NAME, GROUP_NAME, ...messageIdsToAck);
          console.log(`[Worker ${CONSUMER_NAME}] ✅ Acknowledged ${messageIdsToAck.length} processed events to Redis.`);
        }
      }
    } catch (err) {
      console.error(`[Worker ${CONSUMER_NAME}] ❌ Error during processing cycle:`, err);
      // Wait a moment so we don't aggressively spam error loops and crush the CPU
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

function stopProcessing() {
  console.log(`[Worker ${CONSUMER_NAME}] Shutting down processing loop...`);
  isShuttingDown = true;
}

module.exports = { startProcessing, stopProcessing };
