'use strict';

require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcryptjs');
const { ensureIndexes, inTransaction } = require('./lib/mongo');
const { MongoClient } = require('mongodb');
const { getVapidConfig, hasVapidConfig, allowedPushEndpoint, sendPush } = require('./lib/web-push');
const {
  id, now, toUsdtMicro, fromUsdtMicro, toPaise, fromPaise, safeEqual, newCsrf,
  validName, validEmail, validDepositAddress, validTransactionHash, duplicateKeyError
} = require('./lib/domain');

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const APP_ORIGIN = String(process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
const RATE_DEFAULT = Number(process.env.INR_PER_USDT || 106);
const MIN_DEPOSIT_USDT = 10;
const MIN_PAYOUT_INR = 1000;
const MAX_PAYOUT_INR = 100_000;
const IS_PROD = process.env.NODE_ENV === 'production';
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const DB_NAME = String(process.env.MONGODB_DB || 'ckxchange').trim();
if (!Number.isFinite(RATE_DEFAULT) || RATE_DEFAULT <= 0 || RATE_DEFAULT > 100000) throw new Error('INR_PER_USDT must be a positive number.');
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || process.env.SESSION_SECRET.includes('replace-with')) {
  throw new Error('Set SESSION_SECRET in .env to at least 32 random characters.');
}
function readEncryptionKey() {
  const raw = String(process.env.BANK_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw) || raw.includes('replace-with')) {
    throw new Error('Set BANK_ENCRYPTION_KEY in .env to 64 hexadecimal characters (for example: openssl rand -hex 32).');
  }
  return Buffer.from(raw, 'hex');
}
const ENCRYPTION_KEY = readEncryptionKey();

const appRoot = __dirname;
if (!MONGODB_URI) throw new Error('MongoDB is now required. Set MONGODB_URI and MONGODB_DB in .env before starting CKXchange.');
if (!DB_NAME || DB_NAME.length > 63) throw new Error('MONGODB_DB must be a valid MongoDB database name.');
const mongoClient = new MongoClient(MONGODB_URI, {
  appName: 'CKXchange',
  maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 5),
  serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
  retryWrites: true
});
const mongoClientPromise = mongoClient.connect();
const db = mongoClient.db(DB_NAME);
// Reused between warm Vercel invocations. Indexes and transactions must be ready
// before any request is allowed to touch application state.
const mongoReadyPromise = mongoClientPromise.then(async () => {
  await db.command({ ping: 1 });
  await ensureIndexes(db);
  console.log(`CKXchange MongoDB ready; database: ${DB_NAME}`);
  return true;
});
// Attach a rejection handler immediately; request middleware and local startup
// still await the original promise and return a controlled error if it fails.
mongoReadyPromise.catch(() => {});

app.set('trust proxy', IS_PROD ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://ifsc.razorpay.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));

// A Vercel Function can receive requests as soon as it is initialized. Wait for
// MongoDB and required indexes rather than relying on a long-running listen() hook.
app.use(async (req, res, next) => {
  try {
    await mongoReadyPromise;
    next();
  } catch (error) {
    console.error('[mongodb-not-ready]', error?.message || error);
    res.status(503).json({ error: 'CKXchange is temporarily unavailable. Please try again shortly.' });
  }
});

// MongoDB is the source of truth for both application data and login sessions.
// Rolling cookie/store TTL keep an active user signed in for up to 10 days.
// MongoDB Atlas (replica set) is recommended because payouts and deposit approvals use transactions.
const SESSION_TTL_SECONDS = 10 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
function installSessionMiddleware(clientPromise) {
  app.use(session({
    name: 'ckx.sid',
    store: MongoStore.create({
      clientPromise,
      dbName: DB_NAME,
      collectionName: 'sessions',
      ttl: SESSION_TTL_SECONDS,
      touchAfter: 0,
      autoRemove: 'native'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_TTL_MS, path: '/' }
  }));
}
installSessionMiddleware(mongoClientPromise);

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); });
// Persistent, atomic rate limits. In-memory express-rate-limit counters reset across
// serverless instances, so these counters live in MongoDB instead.
function mongoRateLimiter({ scope, windowMs, limit, message }) {
  return async function rateLimitRequest(req, res, next) {
    const bucket = Math.floor(Date.now() / windowMs);
    const clientIp = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const ipFingerprint = crypto.createHash('sha256').update(clientIp).digest('hex').slice(0, 32);
    const key = `${scope}:${bucket}:${ipFingerprint}`;
    const collection = db.collection('rate_limits');
    const update = {
      $inc: { count: 1 },
      $setOnInsert: { expires_at: new Date((bucket + 2) * windowMs) }
    };
    try {
      let record;
      try {
        record = await collection.findOneAndUpdate(
          { _id: key }, update,
          { upsert: true, returnDocument: 'after', projection: { count: 1 } }
        );
      } catch (error) {
        // Two simultaneous first requests may race to create the same bucket.
        if (error?.code !== 11000) throw error;
        record = await collection.findOneAndUpdate(
          { _id: key }, { $inc: { count: 1 } },
          { returnDocument: 'after', projection: { count: 1 } }
        );
      }
      const count = Number(record?.count || 1);
      const resetSeconds = Math.max(0, Math.ceil((((bucket + 1) * windowMs) - Date.now()) / 1000));
      res.set('RateLimit-Limit', String(limit));
      res.set('RateLimit-Remaining', String(Math.max(0, limit - count)));
      res.set('RateLimit-Reset', String(resetSeconds));
      if (count > limit) return res.status(429).json({ error: message });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
const authLimiter = mongoRateLimiter({
  scope: 'auth', windowMs: 15 * 60 * 1000, limit: 20,
  message: 'Too many sign-in attempts. Please try again later.'
});
const mutationLimiter = mongoRateLimiter({
  scope: 'mutations', windowMs: 60 * 1000, limit: 40,
  message: 'Too many requests. Please slow down.'
});

function apiError(res, status, message) { return res.status(status).json({ error: message }); }
function requireCsrf(req, res, next) {
  if (!req.session.csrfToken || !safeEqual(req.get('x-csrf-token') || '', req.session.csrfToken)) return apiError(res, 403, 'Request security token is missing or expired. Refresh the page and try again.');
  next();
}
async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return apiError(res, 401, 'Please sign in to continue.');
    const user = await db.collection('users').findOne({ _id: req.session.userId });
    if (!user || user.status !== 'active') {
      req.session.destroy(() => {});
      return apiError(res, 401, 'Your account is unavailable. Please contact support.');
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return apiError(res, 403, 'Administrator access is required.');
  next();
}
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = String(req.get('origin') || '').trim().replace(/\/+$/, '');
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  const host = String(req.get('host') || '').trim();
  const requestOrigin = host ? `${req.protocol}://${host}`.replace(/\/+$/, '') : '';
  const originAllowed = !origin || origin === requestOrigin || (!!APP_ORIGIN && origin === APP_ORIGIN);
  if (!originAllowed) return apiError(res, 403, 'Request origin is not allowed. Open CKXchange using its configured website address.');
  if (fetchSite === 'cross-site') return apiError(res, 403, 'Cross-site requests are not allowed.');
  return requireCsrf(req, res, next);
});
// Every present and future admin API route requires a live, active admin user in MongoDB.
app.use('/api/admin', requireAuth, requireAdmin);

function userDto(user) {
  return { id: user._id || user.id, name: user.name, email: user.email, role: user.role, status: user.status,
    telegramId: user.telegram_id || '', phoneNumber: user.phone_number || '',
    availableUsdt: fromUsdtMicro(user.available_usdt_micro || 0), reservedUsdt: fromUsdtMicro(user.reserved_usdt_micro || 0), createdAt: user.created_at };
}
function accountMasked(last4) { return `•••• ${last4}`; }
function bankDto(row) { return { id: row._id || row.id, holder: row.holder, account: accountMasked(row.account_last4), last4: row.account_last4, ifsc: row.ifsc, bank: row.bank_name, branch: row.branch_name, createdAt: row.created_at }; }
function transactionDto(row, admin = false) {
  let account = row.bank_last4 ? accountMasked(row.bank_last4) : '';
  if (admin && row.bank_cipher) {
    try { account = decryptAccount(row.bank_cipher); } catch (_) { account = accountMasked(row.bank_last4); }
  }
  return { id: row._id || row.id, type: row.type, status: row.status, amount: fromPaise(row.amount_paise), usdt: fromUsdtMicro(row.usdt_micro),
    bankId: row.bank_id, holder: row.bank_holder, bank: row.bank_name, branch: row.branch_name, account, last4: row.bank_last4, ifsc: row.ifsc,
    network: row.network, txHash: row.tx_hash, depositAddress: row.deposit_address || '', bankReference: row.bank_reference, rejectionReason: row.rejection_reason,
    timestamp: row.created_at, updatedAt: row.updated_at, userId: row.user_id };
}
async function audit(adminId, action, targetId, details = {}, session = null) {
  const document = { _id: id('AUD'), admin_id: adminId, actor_id: adminId, actor_role: 'admin', action, target_id: targetId || null, details, created_at: now() };
  await db.collection('audit_log').insertOne(document, session ? { session } : {});
}
async function auditUser(userId, action, targetId, details = {}, session = null) {
  const document = { _id: id('AUD'), admin_id: null, actor_id: userId, actor_role: 'user', action, target_id: targetId || null, details, created_at: now() };
  await db.collection('audit_log').insertOne(document, session ? { session } : {});
}
async function getUserState(userId) {
  const [user, bankRows, transactionRows, rate] = await Promise.all([
    db.collection('users').findOne({ _id: userId }),
    db.collection('banks').find({ user_id: userId }).sort({ created_at: -1 }).toArray(),
    db.collection('transactions').find({ user_id: userId }).sort({ created_at: -1 }).limit(500).toArray(),
    currentRate()
  ]);
  if (!user) throw new Error('USER_NOT_FOUND');
  return { user: userDto(user), rate, banks: bankRows.map(bankDto), transactions: transactionRows.map(row => transactionDto(row)) };
}
function auditSafeUser(user) {
  return { id: user._id || user.id, name: user.name, email: user.email, role: user.role, status: user.status,
    telegramId: user.telegram_id || '', phoneNumber: user.phone_number || '',
    availableUsdt: fromUsdtMicro(user.available_usdt_micro), reservedUsdt: fromUsdtMicro(user.reserved_usdt_micro), createdAt: user.created_at };
}
function regenerateSession(req) { return new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve())); }
function saveSession(req) { return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); }

// Store account numbers encrypted with AES-256-GCM; the key never lives in MongoDB.
function encryptAccount(account) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(account), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}
function decryptAccount(payload) {
  const item = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(item.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8');
}
function fingerprint(userId, account) { return crypto.createHmac('sha256', ENCRYPTION_KEY).update(`${userId}:${account}`).digest('hex'); }

async function currentRate(session = null) {
  const option = session ? { session } : {};
  const row = await db.collection('app_settings').findOne({ _id: 'inr_per_usdt' }, option);
  const stored = row ? Number(row.setting_value) : RATE_DEFAULT;
  return Number.isFinite(stored) && stored > 0 && stored <= 100000 ? stored : RATE_DEFAULT;
}
async function currentRateSource() {
  const row = await db.collection('app_settings').findOne({ _id: 'inr_per_usdt' }, { projection: { _id: 1 } });
  if (row) return 'admin';
  return process.env.INR_PER_USDT ? 'environment' : 'default';
}
const ADDRESS_ENV = { TRC20: 'DEPOSIT_ADDRESS_TRC20' };
const NETWORK_LABELS = { TRC20: 'USDT on TRON (TRC20)' };
async function effectiveDepositAddress(network, session = null) {
  const option = session ? { session } : {};
  const row = await db.collection('app_settings').findOne({ _id: `deposit_address_${network}` }, option);
  const fallback = String(process.env[ADDRESS_ENV[network]] || '').trim();
  const address = String(row ? row.setting_value : fallback).trim();
  const source = row ? 'database' : (fallback ? 'environment' : 'not_configured');
  return { address, source, valid: validDepositAddress(network, address) };
}
async function depositSettingsDto() {
  const [resolved, rate, rateSource] = await Promise.all([effectiveDepositAddress('TRC20'), currentRate(), currentRateSource()]);
  return { addresses: { TRC20: { address: resolved.address, valid: resolved.valid, source: resolved.source, label: NETWORK_LABELS.TRC20 } }, rate, rateSource };
}
async function writeSetting(key, value, adminId, session) {
  await db.collection('app_settings').replaceOne({ _id: key }, { _id: key, setting_value: String(value), updated_by: adminId, updated_at: now() }, { upsert: true, session });
}
function normalizeTelegramUsername(value) {
  const username = String(value ?? '').trim().replace(/^@/, '');
  if (!username) return '';
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error('TELEGRAM_USERNAME_INVALID');
  return username;
}
function normalizeUserTelegramId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{5,20}$/.test(raw)) return raw;
  const username = raw.replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)) throw new Error('USER_TELEGRAM_INVALID');
  return `@${username}`;
}
function normalizePhoneNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const phone = raw.replace(/[\s().-]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(phone)) throw new Error('PHONE_NUMBER_INVALID');
  return phone;
}
async function currentTelegramSupportUsername(session = null) {
  const options = session ? { session, projection: { setting_value: 1 } } : { projection: { setting_value: 1 } };
  const row = await db.collection('app_settings').findOne({ _id: 'telegram_support_username' }, options);
  try { return normalizeTelegramUsername(row?.setting_value || ''); } catch (_) { return ''; }
}
function parseListParams(req) {
  const asInteger = (value, fallback, min, max) => {
    const number = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  return {
    page: asInteger(req.query.page, 1, 1, 1_000_000),
    pageSize: asInteger(req.query.pageSize, 25, 1, 100),
    q: String(req.query.q || '').trim().slice(0, 80)
  };
}
function escapedRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
async function matchingUserIds(q) {
  if (!q) return [];
  const regex = new RegExp(escapedRegExp(q), 'i');
  const rows = await db.collection('users').find({ $or: [{ _id: regex }, { name: regex }, { email: regex }] }, { projection: { _id: 1 } }).limit(500).toArray();
  return rows.map(row => row._id);
}
function paginationDto(page, pageSize, total) {
  return { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
async function runTransaction(work) { return inTransaction(mongoClient, work); }

function notificationId(eventKey, recipientId) { return `NTF:${eventKey}:${recipientId}`; }
async function queueNotification(session, recipient, eventKey, kind, title, body, route) {
  const key = notificationId(eventKey, recipient._id);
  const created = now();
  await db.collection('notifications').updateOne({ _id: key }, { $setOnInsert: {
    _id: key, recipient_id: recipient._id, recipient_role: recipient.role, event_key: eventKey,
    kind, title, body, route, read_at: null, created_at: created
  } }, { upsert: true, session });
  await db.collection('push_outbox').updateOne({ _id: key }, { $setOnInsert: {
    _id: key, recipient_id: recipient._id, recipient_role: recipient.role, event_key: eventKey, title, body, route,
    state: 'pending', attempts: 0, created_at: created, updated_at: created
  } }, { upsert: true, session });
  return key;
}
function notificationInr(amountPaise) {
  return fromPaise(amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function notificationUsdt(amountMicro) {
  return fromUsdtMicro(amountMicro).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
function abbreviatedHash(hash) {
  const value = String(hash || '');
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}
async function queueDepositAdminNotifications(session, transaction) {
  const admins = await db.collection('users').find({ role: 'admin', status: 'active' }, { session, projection: { _id: 1, role: 1 } }).toArray();
  const ids = [];
  const body = `New USDT deposit request: ${notificationUsdt(transaction.usdt_micro)} USDT (≈ ₹${notificationInr(transaction.amount_paise)}). Hash ${abbreviatedHash(transaction.tx_hash)} needs review.`;
  for (const admin of admins) {
    ids.push(await queueNotification(session, admin, `deposit-request:${transaction._id}`, 'deposit_request', 'USDT deposit request', body, '/admin/deposits'));
  }
  return ids;
}
async function queueDepositApprovedNotification(session, transaction) {
  const owner = await db.collection('users').findOne({ _id: transaction.user_id, role: { $in: ['user', 'admin'] }, status: 'active' }, { session, projection: { _id: 1, role: 1 } });
  if (!owner) throw new Error('USER_NOT_FOUND');
  const body = `Your deposit of ${notificationUsdt(transaction.usdt_micro)} USDT (≈ ₹${notificationInr(transaction.amount_paise)}) has been approved and credited to your CKXchange balance.`;
  return [await queueNotification(session, owner, `deposit-approved:${transaction._id}`, 'deposit_approved', 'USDT deposit approved', body, '/')];
}
async function queuePayoutSuccessNotification(session, transaction) {
  const owner = await db.collection('users').findOne({ _id: transaction.user_id, role: { $in: ['user', 'admin'] }, status: 'active' }, { session, projection: { _id: 1, role: 1 } });
  if (!owner) throw new Error('USER_NOT_FOUND');
  const last4 = /^\d{4}$/.test(String(transaction.bank_last4 || '')) ? transaction.bank_last4 : 'unavailable';
  const body = `Payout successful: ₹${notificationInr(transaction.amount_paise)} to bank account ending ${last4} (≈ ${notificationUsdt(transaction.usdt_micro)} USDT).`;
  return [await queueNotification(session, owner, `payout-success:${transaction._id}`, 'payout_success', 'Payout successful', body, '/')];
}
async function deliverPushOutbox(notificationIds) {
  if (!hasVapidConfig() || !Array.isArray(notificationIds) || notificationIds.length === 0) return;
  for (const key of [...new Set(notificationIds)].slice(0, 40)) {
    const leaseToken = crypto.randomBytes(12).toString('hex');
    const claim = await db.collection('push_outbox').findOneAndUpdate({ _id: key, $or: [
      { state: 'pending' }, { state: 'sending', lease_until: { $lte: now() } }
    ] }, { $set: {
      state: 'sending', lease_token: leaseToken,
      lease_until: new Date(Date.now() + 30000).toISOString(), updated_at: now()
    }, $inc: { attempts: 1 } }, { returnDocument: 'after' });
    const outbox = claim;
    if (!outbox) continue;
    const finalize = async (state, extra = {}) => db.collection('push_outbox').updateOne(
      { _id: key, state: 'sending', lease_token: leaseToken },
      { $set: { state, updated_at: now(), ...extra }, $unset: { lease_token: '', lease_until: '' } }
    );
    const preference = await db.collection('notification_preferences').findOne({ _id: outbox.recipient_id });
    const eventKey = String(outbox.event_key || '');
    let requiredRole = '';
    if (eventKey.startsWith('deposit-request:')) {
      const activeAdmin = await db.collection('users').findOne({ _id: outbox.recipient_id, role: 'admin', status: 'active' }, { projection: { _id: 1, role: 1 } });
      if (!activeAdmin || (outbox.recipient_role && outbox.recipient_role !== 'admin')) { await finalize('skipped'); continue; }
      requiredRole = 'admin';
    } else if (eventKey.startsWith('payout-success:')) {
      const activeOwner = await db.collection('users').findOne({ _id: outbox.recipient_id, role: { $in: ['user', 'admin'] }, status: 'active' }, { projection: { _id: 1, role: 1 } });
      if (!activeOwner || (outbox.recipient_role && outbox.recipient_role !== activeOwner.role)) { await finalize('skipped'); continue; }
      requiredRole = activeOwner.role;
    } else {
      await finalize('skipped'); continue;
    }
    if (preference?.push_enabled !== true) { await finalize('skipped'); continue; }
    const subscriptions = await db.collection('push_subscriptions').find({ user_id: outbox.recipient_id, user_role: requiredRole, active: true }).limit(5).toArray();
    if (!subscriptions.length) { await finalize('skipped'); continue; }
    const outcomes = await Promise.all(subscriptions.map(async row => {
      try {
        const result = await sendPush(row.subscription, {
          title: outbox.title,
          body: outbox.body,
          url: outbox.route,
          tag: outbox.event_key
        });
        if (result.gone) await db.collection('push_subscriptions').deleteOne({ _id: row._id, user_id: outbox.recipient_id });
        return { failed: false };
      } catch (error) {
        console.error('[push-delivery]', error?.message || error);
        return { failed: true };
      }
    }));
    await finalize(outcomes.some(result => result.failed) ? 'pending' : 'sent', { last_attempt_at: now() });
  }
}
async function deliverRecentPendingPushes(userId) {
  if (!hasVapidConfig()) return;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const retryAfter = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = await db.collection('push_outbox').find({ recipient_id: userId, created_at: { $gte: cutoff }, $or: [
    { state: 'sending', lease_until: { $lte: now() } },
    { state: 'pending', $or: [{ last_attempt_at: { $exists: false } }, { last_attempt_at: { $lte: retryAfter } }] }
  ] }, { projection: { _id: 1 } }).sort({ created_at: 1 }).limit(10).toArray();
  if (rows.length) await deliverPushOutbox(rows.map(row => row._id));
}
function notificationDto(row) {
  const safeRoute = typeof row.route === 'string' && row.route.startsWith('/') && !row.route.startsWith('//') ? row.route : '/';
  return { id: row._id, kind: row.kind, title: row.title, body: row.body, route: safeRoute, read: Boolean(row.read_at), createdAt: row.created_at };
}

// Public bootstrap and account endpoints.
app.get('/api/health', async (req, res, next) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true, database: 'mongodb', environment: IS_PROD ? 'production' : 'test', time: now() }); }
  catch (error) { next(error); }
});
app.get('/api/config', async (req, res, next) => {
  try {
    const network = String(req.query.network || 'TRC20').toUpperCase();
    if (network !== 'TRC20') return apiError(res, 400, 'Only USDT on TRON (TRC20) is supported.');
    const [setting, rate] = await Promise.all([effectiveDepositAddress('TRC20'), currentRate()]);
    return res.json({ rate, network: 'TRC20', depositAddress: setting.valid ? setting.address : '', depositConfigured: setting.valid, environment: IS_PROD ? 'production' : 'test' });
  } catch (error) { next(error); }
});
app.get('/api/auth/csrf', (req, res) => { if (!req.session.csrfToken) req.session.csrfToken = newCsrf(); res.json({ csrfToken: req.session.csrfToken }); });
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().toLocaleUpperCase('en-IN').replace(/\s{2,}/g, ' ');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!validName(name)) return apiError(res, 400, 'Enter a valid full name using letters, spaces, apostrophes, periods or hyphens.');
    if (!validEmail(email)) return apiError(res, 400, 'Enter a valid email address.');
    if (password.length < 10 || password.length > 128 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return apiError(res, 400, 'Password must be 10–128 characters and include at least one letter and one number.');
    const userId = id('USR');
    const document = { _id: userId, name, email, password_hash: await bcrypt.hash(password, 12), role: 'user', status: 'active', available_usdt_micro: 0, reserved_usdt_micro: 0, created_at: now() };
    try { await db.collection('users').insertOne(document); }
    catch (error) { if (duplicateKeyError(error)) return apiError(res, 409, 'An account with this email already exists.'); throw error; }
    await regenerateSession(req);
    req.session.userId = userId; req.session.csrfToken = newCsrf();
    await saveSession(req);
    res.status(201).json({ user: userDto(document), csrfToken: req.session.csrfToken });
  } catch (error) { next(error); }
});
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (password.length > 128) return apiError(res, 401, 'Email or password is incorrect, or the account is disabled.');
    const user = await db.collection('users').findOne({ email });
    const validPassword = user ? await bcrypt.compare(password, user.password_hash) : (await bcrypt.hash(password || 'unknown-user-password', 12), false);
    if (!user || !validPassword || user.status !== 'active') return apiError(res, 401, 'Email or password is incorrect, or the account is disabled.');
    await regenerateSession(req);
    req.session.userId = user._id; req.session.csrfToken = newCsrf();
    await saveSession(req);
    res.json({ user: userDto(user), csrfToken: req.session.csrfToken });
  } catch (error) { next(error); }
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: userDto(req.user) }));
app.put('/api/profile/contact', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    let telegramId;
    let phoneNumber;
    try {
      telegramId = normalizeUserTelegramId(req.body?.telegramId);
      phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
    } catch (error) {
      if (error.message === 'USER_TELEGRAM_INVALID') return apiError(res, 400, 'Enter a Telegram username (5–32 letters, numbers or underscores) or a numeric Telegram ID (5–20 digits).');
      if (error.message === 'PHONE_NUMBER_INVALID') return apiError(res, 400, 'Enter a valid phone number with country code if needed, or leave it blank.');
      throw error;
    }
    const result = await db.collection('users').updateOne(
      { _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active' },
      { $set: { telegram_id: telegramId, phone_number: phoneNumber, updated_at: now() } }
    );
    if (result.matchedCount !== 1) return apiError(res, 409, 'Your account is no longer active. Please sign in again.');
    const user = await db.collection('users').findOne({ _id: req.user._id });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, user: userDto(user), message: 'Support contact details saved.' });
  } catch (error) { next(error); }
});
app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('ckx.sid', { path: '/', sameSite: 'lax', secure: IS_PROD, httpOnly: true });
    res.json({ ok: true });
  });
});
// Account deletion preserves financial reconciliation while removing direct profile and bank identifiers.
app.post('/api/account/delete', requireAuth, mutationLimiter, async (req, res, next) => {
  const userId = req.user._id;
  const password = String(req.body?.password || '');
  const confirmation = String(req.body?.confirmation || '');
  if (req.user.role !== 'user') return apiError(res, 403, 'Administrator accounts cannot be deleted from the customer settings page.');
  if (confirmation !== 'DELETE') return apiError(res, 400, 'Type DELETE to confirm account deletion.');
  if (!password || password.length > 128) return apiError(res, 400, 'Enter your current password to continue.');

  let markedForDeletion = false;
  let deleted = false;
  try {
    const current = await db.collection('users').findOne({ _id: userId, status: 'active', role: 'user' }, { projection: { password_hash: 1 } });
    if (!current) return apiError(res, 409, 'This account is no longer active. Please sign in again or contact support.');
    if (!(await bcrypt.compare(password, current.password_hash))) return apiError(res, 403, 'The current password is incorrect.');

    const locked = await db.collection('users').updateOne(
      { _id: userId, status: 'active', role: 'user' },
      { $set: { status: 'deleting', deletion_requested_at: now() } }
    );
    if (locked.modifiedCount !== 1) return apiError(res, 409, 'The account could not be locked for deletion. Refresh and try again.');
    markedForDeletion = true;

    const deletedUserRef = `DELETED-${crypto.createHmac('sha256', ENCRYPTION_KEY).update(`deleted-user:${userId}`).digest('hex').slice(0, 32).toUpperCase()}`;
    await runTransaction(async mongoSession => {
      const users = db.collection('users');
      const transactions = db.collection('transactions');
      const user = await users.findOne({ _id: userId, role: 'user', status: 'deleting' }, { session: mongoSession });
      if (!user) throw new Error('DELETE_ACCOUNT_UNAVAILABLE');
      if (Number(user.available_usdt_micro || 0) !== 0 || Number(user.reserved_usdt_micro || 0) !== 0) throw new Error('DELETE_BLOCKED_BALANCE');
      const openRequests = await transactions.countDocuments({ user_id: userId, status: { $in: ['pending', 'processing'] } }, { session: mongoSession });
      if (openRequests > 0) throw new Error('DELETE_BLOCKED_REQUESTS');

      const deletedAt = now();
      await transactions.updateMany(
        { user_id: userId },
        {
          $set: { user_id: deletedUserRef, user_deleted: true, user_deleted_at: deletedAt },
          $unset: { bank_id: '', bank_cipher: '', bank_holder: '', bank_last4: '', bank_name: '', branch_name: '', ifsc: '' }
        },
        { session: mongoSession }
      );
      await db.collection('ledger').updateMany({ user_id: userId }, { $set: { user_id: deletedUserRef, user_deleted: true } }, { session: mongoSession });
      await db.collection('banks').deleteMany({ user_id: userId }, { session: mongoSession });
      // Account deletion also removes personal notification records, browser endpoints, and retry work.
      await db.collection('notifications').deleteMany({ recipient_id: userId }, { session: mongoSession });
      await db.collection('push_subscriptions').deleteMany({ user_id: userId }, { session: mongoSession });
      await db.collection('push_outbox').deleteMany({ recipient_id: userId }, { session: mongoSession });
      await db.collection('notification_preferences').deleteOne({ _id: userId }, { session: mongoSession });
      // connect-mongo versions may store the session payload as either an object or JSON text.
      const sessionsCollection = db.collection('sessions');
      const sessionJsonMatch = new RegExp(`\"userId\"\\s*:\\s*\"${escapedRegExp(userId)}\"`);
      const matchingSessions = await sessionsCollection.find({ $or: [{ 'session.userId': userId }, { session: sessionJsonMatch }] }, { session: mongoSession, projection: { _id: 1 } }).toArray();
      if (matchingSessions.length) await sessionsCollection.deleteMany({ _id: { $in: matchingSessions.map(row => row._id) } }, { session: mongoSession });
      await db.collection('audit_log').insertOne({
        _id: id('AUD'), actor_id: deletedUserRef, actor_role: 'user', admin_id: null,
        action: 'user_account_deleted', target_id: deletedUserRef,
        details: { financialRecordsPreserved: true, directProfileAndBankDataRemoved: true }, created_at: deletedAt
      }, { session: mongoSession });
      const removed = await users.deleteOne({ _id: userId, status: 'deleting', role: 'user' }, { session: mongoSession });
      if (removed.deletedCount !== 1) throw new Error('DELETE_ACCOUNT_UNAVAILABLE');
    });
    deleted = true;
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('ckx.sid', { path: '/', sameSite: 'lax', secure: IS_PROD, httpOnly: true });
      return res.json({ ok: true, message: 'Your account has been deleted. Financial records required for reconciliation were retained without your direct profile or bank account details.' });
    });
  } catch (error) {
    if (markedForDeletion && !deleted) {
      try { await db.collection('users').updateOne({ _id: userId, status: 'deleting' }, { $set: { status: 'active' }, $unset: { deletion_requested_at: '' } }); }
      catch (restoreError) { console.error('[account-delete-restore-failed]', restoreError?.message || restoreError); }
    }
    if (error.message === 'DELETE_BLOCKED_BALANCE') return apiError(res, 409, 'Account deletion is blocked while your available or reserved USDT balance is not zero. Resolve the balance first.');
    if (error.message === 'DELETE_BLOCKED_REQUESTS') return apiError(res, 409, 'Account deletion is blocked while deposits or payouts are Pending or Processing. Wait until all requests are resolved.');
    if (error.message === 'DELETE_ACCOUNT_UNAVAILABLE') return apiError(res, 409, 'This account is no longer available for deletion. Please sign in again.');
    return next(error);
  }
});
app.get('/api/state', requireAuth, async (req, res, next) => { try { res.json(await getUserState(req.user._id)); } catch (error) { next(error); } });
app.get('/api/support', async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ telegramUsername: await currentTelegramSupportUsername() }); }
  catch (error) { next(error); }
});

// Bank management: account number is encrypted; bank and branch fields come from Razorpay IFSC directory.
app.get('/api/notifications/push-public-key', (req, res) => {
  const config = getVapidConfig();
  res.set('Cache-Control', 'no-store');
  res.json({ publicKey: config?.publicText || '', configured: Boolean(config) });
});
app.get('/api/notifications/preferences', requireAuth, async (req, res, next) => {
  try {
    const [preference, subscriptionCount] = await Promise.all([
      db.collection('notification_preferences').findOne({ _id: req.user._id }),
      db.collection('push_subscriptions').countDocuments({ user_id: req.user._id, user_role: req.user.role, active: true })
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ inAppEnabled: preference?.in_app_enabled !== false, pushEnabled: preference?.push_enabled === true && subscriptionCount > 0, pushConfigured: hasVapidConfig(), subscriptionCount });
  } catch (error) { next(error); }
});
app.put('/api/notifications/preferences', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    if (typeof req.body?.inAppEnabled !== 'boolean') return apiError(res, 400, 'Choose whether in-app notifications are enabled.');
    await db.collection('notification_preferences').updateOne({ _id: req.user._id }, {
      $set: { in_app_enabled: req.body.inAppEnabled, updated_at: now() },
      $setOnInsert: { push_enabled: false }
    }, { upsert: true });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post('/api/notifications/subscribe', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    if (!hasVapidConfig()) return apiError(res, 503, 'Browser push notifications are not configured on the server yet. In-app notifications remain available.');
    const value = req.body?.subscription;
    if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048 || !allowedPushEndpoint(value.endpoint) ||
        typeof value.keys?.p256dh !== 'string' || value.keys.p256dh.length > 256 || typeof value.keys?.auth !== 'string' || value.keys.auth.length > 128) {
      return apiError(res, 400, 'The browser push subscription is invalid or unsupported.');
    }
    const endpointKey = crypto.createHash('sha256').update(value.endpoint).digest('hex');
    await db.collection('push_subscriptions').updateOne({ _id: endpointKey }, { $set: {
      _id: endpointKey, user_id: req.user._id, user_role: req.user.role,
      subscription: { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } },
      active: true, updated_at: now()
    }, $setOnInsert: { created_at: now() } }, { upsert: true });
    await db.collection('notification_preferences').updateOne({ _id: req.user._id }, {
      $set: { push_enabled: true, updated_at: now() }, $setOnInsert: { in_app_enabled: true }
    }, { upsert: true });
    res.json({ ok: true, message: 'Browser push notifications enabled for this account.' });
  } catch (error) { next(error); }
});
app.post('/api/notifications/unsubscribe', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    await Promise.all([
      db.collection('push_subscriptions').deleteMany({ user_id: req.user._id }),
      db.collection('notification_preferences').updateOne({ _id: req.user._id }, { $set: { push_enabled: false, updated_at: now() }, $setOnInsert: { in_app_enabled: true } }, { upsert: true })
    ]);
    res.json({ ok: true, message: 'Browser push notifications disabled for this account.' });
  } catch (error) { next(error); }
});
app.get('/api/notifications', requireAuth, async (req, res, next) => {
  try {
    await deliverRecentPendingPushes(req.user._id);
    const preference = await db.collection('notification_preferences').findOne({ _id: req.user._id });
    if (preference?.in_app_enabled === false) return res.json({ notifications: [], unreadCount: 0, inAppEnabled: false });
    const filter = { recipient_id: req.user._id, recipient_role: req.user.role };
    // An account that was demoted from admin must not retain visibility of historic admin-only alerts.
    if (req.user.role !== 'admin') filter.kind = { $ne: 'deposit_request' };
    const [rows, unreadCount] = await Promise.all([
      db.collection('notifications').find(filter).sort({ created_at: -1 }).limit(50).toArray(),
      db.collection('notifications').countDocuments({ ...filter, read_at: null })
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ notifications: rows.map(notificationDto), unreadCount, inAppEnabled: true });
  } catch (error) { next(error); }
});
app.post('/api/notifications/read-all', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const filter = { recipient_id: req.user._id, recipient_role: req.user.role, read_at: null };
    if (req.user.role !== 'admin') filter.kind = { $ne: 'deposit_request' };
    const result = await db.collection('notifications').updateMany(filter, { $set: { read_at: now() } });
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (error) { next(error); }
});
app.post('/api/notifications/:id/read', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const filter = { _id: req.params.id, recipient_id: req.user._id, recipient_role: req.user.role, read_at: null };
    if (req.user.role !== 'admin') filter.kind = { $ne: 'deposit_request' };
    const result = await db.collection('notifications').updateOne(filter, { $set: { read_at: now() } });
    if (!result.matchedCount) return apiError(res, 404, 'Notification was not found for this account.');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/banks', requireAuth, async (req, res, next) => {
  try { const banks = await db.collection('banks').find({ user_id: req.user._id }).sort({ created_at: -1 }).toArray(); res.json({ banks: banks.map(bankDto) }); }
  catch (error) { next(error); }
});
app.get('/api/banks/:id/payout-review', requireAuth, async (req, res, next) => {
  try {
    const bank = await db.collection('banks').findOne({ _id: req.params.id, user_id: req.user._id });
    if (!bank || !bank.account_cipher) return apiError(res, 404, 'Saved bank account was not found for this account.');
    let account;
    try { account = decryptAccount(bank.account_cipher); }
    catch (_) { return apiError(res, 500, 'Could not securely read this saved account number. Contact support.'); }
    res.set('Cache-Control', 'no-store, max-age=0').set('Pragma', 'no-cache');
    res.json({ bank: { id: bank._id, account } });
  } catch (error) { next(error); }
});
app.post('/api/banks', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const holder = String(req.body?.holder || '').trim().replace(/\s{2,}/g, ' ');
    const account = String(req.body?.account || '').trim();
    const ifsc = String(req.body?.ifsc || '').trim().toUpperCase();
    if (!validName(holder)) return apiError(res, 400, 'Account holder name must use capital letters and valid name punctuation only.');
    if (!/^\d{6,24}$/.test(account)) return apiError(res, 400, 'Account number must contain 6–24 digits only.');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return apiError(res, 400, 'Enter a valid 11-character IFSC code.');
    let bankInfo;
    // Integration-test fixture only: no production shortcut or user-supplied bank metadata.
    if (process.env.NODE_ENV === 'test' && ifsc === 'TEST0123456') {
      bankInfo = { bank: 'CKXchange Smoke Test Bank', branch: 'Smoke Test Branch' };
    } else {
      try {
        const response = await fetch(`https://ifsc.razorpay.com/${encodeURIComponent(ifsc)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
        if (!response.ok) return apiError(res, response.status === 404 ? 400 : 502, response.status === 404 ? 'IFSC code was not found.' : 'IFSC verification service is unavailable.');
        const data = await response.json(); bankInfo = { bank: String(data.BANK || '').trim(), branch: String(data.BRANCH || '').trim() };
      } catch (_) { return apiError(res, 502, 'Could not verify the IFSC with the bank directory. Try again.'); }
    }
    if (!bankInfo.bank || !bankInfo.branch) return apiError(res, 400, 'Bank directory returned incomplete details.');
    const bank = { _id: id('BNK'), user_id: req.user._id, holder, account_cipher: encryptAccount(account), account_fingerprint: fingerprint(req.user._id, account), account_last4: account.slice(-4), ifsc, bank_name: bankInfo.bank, branch_name: bankInfo.branch, created_at: now() };
    try {
      await runTransaction(async mongoSession => {
        // Re-check the active account inside the transaction without relying on a dummy write.
        // This safely permits active admins to use their own customer wallet and bank features too.
        const active = await db.collection('users').findOne({ _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active' }, { session: mongoSession, projection: { _id: 1 } });
        if (!active) throw new Error('ACCOUNT_NOT_ACTIVE');
        await db.collection('banks').insertOne(bank, { session: mongoSession });
      });
    } catch (error) {
      if (duplicateKeyError(error)) return apiError(res, 409, 'This bank account is already saved.');
      if (error.message === 'ACCOUNT_NOT_ACTIVE') return apiError(res, 409, 'Your account is not active. Please sign in again.');
      throw error;
    }
    res.status(201).json({ bank: bankDto(bank) });
  } catch (error) { next(error); }
});
app.delete('/api/banks/:id', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const result = await db.collection('banks').deleteOne({ _id: req.params.id, user_id: req.user._id });
    if (!result.deletedCount) return apiError(res, 404, 'Saved bank account was not found.');
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// TRC20-only settings. Address formatting is checked; blockchain ownership and confirmations are not.
app.get('/api/admin/settings/deposits', async (req, res, next) => { try { res.json(await depositSettingsDto()); } catch (error) { next(error); } });
app.put('/api/admin/settings/deposits', mutationLimiter, async (req, res, next) => {
  try {
    const value = String(req.body?.address ?? req.body?.addresses?.TRC20 ?? '').trim();
    const rateInput = Number(req.body?.rate);
    if (value.length > 120 || (value && !validDepositAddress('TRC20', value))) return apiError(res, 400, 'TRC20 receiving address must be a valid TRON address. No changes were saved.');
    if (!Number.isFinite(rateInput) || rateInput <= 0 || rateInput > 100000 || Math.abs(rateInput * 100 - Math.round(rateInput * 100)) > 1e-6) return apiError(res, 400, 'Enter a rate greater than 0 and no more than 100,000, with at most 2 decimal places.');
    const cleanRate = Math.round(rateInput * 100) / 100;
    const oldRate = await currentRate();
    await runTransaction(async mongoSession => {
      await writeSetting('deposit_address_TRC20', value, req.user._id, mongoSession);
      await writeSetting('inr_per_usdt', String(cleanRate), req.user._id, mongoSession);
      await audit(req.user._id, 'exchange_rate_and_trc20_address_updated', null, { previousRate: oldRate, newRate: cleanRate, trc20Configured: !!value }, mongoSession);
    });
    res.json({ ok: true, ...(await depositSettingsDto()), message: 'TRC20 receiving address and exchange rate saved.' });
  } catch (error) { next(error); }
});
app.get('/api/admin/settings/support', async (req, res, next) => {
  try { res.json({ telegramUsername: await currentTelegramSupportUsername() }); }
  catch (error) { next(error); }
});
app.put('/api/admin/settings/support', mutationLimiter, async (req, res, next) => {
  try {
    let username;
    try { username = normalizeTelegramUsername(req.body?.telegramUsername); }
    catch (error) { if (error.message === 'TELEGRAM_USERNAME_INVALID') return apiError(res, 400, 'Enter a valid Telegram username (5–32 letters, numbers, or underscores).'); throw error; }
    const previous = await currentTelegramSupportUsername();
    await runTransaction(async mongoSession => {
      await writeSetting('telegram_support_username', username, req.user._id, mongoSession);
      await audit(req.user._id, 'telegram_support_username_updated', null, { previousConfigured: !!previous, newConfigured: !!username }, mongoSession);
    });
    res.json({ ok: true, telegramUsername: username, message: username ? 'Telegram customer support saved.' : 'Telegram customer support link disabled.' });
  } catch (error) { next(error); }
});
app.get('/api/transactions', requireAuth, async (req, res, next) => {
  try { const rows = await db.collection('transactions').find({ user_id: req.user._id }).sort({ created_at: -1 }).limit(500).toArray(); res.json({ transactions: rows.map(row => transactionDto(row)) }); }
  catch (error) { next(error); }
});
app.get('/api/payouts/:id/receipt', requireAuth, async (req, res, next) => {
  try {
    // Full bank account details are returned only after checking the payout belongs to this session user.
    const txn = await db.collection('transactions').findOne({ _id: req.params.id, user_id: req.user._id, type: 'payout' });
    if (!txn) return apiError(res, 404, 'Payout receipt was not found for this account.');
    res.set('Cache-Control', 'no-store');
    res.json({ transaction: transactionDto(txn, true) });
  } catch (error) { next(error); }
});
app.post('/api/deposits', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const amount = Number(req.body?.amountUsdt);
    const network = String(req.body?.network || '').toUpperCase();
    let txHash = String(req.body?.txHash || '').trim();
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_USDT || amount > 10_000_000) return apiError(res, 400, 'Minimum USDT deposit is 10 USDT. Enter an amount from 10 USDT up to the transaction limit.');
    if (network !== 'TRC20') return apiError(res, 400, 'Only USDT on TRON (TRC20) is supported.');
    if (!validTransactionHash(network, txHash)) return apiError(res, 400, 'Enter a valid 64-character hexadecimal TRC20 transaction hash.');
    const depositAddress = await effectiveDepositAddress(network);
    if (!depositAddress.valid) return apiError(res, 503, `USDT deposits on ${network} are disabled because the receiving address is missing or invalid. Ask the administrator to configure and verify it first.`);
    txHash = txHash.toLowerCase();
    const prior = await db.collection('transactions').findOne({ network, tx_hash: txHash }, { projection: { _id: 1 } });
    if (prior) return apiError(res, 409, 'This transaction hash has already been submitted for this network.');
    const usdtMicro = toUsdtMicro(amount);
    if (!Number.isSafeInteger(usdtMicro) || usdtMicro <= 0) return apiError(res, 400, 'Deposit amount is outside the supported range.');
    const txId = id('DEP'); const created = now(); const amountPaise = toPaise(fromUsdtMicro(usdtMicro) * await currentRate());
    if (!Number.isSafeInteger(amountPaise) || amountPaise < 0) return apiError(res, 400, 'Deposit amount is outside the supported currency range.');
    const transaction = { _id: txId, user_id: req.user._id, type: 'deposit', status: 'pending', amount_paise: amountPaise, usdt_micro: usdtMicro,
      network, tx_hash: txHash, deposit_address: depositAddress.address, created_at: created, updated_at: created };
    try {
      const notificationIds = await runTransaction(async mongoSession => {
        // Re-check the active account inside the transaction without relying on a dummy write.
        // This safely permits active admins to use their own customer wallet and bank features too.
        const active = await db.collection('users').findOne({ _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active' }, { session: mongoSession, projection: { _id: 1 } });
        if (!active) throw new Error('ACCOUNT_NOT_ACTIVE');
        await db.collection('transactions').insertOne(transaction, { session: mongoSession });
        return queueDepositAdminNotifications(mongoSession, transaction);
      });
      await deliverPushOutbox(notificationIds).catch(error => console.error('[push-outbox]', error?.message || error));
    } catch (error) {
      if (duplicateKeyError(error)) return apiError(res, 409, 'This transaction hash has already been submitted for this network.');
      if (error.message === 'ACCOUNT_NOT_ACTIVE') return apiError(res, 409, 'Your account is not active. Please sign in again.');
      throw error;
    }
    res.status(201).json({ transaction: transactionDto(transaction), message: 'Deposit submitted. It will remain pending until an administrator verifies it.' });
  } catch (error) { next(error); }
});
app.post('/api/payouts', requireAuth, mutationLimiter, async (req, res, next) => {
  try {
    const amount = Number(req.body?.amountInr);
    const bankId = String(req.body?.bankId || '');
    if (!Number.isFinite(amount) || amount < MIN_PAYOUT_INR || amount > MAX_PAYOUT_INR) return apiError(res, 400, 'Minimum INR withdrawal is ₹1,000 and maximum is ₹100,000 per payout request.');
    const bank = await db.collection('banks').findOne({ _id: bankId, user_id: req.user._id });
    if (!bank) return apiError(res, 400, 'Choose a saved bank account.');
    const amountPaise = toPaise(amount);
    const currentExchangeRate = await currentRate();
    const usdtMicro = Math.ceil((amountPaise / 100 / currentExchangeRate) * 1_000_000 - 1e-9);
    if (!Number.isSafeInteger(usdtMicro) || usdtMicro <= 0) return apiError(res, 400, 'Payout amount is outside the supported range.');
    const txId = id('PAY'); const created = now();
    const transaction = await runTransaction(async mongoSession => {
      const users = db.collection('users');
      const user = await users.findOne({ _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active' }, { session: mongoSession, projection: { available_usdt_micro: 1 } });
      if (!user) throw new Error('ACCOUNT_NOT_ACTIVE');
      if (user.available_usdt_micro < usdtMicro) throw new Error('INSUFFICIENT_BALANCE');
      const changed = await users.updateOne({ _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active', available_usdt_micro: { $gte: usdtMicro } }, { $inc: { available_usdt_micro: -usdtMicro, reserved_usdt_micro: usdtMicro } }, { session: mongoSession });
      if (changed.modifiedCount !== 1) throw new Error('INSUFFICIENT_BALANCE');
      const txn = { _id: txId, user_id: req.user._id, type: 'payout', status: 'pending', amount_paise: amountPaise, usdt_micro: usdtMicro,
        bank_id: bank._id, bank_holder: bank.holder, bank_cipher: bank.account_cipher, bank_last4: bank.account_last4, bank_name: bank.bank_name,
        branch_name: bank.branch_name, ifsc: bank.ifsc, created_at: created, updated_at: created };
      await db.collection('transactions').insertOne(txn, { session: mongoSession });
      await db.collection('ledger').insertOne({ _id: `${txId}:payout_reserve`, user_id: req.user._id, transaction_id: txId, entry_type: 'payout_reserve', available_delta_micro: -usdtMicro, reserved_delta_micro: usdtMicro, created_at: created }, { session: mongoSession });
      // Record the customer request in the same transaction. Destination details are joined securely
      // from the protected transaction record at audit-read time rather than duplicated in the log.
      await auditUser(req.user._id, 'payout_requested', txId, {
        payoutAmountInr: fromPaise(amountPaise),
        usdtReserved: fromUsdtMicro(usdtMicro)
      }, mongoSession);
      return txn;
    });
    res.status(201).json({ transaction: transactionDto(transaction), message: 'Payout request created and funds reserved. Status: Pending.' });
  } catch (error) { if (error.message === 'INSUFFICIENT_BALANCE') return apiError(res, 409, 'Insufficient available USDT balance. The request was not created.'); if (error.message === 'ACCOUNT_NOT_ACTIVE') return apiError(res, 409, 'Your account is not active. Please sign in again.'); next(error); }
});

// Admin APIs are centrally protected. Aggregations and state transitions execute against MongoDB.
app.get('/api/admin/overview', async (req, res, next) => {
  try {
    const [users, pendingDeposits, pendingPayouts, payouts, balances] = await Promise.all([
      db.collection('users').countDocuments({ role: 'user' }),
      db.collection('transactions').countDocuments({ type: 'deposit', status: 'pending' }),
      db.collection('transactions').countDocuments({ type: 'payout', status: { $in: ['pending', 'processing'] } }),
      db.collection('transactions').aggregate([{ $match: { type: 'payout', status: 'success' } }, { $group: { _id: null, n: { $sum: '$amount_paise' } } }]).toArray(),
      db.collection('users').aggregate([{ $match: { role: 'user' } }, { $group: { _id: null, n: { $sum: '$available_usdt_micro' } } }]).toArray()
    ]);
    res.json({ users, pendingDeposits, pendingPayouts, successfulPayoutInr: fromPaise(payouts[0]?.n || 0), totalAvailableUsdt: fromUsdtMicro(balances[0]?.n || 0) });
  } catch (error) { next(error); }
});
app.get('/api/admin/transactions', async (req, res, next) => {
  try {
    const type = String(req.query.type || '');
    let filter;
    if (type === 'deposit') filter = { type: 'deposit', status: 'pending' };
    else if (type === 'payout') filter = { type: 'payout', status: { $in: ['pending', 'processing'] } };
    else return apiError(res, 400, 'Transaction type must be deposit or payout.');
    const { page: requestedPage, pageSize, q } = parseListParams(req);
    if (q) {
      const regex = new RegExp(escapedRegExp(q), 'i');
      const userIds = await matchingUserIds(q);
      const searchConditions = [{ _id: regex }, { tx_hash: regex }, { user_id: regex }, ...(userIds.length ? [{ user_id: { $in: userIds } }] : [])];
      if (type === 'payout') {
        // Account numbers are encrypted at rest, so filter by last four digits first,
        // then decrypt only the protected admin-side candidates to support exact full-number search.
        searchConditions.push({ bank_last4: regex });
        if (/^\d{4,24}$/.test(q)) {
          const last4 = q.slice(-4);
          const accountCandidates = await db.collection('transactions').find(
            { type: 'payout', status: { $in: ['pending', 'processing'] }, bank_last4: last4 },
            { projection: { _id: 1, bank_cipher: 1, bank_last4: 1 } }
          ).toArray();
          const accountMatchIds = accountCandidates.filter(row => {
            if (q.length === 4) return row.bank_last4 === q;
            if (!row.bank_cipher) return false;
            try { return decryptAccount(row.bank_cipher) === q; } catch (_) { return false; }
          }).map(row => row._id);
          if (accountMatchIds.length) searchConditions.push({ _id: { $in: accountMatchIds } });
        }
      }
      filter = { $and: [filter, { $or: searchConditions }] };
    }
    const total = await db.collection('transactions').countDocuments(filter);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const sort = type === 'payout' ? { status: 1, created_at: 1 } : { created_at: 1 };
    const rows = await db.collection('transactions').find(filter).sort(sort).skip((page - 1) * pageSize).limit(pageSize).toArray();
    const userIds = [...new Set(rows.map(row => row.user_id))];
    const users = userIds.length ? await db.collection('users').find({ _id: { $in: userIds } }, { projection: { name: 1, email: 1 } }).toArray() : [];
    const userMap = new Map(users.map(user => [user._id, user]));
    res.json({
      transactions: rows.map(row => ({ ...transactionDto(row, true), userName: userMap.get(row.user_id)?.name || (row.user_deleted ? 'Deleted account' : 'Unknown user'), userEmail: userMap.get(row.user_id)?.email || '' })),
      pagination: paginationDto(page, pageSize, total)
    });
  } catch (error) { next(error); }
});
app.get('/api/admin/payouts/:id/receipt', async (req, res, next) => {
  try {
    const txn = await db.collection('transactions').findOne({ _id: req.params.id, type: 'payout' });
    if (!txn) return apiError(res, 404, 'Payout receipt was not found.');
    // This endpoint is protected by the /api/admin requireAuth + requireAdmin middleware.
    // A no-store response prevents decrypted bank details from being retained by browser caches.
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.json({ transaction: transactionDto(txn, true) });
  } catch (error) { next(error); }
});
app.get('/api/admin/users', async (req, res, next) => {
  try {
    const { page: requestedPage, pageSize, q } = parseListParams(req);
    const filter = q ? { $or: [{ _id: new RegExp(escapedRegExp(q), 'i') }, { name: new RegExp(escapedRegExp(q), 'i') }, { email: new RegExp(escapedRegExp(q), 'i') }] } : {};
    const total = await db.collection('users').countDocuments(filter);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const rows = await db.collection('users').find(filter, { projection: { name: 1, email: 1, role: 1, status: 1, telegram_id: 1, phone_number: 1, available_usdt_micro: 1, reserved_usdt_micro: 1, created_at: 1 } }).sort({ created_at: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
    res.json({ users: rows.map(auditSafeUser), pagination: paginationDto(page, pageSize, total) });
  } catch (error) { next(error); }
});
app.get('/api/admin/audit', async (req, res, next) => {
  try {
    const { page: requestedPage, pageSize, q } = parseListParams(req);
    let filter = {};
    if (q) {
      const regex = new RegExp(escapedRegExp(q), 'i');
      const userIds = await matchingUserIds(q);
      const payoutSearch = [{ _id: regex }, { bank_holder: regex }, { bank_name: regex }, { branch_name: regex }, { bank_last4: regex }, { ifsc: regex }, { user_id: regex }];
      if (userIds.length) payoutSearch.push({ user_id: { $in: userIds } });
      const matchingPayouts = await db.collection('transactions').find(
        { type: 'payout', $or: payoutSearch }, { projection: { _id: 1 } }
      ).limit(500).toArray();
      const matchingPayoutIds = matchingPayouts.map(row => row._id);
      filter = { $or: [
        { action: regex }, { target_id: regex }, { admin_id: regex }, { actor_id: regex },
        ...(userIds.length ? [{ admin_id: { $in: userIds } }, { actor_id: { $in: userIds } }] : []),
        ...(matchingPayoutIds.length ? [{ target_id: { $in: matchingPayoutIds } }] : [])
      ] };
    }
    const total = await db.collection('audit_log').countDocuments(filter);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const rows = await db.collection('audit_log').find(filter).sort({ created_at: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
    const targetIds = [...new Set(rows.map(row => row.target_id).filter(Boolean))];
    const payoutRows = targetIds.length ? await db.collection('transactions').find(
      { _id: { $in: targetIds }, type: 'payout' }
    ).toArray() : [];
    const payoutMap = new Map(payoutRows.map(txn => [txn._id, txn]));
    const identities = [...new Set([
      ...rows.map(row => row.actor_id || row.admin_id).filter(Boolean),
      ...payoutRows.map(txn => txn.user_id).filter(Boolean)
    ])];
    const people = identities.length ? await db.collection('users').find(
      { _id: { $in: identities } }, { projection: { name: 1, email: 1, role: 1 } }
    ).toArray() : [];
    const peopleMap = new Map(people.map(user => [user._id, user]));
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    res.json({ entries: rows.map(row => {
      const actorId = row.actor_id || row.admin_id;
      const actor = peopleMap.get(actorId);
      const actorRole = row.actor_role || (row.admin_id ? 'admin' : 'user');
      const payout = payoutMap.get(row.target_id);
      const payoutOwner = payout ? peopleMap.get(payout.user_id) : null;
      let details = row.details && typeof row.details === 'object' && !Array.isArray(row.details) ? { ...row.details } : {};
      if (payout) {
        // The audit database stores no decrypted account number. This protected, no-store admin
        // response joins the full number from the encrypted payout record for the requested UI view.
        details = {
          ...details,
          payoutAmountInr: fromPaise(payout.amount_paise),
          accountHolder: payout.bank_holder || (payout.user_deleted ? 'Bank details removed' : ''),
          accountNumber: payout.bank_cipher ? transactionDto(payout, true).account : (payout.bank_last4 ? accountMasked(payout.bank_last4) : (payout.user_deleted ? 'Bank details removed' : '—'))
        };
      }
      return {
        id: row._id, action: row.action, targetId: row.target_id, payoutLinked: Boolean(payout), details, createdAt: row.created_at,
        actorRole, actorName: actor?.name || (actorRole === 'user' ? 'Deleted account' : 'Unknown admin'),
        actorEmail: actor?.email || '',
        adminName: peopleMap.get(row.admin_id)?.name || (row.actor_role === 'user' ? 'Deleted user' : 'Unknown admin'),
        adminEmail: peopleMap.get(row.admin_id)?.email || ''
      };
    }), pagination: paginationDto(page, pageSize, total) });
  } catch (error) { next(error); }
});

app.post('/api/admin/deposits/:id/approve', mutationLimiter, async (req, res, next) => {
  try {
    const result = await runTransaction(async mongoSession => {
      const transactions = db.collection('transactions');
      const txn = await transactions.findOne({ _id: req.params.id, type: 'deposit' }, { session: mongoSession });
      if (!txn) throw new Error('NOT_FOUND');
      if (txn.status !== 'pending') throw new Error('NOT_PENDING');
      const updatedAt = now();
      const changed = await transactions.updateOne({ _id: txn._id, type: 'deposit', status: 'pending' }, { $set: { status: 'success', updated_at: updatedAt } }, { session: mongoSession });
      if (changed.modifiedCount !== 1) throw new Error('NOT_PENDING');
      const credit = await db.collection('users').updateOne({ _id: txn.user_id, status: 'active' }, { $inc: { available_usdt_micro: txn.usdt_micro } }, { session: mongoSession });
      if (credit.matchedCount !== 1) throw new Error('USER_NOT_FOUND');
      await db.collection('ledger').insertOne({ _id: `${txn._id}:deposit_credit`, user_id: txn.user_id, transaction_id: txn._id, entry_type: 'deposit_credit', available_delta_micro: txn.usdt_micro, reserved_delta_micro: 0, created_at: updatedAt }, { session: mongoSession });
      await audit(req.user._id, 'deposit_approved_manual_verification', txn._id, { network: txn.network, txHash: txn.tx_hash, amountUsdt: fromUsdtMicro(txn.usdt_micro) }, mongoSession);
      const transaction = { ...txn, status: 'success', updated_at: updatedAt };
      const notificationIds = await queueDepositApprovedNotification(mongoSession, transaction);
      return { transaction, notificationIds };
    });
    await deliverPushOutbox(result.notificationIds).catch(error => console.error('[push-outbox]', error?.message || error));
    res.json({ transaction: transactionDto(result.transaction) });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return apiError(res, 404, 'Deposit request not found.');
    if (error.message === 'NOT_PENDING') return apiError(res, 409, 'Deposit has already been reviewed.');
    if (error.message === 'USER_NOT_FOUND') return apiError(res, 409, 'The deposit owner is no longer active; no credit was applied.');
    next(error);
  }
});
app.post('/api/admin/deposits/:id/reject', mutationLimiter, async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (reason.length < 3) return apiError(res, 400, 'Enter a rejection reason (at least 3 characters).');
    await runTransaction(async mongoSession => {
      const result = await db.collection('transactions').updateOne({ _id: req.params.id, type: 'deposit', status: 'pending' }, { $set: { status: 'rejected', rejection_reason: reason, updated_at: now() } }, { session: mongoSession });
      if (result.modifiedCount !== 1) throw new Error('NOT_PENDING');
      await audit(req.user._id, 'deposit_rejected', req.params.id, { reason }, mongoSession);
    });
    res.json({ ok: true });
  } catch (error) { if (error.message === 'NOT_PENDING') return apiError(res, 409, 'Pending deposit was not found or has already been reviewed.'); next(error); }
});
app.post('/api/admin/payouts/:id/approve', mutationLimiter, async (req, res, next) => {
  try {
    await runTransaction(async mongoSession => {
      const result = await db.collection('transactions').updateOne({ _id: req.params.id, type: 'payout', status: 'pending' }, { $set: { status: 'processing', updated_at: now() } }, { session: mongoSession });
      if (result.modifiedCount !== 1) throw new Error('NOT_PENDING');
      await audit(req.user._id, 'payout_approved_processing', req.params.id, {}, mongoSession);
    });
    res.json({ ok: true, message: 'Payout moved to Processing. Complete the transfer through your authorized bank/provider before marking successful.' });
  } catch (error) { if (error.message === 'NOT_PENDING') return apiError(res, 409, 'Pending payout was not found or has already been reviewed.'); next(error); }
});
app.post('/api/admin/payouts/:id/complete', mutationLimiter, async (req, res, next) => {
  try {
    const reference = String(req.body?.bankReference || '').trim();
    if (reference.length < 3 || reference.length > 120) return apiError(res, 400, 'Enter the bank/provider reference for the completed transfer.');
    let notificationIds = [];
    const transaction = await runTransaction(async mongoSession => {
      const txn = await db.collection('transactions').findOne({ _id: req.params.id, type: 'payout' }, { session: mongoSession });
      if (!txn) throw new Error('NOT_FOUND');
      if (txn.status !== 'processing') throw new Error('NOT_PROCESSING');
      const result = await db.collection('transactions').updateOne({ _id: txn._id, status: 'processing' }, { $set: { status: 'success', bank_reference: reference, updated_at: now() } }, { session: mongoSession });
      if (result.modifiedCount !== 1) throw new Error('NOT_PROCESSING');
      const release = await db.collection('users').updateOne({ _id: txn.user_id, reserved_usdt_micro: { $gte: txn.usdt_micro } }, { $inc: { reserved_usdt_micro: -txn.usdt_micro } }, { session: mongoSession });
      if (release.modifiedCount !== 1) throw new Error('RESERVE_MISMATCH');
      await db.collection('ledger').insertOne({ _id: `${txn._id}:payout_paid`, user_id: txn.user_id, transaction_id: txn._id, entry_type: 'payout_paid', available_delta_micro: 0, reserved_delta_micro: -txn.usdt_micro, created_at: now() }, { session: mongoSession });
      await audit(req.user._id, 'payout_marked_success_after_reference', txn._id, { bankReference: reference }, mongoSession);
      notificationIds = await queuePayoutSuccessNotification(mongoSession, { ...txn, status: 'success' });
      return { ...txn, status: 'success', bank_reference: reference, updated_at: now() };
    });
    await deliverPushOutbox(notificationIds).catch(error => console.error('[push-outbox]', error?.message || error));
    res.json({ transaction: transactionDto(transaction) });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return apiError(res, 404, 'Payout request not found.');
    if (error.message === 'NOT_PROCESSING') return apiError(res, 409, 'Payout must be in Processing state before completion.');
    if (error.message === 'RESERVE_MISMATCH') return apiError(res, 409, 'Reserved balance mismatch; transaction was rolled back.');
    next(error);
  }
});
async function releasePayout(req, res, desiredStatus) {
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (reason.length < 3) return apiError(res, 400, 'Enter a reason (at least 3 characters).');
  const action = desiredStatus === 'rejected' ? 'payout_rejected_and_reserve_released' : 'payout_failed_and_reserve_released';
  try {
    await runTransaction(async mongoSession => {
      const txn = await db.collection('transactions').findOne({ _id: req.params.id, type: 'payout' }, { session: mongoSession });
      if (!txn) throw new Error('NOT_FOUND');
      if (!['pending', 'processing'].includes(txn.status)) throw new Error('NOT_ACTIONABLE');
      const release = await db.collection('users').updateOne({ _id: txn.user_id, reserved_usdt_micro: { $gte: txn.usdt_micro } }, { $inc: { available_usdt_micro: txn.usdt_micro, reserved_usdt_micro: -txn.usdt_micro } }, { session: mongoSession });
      if (release.modifiedCount !== 1) throw new Error('RESERVE_MISMATCH');
      const changed = await db.collection('transactions').updateOne({ _id: txn._id, status: { $in: ['pending', 'processing'] } }, { $set: { status: desiredStatus, rejection_reason: reason, updated_at: now() } }, { session: mongoSession });
      if (changed.modifiedCount !== 1) throw new Error('NOT_ACTIONABLE');
      await db.collection('ledger').insertOne({ _id: `${txn._id}:payout_release`, user_id: txn.user_id, transaction_id: txn._id, entry_type: 'payout_release', available_delta_micro: txn.usdt_micro, reserved_delta_micro: -txn.usdt_micro, created_at: now() }, { session: mongoSession });
      await audit(req.user._id, action, txn._id, { reason }, mongoSession);
    });
    res.json({ ok: true, message: `Payout marked ${desiredStatus}; reserved balance was released.` });
  } catch (error) {
    if (error.message === 'NOT_FOUND') return apiError(res, 404, 'Payout request not found.');
    if (error.message === 'NOT_ACTIONABLE') return apiError(res, 409, 'Payout is no longer pending or processing.');
    if (error.message === 'RESERVE_MISMATCH') return apiError(res, 409, 'Reserved balance mismatch; transaction was rolled back.');
    throw error;
  }
}
app.post('/api/admin/payouts/:id/reject', mutationLimiter, (req, res, next) => releasePayout(req, res, 'rejected').catch(next));
app.post('/api/admin/payouts/:id/fail', mutationLimiter, (req, res, next) => releasePayout(req, res, 'failed').catch(next));

const INDEX_HTML_PATH = path.join(appRoot, 'views', 'index.html');
async function activeAdminForRequest(req) {
  const userId = req.session?.userId;
  if (!userId) return false;
  const user = await db.collection('users').findOne({ _id: userId }, { projection: { role: 1, status: 1 } });
  return !!user && user.status === 'active' && user.role === 'admin';
}
async function sendAppShell(req, res, forceAdmin = false) {
  const isAdmin = await activeAdminForRequest(req);
  if (forceAdmin && !isAdmin) return res.redirect(302, '/?next=admin');
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  if (!isAdmin) html = html.replace(/<!-- CKX_ADMIN_UI_START -->[\s\S]*?<!-- CKX_ADMIN_UI_END -->/g, '');
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  return res.status(200).type('html').send(html);
}
app.use(/^\/admin(?:\/|$)/i, (req, res, next) => sendAppShell(req, res, true).catch(next));
app.get(['/', '/index.html'], (req, res, next) => sendAppShell(req, res).catch(next));
app.use(express.static(path.join(appRoot, 'public'), { etag: true, maxAge: IS_PROD ? '1h' : 0, index: false }));
app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => sendAppShell(req, res).catch(next));
app.use('/api', (req, res) => apiError(res, 404, 'API endpoint not found.'));
app.use((error, req, res, next) => {
  console.error('[server-error]', error?.stack || error);
  if (res.headersSent) return next(error);
  const msg = IS_PROD ? 'An unexpected server error occurred.' : (error.message || 'Unexpected server error.');
  res.status(500).json({ error: msg });
});

async function start() {
  await mongoReadyPromise;
  const server = app.listen(PORT, () => console.log(`CKXchange ${IS_PROD ? 'production' : 'test'} server listening on port ${PORT}; MongoDB database: ${DB_NAME}`));
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async () => {
      try { await mongoClient.close(); process.exit(0); }
      catch (error) { console.error('MongoDB shutdown error:', error.message); process.exit(1); }
    });
    setTimeout(() => process.exit(1), 8000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Vercel imports this module as a request handler; local development runs it
// as a normal long-lived Express server. Keep both paths explicit.
if (require.main === module && !process.env.VERCEL) {
  start().catch(error => {
    console.error('CKXchange failed to start:', error.message);
    process.exitCode = 1;
    mongoClient.close().catch(() => {});
  });
}

module.exports = app;
