<?php
/**
 * phpMyAdmin SSO Auto-Login Gateway
 * Receives a temporary token from the control panel, verifies it,
 * and initializes a signon session for phpMyAdmin.
 */

session_set_cookie_params(0, '/', '', false, true);
session_name('SignonSession');
@session_start();

// Enable basic error reporting for debugging if needed
error_reporting(E_ALL);
ini_set('display_errors', 0);

// Se não houver token, permite o acesso normal de login fallback se a sessão existir
if (!isset($_GET['token']) || empty($_GET['token'])) {
    if (isset($_SESSION['PMA_single_signon_user'])) {
        header('Location: index.php');
        exit;
    } else {
        // Strict SSO: Redireciona de volta para o painel de controle
        $host = preg_replace('/:[0-9]+$/', '', $_SERVER['HTTP_HOST']);
        header('Location: http://' . $host . ':8088/');
        exit;
    }
}

$token = $_GET['token'];
$backendUrl = 'http://127.0.0.1:8088/api/database/verify-token?token=' . urlencode($token);

// Usar cURL para contatar o backend local
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $backendUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 5);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($httpCode !== 200 || !$response) {
    die("Acesso Negado: Token inválido, expirado ou falha no backend.");
}

$data = json_decode($response, true);

if (!isset($data['success']) || !$data['success']) {
    die("Acesso Negado: " . (isset($data['error']) ? $data['error'] : 'Erro desconhecido.'));
}

// Inicializa variáveis de sessão requeridas pelo auth_type = 'signon'
$_SESSION['PMA_single_signon_user'] = $data['user'];
$_SESSION['PMA_single_signon_password'] = $data['password'];
$_SESSION['PMA_single_signon_host'] = '127.0.0.1'; // Optional

$db = isset($data['database']) && !empty($data['database']) ? $data['database'] : '';

// Redireciona para o phpMyAdmin
if ($db) {
    header("Location: index.php?server=1&db=" . urlencode($db));
} else {
    header("Location: index.php?server=1");
}
exit;
