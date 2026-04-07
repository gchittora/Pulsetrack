// ------------------------------------------------------------------
// Aggregation Worker
//
// WHY separate from the DB writer?
//   The DB worker's job is durability — get events into MongoDB safely.
//   The aggregator's job is speed — maintain real-time counters in Redis
//   so the dashboard can show live stats in O(1) instead of running
//   expensive MongoDB aggregation pipelines on every page load.
//
// HOW it works:
//   After each batch is written to MongoDB, the processor calls
//   updateAggregates(docs). For each event in the batch, we increment:
//
//   1. stats:{project_id}:total          — total event count per project
//   2. stats:{project_id}:event:{name}   — count per event type
//   3. stats:{project_id}:daily:{date}   — count per day (for time-series)
//   4. stats:{project_id}:users          — unique user set (HyperLogLog)
//
// WHY Redis data structures?
//   - INCRBY for counters: atomic, O(1), survives concurrent workers
//   - PFADD (HyperLogLog) for unique users: uses only 12KB of memory
//     regardless of how many users there are (vs. storing every user_id)
//   - Keys auto-expire after 31 days to prevent unbounded growth
// ------------------------------------------------------------------

const { redis } = require('./redis');

const STATS_TTL = 31 * 24 * 60 * 60; // 31 days in seconds

async function updateAggregates(docs) {
  if (!docs || docs.length === 0) return;

  // Use a Redis pipeline to batch all counter updates into a single
  // round-trip. Without pipelining, 100 events = 400+ Redis calls.
  // With pipelining, 100 events = 1 Redis call containing 400+ commands.
  const pipeline = redis.pipeline();

  for (const doc of docs) {
    const projectId = doc.project_id || 'unknown';
    const eventName = doc.event || 'unknown';
    const userId = doc.user_id || 'anonymous';
    const date = new Date(doc.timestamp || Date.now())
      .toISOString()
      .split('T')[0]; // YYYY-MM-DD

    const projectKey = `stats:${projectId}`;

    // 1. Total events for this project
    pipeline.incrby(`${projectKey}:total`, 1);
    pipeline.expire(`${projectKey}:total`, STATS_TTL);

    // 2. Per event-type counter
    pipeline.incrby(`${projectKey}:event:${eventName}`, 1);
    pipeline.expire(`${projectKey}:event:${eventName}`, STATS_TTL);

    // 3. Daily time-series counter
    pipeline.incrby(`${projectKey}:daily:${date}`, 1);
    pipeline.expire(`${projectKey}:daily:${date}`, STATS_TTL);

    // 4. Unique users via HyperLogLog (12KB max memory per project)
    pipeline.pfadd(`${projectKey}:users`, userId);
    pipeline.expire(`${projectKey}:users`, STATS_TTL);
  }

  await pipeline.exec();
}

module.exports = { updateAggregates };
