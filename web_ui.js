// web_ui.js — Web/localhost UI controller for Pro Facebook Page Messenger
// Requires fb_api.js to be loaded first. Calls fb_api.js functions directly.
// For the Chrome extension, use popup.js (which communicates via service_worker.js).

const $ = (id) => document.getElementById(id);
const pct = (n) => `${Math.round((n || 0) * 100)}%`;

// ── ETA helper ─────────────────────────────────────────
let sendStartTime = null;

function formatEta(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60)  return `~${s}s left`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s left` : `~${m}m left`;
}

function updateEta(done, total, delayMs) {
  const el = $('etaText');
  if (!el) return;
  if (!done || !total || done >= total) { el.textContent = ''; return; }
  const remaining  = total - done;
  const elapsedMs  = Date.now() - (sendStartTime || Date.now());
  const msPerItem  = elapsedMs / done;
  const eta        = remaining * (msPerItem || delayMs);
  el.textContent   = formatEta(eta);
}

// ── DOM references ─────────────────────────────────────
const btnLogin           = $('btnLogin');
const btnFetchPages      = $('btnFetchPages');
const pageSelect         = $('pageSelect');
const pageCardsContainer = $('pageCards');
const btnLoadConvos      = $('btnLoadConvos');
const btnStart           = $('btnStart');
const btnPause           = $('btnPause');
const btnResume          = $('btnResume');
const btnStop            = $('btnStop');
const recipientFilter    = $('recipientFilter');
const messageText        = $('messageText');
const statusBar          = $('statusBar');
const recipientsDiv      = $('recipients');
const statTotal          = $('statTotal');
const statSent           = $('statSent');
const statFailed         = $('statFailed');
const progressBar        = $('progressBar');
const delayMs            = $('delayMs');
const charCount          = $('charCount');
const recipientCount     = $('recipientCount');
const progressPct        = $('progressPct');
const loginStatus        = $('loginStatus');
const sendHint           = $('sendHint');

let allRecipients = [];


// ── UI helpers ─────────────────────────────────────────
function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
}

let statusTimer;
function showStatus(msg, type = 'info') {
  clearTimeout(statusTimer);
  statusBar.textContent = msg;
  statusBar.className = `status-bar status-bar--${type}`;
  statusBar.style.display = 'block';
  statusTimer = setTimeout(() => { statusBar.style.display = 'none'; }, 5000);
}

function setLoginOnline() {
  if (!loginStatus) return;
  loginStatus.className = 'login-status login-status--online';
  loginStatus.querySelector('.login-status__text').textContent = 'Connected';
}

function updateSendHint() {
  if (!sendHint) return;
  const pageId = pageSelect?.value;
  const count  = allRecipients.length;
  if (!pageId)   { sendHint.textContent = 'Select a page and load conversations first'; return; }
  if (!count)    { sendHint.textContent = 'Load conversations to see recipients'; return; }
  const filtered = getFilteredRecipients().length;
  sendHint.textContent = `Will send to ${filtered} recipient${filtered !== 1 ? 's' : ''}`;
}

// ── Pages rendering (clickable cards) ────────────────
function renderPages(pages) {
  pageCardsContainer.innerHTML = '';
  pageSelect.innerHTML = '';

  if (!pages || pages.length === 0) {
    pageCardsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__text">No pages found.</div>
      </div>`;
    return;
  }

  (pages || []).forEach(p => {
    // Keep hidden select in sync for value reads
    const opt = document.createElement('option');
    opt.value = p.id;
    pageSelect.appendChild(opt);

    // Visual card
    const picUrl = p.picture?.data?.url || '';
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = p.id;
    card.innerHTML = `
      ${picUrl
        ? `<img class="page-card__logo" src="${picUrl}" alt="">`
        : `<div class="page-card__logo page-card__logo--placeholder">📄</div>`}
      <div class="page-card__info">
        <div class="page-card__name">${p.name}</div>
        ${p.category ? `<div class="page-card__category">${p.category}</div>` : ''}
      </div>
      <div class="page-card__check">✓</div>
    `;
    card.addEventListener('click', () => {
      pageCardsContainer.querySelectorAll('.page-card').forEach(c => c.classList.remove('page-card--selected'));
      card.classList.add('page-card--selected');
      pageSelect.value = p.id;
      updateSendHint();
    });
    pageCardsContainer.appendChild(card);
  });

  // Auto-select first page
  if (pages.length > 0) {
    pageCardsContainer.querySelector('.page-card')?.click();
  }
}

// ── Recipients ─────────────────────────────────────────
function getFilteredRecipients() {
  const filter = recipientFilter?.value || 'all';
  if (filter === 'all') return allRecipients;
  if (filter.startsWith('status:')) {
    const s = filter.slice(7);
    return allRecipients.filter(r => r.status === s);
  }
  if (filter.startsWith('label:')) {
    const lbl = filter.slice(6);
    return allRecipients.filter(r => (r.labels || []).includes(lbl));
  }
  return allRecipients;
}

function buildFilterOptions(labelMap) {
  if (!recipientFilter) return;
  recipientFilter.querySelectorAll('[data-label]').forEach(o => o.remove());

  const allLabels = new Set();
  Object.values(labelMap || {}).forEach(labels => labels.forEach(l => allLabels.add(l)));
  if (allLabels.size === 0) return;

  const sep = document.createElement('option');
  sep.disabled = true;
  sep.textContent = '── Labels ──';
  sep.dataset.label = '1';
  recipientFilter.appendChild(sep);

  allLabels.forEach(label => {
    const opt = document.createElement('option');
    opt.value = `label:${label}`;
    opt.textContent = label.charAt(0).toUpperCase() + label.slice(1);
    opt.dataset.label = '1';
    recipientFilter.appendChild(opt);
  });
}

function renderRecipients() {
  const list = getFilteredRecipients();
  if (recipientCount) recipientCount.textContent = list.length;
  recipientsDiv.innerHTML = '';

  if (list.length === 0) {
    recipientsDiv.innerHTML = `
      <div class="table-empty">
        <div class="table-empty__icon">${allRecipients.length === 0 ? '💬' : '🔍'}</div>
        <div>${allRecipients.length === 0
          ? 'No recipients yet.<br>Load conversations to begin.'
          : 'No recipients match the current filter.'}</div>
      </div>`;
    return;
  }

  list.forEach(r => {
    const row = document.createElement('div');
    row.className = 'table__row';
    row.dataset.id = r.id;
    const labelBadges = (r.labels || []).map(l =>
      `<span class="badge badge--label">${l}</span>`
    ).join('');
    row.innerHTML = `
      <div class="mono">${r.id}</div>
      <div class="status-cell">
        <span class="badge badge--send-status badge--${r.status}">${r.status}</span>
        ${labelBadges}
      </div>
      <div class="error" title="${r.error || ''}">${r.error || ''}</div>
    `;
    recipientsDiv.appendChild(row);
  });
  updateSendHint();
}

function updateStats() {
  const total  = allRecipients.length;
  const sent   = allRecipients.filter(r => r.status === 'sent').length;
  const failed = allRecipients.filter(r => r.status === 'failed').length;
  statTotal.textContent  = total;
  statSent.textContent   = sent;
  statFailed.textContent = failed;

  const ratio = total ? (sent + failed) / total : 0;
  progressBar.style.width = pct(ratio);
  if (progressPct) progressPct.textContent = pct(ratio);
  if (recipientCount) recipientCount.textContent = getFilteredRecipients().length;
}

function updateRecipientRow(item) {
  const r = allRecipients.find(r => r.id === item.id);
  if (r) { r.status = item.status; r.error = item.error || ''; }

  const row = recipientsDiv.querySelector(`[data-id="${item.id}"]`);
  if (!row) return;
  const badge = row.querySelector('.badge--send-status');
  const error = row.querySelector('.error');
  if (badge) { badge.className = `badge badge--${item.status}`; badge.textContent = item.status; }
  if (error) { error.textContent = item.error || ''; error.title = item.error || ''; }
}

// ── Storage init ───────────────────────────────────────
function initFromStorage() {
  try {
    const queue = JSON.parse(localStorage.getItem('send_queue') || '[]');
    if (queue.length > 0) { allRecipients = queue; renderRecipients(); updateStats(); }
  } catch (_) {}
}

// ── Event wiring ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initFromStorage();
  recipientFilter?.addEventListener('change', () => { renderRecipients(); updateSendHint(); });

  // Character counter
  messageText?.addEventListener('input', () => {
    const len = messageText.value.length;
    if (charCount) {
      charCount.textContent = `${len} / 2000`;
      charCount.className = len >= 2000 ? 'char-counter char-counter--danger'
                          : len >= 1600 ? 'char-counter char-counter--warning'
                          : 'char-counter';
    }
  });

  // Ctrl+Enter shortcut to start sending
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (btnStart && !btnStart.disabled) btnStart.click();
    }
  });
});

btnLogin.addEventListener('click', async () => {
  setLoading(btnLogin, true);
  try {
    await startFacebookLogin();
    setLoginOnline();
    showStatus('Logged in. Click "Refresh" to load your Pages.', 'success');
  } catch (e) {
    showStatus(e.message || 'Login failed.', 'error');
  }
  setLoading(btnLogin, false);
});

btnFetchPages.addEventListener('click', async () => {
  setLoading(btnFetchPages, true);
  try {
    const pages = await fetchUserPages();
    renderPages(pages || []);
    showStatus(`${(pages || []).length} page(s) loaded.`, 'success');
  } catch (e) {
    showStatus(e.message || 'Failed to fetch pages.', 'error');
  }
  setLoading(btnFetchPages, false);
});

btnLoadConvos.addEventListener('click', async () => {
  const pageId = pageSelect.value;
  if (!pageId) return showStatus('Select a page first.', 'warning');
  setLoading(btnLoadConvos, true);
  try {
    const { psids, labelMap } = await fetchConversations(pageId, ({ fetched, total, pct }) => {
      const msg = (pct != null)
        ? `Fetching… ${pct}% (${fetched} of ${total} conversations)`
        : `Fetching… ${fetched} conversations loaded`;
      showStatus(msg, 'info');
    });
    allRecipients = (psids || []).map(id => ({
      id,
      status: 'pending',
      error:  '',
      labels: labelMap?.[id] || []
    }));
    buildFilterOptions(labelMap || {});
    renderRecipients();
    updateStats();
    if (allRecipients.length === 0) {
      showStatus('No conversations found. Only users who previously messaged the Page are eligible.', 'warning');
    } else {
      const labelCount = Object.values(labelMap || {}).flat().filter(Boolean).length;
      const labelMsg   = labelCount > 0 ? ` Labels loaded in filter.` : ' No labels found on conversations.';
      showStatus(`${allRecipients.length} recipient(s) loaded.${labelMsg}`, 'success');
    }
  } catch (e) {
    showStatus(e.message || 'Failed to load conversations.', 'error');
  }
  setLoading(btnLoadConvos, false);
});

btnStart.addEventListener('click', async () => {
  const pageId = pageSelect.value;
  const text   = messageText.value.trim();
  const delay  = Math.max(500, parseInt(delayMs.value, 10) || 1200);
  if (!pageId)               return showStatus('Select a page first.', 'warning');
  if (!text)                 return showStatus('Enter a message to send.', 'warning');
  if (!allRecipients.length) return showStatus('Load conversations first.', 'warning');

  const recipientIds = getFilteredRecipients().map(r => r.id);
  sendStartTime = Date.now();
  progressBar?.classList.add('progress__bar--active');
  setLoading(btnStart, true);
  try {
    await enqueueAndSendUtility({
      pageId,
      messageText: text,
      recipientIds,
      delayMs: delay,
      onProgress: ({ index, total, item }) => {
        updateRecipientRow(item);
        updateStats();
        updateEta(index, total, delay);
      },
      onDone: () => {
        progressBar?.classList.remove('progress__bar--active');
        setLoading(btnStart, false);
        if ($('etaText')) $('etaText').textContent = '';
        showStatus('All messages processed.', 'success');
      }
    });
  } catch (e) {
    progressBar?.classList.remove('progress__bar--active');
    showStatus(e.message || 'Failed to start sending.', 'error');
    setLoading(btnStart, false);
  }
});

btnPause.addEventListener('click',  () => { pauseSending();  showStatus('Paused.', 'warning'); });
btnResume.addEventListener('click', () => { resumeSending(); showStatus('Resumed.', 'info'); });
btnStop.addEventListener('click',   () => {
  stopSending();
  progressBar?.classList.remove('progress__bar--active');
  setLoading(btnStart, false);
  if ($('etaText')) $('etaText').textContent = '';
  showStatus('Stopped.', 'error');
});


