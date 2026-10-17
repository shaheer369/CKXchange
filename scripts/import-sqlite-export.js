'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { connectMongo } = require('../lib/mongo');

const exportFile = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'sqlite-export.json'));
const importOrder = ['users', 'banks', 'transactions', 'ledger', 'app_settings', 'audit_log'];

(async () => {
  let client;
  try {
    if (!fs.existsSync(exportFile)) throw new Error(`Export file not found: ${exportFile}. Run scripts/export-sqlite.py first.`);
    const payload = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    if (payload.format !== 'ckxchange-sqlite-export-v1' || !payload.collections) throw new Error('This is not a recognized CKXchange SQLite export.');
    const connected = await connectMongo(process.env);
    client = connected.client;
    const db = connected.db;
    for (const name of importOrder) {
      const count = await db.collection(name).countDocuments({});
      if (count > 0) throw new Error(`MongoDB collection '${name}' is not empty (${count} record(s)). Import only into a new/empty CKXchange database.`);
    }
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        for (const name of importOrder) {
          const documents = payload.collections[name] || [];
          if (documents.length) await db.collection(name).insertMany(documents, { ordered: true, session });
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    } finally {
      await session.endSession();
    }
    console.log('SQLite data imported to MongoDB successfully.');
    for (const name of importOrder) console.log(`  ${name}: ${(payload.collections[name] || []).length}`);
    console.log('Login sessions were not migrated. All users must sign in again.');
    console.log('Keep the existing BANK_ENCRYPTION_KEY in .env; imported bank account ciphertext requires that exact key.');
    console.log('The original SQLite database and export file were not deleted. Securely remove the export after verifying the migration.');
  } catch (error) {
    console.error('MongoDB import failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
  }
})();
