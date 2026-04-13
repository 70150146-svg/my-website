// fb_api.js — Web/localhost Facebook Graph API helpers
// Used by index.html for local development and testing.
// For the Chrome extension, all API calls go through service_worker.js instead.

const FB_AUTH = {
  appId:       '1077082944153784',
  redirectUri: window.location.origin + '/oauth_callback.html',
  scopes:      ['pages_show_list', 'pages_read_engagement', 'pages_messaging']
};

const STORAGE_KEYS = {
  USER_TOKEN: 'fb_user_token',
  PAGES:      'fb_pages',
  THREAD_MAP: 'fb_thread_by_psid',
  QUEUE:      'send_queue'
};

// Volatile state for the active send session
let runtime = { isSending: false, paused: false, currentIndex: 0 };

// ── Facebook OAuth (postMessage flow) ─────────────────
// Uses oauth_callback.html as redirect target.
// oauth_callback.html posts the token back via window.postMessage —
// no cross-origin polling, no chrome-error:// issues.
async function startFacebookLogin() {
  const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  authUrl.searchParams.set('client_id',     FB_AUTH.appId);
  authUrl.searchParams.set('redirect_uri',  FB_AUTH.redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('display',       'popup');
  authUrl.searchParams.set('scope',         FB_AUTH.scopes.join(','));

  return new Promise((resolve, reject) => {
    const popup = window.open(authUrl.toString(), 'fbLogin', 'width=600,height=700');
    if (!popup) return reject(new Error('Popup blocked. Please allow popups for this page.'));

    // Listen for token posted back from oauth_callback.html
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'fb_oauth') return;

      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);

      const hash      = event.data.hash || '';
      const params    = new URLSearchParams(hash.replace(/^#/, ''));
      const token     = params.get('access_token');
      const expiresIn = Number(params.get('expires_in') || 0);

      if (!token) return reject(new Error('No access token received.'));

      localStorage.setItem(STORAGE_KEYS.USER_TOKEN, JSON.stringify({
        token,
        expiresAt: Date.now() + expiresIn * 1000
      }));

      // ── Server-side long-lived token exchange ──────────
      fetch('/api/exchange_token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ user_token: token }),
      })
        .then(r => r.json())
        .then(xData => {
          if (xData.success && xData.pages?.length > 0) {
            localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(xData.pages));
          }
        })
        .catch(() => {}) // silent — user can still click Refresh
        .finally(() => resolve(token));
    }

    window.addEventListener('message', onMessage);

    // Fallback: if user closes popup without logging in
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(closedTimer);
        window.removeEventListener('message', onMessage);
        reject(new Error('Login window closed before completing authentication.'));
      }
    }, 500);
  });
}

// ── Graph API helpers (routed through server proxy) ────
// All calls go via fb_proxy.php so Pakistani ISP blocks are bypassed.

async function fbGet(path, token, params = {}) {
  const res  = await fetch('/api/fb_proxy', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ method: 'GET', path, token, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function fbGetUrl(fullUrl) {
  // For pagination: full URL from Facebook (token already embedded)
  const res  = await fetch('/api/fb_proxy', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ method: 'GET', url: fullUrl, token: '' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function fbPost(path, token, body) {
  const res  = await fetch('/api/fb_proxy', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ method: 'POST', path, token, body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ── Fetch user's Pages (with thumbnails) ──────────────
// Uses server-side exchange to get long-lived page tokens (~60 days).
async function fetchUserPages() {
  const stored    = localStorage.getItem(STORAGE_KEYS.USER_TOKEN);
  const userToken = stored ? JSON.parse(stored) : null;
  if (!userToken?.token) throw new Error('Not logged in.');

  // Try server-side exchange first (long-lived tokens)
  try {
    const xRes  = await fetch('/api/exchange_token', {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ user_token: userToken.token }),
    });
    if (xRes.ok) {
      const xText = await xRes.text();
      let xData;
      try { xData = JSON.parse(xText); } catch { throw new Error('Invalid server response'); }
      if (xData.success && xData.pages) {
        localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(xData.pages));
        return xData.pages;
      }
      if (xData.error) throw new Error(xData.error);
    }
  } catch (e) {
    if (e.message && !e.message.includes('fetch')) throw e;
    // Network error — fall through to direct API call
  }

  // Fallback: direct Graph API call (short-lived tokens)
  const data  = await fbGet('me/accounts', userToken.token, {
    fields: 'id,name,access_token,category,picture.type(large)'
  });
  const pages = data.data || [];
  localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(pages));
  return pages;
}

// ── Fetch conversations and extract PSIDs ──────────────
async function fetchConversations(pageId, onProgress) {
  const pages = JSON.parse(localStorage.getItem(STORAGE_KEYS.PAGES) || '[]');
  const page  = pages.find(p => p.id === pageId);
  if (!page) throw new Error('Page not found. Please refresh your Pages.');

  // System/folder tags that Facebook adds automatically — we want to ignore these
  const SYSTEM_TAGS = new Set([
    'INBOX', 'DONE', 'FOLLOW_UP', 'OPEN', 'UNREAD', 'SPAM', 'IN_PROGRESS',
    'MESSENGER', 'INSTAGRAM_DIRECT', 'OTHER'
  ]);

  // ── Fetch conversations + embedded tags ────────────────
  const allConvos = [];
  const psidMap   = {};
  const psids     = [];
  const labelMap  = {};
  let   totalCount = 0;

  // First page via path-based proxy call
  let data = await fbGet(`${page.id}/conversations`, page.access_token, {
    fields: 'id,participants,tags,can_reply',
    limit:  '200',
    summary: 'true',
  });
  let nextUrl = true; // sentinel to enter loop

  while (nextUrl) {
    if (data.error) throw new Error(data.error.message || 'Facebook API error.');

    // Grab total count from first response summary (for % calculation)
    if (!totalCount && data.summary?.total_count) {
      totalCount = data.summary.total_count;
    }

    for (const convo of (data.data || [])) {
      // Skip conversations where the user has blocked the page (or page blocked user)
      if (convo.can_reply === false) continue;

      // Extract only user-created labels (skip system folder tags)
      const labels = (convo.tags?.data || [])
        .map(t => t.name)
        .filter(n => n && !SYSTEM_TAGS.has(n.toUpperCase()));

      for (const p of (convo.participants?.data || [])) {
        if (!p?.id || p.id === page.id) continue;
        psidMap[p.id] = convo.id;
        if (labels.length) {
          if (!labelMap[p.id]) labelMap[p.id] = [];
          labels.forEach(l => { if (!labelMap[p.id].includes(l)) labelMap[p.id].push(l); });
        }
        psids.push(p.id);
      }
    }
    allConvos.push(...(data.data || []));
    const paginationNext = data.paging?.next || null;

    // Report progress after each page
    if (onProgress) {
      const pct = totalCount ? Math.min(Math.round((psids.length / totalCount) * 100), 99) : null;
      onProgress({ fetched: psids.length, total: totalCount, pct });
    }

    if (!paginationNext) break;
    // Load next page via full URL proxy (token already embedded in Facebook's pagination URL)
    data    = await fbGetUrl(paginationNext);
    nextUrl = true; // keep loop going
  }

  localStorage.setItem(STORAGE_KEYS.THREAD_MAP, JSON.stringify(psidMap));

  return { page, convos: allConvos, psids: [...new Set(psids)], labelMap };
}

// ── Bulk send queue ────────────────────────────────────
async function enqueueAndSendUtility({ pageId, messageText, recipientIds, delayMs = 1200, onProgress, onDone }) {
  const pages = JSON.parse(localStorage.getItem(STORAGE_KEYS.PAGES) || '[]');
  const page  = pages.find(p => p.id === pageId);
  if (!page) throw new Error('Page not found.');

  const queue = recipientIds.map(id => ({ id, status: 'pending', error: '' }));
  localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));

  runtime.isSending    = true;
  runtime.paused       = false;
  runtime.currentIndex = 0;

  for (let i = 0; i < queue.length; i++) {
    if (!runtime.isSending) break;
    while (runtime.paused) await new Promise(r => setTimeout(r, 250));

    const item = queue[i];
    try {
      await fbPost(`${page.id}/messages`, page.access_token, {
        recipient:      { id: item.id },
        message:        { text: messageText },
        messaging_type: 'UTILITY'
      });
      item.status = 'sent';
      item.error  = '';
    } catch (e) {
      item.status = 'failed';
      item.error  = e?.message || String(e);
    }

    runtime.currentIndex = i + 1;
    localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
    if (onProgress) onProgress({ index: runtime.currentIndex, total: queue.length, item });
    await new Promise(r => setTimeout(r, delayMs));
  }

  if (onDone) onDone();
}

// ── Controls ───────────────────────────────────────────
function pauseSending()  { runtime.paused    = true;  }
function resumeSending() { runtime.paused    = false; }
function stopSending()   { runtime.isSending = false; }

// Expose API for browser usage
window.startFacebookLogin = startFacebookLogin;
window.fetchUserPages = fetchUserPages;
window.fetchConversations = fetchConversations;
window.enqueueAndSendUtility = enqueueAndSendUtility;
window.pauseSending = pauseSending;
window.resumeSending = resumeSending;
window.stopSending = stopSending;
