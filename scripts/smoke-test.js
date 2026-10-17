'use strict';

// Full HTTP integration test against an explicitly provided, disposable MongoDB database.
// Uses a unique test DB and drops only that database at the end. Transactions require a replica set (MongoDB Atlas works).
const assert = require('node:assert/strict');
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

  let csrf = await api(origin, '/api/auth/csrf');
  const registration = await api(origin, '/api/auth/register', {
    method: 'POST', cookie: csrf.cookie, csrf: csrf.data.csrfToken,
    body: { name: 'TEST CUSTOMER', email: 'smoke-user@example.com', password: 'SmokeCustomer12345', role: 'admin' }
  });
  assert.equal(registration.response.status, 201, `registration failed: ${JSON.stringify(registration.data)}`);
  assert.equal(registration.data.user.role, 'user', 'registration must not allow self-assigned admin role');
  let customer = await login(origin, 'smoke-user@example.com', 'SmokeCustomer12345');
  assert.equal((await api(origin, '/api/admin/overview', customer)).response.status, 403, 'ordinary users must not access admin APIs');

  const adminCreate = spawnSync(node, ['scripts/create-admin.js', '--email', 'smoke-admin@example.com', '--name', 'SMOKE ADMIN'], {
    cwd: root, env: { ...env, ADMIN_PASSWORD: testPassword }, encoding: 'utf8'
  });
  assert.equal(adminCreate.status, 0, `admin bootstrap failed: ${adminCreate.stderr || adminCreate.stdout}`);
  let admin = await login(origin, 'smoke-admin@example.com', testPassword);
  const adminPage = await api(origin, '/admin', { cookie: admin.cookie });
  assert.equal(adminPage.response.status, 200, 'admin session should access /admin');
  assert.match(adminPage.text, /id="page-admin"/, 'admin shell should contain admin UI');

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
  assert.equal((await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: {} })).response.status, 403, 'normal users cannot approve deposits');
  const approval = await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(approval.response.status, 200, `deposit approval failed: ${JSON.stringify(approval.data)}`);
  assert.equal((await api(origin, `/api/admin/deposits/${deposit.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} })).response.status, 409, 'deposit must not be credited twice');
  assert.equal((await api(origin, '/api/state', { cookie: customer.cookie })).data.user.availableUsdt, 5, 'deposit must credit wallet once');
  assert.equal((await api(origin, '/api/deposits', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { amountUsdt: 5, network: 'TRC20', txHash: 'A'.repeat(64) } })).response.status, 409, 'hash duplicates must be case-insensitive');

  // Seed one bank record directly into the disposable test database so no external IFSC request is required.
  mongoClient = new MongoClient(testUri);
  await mongoClient.connect();
  const testDb = mongoClient.db(dbName);
  await testDb.collection('banks').insertOne({ _id: 'BNK-SMOKE-001', user_id: registration.data.user.id, holder: 'TEST CUSTOMER', account_cipher: 'test-cipher', account_fingerprint: 'smoke-fingerprint', account_last4: '4242', ifsc: 'TEST0123456', bank_name: 'Smoke Bank', branch_name: 'Smoke Branch', created_at: new Date().toISOString() });
  const tooLargePayout = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 636 } });
  assert.equal(tooLargePayout.response.status, 409, 'payout exceeding available balance must be rejected');
  const payout = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 110 } });
  assert.equal(payout.response.status, 201, `payout request failed: ${JSON.stringify(payout.data)}`);
  let state = await api(origin, '/api/state', { cookie: customer.cookie });
  assert.equal(state.data.user.availableUsdt, 4);
  assert.equal(state.data.user.reservedUsdt, 1);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/approve`, { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: {} })).response.status, 403, 'normal users cannot approve payouts');
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/approve`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} })).response.status, 200);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: '' } })).response.status, 400, 'successful payout requires reference');
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: 'SMOKE-BANK-REF-123' } })).response.status, 200);
  assert.equal((await api(origin, `/api/admin/payouts/${payout.data.transaction.id}/complete`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { bankReference: 'SMOKE-BANK-REF-123' } })).response.status, 409, 'payout must not complete twice');
  const rejected = await api(origin, '/api/payouts', { method: 'POST', cookie: customer.cookie, csrf: customer.csrf, body: { bankId: 'BNK-SMOKE-001', amountInr: 110 } });
  assert.equal(rejected.response.status, 201);
  assert.equal((await api(origin, `/api/admin/payouts/${rejected.data.transaction.id}/reject`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { reason: 'Smoke test rejection' } })).response.status, 200);
  state = await api(origin, '/api/state', { cookie: customer.cookie });
  assert.equal(state.data.user.availableUsdt, 4);
  assert.equal(state.data.user.reservedUsdt, 0);

  const newAdminPassword = 'SmokeTestAdminPasswordChanged2026!';
  const adminReset = spawnSync(node, ['scripts/create-admin.js', '--email', 'smoke-admin@example.com', '--name', 'SMOKE ADMIN'], { cwd: root, env: { ...env, ADMIN_PASSWORD: newAdminPassword }, encoding: 'utf8' });
  assert.equal(adminReset.status, 0, `admin reset failed: ${adminReset.stderr || adminReset.stdout}`);
  assert.equal((await api(origin, '/api/admin/overview', admin)).response.status, 401, 'admin reset must revoke previous admin sessions');
  admin = await login(origin, 'smoke-admin@example.com', newAdminPassword);
  assert.equal(admin.user.role, 'admin');
  console.log('CKXchange MongoDB integration tests passed: role isolation, sessions, rate/address settings, TRC20-only deposits, duplicate hashes, one-time credit, payout reservation/completion/rejection.');
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
