'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'lib', 'domain.js'), 'utf8');
const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) {
  console.error(`Duplicate HTML IDs: ${[...new Set(duplicates)].join(', ')}`);
  process.exit(1);
}
const available = new Set(ids);
const references = [...js.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
const missing = [...new Set(references.filter(id => !available.has(id)))];
if (missing.length) {
  console.error(`JavaScript references missing HTML IDs: ${missing.join(', ')}`);
  process.exit(1);
}
if (!available.has('depositAddressTRC20') || !available.has('depositAddressTRC20Status') || !available.has('inrPerUsdtRate')) {
  console.error('Admin settings must expose only the TRC20 address and the editable INR/USDT rate.');
  process.exit(1);
}
if (/depositAddress(?:ERC20|BEP20|POLYGON|SOLANA)|value="(?:ERC20|BEP20|POLYGON|SOLANA)"/.test(html)) {
  console.error('The UI must not expose other deposit networks.');
  process.exit(1);
}
if (!js.includes("request('/api/admin/settings/deposits')") || !html.includes('id="depositSettingsForm"')) {
  console.error('Admin deposit-address management UI or API binding is missing.');
  process.exit(1);
}
if (!js.includes('body:{ address, rate }') || !js.includes('renderRateDisplays') || !html.includes('id="sidebarRateValue"') || !html.includes('id="homeRateNote"') || !html.includes('id="profileRateValue"')) {
  console.error('Admin-managed exchange rate is not wired to settings and user-facing rate labels.');
  process.exit(1);
}
const markerStarts = (html.match(/<!-- CKX_ADMIN_UI_START -->/g) || []).length;
const markerEnds = (html.match(/<!-- CKX_ADMIN_UI_END -->/g) || []).length;
if (markerStarts !== 3 || markerEnds !== 3) {
  console.error(`Expected 3 isolated admin markup blocks, found ${markerStarts} starts and ${markerEnds} ends.`);
  process.exit(1);
}
const customerShell = html.replace(/<!-- CKX_ADMIN_UI_START -->[\s\S]*?<!-- CKX_ADMIN_UI_END -->/g, '');
if (/id="page-admin"|id="adminNav"|id="adminMobileNav"|id="depositSettingsForm"/.test(customerShell)) {
  console.error('Customer HTML shell still contains admin controls.');
  process.exit(1);
}
if (!js.includes("window.location.replace('/admin')") || !js.includes("if ($('depositSettingsForm'))")) {
  console.error('Admin sign-in shell reload or optional admin-form wiring is missing.');
  process.exit(1);
}
if (!js.includes("state.user?.role !== 'admin'") || !js.includes("(error.status === 401 || error.status === 403) && $('page-admin')")) {
  console.error('Expired or revoked admin sessions must reload the role-sanitized customer shell.');
  process.exit(1);
}
if (!server.includes('activeAdminForRequest') || !server.includes("Cache-Control', 'no-store, max-age=0'")) {
  console.error('Role-aware no-cache app shell serving is missing.');
  process.exit(1);
}
if (!server.includes('deposit_address: depositAddress.address') || !server.includes('depositAddress: row.deposit_address')) {
  console.error('Deposit requests must retain the receiving address used when submitted.');
  process.exit(1);
}
const adminScript = fs.readFileSync(path.join(root, 'scripts', 'create-admin.js'), 'utf8');
if (!adminScript.includes("{ role: 'admin', _id: { $ne: targetId } }") || !adminScript.includes("{ $set: { role: 'user' } }")) {
  console.error('Admin provisioning must demote other admin-role accounts by default.');
  process.exit(1);
}
const securityChecks = [
  [server.includes("app.use('/api/admin', requireAuth, requireAdmin);"), 'Central admin API authorization is missing.'],
  [server.includes("app.use(/^\\/admin") || server.includes("app.use(/^\/admin"), 'Server-side /admin route guard is missing.'],
  [server.includes("role: 'user'") && server.includes("password_hash: await bcrypt.hash(password, 12)"), 'Registration must force ordinary-user role and hash passwords.'],
  [server.includes("app.put('/api/admin/settings/deposits'") && server.includes("writeSetting('inr_per_usdt'") && server.includes('exchange_rate_and_trc20_address_updated'), 'Admin rate/address settings endpoint is missing.'],
  [server.includes('function requireCsrf') && server.includes('safeEqual') && domain.includes('crypto.timingSafeEqual') && server.includes('Cross-site requests are not allowed.') && server.includes('origin === requestOrigin'), 'CSRF and same-origin mutation checks are missing.'],
  [server.includes('if (!depositAddress.valid) return apiError(res, 503'), 'Deposit submission is not gated on a configured receiving address.'],
  [server.includes("status: 'success'") && server.includes("entry_type: 'deposit_credit'") && server.includes('await runTransaction(async mongoSession'), 'One-time pending deposit credit safeguards are missing.'],
  [server.includes('available_usdt_micro: { $gte: usdtMicro }') && server.includes("txn.status !== 'processing'"), 'Payout reservation/completion checks are missing.'],
  [server.includes('fromUsdtMicro(usdtMicro) * await currentRate()') && server.includes('amountPaise / 100 / currentExchangeRate'), 'Deposit/payout conversions must use the current admin-managed rate.'],
  [server.includes("if (network !== 'TRC20') return apiError(res, 400, 'Only USDT on TRON (TRC20) is supported.')"), 'The backend must enforce TRC20-only deposit requests.'],
  [server.includes("const mongoClient = new MongoClient(MONGODB_URI") && server.includes("collectionName: 'sessions'"), 'MongoDB must be the database and session store.'],
  [js.includes('const isAdminPath = () => /^\\/admin') && js.includes('requestedAdminPage'), 'Admin navigation deep-link handling is missing.']
];
for (const [ok, message] of securityChecks) {
  if (!ok) { console.error(message); process.exit(1); }
}
console.log(`Checks passed: ${ids.length} unique HTML IDs, ${new Set(references).size} resolved static JS ID references, and ${securityChecks.length} security invariants.`);
