/*
 * api/exchange_token.js
 * Vercel serverless function — replaces exchange_token.php
 * Short-lived user token → Long-lived user token → Long-lived page tokens (60 days)
 */

const FB_APP_ID  = process.env.FB_APP_ID  || '1077082944153784';
const FB_API_VER = 'v21.0';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  /* ── Only POST allowed ──────────────────────────────── */
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const FB_APP_SECRET = process.env.FB_APP_SECRET;
  if (!FB_APP_SECRET) {
    return res.status(500).json({ error: 'Server misconfiguration: FB_APP_SECRET not set' });
  }

  /* ── Read short-lived user token from request ────────── */
  const shortToken = (req.body?.user_token || '').trim();

  if (!shortToken) {
    return res.status(400).json({ error: 'user_token is required' });
  }

  /* ── Step 1: Short-lived → Long-lived user token ──────── */
  const exchangeUrl = `https://graph.facebook.com/${FB_API_VER}/oauth/access_token?` +
    new URLSearchParams({
      grant_type:        'fb_exchange_token',
      client_id:         FB_APP_ID,
      client_secret:     FB_APP_SECRET,
      fb_exchange_token: shortToken,
    });

  let data;
  try {
    const r = await fetch(exchangeUrl);
    data = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Failed to reach Facebook API' });
  }

  if (!data?.access_token) {
    const msg = data?.error?.message || 'Token exchange failed. Check App Secret.';
    return res.status(400).json({ error: msg });
  }

  const longLivedUserToken = data.access_token;

  /* ── Step 2: Fetch pages using long-lived user token ─────
     Pages fetched with a long-lived user token get
     long-lived page tokens (~60 days). */
  const pagesUrl = `https://graph.facebook.com/${FB_API_VER}/me/accounts?` +
    new URLSearchParams({
      fields:       'id,name,access_token,category,picture.type(large)',
      access_token: longLivedUserToken,
    });

  let pagesData;
  try {
    const r = await fetch(pagesUrl);
    pagesData = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch pages from Facebook' });
  }

  if (!pagesData || pagesData.error) {
    const msg = pagesData?.error?.message || 'Failed to fetch pages';
    return res.status(400).json({ error: msg });
  }

  /* ── Return long-lived page tokens ───────────────────── */
  return res.status(200).json({
    success: true,
    pages:   pagesData.data || [],
  });
}
