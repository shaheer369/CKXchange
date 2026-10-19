'use strict';

// Full HTTP integration test against an explicitly provided, disposable MongoDB database.
// Uses a unique test DB and drops only that database at the end. Transactions require a replica set (MongoDB Atlas works).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { MongoClient } = require('mongodb');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');
const node = process.execPath;
const testUri = String(process.env.MONGODB_TEST_URI || '').trim();
if (!testUri) {
  console.error('Set MONGODB_TEST_URI to a disposable MongoDB Atlas/replica-set connection string before running npm run test:integration. The integration test creates and drops a uniquely named database.');
  process.exit(2);
}
const dbName = `ckxchange_test_${process.pid}_${Date.now()}`;
const testPassword = 'SmokeTestAdminPassword2026!';
let child;
let serverOutput = '';
let mongoClient;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
function setCookie(response, existing = '') {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  return cookies.map(cookie => cookie.split(';')[0]).find(cookie => cookie.startsWith('ckx.sid=')) || existing;
}
async function api(origin, route, { method = 'GET', cookie = '', csrf = '', body, redirect = 'manual' } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.Origin = origin;
  const response = await fetch(`${origin}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* HTML routes are expected to return HTML. */ }
  return { response, data, cookie: setCookie(response, cookie), text };
}
async function login(origin, email, password) {
  const csrf = await api(origin, '/api/auth/csrf');
  const result = await api(origin, '/api/auth/login', { method: 'POST', cookie: csrf.cookie, csrf: csrf.data.csrfToken, body: { email, password } });
  assert.equal(result.response.status, 200, `login failed: ${JSON.stringify(result.data)}`);
  return { cookie: result.cookie, csrf: result.data.csrfToken, user: result.data.user };
}
async function waitForStart(proc, origin) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${serverOutput}`);
    try { const response = await fetch(`${origin}/api/health`, { cache: 'no-store' }); if (response.ok) return; }
    catch { /* server is not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start in time:\n${serverOutput}`);
}

(async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: origin,
    SESSION_SECRET: 'smoke-test-session-secret-0123456789-abcdef',
    BANK_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    DEPOSIT_ADDRESS_TRC20: '', MONGODB_URI: testUri, MONGODB_DB: dbName
  };
  child = spawn(node, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { serverOutput += chunk; });
  child.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitForStart(child, origin);

  const anonymousAdmin = await api(origin, '/api/admin/overview');
  assert.equal(anonymousAdmin.response.status, 401, 'anonymous admin API must return 401');
  const anonymousPage = await api(origin, '/admin');
  assert.equal(anonymousPage.response.status, 302, 'anonymous /admin must redirect');
  const anonymousRoot = await api(origin, '/');
  assert.doesNotMatch(anonymousRoot.text, /id="page-admin"|id="depositSettingsForm"/, 'anonymous HTML must omit admin controls');
  const health = await api(origin, '/api/health');
  assert.equal(health.data.database, 'mongodb', 'server must report MongoDB as its database');
  const unconfigured = await api(origin, '/api/config?network=TRC20');
  assert.equal(unconfigured.data.depositConfigured, false, 'deposits are disabled until a receiving address is configured');
  const manifest = await api(origin, '/manifest.webmanifest');
  assert.equal(manifest.response.status, 200, 'PWA manifest should be served');
  assert.match(manifest.text, /\"display\": \"standalone\"/, 'PWA should use an installable standalone display mode');
  const serviceWorker = await api(origin, '/service-worker.js');
  assert.equal(serviceWorker.response.status, 200, 'PWA service worker should be served');
  assert.match(serviceWorker.text, /url\.pathname\.startsWith\('\/api\/'\)/, 'service worker must never cache API responses');
  const pushKey = await api(origin, '/api/notifications/push-public-key');
  assert.equal(pushKey.response.status, 200);
  assert.equal(pushKey.data.configured, false, 'browser push should remain disabled without VAPID environment variables');

  let csrf = await api(origin, '/api/auth/csrf');
  const registration = await api(origin, '/api/auth/register', {
    method: 'POST', cookie: csrf.cookie, csrf: csrf.data.csrfToken,
    body: { name: 'TEST CUSTOMER', email: 'smoke-user@example.com', password: 'SmokeCustomer12345', role: 'admin' }
  });
  assert.equal(registration.response.status, 201, `registration failed: ${JSON.stringify(registration.data)}`);
  assert.equal(registration.data.user.role, 'user', 'registration must not allow self-assigned admin role');
  let customer = await login(origin, 'smoke-user@example.com', 'SmokeCustomer12345');
  assert.equal((await api(origin, '/api/admin/overview', customer)).response.status, 403, 'ordinary users must not access admin APIs');
  const initialPreferences = await api(origin, '/api/notifications/preferences', { cookie: customer.cookie });
  assert.equal(initialPreferences.response.status, 200, 'authenticated customers should read notification preferences');
  assert.equal(initialPreferences.data.inAppEnabled, true, 'in-app notifications should default to enabled');
  assert.equal(initialPreferences.data.pushConfigured, false, 'push should report unconfigured in integration tests without VAPID keys');

  const adminCreate = spawnSync(node, ['scripts/create-admin.js', '--email', 'smoke-admin@example.com', '--name', 'SMOKE ADMIN'], {
    cwd: root, env: { ...env, ADMIN_PASSWORD: testPassword }, encoding: 'utf8'
  });
  assert.equal(adminCreate.status, 0, `admin bootstrap failed: ${adminCreate.stderr || adminCreate.stdout}`);
  let admin = await login(origin, 'smoke-admin@example.com', testPassword);
  mongoClient = new MongoClient(testUri);
  await mongoClient.connect();
  const testDb = mongoClient.db(dbName);
  const adminPage = await api(origin, '/admin', { cookie: admin.cookie });
  assert.equal(adminPage.response.status, 200, 'admin session should access /admin');
  assert.match(adminPage.text, /id="page-admin"/, 'admin shell should contain admin UI');
  assert.equal((await api(origin, '/admin/deposits', { cookie: admin.cookie })).response.status, 200, 'admin subpages should work when opened directly');
  assert.equal((await api(origin, '/admin/deposits', { cookie: customer.cookie })).response.status, 302, 'ordinary users must not open admin subpages directly');
  const pagedUsers = await api(origin, '/api/admin/users?page=1&pageSize=999', { cookie: admin.cookie });
  assert.equal(pagedUsers.response.status, 200);
  assert.equal(pagedUsers.data.pagination.pageSize, 100, 'server must clamp excessive page sizes');
  assert.ok(Array.isArray(pagedUsers.data.users), 'users endpoint should return a paginated array');
  const pagedDeposits = await api(origin, '/api/admin/transactions?type=deposit&page=1&pageSize=999', { cookie: admin.cookie });
  assert.equal(pagedDeposits.response.status, 200);
  assert.equal(pagedDeposits.data.pagination.pageSize, 100, 'transaction queue must clamp excessive page sizes');
  const pagedAudit = await api(origin, '/api/admin/audit?page=1&pageSize=999', { cookie: admin.cookie });
  assert.equal(pagedAudit.response.status, 200);
  assert.equal(pagedAudit.data.pagination.pageSize, 100, 'audit queue must clamp excessive page sizes');
  const ordinarySupportEdit = await api(origin, '/api/admin/settings/support', { method: 'PUT', cookie: customer.cookie, csrf: customer.csrf, body: { telegramUsername: 'CKXchangeSupport' } });
  assert.equal(ordinarySupportEdit.response.status, 403, 'ordinary users must not update admin support settings');
  const badSupport = await api(origin, '/api/admin/settings/support', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { telegramUsername: 'https://t.me/evil' } });
  assert.equal(badSupport.response.status, 400, 'Telegram support must reject URLs instead of usernames');
  const goodSupport = await api(origin, '/api/admin/settings/support', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { telegramUsername: '@CKXchangeSupport' } });
  assert.equal(goodSupport.response.status, 200, `valid Telegram support setting failed: ${JSON.stringify(goodSupport.data)}`);
  assert.equal(goodSupport.data.telegramUsername, 'CKXchangeSupport', 'Telegram username should be normalized');
  const publicSupport = await api(origin, '/api/support');
  assert.deepEqual(publicSupport.data, { telegramUsername: 'CKXchangeSupport' }, 'public support API must expose only the public Telegram username');

  const badSettings = await api(origin, '/api/admin/settings/deposits', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { address: 'not-an-address', rate: 106 } });
  assert.equal(badSettings.response.status, 400, 'invalid TRC20 address must be rejected');
  const trc20Address = `T${'1'.repeat(33)}`;
  const settings = await api(origin, '/api/admin/settings/deposits', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { address: trc20Address, rate: 110 } });
  assert.equal(settings.response.status, 200, `admin settings save failed: ${JSON.stringify(settings.data)}`);
  assert.equal(settings.data.rate, 110, 'admin-managed rate should save in MongoDB');
  assert.equal((await api(origin, '/api/config?network=ERC20')).response.status, 400, 'non-TRC20 network should be rejected');
  assert.equal((await api(origin, '/api/deposits', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { amountUsdt: 5, network: 'ERC20', txHash: 'c'.repeat(64) } })).response.status, 400, 'API must reject unsupported deposit network');
  assert.equal((await api(origin, '/api/admin/settings/deposits', { method: 'PUT', cookie: admin.cookie, csrf: admin.csrf, body: { address: trc20Address, rate: -1 } })).response.status, 400, 'invalid rate must be rejected');

  const deposit = await api(origin, '/api/deposits', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { amountUsdt: 5, network: 'TRC20', txHash: 'a'.repeat(64) } });
  assert.equal(deposit.response.status, 201, `deposit creation failed: ${JSON.stringify(deposit.data)}`);
  assert.equal(deposit.data.transaction.status, 'pending');
  assert.equal(deposit.data.transaction.depositAddress, trc20Address);
  assert.equal(deposit.data.transaction.amount, 550, 'deposit valuation must use admin rate');
  const adminDepositNotes = await api(origin, '/api/notifications', { cookie: admin.cookie });
  assert.equal(adminDepositNotes.response.status, 200);
  const depositNote = adminDepositNotes.data.notifications.find(row => row.kind === 'deposit_request' && row.body.includes('deposit request'));
  assert.ok(depositNote, 'a USDT deposit request should notify the active admin');
  await testDb.collection('users').updateOne({ _id: admin.user.id }, { $set: { role: 'user' } });
  const demotedAdminNotes = await api(origin, '/api/notifications', { cookie: admin.cookie });
  assert.equal(demotedAdminNotes.data.notifications.some(row => row.kind === 'deposit_request'), false, 'a demoted administrator must not retain admin-only notification access');
  await testDb.collection('users').updateOne({ _id: admin.user.id, role: 'user' }, { $set: { role: 'admin' } });
  const customerDepositNotes = await api(origin, '/api/notifications', { cookie: customer.cookie });
  assert.equal(customerDepositNotes.data.notifications.some(row => row.kind === 'deposit_request'), false, 'deposit request notification must not be disclosed to the customer');
  assert.equal((await api(origin, `/api/notifications/${encodeURIComponent(depositNote.id)}/read`, { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: {} })).response.status, 404, 'customers must not mark an admin notification as read');
  const disableInApp = await api(origin, '/api/notifications/preferences', { method: 'PUT', cookie: customer.cookie, csrf: customer.csrf, body: { inAppEnabled: false } });
  assert.equal(disableInApp.response.status, 200, 'customer should be able to disable in-app notification history');
  const hiddenNotifications = await api(origin, '/api/notifications', { cookie: customer.cookie });
  assert.deepEqual(hiddenNotifications.data.notifications, [], 'disabled in-app notification history should not be returned');
  assert.equal((await api(origin, '/api/notifications/preferences', { method: 'PUT', cookie: customer.cookie, csrf: customer.csrf, body: { inAppEnabled: true } })).response.status, 200, 'customer should be able to re-enable in-app notification history');
  assert.equal((await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: {} })).response.status, 403, 'normal users cannot approve deposits');
  const approval = await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(approval.response.status, 200, `deposit approval failed: ${JSON.stringify(approval.data)}`);
  assert.equal((await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} })).response.status, 409, 'deposit must not be credited twice');
  assert.equal((await api(origin, '/api/state', { cookie: customer.cookie })).data.user.availableUsdt, 5, 'deposit must credit wallet once');
  assert.equal((await api(origin, '/api/deposits', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { amountUsdt: 5, network: 'TRC20', txHash: 'A'.repeat(64) } })).response.status, 409, 'hash duplicates must be case-insensitive');
  const blockedDeletion = await api(origin, '/api/account/delete', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { password: 'SmokeCustomer12345', confirmation: 'DELETE' } });
  assert.equal(blockedDeletion.response.status, 409, 'account deletion must be blocked while an available USDT balance remains');
  assert.equal((await api(origin, '/api/auth/me', { cookie: customer.cookie })).response.status, 200, 'a blocked deletion must restore the customer account to active');

  // Seed one bank record directly into the disposable test database so no external IFSC request is required.
  const expectedFullAccount = '1234567890123456';
  const bankIv = crypto.randomBytes(12);
  const bankCipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.BANK_ENCRYPTION_KEY, 'hex'), bankIv);
  const bankEncryptedData = Buffer.concat([bankCipher.update(expectedFullAccount, 'utf8'), bankCipher.final()]);
  const validAccountCipher = JSON.stringify({ iv: bankIv.toString('base64'), tag: bankCipher.getAuthTag().toString('base64'), data: bankEncryptedData.toString('base64') });
  await testDb.collection('banks').insertOne({ _id: 'BNK-SMOKE-001', user_id: registration.data.user.id, holder: 'TEST CUSTOMER', account_cipher: validAccountCipher, account_fingerprint: 'smoke-fingerprint', account_last4: expectedFullAccount.slice(-4), ifsc: 'TEST0123456', bank_name: 'Smoke Bank', branch_name: 'Smoke Branch', created_at: new Date().toISOString() });
  const tooLargePayout = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 636 } });
  assert.equal(tooLargePayout.response.status, 409, 'payout exceeding available balance must be rejected');
  const payout = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 110 } });
  assert.equal(payout.response.status, 201, `payout request failed: ${JSON.stringify(payout.data)}`);
  assert.equal(payout.data.transaction.account, `•••• ${expectedFullAccount.slice(-4)}`, 'ordinary payout response must continue to mask account numbers');
  const customerReceipt = await api(origin, `/api/payouts/${encodeURIComponent(payout.data.transaction.id)}/receipt`, { cookie: customer.cookie });
  assert.equal(customerReceipt.response.status, 200, 'payout owner should be able to retrieve the payout receipt');
  assert.equal(customerReceipt.data.transaction.account, expectedFullAccount, 'owner-scoped payout receipt should include the full account number');
  const adminReceipt = await api(origin, `/api/payouts/${encodeURIComponent(payout.data.transaction.id)}/receipt`, { cookie: admin.cookie });
  assert.equal(adminReceipt.response.status, 404, 'other accounts including admins must not use the owner-only receipt endpoint');
  let state = await api(origin, '/api/state', { cookie: customer.cookie });
  assert.equal(state.data.user.availableUsdt, 4);
  assert.equal(state.data.user.reservedUsdt, 1);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/approve`, { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: {} })).response.status, 403, 'normal users cannot approve payouts');
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} })).response.status, 200);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: '' } })).response.status, 400, 'successful payout requires reference');
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: 'SMOKE-BANK-REF-123' } })).response.status, 200);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: 'SMOKE-BANK-REF-123' } })).response.status, 409, 'payout must not complete twice');
  const payoutSuccessNotes = await api(origin, '/api/notifications', { cookie: customer.cookie });
  const payoutSuccessNote = payoutSuccessNotes.data.notifications.find(row => row.kind === 'payout_success' && row.body.includes('marked successful'));
  assert.ok(payoutSuccessNote, 'successful payout should notify its owner');
  const adminAfterPayoutNotes = await api(origin, '/api/notifications', { cookie: admin.cookie });
  assert.equal(adminAfterPayoutNotes.data.notifications.some(row => row.kind === 'payout_success'), false, 'payout success notification must not be disclosed to admins');
  assert.equal((await api(origin, `/api/notifications/${encodeURIComponent(payoutSuccessNote.id)}/read`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} })).response.status, 404, 'admins must not mark a customer notification as read');
  const rejected = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 110 } });
  assert.equal(rejected.response.status, 201);
  assert.equal((await api(origin, `/api/admin/payouts/${rejected.data.transaction.id}/reject`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { reason: 'Smoke test rejection' } })).response.status, 200);
  state = await api(origin, '/api/state', { cookie: customer.cookie });
  assert.equal(state.data.user.availableUsdt, 4);
  assert.equal(state.data.user.reservedUsdt, 0);

  // Exercise account deletion against a disposable account with no balances or open requests.
  const deletionCsrf = await api(origin, '/api/auth/csrf');
  const deletionRegistration = await api(origin, '/api/auth/register', {
    method: 'POST', cookie: deletionCsrf.cookie, csrf: deletionCsrf.data.csrfToken,
    body: { name: 'DELETE TEST USER', email: 'delete-test@example.com', password: 'DeleteCustomer12345' }
  });
  assert.equal(deletionRegistration.response.status, 201, `deletion-test registration failed: ${JSON.stringify(deletionRegistration.data)}`);
  const deletionUserId = deletionRegistration.data.user.id;
  const deletionCookie = deletionRegistration.cookie;
  const deletionToken = deletionRegistration.data.csrfToken;
  const historicId = 'PAY-DELETE-SAMPLE';
  await testDb.collection('banks').insertOne({ _id: 'BNK-DELETE-SAMPLE', user_id: deletionUserId, holder: 'DELETE TEST USER', account_cipher: 'encrypted-test-only', account_fingerprint: 'delete-fingerprint', account_last4: '4242', ifsc: 'TEST0123456', bank_name: 'Smoke Bank', branch_name: 'Smoke Branch', created_at: new Date().toISOString() });
  await testDb.collection('notifications').insertOne({ _id: `NTF:deletion:${deletionUserId}`, recipient_id: deletionUserId, recipient_role: 'user', event_key: 'deletion-test', kind: 'payout_success', title: 'Test notification', body: 'Test only', route: '/', read_at: null, created_at: new Date().toISOString() });
  await testDb.collection('push_subscriptions').insertOne({ _id: `PUSH-DELETE-${deletionUserId}`, user_id: deletionUserId, active: true, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'test', auth: 'test' } } });
  await testDb.collection('push_outbox').insertOne({ _id: `OUTBOX-DELETE-${deletionUserId}`, recipient_id: deletionUserId, state: 'pending', created_at: new Date().toISOString() });
  await testDb.collection('notification_preferences').insertOne({ _id: deletionUserId, in_app_enabled: true, push_enabled: false });
  await testDb.collection('transactions').insertOne({ _id: historicId, user_id: deletionUserId, type: 'payout', status: 'success', amount_paise: 11000, usdt_micro: 1000000, bank_id: 'BNK-DELETE-SAMPLE', bank_cipher: 'encrypted-test-only', bank_holder: 'DELETE TEST USER', bank_last4: '4242', bank_name: 'Smoke Bank', branch_name: 'Smoke Branch', ifsc: 'TEST0123456', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await testDb.collection('ledger').insertOne({ _id: `${historicId}:payout_paid`, user_id: deletionUserId, transaction_id: historicId, entry_type: 'payout_paid', available_delta_micro: 0, reserved_delta_micro: -1000000, created_at: new Date().toISOString() });
  const wrongDeletePassword = await api(origin, '/api/account/delete', { method: 'POST', cookie: deletionCookie, csrf: deletionToken, body: { password: 'IncorrectPassword123', confirmation: 'DELETE' } });
  assert.equal(wrongDeletePassword.response.status, 403, 'account deletion must verify the current password');
  assert.ok(await testDb.collection('users').findOne({ _id: deletionUserId, status: 'active' }), 'wrong password must not lock or delete the account');
  const wrongDeleteConfirmation = await api(origin, '/api/account/delete', { method: 'POST', cookie: deletionCookie, csrf: deletionToken, body: { password: 'DeleteCustomer12345', confirmation: 'delete' } });
  assert.equal(wrongDeleteConfirmation.response.status, 400, 'account deletion must require the exact confirmation word');
  const deletionResult = await api(origin, '/api/account/delete', { method: 'POST', cookie: deletionCookie, csrf: deletionToken, body: { password: 'DeleteCustomer12345', confirmation: 'DELETE' } });
  assert.equal(deletionResult.response.status, 200, `account deletion failed: ${JSON.stringify(deletionResult.data)}`);
  assert.equal((await api(origin, '/api/auth/me', { cookie: deletionCookie })).response.status, 401, 'deleted customer sessions must no longer authenticate');
  assert.equal(await testDb.collection('users').findOne({ _id: deletionUserId }), null, 'deleted account profile must be removed');
  assert.equal(await testDb.collection('banks').countDocuments({ user_id: deletionUserId }), 0, 'saved bank records must be deleted');
  assert.equal(await testDb.collection('notifications').countDocuments({ recipient_id: deletionUserId }), 0, 'account deletion must remove private notification history');
  assert.equal(await testDb.collection('push_subscriptions').countDocuments({ user_id: deletionUserId }), 0, 'account deletion must remove browser push subscriptions');
  assert.equal(await testDb.collection('push_outbox').countDocuments({ recipient_id: deletionUserId }), 0, 'account deletion must remove queued push notifications');
  assert.equal(await testDb.collection('notification_preferences').countDocuments({ _id: deletionUserId }), 0, 'account deletion must remove notification preferences');
  const preservedTransaction = await testDb.collection('transactions').findOne({ _id: historicId });
  assert.ok(preservedTransaction, 'financial transaction history must be preserved for reconciliation');
  assert.equal(preservedTransaction.user_deleted, true);
  assert.match(preservedTransaction.user_id, /^DELETED-/);
  for (const field of ['bank_id','bank_cipher','bank_holder','bank_last4','bank_name','branch_name','ifsc']) assert.equal(Object.hasOwn(preservedTransaction, field), false, `retained transaction must not contain ${field}`);
  const preservedLedger = await testDb.collection('ledger').findOne({ transaction_id: historicId });
  assert.equal(preservedLedger.user_deleted, true, 'ledger should retain its entry but pseudonymize the deleted customer reference');
  assert.equal(preservedLedger.user_id, preservedTransaction.user_id);
  assert.ok(await testDb.collection('audit_log').findOne({ action: 'user_account_deleted', target_id: preservedTransaction.user_id }), 'account deletion should create a pseudonymous audit entry');

  const newAdminPassword = 'SmokeTestAdminPasswordChanged2026!';
  const adminReset = spawnSync(node, ['scripts/create-admin.js', '--email', 'smoke-admin@example.com', '--name', 'SMOKE ADMIN'], { cwd: root, env: { ...env, ADMIN_PASSWORD: newAdminPassword }, encoding: 'utf8' });
  assert.equal(adminReset.status, 0, `admin reset failed: ${adminReset.stderr || adminReset.stdout}`);
  assert.equal((await api(origin, '/api/admin/overview', admin)).response.status, 401, 'admin reset must revoke previous admin sessions');
  admin = await login(origin, 'smoke-admin@example.com', newAdminPassword);
  assert.equal(admin.user.role, 'admin');
  console.log('CKXchange MongoDB integration tests passed: auth/admin isolation, PWA static assets, notification recipient isolation/preferences, owner-only full-account payout receipt, support and deposit settings, account deletion, balances, and payout workflow.');
})().catch(error => {
  console.error('CKXchange MongoDB integration test failed:', error.stack || error);
  if (serverOutput) console.error('Server output:\n' + serverOutput);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  if (mongoClient) {
    try { await mongoClient.db(dbName).dropDatabase(); } catch (_) {}
    await mongoClient.close().catch(() => {});
  } else {
    try {
      const cleanup = new MongoClient(testUri);
      await cleanup.connect(); await cleanup.db(dbName).dropDatabase(); await cleanup.close();
    } catch (_) { /* best-effort cleanup after setup failures */ }
  }
});
