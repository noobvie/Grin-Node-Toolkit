<?php
// csrf.php is no longer used — login is handled by login.php
http_response_code(410);
header('Content-Type: application/json');
echo json_encode(['error' => 'This endpoint has been removed. See login.php.']);
?>
