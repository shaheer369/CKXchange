(() => {
  'use strict';
  const RATE_DEFAULT = 106;
  const $ = id => document.getElementById(id);
  const state = { user: null, balance: 0, reservedUsdt: 0, rate: RATE_DEFAULT, banks: [], transactions: [] };
  let csrfToken = '';
  let authMode = 'login';
  let currentReceipt = null;
  let ifscRequestVersion = 0;
  let ifscTimer = null;
  let addBankReturnPage = 'send';
  let networkConfig = { depositAddress: '', depositConfigured: false };
  let depositAddressRequestVersion = 0;
  let adminLoading = false;
  let adminDepositSettingsLoaded = false;
  let pollHandle = null;
  const isAdminPath = () => /^\/admin(?:\/|$)/i.test(location.pathname);
  const requestedAdminPage = () => isAdminPath() || new URLSearchParams(location.search).get('next') === 'admin';

  const PAGE_META = {
    home: ['YOUR ACCOUNT', 'Overview', 'Your available wallet value and recent transactions.'],
    send: ['PAYMENTS', 'Send INR', 'Request a bank payout and track its review status.'],
    banks: ['RECIPIENTS', 'Bank accounts', 'Add, view and remove your saved bank accounts.'],
    addbank: ['RECIPIENTS', 'Add bank account', 'Link an account for future payout requests.'],
    recharge: ['WALLET', 'Add USDT', 'Submit a deposit transaction for verification.'],
    history: ['ACTIVITY', 'Transaction history', 'Track deposit and payout status updates.'],
    profile: ['ACCOUNT', 'Profile & settings', 'Your CKXchange account details and settings.'],
    admin: ['ADMINISTRATION', 'Admin panel', 'Review deposit claims, payout requests and account activity.']
  };
  const fmtNumber = (value, digits = 4) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
    const data = await response.json(); csrfToken = data.csrfToken || ''; return csrfToken;
  }
  function showAuth() {
    $('authOverlay').hidden = false; document.body.classList.add('auth-pending');
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
  }
  function showApplication() {
    $('authOverlay').hidden = true; document.body.classList.remove('auth-pending');
    const admin = state.user?.role === 'admin';
    const desktopAdminNav = $('adminNav'); if (desktopAdminNav) desktopAdminNav.hidden = !admin;
    const mobileAdminNav = $('adminMobileNav'); if (mobileAdminNav) mobileAdminNav.hidden = !admin;
    $('mobile-bottom')?.classList.toggle('admin-view', admin);
    const mobile = document.querySelector('.mobile-bottom'); if (mobile) mobile.classList.toggle('admin-view', admin);
    $('profileMemberName').textContent = state.user?.name || 'CKXchange member';
    $('profileMemberEmail').textContent = state.user?.email || '';
    const miniName = document.querySelector('.mini-name'); if (miniName) miniName.textContent = state.user?.name || 'CKXchange member';
    const miniRole = document.querySelector('.mini-role'); if (miniRole) miniRole.textContent = admin ? 'Administrator' : 'Member';
    const initialAvatar = document.querySelector('#page-profile .avatar'); if (initialAvatar) initialAvatar.textContent = (state.user?.name || 'CX').split(/\s+/).slice(0,2).map(x => x[0] || '').join('').slice(0,2);
  }
  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    document.querySelectorAll('[data-auth-mode]').forEach(button => button.classList.toggle('active', button.dataset.authMode === authMode));
    $('authNameField').hidden = authMode !== 'register'; $('authConfirmField').hidden = authMode !== 'register';
    $('authName').required = authMode === 'register'; $('authConfirm').required = authMode === 'register';
    $('authPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    $('authTitle').textContent = authMode === 'register' ? 'Create your account' : 'Sign in to CKXchange';
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
  async function initialize() {
    try {
      await refreshCsrf();
      const auth = await request('/api/auth/me');
      state.user = auth.user;
      showApplication();
      await refreshState({ quiet:true });
      const wantsAdmin = requestedAdminPage();
      const desired = wantsAdmin && state.user.role === 'admin' ? 'admin' : 'home';
      go(desired, false);
      if (desired === 'admin') history.replaceState({}, '', '/admin');
      else if (wantsAdmin) { history.replaceState({}, '', '/'); toast('Admin access is restricted to administrator accounts.', 'error'); }
      startPolling();
    } catch (error) {
      // If an admin document was loaded but the session is no longer valid, reload the
      // customer route so the server sends the sanitized non-admin shell.
      if (error.status === 401 && $('page-admin')) { window.location.replace('/'); return; }
      showAuth();
      if (error.status !== 401) $('authAlert').textContent = `${error.message} Ensure the CKXchange backend server is running.`;
    }
  }
  async function refreshState({ quiet = false } = {}) {
    const response = await request('/api/state');
    state.user = response.user; state.rate = response.rate || RATE_DEFAULT;
    state.balance = Number(response.user.availableUsdt || 0); state.reservedUsdt = Number(response.user.reservedUsdt || 0);
    state.banks = response.banks || []; state.transactions = response.transactions || [];
    if (!document.body.classList.contains('auth-pending')) showApplication();
    renderAll();
    if (currentReceipt) { const latest = state.transactions.find(t => t.id === currentReceipt.id); if (latest && latest.status !== currentReceipt.status) { currentReceipt = latest; renderReceiptDetails(latest); } }
    return response;
  }
  function go(page, push = true) {
    if (page === 'bankreturn') page = addBankReturnPage;
    if (!PAGE_META[page]) return;
    if (page === 'admin' && state.user?.role !== 'admin') { toast('Administrator access is required.', 'error'); return; }
    const currentPage = document.querySelector('.page.active')?.id.replace(/^page-/, '');
    if (page === 'addbank' && (currentPage === 'send' || currentPage === 'banks')) addBankReturnPage = currentPage;
    document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
    document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    const [eyebrow, title, subtitle] = PAGE_META[page];
    $('pageEyebrow').textContent = eyebrow; $('pageTitle').textContent = title; $('pageSubtitle').textContent = subtitle;
    if (page === 'send') refreshSendPage();
    if (page === 'banks') renderBanks();
    if (page === 'addbank') $('addBankSavedCount').textContent = `${state.banks.length} saved account${state.banks.length === 1 ? '' : 's'}`;
    if (page === 'recharge') { updateDepositEstimate(); updateDepositAddress(); }
    if (page === 'admin') loadAdmin().catch(error => {
      if (error.status === 401 || error.status === 403) {
        if ($('page-admin')) { window.location.replace('/'); return; }
        if (error.status === 401) { state.user = null; history.replaceState({}, '', '/'); showAuth(); setAuthMode('login'); }
        else toast('Administrator access is required.', 'error');
      } else toast(error.message, 'error');
    });
    if (push) history.replaceState({}, '', page === 'admin' ? '/admin' : '/');
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
  function renderRateDisplays() {
    const formatted = money(state.rate);
    if ($('sidebarRateValue')) $('sidebarRateValue').textContent = formatted;
    if ($('homeRateNote')) $('homeRateNote').textContent = `1 USDT = ${formatted} · configured estimate`;
    if ($('profileRateValue')) $('profileRateValue').textContent = `${formatted} / USDT`;
  }
  function renderTransactions() {
    renderRateDisplays();
    const payouts = state.transactions.filter(t => t.type === 'payout' && t.status === 'success');
    const total = payouts.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const usdt = payouts.reduce((sum, t) => sum + Number(t.usdt || 0), 0);
    $('historyCount').textContent = payouts.length.toLocaleString('en-IN');
    $('historyTotal').textContent = money(total).replace(/\.00$/, ''); $('historyUsdt').textContent = fmtNumber(usdt, 4);
    $('profileTotal').textContent = money(total).replace(/\.00$/, ''); $('profileBanks').textContent = state.banks.length.toLocaleString('en-IN');
    $('profileBalance').textContent = fmtNumber(state.balance, 4); $('homeUsdt').textContent = fmtNumber(state.balance, 4);
    $('homeInr').textContent = money(state.balance * state.rate); $('rechargeCurrent').textContent = fmtNumber(state.balance,4);
    $('pageSubtitle').textContent = PAGE_META[document.querySelector('.page.active')?.id.replace('page-','') || 'home']?.[2] || '';
    const recent = [...state.transactions].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0,4);
    $('recentActivity').innerHTML = recent.length ? recent.map(t => {
      const isPayout = t.type === 'payout'; const title = isPayout ? 'INR payout' : 'USDT deposit request';
      const desc = isPayout ? `${safe(t.bank || 'Saved bank')} · ${safe(dateText(t.timestamp))}` : `${safe(t.network || 'USDT')} · ${safe(dateText(t.timestamp))}`;
      const amount = isPayout ? `−${money(t.amount)}` : `+${fmtNumber(t.usdt, 4)} USDT requested`;
      const subAmount = isPayout ? `Reserved ${fmtNumber(t.usdt,4)} USDT` : `Claimed value ${money(t.amount)}`;
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
      const transactionRef = isPayout ? `<button type="button" class="transaction-slip-link" data-view-transaction="${safe(t.id)}" aria-label="View payout slip ${safe(t.id)}">${safe(t.id)} · View slip ↗</button>` : `<div class="table-sub">${safe(t.id)}</div>`;
      const amount = money(t.amount);
      const amountLabel = isPayout ? 'Requested payout' : 'Claimed deposit value';
      return `<tr><td><div class="table-main">${isPayout ? 'INR payout' : 'USDT deposit'}</div>${transactionRef}${t.rejectionReason ? `<div class="table-sub">Reason: ${safe(t.rejectionReason)}</div>` : ''}</td><td>${safe(dateShort(t.timestamp))}<div class="table-sub">${safe(new Intl.DateTimeFormat('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(t.timestamp)))}</div></td><td><div class="table-main">${amount}</div><div class="table-sub">${amountLabel}</div></td><td><div class="table-main">${isPayout?'−':'+'}${fmtNumber(t.usdt,4)}</div><div class="table-sub">USDT</div></td><td>${statusBadge(t.status)}</td></tr>`;
    }).join('');
    $('historyEmpty').style.display = txs.length ? 'none' : 'block';
    document.querySelector('.history-wrap').style.display = txs.length ? 'block' : 'none';
  }
  function renderAll() { renderBanks(); renderTransactions(); updateSendEstimate(); updateDepositEstimate(); }
  function refreshSendPage() { renderBanks(); updateSendEstimate(); }
  function updateSendEstimate() {
    const raw = $('sendAmount').value.trim(); const amount = Number(raw); const available = Math.max(0, state.balance * state.rate);
    const status = $('sendAmountStatus'); const remaining = $('sendRemainingInr');
    if (!raw || !Number.isFinite(amount) || amount <= 0) { remaining.textContent='—'; status.className='lookup-status'; status.textContent=`Available payout value: ${money(available)}.`; return; }
    if (amount > available + 1e-7) { remaining.textContent='Insufficient balance'; status.className='lookup-status error'; status.textContent=`This exceeds your available payout value of ${money(available)}.`; return; }
    remaining.textContent = money(Math.max(0, available - amount)); status.className='lookup-status success'; status.textContent=`Available payout value: ${money(available)}. Final validation happens on the server.`;
  }
  function updateDepositEstimate() {
    const amount = Math.max(0, Number($('depositAmount')?.value) || 0);
    if ($('depositEstUsdt')) $('depositEstUsdt').textContent = `${fmtNumber(amount, 6)} USDT`;
    if ($('depositEstInr')) $('depositEstInr').textContent = money(amount * state.rate);
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
      $('depositSubmit').disabled = !config.depositConfigured;
      $('depositAddressStatus').className = 'lookup-status ' + (config.depositConfigured ? 'success' : 'error');
      $('depositAddressStatus').textContent = config.depositConfigured ? 'Check that the address and network match before sending any assets.' : `Deposits are disabled on ${network} until an authorized receiving address is configured.`;
    } catch (error) {
      if (requestVersion !== depositAddressRequestVersion) return;
      networkConfig = { depositAddress:'', depositConfigured:false };
      $('depositAddressText').textContent = 'Address lookup unavailable'; $('copyDepositAddress').disabled = true; $('depositSubmit').disabled = true;
      $('depositAddressStatus').className='lookup-status error'; $('depositAddressStatus').textContent=error.message;
    }
  }
  function ifscClear(message = 'Bank details will be looked up automatically.') {
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
    const canvas=document.createElement('canvas'); canvas.width=1000; canvas.height=1130; const ctx=canvas.getContext('2d'); const status=t.status||'pending';
    const accent=status==='success'?'#61e6aa':status==='pending'?'#f0c477':status==='processing'?'#72b7ff':'#ff7792';
    const bg=ctx.createLinearGradient(0,0,1000,1130); bg.addColorStop(0,'#0d1020'); bg.addColorStop(1,'#101a2a'); ctx.fillStyle=bg; ctx.fillRect(0,0,1000,1130);
    const glow=ctx.createRadialGradient(500,100,20,500,100,600); glow.addColorStop(0,`${accent}20`); glow.addColorStop(1,'#10132100'); ctx.fillStyle=glow; ctx.fillRect(0,0,1000,550);
    ctx.strokeStyle='rgba(255,255,255,.10)'; ctx.lineWidth=2; roundedRect(ctx,36,36,928,1058,34); ctx.stroke();
    ctx.textAlign='center'; ctx.fillStyle='#b6a2ff'; ctx.font='700 24px Arial'; ctx.fillText('CKXchange',500,96);
    ctx.fillStyle=accent; roundedRect(ctx,440,124,120,120,60); ctx.fill(); ctx.fillStyle='#101321'; ctx.font='700 64px Arial'; ctx.fillText(status==='success'?'✓':status==='pending'?'…':status==='processing'?'↻':'!',500,205);
    ctx.fillStyle='#f5f6ff'; ctx.font='700 39px Arial'; ctx.fillText(`Payout ${statusText(status)}`,500,305);
    ctx.fillStyle='#8e97b3'; ctx.font='500 20px Arial'; ctx.fillText('INR payout request receipt',500,344);
    ctx.fillStyle='#fff'; ctx.font='700 58px Arial'; ctx.fillText(money(t.amount),500,430);
    const rows=[['TRANSACTION ID',t.id||'—'],['DATE & TIME',dateText(t.timestamp)],['ACCOUNT HOLDER',t.holder||'—'],['BANK',t.bank||'—'],['BRANCH',t.branch||'—'],['ACCOUNT NUMBER',masked(t.account)],['IFSC CODE',t.ifsc||'—'],['STATUS',statusText(status)]];
    if(t.bankReference) rows.push(['BANK REFERENCE',t.bankReference]); if(t.rejectionReason) rows.push(['REASON',t.rejectionReason]);
    let y=500;
    for(const [label,value] of rows) {
      ctx.fillStyle='#8992ad'; ctx.font='600 17px Arial'; ctx.textAlign='left'; ctx.fillText(label,90,y);
      ctx.fillStyle=label==='STATUS'?accent:'#f0f1fc'; ctx.font='600 18px Arial'; ctx.textAlign='right';
      let textValue=String(value); const max=525; while(ctx.measureText(textValue).width>max && textValue.length>6) textValue=textValue.slice(0,-4)+'…';
      ctx.fillText(textValue,910,y); ctx.strokeStyle='rgba(255,255,255,.075)'; ctx.beginPath(); ctx.moveTo(90,y+18); ctx.lineTo(910,y+18); ctx.stroke(); y+=57;
    }
    ctx.textAlign='center'; ctx.fillStyle='#e8c77e'; ctx.font='700 17px Arial'; ctx.fillText('PENDING / PROCESSING IS NOT PROOF OF PAYMENT',500,1018);
    ctx.fillStyle='#8b94ad'; ctx.font='500 15px Arial'; ctx.fillText('This receipt reflects the current status stored in CKXchange.',500,1050);
    return canvas;
  }
  async function downloadReceiptImage(t) {
    const canvas=createReceiptCanvas(t); const blob=await new Promise((resolve,reject)=>canvas.toBlob(result=>result?resolve(result):reject(new Error('Could not create receipt image.')),'image/png'));
    const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`ckxchange-payout-slip-${String(t.id||'receipt').replace(/[^a-z0-9_-]/gi,'-')}.png`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function renderReceiptDetails(t) {
    const status=t.status||'pending'; $('receiptTitle').textContent=`Payout ${statusText(status)}`;
    $('receiptModal').querySelector('.receipt-head p').textContent=status==='success'?'Your payout is recorded as successful.':status==='processing'?'Your payout request is being processed.':status==='pending'?'Your payout request is waiting for admin review.':`Your payout request was ${statusText(status).toLowerCase()}.`;
    $('receiptAmount').textContent=money(t.amount); const amountLabel=$('receiptModal').querySelector('.receipt-amount-label'); if(amountLabel) amountLabel.textContent=status==='success'?'AMOUNT SENT · INR':'REQUESTED AMOUNT · INR'; $('receiptId').textContent=t.id; $('receiptDate').textContent=dateText(t.timestamp); $('receiptHolder').textContent=t.holder||'—'; $('receiptBank').textContent=t.bank||'—'; $('receiptBranch').textContent=t.branch||'—'; $('receiptAccount').textContent=masked(t.account); $('receiptIfsc').textContent=t.ifsc||'—';
    $('receiptStatus').textContent=statusText(status); $('receiptStatus').style.color=status==='success'?'var(--green)':status==='pending'?'#f0c477':status==='processing'?'#72b7ff':'var(--red)';
    const icon=$('receiptModal').querySelector('.success-mark'); icon.style.background=status==='success'?'linear-gradient(145deg,#8af4bf,#42d69c)':status==='pending'?'linear-gradient(145deg,#ffe3a1,#dcae4a)':status==='processing'?'linear-gradient(145deg,#acd6ff,#5998df)':'linear-gradient(145deg,#ffb5c2,#e45a7e)'; icon.querySelector('svg path').setAttribute('d',status==='success'?'m5 12 4.5 4.5L19 7':status==='pending'?'M12 6v6l4 2':status==='processing'?'M20 11a8 8 0 1 0 2 5':'M6 6l12 12M18 6 6 18');
  }
  function openReceipt(t) {
    currentReceipt=t; renderReceiptDetails(t); $('receiptModal').classList.add('open'); $('closeReceipt').focus();
  }
  function closeReceipt() { $('receiptModal').classList.remove('open'); currentReceipt=null; }

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

  async function loadAdmin({ refreshDepositSettings = false } = {}) {
    if(adminLoading || state.user?.role!=='admin') return; adminLoading=true;
    try {
      const [overview,deposits,payouts,users,audit]=await Promise.all([
        request('/api/admin/overview'), request('/api/admin/transactions?type=deposit'), request('/api/admin/transactions?type=payout'), request('/api/admin/users'), request('/api/admin/audit')
      ]);
      $('adminUsersCount').textContent=overview.users.toLocaleString('en-IN'); $('adminDepositsCount').textContent=overview.pendingDeposits.toLocaleString('en-IN'); $('adminPayoutsCount').textContent=overview.pendingPayouts.toLocaleString('en-IN');
      $('adminDepositsRows').innerHTML=deposits.transactions.map(t=>`<tr><td><div class="table-main">${safe(t.userName)}</div><div class="table-sub">${safe(t.userEmail)}</div></td><td><div class="table-main">${safe(t.network)}</div><div class="table-sub">Destination used for this request</div><div class="admin-hash">${safe(t.depositAddress || 'Not recorded by an earlier app version')}</div><div class="table-sub">Transaction hash</div><div class="admin-hash">${safe(t.txHash)}</div></td><td><div class="table-main">${fmtNumber(t.usdt,6)} USDT</div><div class="table-sub">${money(t.amount)} estimated value</div></td><td>${safe(dateText(t.timestamp))}</td><td><div class="admin-actions"><button class="primary-btn" data-admin-action="deposit-approve" data-id="${safe(t.id)}">Verify & credit</button><button class="danger-btn" data-admin-action="deposit-reject" data-id="${safe(t.id)}">Reject</button></div></td></tr>`).join('');
      $('adminDepositsEmpty').hidden=deposits.transactions.length!==0;
      $('adminPayoutRows').innerHTML=payouts.transactions.map(t=>`<tr><td><div class="table-main">${safe(t.userName)} · ${safe(t.holder||'')}</div><div class="table-sub">${safe(t.userEmail)}</div><div class="admin-user-muted">${safe(t.bank||'')} · ${safe(t.branch||'')}</div><div class="admin-user-muted">A/C ${safe(t.account||masked(t.last4))} · ${safe(t.ifsc||'')}</div></td><td><div class="table-main">${money(t.amount)}</div><div class="table-sub">${fmtNumber(t.usdt,6)} USDT reserved</div></td><td>${statusBadge(t.status)}${t.bankReference?`<div class="table-sub">Ref: ${safe(t.bankReference)}</div>`:''}</td><td>${safe(dateText(t.timestamp))}</td><td><div class="admin-actions">${t.status==='pending'?`<button class="primary-btn" data-admin-action="payout-approve" data-id="${safe(t.id)}">Approve</button>`:''}${t.status==='processing'?`<button class="primary-btn" data-admin-action="payout-complete" data-id="${safe(t.id)}">Mark successful</button><button class="secondary-btn" data-admin-action="payout-fail" data-id="${safe(t.id)}">Mark failed</button>`:''}<button class="danger-btn" data-admin-action="payout-reject" data-id="${safe(t.id)}">Reject</button></div></td></tr>`).join('');
      $('adminPayoutsEmpty').hidden=payouts.transactions.length!==0;
      $('adminUsersRows').innerHTML=users.users.map(u=>`<tr><td><div class="table-main">${safe(u.name)}</div><div class="table-sub">${safe(u.id)}</div></td><td>${safe(u.email)}</td><td>${safe(u.role)}</td><td>${fmtNumber(u.availableUsdt,4)}<div class="table-sub">Reserved ${fmtNumber(u.reservedUsdt,4)}</div></td><td>${safe(u.status)}</td></tr>`).join('');
      $('adminAuditRows').innerHTML=audit.entries.length?audit.entries.map(entry=>`<div class="settings-row"><div class="settings-icon">✓</div><div class="settings-content"><div class="settings-name">${safe(entry.action)}</div><div class="settings-desc">${safe(entry.adminName)} · ${safe(dateText(entry.createdAt))} · Target ${safe(entry.targetId||'—')}</div><div class="settings-desc">${safe(JSON.stringify(entry.details))}</div></div></div>`).join(''):`<div class="empty-state"><div class="empty-title">No admin actions recorded yet</div></div>`;
      if (!adminDepositSettingsLoaded || refreshDepositSettings) {
        const settings = await request('/api/admin/settings/deposits');
        renderAdminDepositSettings(settings); adminDepositSettingsLoaded = true;
      }
    } finally { adminLoading=false; }
  }
  async function adminAction(button) {
    const action=button.dataset.adminAction, id=button.dataset.id; if(!action||!id) return;
    try {
      if(action==='deposit-approve') {
        if(!confirm('Confirm you independently verified this network transaction, token contract, receiving address, amount, and required confirmations. Approving will credit the USDT balance.')) return;
        await request(`/api/admin/deposits/${encodeURIComponent(id)}/approve`,{method:'POST',body:{}}); toast('Deposit verified and USDT credited.');
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
    }
  }

  document.addEventListener('click', async event => {
    const authTab=event.target.closest('[data-auth-mode]'); if(authTab){setAuthMode(authTab.dataset.authMode); return;}
    const removeButton=event.target.closest('[data-remove-bank]');
    if(removeButton) {
      const bank=state.banks.find(item=>item.id===removeButton.dataset.removeBank); if(!bank) return;
      if(!confirm(`Remove ${bank.holder}'s saved account ending ${bank.last4}? Previous transaction history will be kept.`)) return;
      try { await request(`/api/banks/${encodeURIComponent(bank.id)}`,{method:'DELETE'}); await refreshState({quiet:true}); toast('Saved bank account removed.'); }
      catch(error){toast(error.message,'error');} return;
    }
    const slipButton=event.target.closest('[data-view-transaction]');
    if(slipButton){const txn=state.transactions.find(item=>item.id===slipButton.dataset.viewTransaction); if(txn&&txn.type==='payout') openReceipt(txn); return;}
    const adminButton=event.target.closest('[data-admin-action]'); if(adminButton){await adminAction(adminButton);return;}
    if(event.target.closest('[data-admin-refresh]')){try{await refreshState({quiet:true});await loadAdmin({refreshDepositSettings:true});toast('Admin data refreshed.');}catch(error){toast(error.message,'error');}return;}
    const copy=event.target.closest('#copyDepositAddress'); if(copy&&!copy.disabled){try{await navigator.clipboard.writeText(networkConfig.depositAddress);toast('Receiving address copied.');}catch(_){toast('Copy was unavailable; select and copy the address manually.','error');}return;}
    const nav=event.target.closest('[data-page]'); if(nav){go(nav.dataset.page);return;}
    const goButton=event.target.closest('[data-go]'); if(goButton){go(goButton.dataset.go);return;}
  });

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
      showApplication(); await refreshState({quiet:true});
      const wantsAdmin = requestedAdminPage();
      const initialPage = wantsAdmin && state.user.role === 'admin' ? 'admin' : 'home';
      if(wantsAdmin && state.user.role !== 'admin'){history.replaceState({},'','/');toast('Admin access is restricted to administrator accounts.','error');}
      go(initialPage,false);
      if(initialPage === 'admin') history.replaceState({},'','/admin');
      $('authForm').reset(); toast(authMode==='register'?'Account created successfully.':'Signed in successfully.');
      startPolling();
    } catch(error) { $('authAlert').textContent=error.message; $('authAlert').style.color='var(--red)'; }
    finally { submit.disabled=false; }
  });
  $('logoutButton').addEventListener('click', async () => {
    if(!confirm('Sign out of CKXchange on this device?')) return;
    try { await request('/api/auth/logout',{method:'POST',body:{}}); }
    catch(error) { toast(`Sign out failed: ${error.message}. Please try again.`, 'error'); return; }
    state.user=null; state.balance=0; state.reservedUsdt=0; state.banks=[]; state.transactions=[]; csrfToken='';
    // A full reload clears any admin-only markup already present in the administrator document.
    window.location.replace('/');
  });
  $('helpButton').addEventListener('click',()=>toast('CKXchange uses a backend database. Blockchain deposits still require independent admin verification, and payouts are manually completed through an authorized bank/provider.'));
  $('sendAmount').addEventListener('input',updateSendEstimate);
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
  $('sendForm').addEventListener('submit',async event=>{
    event.preventDefault(); const bankId=$('sendBank').value; const amountInr=Number($('sendAmount').value);
    if(!bankId){toast('Choose a saved bank account first.','error');return;}
    if(!Number.isFinite(amountInr)||amountInr<=0){toast('Enter a valid INR amount.','error');return;}
    const submit=$('sendSubmit');submit.disabled=true;
    try {
      const result=await request('/api/payouts',{method:'POST',body:{bankId,amountInr}});
      await refreshState({quiet:true}); $('sendForm').reset(); updateSendEstimate(); openReceipt(state.transactions.find(t=>t.id===result.transaction.id)||result.transaction); toast('Payout request submitted and balance reserved. Status: Pending.');
    } catch(error) {toast(error.message,'error');}
    finally {submit.disabled=false;}
  });
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
    const submit=$('depositSubmit');submit.disabled=true;
    try {
      const result=await request('/api/deposits',{method:'POST',body:{amountUsdt,network,txHash}}); await refreshState({quiet:true}); $('depositForm').reset(); updateDepositEstimate(); await updateDepositAddress(); toast(`Deposit ${result.transaction.id} submitted. Status: Pending.`); go('history'); $('historyFilter').value='deposit'; renderHistoryTable();
    } catch(error) {toast(error.message,'error');}
    finally {submit.disabled=!networkConfig.depositConfigured;}
  });
  $('historyFilter').addEventListener('change',renderHistoryTable);
  $('downloadReceipt').addEventListener('click',async()=>{if(!currentReceipt)return;try{const latest=state.transactions.find(t=>t.id===currentReceipt.id);await downloadReceiptImage(latest||currentReceipt);toast('Payout slip downloaded as a PNG image.');}catch(error){toast(error.message,'error');}});
  $('closeReceipt').addEventListener('click',closeReceipt); $('receiptDone').addEventListener('click',closeReceipt);
  $('receiptModal').addEventListener('click',event=>{if(event.target===$('receiptModal'))closeReceipt();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('receiptModal').classList.contains('open'))closeReceipt();});
  window.addEventListener('popstate',()=>{
    if(isAdminPath()) {
      if(state.user?.role==='admin') go('admin',false);
      else { history.replaceState({}, '', '/'); go('home',false); toast('Administrator access is restricted to administrator accounts.','error'); }
    } else go('home',false);
  });
  // No browser-local wallet state is used. Periodic refresh makes admin status changes visible to the user.
  setAuthMode('login');
  updateDepositEstimate();
  initialize();
})();
