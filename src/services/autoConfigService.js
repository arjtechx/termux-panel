const { detectServices } = require('./serviceDiscoveryService');
const { FILES, readJson, writeJson, logLine } = require('./autoConfigStorage');
const { buildCloudflaredConfig, writeCloudflaredConfig } = require('./cloudflareService');
const { buildNginxConfig, writeNginxConfig } = require('./nginxService');
const { validateAll, run } = require('./validationService');
const { createBackup, restoreLastBackup } = require('./backupService');

const MODES = ['cloudflare_only', 'cloudflare_nginx', 'proxy_only'];

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

module.exports = { detect, generate, validate, apply, restoreLastBackup, normalizeMode };
