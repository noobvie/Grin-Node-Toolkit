<?php
/**
 * Grin Wallet API Proxy — Owner API v3 (encrypted)
 *
 * Wraps every JSON-RPC call in encrypted_request_v3 using the AES key
 * and wallet token established during login (stored in PHP session).
 * receive_tx is routed to the Foreign API v2 (plaintext).
 */

ini_set('session.gc_maxlifetime', 3600);
ini_set('session.use_strict_mode', '1');
session_set_cookie_params([
    'lifetime' => 0,
    'path'     => '/',
    'secure'   => true,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

header('Content-Type: application/json');
header('Cache-Control: no-store');

// ── Session idle timeout ──────────────────────────────────────────────────────
if (isset($_SESSION['last_activity']) && (time() - $_SESSION['last_activity']) > 3600) {
    session_unset();
    session_destroy();
    http_response_code(401);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Session expired — please log in again']]);
    exit;
}

// ── Auth check ────────────────────────────────────────────────────────────────
if (empty($_SESSION['wallet_token']) || empty($_SESSION['aes_key'])) {
    http_response_code(401);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Not authenticated']]);
    exit;
}
$_SESSION['last_activity'] = time();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Method Not Allowed']]);
    exit;
}

// ── Load config ───────────────────────────────────────────────────────────────
$cfgFile = '/opt/grin/conf/grin_web_wallet_api.json';
if (!file_exists($cfgFile) || !is_readable($cfgFile)) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Server config missing']]);
    exit;
}
$config = json_decode(file_get_contents($cfgFile), true);
$host   = (string)($config['walletHost']     ?? '127.0.0.1');
$port   = (int)   ($config['walletPort']     ?? 3415);
$secret = (string)($config['ownerApiSecret'] ?? '');

if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true)) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Wallet host must be localhost']]);
    exit;
}

$token  = $_SESSION['wallet_token'];
$aesKey = base64_decode($_SESSION['aes_key']);

// ── Method routing ────────────────────────────────────────────────────────────
// Owner API v3 methods (encrypted)
$ownerMethods = [
    'get_info'     => 'retrieve_summary_info',
    'get_balance'  => 'retrieve_summary_info',
    'retrieve_txs' => 'retrieve_txs',
    'init_send_tx' => 'init_send_tx',
    'finalize_tx'  => 'finalize_tx',
    'cancel_tx'    => 'cancel_tx',
    'estimate_fee' => 'estimate_fee',
];
// Foreign API v2 methods (plaintext)
$foreignMethods = [
    'receive_tx' => 'receive_tx',
];

// ── Parse request ─────────────────────────────────────────────────────────────
$body = file_get_contents('php://input');
if (empty($body)) {
    http_response_code(400);
    echo json_encode(['error' => ['code' => -32700, 'message' => 'Empty request body']]);
    exit;
}
$data = json_decode($body, true);
if (!$data || ($data['jsonrpc'] ?? '') !== '2.0' || !isset($data['method'])) {
    http_response_code(400);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Invalid JSON-RPC 2.0 request']]);
    exit;
}

$method = $data['method'];
$params = $data['params'] ?? [];
$id     = $data['id'] ?? 1;

// ── Dispatch ──────────────────────────────────────────────────────────────────

if ($method === 'send_http') {
    handleHttpSend($host, $port, $secret, $aesKey, $token, $params);
    exit;
}

if (isset($ownerMethods[$method])) {
    $mapped  = $ownerMethods[$method];
    $payload = ['jsonrpc' => '2.0', 'method' => $mapped, 'params' => array_merge(['token' => $token], $params), 'id' => $id];
    echo json_encode(ownerCall($host, $port, $secret, $aesKey, $payload));
    exit;
}

if (isset($foreignMethods[$method])) {
    $mapped  = $foreignMethods[$method];
    $payload = ['jsonrpc' => '2.0', 'method' => $mapped, 'params' => $params, 'id' => $id];
    echo json_encode(foreignCall($host, $port, $secret, $payload));
    exit;
}

http_response_code(400);
echo json_encode(['error' => ['code' => -32601, 'message' => "Method not allowed: $method"]]);

// ── Owner API (encrypted) call ────────────────────────────────────────────────
function ownerCall(string $host, int $port, string $secret, string $aesKey, array $payload): array {
    $nonce = random_bytes(12);
    $tag   = '';
    $ct    = openssl_encrypt(json_encode($payload), 'aes-256-gcm', $aesKey, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($ct === false) return ['error' => ['code' => -32000, 'message' => 'Encryption failed']];

    $encReq = [
        'jsonrpc' => '2.0',
        'method'  => 'encrypted_request_v3',
        'params'  => [
            'nonce'    => bin2hex($nonce),
            'body_enc' => base64_encode($ct . $tag),
        ],
        'id' => $payload['id'] ?? 1,
    ];

    $raw = rawOwnerCall($host, $port, $secret, $encReq);
    if (isset($raw['error'])) return $raw;

    $encBody = $raw['result']['Ok'] ?? null;
    if (!$encBody || !is_array($encBody)) {
        return ['error' => ['code' => -32000, 'message' => 'No encrypted body in wallet response']];
    }

    $plain = decryptBody($encBody, $aesKey);
    if ($plain === null) return ['error' => ['code' => -32000, 'message' => 'Response decryption failed']];

    $resp = json_decode($plain, true);
    if (!$resp) return ['error' => ['code' => -32700, 'message' => 'Invalid JSON in decrypted response']];

    return normalizeResponse($resp);
}

// ── Foreign API (plaintext) call ──────────────────────────────────────────────
function foreignCall(string $host, int $port, string $secret, array $payload): array {
    try {
        $socket = fsockopen($host, $port, $errno, $errstr, 10);
        if (!$socket) throw new Exception("Cannot connect to wallet: $errstr ($errno)");
        $json = json_encode($payload);
        $auth = $secret !== '' ? "Authorization: Basic " . base64_encode(':' . $secret) . "\r\n" : '';
        $req  = "POST /v2/foreign HTTP/1.1\r\n"
              . "Host: $host:$port\r\n"
              . "Content-Type: application/json\r\n"
              . "Content-Length: " . strlen($json) . "\r\n"
              . $auth
              . "Connection: close\r\n"
              . "\r\n"
              . $json;
        fwrite($socket, $req);
        stream_set_timeout($socket, 30);
        $raw = '';
        while (!feof($socket)) $raw .= fgets($socket, 4096);
        fclose($socket);
        $parts = explode("\r\n\r\n", $raw, 2);
        if (count($parts) !== 2) throw new Exception('Invalid HTTP response from wallet');
        $status = (int)(explode(' ', $parts[0])[1] ?? 0);
        if ($status !== 200) throw new Exception("Wallet returned HTTP $status");
        $resp = json_decode($parts[1], true);
        if (!$resp) throw new Exception('Invalid JSON from wallet');
        return normalizeResponse($resp);
    } catch (Exception $e) {
        return ['error' => ['code' => -32000, 'message' => $e->getMessage()]];
    }
}

// ── Raw HTTP call to /v3/owner ────────────────────────────────────────────────
function rawOwnerCall(string $host, int $port, string $secret, array $payload): array {
    try {
        $socket = fsockopen($host, $port, $errno, $errstr, 10);
        if (!$socket) throw new Exception("Cannot connect to wallet: $errstr ($errno)");
        $json = json_encode($payload);
        $auth = $secret !== '' ? "Authorization: Basic " . base64_encode(':' . $secret) . "\r\n" : '';
        $req  = "POST /v3/owner HTTP/1.1\r\n"
              . "Host: $host:$port\r\n"
              . "Content-Type: application/json\r\n"
              . "Content-Length: " . strlen($json) . "\r\n"
              . $auth
              . "Connection: close\r\n"
              . "\r\n"
              . $json;
        fwrite($socket, $req);
        stream_set_timeout($socket, 30);
        $raw = '';
        while (!feof($socket)) $raw .= fgets($socket, 4096);
        fclose($socket);
        $parts = explode("\r\n\r\n", $raw, 2);
        if (count($parts) !== 2) throw new Exception('Invalid HTTP response from wallet');
        $status = (int)(explode(' ', $parts[0])[1] ?? 0);
        if ($status !== 200) throw new Exception("Wallet returned HTTP $status");
        $data = json_decode($parts[1], true);
        if ($data === null) throw new Exception('Invalid JSON from wallet');
        return $data;
    } catch (Exception $e) {
        return ['error' => ['code' => -32000, 'message' => $e->getMessage()]];
    }
}

// ── Decrypt response body ─────────────────────────────────────────────────────
function decryptBody(array $encBody, string $aesKey): ?string {
    $nonce = hex2bin($encBody['nonce'] ?? '');
    $full  = base64_decode($encBody['body_enc'] ?? '');
    if (!$nonce || !$full || strlen($full) < 16) return null;
    $tag   = substr($full, -16);
    $ct    = substr($full, 0, -16);
    $plain = openssl_decrypt($ct, 'aes-256-gcm', $aesKey, OPENSSL_RAW_DATA, $nonce, $tag);
    return $plain === false ? null : $plain;
}

// ── Normalize JSON-RPC response ───────────────────────────────────────────────
// Converts {"result":{"Ok":value}} → {"result":value}
// Converts {"result":{"Err":msg}}  → {"error":{...}}
function normalizeResponse(array $resp): array {
    if (!isset($resp['result'])) return $resp;
    $result = $resp['result'];

    if (isset($result['Err'])) {
        $err = $result['Err'];
        $msg = is_string($err) ? $err : json_encode($err);
        return ['error' => ['code' => -32000, 'message' => $msg], 'id' => $resp['id'] ?? null];
    }
    if (array_key_exists('Ok', $result)) {
        $resp['result'] = $result['Ok'];
    }
    return $resp;
}

// ── Server-side HTTP send (avoids browser SSRF) ───────────────────────────────
function isValidRecipientUrl(string $url): bool {
    $p = parse_url($url);
    if (!$p || ($p['scheme'] ?? '') !== 'https') return false;
    $h = strtolower($p['host'] ?? '');
    if (!$h) return false;
    foreach (['localhost', '::1', '[::1]', '0.0.0.0'] as $b) {
        if ($h === $b) return false;
    }
    foreach (['127.', '10.', '192.168.', '169.254.', 'fe80:', '::ffff:'] as $pfx) {
        if (strncmp($h, $pfx, strlen($pfx)) === 0) return false;
    }
    if (preg_match('/^172\.(1[6-9]|2[0-9]|3[01])\./', $h)) return false;
    return true;
}

function handleHttpSend(string $host, int $port, string $secret, string $aesKey, string $token, array $params): void {
    $recipientUrl = $params['recipient_url'] ?? '';
    $sendParams   = $params['send_params'] ?? [];

    if (!isValidRecipientUrl($recipientUrl)) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32602, 'message' => 'Invalid recipient URL (HTTPS only, no private addresses)']]);
        return;
    }

    // Step 1: init_send_tx
    $initPayload = ['jsonrpc' => '2.0', 'method' => 'init_send_tx',
        'params' => array_merge(['token' => $token], $sendParams), 'id' => 1];
    $initResp = ownerCall($host, $port, $secret, $aesKey, $initPayload);
    if (isset($initResp['error'])) { echo json_encode($initResp); return; }

    $slate = $initResp['result']['slate'] ?? $initResp['result'] ?? null;
    if (!$slate) { echo json_encode(['error' => ['code' => -32000, 'message' => 'init_send_tx returned no slate']]); return; }

    // Step 2: POST slate to recipient
    $ch = curl_init($recipientUrl);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode(['slate' => $slate]),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    $curlBody = curl_exec($ch);
    $curlCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlBody === false || $curlCode !== 200) {
        echo json_encode(['error' => ['code' => -32000, 'message' => "Recipient send failed (HTTP $curlCode): $curlErr"]]);
        return;
    }

    $recipResp     = json_decode($curlBody, true);
    $responseSlate = $recipResp['slate'] ?? $recipResp['result']['slate'] ?? null;
    if (!$responseSlate) {
        echo json_encode(['error' => ['code' => -32000, 'message' => 'Recipient returned no response slate']]);
        return;
    }

    // Step 3: finalize_tx
    $finalPayload = ['jsonrpc' => '2.0', 'method' => 'finalize_tx',
        'params' => ['token' => $token, 'slate' => $responseSlate, 'post_tx' => true, 'fluff' => false], 'id' => 2];
    echo json_encode(ownerCall($host, $port, $secret, $aesKey, $finalPayload));
}
?>
