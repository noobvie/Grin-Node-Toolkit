<?php
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=3600');
$data = isset($_GET['data']) ? substr(trim($_GET['data']), 0, 1000) : '';
if (empty($data)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'No data provided']);
    exit;
}
exec('command -v qrencode 2>/dev/null', $out, $rc);
if ($rc !== 0) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'QR generator not installed. Run: apt-get install qrencode']);
    exit;
}
header('Content-Type: image/png');
passthru('qrencode -t PNG -s 8 -q L -o - ' . escapeshellarg($data));
?>
