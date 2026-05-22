const { detectServices } = require('./serviceDiscoveryService');
const { FILES, readJson, writeJson, logLine } = require('./autoConfigStorage');
const { buildCloudflaredConfig, writeCloudflaredConfig } = require('./cloudflareService');
const { buildNginxConfig, writeNginxConfig } = require('./nginxService');
const { validateAll, run } = require('./validationService');
const { createBackup, restoreLastBackup } = require('./backupService');
const cloudflaredManager = require('../../modules/cloudflared/manager');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODES = ['cloudflare_only', 'cloudflare_nginx', 'proxy_only'];
const AUTOCONFIG_INSTANCE_ID = 'inst-autoconfig-system';
const AUTOCONFIG_INSTANCE_NAME = 'Autoconfiguração do Sistema';
const HOME_DIR = process.env.HOME || os.homedir();
const DEFAULT_CLOUDFLARED_CONFIG = path.join(HOME_DIR, '.cloudflared', 'config.yml');

function normalizeMode(mode) {
  if (mode === '1' || mode === 'cloudflare') return 'cloudflare_only';
  if (mode === '2' || mode === 'cloudflare_nginx') return 'cloudflare_nginx';
  if (mode === '3' || mode === 'proxy_only') return 'proxy_only';
  return MODES.includes(mode) ? mode : 'cloudflare_nginx';
}

async function detect(domain) {
  const services = await detectServices();
  writeJson(FILES.services, { domain, services, updatedAt: new Date().toISOString() });
  logLine('services', `Detectados ${services.length} serviços para ${domain}`);
  return { success: true, domain, services };
}

async function generate({ domain, mode }) {
  const m = normalizeMode(mode);
  const current = readJson(FILES.services, { services: [] });
  const services = current.services && current.services.length ? current.services : (await detectServices());

  const routes = services.filter(s => s.enabled).map((s, i) => ({
    id: `${s.id}-${i}`,
    serviceId: s.id,
    protocol: s.protocol,
    path: s.path,
    target: s.target,
    public: !!s.public && !s.exposeOnlyWithAdvancedMode,
    protected: !!s.protected
  }));

  const cloudflared = (m === 'proxy_only') ? '' : buildCloudflaredConfig({ domain, mode: m, services });
  const nginx = (m === 'cloudflare_only') ? '' : buildNginxConfig({ domain, services });

  const config = { domain, mode: m, routes, cloudflared, nginx, generatedAt: new Date().toISOString() };
  writeJson(FILES.routes, { routes, generatedAt: config.generatedAt });
  writeJson(FILES.tunnelConfig, config);
  logLine('routes', `Rotas geradas em modo ${m} para ${domain}`);
  return { success: true, config };
}

async function validate(input) {
  const conf = input || readJson(FILES.tunnelConfig, {});
  const result = await validateAll(conf.mode || 'cloudflare_nginx', { includeRuntime: true });
  logLine('services', `Validacao ${result.success ? 'OK' : 'FALHOU'} (${conf.mode || 'default'})`);
  return result;
}

async function apply(input) {
  const conf = input || readJson(FILES.tunnelConfig, {});
  if (!conf.domain) throw new Error('Configuração não gerada.');
  const backup = createBackup();

  if (conf.mode !== 'proxy_only' && conf.cloudflared) writeCloudflaredConfig(conf.cloudflared);
  if (conf.mode !== 'cloudflare_only' && conf.nginx) writeNginxConfig(conf.nginx);

  // Primeiro valida sintaxe/estrutura (sem runtime check)
  const syntaxVal = await validateAll(conf.mode || 'cloudflare_nginx', { includeRuntime: false });
  if (!syntaxVal.success) {
    restoreLastBackup();
    logLine('services', `Validacao FALHOU (${conf.mode}) detalhes: ${JSON.stringify(syntaxVal.checks)}`);
    logLine('services', 'Rollback automático executado por falha de validação.');
    return { success: false, error: 'Falha na validação de sintaxe; backup restaurado.', validation: syntaxVal, backup };
  }

  if (conf.mode !== 'cloudflare_only') {
    const reload = await run('nginx -s reload');
    if (!reload.ok) await run('nginx');
  }
  if (conf.mode !== 'proxy_only') {
    await run('cloudflared tunnel ingress validate');
    syncAutoconfigCloudflaredInstance(conf);
  }

  // Depois valida runtime (ports/head checks)
  const runtimeVal = await validateAll(conf.mode || 'cloudflare_nginx', { includeRuntime: true });
  if (!runtimeVal.success) {
    restoreLastBackup();
    logLine('services', `Validacao FALHOU (${conf.mode}) detalhes: ${JSON.stringify(runtimeVal.checks)}`);
    logLine('services', 'Rollback automático executado por falha de validação.');
    return { success: false, error: 'Falha na validação de runtime; backup restaurado.', validation: runtimeVal, backup };
  }

  logLine('services', `Configuração aplicada com sucesso (${conf.mode})`);
  return { success: true, backup, validation: runtimeVal, syntaxValidation: syntaxVal };
}

function syncAutoconfigCloudflaredInstance(conf) {
  const state = readJson(FILES.services, { services: [] });
  const services = Array.isArray(state.services) ? state.services : [];
  const tunnelContext = resolveTunnelContext();

  const routes = [];
  if (conf.mode === 'cloudflare_nginx') {
    routes.push({
      name: 'Autoconfig Nginx Entry',
      hostname: conf.domain,
      path: '/',
      routeType: 'http',
      targetProtocol: 'http',
      targetHost: '127.0.0.1',
      targetPort: 8090
    });
  } else if (conf.mode === 'cloudflare_only') {
    for (const svc of services) {
      if (!svc.enabled || !svc.public) continue;
      routes.push({
        name: svc.name || svc.id,
        hostname: conf.domain,
        path: svc.path || '/',
        routeType: (svc.protocol === 'https' ? 'https' : 'http'),
        targetProtocol: (svc.protocol === 'https' ? 'https' : 'http'),
        targetHost: '127.0.0.1',
        targetPort: svc.defaultPort || 80
      });
    }
  }

  const payload = {
    id: AUTOCONFIG_INSTANCE_ID,
    name: AUTOCONFIG_INSTANCE_NAME,
    type: 'service',
    protected: true,
    autoRestartOnSave: !!tunnelContext.tunnelId,
    hostname: conf.domain,
    tunnelId: tunnelContext.tunnelId,
    credentialsFile: tunnelContext.credentialsFile,
    routes
  };

  if (!payload.tunnelId) {
    logLine('services', 'Autoconfiguração sem tunnelId detectado: instância salva sem auto-restart para evitar loop de erro.');
  }

  const exists = cloudflaredManager.getInstances().some(i => i.id === AUTOCONFIG_INSTANCE_ID);
  if (exists) cloudflaredManager.updateInstance(AUTOCONFIG_INSTANCE_ID, payload);
  else cloudflaredManager.createInstance(payload);
}

function resolveTunnelContext() {
  const instances = cloudflaredManager.getInstances();
  const preferred = instances.find(i => i.id !== AUTOCONFIG_INSTANCE_ID && i.tunnelId);
  if (preferred) {
    return {
      tunnelId: String(preferred.tunnelId || '').trim(),
      credentialsFile: String(preferred.credentialsFile || '').trim()
    };
  }

  if (!fs.existsSync(DEFAULT_CLOUDFLARED_CONFIG)) {
    return { tunnelId: '', credentialsFile: '' };
  }

  const text = fs.readFileSync(DEFAULT_CLOUDFLARED_CONFIG, 'utf8');
  const tunnelMatch = text.match(/^\s*tunnel:\s*["']?([^"'\n]+)["']?\s*$/m);
  const credMatch = text.match(/^\s*credentials-file:\s*["']?([^"'\n]+)["']?\s*$/m);
  return {
    tunnelId: tunnelMatch ? tunnelMatch[1].trim() : '',
    credentialsFile: credMatch ? credMatch[1].trim() : ''
  };
}

module.exports = { detect, generate, validate, apply, restoreLastBackup, normalizeMode };
