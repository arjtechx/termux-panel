<?php
/**
 * phpMyAdmin SSO Auto-Login Gateway
 */

ini_set('display_errors', 1);
error_reporting(E_ALL);

$token = $_GET['token'] ?? '';

if (!$token) {
    http_response_code(400);
    exit('Token ausente.');
}

// Em desenvolvimento, o painel roda na porta 8088
$backendUrl = 'http://127.0.0.1:8088/api/phpmyadmin/validate-token';

$payload = json_encode(['token' => $token]);

$ch = curl_init($backendUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_TIMEOUT, 5);

$response = curl_exec($ch);
$error = curl_error($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$response || $code !== 200) {
    error_log("AUTOLOGIN BACKEND ERROR: " . $error . " CODE: " . $code);
    exit('Acesso Negado: falha ao consultar backend.');
}

$data = json_decode($response, true);

if (!$data || empty($data['ok'])) {
    error_log("AUTOLOGIN TOKEN INVALIDO: " . $response);
    exit('Acesso Negado: Token inválido ou expirado.');
}

session_name('PMA_single_signon');
session_start();

$_SESSION['PMA_single_signon_user'] = $data['user'];
$_SESSION['PMA_single_signon_password'] = $data['password'];
$_SESSION['PMA_single_signon_host'] = $data['host'] ?? '127.0.0.1';

$db = urlencode($data['database'] ?? '');

if ($db) {
    header('Location: /phpmyadmin/index.php?db=' . $db);
} else {
    header('Location: /phpmyadmin/index.php');
}
exit;
