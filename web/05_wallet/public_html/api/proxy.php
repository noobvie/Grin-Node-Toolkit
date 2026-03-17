<?php
/**
 * Grin Wallet REST API Proxy
 *
 * Security:
 *   - No CORS headers (same-origin deployment — no cross-origin callers expected)
 *   - CSRF token validated on every POST via PHP session
 *   - Wallet host/port read from server-side config.json (never trusted from headers)
 *   - Strict method whitelist — unknown methods are rejected
 *   - Server-side HTTP send (avoids browser SSRF; recipient URL validated here)
 */

session_start();

header('Content-Type: application/json');

// ─── CSRF validation ─────────────────────────────────────────────────────────
function validateCsrfToken(): bool {
    if (empty($_SESSION['csrf_token'])) return false;
    $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    return strlen($token) > 0 && hash_equals($_SESSION['csrf_token'], $token);
}

// ─── Only POST allowed ────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Method Not Allowed']]);
    exit;
}

// ─── CSRF check ───────────────────────────────────────────────────────────────
if (!validateCsrfToken()) {
    http_response_code(403);
    echo json_encode(['error' => ['code' => -32600, 'message' => 'Invalid or missing CSRF token']]);
    exit;
}

// ─── Load server-side config (never exposed to browser) ──────────────────────
$config_file = __DIR__ . '/config.json';
if (!file_exists($config_file) || !is_readable($config_file)) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Server configuration missing. Deploy via Script 05 option m.']]);
    exit;
}
$config = json_decode(file_get_contents($config_file), true);
if (!$config) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Server configuration invalid']]);
    exit;
}

$WALLET_HOST    = filter_var($config['walletHost'] ?? '127.0.0.1', FILTER_SANITIZE_STRING);
$WALLET_PORT    = intval($config['walletPort'] ?? 3415);
$REQUEST_TIMEOUT = 30;

if ($WALLET_PORT < 1 || $WALLET_PORT > 65535) {
    http_response_code(500);
    echo json_encode(['error' => ['code' => -32000, 'message' => 'Invalid wallet port in server config']]);
    exit;
}

// ─── Method whitelist ─────────────────────────────────────────────────────────
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

// ─── Recipient URL validation (for server-side HTTP send) ────────────────────
function isValidRecipientUrl(string $url): bool {
    $parsed = parse_url($url);
    if (!$parsed || ($parsed['scheme'] ?? '') !== 'https') return false;
    $host = strtolower($parsed['host'] ?? '');
    if (empty($host)) return false;

    // Block private/loopback/link-local ranges
    $banned_exact   = ['localhost', '::1', '[::1]'];
    $banned_prefixes = ['127.', '10.', '192.168.', '169.254.'];
    foreach ($banned_exact as $b)   { if ($host === $b) return false; }
    foreach ($banned_prefixes as $p) { if (strncmp($host, $p, strlen($p)) === 0) return false; }

    // Block 172.16.0.0/12
    if (preg_match('/^172\.(1[6-9]|2[0-9]|3[01])\./', $host)) return false;

    return true;
}

// ─── Forward JSON-RPC to wallet ───────────────────────────────────────────────
function forwardToWallet(string $host, int $port, array $payload, int $timeout): array {
    try {
        $socket = fsockopen($host, $port, $errno, $errstr, $timeout);
        if (!$socket) {
            throw new Exception("Cannot connect to wallet at $host:$port — $errstr ($errno)");
        }

        $json    = json_encode($payload);
        $request = "POST /v3/wallet HTTP/1.1\r\n"
                 . "Host: $host:$port\r\n"
                 . "Content-Type: application/json\r\n"
                 . "Content-Length: " . strlen($json) . "\r\n"
                 . "Connection: close\r\n"
                 . "\r\n"
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

// ─── Server-side HTTP send (avoids browser SSRF) ─────────────────────────────
function handleHttpSend(string $walletHost, int $walletPort, array $params, int $timeout): void {
    $recipientUrl = $params['recipient_url'] ?? '';
    $sendParams   = $params['send_params'] ?? [];

    if (!isValidRecipientUrl($recipientUrl)) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32602, 'message' => 'Invalid recipient URL (must be HTTPS and non-private)']]);
        return;
    }

    // Step 1: init_send_tx
    $initPayload  = ['jsonrpc' => '2.0', 'method' => 'init_send_tx', 'params' => $sendParams, 'id' => 1];
    $initResponse = forwardToWallet($walletHost, $walletPort, $initPayload, $timeout);
    if (isset($initResponse['error'])) { echo json_encode($initResponse); return; }

    $slate = $initResponse['result']['slate'] ?? $initResponse['result'] ?? null;
    if (!$slate) {
        echo json_encode(['error' => ['code' => -32000, 'message' => 'init_send_tx returned no slate']]);
        return;
    }

    // Step 2: POST slate to recipient wallet via curl
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
    if (!$responseSlate) {
        echo json_encode(['error' => ['code' => -32000, 'message' => 'Recipient returned no response slate']]);
        return;
    }

    // Step 3: finalize_tx
    $finalPayload  = ['jsonrpc' => '2.0', 'method' => 'finalize_tx', 'params' => ['slate' => $responseSlate, 'post_tx' => true, 'fluff' => false], 'id' => 2];
    $finalResponse = forwardToWallet($walletHost, $walletPort, $finalPayload, $timeout);
    echo json_encode($finalResponse);
}

// ─── Request validation ───────────────────────────────────────────────────────
function validateRequest(array $data): ?array {
    if (($data['jsonrpc'] ?? '') !== '2.0') {
        return ['error' => ['code' => -32600, 'message' => 'Invalid JSON-RPC 2.0 request']];
    }
    if (!isset($data['method'])) {
        return ['error' => ['code' => -32600, 'message' => 'Missing method']];
    }
    return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
function handleRequest(): void {
    global $WALLET_HOST, $WALLET_PORT, $REQUEST_TIMEOUT;

    $body = file_get_contents('php://input');
    if (empty($body)) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32700, 'message' => 'Empty request body']]);
        return;
    }

    $data = json_decode($body, true);
    if ($data === null) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32700, 'message' => 'Invalid JSON']]);
        return;
    }

    $err = validateRequest($data);
    if ($err) { http_response_code(400); echo json_encode($err); return; }

    $method = $data['method'];

    // Server-side HTTP send (special case)
    if ($method === 'send_http') {
        handleHttpSend($WALLET_HOST, $WALLET_PORT, $data['params'] ?? [], $REQUEST_TIMEOUT);
        return;
    }

    // Map and whitelist check
    $mappedMethod = mapMethodName($method);
    if ($mappedMethod === null) {
        http_response_code(400);
        echo json_encode(['error' => ['code' => -32601, 'message' => "Method not allowed: $method"]]);
        return;
    }

    $payload  = ['jsonrpc' => '2.0', 'method' => $mappedMethod, 'params' => $data['params'] ?? [], 'id' => $data['id'] ?? 1];
    $response = forwardToWallet($WALLET_HOST, $WALLET_PORT, $payload, $REQUEST_TIMEOUT);
    echo json_encode($response);
}

handleRequest();
?>
