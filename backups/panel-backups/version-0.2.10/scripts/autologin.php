<?php
/**
 * phpMyAdmin SSO Auto-Login Gateway
 * v2.1.0 - Robust Session Handling, Error Suppression & Buffering
 */

// CORREÇÃO 1 — Desativar warnings e iniciar buffer no topo do arquivo
error_reporting(0);
ini_set('display_errors', '0');
ob_start();

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

// CORREÇÃO 2 — Remover curl_close($ch) pois o recurso é fechado automaticamente ou deprecated em versões novas PHP

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

// Função de logs de depuração para o SSO
function logSSODebug($msg) {
    try {
        $logFile = __DIR__ . '/sso_debug.log';
        $timestamp = date('Y-m-d H:i:s');
        file_put_contents($logFile, "[$timestamp] $msg\n", FILE_APPEND);
    } catch (\Throwable $e) {}
}

// CORREÇÃO 3 — Garantir session_start antes de qualquer output e após checagem de estado da sessão
if (session_status() === PHP_SESSION_NONE) {
    // Usamos a sessão PMA_single_signon para bater 100% com o setup-pma-sso.sh e com a config do phpMyAdmin
    session_name('PMA_single_signon');
    session_start();
}

logSSODebug("--- NOVA TENTATIVA DE AUTO-LOGIN SSO ---");
logSSODebug("Token recebido: " . ($token ? substr($token, 0, 8) . "..." : "NENHUM"));

// Define as credenciais obtidas de forma segura
$_SESSION['PMA_single_signon_user'] = $data['username'] ?? $data['user'] ?? '';
$_SESSION['PMA_single_signon_password'] = $data['password'] ?? '';
$_SESSION['PMA_single_signon_host'] = $data['host'] ?? '127.0.0.1';
$_SESSION['PMA_single_signon_port'] = $data['port'] ?? 3306;

logSSODebug("Sessão SSO criada para o usuário: " . ($_SESSION['PMA_single_signon_user'] ?: 'root'));

// Sanitiza e valida o parâmetro de banco (db)
$db = '';
if (!empty($_GET['db'])) {
    $db = preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['db']);
    logSSODebug("Banco recebido (via GET): $db");
} elseif (!empty($data['database'])) {
    $db = preg_replace('/[^a-zA-Z0-9_]/', '', $data['database']);
    logSSODebug("Banco obtido (via Token payload): $db");
}

// Sanitiza e valida o parâmetro de destino específico (target)
$target = '';
if (!empty($_GET['target'])) {
    $target = preg_replace('/[^a-zA-Z0-9_\.]/', '', $_GET['target']);
    logSSODebug("Página-alvo (target) recebida: $target");
}

// Constrói a URL final de redirecionamento focado
$redirectUrl = 'index.php';
$params = [];

if (!empty($db)) {
    $params['db'] = $db;
}
if (!empty($target)) {
    $params['target'] = $target;
}

if (!empty($params)) {
    $redirectUrl .= '?' . http_build_query($params);
}

logSSODebug("Redirecionamento gerado: $redirectUrl");
logSSODebug("----------------------------------------");

header("Location: " . $redirectUrl);

// CORREÇÃO 4 — Finalizar buffer
ob_end_flush();
exit;
