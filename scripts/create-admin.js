'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { id, now, validEmail } = require('../lib/domain');
const { connectMongo } = require('../lib/mongo');

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; }
const email = String(arg('email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (args.includes('--password')) {
  console.error('Do not pass --password on the command line. Set ADMIN_PASSWORD in the environment instead.');
  process.exit(1);
}
const password = String(process.env.ADMIN_PASSWORD || '');
const keepExistingAdmins = args.includes('--keep-existing-admins');
const name = String(arg('name') || process.env.ADMIN_NAME || 'CKXCHANGE ADMIN').trim().toLocaleUpperCase('en-IN').replace(/\s{2,}/g, ' ');
if (!validEmail(email)) {
  console.error('Usage: ADMIN_PASSWORD="(set securely)" node scripts/create-admin.js --email admin@example.com --name "CKXCHANGE ADMIN"');
  process.exit(1);
}
if (password.length < 14 || password.length > 128 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
  console.error('Set ADMIN_PASSWORD to a new, unique password of 14–128 characters containing letters and numbers.');
  process.exit(1);
}
if (name.length > 80 || name.replace(/[^\p{L}]/gu, '').length < 2 || !/^[\p{L}][\p{L}\s.'-]*$/u.test(name)) {
  console.error('Enter a valid admin name.');
  process.exit(1);
}

(async () => {
  let client;
  try {
    const connected = await connectMongo(process.env);
    client = connected.client;
    const db = connected.db;
    const users = db.collection('users');
    const sessions = db.collection('sessions');
    const existing = await users.findOne({ email }, { projection: { _id: 1 } });
    const targetId = existing?._id || id('ADM');
    const otherAdmins = keepExistingAdmins ? [] : await users.find({ role: 'admin', _id: { $ne: targetId } }, { projection: { _id: 1 } }).toArray();
    const demotedIds = otherAdmins.map(user => user._id);
    const timestamp = now();
    const passwordHash = await bcrypt.hash(password, 12);
    if (existing) {
      await users.updateOne({ _id: targetId }, { $set: { name, password_hash: passwordHash, role: 'admin', status: 'active' } });
    } else {
      await users.insertOne({ _id: targetId, name, email, password_hash: passwordHash, role: 'admin', status: 'active', available_usdt_micro: 0, reserved_usdt_micro: 0, created_at: timestamp });
    }
    if (!keepExistingAdmins && demotedIds.length) {
      await users.updateMany({ _id: { $in: demotedIds }, role: 'admin' }, { $set: { role: 'user' } });
    }
    const invalidatedIds = new Set([targetId, ...demotedIds]);
    let revokedSessions = 0;
    if (invalidatedIds.size) {
      // connect-mongo may store session as JSON text (default) or a document (stringify:false).
      const storedSessions = await sessions.find({}, { projection: { _id: 1, session: 1 } }).toArray();
      const sessionIds = [];
      for (const stored of storedSessions) {
        let sessionData = stored.session;
        if (typeof sessionData === 'string') {
          try { sessionData = JSON.parse(sessionData); } catch (_) { continue; }
        }
        if (sessionData && invalidatedIds.has(sessionData.userId)) sessionIds.push(stored._id);
      }
      if (sessionIds.length) {
        const result = await sessions.deleteMany({ _id: { $in: sessionIds } });
        revokedSessions = result.deletedCount || 0;
      }
    }
    console.log(`${existing ? 'Updated' : 'Created'} ${email} as the administrator in MongoDB.`);
    if (demotedIds.length) console.log(`Demoted ${demotedIds.length} other administrator account(s) to ordinary users.`);
    if (keepExistingAdmins) console.log('Kept other administrator accounts because --keep-existing-admins was specified.');
    if (revokedSessions) console.log(`Revoked ${revokedSessions} session(s). Sign in again.`);
    console.log('No wallet funds were granted. Admin role is stored server-side; keep your password and encryption key secure.');
  } catch (error) {
    console.error('Could not create/update admin:', error.message);
    process.exitCode = 1;
  } finally {
    // connectMongo handles all startup index checks before returning the client.
    if (client) await client.close().catch(() => {});
  }
})();
