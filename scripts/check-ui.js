'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'views', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const domain = fs.readFileSync(path.join(root, 'lib', 'domain.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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
if (!js.includes('body:{ address, rate }') || !js.includes('renderRateDisplays') || !html.includes('id="sidebarRateValue"') || !html.includes('id="homeRateNote"') || html.includes('id="profileRateValue"') || html.includes('Fixed exchange rate</div>') || html.includes('Local data storage</div>')) {
  console.error('Admin-managed exchange rate must remain functional while rate/storage rows are removed from Profile & Settings.');
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
  [server.includes('fromUsdtMicro(usdtMicro) * depositRate') && server.includes('amountPaise / 100 / currentExchangeRate'), 'Deposit/payout conversions must use the current admin-managed rate.'],
  [server.includes("if (network !== 'TRC20') return apiError(res, 400, 'Only USDT on TRON (TRC20) is supported.')"), 'The backend must enforce TRC20-only deposit requests.'],
  [server.includes("const mongoClient = new MongoClient(MONGODB_URI") && server.includes("collectionName: 'sessions'"), 'MongoDB must be the database and session store.'],
  [js.includes('const isAdminPath = () => /^\\/admin') && js.includes('requestedAdminPage'), 'Admin navigation deep-link handling is missing.'],
  [server.includes("app.post('/api/account/delete'") && server.includes("confirmation !== 'DELETE'") && server.includes("bcrypt.compare(password, current.password_hash)") && server.includes('DELETE_BLOCKED_BALANCE') && server.includes('DELETE_BLOCKED_REQUESTS') && server.includes('canDeleteWithDustBalance(availableUsdtMicro, reservedUsdtMicro, deletionRate)'), 'Safe account deletion must verify password/confirmation, permit only sub-₹1 available dust, and block reserved balances or open requests.'],
  [server.includes('user_deleted: true') && server.includes("bank_cipher: ''") && server.includes("ledger').updateMany({ user_id: userId }"), 'Account deletion must pseudonymize retained financial records and remove encrypted bank details.'],
  [server.includes("app.get('/api/support'") && server.includes("app.put('/api/admin/settings/support'") && server.includes('normalizeTelegramUsername') && server.includes('telegram_support_username_updated'), 'Configurable Telegram customer support is missing or lacks validation/audit logging.'],
  [server.includes('parseListParams(req)') && server.includes('.skip((page - 1) * pageSize).limit(pageSize)') && server.includes('paginationDto(page, pageSize, total)'), 'Admin queues must use server-side pagination and validated page sizes.'],
  [html.includes('href="/admin/deposits"') && html.includes('href="/admin/payouts"') && html.includes('href="/admin/users"') && html.includes('href="/admin/audit"') && html.includes('href="/admin/settings"') && js.includes('setAdminSubPage'), 'Separate administrator subpages and route handling are missing.'],
  [js.includes('adminCopyIcon(value, label)') && js.includes('navigator.clipboard?.writeText') && html.includes('id="adminDepositsRows"') && html.includes('id="adminPayoutRows"') && html.includes('class="admin-request-list"') && js.includes("adminRequestField('PAY ID'") && js.includes("adminRequestField('DEP ID'"), 'Mobile-friendly deposit/payout request cards, DEP/PAY identifiers, or inline copy icons are missing.'],
  [js.includes('data-toggle-admin-request') && js.includes('expandedAdminRequestKey') && js.includes('admin-request-details') && js.includes('aria-expanded') && js.includes('shouldExpand=expandedAdminRequestKey!==key') && js.includes("classList.toggle(\'is-expanded\'") && html.includes('.admin-request-summary') && html.includes('.admin-request-details[hidden]'), 'Admin request summaries must expand/collapse one at a time with accessible controls and retain details below.'],
  [html.includes('id="deleteAccountForm"') && html.includes('id="supportTelegramLink"') && html.includes('id="supportSettingsForm"'), 'Account deletion and customer/admin support controls are missing.'],
  [(html.match(/<img src="\/icons\/icon-192\.png\?v=2\.4\.12" alt="" \/>/g) || []).length === 3 && !/<div[^>]*class="[^"]*brand-mark[^"]*"[^>]*>\s*<svg/.test(html), 'All three in-app brand marks must use the supplied transparent CKX currency logo.' ],
  [fs.existsSync(path.join(root, 'public', 'icons', 'icon-192.png')) && fs.existsSync(path.join(root, 'public', 'icons', 'icon-512.png')) && fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8').includes('ckxchange-static-v2-4-12') && fs.readFileSync(path.join(root, 'public', 'offline.html'), 'utf8').includes('ckx-logo-192.png?v=2.4.12'), 'New in-app icons, offline logo, and versioned service-worker cache must be present.'],

  [html.includes('rel="manifest" href="/manifest.webmanifest"') && fs.existsSync(path.join(root, 'public', 'service-worker.js')) && fs.existsSync(path.join(root, 'public', 'offline.html')) && fs.existsSync(path.join(root, 'public', 'icons', 'ckx-logo-192.png')) && fs.existsSync(path.join(root, 'public', 'icons', 'ckx-logo-512.png')) && fs.readFileSync(path.join(root, 'public', 'manifest.webmanifest'), 'utf8').includes('/icons/ckx-logo-512.png'), 'PWA manifest, offline page, icons, and service worker must be present.'],
  [server.includes("app.get('/api/payouts/:id/receipt', requireAuth") && server.includes("user_id: req.user._id, type: 'payout'") && server.includes('transactionDto(txn, true)'), 'Full payout account number must only be returned by an authenticated owner-scoped receipt endpoint.'],
  [server.includes("app.get('/api/banks/:id/payout-review', requireAuth") && server.includes("findOne({ _id: req.params.id, user_id: req.user._id })") && server.includes('decryptAccount(bank.account_cipher)') && server.includes("Cache-Control', 'no-store, max-age=0'"), 'Full saved bank account number must be exposed only to the authenticated owner through a no-cache payout-review endpoint.'],
  [server.includes('queueDepositAdminNotifications(mongoSession, transaction)') && server.includes("role: 'admin', status: 'active'") && server.includes('queuePayoutSuccessNotification(mongoSession') && server.includes('recipient_id: req.user._id'), 'Deposit and successful-payout notifications must be recipient-scoped and transaction-bound.'],
  [server.includes("db.collection('notifications').find(filter)") && server.includes('recipient_id: req.user._id') && server.includes("app.post('/api/notifications/:id/read'"), 'Notification history and read actions must be filtered by the authenticated recipient.'],
  [server.includes('allowedPushEndpoint(value.endpoint)') && fs.existsSync(path.join(root, 'lib', 'web-push.js')) && server.includes('hasVapidConfig()'), 'Web Push must require validated endpoint URLs and server-side VAPID configuration.'],
  [js.includes("request(`/api/payouts/${encodeURIComponent(t.id)}/receipt`) ") || js.includes("request(`/api/payouts/${encodeURIComponent(t.id)}/receipt`)") , 'Payout receipt must fetch owner-authorized full account details.'],
  [js.includes('loadNotifications') && js.includes('togglePushNotifications') && html.includes('id="notificationBellCount"') && html.includes('id="notificationList"'), 'In-app notification history, unread count, and push preference controls must be wired.'],
  [fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8').includes("url.pathname.startsWith('/api/')") && fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8').includes("url.pathname === '/'") && fs.readFileSync(path.join(root, 'public', 'service-worker.js'), 'utf8').includes("caches.match('/offline.html')"), 'Service worker must not cache API or personalized HTML and must return a safe offline page.'],
  [server.includes("collection('push_subscriptions').deleteMany({ user_id: userId }") && server.includes("collection('notifications').deleteMany({ recipient_id: userId }") && server.includes("collection('notification_preferences').deleteOne({ _id: userId }"), 'Account deletion must also remove notification history, subscriptions, and preferences.'],
  [server.includes('recipient_role: req.user.role') && server.includes("filter.kind = { $ne: 'deposit_request' }"), 'Demoted administrators must not retain access to admin-only notifications.'],
  [html.includes('id="page-notifications"') && html.indexOf('id="notificationPanel"') < html.indexOf('id="page-profile"') && js.includes("go('notifications')"), 'Notifications must live on a dedicated page, not in Profile & Settings.'],
  [html.includes('id="contactSettingsForm"') && html.includes('id="telegramContactId"') && html.includes('id="contactPhoneNumber"') && server.includes("app.put('/api/profile/contact'") && server.includes('normalizeUserTelegramId') && server.includes('normalizePhoneNumber') && server.includes('telegramId: user.telegram_id') && server.includes('phoneNumber: user.phone_number'), 'Customer support contact settings must be validated, saved, and returned to the authenticated owner.'],
  [server.includes('const body = `New USDT deposit request: ${notificationUsdt(transaction.usdt_micro)} USDT (≈ ₹${notificationInr(transaction.amount_paise)') && server.includes('to bank account ending ${last4}') && server.includes('notificationUsdt(transaction.usdt_micro)'), 'Notifications must include deposit/payout amounts and payout bank last four digits.'],
  [js.includes('function renderAuditDetails(details)') && js.includes('shortHash(raw)') && js.includes('data-copy-value="${safe(raw)}"') && html.includes('.audit-detail-value') && html.includes('overflow-wrap:anywhere'), 'Admin audit details must wrap long hashes on mobile while retaining a copy-full-hash action.'],
  [server.includes('const MIN_DEPOSIT_USDT = 10;') && server.includes('const MIN_PAYOUT_INR = 1000;') && server.includes('amount < MIN_DEPOSIT_USDT') && server.includes('amount < MIN_PAYOUT_INR') && html.includes('id="depositAmount" max="10000000" min="10"') && html.includes('id="sendAmount" inputmode="decimal" max="100000" min="1000"'), 'Minimum deposit/withdrawal rules must be enforced in both the browser and server.'],
  [server.includes('const SESSION_TTL_SECONDS = 10 * 24 * 60 * 60;') && server.includes('maxAge: SESSION_TTL_MS') && server.includes('touchAfter: 0') && (server.match(/await saveSession\(req\)/g) || []).length >= 2, 'Login sessions must persist before responding and expire after ten rolling days.'],
  [js.includes('let initializeRunning = false;') && js.includes('authRetryButton') && js.includes('if (error.status === 401) {') && js.includes('your account has not been signed out'), 'Transient session restoration failures must not flash a false sign-in state.'],
  [js.includes('async function openPayoutReview(bankId, amountInr)') && js.includes('function submitReviewedPayout()') && html.includes('id="payoutReviewModal"') && js.includes("request('/api/payouts', { method:'POST', body:payload })"), 'Payout submission must use a review-and-confirm step.'],
  [html.includes('<th>Transaction</th><th>Amount</th><th>Status</th>') && !/customer-history-table[\s\S]*?<th>USDT<\/th>/.test(html) && js.includes('history-transaction-date') && html.includes('.customer-history-table { min-width: 0; width: 100%; table-layout: fixed; }'), 'Customer transaction history must fit a three-column mobile layout without a USDT column.'],
  [server.includes('queueDepositApprovedNotification(mongoSession, transaction)') && server.includes("'deposit_approved'") && server.includes('deliverPushOutbox(result.notificationIds)'), 'Approved deposits must queue an owner-scoped in-app/push notification.'],
  [server.includes('async function auditUser(userId, action, targetId') && server.includes("'payout_requested'") && server.includes('payoutAmountInr: fromPaise(payout.amount_paise)') && server.includes('const payoutMap = new Map') && server.includes('accountNumber: payout.bank_cipher ? transactionDto(payout, true).account') && server.includes('payoutLinked: Boolean(payout)') && js.includes('Payout requester') && js.includes('Customer requested an INR payout'), 'The admin audit log must record payout requests and retrieve destination account details from the linked transaction for authorized administrators.'],
  [packageJson.version === '2.4.12' && packageJson.overrides?.['body-parser'] === '^2.4.0', 'Release 2.4.12 must retain the patched body-parser 2.4.x transitive dependency.'],
  [js.includes('const fmtUsdt = (value, digits = 4) => `$${fmtNumber(value, digits)}`') && js.includes("$('homeUsdt').textContent = fmtUsdt(state.balance, 4)") && js.includes("$('profileBalance').textContent = fmtUsdt(state.balance, 4)") && js.includes("$('historyUsdt').textContent = fmtUsdt(usdt, 4)"), 'USDT balances and deductions must be rendered with a leading dollar sign.'],
  [server.includes("app.get('/api/admin/payouts/:id/receipt'") && server.includes('transaction: transactionDto(txn, true)') && server.includes("res.set('Cache-Control', 'no-store, max-age=0')"), 'Admin payout receipt must use a privileged no-cache route and the full slip DTO.'],
  [js.includes('function renderAuditEntry(entry)') && js.includes('data-view-admin-transaction=') && js.includes('data-view-admin-transaction') && js.includes('async function openAdminReceipt') && js.includes('Account number') && js.includes('View slip'), 'Payout audit rows must be compact and provide a working View slip action.'],
  [js.includes("ctx.textAlign = 'center'") && js.includes('ctx.fillText(`Payout ${palette.label}`, width/2, 340)') && js.includes('ctx.fillText(money(t.amount), width/2, 499)'), 'Downloaded payout slips must center their headline and amount.'],
  [server.includes("app.post('/api/banks'") && (server.match(/role: \{ \$in: \['user', 'admin'\] \}, status: 'active'/g) || []).length >= 3 && !server.includes("const active = await db.collection('users').updateOne({ _id: req.user._id, role: { $in: ['user', 'admin'] }, status: 'active' }, { $inc: { activity_seq: 1 } }"), 'Active administrators must be allowed to use their own bank, deposit, and payout workflow without a dummy activity counter write.'],
  [server.includes('const MAX_PAYOUT_INR = 100_000;') && server.includes('amount > MAX_PAYOUT_INR') && html.includes('id="sendAmount" inputmode="decimal" max="100000" min="1000"') && js.includes('function maxPayoutAmountInr()') && html.includes('id="sendMax"'), 'Payout maximum must be enforced server-side and the MAX button must use the safely available balance.'],
  [server.includes("accountCandidates = await db.collection('transactions').find") && server.includes('decryptAccount(row.bank_cipher) === q') && html.includes('account number (full or last 4)'), 'Administrator payout search must support full account-number and last-four-digit lookup.'],
  [html.includes('>Bank</button>') && html.includes('>Add bank</button>') && !html.includes('</svg>+ Bank</button>') && !html.includes('</svg>+ Add bank</button>') && html.includes('Enter a valid IFSC code to fetch the bank and branch details automatically.') && !html.includes("retrieved from Razorpay's public IFSC API"), 'Bank add buttons must use one plus icon and IFSC copy must avoid provider branding.'],
  [html.includes('data-theme="light"') && html.includes('id="themeModeToggle"') && js.includes('THEME_STORAGE_KEY') && js.includes('function applyTheme') && fs.existsSync(path.join(root, 'public', 'theme-init.js')), 'Light mode must be the default and the Profile theme toggle must persist the user preference.'],
  [server.includes('credited_usdt_micro: creditedMicro') && server.includes('available_usdt_micro: creditedMicro') && server.includes('requested_usdt_micro: requestedMicro') && server.includes('ADJUSTMENT_REASON_REQUIRED'), 'Admin deposit approval must atomically credit the verified amount, retain the requested amount, and require a reason for adjustments.'],
  [server.includes("auditUser(req.user._id, 'deposit_requested'") && js.includes("deposit_requested: 'Customer requested a USDT deposit'") && server.includes('depositOwnerName'), 'Deposit audit entries must identify the requesting user and requested amount.'],
  [js.includes('data-requested-usdt=') && js.includes('Enter the actual USDT amount independently verified on-chain') && js.includes('adjustmentReason'), 'Admin deposit verification must allow the admin to enter the actual verified amount with an adjustment reason.'],
  [html.includes('id="pwaInstallRow"') && html.includes('id="pwaInstallButton"') && js.includes("window.addEventListener('beforeinstallprompt'") && js.includes("window.addEventListener('appinstalled'") && js.includes('isPwaRunningInstalled'), 'Profile must offer PWA installation and hide the control once installed.'],
  [server.includes('payoutOwnerName') && js.includes('Requested by:') && server.includes('depositMap') && js.includes('depositOwnerName'), 'Audit records must display the original payout requester and USDT deposit requester.'],
  [js.includes("const width = 1254") && js.includes("'#d8ccff'") && js.includes("'#f4dafa'") && html.includes('.receipt-modal { background: linear-gradient(135deg,#f4efff'), 'Payout slips must retain the fixed pastel reference palette in both app themes.'],
  [server.includes("app.post('/api/auth/change-password', requireAuth, authLimiter") && server.includes('bcrypt.compare(currentPassword, current.password_hash)') && server.includes('bcrypt.hash(newPassword, 12)') && server.includes('newPassword !== confirmPassword'), 'Password changes must require an authenticated session, rate limiting, current-password verification, matching confirmation, and bcrypt hashing.'],
  [html.includes('id="openChangePassword"') && html.includes('data-go="password"') && html.includes('id="page-password"') && html.includes('id="currentAccountPassword"') && html.includes('id="newAccountPassword"') && html.includes('id="confirmAccountPassword"') && js.includes("password: ['ACCOUNT SECURITY', 'Change password'") && js.includes("request('/api/auth/change-password'") && js.includes("page === 'password' ? 'profile' : page"), 'Profile must open a dedicated password-change page and keep Profile navigation active.'],
  [js.includes("rows.forEach(([label,value], index)") && js.includes("ctx.fillText(label, 132, y)") && !js.includes('const iconStyles = [') && !js.includes('ctx.fillText(icon,158,y+1)'), 'Downloaded payout slips must render clean detail rows without the unwanted initial text/icon tiles.'],
  [html.includes('id="profileMemberId"') && html.includes('id="profileAccountStatus"') && html.includes('id="profileBalance"') && html.includes('id="profileReservedBalance"') && !html.includes('id="profileTotal"') && js.includes("$('profileReservedBalance').textContent = fmtUsdt(state.reservedUsdt, 4)"), 'Profile must show identity details and exactly the available/reserved USDT balance cards, without Total INR Sent.'],
  [html.includes('Personal Information') && html.includes('Bank Accounts') && html.includes('Security</h2>') && html.includes('Appearance</h2>') && html.includes('Notifications</h2>') && html.includes('App Settings</h2>') && html.includes('Help &amp; Support</h2>') && html.includes('id="deleteAccountPanel"') && html.includes('id="logoutButton"'), 'Profile sections must be organized and keep support, account deletion, and sign-out controls.'],
  [html.includes('data-go="banks"') && html.includes('data-go="notifications"') && html.includes('id="themeModeToggle"') && html.includes('id="pwaInstallButton"') && html.includes('id="supportTelegramLink"') && html.includes('id="mobile-bottom"'), 'Profile shortcuts must preserve bank, notification, appearance, install, support, and existing bottom navigation functionality.']
];
for (const [ok, message] of securityChecks) {
  if (!ok) { console.error(message); process.exit(1); }
}
if (!html.includes('.transaction-slip-link') || !html.includes('margin-top: 0;') || !html.includes('white-space: nowrap; overflow-wrap: normal; word-break: normal;') || !js.includes('async function openPayoutReview') || !js.includes('request(`/api/banks/${encodeURIComponent(bankId)}/payout-review`)') || !js.includes("$('payoutReviewAccount').textContent = accountNumber")) {
  console.error('Payout review and mobile history alignment fixes are missing.');
  process.exit(1);
}
if (html.includes('receipt-demo-note') || html.includes('Pending/processing is not proof of payment.') || js.includes('PENDING / PROCESSING IS NOT PROOF OF PAYMENT')) {
  console.error('The removed payout-slip disclaimer is still present.');
  process.exit(1);
}
const receiptCode = js.slice(js.indexOf('function createReceiptCanvas'), js.indexOf('async function downloadReceiptImage'));
if (receiptCode.includes("fillText('CKXchange'") || receiptCode.includes('This receipt reflects the current status stored in CKXchange.')) {
  console.error('Downloaded payout slips must not include the CKXchange heading or status footer sentence.');
  process.exit(1);
}
console.log(`Checks passed: ${ids.length} unique HTML IDs, ${new Set(references).size} resolved static JS ID references, and ${securityChecks.length} security invariants.`);
