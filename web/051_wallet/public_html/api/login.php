<?php
/**
 * Grin Wallet Login
 *
 * Performs secp256k1 ECDH key exchange with the wallet's Owner API v3,
 * calls init_secure_api + open_wallet, stores token + AES key in PHP session.
 * No password is persisted — it is used once and discarded.
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

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$body     = json_decode(file_get_contents('php://input'), true);
$password = (string)($body['password'] ?? '');
if ($password === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Password required']);
    exit;
}

// ── Load server config ────────────────────────────────────────────────────────
$cfgFile = '/opt/grin/conf/grin_web_wallet_api.json';
if (!file_exists($cfgFile) || !is_readable($cfgFile)) {
    http_response_code(500);
    echo json_encode(['error' => 'Server config missing']);
    exit;
}
$config = json_decode(file_get_contents($cfgFile), true);
$host   = (string)($config['walletHost']     ?? '127.0.0.1');
$port   = (int)   ($config['walletPort']     ?? 3415);
$secret = (string)($config['ownerApiSecret'] ?? '');

if (!in_array($host, ['127.0.0.1', 'localhost', '::1'], true)) {
    http_response_code(500);
    echo json_encode(['error' => 'Wallet host must be localhost']);
    exit;
}

// ── Generate ephemeral secp256k1 keypair ──────────────────────────────────────
$privKey = openssl_pkey_new([
    'curve_name'       => 'secp256k1',
    'private_key_type' => OPENSSL_KEYTYPE_EC,
]);
if (!$privKey) {
    http_response_code(500);
    echo json_encode(['error' => 'Keypair generation failed: ' . openssl_error_string()]);
    exit;
}
$details   = openssl_pkey_get_details($privKey);
$ourPubHex = '04' . bin2hex($details['ec']['x']) . bin2hex($details['ec']['y']);

// ── Call init_secure_api ──────────────────────────────────────────────────────
$initResp = walletCall($host, $port, $secret, [
    'jsonrpc' => '2.0',
    'method'  => 'init_secure_api',
    'params'  => ['ecdh_pubkey' => $ourPubHex],
    'id'      => 1,
]);
if (isset($initResp['error'])) {
    http_response_code(502);
    echo json_encode(['error' => 'init_secure_api failed: ' . ($initResp['error']['message'] ?? 'unknown')]);
    exit;
}
$serverPubHex = $initResp['result']['Ok'] ?? ($initResp['result'] ?? null);
if (!$serverPubHex || !is_string($serverPubHex)) {
    http_response_code(502);
    echo json_encode(['error' => 'init_secure_api returned no pubkey']);
    exit;
}

// ── Convert server pubkey hex → OpenSSL PEM ───────────────────────────────────
$pointBytes = hex2bin($serverPubHex);
if ($pointBytes === false || strlen($pointBytes) === 0) {
    http_response_code(502);
    echo json_encode(['error' => 'Invalid server pubkey hex']);
    exit;
}
// Decompress if compressed (33 bytes)
if (strlen($pointBytes) === 33) {
    $pointBytes = decompressSecp256k1Point($pointBytes);
    if ($pointBytes === null) {
        http_response_code(502);
        echo json_encode(['error' => 'Failed to decompress server pubkey']);
        exit;
    }
}
if (strlen($pointBytes) !== 65 || ord($pointBytes[0]) !== 0x04) {
    http_response_code(502);
    echo json_encode(['error' => 'Unexpected server pubkey format']);
    exit;
}
// DER SubjectPublicKeyInfo for secp256k1 uncompressed point (65 bytes)
$derHeader = hex2bin('3056301006072a8648ce3d020106052b8104000a034200');
$der       = $derHeader . $pointBytes;
$pem       = "-----BEGIN PUBLIC KEY-----\n"
           . chunk_split(base64_encode($der), 64, "\n")
           . "-----END PUBLIC KEY-----\n";
$serverPubKey = openssl_pkey_get_public($pem);
if (!$serverPubKey) {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to import server pubkey: ' . openssl_error_string()]);
    exit;
}

// ── ECDH → AES-256 key ────────────────────────────────────────────────────────
$sharedSecret = openssl_pkey_derive($serverPubKey, $privKey);
if ($sharedSecret === false) {
    http_response_code(500);
    echo json_encode(['error' => 'ECDH failed: ' . openssl_error_string()]);
    exit;
}
$aesKey = hash('sha256', $sharedSecret, true);

// ── Encrypt open_wallet call ──────────────────────────────────────────────────
$nonce     = random_bytes(12);
$tag       = '';
$plaintext = json_encode([
    'jsonrpc' => '2.0',
    'method'  => 'open_wallet',
    'params'  => ['name' => null, 'password' => $password],
    'id'      => 2,
]);
$ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', $aesKey, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
if ($ciphertext === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Encryption failed']);
    exit;
}

$encResp = walletCall($host, $port, $secret, [
    'jsonrpc' => '2.0',
    'method'  => 'encrypted_request_v3',
    'params'  => [
        'nonce'    => bin2hex($nonce),
        'body_enc' => base64_encode($ciphertext . $tag),
    ],
    'id' => 2,
]);
if (isset($encResp['error'])) {
    http_response_code(502);
    echo json_encode(['error' => 'Encrypted open_wallet failed: ' . ($encResp['error']['message'] ?? 'unknown')]);
    exit;
}

$encBody = $encResp['result']['Ok'] ?? null;
if (!$encBody || !is_array($encBody)) {
    http_response_code(502);
    echo json_encode(['error' => 'No encrypted body in open_wallet response']);
    exit;
}

$decrypted = decryptBody($encBody, $aesKey);
if ($decrypted === null) {
    http_response_code(502);
    echo json_encode(['error' => 'Failed to decrypt open_wallet response']);
    exit;
}
$openResult = json_decode($decrypted, true);
if (!$openResult) {
    http_response_code(502);
    echo json_encode(['error' => 'Invalid JSON in decrypted open_wallet response']);
    exit;
}
if (isset($openResult['error'])) {
    http_response_code(401);
    echo json_encode(['error' => 'open_wallet: ' . ($openResult['error']['message'] ?? 'wrong password?')]);
    exit;
}
if (isset($openResult['result']['Err'])) {
    http_response_code(401);
    echo json_encode(['error' => 'open_wallet error: ' . json_encode($openResult['result']['Err'])]);
    exit;
}
$token = $openResult['result']['Ok'] ?? null;
if ($token === null) {
    http_response_code(502);
    echo json_encode(['error' => 'open_wallet returned no token']);
    exit;
}

// ── Store session ─────────────────────────────────────────────────────────────
session_regenerate_id(true);
$_SESSION['wallet_token']  = $token;
$_SESSION['aes_key']       = base64_encode($aesKey);
$_SESSION['last_activity'] = time();

// Clear password from memory (best-effort in PHP)
$password = str_repeat("\0", strlen($password));
unset($password, $sharedSecret, $plaintext);

echo json_encode(['ok' => true]);

// ── Helper functions ──────────────────────────────────────────────────────────

function walletCall(string $host, int $port, string $secret, array $payload): array {
    try {
        $socket = fsockopen($host, $port, $errno, $errstr, 10);
        if (!$socket) throw new Exception("Cannot connect to wallet at $host:$port — $errstr ($errno)");
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
        stream_set_timeout($socket, 10);
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

function decryptBody(array $encBody, string $aesKey): ?string {
    $nonce = hex2bin($encBody['nonce'] ?? '');
    $full  = base64_decode($encBody['body_enc'] ?? '');
    if (!$nonce || !$full || strlen($full) < 16) return null;
    $tag   = substr($full, -16);
    $ct    = substr($full, 0, -16);
    $plain = openssl_decrypt($ct, 'aes-256-gcm', $aesKey, OPENSSL_RAW_DATA, $nonce, $tag);
    return $plain === false ? null : $plain;
}

function decompressSecp256k1Point(string $compressed): ?string {
    // Load compressed point into OpenSSL via DER SubjectPublicKeyInfo
    // DER header for secp256k1 compressed point (33 bytes):
    //   SEQUENCE { SEQUENCE { OID ecPublicKey, OID secp256k1 } BIT STRING(compressed_point) }
    $compHeader = hex2bin('3036301006072a8648ce3d020106052b8104000a032200');
    $der = $compHeader . $compressed;
    $pem = "-----BEGIN PUBLIC KEY-----\n"
         . chunk_split(base64_encode($der), 64, "\n")
         . "-----END PUBLIC KEY-----\n";
    $pk = @openssl_pkey_get_public($pem);
    if (!$pk) return null;
    $d = openssl_pkey_get_details($pk);
    if (!$d || !isset($d['ec']['x'], $d['ec']['y'])) return null;
    // Pad x and y to 32 bytes each
    $x = str_pad($d['ec']['x'], 32, "\0", STR_PAD_LEFT);
    $y = str_pad($d['ec']['y'], 32, "\0", STR_PAD_LEFT);
    return "\x04" . $x . $y;
}
?>
