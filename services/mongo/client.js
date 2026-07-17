// Shared MongoClient for storage. Lazy connect; safe when MONGODB_URI unset.

'use strict';

let clientPromise = null;
let cachedUri = null;

async function getMongoClient(uri) {
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (clientPromise && cachedUri === uri) return clientPromise;

  cachedUri = uri;
  clientPromise = (async () => {
    let MongoClient;
    try {
      ({ MongoClient } = require('mongodb'));
    } catch (e) {
      throw new Error('mongodb package is not installed. Run: npm install mongodb');
    }
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 15000,
    });
    await client.connect();
    return client;
  })();

  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null;
    cachedUri = null;
    throw err;
  }
}

async function getDb(uri, dbName) {
  const client = await getMongoClient(uri);
  return client.db(dbName || 'videofurge');
}

async function closeMongo() {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch (_) {}
  clientPromise = null;
  cachedUri = null;
}

module.exports = { getMongoClient, getDb, closeMongo };
