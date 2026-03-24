<?php
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
$_SESSION['last_activity'] = time();
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
if (empty($_SESSION['csrf_token'])) {
    session_regenerate_id(true);
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}
echo json_encode(['csrfToken' => $_SESSION['csrf_token']]);
?>
