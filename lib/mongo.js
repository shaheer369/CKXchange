'use strict';
const { MongoClient } = require('mongodb');

function databaseConfig(env = process.env) {
  const uri = String(env.MONGODB_URI || '').trim();
  const dbName = String(env.MONGODB_DB || 'ckxchange').trim();
  if (!uri) throw new Error('Set MONGODB_URI in .env to your MongoDB Atlas or replica-set connection string.');
  if (!dbName || dbName.length > 63) throw new Error('MONGODB_DB must be a valid database name.');
  return { uri, dbName };
}

async function connectMongo(env = process.env) {
  const { uri, dbName } = databaseConfig(env);
  const client = new MongoClient(uri, {
    appName: 'CKXchange',
    maxPoolSize: Number(env.MONGODB_MAX_POOL_SIZE || 5),
    serverSelectionTimeoutMS: Number(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
    retryWrites: true
  });
  try {
    await client.connect();
    const db = client.db(dbName);
    await db.command({ ping: 1 });
    await ensureIndexes(db);
    return { client, db, dbName };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function ensureIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'users_email_unique' }),
    db.collection('users').createIndex({ role: 1, status: 1 }, { name: 'users_role_status' }),
    db.collection('users').createIndex({ created_at: -1 }, { name: 'users_created_desc' }),
    db.collection('banks').createIndex({ user_id: 1, account_fingerprint: 1 }, { unique: true, name: 'banks_account_per_user_unique' }),
    db.collection('banks').createIndex({ user_id: 1, created_at: -1 }, { name: 'banks_user_created' }),
    db.collection('transactions').createIndex(
      { network: 1, tx_hash: 1 },
      { unique: true, name: 'transactions_network_hash_unique', partialFilterExpression: { network: { $type: 'string' }, tx_hash: { $type: 'string' } } }
    ),
    db.collection('transactions').createIndex({ user_id: 1, created_at: -1 }, { name: 'transactions_user_created' }),
    db.collection('transactions').createIndex({ type: 1, status: 1, created_at: 1 }, { name: 'transactions_status_queue' }),
    db.collection('ledger').createIndex({ transaction_id: 1, entry_type: 1 }, { unique: true, name: 'ledger_transaction_entry_unique' }),
    db.collection('ledger').createIndex({ user_id: 1, created_at: -1 }, { name: 'ledger_user_created' }),
    db.collection('audit_log').createIndex({ created_at: -1 }, { name: 'audit_created_desc' }),
    db.collection('notifications').createIndex({ recipient_id: 1, created_at: -1 }, { name: 'notifications_recipient_created' }),
    db.collection('notifications').createIndex({ recipient_id: 1, read_at: 1 }, { name: 'notifications_recipient_read' }),
    db.collection('push_subscriptions').createIndex({ user_id: 1, active: 1 }, { name: 'push_subscriptions_user_active' }),
    db.collection('push_outbox').createIndex({ state: 1, created_at: 1 }, { name: 'push_outbox_state_created' }),
    db.collection('app_settings').createIndex({ updated_at: -1 }, { name: 'settings_updated_desc' }),
    db.collection('rate_limits').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'rate_limits_expiry' })
  ]);
}

async function inTransaction(client, work) {
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { databaseConfig, connectMongo, ensureIndexes, inTransaction };
