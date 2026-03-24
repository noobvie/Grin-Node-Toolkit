<?php
/**
 * Grin Wallet REST API Proxy — XP Edition
 *
 * Identical to 051 proxy.php except:
 *   - Config path: /opt/grin/webwallet/xp-mainnet/grin_web_wallet_api.json
 *   - Deployed under /wallet/api/ (called by the wallet iframe)
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

if (isset($_SESSION['last_activity']) && (time() - $_SESSION['last_activity']) > 3600) {
    session_unset();
    session_destroy();
    http_response_code(401);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Session expired — please reload the page']]);
    exit;
}
$_SESSION['last_activity'] = time();

header('Content-Type: application/json');

function validateCsrfToken(): bool {
    if (empty($_SESSION['csrf_token'])) return false;
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    return strlen($token) > 0 && hash_equals($_SESSION['csrf_token'], $token);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Method Not Allowed']]);
    exit;
}

if (!validateCsrfToken()) {
    http_response_code(403);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Invalid or missing CSRF token']]);
    exit;
}

// XP-specific config path
$config_file = '/opt/grin/webwallet/xp-mainnet/grin_web_wallet_api.json';
if (!file_exists($config_file) || !is_readable($config_file)) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Server configuration missing. Deploy via Script 051x option b.']]);
    exit;
}
$config = json_decode(file_get_contents($config_file), true);
if (!$config) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Server configuration invalid']]);
    exit;
}

$WALLET_HOST       = (string)($config['walletHost'] ?? '127.0.0.1');
$WALLET_PORT       = intval($config['walletPort'] ?? 3415);
$WALLET_API_SECRET = (string)($config['ownerApiSecret'] ?? '');
$REQUEST_TIMEOUT   = 30;

// Wallet must be localhost — defense-in-depth against config tampering
if (!in_array($WALLET_HOST, ['127.0.0.1', 'localhost', '::1'], true)) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Wallet host must be localhost']]);
    exit;
}

if ($WALLET_PORT < 1 || $WALLET_PORT > 65535) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Invalid wallet port in server config']]);
    exit;
}

function mapMethodName(string $method): ?string {
    $map = [
        'get_info'     => 'retrieve_summary_info',
        'get_balance'  => 'retrieve_summary_info',
        'retrieve_txs' => 'retrieve_txs',
        'init_send_tx' => 'init_send_tx',
        'receive_tx'   => 'receive_tx',
        'finalize_tx'  => 'finalize_tx',
        'cancel_tx'    => 'cancel_tx',
        'verify_slate' => 'verify_slate',
        'estimate_fee' => 'estimate_fee',
    ];
    return $map[$method] ?? null;
}

function isValidRecipientUrl(string $url): bool {
    $parsed = parse_url($url);
    if (!$parsed || ($parsed['scheme'] ?? '') !== 'https') return false;
    $host = strtolower($parsed['host'] ?? '');
    if (empty($host)) return false;
    $banned_exact    = ['localhost', '::1', '[::1]', '0.0.0.0'];
    $banned_prefixes = ['127.', '10.', '192.168.', '169.254.', 'fe80:', '::ffff:'];
    foreach ($banned_exact    as $b) { if ($host === $b) return false; }
    foreach ($banned_prefixes as $p) { if (strncmp($host, $p, strlen($p)) === 0) return false; }
    if (preg_match('/^172\.(1[6-9]|2[0-9]|3[01])\./', $host)) return false;
    return true;
}

function forwardToWallet(string $host, int $port, array $payload, int $timeout, string $apiSecret = ''): array {
    try {
        $socket = fsockopen($host, $port, $errno, $errstr, $timeout);
        if (!$socket) {
            throw new Exception("Cannot connect to wallet at $host:$port — $errstr ($errno)");
        }
        $json       = json_encode($payload);
        $authHeader = '';
        if ($apiSecret !== '') {
            $authHeader = "Authorization: Basic " . base64_encode(':' . $apiSecret) . "\r\n";
        }
        $request = "POST /v3/wallet HTTP/1.1\r\n"
                 . "Host: $host:$port\r\n"
                 . "Content-Type: application/json\r\n"
                 . "Content-Length: " . strlen($json) . "\r\n"
                 . $authHeader
                 . "Connection: close\r\n\r\n"
                 . $json;
        fwrite($socket, $request);
        stream_set_timeout($socket, $timeout);
        $response = '';
        while (!feof($socket)) { $response .= fgets($socket, 4096); }
        fclose($socket);
        $parts = explode("\r\n\r\n", $response, 2);
        if (count($parts) !== 2) throw new Exception('Invalid response from wallet');
        if (strpos($parts[0], '200') === false) throw new Exception('Wallet returned non-200: ' . explode("\r\n", $parts[0])[0]);
        $data = json_decode($parts[1], true);
        if ($data === null) throw new Exception('Failed to parse wallet response');
        return $data;
    } catch (Exception $e) {
        return ['error' => ['code' => -32000, 'message' => $e->getMessage()]];
    }
}

function handleHttpSend(string $walletHost, int $walletPort, array $params, int $timeout, string $apiSecret = ''): void {
    $recipientUrl = $params['recipient_url'] ?? '';
    $sendParams   = $params['send_params']   ?? [];
    if (!isValidRecipientUrl($recipientUrl)) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32602, 'message' => 'Invalid recipient URL (must be HTTPS and non-private)']]);
        return;
    }
    $initPayload  = ['jsonrpc' => '2.0', 'method' => 'init_send_tx', 'params' => $sendParams, 'id' => 1];
    $initResponse = forwardToWallet($walletHost, $walletPort, $initPayload, $timeout, $apiSecret);
    if (isset($initResponse['error'])) { echo json_encode($initResponse); return; }
    $slate = $initResponse['result']['slate'] ?? $initResponse['result'] ?? null;
    if (!$slate) { echo json_encode(['error' => ['code' => -32000, 'message' => 'init_send_tx returned no slate']]); return; }
    $ch = curl_init($recipientUrl);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode(['slate' => $slate]),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
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
    $recipientResp = json_decode($curlBody, true);
    $responseSlate = $recipientResp['slate'] ?? $recipientResp['result']['slate'] ?? null;
    if (!$responseSlate) { echo json_encode(['error' => ['code' => -32000, 'message' => 'Recipient returned no response slate']]); return; }
    $finalPayload  = ['jsonrpc' => '2.0', 'method' => 'finalize_tx', 'params' => ['slate' => $responseSlate, 'post_tx' => true, 'fluff' => false], 'id' => 2];
    echo json_encode(forwardToWallet($walletHost, $walletPort, $finalPayload, $timeout, $apiSecret));
}

function validateRequest(array $data): ?array {
    if (($data['jsonrpc'] ?? '') !== '2.0') return ['error' => ['code' => -32600, 'message' => 'Invalid JSON-RPC 2.0 request']];
    if (!isset($data['method']))            return ['error' => ['code' => -32600, 'message' => 'Missing method']];
    return null;
}

function handleRequest(): void {
    global $WALLET_HOST, $WALLET_PORT, $REQUEST_TIMEOUT, $WALLET_API_SECRET;
    $body = file_get_contents('php://input');
    if (empty($body)) { http_response_code(400); echo json_encode(['error' => ['code' => -32700, 'message' => 'Empty request body']]); return; }
    $data = json_decode($body, true);
    if ($data === null) { http_response_code(400); echo json_encode(['error' => ['code' => -32700, 'message' => 'Invalid JSON']]); return; }
    $err = validateRequest($data);
    if ($err) { http_response_code(400); echo json_encode($err); return; }
    $method = $data['method'];
    if ($method === 'send_http') {
        handleHttpSend($WALLET_HOST, $WALLET_PORT, $data['params'] ?? [], $REQUEST_TIMEOUT, $WALLET_API_SECRET);
        return;
    }
    $mappedMethod = mapMethodName($method);
    if ($mappedMethod === null) { http_response_code(400); echo json_encode(['error' => ['code' => -32601, 'message' => "Method not allowed: $method"]]); return; }
    $payload  = ['jsonrpc' => '2.0', 'method' => $mappedMethod, 'params' => $data['params'] ?? [], 'id' => $data['id'] ?? 1];
    echo json_encode(forwardToWallet($WALLET_HOST, $WALLET_PORT, $payload, $REQUEST_TIMEOUT, $WALLET_API_SECRET));
}

handleRequest();
?>
