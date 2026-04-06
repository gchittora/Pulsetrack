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

  const auth = mongoUser && mongoPass ? `${encodeURIComponent(mongoUser)}:${encodeURIComponent(mongoPass)}@` : '';
  const uri = `mongodb://${auth}${mongoHost}:${mongoPort}/?authSource=admin`;

  try {
    client = new MongoClient(uri);
    await client.connect();
    
    db = client.db(mongoDbName);
    console.log(`[Worker] ✅ Connected to MongoDB at ${mongoHost}:${mongoPort}`);
    
    // Ensure the events collection exists
    await db.createCollection('events').catch(() => {
      // Ignore error if collection already exists
    });

    return db;
  } catch (err) {
    console.error(`[Worker] ❌ Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }
}

async function closeMongo() {
  if (client) {
    await client.close();
    console.log('[Worker] MongoDB connection closed.');
  }
}

module.exports = { connectMongo, closeMongo };
