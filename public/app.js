(() => {
  'use strict';
  const RATE_DEFAULT = 106;
  const $ = id => document.getElementById(id);
  const THEME_STORAGE_KEY = 'ckxchange-theme';
  const PWA_INSTALLED_STORAGE_KEY = 'ckxchange-pwa-installed';
  function applyTheme(theme, persist = true) {
    const selected = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = selected;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', selected === 'dark' ? '#090b13' : '#f6f2ff');
    const toggle = $('themeModeToggle');
    const label = $('themeModeToggleLabel');
    const description = $('themeModeDescription');
    const next = selected === 'light' ? 'dark' : 'light';
    if (label) label.textContent = `Switch to ${next} mode`;
    if (description) description.textContent = `${selected === 'light' ? 'Light' : 'Dark'} mode is enabled. You can switch anytime.`;
    if (toggle) {
      toggle.setAttribute('aria-label', `Switch to ${next} mode`);
      toggle.setAttribute('aria-pressed', String(selected === 'dark'));
      toggle.title = `Switch to ${next} mode`;
    }
    if (persist) {
      try { localStorage.setItem(THEME_STORAGE_KEY, selected); }
      catch (error) { console.warn('CKXchange could not save the appearance preference:', error?.message || error); }
    }
    return selected;
  }
  const state = { user: null, balance: 0, reservedUsdt: 0, rate: RATE_DEFAULT, banks: [], transactions: [], supportUsername: '', notifications: [], unreadNotifications: 0, notificationPrefs: { inAppEnabled: true, pushEnabled: false, pushConfigured: false } };
  let csrfToken = '';
  let authMode = 'login';
  let currentReceipt = null;
  let pendingPayoutReview = null;
  let ifscRequestVersion = 0;
  let ifscTimer = null;
  let addBankReturnPage = 'send';
  let networkConfig = { depositAddress: '', depositConfigured: false };
  let depositAddressRequestVersion = 0;
  let adminLoading = false;
  let expandedAdminRequestKey = '';
  let adminDepositSettingsLoaded = false;
  let adminSupportSettingsLoaded = false;
  let activeAdminSubPage = 'overview';
  const adminLists = {
    deposits: { page: 1, pageSize: 25, q: '' },
    payouts: { page: 1, pageSize: 25, q: '' },
    users: { page: 1, pageSize: 25, q: '' },
    audit: { page: 1, pageSize: 25, q: '' }
  };
  let pollHandle = null;
  let pwaRegistration = null;
  let deferredInstallPrompt = null;
  let pwaInstalled = false;
  let notificationLoadPending = false;
  const ADMIN_SUBPAGES = ['overview', 'deposits', 'payouts', 'users', 'audit', 'settings'];
  const ADMIN_META = {
    overview: ['ADMINISTRATION', 'Admin overview', 'Pending workload and high-level account activity.'],
    deposits: ['ADMINISTRATION', 'Deposit requests', 'Review pending USDT deposits and verify matching on-chain transactions.'],
    payouts: ['ADMINISTRATION', 'Payout requests', 'Process INR payout requests and reconcile completed transfers.'],
    users: ['ADMINISTRATION', 'Users', 'Search customer accounts and review account status and balances.'],
    audit: ['ADMINISTRATION', 'Audit log', 'Review administrator actions and account deletion records.'],
    settings: ['ADMINISTRATION', 'Admin settings', 'Configure the TRC20 receiving address, reference rate, and Telegram support.']
  };
  const isAdminPath = () => /^\/admin(?:\/|$)/i.test(location.pathname);
  const adminSubPageFromPath = () => { const segment = location.pathname.split('/').filter(Boolean)[1] || 'overview'; return ADMIN_SUBPAGES.includes(segment) ? segment : 'overview'; };
  const adminPathFor = route => route === 'overview' ? '/admin' : `/admin/${route}`;
  const requestedAdminPage = () => isAdminPath() || new URLSearchParams(location.search).get('next') === 'admin';

  const PAGE_META = {
    home: ['YOUR ACCOUNT', 'Overview', 'Your available wallet value and recent transactions.'],
    send: ['PAYMENTS', 'Send INR', 'Request a bank payout and track its review status.'],
    banks: ['RECIPIENTS', 'Bank accounts', 'Add, view and remove your saved bank accounts.'],
    addbank: ['RECIPIENTS', 'Add bank account', 'Link an account for future payout requests.'],
    recharge: ['WALLET', 'Add USDT', 'Submit a deposit transaction for verification.'],
    history: ['ACTIVITY', 'Transaction history', 'Track deposit and payout status updates.'],
    profile: ['ACCOUNT', 'Profile & settings', 'Your CKXchange account details and settings.'],
    password: ['ACCOUNT SECURITY', 'Change password', 'Update your password securely.'],
    notifications: ['YOUR ACCOUNT', 'Notification center', 'Review account alerts and manage browser delivery.'],
    admin: ['ADMINISTRATION', 'Admin panel', 'Review deposit claims, payout requests and account activity.']
  };
  const fmtNumber = (value, digits = 4) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtUsdt = (value, digits = 4) => `$${fmtNumber(value, digits)}`;
  const money = value => '₹' + Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const safe = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const statusText = status => ({ pending:'Pending', processing:'Processing', success:'Successful', rejected:'Rejected', failed:'Failed' }[status] || 'Unknown');
  const statusClass = status => `status-${['pending','processing','success','rejected','failed'].includes(status) ? status : 'pending'}`;
  const dateText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }).format(date);
  };
  const dateShort = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { day:'2-digit', month:'short', year:'numeric' }).format(date);
  };
  const masked = value => {
    const raw = String(value || '');
    const last4 = raw.match(/(\d{4})$/)?.[1];
    return last4 ? `•••• ${last4}` : (raw || '—');
  };
  const shortHash = value => {
    const raw = String(value || '');
    return raw.length > 22 ? `${raw.slice(0, 12)}…${raw.slice(-8)}` : raw;
  };
  const AUDIT_DETAIL_LABELS = {
    requestedBy: 'Payout requester', requesterEmail: 'Requester email',
    payoutAmountInr: 'Payout amount', amountInr: 'Payout amount',
    usdtReserved: 'USDT reserved', amountUsdt: 'USDT amount',
    accountHolder: 'Account holder', bankName: 'Destination bank', branchName: 'Branch',
    accountNumber: 'Destination account', accountLast4: 'Destination account', ifscCode: 'IFSC code',
    remainingDustUsdt: 'Remaining USDT balance waived', remainingDustInrApprox: 'Approximate INR value waived', dustBalanceWaived: 'Sub-₹1 balance waived on deletion',
    payoutStatus: 'Current transaction status', bankReference: 'Bank/provider reference',
    txHash: 'TRC20 transaction hash', network: 'Deposit network', requestedUsdt: 'USDT requested', creditedUsdt: 'USDT credited', estimatedInr: 'Estimated INR value', adjustmentReason: 'Credit adjustment reason', reason: 'Reason',
    previousRate: 'Previous rate (INR/USDT)', newRate: 'New rate (INR/USDT)',
    trc20Configured: 'TRC20 address configured', financialRecordsPreserved: 'Financial records preserved',
    directProfileAndBankDataRemoved: 'Profile/bank data removed', previousConfigured: 'Support was configured',
    newConfigured: 'Support is configured'
  };
  function auditActionLabel(action) {
    const labels = {
      payout_requested: 'Customer requested an INR payout',
      payout_approved_processing: 'Payout approved and moved to Processing',
      payout_marked_success_after_reference: 'Payout marked Successful',
      payout_rejected_and_reserve_released: 'Payout rejected; reserved USDT released',
      payout_failed_and_reserve_released: 'Payout marked Failed; reserved USDT released',
      deposit_requested: 'Customer requested a USDT deposit',
      deposit_approved_manual_verification: 'USDT deposit approved',
      deposit_rejected: 'USDT deposit rejected',
      user_account_deleted: 'Customer account deleted',
      exchange_rate_and_trc20_address_updated: 'Rate / TRC20 settings updated',
      telegram_support_username_updated: 'Support Telegram updated'
    };
    return labels[action] || String(action || 'Audit event').replace(/_/g, ' ');
  }
  function auditDetailText(key, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (['payoutAmountInr', 'amountInr'].includes(key)) return money(value);
    if (['usdtReserved', 'amountUsdt', 'requestedUsdt', 'creditedUsdt', 'remainingDustUsdt'].includes(key)) return `${fmtUsdt(value, 6)} USDT`;
    if (key === 'remainingDustInrApprox') return money(value);
    if (key === 'payoutStatus') return statusText(value);
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  function renderAuditDetails(details) {
    const entries = Object.entries(details && typeof details === 'object' && !Array.isArray(details) ? details : {});
    if (!entries.length) return '<div class="settings-desc">No additional details.</div>';
    return `<div class="audit-details">${entries.map(([key, value]) => {
      const raw = typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value));
      const label = AUDIT_DETAIL_LABELS[key] || String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, char => char.toUpperCase());
      if (/tx.?hash|transaction.?hash/i.test(key) && raw) {
        return `<div class="audit-detail-row"><span class="audit-detail-label">${safe(label)}</span><code class="audit-detail-hash" title="${safe(raw)}">${safe(shortHash(raw))}</code><button class="admin-copy-btn" type="button" data-copy-value="${safe(raw)}" aria-label="Copy full ${safe(label)}">Copy hash</button></div>`;
      }
      return `<div class="audit-detail-row"><span class="audit-detail-label">${safe(label)}</span><span class="audit-detail-value">${safe(auditDetailText(key, value))}</span></div>`;
    }).join('')}</div>`;
  }
  function renderAuditEntry(entry) {
    const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
    const targetId = String(entry.targetId || '');
    const isPayout = Boolean(entry.payoutLinked) && /^PAY-/i.test(targetId);
    if (isPayout) {
      const isAdmin = entry.actorRole === 'admin';
      const actorLabel = isAdmin ? 'Admin' : 'Requester';
      const actorName = isAdmin
        ? (entry.adminName || entry.actorName || 'Unknown admin')
        : (entry.actorName || 'Unknown requester');
      const actorEmail = isAdmin ? (entry.adminEmail || entry.actorEmail || '') : (entry.actorEmail || '');
      const amount = details.payoutAmountInr ?? details.amountInr ?? 0;
      const accountNumber = details.accountNumber || details.accountLast4 || '—';
      const accountHolder = details.accountHolder || '—';
      return `<div class="settings-row audit-row audit-payout-row"><div class="settings-icon" aria-hidden="true">↗</div><div class="settings-content">
        <div class="settings-name">${safe(auditActionLabel(entry.action))}</div>
        <div class="audit-payout-meta"><span>${actorLabel}:</span> <strong>${safe(actorName)}</strong>${actorEmail ? ` <span>·</span> <span>${safe(actorEmail)}</span>` : ''}</div>
        ${isAdmin && entry.payoutOwnerName ? `<div class="audit-payout-meta"><span>Requested by:</span> <strong>${safe(entry.payoutOwnerName)}</strong>${entry.payoutOwnerEmail ? ` <span>·</span> <span>${safe(entry.payoutOwnerEmail)}</span>` : ''}</div>` : ''}
        <div class="audit-payout-meta">${safe(dateText(entry.createdAt))}</div>
        <div class="audit-payout-reference"><span>Transaction</span><code title="${safe(targetId)}">${safe(targetId)}</code></div>
        <div class="audit-payout-fields">
          <div class="audit-payout-field"><span>Account number</span><strong>${safe(accountNumber)}</strong></div>
          <div class="audit-payout-field"><span>Name</span><strong>${safe(accountHolder)}</strong></div>
          <div class="audit-payout-field"><span>Amount</span><strong>${safe(money(amount))}</strong></div>
        </div>
        <button type="button" class="transaction-slip-link audit-view-slip" data-view-admin-transaction="${safe(targetId)}" aria-label="View payout slip ${safe(targetId)}">View slip ↗</button>
      </div></div>`;
    }
    const isDeposit = Boolean(entry.depositLinked) && /^DEP-/i.test(targetId);
    if (isDeposit) {
      const isAdmin = entry.actorRole === 'admin';
      const actorLabel = isAdmin ? 'Reviewed by' : 'Requested by';
      const actorName = isAdmin ? (entry.adminName || entry.actorName || 'Unknown admin') : (entry.actorName || 'Deleted account');
      const actorEmail = isAdmin ? (entry.adminEmail || entry.actorEmail || '') : (entry.actorEmail || '');
      const requested = details.requestedUsdt ?? details.amountUsdt;
      const credited = details.creditedUsdt;
      const txHash = String(details.txHash || '');
      return `<div class="settings-row audit-row audit-payout-row"><div class="settings-icon" aria-hidden="true">₮</div><div class="settings-content">
        <div class="settings-name">${safe(auditActionLabel(entry.action))}</div>
        <div class="audit-payout-meta"><span>${actorLabel}:</span> <strong>${safe(actorName)}</strong>${actorEmail ? ` <span>·</span> <span>${safe(actorEmail)}</span>` : ''}</div>
        ${isAdmin ? `<div class="audit-payout-meta"><span>Customer:</span> <strong>${safe(entry.depositOwnerName || 'Unknown user')}</strong>${entry.depositOwnerEmail ? ` <span>·</span> <span>${safe(entry.depositOwnerEmail)}</span>` : ''}</div>` : ''}
        ${isAdmin && entry.payoutOwnerName ? `<div class="audit-payout-meta"><span>Requested by:</span> <strong>${safe(entry.payoutOwnerName)}</strong>${entry.payoutOwnerEmail ? ` <span>·</span> <span>${safe(entry.payoutOwnerEmail)}</span>` : ''}</div>` : ''}
        <div class="audit-payout-meta">${safe(dateText(entry.createdAt))}</div>
        <div class="audit-payout-reference"><span>Transaction</span><code title="${safe(targetId)}">${safe(targetId)}</code></div>
        <div class="audit-payout-fields">
          <div class="audit-payout-field"><span>Requested</span><strong>${requested == null ? '—' : `${safe(fmtUsdt(requested, 6))} USDT`}</strong></div>
          ${credited == null ? '' : `<div class="audit-payout-field"><span>Credited</span><strong>${safe(fmtUsdt(credited, 6))} USDT</strong></div>`}
        </div>
        ${txHash ? `<div class="audit-payout-reference"><span>TRC20 hash</span><code title="${safe(txHash)}">${safe(shortHash(txHash))}</code><button class="admin-copy-btn" type="button" data-copy-value="${safe(txHash)}" aria-label="Copy deposit transaction hash">Copy hash</button></div>` : ''}
        ${details.adjustmentReason ? `<div class="settings-desc">Adjustment: ${safe(details.adjustmentReason)}</div>` : ''}
      </div></div>`;
    }
    const actorLabel = entry.actorRole === 'user' ? 'User' : 'Admin';
    const actorName = entry.actorName || entry.adminName || (entry.actorRole === 'user' ? 'Deleted account' : 'Unknown admin');
    const actorEmail = entry.actorEmail || entry.adminEmail || '';
    return `<div class="settings-row audit-row"><div class="settings-icon">${entry.actorRole === 'user' ? '↗' : '✓'}</div><div class="settings-content"><div class="settings-name">${safe(auditActionLabel(entry.action))}</div><div class="settings-desc">${safe(actorLabel)}: ${safe(actorName)}${actorEmail ? ` · ${safe(actorEmail)}` : ''} · ${safe(dateText(entry.createdAt))}${entry.targetId ? ` · Transaction ${safe(entry.targetId)}` : ''}</div>${renderAuditDetails(details)}</div></div>`;
  }
  function toast(message, type = 'success') {
    const region = $('toastRegion'); if (!region) return;
    const node = document.createElement('div'); node.className = 'toast' + (type === 'error' ? ' error' : '');
    const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.textContent = type === 'error' ? '!' : '✓';
    const text = document.createElement('span'); text.textContent = String(message);
    node.append(icon, text); region.appendChild(node); setTimeout(() => node.remove(), 4200);
  }
  async function request(url, options = {}, retryCsrf = true) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Accept':'application/json', ...(options.headers || {}) };
    let body = options.body;
    if (body !== undefined && typeof body !== 'string') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    if (!['GET','HEAD','OPTIONS'].includes(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;
    const response = await fetch(url, { ...options, method, headers, body, credentials:'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // CSRF failures happen before a mutation reaches its route, so retrying once with a fresh token is safe.
      if (retryCsrf && response.status === 403 && /security token/i.test(data.error || '')) {
        await refreshCsrf();
        return request(url, options, false);
      }
      const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error;
    }
    if (data.csrfToken) csrfToken = data.csrfToken;
    return data;
  }
  async function refreshCsrf() {
    const response = await fetch('/api/auth/csrf', { credentials:'same-origin', cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Could not restore the CKXchange session (${response.status}).`); error.status = response.status; throw error; }
    csrfToken = data.csrfToken || '';
    return csrfToken;
  }
  function showAuth() {
    $('authOverlay').hidden = false; document.body.classList.remove('auth-restoring'); document.body.classList.add('auth-pending');
    $('authTitle').textContent = 'Sign in to CKXchange';
    const authCopy = $('authCopy'); if (authCopy) authCopy.textContent = 'Your account and transaction records are stored on the CKXchange server.';
    if ($('authRetryButton')) $('authRetryButton').hidden = true;
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
  }
  function showApplication() {
    $('authOverlay').hidden = true; document.body.classList.remove('auth-pending', 'auth-restoring');
    const admin = state.user?.role === 'admin';
    const desktopAdminNav = $('adminNav'); if (desktopAdminNav) desktopAdminNav.hidden = !admin;
    const mobileAdminNav = $('adminMobileNav'); if (mobileAdminNav) mobileAdminNav.hidden = !admin;
    $('mobile-bottom')?.classList.toggle('admin-view', admin);
    const mobile = document.querySelector('.mobile-bottom'); if (mobile) mobile.classList.toggle('admin-view', admin);
    $('profileMemberName').textContent = state.user?.name || 'CKXchange member';
    $('profileMemberEmail').textContent = state.user?.email || '';
    const profileId = $('profileMemberId'); if (profileId) profileId.textContent = state.user?.id || '—';
    const profileStatus = $('profileAccountStatus');
    if (profileStatus) { const active = String(state.user?.status || '').toLowerCase() === 'active'; profileStatus.textContent = active ? 'Active' : (state.user?.status || 'Unknown'); profileStatus.classList.toggle('is-inactive', !active); }
    const deletePanel = $('deleteAccountPanel'); if (deletePanel) deletePanel.hidden = admin;
    const miniName = document.querySelector('.mini-name'); if (miniName) miniName.textContent = state.user?.name || 'CKXchange member';
    const miniRole = document.querySelector('.mini-role'); if (miniRole) miniRole.textContent = admin ? 'Administrator' : 'Member';
    const initialAvatar = document.querySelector('#page-profile .avatar'); if (initialAvatar) initialAvatar.textContent = (state.user?.name || 'CX').split(/\s+/).slice(0,2).map(x => x[0] || '').join('').slice(0,2);
    const contactForm = $('contactSettingsForm');
    if (contactForm && contactForm.dataset.userId !== String(state.user?.id || '')) {
      $('telegramContactId').value = state.user?.telegramId || '';
      $('contactPhoneNumber').value = state.user?.phoneNumber || '';
      contactForm.dataset.userId = String(state.user?.id || '');
      $('contactSettingsStatus').textContent = 'Your details are private and used for account support only.';
    }
  }
  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    document.querySelectorAll('[data-auth-mode]').forEach(button => button.classList.toggle('active', button.dataset.authMode === authMode));
    $('authNameField').hidden = authMode !== 'register'; $('authConfirmField').hidden = authMode !== 'register';
    $('authName').required = authMode === 'register'; $('authConfirm').required = authMode === 'register';
    $('authPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    if (!document.body.classList.contains('auth-restoring')) $('authTitle').textContent = authMode === 'register' ? 'Create your account' : 'Sign in to CKXchange';
    $('authSubmit').textContent = authMode === 'register' ? 'Create account' : 'Sign in';
    $('authAlert').style.color = '#f0d49a';
    $('authAlert').textContent = authMode === 'register'
      ? 'Use a strong password. Registration creates a standard user account; admin rights are granted separately by the server operator.'
      : 'Test environment: deposits require manual verification and payouts require bank confirmation.';
  }
  function startPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
      if (!state.user || document.hidden) return;
      try {
        await refreshState({ quiet:true });
        await loadNotifications({ quiet:true }).catch(() => {});
        // If an admin role was revoked while this document was open, reload through the
        // role-aware server route so privileged markup is removed as well as API access denied.
        if ($('page-admin') && state.user?.role !== 'admin') {
          window.location.replace('/');
          return;
        }
        if (document.querySelector('#page-admin.active')) await loadAdmin();
      } catch (error) {
        if ((error.status === 401 || error.status === 403) && $('page-admin')) {
          window.location.replace('/');
          return;
        }
        if (error.status === 401) { state.user = null; showAuth(); setAuthMode('login'); }
      }
    }, 10000);
  }
  function updateOfflineState() {
    const banner = $('offlineBanner');
    if (banner) banner.hidden = navigator.onLine;
    if (!navigator.onLine && state.user) toast('You are offline. Financial actions need a live connection.', 'error');
  }
  function isPwaRunningInstalled() {
    const standalone = Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true || document.referrer.startsWith('android-app://'));
    if (standalone) return true;
    try { return localStorage.getItem(PWA_INSTALLED_STORAGE_KEY) === '1'; }
    catch (_) { return false; }
  }
  function rememberPwaInstalled() {
    pwaInstalled = true;
    try { localStorage.setItem(PWA_INSTALLED_STORAGE_KEY, '1'); } catch (_) {}
  }
  function renderPwaInstallButton() {
    const row = $('pwaInstallRow');
    const button = $('pwaInstallButton');
    if (!row || !button) return;
    pwaInstalled = pwaInstalled || isPwaRunningInstalled();
    row.hidden = pwaInstalled;
    button.textContent = deferredInstallPrompt ? 'Install app' : 'How to install';
  }
  async function installPwaFromProfile() {
    if (pwaInstalled || isPwaRunningInstalled()) { pwaInstalled = true; renderPwaInstallButton(); return; }
    if (!deferredInstallPrompt) {
      const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
      toast(isAppleMobile ? 'To install: open the Share menu in Safari and choose Add to Home Screen.' : 'To install: open your browser menu and choose Install app or Add to Home Screen.');
      return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    renderPwaInstallButton();
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') { rememberPwaInstalled(); toast('Installation started.'); }
      else toast('Installation was cancelled. You can install CKXchange later from the browser menu.');
    } catch (error) {
      console.warn('CKXchange install prompt failed:', error?.message || error);
      toast('Could not open the install prompt. Use your browser menu to install CKXchange.', 'error');
    }
    renderPwaInstallButton();
  }
  async function initializePwa() {
    updateOfflineState();
    pwaInstalled = isPwaRunningInstalled();
    renderPwaInstallButton();
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      renderPwaInstallButton();
    });
    window.addEventListener('appinstalled', () => {
      rememberPwaInstalled();
      deferredInstallPrompt = null;
      renderPwaInstallButton();
      toast('CKXchange has been installed.');
    });
    $('pwaInstallButton')?.addEventListener('click', installPwaFromProfile);
    window.addEventListener('online', updateOfflineState);
    window.addEventListener('offline', updateOfflineState);
    if (!('serviceWorker' in navigator)) return;
    try { pwaRegistration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' }); }
    catch (error) { console.warn('CKXchange service worker could not be registered:', error?.message || error); }
  }
  function renderNotificationSettings() {
    const prefs = state.notificationPrefs || {};
    const inApp = $('notificationsInAppEnabled');
    if (inApp) inApp.checked = prefs.inAppEnabled !== false;
    const pushButton = $('togglePushNotifications');
    if (pushButton) {
      pushButton.textContent = prefs.pushEnabled ? 'Disable browser push' : 'Enable browser push';
      pushButton.disabled = (!prefs.pushConfigured && !prefs.pushEnabled) || ((!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) && !prefs.pushEnabled);
    }
    const status = $('notificationPushStatus');
    if (!status) return;
    if (!prefs.pushConfigured && !prefs.pushEnabled) status.textContent = 'Browser push has not been configured on the server. In-app notifications work without push keys.';
    else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) status.textContent = prefs.pushEnabled ? 'A browser push subscription exists for this account but this browser cannot manage it here.' : 'This browser does not support Web Push. In-app notification history remains available.';
    else if (Notification.permission === 'denied' && !prefs.pushEnabled) status.textContent = 'Notifications are blocked in browser settings. Allow them for this website to enable push.';
    else if (prefs.pushEnabled && !prefs.pushConfigured) status.textContent = 'Push keys are missing on the server. Disable the existing subscription here; push delivery will resume after the keys are restored.';
    else if (prefs.pushEnabled) status.textContent = 'Browser push is enabled for this account. Use Disable to remove its registered push subscriptions.';
    else status.textContent = 'Browser push is optional. Tap Enable and approve the browser permission when prompted.';
  }
  function renderNotifications() {
    const count = Number(state.unreadNotifications || 0);
    const badge = $('notificationBellCount');
    if (badge) { badge.hidden = count < 1; badge.textContent = count > 99 ? '99+' : String(count); }
    const navBadge = $('notificationNavCount');
    if (navBadge) { navBadge.hidden = count < 1; navBadge.textContent = count > 99 ? '99+' : String(count); }
    const unreadLabel = $('notificationUnreadLabel');
    if (unreadLabel) unreadLabel.textContent = `${count} unread`;
    const profileUnread = $('profileUnreadCount');
    if (profileUnread) profileUnread.textContent = `${count} unread`;
    const list = $('notificationList');
    if (list) {
      if (state.notificationPrefs?.inAppEnabled === false) list.innerHTML = '<div class="notification-empty">In-app notification history is disabled. Turn it on above to view saved notifications.</div>';
      else if (!state.notifications.length) list.innerHTML = '<div class="notification-empty">You have no notifications yet.</div>';
      else list.innerHTML = state.notifications.map(item => `<button type="button" class="notification-item ${item.read ? 'read' : 'unread'}" data-notification-open="${safe(item.id)}"><span class="notification-unread-dot" aria-hidden="true"></span><span class="notification-item-content"><span class="notification-item-title">${safe(item.title)}</span><span class="notification-item-body">${safe(item.body)}</span><span class="notification-item-date">${safe(dateText(item.createdAt))}${item.read ? ' · Read' : ' · Unread'}</span></span></button>`).join('');
    }
    const mark = $('markAllNotificationsRead');
    if (mark) mark.disabled = count < 1;
    renderNotificationSettings();
  }
  async function loadNotifications({ quiet = false } = {}) {
    if (!state.user || notificationLoadPending) return;
    notificationLoadPending = true;
    try {
      const prefs = await request('/api/notifications/preferences');
      const result = await request('/api/notifications');
      state.notificationPrefs = { ...prefs, inAppEnabled: result.inAppEnabled !== false && prefs.inAppEnabled !== false };
      state.notifications = result.notifications || [];
      state.unreadNotifications = Number(result.unreadCount || 0);
      renderNotifications();
    } catch (error) {
      if (!quiet) toast(error.message || 'Could not load notifications.', 'error');
      throw error;
    } finally { notificationLoadPending = false; }
  }
  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  }
  async function togglePushNotifications() {
    if (!state.user) return;
    try {
      if (state.notificationPrefs.pushEnabled) {
        if (!confirm('Disable browser push notifications for this account on all registered devices?')) return;
        await request('/api/notifications/unsubscribe', { method: 'POST', body: {} });
        if (pwaRegistration) {
          const subscription = await pwaRegistration.pushManager.getSubscription().catch(() => null);
          if (subscription) await subscription.unsubscribe().catch(() => false);
        }
        toast('Browser push notifications disabled.');
        await loadNotifications({ quiet: true });
        return;
      }
      if (!pwaRegistration && 'serviceWorker' in navigator) pwaRegistration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
      const keyInfo = await request('/api/notifications/push-public-key');
      if (!keyInfo.configured || !keyInfo.publicKey) throw new Error('Browser push is not configured on the server yet. Set the VAPID environment variables first.');
      if (!('Notification' in window) || !pwaRegistration?.pushManager) throw new Error('This browser does not support push notifications.');
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Browser notification permission was not granted. You can still use in-app notifications.');
      let subscription = await pwaRegistration.pushManager.getSubscription();
      if (!subscription) subscription = await pwaRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(keyInfo.publicKey) });
      await request('/api/notifications/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
      toast('Browser push notifications enabled.');
      await loadNotifications({ quiet: true });
    } catch (error) { toast(error.message || 'Could not update push notification settings.', 'error'); }
  }
  async function openNotification(item) {
    try {
      if (!item.read) await request(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST', body: {} });
      await loadNotifications({ quiet: true });
    } catch (error) { toast(error.message || 'Could not update notification.', 'error'); }
    if (item.route === '/admin/deposits' && state.user?.role === 'admin') {
      if (state.user?.role !== 'admin') return;
      go('admin', false);
      setAdminSubPage('deposits', { historyMode: 'push' });
    } else go('home');
  }

  function renderSupportContact(username) {
    const clean = String(username || '').replace(/^@/, '');
    const valid = /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(clean);
    state.supportUsername = valid ? clean : '';
    const link = $('supportTelegramLink');
    const label = $('supportUsernameValue');
    const fallback = $('supportNotConfigured');
    if (link) { link.hidden = !valid; link.href = valid ? `https://t.me/${clean}` : '#'; }
    if (label) { label.hidden = !valid; label.textContent = valid ? `@${clean}` : ''; }
    if (fallback) { fallback.hidden = valid; fallback.textContent = valid ? '' : 'Customer support is not configured yet.'; }
  }
  async function loadSupportContact() {
    try { const result = await request('/api/support'); renderSupportContact(result.telegramUsername || ''); }
    catch (_) { renderSupportContact(''); }
  }

  let initializeRunning = false;
  async function initialize() {
    if (initializeRunning) return;
    initializeRunning = true;
    const retryButton = $('authRetryButton');
    if (retryButton) retryButton.hidden = true;
    $('authOverlay').hidden = false;
    document.body.classList.add('auth-pending', 'auth-restoring');
    $('authTitle').textContent = 'Restoring your session…';
    $('authCopy').textContent = 'Checking your saved sign-in securely. Please wait a moment.';
    try {
      let auth;
      // Serverless cold starts / temporary Atlas delay should not expose the sign-in form
      // while the existing cookie may still be valid.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await refreshCsrf();
          auth = await request('/api/auth/me');
          break;
        } catch (error) {
          if (error.status === 401 || attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      state.user = auth.user;
      showApplication();
      await refreshState({ quiet:true });
      await loadSupportContact();
      await loadNotifications({ quiet: true }).catch(() => {});
      const wantsAdmin = requestedAdminPage();
      const desired = wantsAdmin && state.user.role === 'admin' ? 'admin' : 'home';
      go(desired, false);
      if (desired === 'admin' && !isAdminPath()) history.replaceState({ adminSubPage: 'overview' }, '', '/admin');
      else if (wantsAdmin) { history.replaceState({}, '', '/'); toast('Admin access is restricted to administrator accounts.', 'error'); }
      startPolling();
    } catch (error) {
      // If an admin document was loaded but the session is no longer valid, reload the
      // customer route so the server sends the sanitized non-admin shell.
      if (error.status === 401 && $('page-admin')) { window.location.replace('/'); return; }
      if (error.status === 401) {
        showAuth();
      } else {
        // Do not turn a temporary network / server error into a misleading logout.
        document.body.classList.add('auth-pending', 'auth-restoring');
        $('authOverlay').hidden = false;
        $('authTitle').textContent = 'Unable to restore your session';
        $('authCopy').textContent = 'CKXchange could not verify your sign-in. Check your connection and retry; your account has not been signed out.';
        if (retryButton) retryButton.hidden = false;
        const authAlert = $('authAlert'); if (authAlert) authAlert.textContent = error.message || 'The server is temporarily unavailable.';
      }
    } finally {
      initializeRunning = false;
    }
  }
  async function refreshState({ quiet = false } = {}) {
    const response = await request('/api/state');
    state.user = response.user; state.rate = response.rate || RATE_DEFAULT;
    state.balance = Number(response.user.availableUsdt || 0); state.reservedUsdt = Number(response.user.reservedUsdt || 0);
    state.banks = response.banks || []; state.transactions = response.transactions || [];
    if (!document.body.classList.contains('auth-pending')) showApplication();
    renderAll();
    if (currentReceipt) { const latest = state.transactions.find(t => t.id === currentReceipt.id); if (latest && latest.status !== currentReceipt.status) { currentReceipt = { ...latest, account: currentReceipt.account || latest.account }; renderReceiptDetails(currentReceipt); } }
    return response;
  }
  function setAdminSubPage(route, { historyMode = 'none', load = true } = {}) {
    const subpage = ADMIN_SUBPAGES.includes(route) ? route : 'overview';
    if (activeAdminSubPage !== subpage) expandedAdminRequestKey = '';
    activeAdminSubPage = subpage;
    document.querySelectorAll('[data-admin-subpage]').forEach(section => { section.hidden = section.dataset.adminSubpage !== subpage; });
    document.querySelectorAll('[data-admin-route]').forEach(link => link.classList.toggle('active', link.dataset.adminRoute === subpage));
    const meta = ADMIN_META[subpage];
    $('pageEyebrow').textContent = meta[0]; $('pageTitle').textContent = meta[1]; $('pageSubtitle').textContent = meta[2];
    if (historyMode === 'push') history.pushState({ adminSubPage: subpage }, '', adminPathFor(subpage));
    else if (historyMode === 'replace') history.replaceState({ adminSubPage: subpage }, '', adminPathFor(subpage));
    if (load) loadAdmin().catch(error => {
      if (error.status === 401 || error.status === 403) {
        if ($('page-admin')) { window.location.replace('/'); return; }
        if (error.status === 401) { state.user = null; history.replaceState({}, '', '/'); showAuth(); setAuthMode('login'); }
        else toast('Administrator access is required.', 'error');
      } else toast(error.message, 'error');
    });
  }
  function go(page, push = true) {
    if (page === 'bankreturn') page = addBankReturnPage;
    if (!PAGE_META[page]) return;
    if (page === 'admin' && state.user?.role !== 'admin') { toast('Administrator access is required.', 'error'); return; }
    const currentPage = document.querySelector('.page.active')?.id.replace(/^page-/, '');
    if (page === 'addbank' && (currentPage === 'send' || currentPage === 'banks')) addBankReturnPage = currentPage;
    document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
    const activeNavPage = page === 'password' ? 'profile' : page;
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === activeNavPage));
    if (page === 'admin') {
      const route = isAdminPath() ? adminSubPageFromPath() : 'overview';
      setAdminSubPage(route, { historyMode: push ? 'replace' : 'none' });
    } else {
      const [eyebrow, title, subtitle] = PAGE_META[page];
      $('pageEyebrow').textContent = eyebrow; $('pageTitle').textContent = title; $('pageSubtitle').textContent = subtitle;
      if (page === 'send') refreshSendPage();
      if (page === 'banks') renderBanks();
      if (page === 'addbank') $('addBankSavedCount').textContent = `${state.banks.length} saved account${state.banks.length === 1 ? '' : 's'}`;
      if (page === 'recharge') { updateDepositEstimate(); updateDepositAddress(); }
      if (push) history.replaceState({}, '', '/');
    }
    window.scrollTo({ top:0, behavior:'smooth' });
  }
  function bankSymbol(bank) {
    const words = String(bank || 'Bank').split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'B').slice(0,2)).toUpperCase();
  }
  function renderBanks() {
    const emptySend = `<div class="saved-bank-empty"><p>No saved bank accounts. Add an account to use it for a payout request.</p><button class="secondary-btn full" type="button" data-go="addbank">Add bank account</button></div>`;
    const sendList = $('sendBankList');
    if (!state.banks.length) sendList.innerHTML = emptySend;
    else sendList.innerHTML = state.banks.map(b => `<div class="saved-bank-row"><div class="bank-logo">${safe(bankSymbol(b.bank))}</div><div class="bank-info"><div class="bank-name">${safe(b.holder)}</div><div class="bank-holder">Account ending ${safe(b.last4 || String(b.account).slice(-4))}</div></div><button class="delete-bank-btn" type="button" data-remove-bank="${safe(b.id)}" aria-label="Remove ${safe(b.holder)} account ending ${safe(b.last4)}" title="Remove bank account"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`).join('');
    const managementList = $('managementBankList');
    if (managementList) {
      if (!state.banks.length) managementList.innerHTML = `<div class="saved-bank-empty"><p>You have no linked bank accounts yet. Add one to make it available on Send INR.</p><button class="primary-btn" type="button" data-go="addbank">+ Add bank account</button></div>`;
      else managementList.innerHTML = state.banks.map(b => `<div class="saved-bank-row"><div class="bank-logo">${safe(bankSymbol(b.bank))}</div><div class="bank-info"><div class="bank-name">${safe(b.holder)}</div><div class="bank-holder">${safe(b.bank)} · ${safe(b.branch)}</div><div class="bank-number">Account ${safe(masked(b.account))}</div><div class="bank-holder">IFSC: ${safe(b.ifsc)}</div></div><button class="delete-bank-btn" type="button" data-remove-bank="${safe(b.id)}" aria-label="Remove ${safe(b.holder)} account ending ${safe(b.last4)}" title="Delete bank account"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`).join('');
    }
    const select = $('sendBank'); const selected = select.value;
    select.innerHTML = '<option value="">Select an account holder</option>' + state.banks.map(b => `<option value="${safe(b.id)}">${safe(b.holder)} · •••• ${safe(b.last4 || String(b.account).slice(-4))}</option>`).join('');
    if (state.banks.some(b => b.id === selected)) select.value = selected;
    $('addBankSavedCount').textContent = `${state.banks.length} saved account${state.banks.length === 1 ? '' : 's'}`;
  }
  function statusBadge(status) { return `<span class="status-tag ${statusClass(status)}">${safe(statusText(status))}</span>`; }
  function adminCopyIcon(value, label) {
    const raw = String(value ?? '');
    if (!raw) return '';
    return `<button class="admin-copy-icon" type="button" data-copy-value="${safe(raw)}" aria-label="Copy ${safe(label)}" title="Copy ${safe(label)}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="1.7"/></svg></button>`;
  }
  function adminRequestField(label, value, copyValue = '', valueClass = '') {
    return `<div class="admin-request-field"><span>${safe(label)}</span><div class="admin-request-value ${valueClass}"><strong>${value}</strong>${copyValue ? adminCopyIcon(copyValue, label) : ''}</div></div>`;
  }
  function adminRequestSummaryLine(label, value, valueClass = '') {
    return `<span class="admin-request-summary-line"><span>${safe(label)}</span><strong class="${valueClass}">${value}</strong></span>`;
  }
  function adminRequestChevron() {
    return '<svg class="admin-request-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  function renderAdminDepositRequest(t) {
    const requested = Number(t.requestedUsdt ?? t.usdt ?? 0);
    const hash = String(t.txHash || 'Not provided');
    const key = `deposit:${t.id}`;
    const expanded = expandedAdminRequestKey === key;
    const actions = `<div class="admin-actions"><button class="primary-btn" data-admin-action="deposit-approve" data-id="${safe(t.id)}" data-requested-usdt="${safe(requested)}">Verify &amp; credit</button><button class="danger-btn" data-admin-action="deposit-reject" data-id="${safe(t.id)}">Reject</button></div>`;
    return `<article class="admin-request-card admin-deposit-request${expanded ? ' is-expanded' : ''}">
      <button class="admin-request-summary" type="button" data-toggle-admin-request="${safe(key)}" aria-expanded="${expanded}" aria-controls="admin-request-details-${safe(t.id)}">
        <span class="admin-request-summary-top"><strong class="admin-request-user">${safe(t.userName || 'Unknown user')}</strong>${statusBadge(t.status)}</span>
        ${adminRequestSummaryLine('Amount', `<span class="admin-request-amount-usdt">$${safe(fmtUsdt(requested, 6))} USDT</span>`)}
        ${adminRequestSummaryLine('Date', safe(dateText(t.timestamp)))}
        <span class="admin-request-summary-bottom"><code>DEP ID · ${safe(t.id)}</code><span class="admin-request-expand-label">${expanded ? 'Hide details' : 'View details'} ${adminRequestChevron()}</span></span>
      </button>
      <div class="admin-request-details" id="admin-request-details-${safe(t.id)}" ${expanded ? '' : 'hidden'}>
        <div class="admin-request-fields">
          ${adminRequestField('User', safe(t.userName || 'Unknown user'))}
          ${adminRequestField('Transaction hash', `<code class="admin-request-code" title="${safe(hash)}">${safe(hash)}</code>`, t.txHash || '', 'hash')}
          ${adminRequestField('Requested amount', `$${safe(fmtUsdt(requested, 6))} USDT`)}
          ${adminRequestField('Created time', safe(dateText(t.timestamp)))}
          ${adminRequestField('DEP ID', `<code>${safe(t.id)}</code>`)}
        </div>${actions}
      </div>
    </article>`;
  }
  function renderAdminPayoutRequest(t) {
    const actionButtons = `${t.status === 'pending' ? `<button class="primary-btn" data-admin-action="payout-approve" data-id="${safe(t.id)}">Approve</button>` : ''}${t.status === 'processing' ? `<button class="primary-btn" data-admin-action="payout-complete" data-id="${safe(t.id)}">Mark successful</button><button class="secondary-btn" data-admin-action="payout-fail" data-id="${safe(t.id)}">Mark failed</button>` : ''}<button class="danger-btn" data-admin-action="payout-reject" data-id="${safe(t.id)}">Reject</button>`;
    const amountValue = `<span>${safe(money(t.amount))}</span><small>$${safe(fmtUsdt(t.usdt, 6))} USDT reserved</small>`;
    const account = String(t.account || masked(t.last4));
    const key = `payout:${t.id}`;
    const expanded = expandedAdminRequestKey === key;
    return `<article class="admin-request-card admin-payout-request${expanded ? ' is-expanded' : ''}">
      <button class="admin-request-summary" type="button" data-toggle-admin-request="${safe(key)}" aria-expanded="${expanded}" aria-controls="admin-request-details-${safe(t.id)}">
        <span class="admin-request-summary-top"><strong class="admin-request-user">${safe(t.userName || 'Unknown user')}</strong>${statusBadge(t.status)}</span>
        ${adminRequestSummaryLine('Amount (INR)', safe(money(t.amount)))}
        ${adminRequestSummaryLine('Account name', safe(t.holder || '—'))}
        ${adminRequestSummaryLine('Date', safe(dateText(t.timestamp)))}
        <span class="admin-request-summary-bottom"><code>PAY ID · ${safe(t.id)}</code><span class="admin-request-expand-label">${expanded ? 'Hide details' : 'View details'} ${adminRequestChevron()}</span></span>
      </button>
      <div class="admin-request-details" id="admin-request-details-${safe(t.id)}" ${expanded ? '' : 'hidden'}>
        <div class="admin-request-fields">
          ${adminRequestField('Amount (INR)', amountValue)}
          ${adminRequestField('Account number', safe(account), t.account || '')}
          ${adminRequestField('Account name', safe(t.holder || '—'), t.holder || '')}
          ${adminRequestField('IFSC code', safe(t.ifsc || '—'), t.ifsc || '')}
          ${adminRequestField('Created time', safe(dateText(t.timestamp)))}
          ${adminRequestField('PAY ID', `<code>${safe(t.id)}</code>`)}
        </div><div class="admin-actions">${actionButtons}</div>
      </div>
    </article>`;
  }
  function renderRateDisplays() {
    const formatted = money(state.rate);
    if ($('sidebarRateValue')) $('sidebarRateValue').textContent = formatted;
    if ($('homeRateNote')) $('homeRateNote').textContent = `1 USDT = ${formatted} · configured estimate`;
  }
  function renderTransactions() {
    renderRateDisplays();
    const payouts = state.transactions.filter(t => t.type === 'payout' && t.status === 'success');
    const total = payouts.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const usdt = payouts.reduce((sum, t) => sum + Number(t.usdt || 0), 0);
    $('historyCount').textContent = payouts.length.toLocaleString('en-IN');
    $('historyTotal').textContent = money(total).replace(/\.00$/, ''); $('historyUsdt').textContent = fmtUsdt(usdt, 4);
    $('profileBanks').textContent = state.banks.length.toLocaleString('en-IN');
    $('profileBalance').textContent = fmtUsdt(state.balance, 4);
    $('profileReservedBalance').textContent = fmtUsdt(state.reservedUsdt, 4);
    $('homeUsdt').textContent = fmtUsdt(state.balance, 4);
    $('homeInr').textContent = money(state.balance * state.rate); $('rechargeCurrent').textContent = fmtUsdt(state.balance,4);
    const activePage = document.querySelector('.page.active')?.id.replace('page-','') || 'home';
    $('pageSubtitle').textContent = (activePage === 'admin' ? ADMIN_META[activeAdminSubPage] : PAGE_META[activePage])?.[2] || '';
    const recent = [...state.transactions].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0,4);
    $('recentActivity').innerHTML = recent.length ? recent.map(t => {
      const isPayout = t.type === 'payout'; const title = isPayout ? 'INR payout' : 'USDT deposit request';
      const desc = isPayout ? `${safe(t.bank || 'Saved bank')} · ${safe(dateText(t.timestamp))}` : `${safe(t.network || 'USDT')} · ${safe(dateText(t.timestamp))}`;
      const amount = isPayout ? `−${money(t.amount)}` : `+${fmtUsdt(t.usdt, 4)} USDT requested`;
      const subAmount = isPayout ? `Reserved ${fmtUsdt(t.usdt,4)} USDT` : `Claimed value ${money(t.amount)}`;
      return `<div class="activity-item"><div class="activity-icon" style="color:${t.status==='success'?'var(--green)':t.status==='pending'?'#f0c477':'#a4baff'}">${isPayout ? '↗' : '₮'}</div><div class="activity-content"><div class="activity-title">${title}</div><div class="activity-sub">${desc}</div>${statusBadge(t.status)}</div><div class="activity-amount"><div class="activity-inr">${amount}</div><div class="activity-usdt">${subAmount}</div></div></div>`;
    }).join('') : `<div class="empty-state"><div class="empty-title">Nothing here just yet</div><div class="empty-desc">Submit a USDT deposit request or an INR payout request to create activity.</div></div>`;
    renderHistoryTable();
  }
  function renderHistoryTable() {
    const filter = $('historyFilter').value;
    let txs = [...state.transactions].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (filter !== 'all') txs = txs.filter(t => t.type === filter);
    $('historyCaption').textContent = `${txs.length} record${txs.length === 1 ? '' : 's'} · statuses update after review`;
    $('historyRows').innerHTML = txs.map(t => {
      const isPayout = t.type === 'payout';
      const rawId = String(t.id || '—');
      const shortId = rawId.length > 14 ? `${rawId.slice(0, 8)}…${rawId.slice(-4)}` : rawId;
      const transactionRef = isPayout ? `<div class="table-sub history-transaction-id"><span title="${safe(rawId)}">${safe(shortId)}</span><button type="button" class="transaction-slip-link" data-view-transaction="${safe(t.id)}" aria-label="View payout slip ${safe(t.id)}">View slip ↗</button></div>` : `<div class="table-sub history-transaction-id" title="${safe(rawId)}">${safe(shortId)}</div>`;
      const amount = isPayout ? `−${money(t.amount)}` : `+${money(t.amount)}`;
      const amountLabel = isPayout ? 'INR payout' : 'Estimated INR';
      const time = new Intl.DateTimeFormat('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(t.timestamp));
      return `<tr><td><div class="table-main">${isPayout ? 'INR payout' : 'USDT deposit'}</div>${transactionRef}<div class="table-sub history-transaction-date">${safe(dateShort(t.timestamp))} · ${safe(time)}</div>${t.rejectionReason ? `<div class="table-sub">Reason: ${safe(t.rejectionReason)}</div>` : ''}</td><td><div class="table-main">${amount}</div><div class="table-sub">${amountLabel}</div></td><td>${statusBadge(t.status)}</td></tr>`;
    }).join('');
    $('historyEmpty').style.display = txs.length ? 'none' : 'block';
    document.querySelector('.history-wrap').style.display = txs.length ? 'block' : 'none';
  }
  function renderAll() { renderBanks(); renderTransactions(); updateSendEstimate(); updateDepositEstimate(); }
  function refreshSendPage() { renderBanks(); updateSendEstimate(); }
  const MAX_PAYOUT_INR = 100_000;
  function maxPayoutAmountInr() {
    const availableMicro = Math.max(0, Math.round((Number(state.balance) || 0) * 1_000_000));
    if (!Number.isFinite(state.rate) || state.rate <= 0 || availableMicro <= 0) return 0;
    let paise = Math.min(MAX_PAYOUT_INR * 100, Math.max(0, Math.floor((availableMicro / 1_000_000) * state.rate * 100 + 1e-8)));
    // Keep the rounded rupee amount within the exact available micro-USDT balance,
    // matching the server's ceiling conversion before reserving funds.
    while (paise > 0 && Math.ceil((paise / 100 / state.rate) * 1_000_000 - 1e-9) > availableMicro) paise -= 1;
    return paise / 100;
  }
  function updateSendEstimate() {
    const raw = $('sendAmount').value.trim(); const amount = Number(raw); const available = Math.max(0, state.balance * state.rate);
    const status = $('sendAmountStatus'); const remaining = $('sendRemainingInr');
    if (!raw || !Number.isFinite(amount) || amount <= 0) { remaining.textContent='—'; status.className='lookup-status'; status.textContent=`Minimum withdrawal is ₹1,000; maximum is ₹${money(MAX_PAYOUT_INR)} per request. Available payout value: ${money(available)}.`; return; }
    if (amount < 1000) { remaining.textContent=money(Math.max(0, available - amount)); status.className='lookup-status error'; status.textContent='Minimum withdrawal is ₹1,000.'; return; }
    if (amount > MAX_PAYOUT_INR) { remaining.textContent='Over per-request limit'; status.className='lookup-status error'; status.textContent=`Maximum payout per request is ${money(MAX_PAYOUT_INR)}.`; return; }
    if (amount > available + 1e-7) { remaining.textContent='Insufficient balance'; status.className='lookup-status error'; status.textContent=`This exceeds your available payout value of ${money(available)}.`; return; }
    remaining.textContent = money(Math.max(0, available - amount)); status.className='lookup-status success'; status.textContent=`Available payout value: ${money(available)}. Maximum per request: ${money(MAX_PAYOUT_INR)}.`;
  }
  function updateDepositEstimate() {
    const amount = Math.max(0, Number($('depositAmount')?.value) || 0);
    if ($('depositEstUsdt')) $('depositEstUsdt').textContent = `${fmtUsdt(amount, 6)} USDT`;
    if ($('depositEstInr')) $('depositEstInr').textContent = money(amount * state.rate);
    const validAmount = amount >= 10;
    const hint = $('depositMinimumHint');
    if (hint) { hint.className = `lookup-status${amount > 0 && !validAmount ? ' error' : ''}`; hint.textContent = validAmount ? 'Minimum deposit met.' : 'Minimum deposit is 10 USDT.'; }
    const submit = $('depositSubmit');
    if (submit) submit.disabled = !networkConfig.depositConfigured || !validAmount;
  }
  async function updateDepositAddress() {
    const network = $('depositNetwork').value;
    const requestVersion = ++depositAddressRequestVersion;
    try {
      const config = await request(`/api/config?network=${encodeURIComponent(network)}`);
      if (requestVersion !== depositAddressRequestVersion) return;
      networkConfig = config;
      if (Number.isFinite(Number(config.rate)) && Number(config.rate) > 0) { state.rate = Number(config.rate); renderRateDisplays(); updateDepositEstimate(); updateSendEstimate(); }
      $('depositAddressText').textContent = config.depositAddress || 'No receiving address configured';
      $('copyDepositAddress').disabled = !config.depositAddress;
      $('depositSubmit').disabled = !config.depositConfigured || Number($('depositAmount').value) < 10;
      $('depositAddressStatus').className = 'lookup-status ' + (config.depositConfigured ? 'success' : 'error');
      $('depositAddressStatus').textContent = config.depositConfigured ? 'Check that the address and network match before sending any assets.' : `Deposits are disabled on ${network} until an authorized receiving address is configured.`;
    } catch (error) {
      if (requestVersion !== depositAddressRequestVersion) return;
      networkConfig = { depositAddress:'', depositConfigured:false };
      $('depositAddressText').textContent = 'Address lookup unavailable'; $('copyDepositAddress').disabled = true; $('depositSubmit').disabled = true;
      $('depositAddressStatus').className='lookup-status error'; $('depositAddressStatus').textContent=error.message;
    }
  }
  function ifscClear(message = 'Enter a valid IFSC code to fetch the bank and branch details automatically.') {
    $('bankName').value = ''; $('branchName').value = ''; $('ifscStatus').className='lookup-status'; $('ifscStatus').textContent=message; $('saveBankBtn').disabled=true;
  }
  async function lookupIfsc(code) {
    const version = ++ifscRequestVersion; const cleaned = code.trim().toUpperCase(); $('ifscCode').value=cleaned;
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleaned)) { ifscClear(cleaned.length < 11 ? 'Enter all 11 characters to look up the branch.' : 'IFSC format should look like ABCD0123456.'); return; }
    $('ifscStatus').className='lookup-status loading'; $('ifscStatus').textContent='Looking up bank and branch…'; $('saveBankBtn').disabled=true;
    try {
      const response = await fetch(`https://ifsc.razorpay.com/${encodeURIComponent(cleaned)}`, { headers:{'Accept':'application/json'}, signal:AbortSignal.timeout(6000) });
      if (version !== ifscRequestVersion) return;
      if (!response.ok) throw new Error(response.status === 404 ? 'IFSC code not found. Please check the code.' : 'IFSC lookup failed. Please try again.');
      const data=await response.json(); if(version !== ifscRequestVersion) return;
      const bank=String(data.BANK||'').trim(); const branch=String(data.BRANCH||'').trim();
      if(!bank||!branch) throw new Error('The API returned incomplete bank details.');
      $('bankName').value=bank; $('branchName').value=branch; $('ifscStatus').className='lookup-status success'; $('ifscStatus').textContent=`✓ Verified: ${bank} · ${branch}`; validateBankForm();
    } catch(error) { if(version !== ifscRequestVersion) return; $('ifscStatus').className='lookup-status error'; $('ifscStatus').textContent=error.message||'Could not reach the IFSC API.'; $('bankName').value=''; $('branchName').value=''; $('saveBankBtn').disabled=true; }
  }
  function validHolderName(value) { const holder=String(value||'').trim(); return holder.replace(/[^\p{L}]/gu,'').length>=2 && /^[\p{L}][\p{L}\s.'-]*$/u.test(holder) && holder === holder.toLocaleUpperCase('en-IN'); }
  function validateBankForm() {
    const holder=$('holderName').value.trim(); const account=$('accountNumber').value.trim(); const ifsc=$('ifscCode').value.trim();
    const okay=validHolderName(holder) && /^\d{6,24}$/.test(account) && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) && !!$('bankName').value && !!$('branchName').value;
    $('saveBankBtn').disabled=!okay; return okay;
  }
  function roundedRect(ctx,x,y,w,h,r) { const radius=Math.min(r,w/2,h/2); ctx.beginPath(); ctx.moveTo(x+radius,y); ctx.arcTo(x+w,y,x+w,y+h,radius); ctx.arcTo(x+w,y+h,x,y+h,radius); ctx.arcTo(x,y+h,x,y,radius); ctx.arcTo(x,y,x+w,y,radius); ctx.closePath(); }
  function createReceiptCanvas(t) {
    const status = t.status || 'pending';
    const statusPalette = {
      success: { strong:'#087b59', soft:'#d9f7eb', label:'Successful' },
      pending: { strong:'#936116', soft:'#fff0cf', label:'Pending' },
      processing: { strong:'#2368ad', soft:'#deefff', label:'Processing' },
      rejected: { strong:'#b43c58', soft:'#ffe3e9', label:'Rejected' },
      failed: { strong:'#b43c58', soft:'#ffe3e9', label:'Failed' }
    };
    const palette = statusPalette[status] || statusPalette.pending;
    const rows = [
      ['TRANSACTION ID',t.id || '—'],
      ['DATE & TIME',dateText(t.timestamp)],
      ['ACCOUNT HOLDER',t.holder || '—'],
      ['BANK',t.bank || '—'],
      ['BRANCH',t.branch || '—'],
      ['ACCOUNT NUMBER',String(t.account || '—')],
      ['IFSC CODE',t.ifsc || '—'],
      ['STATUS',palette.label]
    ];
    if (t.bankReference) rows.push(['BANK REFERENCE',t.bankReference]);
    if (t.rejectionReason) rows.push(['REASON',t.rejectionReason]);

    const width = 1254;
    const panelY = 565;
    const rowHeight = 76;
    const panelHeight = rows.length * rowHeight + 42;
    const height = panelY + panelHeight + 75;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const background = ctx.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#d8ccff');
    background.addColorStop(.48, '#eaf4ff');
    background.addColorStop(1, '#f4dafa');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    // Soft pastel light pools, matching the supplied fixed receipt reference.
    const glowA = ctx.createRadialGradient(220, 160, 12, 220, 160, 560);
    glowA.addColorStop(0, 'rgba(255,255,255,.82)');
    glowA.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, width, height);
    const glowB = ctx.createRadialGradient(1070, 950, 20, 1070, 950, 540);
    glowB.addColorStop(0, 'rgba(255,255,255,.48)');
    glowB.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glowB;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.shadowColor = 'rgba(104,83,165,.16)';
    ctx.shadowBlur = 28;
    ctx.strokeStyle = 'rgba(255,255,255,.88)';
    ctx.lineWidth = 4;
    roundedRect(ctx, 48, 48, width - 96, height - 96, 48);
    ctx.stroke();
    ctx.restore();

    // A calm centered success/status mark and receipt heading.
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath(); ctx.arc(width/2, 172, 104, 0, Math.PI*2); ctx.fill();
    const markGradient = ctx.createLinearGradient(0, 80, 0, 270);
    markGradient.addColorStop(0, status === 'success' ? '#a0f8d8' : palette.soft);
    markGradient.addColorStop(1, status === 'success' ? '#55e5b5' : '#c9b8ff');
    ctx.fillStyle = markGradient;
    ctx.beginPath(); ctx.arc(width/2, 172, 78, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.76)'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.arc(width/2, 172, 91, 0, Math.PI*2); ctx.stroke();
    ctx.fillStyle = status === 'success' ? '#07563f' : palette.strong;
    ctx.font = '700 94px Arial';
    ctx.fillText(status === 'success' ? '✓' : status === 'pending' ? '…' : status === 'processing' ? '↻' : '!', width/2, 205);
    // Small celebratory strokes are part of the receipt, not theme-dependent.
    const confetti = ['#59a7f3','#51cdb1','#9d69ef','#58c6b4'];
    const marks = [[510,135,-1],[744,130,1],[490,205,-1],[765,196,1]];
    marks.forEach(([x,y,d],i)=>{ ctx.save(); ctx.translate(x,y); ctx.rotate(d*.55); ctx.strokeStyle=confetti[i]; ctx.lineWidth=9; ctx.lineCap='round'; ctx.beginPath(); ctx.moveTo(-8,0); ctx.lineTo(8,0); ctx.stroke(); ctx.restore(); });

    ctx.fillStyle = '#111027';
    ctx.font = '700 53px Arial';
    ctx.fillText(`Payout ${palette.label}`, width/2, 340);
    ctx.fillStyle = '#77719e';
    ctx.font = '500 27px Arial';
    ctx.fillText('INR payout request receipt', width/2, 390);

    // Amount in its own translucent pill.
    ctx.save();
    ctx.shadowColor = 'rgba(122,94,190,.10)'; ctx.shadowBlur = 18;
    const amountGradient = ctx.createLinearGradient(350, 420, 900, 520);
    amountGradient.addColorStop(0, 'rgba(255,255,255,.76)');
    amountGradient.addColorStop(1, 'rgba(255,255,255,.56)');
    ctx.fillStyle = amountGradient;
    roundedRect(ctx, 344, 423, 566, 112, 40); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.86)'; ctx.lineWidth=3; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#111027'; ctx.font = '700 66px Arial';
    ctx.textAlign = 'center'; ctx.fillText(money(t.amount), width/2, 499);

    // White glass transaction panel with pastel icon tiles and aligned values.
    ctx.save();
    ctx.shadowColor = 'rgba(111,89,164,.12)'; ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    roundedRect(ctx, 98, panelY, width - 196, panelHeight, 34); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();

    let y = panelY + 58;
    rows.forEach(([label,value], index) => {
      ctx.textAlign='left'; ctx.fillStyle='#716a9b'; ctx.font='600 21px Arial'; ctx.fillText(label, 132, y);
      if (label === 'STATUS') {
        ctx.font = '600 21px Arial';
        const pillW = Math.max(144, ctx.measureText(String(value)).width + 54);
        const px = width - 132 - pillW;
        roundedRect(ctx, px, y - 31, pillW, 46, 23);
        ctx.fillStyle = palette.soft; ctx.fill();
        ctx.fillStyle = palette.strong; ctx.beginPath(); ctx.arc(px+23,y-8,7,0,Math.PI*2); ctx.fill();
        ctx.textAlign='center'; ctx.fillStyle=palette.strong; ctx.fillText(String(value), px + pillW/2 + 10, y+1);
      } else {
        let textValue = String(value);
        let fontSize = 23;
        ctx.textAlign='right'; ctx.fillStyle='#17132f';
        ctx.font = `500 ${fontSize}px Arial`;
        while (ctx.measureText(textValue).width > 510 && fontSize > 15) { fontSize -= 1; ctx.font = `500 ${fontSize}px Arial`; }
        while (ctx.measureText(textValue).width > 510 && textValue.length > 9) { textValue = textValue.slice(0,-5) + '…'; }
        ctx.fillText(textValue, width - 132, y);
      }
      if (index < rows.length - 1) {
        ctx.strokeStyle='rgba(127,111,176,.18)'; ctx.lineWidth=1.5;
        ctx.beginPath(); ctx.moveTo(132,y+32); ctx.lineTo(width-132,y+32); ctx.stroke();
      }
      y += rowHeight;
    });
    return canvas;
  }
  async function downloadReceiptImage(t) {
    const canvas=createReceiptCanvas(t); const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('Could not create receipt image.')),'image/png'));
    const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`ckxchange-payout-slip-${String(t.id||'receipt').replace(/[^a-z0-9_-]/gi,'-')}.png`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function renderReceiptDetails(t) {
    const status=t.status||'pending'; $('receiptTitle').textContent=`Payout ${statusText(status)}`;
    $('receiptModal').querySelector('.receipt-head p').textContent=status==='success'?'Your payout is recorded as successful.':status==='processing'?'Your payout request is being processed.':status==='pending'?'Your payout request is waiting for admin review.':`Your payout request was ${statusText(status).toLowerCase()}.`;
    $('receiptAmount').textContent=money(t.amount); const amountLabel=$('receiptModal').querySelector('.receipt-amount-label'); if(amountLabel) amountLabel.textContent=status==='success'?'AMOUNT SENT · INR':'REQUESTED AMOUNT · INR'; $('receiptId').textContent=t.id; $('receiptDate').textContent=dateText(t.timestamp); $('receiptHolder').textContent=t.holder||'—'; $('receiptBank').textContent=t.bank||'—'; $('receiptBranch').textContent=t.branch||'—'; $('receiptAccount').textContent=t.account||'—'; $('receiptIfsc').textContent=t.ifsc||'—';
    $('receiptStatus').textContent=statusText(status); $('receiptStatus').style.color=status==='success'?'#087b59':status==='pending'?'#936116':status==='processing'?'#2368ad':'#b43c58';
    const icon=$('receiptModal').querySelector('.success-mark'); icon.style.background=status==='success'?'linear-gradient(145deg,#8af4bf,#42d69c)':status==='pending'?'linear-gradient(145deg,#ffe3a1,#dcae4a)':status==='processing'?'linear-gradient(145deg,#acd6ff,#5998df)':'linear-gradient(145deg,#ffb5c2,#e45a7e)'; icon.querySelector('svg path').setAttribute('d',status==='success'?'m5 12 4.5 4.5L19 7':status==='pending'?'M12 6v6l4 2':status==='processing'?'M20 11a8 8 0 1 0 2 5':'M6 6l12 12M18 6 6 18');
  }
  async function openReceipt(t) {
    if (!t?.id) return;
    try {
      const result = await request(`/api/payouts/${encodeURIComponent(t.id)}/receipt`);
      currentReceipt = result.transaction;
      renderReceiptDetails(currentReceipt); $('receiptModal').classList.add('open'); $('closeReceipt').focus();
    } catch (error) { toast(error.message || 'Could not load your payout slip.', 'error'); }
  }
  async function openAdminReceipt(transactionId) {
    if (!transactionId || !/^PAY-/i.test(String(transactionId))) return;
    try {
      const result = await request(`/api/admin/payouts/${encodeURIComponent(transactionId)}/receipt`);
      currentReceipt = result.transaction;
      renderReceiptDetails(currentReceipt); $('receiptModal').classList.add('open'); $('closeReceipt').focus();
    } catch (error) { toast(error.message || 'Could not load the payout slip.', 'error'); }
  }
  function closeReceipt() { $('receiptModal').classList.remove('open'); currentReceipt=null; $('receiptAccount').textContent='—'; }

  function renderAdminDepositSettings(result) {
    const entry = result?.addresses?.TRC20 || { address:'', valid:false, source:'not_configured' };
    const input = $('depositAddressTRC20'); const status = $('depositAddressTRC20Status');
    if (input && document.activeElement !== input) input.value = entry.address || '';
    if (status) {
      status.className = `lookup-status ${entry.valid ? 'success' : 'error'}`;
      if (entry.valid) status.textContent = `TRC20 address format looks valid · Source: ${entry.source}. Verify ownership and the correct USDT token before enabling deposits.`;
      else if (entry.address) status.textContent = 'This address format is invalid; user deposit requests remain disabled.';
      else status.textContent = entry.source === 'database' ? 'Disabled by saved admin setting.' : 'Not configured. User deposit requests remain disabled.';
    }
    const rateInput = $('inrPerUsdtRate');
    if (rateInput && document.activeElement !== rateInput && Number.isFinite(Number(result?.rate))) rateInput.value = Number(result.rate).toFixed(2);
    if (Number.isFinite(Number(result?.rate)) && Number(result.rate) > 0) {
      state.rate = Number(result.rate); renderRateDisplays(); updateDepositEstimate(); updateSendEstimate();
    }
    const rateHint = $('rateSettingHint');
    if (rateHint && result?.rateSource) rateHint.textContent = `Current rate: ${money(state.rate)} per USDT · source: ${result.rateSource}. Applies to future requests only; not a live market quote.`;
  }

  function updateAdminPagination(kind, pagination) {
    const info = $(`admin${kind[0].toUpperCase()+kind.slice(1)}PageInfo`);
    const previous = document.querySelector(`[data-admin-page-prev="${kind}"]`);
    const next = document.querySelector(`[data-admin-page-next="${kind}"]`);
    const data = pagination || { page: adminLists[kind].page, pageSize: 25, total: 0, pages: 1 };
    adminLists[kind].page = data.page || 1;
    if (info) info.textContent = `Page ${data.page || 1} of ${data.pages || 1} · ${(data.total || 0).toLocaleString('en-IN')} record${data.total === 1 ? '' : 's'}`;
    if (previous) previous.disabled = (data.page || 1) <= 1;
    if (next) next.disabled = (data.page || 1) >= (data.pages || 1);
  }
  function copyAdminValue(value, button) {
    const raw = String(value ?? '');
    if (!raw) { toast('Nothing to copy.','error'); return; }
    const setCopied = () => { const original = button.innerHTML; const originalLabel = button.getAttribute('aria-label') || button.title || 'Copy value'; button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; button.classList.add('is-copied'); button.setAttribute('aria-label', 'Copied'); button.title = 'Copied'; setTimeout(() => { if (button.isConnected) { button.innerHTML = original; button.classList.remove('is-copied'); button.setAttribute('aria-label', originalLabel); button.title = originalLabel; } }, 1400); };
    const fallback = () => {
      const area = document.createElement('textarea'); area.value = raw; area.setAttribute('readonly',''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.appendChild(area); area.select();
      let copied = false; try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
      area.remove();
      if (copied) { setCopied(); toast('Copied to clipboard.'); }
      else toast('Clipboard access is unavailable. Select and copy the value manually.','error');
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(raw).then(() => { setCopied(); toast('Copied to clipboard.'); }).catch(fallback);
    else fallback();
  }
  async function loadAdmin({ refreshDepositSettings = false, refreshSupportSettings = false } = {}) {
    if (adminLoading || state.user?.role !== 'admin') return;
    adminLoading = true;
    try {
      const overview = await request('/api/admin/overview');
      $('adminUsersCount').textContent = Number(overview.users || 0).toLocaleString('en-IN');
      $('adminDepositsCount').textContent = Number(overview.pendingDeposits || 0).toLocaleString('en-IN');
      $('adminPayoutsCount').textContent = Number(overview.pendingPayouts || 0).toLocaleString('en-IN');
      $('adminSuccessfulPayoutInr').textContent = money(overview.successfulPayoutInr || 0);
      $('adminTotalAvailableUsdt').textContent = `${fmtUsdt(overview.totalAvailableUsdt || 0,4)} USDT`;
      $('adminDepositsBadge').textContent = Number(overview.pendingDeposits || 0) > 99 ? '99+' : String(overview.pendingDeposits || 0);
      $('adminPayoutsBadge').textContent = Number(overview.pendingPayouts || 0) > 99 ? '99+' : String(overview.pendingPayouts || 0);

      if (activeAdminSubPage === 'deposits' || activeAdminSubPage === 'payouts') {
        const kind = activeAdminSubPage;
        const list = adminLists[kind];
        const data = await request(`/api/admin/transactions?type=${kind === 'deposits' ? 'deposit' : 'payout'}&page=${list.page}&pageSize=${list.pageSize}&q=${encodeURIComponent(list.q)}`);
        if (kind === 'deposits') {
          $('adminDepositsRows').innerHTML = (data.transactions || []).map(renderAdminDepositRequest).join('');
          $('adminDepositsEmpty').hidden = (data.transactions || []).length !== 0;
        } else {
          $('adminPayoutRows').innerHTML = (data.transactions || []).map(renderAdminPayoutRequest).join('');
          $('adminPayoutsEmpty').hidden = (data.transactions || []).length !== 0;
        }
        updateAdminPagination(kind, data.pagination);
      } else if (activeAdminSubPage === 'users') {
        const list = adminLists.users;
        const data = await request(`/api/admin/users?page=${list.page}&pageSize=${list.pageSize}&q=${encodeURIComponent(list.q)}`);
        $('adminUsersRows').innerHTML = (data.users || []).map(u=>`<tr><td><div class="table-main">${safe(u.name)}</div><div class="table-sub">${safe(u.id)}</div><div class="table-sub">Telegram: ${safe(u.telegramId || 'Not linked')}</div><div class="table-sub">Phone: ${safe(u.phoneNumber || 'Not provided')}</div></td><td>${safe(u.email)}</td><td>${safe(u.role)}</td><td>${fmtUsdt(u.availableUsdt,4)}<div class="table-sub">Reserved ${fmtUsdt(u.reservedUsdt,4)}</div></td><td>${safe(u.status)}</td></tr>`).join('');
        $('adminUsersEmpty').hidden = (data.users || []).length !== 0;
        updateAdminPagination('users', data.pagination);
      } else if (activeAdminSubPage === 'audit') {
        const list = adminLists.audit;
        const data = await request(`/api/admin/audit?page=${list.page}&pageSize=${list.pageSize}&q=${encodeURIComponent(list.q)}`);
        $('adminAuditRows').innerHTML = (data.entries || []).length ? data.entries.map(renderAuditEntry).join('') : '';
        $('adminAuditEmpty').hidden = (data.entries || []).length !== 0;
        updateAdminPagination('audit', data.pagination);
      } else if (activeAdminSubPage === 'settings') {
        if (!adminDepositSettingsLoaded || refreshDepositSettings) {
          const settings = await request('/api/admin/settings/deposits');
          renderAdminDepositSettings(settings); adminDepositSettingsLoaded = true;
        }
        if (!adminSupportSettingsLoaded || refreshSupportSettings) {
          const support = await request('/api/admin/settings/support');
          $('supportTelegramUsername').value = support.telegramUsername || '';
          adminSupportSettingsLoaded = true;
        }
      }
    } finally { adminLoading = false; }
  }
  async function adminAction(button) {
    const action=button.dataset.adminAction, id=button.dataset.id; if(!action||!id||button.disabled) return;
    const originalText = button.textContent;
    const row = button.closest('.admin-request-card');
    const rowButtons = row ? [...row.querySelectorAll('[data-admin-action]')] : [button];
    rowButtons.forEach(item => { item.disabled = true; });
    button.textContent = 'Working…';
    try {
      if(action==='deposit-approve') {
        const requestedUsdt = Number(button.dataset.requestedUsdt);
        const enteredCredit = prompt(`Customer requested ${fmtUsdt(requestedUsdt, 6)} USDT. Enter the actual USDT amount independently verified on-chain:`, fmtNumber(requestedUsdt, 6));
        if (enteredCredit === null) return;
        const creditedUsdt = Number(String(enteredCredit).trim());
        if (!Number.isFinite(creditedUsdt) || creditedUsdt <= 0 || creditedUsdt > 10_000_000 || Math.round(creditedUsdt * 1_000_000) <= 0) {
          toast('Enter a valid verified amount greater than 0 and no more than 10,000,000 USDT.', 'error'); return;
        }
        const changedAmount = Math.round(creditedUsdt * 1_000_000) !== Math.round(requestedUsdt * 1_000_000);
        let adjustmentReason = '';
        if (changedAmount) {
          const reason = prompt('The verified amount differs from the customer request. Enter the reason for this adjustment (at least 3 characters):');
          if (reason === null) return;
          adjustmentReason = reason.trim();
          if (adjustmentReason.length < 3) { toast('An adjustment reason of at least 3 characters is required.', 'error'); return; }
        }
        const confirmText = `Confirm independent verification of the TRC20 transaction, token, receiving address and confirmations.\n\nRequested: ${fmtUsdt(requestedUsdt, 6)} USDT\nTo credit: ${fmtUsdt(creditedUsdt, 6)} USDT${changedAmount ? `\nAdjustment: ${adjustmentReason}` : ''}\n\nThis will credit the verified amount exactly once.`;
        if(!confirm(confirmText)) return;
        await request(`/api/admin/deposits/${encodeURIComponent(id)}/approve`,{method:'POST',body:{creditedUsdt, adjustmentReason}});
        toast(`${fmtUsdt(creditedUsdt, 6)} USDT verified and credited.`);
      } else if(action==='deposit-reject') {
        const reason=prompt('Why is this deposit being rejected?'); if(!reason) return;
        await request(`/api/admin/deposits/${encodeURIComponent(id)}/reject`,{method:'POST',body:{reason}}); toast('Deposit rejected; no balance was credited.');
      } else if(action==='payout-approve') {
        if(!confirm('Approve this request for processing? This does not send money. The transfer must still be made through your authorized bank/provider.')) return;
        const result=await request(`/api/admin/payouts/${encodeURIComponent(id)}/approve`,{method:'POST',body:{}}); toast(result.message||'Payout moved to Processing.');
      } else if(action==='payout-complete') {
        const bankReference=prompt('After the actual bank transfer is confirmed, enter its bank/provider reference:'); if(!bankReference) return;
        if(!confirm('Confirm that the transfer has completed successfully and that the reference is accurate?')) return;
        await request(`/api/admin/payouts/${encodeURIComponent(id)}/complete`,{method:'POST',body:{bankReference}}); toast('Payout marked successful.');
      } else if(action==='payout-reject'||action==='payout-fail') {
        const reason=prompt(action==='payout-fail'?'Why did the payout fail?':'Why are you rejecting this payout?'); if(!reason) return;
        await request(`/api/admin/payouts/${encodeURIComponent(id)}/${action==='payout-fail'?'fail':'reject'}`,{method:'POST',body:{reason}}); toast('Payout closed and reserved funds returned to available balance.');
      }
      await refreshState({quiet:true}); await loadAdmin();
    } catch(error) {
      if (error.status === 401 || error.status === 403) {
        if ($('page-admin')) { window.location.replace('/'); return; }
        if (error.status === 401) {
          state.user = null;
          history.replaceState({}, '', '/'); showAuth(); setAuthMode('login');
        }
      }
      toast(error.message,'error');
    } finally {
      if (button.isConnected) { button.textContent = originalText; rowButtons.forEach(item => { if (item.isConnected) item.disabled = false; }); }
    }
  }

  document.addEventListener('click', async event => {
    const authTab=event.target.closest('[data-auth-mode]'); if(authTab){setAuthMode(authTab.dataset.authMode); return;}
    const requestToggle=event.target.closest('[data-toggle-admin-request]'); if(requestToggle){
      const key=requestToggle.dataset.toggleAdminRequest;
      const shouldExpand=expandedAdminRequestKey!==key;
      expandedAdminRequestKey=shouldExpand?key:'';
      document.querySelectorAll('.admin-request-card').forEach(card=>{
        const toggle=card.querySelector('[data-toggle-admin-request]');
        const details=card.querySelector('.admin-request-details');
        const expanded=shouldExpand && toggle?.dataset.toggleAdminRequest===key;
        card.classList.toggle('is-expanded',Boolean(expanded));
        if(toggle){toggle.setAttribute('aria-expanded',String(Boolean(expanded)));const label=toggle.querySelector('.admin-request-expand-label');if(label)label.innerHTML=`${expanded?'Hide details':'View details'} ${adminRequestChevron()}`;}
        if(details)details.hidden=!expanded;
      });
      return;
    }
    const removeButton=event.target.closest('[data-remove-bank]');
    if(removeButton) {
      const bank=state.banks.find(item=>item.id===removeButton.dataset.removeBank); if(!bank) return;
      if(!confirm(`Remove ${bank.holder}'s saved account ending ${bank.last4}? Previous transaction history will be kept.`)) return;
      try { await request(`/api/banks/${encodeURIComponent(bank.id)}`,{method:'DELETE'}); await refreshState({quiet:true}); toast('Saved bank account removed.'); }
      catch(error){toast(error.message,'error');} return;
    }
    const adminSlipButton=event.target.closest('[data-view-admin-transaction]');
    if(adminSlipButton){await openAdminReceipt(adminSlipButton.dataset.viewAdminTransaction);return;}
    const slipButton=event.target.closest('[data-view-transaction]');
    if(slipButton){const txn=state.transactions.find(item=>item.id===slipButton.dataset.viewTransaction); if(txn&&txn.type==='payout') await openReceipt(txn); return;}
    const notificationButton=event.target.closest('[data-notification-open]'); if(notificationButton){const item=state.notifications.find(value=>value.id===notificationButton.dataset.notificationOpen); if(item) await openNotification(item); return;}
    const adminButton=event.target.closest('[data-admin-action]'); if(adminButton){await adminAction(adminButton);return;}
    const adminCopy=event.target.closest('[data-copy-value]'); if(adminCopy){copyAdminValue(adminCopy.dataset.copyValue,adminCopy);return;}
    const previousPage=event.target.closest('[data-admin-page-prev]'); if(previousPage){const kind=previousPage.dataset.adminPagePrev; if(adminLists[kind]&&adminLists[kind].page>1){adminLists[kind].page-=1;await loadAdmin().catch(error=>toast(error.message,'error'));}return;}
    const nextPage=event.target.closest('[data-admin-page-next]'); if(nextPage){const kind=nextPage.dataset.adminPageNext; if(adminLists[kind]){adminLists[kind].page+=1;await loadAdmin().catch(error=>toast(error.message,'error'));}return;}
    const adminRoute=event.target.closest('[data-admin-route]'); if(adminRoute){event.preventDefault(); if(state.user?.role!=='admin'){toast('Administrator access is required.','error');return;} setAdminSubPage(adminRoute.dataset.adminRoute,{historyMode:'push'}); return;}
    if(event.target.closest('[data-admin-refresh]')){try{await refreshState({quiet:true});await loadAdmin({refreshDepositSettings:true,refreshSupportSettings:true});toast('Admin data refreshed.');}catch(error){toast(error.message,'error');}return;}
    const copy=event.target.closest('#copyDepositAddress'); if(copy&&!copy.disabled){try{await navigator.clipboard.writeText(networkConfig.depositAddress);toast('Receiving address copied.');}catch(_){toast('Copy was unavailable; select and copy the address manually.','error');}return;}
    const nav=event.target.closest('[data-page]'); if(nav){go(nav.dataset.page);return;}
    const goButton=event.target.closest('[data-go]'); if(goButton){go(goButton.dataset.go);return;}
  });

  const adminSearchForms = [
    ['deposits','adminDepositsSearchForm','adminDepositsSearch'],
    ['payouts','adminPayoutsSearchForm','adminPayoutsSearch'],
    ['users','adminUsersSearchForm','adminUsersSearch'],
    ['audit','adminAuditSearchForm','adminAuditSearch']
  ];
  adminSearchForms.forEach(([kind,formId,inputId]) => {
    const form = $(formId); if (!form) return;
    form.addEventListener('submit', event => {
      event.preventDefault(); adminLists[kind].q = $(inputId).value.trim().slice(0,80); adminLists[kind].page = 1;
      if (activeAdminSubPage !== kind) setAdminSubPage(kind, { historyMode: 'push' }); else loadAdmin().catch(error => toast(error.message,'error'));
    });
  });

  if ($('contactSettingsForm')) $('contactSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('saveContactSettingsBtn'); button.disabled = true;
    $('contactSettingsStatus').textContent = 'Saving contact details…';
    try {
      const result = await request('/api/profile/contact', { method:'PUT', body:{ telegramId: $('telegramContactId').value.trim(), phoneNumber: $('contactPhoneNumber').value.trim() } });
      state.user = { ...state.user, ...result.user };
      $('telegramContactId').value = state.user.telegramId || '';
      $('contactPhoneNumber').value = state.user.phoneNumber || '';
      $('contactSettingsStatus').textContent = 'Saved. These details are visible to authorized CKXchange administrators only.';
      toast(result.message || 'Support contact details saved.');
    } catch (error) {
      $('contactSettingsStatus').textContent = 'Could not save these details. Check the fields and try again.';
      toast(error.message, 'error');
    } finally { button.disabled = false; }
  });

  if ($('changePasswordForm')) $('changePasswordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const currentPassword = $('currentAccountPassword').value;
    const newPassword = $('newAccountPassword').value;
    const confirmPassword = $('confirmAccountPassword').value;
    const status = $('changePasswordStatus');
    const button = $('changePasswordSubmit');
    if (newPassword.length < 10 || newPassword.length > 128 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      status.textContent = 'New password must be 10–128 characters and include at least one letter and one number.';
      toast(status.textContent, 'error'); return;
    }
    if (newPassword !== confirmPassword) {
      status.textContent = 'New password and confirmation do not match.';
      toast(status.textContent, 'error'); $('confirmAccountPassword').focus(); return;
    }
    button.disabled = true; status.textContent = 'Updating your password…';
    try {
      const result = await request('/api/auth/change-password', {
        method: 'POST', body: { currentPassword, newPassword, confirmPassword }
      });
      $('changePasswordForm').reset();
      status.textContent = result.message || 'Your password has been changed successfully.';
      toast(status.textContent);
    } catch (error) {
      status.textContent = error.message;
      toast(error.message, 'error');
    } finally { button.disabled = false; }
  });

  if ($('supportSettingsForm')) $('supportSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.user?.role !== 'admin') { toast('Administrator access is required.','error'); return; }
    const button = $('saveSupportSettingsBtn'); button.disabled = true;
    try {
      const result = await request('/api/admin/settings/support', { method:'PUT', body:{ telegramUsername: $('supportTelegramUsername').value.trim() } });
      $('supportTelegramUsername').value = result.telegramUsername || '';
      adminSupportSettingsLoaded = true; renderSupportContact(result.telegramUsername || '');
      toast(result.message || 'Support contact saved.');
    } catch (error) { toast(error.message,'error'); }
    finally { button.disabled = false; }
  });

  if ($('deleteAccountForm')) $('deleteAccountForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = $('deleteAccountPassword').value;
    const confirmation = $('deleteAccountConfirmation').value.trim();
    if (state.user?.role !== 'user') { toast('Administrator accounts cannot be deleted from this page.','error'); return; }
    if (confirmation !== 'DELETE') { toast('Type DELETE exactly to confirm.','error'); return; }
    if (!confirm('Permanently delete your CKXchange account? This cannot be undone. Requests that are still pending or processing, or any remaining balance, will block deletion.')) return;
    const button = $('deleteAccountSubmit'); button.disabled = true;
    try {
      const result = await request('/api/account/delete', { method:'POST', body:{ password, confirmation } });
      window.alert(result.message || 'Your account has been deleted.');
      state.user = null; state.banks = []; state.transactions = []; state.balance = 0; state.reservedUsdt = 0; csrfToken = '';
      window.location.replace('/');
    } catch (error) { toast(error.message,'error'); button.disabled = false; }
  });

  $('authRetryButton').addEventListener('click', () => initialize());
  $('authForm').addEventListener('submit', async event => {
    event.preventDefault(); const submit=$('authSubmit'); submit.disabled=true;
    try {
      await refreshCsrf();
      const email=$('authEmail').value.trim().toLowerCase(); const password=$('authPassword').value;
      let result;
      if(authMode==='register') {
        const name=$('authName').value.toLocaleUpperCase('en-IN').replace(/\s{2,}/g,' ').trim(); const confirmPassword=$('authConfirm').value;
        if(password!==confirmPassword) throw new Error('Passwords do not match.');
        result=await request('/api/auth/register',{method:'POST',body:{name,email,password}});
      } else result=await request('/api/auth/login',{method:'POST',body:{email,password}});
      csrfToken=result.csrfToken||csrfToken; state.user=result.user;
      // Customer HTML omits admin-only markup. Reload through the server-guarded route after admin sign-in.
      if(state.user.role === 'admin' && !isAdminPath()) { window.location.replace('/admin'); return; }
      showApplication(); await refreshState({quiet:true}); await loadSupportContact(); await loadNotifications({quiet:true}).catch(() => {});
      const wantsAdmin = requestedAdminPage();
      const initialPage = wantsAdmin && state.user.role === 'admin' ? 'admin' : 'home';
      if(wantsAdmin && state.user.role !== 'admin'){history.replaceState({},'','/');toast('Admin access is restricted to administrator accounts.','error');}
      go(initialPage,false);
      if(initialPage === 'admin' && !isAdminPath()) history.replaceState({ adminSubPage: 'overview' },'','/admin');
      $('authForm').reset(); toast(authMode==='register'?'Account created successfully.':'Signed in successfully.');
      startPolling();
    } catch(error) { $('authAlert').textContent=error.message; $('authAlert').style.color='var(--red)'; }
    finally { submit.disabled=false; }
  });
  $('logoutButton').addEventListener('click', async () => {
    if(!confirm('Sign out of CKXchange on this device?')) return;
    try { await request('/api/auth/logout',{method:'POST',body:{}}); }
    catch(error) { toast(`Sign out failed: ${error.message}. Please try again.`, 'error'); return; }
    state.user=null; state.balance=0; state.reservedUsdt=0; state.banks=[]; state.transactions=[]; state.notifications=[]; state.unreadNotifications=0; state.notificationPrefs={inAppEnabled:true,pushEnabled:false,pushConfigured:false}; csrfToken='';
    // A full reload clears any admin-only markup already present in the administrator document.
    window.location.replace('/');
  });
  $('helpButton').addEventListener('click',()=>toast('CKXchange uses a backend database. Blockchain deposits still require independent admin verification, and payouts are manually completed through an authorized bank/provider.'));
  $('sendAmount').addEventListener('input',updateSendEstimate);
  $('sendMax').addEventListener('click', () => {
    const amount = maxPayoutAmountInr();
    if (amount <= 0) { toast('No available payout balance to use.', 'error'); return; }
    $('sendAmount').value = amount.toFixed(2);
    updateSendEstimate();
  });
  $('bankForm').addEventListener('input',event=>{
    if(event.target.id==='holderName') event.target.value=event.target.value.toLocaleUpperCase('en-IN').replace(/[^\p{L}\s.'-]/gu,'').replace(/\s{2,}/g,' ').slice(0,80);
    if(event.target.id==='accountNumber') event.target.value=event.target.value.replace(/[^0-9]/g,'').slice(0,24);
    if(event.target.id==='ifscCode') {const start=event.target.selectionStart;event.target.value=event.target.value.toUpperCase().replace(/\s+/g,'').slice(0,11);try{event.target.setSelectionRange(start,start);}catch(_){} ifscRequestVersion++;clearTimeout(ifscTimer);ifscClear();const code=event.target.value;if(code.length===11)ifscTimer=setTimeout(()=>lookupIfsc(code),250);}
    validateBankForm();
  });
  $('bankForm').addEventListener('submit',async event=>{
    event.preventDefault(); $('holderName').value=$('holderName').value.toLocaleUpperCase('en-IN').replace(/\s{2,}/g,' ').trim(); $('accountNumber').value=$('accountNumber').value.replace(/[^0-9]/g,'').slice(0,24);
    if(!validateBankForm()){toast('Use capital letters for the holder name, digits only for the account number, and a verified IFSC.','error');return;}
    const btn=$('saveBankBtn');btn.disabled=true;
    try {
      await request('/api/banks',{method:'POST',body:{holder:$('holderName').value.trim(),account:$('accountNumber').value.trim(),ifsc:$('ifscCode').value.trim().toUpperCase()}});
      await refreshState({quiet:true}); $('bankForm').reset(); ifscClear(); toast('Bank account saved securely.'); go('bankreturn');
    } catch(error) {toast(error.message,'error');}
    finally {validateBankForm();}
  });
  function closePayoutReview() {
    $('payoutReviewModal').classList.remove('open');
    pendingPayoutReview = null;
    $('confirmPayoutRequest').disabled = false;
  }
  async function openPayoutReview(bankId, amountInr) {
    const bank = state.banks.find(item => item.id === bankId);
    if (!bank) { toast('Choose a saved bank account first.', 'error'); return; }
    const submitButton = $('sendSubmit');
    const wasDisabled = submitButton?.disabled || false;
    if (submitButton) submitButton.disabled = true;
    try {
      // Bulk bank listings intentionally mask account numbers. Fetch the full number
      // only for this owner's review modal through the no-cache, owner-scoped endpoint.
      const detail = await request(`/api/banks/${encodeURIComponent(bankId)}/payout-review`);
      const accountNumber = String(detail.bank?.account || '');
      if (!/^\d{6,24}$/.test(accountNumber)) throw new Error('Could not securely retrieve the full account number. Please try again.');
      const rate = Math.max(Number(state.rate) || RATE_DEFAULT, 0.000001);
      const usdtToReserve = Math.ceil((amountInr / rate) * 1_000_000 - 1e-9) / 1_000_000;
      const availableInr = Math.max(0, state.balance * rate);
      $('payoutReviewHolder').textContent = bank.holder || '—';
      $('payoutReviewBank').textContent = [bank.bank, bank.branch].filter(Boolean).join(' · ') || 'Saved bank account';
      $('payoutReviewAccount').textContent = accountNumber;
      $('payoutReviewIfsc').textContent = bank.ifsc || '—';
      $('payoutReviewAmount').textContent = money(amountInr);
      $('payoutReviewUsdt').textContent = `${fmtUsdt(usdtToReserve, 6)} USDT`;
      $('payoutReviewRemaining').textContent = money(Math.max(0, availableInr - amountInr));
      pendingPayoutReview = { bankId, amountInr };
      $('payoutReviewModal').classList.add('open');
    } catch (error) { toast(error.message || 'Could not load payout review details.', 'error'); }
    finally { if (submitButton) submitButton.disabled = wasDisabled; }
  }
  async function submitReviewedPayout() {
    if (!pendingPayoutReview) return;
    const payload = { ...pendingPayoutReview };
    const confirmButton = $('confirmPayoutRequest'); confirmButton.disabled = true;
    try {
      const result = await request('/api/payouts', { method:'POST', body:payload });
      closePayoutReview();
      await refreshState({ quiet:true }); $('sendForm').reset(); updateSendEstimate();
      await openReceipt(state.transactions.find(t => t.id === result.transaction.id) || result.transaction);
      toast('Payout request submitted and balance reserved. Status: Pending.');
    } catch (error) { toast(error.message, 'error'); }
    finally { confirmButton.disabled = false; }
  }
  $('sendForm').addEventListener('submit', event => {
    event.preventDefault();
    const bankId = $('sendBank').value;
    const amountInr = Number($('sendAmount').value);
    if (!bankId) { toast('Choose a saved bank account first.', 'error'); return; }
    if (!Number.isFinite(amountInr) || amountInr < 1000) { toast('Minimum withdrawal is ₹1,000.', 'error'); return; }
    if (amountInr > MAX_PAYOUT_INR) { toast('Maximum payout per request is ₹100,000.', 'error'); return; }
    if (amountInr > state.balance * state.rate + 1e-7) { toast('Insufficient available USDT balance for this payout.', 'error'); return; }
    openPayoutReview(bankId, amountInr);
  });
  $('cancelPayoutReview').addEventListener('click', closePayoutReview);
  $('closePayoutReview').addEventListener('click', closePayoutReview);
  $('confirmPayoutRequest').addEventListener('click', submitReviewedPayout);
  $('payoutReviewModal').addEventListener('click', event => { if (event.target === $('payoutReviewModal')) closePayoutReview(); });
  if ($('depositSettingsForm')) $('depositSettingsForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.user?.role !== 'admin') { toast('Administrator access is required.', 'error'); return; }
    const button = $('saveDepositSettingsBtn'); button.disabled = true;
    try {
      const address = $('depositAddressTRC20').value.trim();
      const rate = Number($('inrPerUsdtRate').value);
      const result = await request('/api/admin/settings/deposits', { method:'PUT', body:{ address, rate } });
      renderAdminDepositSettings(result); adminDepositSettingsLoaded = true;
      await updateDepositAddress();
      toast('TRC20 receiving address and USDT/INR rate saved.');
      await loadAdmin({ refreshDepositSettings:true });
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  $('depositAmount').addEventListener('input',updateDepositEstimate);
  $('depositNetwork').addEventListener('change',updateDepositAddress);
  $('depositForm').addEventListener('submit',async event=>{
    event.preventDefault(); const amountUsdt=Number($('depositAmount').value); const network='TRC20'; const txHash=$('depositTxHash').value.trim();
    if(!networkConfig.depositConfigured){toast('Deposits are disabled until a receiving address is configured.','error');return;}
    if(!Number.isFinite(amountUsdt) || amountUsdt < 10){toast('Minimum deposit is 10 USDT.','error');return;}
    const submit=$('depositSubmit');submit.disabled=true;
    try {
      const result=await request('/api/deposits',{method:'POST',body:{amountUsdt,network,txHash}}); await refreshState({quiet:true}); $('depositForm').reset(); updateDepositEstimate(); await updateDepositAddress(); toast(`Deposit ${result.transaction.id} submitted. Status: Pending.`); go('history'); $('historyFilter').value='deposit'; renderHistoryTable();
    } catch(error) {toast(error.message,'error');}
    finally {submit.disabled=!networkConfig.depositConfigured || Number($('depositAmount').value) < 10;}
  });
  $('historyFilter').addEventListener('change',renderHistoryTable);
  $('notificationBell').addEventListener('click', async () => { go('notifications'); await loadNotifications({ quiet: true }).catch(() => {}); });
  $('refreshNotifications').addEventListener('click', async () => { try { await loadNotifications(); toast('Notifications refreshed.'); } catch (_) {} });
  $('markAllNotificationsRead').addEventListener('click', async () => { try { await request('/api/notifications/read-all', { method: 'POST', body: {} }); await loadNotifications({ quiet: true }); toast('All notifications marked as read.'); } catch (error) { toast(error.message, 'error'); } });
  $('notificationsInAppEnabled').addEventListener('change', async event => {
    const checkbox = event.currentTarget; checkbox.disabled = true;
    try { await request('/api/notifications/preferences', { method: 'PUT', body: { inAppEnabled: checkbox.checked } }); await loadNotifications({ quiet: true }); }
    catch (error) { checkbox.checked = !checkbox.checked; toast(error.message, 'error'); }
    finally { checkbox.disabled = false; }
  });
  $('togglePushNotifications').addEventListener('click', togglePushNotifications);
  $('downloadReceipt').addEventListener('click',async()=>{if(!currentReceipt)return;try{await downloadReceiptImage(currentReceipt);toast('Payout slip downloaded as a PNG image.');}catch(error){toast(error.message,'error');}});
  $('closeReceipt').addEventListener('click',closeReceipt); $('receiptDone').addEventListener('click',closeReceipt);
  $('receiptModal').addEventListener('click',event=>{if(event.target===$('receiptModal'))closeReceipt();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('receiptModal').classList.contains('open'))closeReceipt();if(event.key==='Escape'&&$('payoutReviewModal').classList.contains('open'))closePayoutReview();});
  window.addEventListener('popstate',()=>{
    if(isAdminPath()) {
      if(state.user?.role==='admin') go('admin',false);
      else { history.replaceState({}, '', '/'); go('home',false); toast('Administrator access is restricted to administrator accounts.','error'); }
    } else go('home',false);
  });
  const themeModeToggle = $('themeModeToggle');
  if (themeModeToggle) themeModeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  applyTheme(document.documentElement.dataset.theme || 'light', false);

  // Customer support username is public configuration; wallet and account data remain server-side.
  setAuthMode('login');
  updateDepositEstimate();
  initializePwa();
  initialize();
})();
