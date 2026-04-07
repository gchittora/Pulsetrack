const { MongoClient } = require('mongodb');

let db;
let client;

async function connectMongo() {
  if (db) return db;

  const mongoHost = process.env.MONGO_HOST || 'localhost';
  const mongoPort = process.env.MONGO_PORT || 27017;
  const mongoDbName = process.env.MONGO_DB || 'pulsetrack';
  const mongoUser = process.env.MONGO_USER || '';
  const mongoPass = process.env.MONGO_PASSWORD || '';

  const auth = mongoUser && mongoPass
    ? `${encodeURIComponent(mongoUser)}:${encodeURIComponent(mongoPass)}@`
    : '';
  const uri = `mongodb://${auth}${mongoHost}:${mongoPort}/?authSource=admin`;

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(mongoDbName);
  console.log(`[Worker] Connected to MongoDB at ${mongoHost}:${mongoPort}`);

  // Create indexes on first connect
  await ensureIndexes(db);

  return db;
}

// ------------------------------------------------------------------
// MongoDB Indexes — created once at startup, idempotent on restart.
//
// WHY compound index?
//   Queries like "all page_view events for project X in the last hour"
//   need to filter on project_id, event name, AND sort by time.
//   A compound index {project_id, event, timestamp} covers all three
//   in a single B-tree walk — no collection scan needed.
//
// WHY TTL index?
//   Without it, the events collection grows forever. The TTL index
//   makes MongoDB automatically delete documents older than 30 days.
//   No cron job, no manual cleanup — the database handles it.
// ------------------------------------------------------------------
async function ensureIndexes(database) {
  const events = database.collection('events');

  // Compound index: speeds up filtered + sorted queries
  await events.createIndex(
    { project_id: 1, event: 1, timestamp: -1 },
    { name: 'idx_project_event_time', background: true }
  );

  // TTL index: auto-delete events older than 30 days
  await events.createIndex(
    { stored_at: 1 },
    { name: 'idx_ttl_30d', expireAfterSeconds: 30 * 24 * 60 * 60, background: true }
  );

  // Single-field index on user_id for unique user counts
  await events.createIndex(
    { user_id: 1 },
    { name: 'idx_user_id', background: true }
  );

  console.log('[Worker] MongoDB indexes ensured (compound, TTL, user_id).');
}

async function closeMongo() {
  if (client) {
    await client.close();
    console.log('[Worker] MongoDB connection closed.');
  }
}

module.exports = { connectMongo, closeMongo, getDb: () => db };
