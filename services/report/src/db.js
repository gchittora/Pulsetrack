const { MongoClient } = require('mongodb');

let db, client;

async function connectMongo() {
  if (db) return db;

  const host = process.env.MONGO_HOST || 'localhost';
  const port = process.env.MONGO_PORT || 27017;
  const dbName = process.env.MONGO_DB || 'pulsetrack';
  const user = process.env.MONGO_USER || '';
  const pass = process.env.MONGO_PASSWORD || '';

  const auth = user && pass
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : '';
  const uri = `mongodb://${auth}${host}:${port}/?authSource=admin`;

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  console.log('[Report] Connected to MongoDB');
  return db;
}

async function closeMongo() {
  if (client) await client.close();
}

module.exports = { connectMongo, closeMongo, getDb: () => db };
