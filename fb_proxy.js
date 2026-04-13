/*
 * api/fb_proxy.js
 * Vercel serverless function — replaces fb_proxy.php
 * Routes all browser API calls through the server to bypass ISP blocks.
 *
 * Accepts POST with JSON body:
 *   { method: 'GET'|'POST', path: 'me/accounts', token: '...', params: {}, body: {} }
 *   { method: 'GET', url: 'https://graph.facebook.com/...', token: '' }  ← pagination
 *   { method: 'UPLOAD_IMAGE', page_id, token, image_data (base64), mime_type }
 */

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  /* ── Only POST allowed ──────────────────────────────── */
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    method,
    path,
    token,
    params  = {},
    body    = {},
    url: fullUrl,
  } = req.body || {};

  const fbMethod = (method || 'GET').toUpperCase();

  /* ── Image upload (base64 → Facebook attachment_id) ──── */
  if (fbMethod === 'UPLOAD_IMAGE') {
    const { page_id: pageId, token: uploadToken, image_data: imgB64, mime_type: mimeType = 'image/jpeg' } = req.body;

    if (!pageId || !uploadToken || !imgB64) {
      return res.status(400).json({ error: 'page_id, token, image_data required' });
    }

    const imgBuffer = Buffer.from(imgB64, 'base64');
    if (!imgBuffer || imgBuffer.length === 0) {
      return res.status(400).json({ error: 'Invalid base64 image data' });
    }

    const extMap = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
    const ext    = extMap[mimeType] || 'jpg';

    const apiUrl   = `https://graph.facebook.com/v21.0/${pageId}/message_attachments?access_token=${encodeURIComponent(uploadToken)}`;
    const formData = new FormData();
    formData.append('message', JSON.stringify({
      attachment: { type: 'image', payload: { is_reusable: true } },
    }));
    formData.append('filedata', new Blob([imgBuffer], { type: mimeType }), `upload.${ext}`);

    let upRes;
    try {
      upRes = await fetch(apiUrl, { method: 'POST', body: formData });
    } catch (e) {
      return res.status(502).json({ error: 'Upload connection error: ' + e.message });
    }
    const upText = await upRes.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upRes.status).send(upText);
  }

  /* ── Build target URL ───────────────────────────────── */
  let targetUrl;

  if (fullUrl) {
    /* Pagination URL from Facebook — token already embedded */
    let host;
    try { host = new URL(fullUrl).hostname; } catch { host = ''; }
    if (host !== 'graph.facebook.com') {
      return res.status(400).json({ error: 'Invalid URL host' });
    }
    targetUrl = fullUrl;
  } else if (path) {
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }
    const qs = new URLSearchParams({ ...params, access_token: token });
    targetUrl = `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}?${qs}`;
  } else {
    return res.status(400).json({ error: 'path or url is required' });
  }

  /* ── cURL-equivalent fetch ──────────────────────────── */
  const fetchOpts = {};

  if (fbMethod === 'POST') {
    /* For POST, add token to URL; body goes as form-urlencoded */
    if (token && !targetUrl.includes('access_token=')) {
      targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    }
    const formBody = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      formBody.append(k, (typeof v === 'object') ? JSON.stringify(v) : String(v));
    }
    fetchOpts.method  = 'POST';
    fetchOpts.body    = formBody.toString();
    fetchOpts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  } else {
    fetchOpts.method = 'GET';
  }

  let fbRes;
  try {
    fbRes = await fetch(targetUrl, fetchOpts);
  } catch (e) {
    return res.status(502).json({ error: 'Proxy connection error: ' + e.message });
  }

  const text = await fbRes.text();
  res.setHeader('Content-Type', 'application/json');
  return res.status(fbRes.status).send(text);
}
