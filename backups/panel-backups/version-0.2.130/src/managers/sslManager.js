const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const KEY_PATH = path.join(CONFIG_DIR, 'ssl.key');
const CERT_PATH = path.join(CONFIG_DIR, 'ssl.crt');

class SSLManager {
    /**
     * Valida se um certificado PEM e uma Chave Privada PEM se correspondem.
     */
    static validateManualCert(certPem, keyPem) {
        try {
            // Tenta criar os objetos nativos do crypto para validação de formato básico
            const cert = new crypto.X509Certificate(certPem);
            const privateKey = crypto.createPrivateKey({
                key: keyPem,
                format: 'pem'
            });

            // Verifica se a chave pública do certificado e a chave privada geram a mesma assinatura
            // No Node >= 15.6.0 X509Certificate possui publicKey
            if (cert.publicKey) {
                const pubKeyObject = cert.checkPrivateKey(privateKey);
                if (!pubKeyObject) {
                    return { valid: false, error: 'A Chave Privada não corresponde ao Certificado fornecido.' };
                }
            }
            
            // Check expiration
            const validTo = new Date(cert.validTo);
            const now = new Date();
            if (now > validTo) {
                return { valid: false, error: 'O certificado fornecido já está expirado.' };
            }

            const daysLeft = Math.ceil((validTo - now) / (1000 * 60 * 60 * 24));

            return {
                valid: true,
                subject: cert.subject,
                issuer: cert.issuer,
                daysLeft
            };
        } catch (error) {
            return { valid: false, error: 'Formato inválido. Certifique-se de que são blocos válidos PEM (Iniciam com -----BEGIN CERTIFICATE----- e -----BEGIN PRIVATE KEY-----)' };
        }
    }

    /**
     * Salva os certificados no diretório config
     */
    static saveCert(certPem, keyPem) {
        try {
            if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
            
            // Previne falha de permissão ao salvar
            fs.writeFileSync(CERT_PATH, certPem, { mode: 0o600 });
            fs.writeFileSync(KEY_PATH, keyPem, { mode: 0o600 });
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Gera um certificado autoassinado (OpenSSL)
     */
    static createSelfSigned(domain = 'localhost', days = 365) {
        try {
            if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
            
            // Remove existentes se houver
            if (fs.existsSync(KEY_PATH)) fs.unlinkSync(KEY_PATH);
            if (fs.existsSync(CERT_PATH)) fs.unlinkSync(CERT_PATH);

            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" -days ${days} -nodes -subj "/CN=${domain}"`);
            
            return { success: true };
        } catch (error) {
            return { success: false, error: 'Falha ao executar OpenSSL. O pacote "openssl" está instalado no Termux?' };
        }
    }
}

module.exports = SSLManager;
