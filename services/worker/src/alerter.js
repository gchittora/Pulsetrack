// ------------------------------------------------------------------
// Alert Worker
//
// WHY threshold-based alerting?
//   If a project suddenly gets 10x its normal traffic, that could mean:
//   - A bot attack flooding the ingestion endpoint
//   - A bug in the client SDK sending duplicate events
//   - A successful product launch (good problem to have)
//
//   Either way, the team needs to know immediately — not when they
//   check the dashboard an hour later.
//
// HOW it works:
//   After each batch, the processor calls checkAlerts(docs).
//   We use a Redis sliding window (1-minute buckets) to track
//   event rates per project. If the rate exceeds the threshold,
//   we publish an alert to the Redis Pub/Sub channel `alerts:spike`.
//
//   Any subscriber (dashboard WebSocket, Slack bot, PagerDuty hook)
//   can listen on that channel and react in real-time.
//
// WHY Redis Pub/Sub instead of writing alerts to MongoDB?
//   Alerts are ephemeral notifications, not durable records.
//   Pub/Sub is fire-and-forget with zero storage overhead.
//   If we later need to persist alerts, we add a subscriber that
//   writes to MongoDB — the publishers don't need to change.
// ------------------------------------------------------------------

const { redis } = require('./redis');

// If a project receives more than this many events per minute, trigger alert
const SPIKE_THRESHOLD = parseInt(process.env.ALERT_SPIKE_THRESHOLD || '500', 10);
const WINDOW_SECONDS = 60;
const ALERT_CHANNEL = 'alerts:spike';

// Cooldown: don't fire more than one alert per project per 5 minutes
const COOLDOWN_SECONDS = 300;

async function checkAlerts(docs) {
  if (!docs || docs.length === 0) return;

  // Group events by project_id to check rate per project
  const projectCounts = {};
  for (const doc of docs) {
    const pid = doc.project_id || 'unknown';
    projectCounts[pid] = (projectCounts[pid] || 0) + 1;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowKey = Math.floor(now / WINDOW_SECONDS); // Current 1-min bucket

  for (const [projectId, batchCount] of Object.entries(projectCounts)) {
    const rateKey = `rate:${projectId}:${windowKey}`;

    // Increment the rate counter for this 1-minute window
    const currentRate = await redis.incrby(rateKey, batchCount);
    await redis.expire(rateKey, WINDOW_SECONDS * 2); // Expire after 2 windows

    if (currentRate >= SPIKE_THRESHOLD) {
      // Check cooldown — don't spam alerts
      const cooldownKey = `alert:cooldown:${projectId}`;
      const inCooldown = await redis.get(cooldownKey);

      if (!inCooldown) {
        const alert = {
          type: 'SPIKE_DETECTED',
          project_id: projectId,
          current_rate: currentRate,
          threshold: SPIKE_THRESHOLD,
          window_seconds: WINDOW_SECONDS,
          timestamp: new Date().toISOString(),
          message: `Project ${projectId} hit ${currentRate} events/min (threshold: ${SPIKE_THRESHOLD})`
        };

        // Publish to Redis Pub/Sub — any subscriber gets it instantly
        await redis.publish(ALERT_CHANNEL, JSON.stringify(alert));
        console.log(`[Alert] SPIKE DETECTED: ${alert.message}`);

        // Set cooldown to prevent alert fatigue
        await redis.set(cooldownKey, '1', 'EX', COOLDOWN_SECONDS);
      }
    }
  }
}

module.exports = { checkAlerts };
