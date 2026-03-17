<?php
/**
 * CSRF Token Endpoint
 *
 * Generates and returns a per-session CSRF token.
 * The JS client fetches this once on init and attaches the token
 * as X-CSRF-Token header on every subsequent API call to proxy.php.
 */

session_start();

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');

if (empty($_SESSION['csrf_token'])) {
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

echo json_encode(['csrfToken' => $_SESSION['csrf_token']]);
?>
