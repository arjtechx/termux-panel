<?php
declare(strict_types=1);

/**
 * phpMyAdmin SSO Auto-Login Gateway
 * v1.0.7 - Dynamic Port Integration
 */

$token = $_GET['token'] ?? '';

if (!$token) {
    die('Acesso Negado: Token ausente.');
}

// Detecta a porta do painel de forma dinâmica a partir do arquivo de configuração
$port = 8088;
$serverConfigPath = '/data/data/com.termux/files/home/termux-panel/config/server.json';
if (file_exists($serverConfigPath)) {
    $config = json_decode(file_get_contents($serverConfigPath), true);
    if (isset($config['port'])) {
        $port = (int)$config['port'];
    }
}

$backend = 'http://127.0.0.1:' . $port . '/api/pma/sso/validate?token=' . urlencode($token);

$ch = curl_init($backend);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 5,
]);

$response = curl_exec($ch);
$error = curl_error($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
// curl_close($ch); // Depreciado no PHP 8.0+

if ($response === false || $httpCode !== 200) {
    die("Acesso Negado: falha no backend. HTTP=$httpCode ERRO=$error RESPOSTA=$response");
}

$data = json_decode($response, true);

if (!$data || empty($data['success'])) {
    die("Acesso Negado: token inválido ou expirado. RESPOSTA=$response");
}

session_name('PMA_single_signon');
session_start();

$_SESSION['PMA_single_signon_user'] = $data['user'] ?? '';
$_SESSION['PMA_single_signon_password'] = $data['password'] ?? '';
$_SESSION['PMA_single_signon_host'] = $data['host'] ?? '127.0.0.1';
$_SESSION['PMA_single_signon_port'] = $data['port'] ?? 3306;

header('Location: /phpmyadmin/index.php');
exit;
