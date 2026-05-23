const acme = require('acme-client');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const SSLManager = require('./sslManager');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const DUCKDNS_CONFIG = path.join(CONFIG_DIR, 'duckdns.json');

class DuckDNSManager {
    static getSavedConfig() {
        if (fs.existsSync(DUCKDNS_CONFIG)) {
            try {
                return JSON.parse(fs.readFileSync(DUCKDNS_CONFIG, 'utf8'));
            } catch (e) {}
        }
        return { domain: '', token: '', email: '' };
    }

    static saveConfig(config) {
        fs.writeFileSync(DUCKDNS_CONFIG, JSON.stringify(config, null, 2));
    }

    static async testToken(domain, token) {
        try {
            // A API do DuckDNS retorna "OK" se der certo, e "KO" se falhar.
            // Para testar, apenas damos update sem o parâmetro txt.
            const url = `https://www.duckdns.org/update?domains=${domain}&token=${token}`;
            const res = await axios.get(url, { timeout: 10000 });
            if (res.data.trim() === 'OK') {
                return { success: true };
            }
            return { success: false, error: 'Token ou Domínio inválidos (Retorno: KO)' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    static async issueCertificate(domain, token, email) {
        try {
            console.log(`[DuckDNS] Iniciando emissão Let's Encrypt para ${domain}...`);

            acme.setLogger((message) => {
                console.log('[ACME]', message);
            });

            // Geração de chave da conta ACME
            const accountKey = await acme.crypto.createPrivateKey();
            
            const client = new acme.Client({
                directoryUrl: acme.directory.letsencrypt.production,
                accountKey: accountKey
            });

            // Geração do CSR
            const [key, csr] = await acme.crypto.createCsr({
                commonName: domain
            });

            const cert = await client.auto({
                csr,
                email,
                termsOfServiceAgreed: true,
                challengePriority: ['dns-01'],
                challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                    console.log(`[DuckDNS] Criando desafio DNS TXT para _acme-challenge.${domain}`);
                    const url = `https://www.duckdns.org/update?domains=${domain}&token=${token}&txt=${keyAuthorization}`;
                    const duckRes = await axios.get(url);
                    
                    if (duckRes.data.trim() !== 'OK') {
                        throw new Error('Falha ao injetar TXT no DuckDNS.');
                    }
                    
                    console.log(`[DuckDNS] Desafio injetado. Aguardando 45 segundos para propagação DNS...`);
                    await new Promise(resolve => setTimeout(resolve, 45000));
                },
                challengeRemoveFn: async (authz, challenge, keyAuthorization) => {
                    console.log(`[DuckDNS] Limpando desafio DNS TXT...`);
                    const url = `https://www.duckdns.org/update?domains=${domain}&token=${token}&txt=clear`;
                    await axios.get(url).catch(() => {});
                }
            });

            console.log(`[DuckDNS] Certificado gerado com sucesso!`);
            
            // Salva na configuração global
            const saveRes = SSLManager.saveCert(cert.toString(), key.toString());
            if (!saveRes.success) throw new Error(saveRes.error);

            this.saveConfig({ domain, token, email, lastIssued: Date.now() });

            return { success: true };
        } catch (error) {
            console.error('[DuckDNS] Falha na emissão:', error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = DuckDNSManager;
