<?php
declare(strict_types=1);

/**
 * phpMyAdmin SSO Auto-Login Gateway
 * v2.0.0 - Robust Dynamic Config & Secure Token Validation
 */

$token = $_GET['token'] ?? '';

if (!$token) {
    header('HTTP/1.1 403 Forbidden');
    die('Acesso Negado: Token ausente.');
}

// Lista de caminhos potenciais para o arquivo de configuração do painel
$configPaths = [
    '/data/data/com.termux/files/home/termux-panel/config/server.json',
    '/data/data/com.termux/files/home/termux-panel/server.json',
    dirname(__DIR__, 2) . '/config/server.json',
    dirname(__DIR__, 3) . '/config/server.json',
];

$port = 8088; // Porta padrão de fallback
foreach ($configPaths as $path) {
    if (file_exists($path)) {
        $config = json_decode(file_get_contents($path), true);
        if (json_last_error() === JSON_ERROR_NONE && isset($config['port'])) {
            $port = (int)$config['port'];
            break;
        }
    }
}

// Constrói a URL do backend de validação local na porta ativa do painel
$backend = 'http://127.0.0.1:' . $port . '/api/phpmyadmin/validate?token=' . urlencode($token);

$ch = curl_init($backend);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5,
    CURLOPT_CONNECTTIMEOUT => 2,
]);

$response = curl_exec($ch);
$error = curl_error($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($response === false || $httpCode !== 200) {
    header('HTTP/1.1 403 Forbidden');
    die("Acesso Negado: falha de comunicação com o painel backend. (HTTP={$httpCode}, ERRO={$error})");
}

$data = json_decode($response, true);

if (!$data || empty($data['success'])) {
    header('HTTP/1.1 403 Forbidden');
    $errMsg = $data['error'] ?? 'token inválido ou expirado';
    die("Acesso Negado: {$errMsg}.");
}

// Inicia sessão PMA
session_name('PMA_single_signon');
if (session_status() === PHP_SESSION_NONE) {
    session_start();
}

// Define as credenciais obtidas de forma segura
$_SESSION['PMA_single_signon_user'] = $data['username'] ?? $data['user'] ?? '';
$_SESSION['PMA_single_signon_password'] = $data['password'] ?? '';
$_SESSION['PMA_single_signon_host'] = $data['host'] ?? '127.0.0.1';
$_SESSION['PMA_single_signon_port'] = $data['port'] ?? 3306;

// Redireciona o usuário para o painel principal do phpMyAdmin
header('Location: index.php');
exit;
