<?php
/**
 * CSRF Token Endpoint
 *
 * Generates and returns a per-session CSRF token.
 * The JS client fetches this once on init and attaches the token
 * as X-CSRF-Token header on every subsequent API call to proxy.php.
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

// Reset idle timeout on token fetch
$_SESSION['last_activity'] = time();

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');

if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

echo json_encode(['csrfToken' => $_SESSION['csrf_token']]);
?>
