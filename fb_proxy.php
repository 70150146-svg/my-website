<?php
/*
 * fb_proxy.php
 * Server-side proxy for Facebook Graph API.
 * Routes all browser API calls through the server to bypass ISP blocks.
 *
 * Accepts POST with JSON body:
 *   { method: 'GET'|'POST', path: 'me/accounts', token: '...', params: {}, body: {} }
 *   { method: 'GET', url: 'https://graph.facebook.com/...', token: '' }  ← pagination
 */

header('Content-Type: application/json');

/* ── Rate limiting (500 req/min per IP) ────────────────── */
session_start();
$_ip  = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$_key = 'fbprx_' . md5($_ip);
if (!isset($_SESSION[$_key]) || (time() - $_SESSION[$_key]['window'] > 60)) {
    $_SESSION[$_key] = ['count' => 0, 'window' => time()];
}
$_SESSION[$_key]['count']++;
if ($_SESSION[$_key]['count'] > 500) {
    http_response_code(429);
    echo json_encode(['error' => 'Too many requests. Please wait.']);
    exit;
}

/* ── Only POST allowed ─────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

/* ── Parse request ─────────────────────────────────────── */
$input   = json_decode(file_get_contents('php://input'), true);
$method  = strtoupper($input['method'] ?? 'GET');

/* ── Image upload (base64 → Facebook attachment_id) ───── */
if ($method === 'UPLOAD_IMAGE') {
    $pageId   = trim($input['page_id']   ?? '');
    $token    = trim($input['token']     ?? '');
    $imgB64   = $input['image_data']     ?? '';
    $mimeType = $input['mime_type']      ?? 'image/jpeg';

    if (!$pageId || !$token || !$imgB64) {
        http_response_code(400);
        echo json_encode(['error' => 'page_id, token, image_data required']);
        exit;
    }

    $imgBytes = base64_decode($imgB64);
    if (!$imgBytes) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid base64 image data']);
        exit;
    }

    $extMap  = ['image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    $ext     = $extMap[$mimeType] ?? 'jpg';
    $tmpPath = tempnam(sys_get_temp_dir(), 'fbimg') . '.' . $ext;
    file_put_contents($tmpPath, $imgBytes);

    $apiUrl = 'https://graph.facebook.com/v19.0/' . $pageId . '/message_attachments'
            . '?access_token=' . urlencode($token);

    $ch2 = curl_init($apiUrl);
    curl_setopt_array($ch2, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => [
            'message'  => json_encode([
                'attachment' => [
                    'type'    => 'image',
                    'payload' => ['is_reusable' => true],
                ],
            ]),
            'filedata' => new CURLFile($tmpPath, $mimeType, 'upload.' . $ext),
        ],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'PHP/FBProxy/1.0',
    ]);

    $upResp = curl_exec($ch2);
    $upCode = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
    $upErr  = curl_error($ch2);
    curl_close($ch2);
    @unlink($tmpPath);

    if ($upErr) {
        http_response_code(502);
        echo json_encode(['error' => 'Upload cURL error: ' . $upErr]);
        exit;
    }

    http_response_code($upCode);
    echo $upResp;
    exit;
}
$token   = trim($input['token'] ?? '');
$path    = trim($input['path'] ?? '');
$fullUrl = trim($input['url']  ?? '');
$params  = $input['params'] ?? [];
$body    = $input['body']   ?? [];

/* ── Build target URL ──────────────────────────────────── */
if ($fullUrl) {
    /* Pagination URL from Facebook — token already embedded */
    $host = parse_url($fullUrl, PHP_URL_HOST);
    if ($host !== 'graph.facebook.com') {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid URL host']);
        exit;
    }
    $url = $fullUrl;
} elseif ($path) {
    if (!$token) {
        http_response_code(400);
        echo json_encode(['error' => 'token is required']);
        exit;
    }
    $params['access_token'] = $token;
    $url = 'https://graph.facebook.com/v19.0/' . ltrim($path, '/') . '?' . http_build_query($params);
} else {
    http_response_code(400);
    echo json_encode(['error' => 'path or url is required']);
    exit;
}

/* ── cURL request ──────────────────────────────────────── */
$ch   = curl_init();
$opts = [
    CURLOPT_URL            => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_USERAGENT      => 'PHP/FBProxy/1.0',
];

if ($method === 'POST') {
    /* For POST, add token to URL; body goes as form-urlencoded */
    if ($token && strpos($url, 'access_token=') === false) {
        $opts[CURLOPT_URL] = $url . (strpos($url, '?') !== false ? '&' : '?') . 'access_token=' . urlencode($token);
    }
    $formBody = [];
    foreach ($body as $k => $v) {
        $formBody[$k] = (is_array($v) || is_object($v)) ? json_encode($v) : (string)$v;
    }
    $opts[CURLOPT_POST]       = true;
    $opts[CURLOPT_POSTFIELDS] = http_build_query($formBody);
    $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/x-www-form-urlencoded'];
}

curl_setopt_array($ch, $opts);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($curlErr) {
    http_response_code(502);
    echo json_encode(['error' => 'Proxy connection error: ' . $curlErr]);
    exit;
}

http_response_code($httpCode);
echo $response;
