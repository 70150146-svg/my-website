<?php
/*
 * exchange_token.php
 * Server-side Facebook token exchange.
 * Short-lived user token → Long-lived user token → Long-lived page tokens (60 days)
 */

header('Content-Type: application/json');

/* ── Facebook App Credentials ──────────────────────────── */
define('FB_APP_ID',     '1077082944153784');
define('FB_APP_SECRET', 'bda5ba68e4e8b6bd8fc9396209b07ef9'); // ← apna App Secret yahan daalen
define('FB_API_VER',    'v19.0');

/* ── Only POST allowed ─────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

/* ── Rate limit: max 10 requests per minute per IP ─────── */
session_start();
$_ip  = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$_key = 'xchg_' . md5($_ip);
if (!isset($_SESSION[$_key])) {
    $_SESSION[$_key] = ['count' => 0, 'window' => time()];
}
if (time() - $_SESSION[$_key]['window'] > 60) {
    $_SESSION[$_key] = ['count' => 0, 'window' => time()];
}
$_SESSION[$_key]['count']++;
if ($_SESSION[$_key]['count'] > 10) {
    http_response_code(429);
    echo json_encode(['error' => 'Too many requests. Please wait a minute.']);
    exit;
}

/* ── Read short-lived user token from request ──────────── */
$input      = json_decode(file_get_contents('php://input'), true);
$shortToken = trim($input['user_token'] ?? '');

if (!$shortToken) {
    http_response_code(400);
    echo json_encode(['error' => 'user_token is required']);
    exit;
}

/* ── cURL helper ───────────────────────────────────────── */
function fb_get($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'PHP/FacebookTokenExchange',
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    curl_close($ch);
    if ($err) return null;
    return json_decode($body, true);
}

/* ── Step 1: Short-lived user token → Long-lived user token */
$exchangeUrl = 'https://graph.facebook.com/' . FB_API_VER . '/oauth/access_token?' . http_build_query([
    'grant_type'        => 'fb_exchange_token',
    'client_id'         => FB_APP_ID,
    'client_secret'     => FB_APP_SECRET,
    'fb_exchange_token' => $shortToken,
]);

$data = fb_get($exchangeUrl);

if (!$data || empty($data['access_token'])) {
    $msg = $data['error']['message'] ?? 'Token exchange failed. Check App Secret.';
    http_response_code(400);
    echo json_encode(['error' => $msg]);
    exit;
}

$longLivedUserToken = $data['access_token'];

/* ── Step 2: Fetch pages using long-lived user token ─────
   Pages fetched with a long-lived user token get
   long-lived page tokens (~60 days). */
$pagesUrl = 'https://graph.facebook.com/' . FB_API_VER . '/me/accounts?' . http_build_query([
    'fields'       => 'id,name,access_token,category,picture.type(large)',
    'access_token' => $longLivedUserToken,
]);

$pagesData = fb_get($pagesUrl);

if (!$pagesData || isset($pagesData['error'])) {
    $msg = $pagesData['error']['message'] ?? 'Failed to fetch pages';
    http_response_code(400);
    echo json_encode(['error' => $msg]);
    exit;
}

/* ── Return long-lived page tokens ─────────────────────── */
echo json_encode([
    'success' => true,
    'pages'   => $pagesData['data'] ?? [],
]);
