const fs = require('fs');
const os = require('os');
const path = require('path');
const manager = require('./manager');
const processManager = require('./process');

const HOME_DIR = process.env.HOME || os.homedir();
const DEFAULT_CONFIG = path.join(HOME_DIR, '.cloudflared', 'config.yml');

function slug(value) {
  return String(value || 'service')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'service';
}

function parseTunnelHeader() {
  if (!fs.existsSync(DEFAULT_CONFIG)) return { tunnelId: '', credentialsFile: '' };
  const text = fs.readFileSync(DEFAULT_CONFIG, 'utf8');
  const t = text.match(/^\s*tunnel:\s*["']?([^"'\n]+)["']?\s*$/m);
  const c = text.match(/^\s*credentials-file:\s*["']?([^"'\n]+)["']?\s*$/m);
  return {
    tunnelId: t ? t[1].trim() : '',
    credentialsFile: c ? c[1].trim() : ''
  };
}

async function resolveTunnelContext() {
  const instances = (await manager.getInstances());
  const preferred = instances.find(i => i.tunnelId);
  if (preferred) {
    return {
      tunnelId: String(preferred.tunnelId || '').trim(),
      credentialsFile: String(preferred.credentialsFile || '').trim()
    };
  }
  return parseTunnelHeader();
}

function normalizePath(pathValue, protocol) {
  if ((protocol || '').toLowerCase() === 'tcp') return '/';
  const raw = String(pathValue || '/').trim();
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload inválido.');
  if (!payload.serviceName || !String(payload.serviceName).trim()) throw new Error('serviceName é obrigatório.');
  if (!payload.publicHost || !String(payload.publicHost).trim()) throw new Error('publicHost é obrigatório.');
  if (!/^[a-z0-9.-]+$/i.test(String(payload.publicHost).trim())) throw new Error('Hostname público inválido.');
  const port = parseInt(payload.internalPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('internalPort inválida.');
  const proto = String(payload.internalProtocol || 'http').toLowerCase();
  if (!['http', 'https', 'tcp'].includes(proto)) throw new Error('internalProtocol inválido.');
}

async function assertNoDuplicateHostnamePath(hostname, routePath, skipInstanceId) {
  const all = (await manager.getInstances());
  const normHost = String(hostname || '').trim().toLowerCase();
  const normPath = String(routePath || '/').trim() || '/';
  for (const inst of all) {
    if (skipInstanceId && inst.id === skipInstanceId) continue;
    const routes = Array.isArray(inst.routes) ? inst.routes : [];
    for (const r of routes) {
      const h = String(r.hostname || '').trim().toLowerCase();
      const p = String(r.path || '/').trim() || '/';
      if (h === normHost && p === normPath) {
        throw new Error(`Já existe uma rota para ${hostname}${routePath === '/' ? '' : routePath}.`);
      }
    }
  }
}

async function upsertCloudflareRouteFromHosting(payload) {
  validatePayload(payload);

  const tunnelCtx = await resolveTunnelContext();
  if (!tunnelCtx.tunnelId) {
    throw new Error('Configure primeiro o Cloudflare Manager (login/túnel) antes de publicar externamente.');
  }

  const serviceName = String(payload.serviceName).trim();
  const publicHost = String(payload.publicHost).trim().toLowerCase();
  const internalProtocol = String(payload.internalProtocol || 'http').toLowerCase();
  const internalHost = String(payload.internalHost || '127.0.0.1').trim() || '127.0.0.1';
  const internalPort = parseInt(payload.internalPort, 10);
  const routePath = normalizePath(payload.routePath, internalProtocol);
  const tunnelName = String(payload.tunnelName || `${serviceName}-tunnel`).trim();
  const instanceId = `inst-hosting-${slug(tunnelName)}`;

  const routeType = internalProtocol === 'tcp' ? 'tcp' : internalProtocol;
  const route = {
    name: `Hosting:${serviceName}`,
    hostname: publicHost,
    path: routePath,
    routeType,
    targetProtocol: internalProtocol,
    targetHost: internalHost,
    targetPort: internalPort
  };

  const current = (await manager.getInstances()).find(i => i.id === instanceId);
  await assertNoDuplicateHostnamePath(publicHost, routePath, current ? instanceId : '');

  let instance;
  if (current) {
    const kept = (current.routes || []).filter(r => {
      const sameHostPath = String(r.hostname || '').toLowerCase() === publicHost && String(r.path || '/') === routePath;
      const sameOwner = String(r.name || '') === `Hosting:${serviceName}`;
      return !(sameHostPath || sameOwner);
    });
    instance = await manager.updateInstance(instanceId, {
      name: tunnelName,
      type: 'service',
      protected: false,
      autoRestartOnSave: true,
      hostname: publicHost,
      tunnelId: tunnelCtx.tunnelId,
      credentialsFile: tunnelCtx.credentialsFile,
      routes: [...kept, route]
    });
  } else {
    instance = await manager.createInstance({
      id: instanceId,
      name: tunnelName,
      type: 'service',
      protected: false,
      autoRestartOnSave: true,
      hostname: publicHost,
      tunnelId: tunnelCtx.tunnelId,
      credentialsFile: tunnelCtx.credentialsFile,
      routes: [route]
    });
  }

  let processResult = { success: true };
  try {
    processManager.stopInstance(instance.id);
  } catch {}
  try {
    processResult = processManager.startInstance(instance);
  } catch (e) {
    processResult = { success: false, error: e.message };
  }

  return {
    success: true,
    instanceId: instance.id,
    tunnelName,
    publicHost,
    routePath,
    internalProtocol,
    internalHost,
    internalPort,
    publicUrl: `https://${publicHost}${routePath === '/' ? '' : routePath}`,
    process: processResult
  };
}

async function removeCloudflareRouteFromHosting({ serviceName, publicHost, routePath = '/', tunnelName }) {
  const host = String(publicHost || '').trim().toLowerCase();
  const pathNorm = String(routePath || '/').trim() || '/';
  const expectedName = serviceName ? `Hosting:${String(serviceName).trim()}` : '';
  const instanceId = tunnelName ? `inst-hosting-${slug(tunnelName)}` : '';

  const instances = (await manager.getInstances());
  const target = instances.find(i => i.id === instanceId) || instances.find(i => (i.routes || []).some(r =>
    String(r.hostname || '').toLowerCase() === host && String(r.path || '/') === pathNorm
  ));
  if (!target) return { success: true, removed: false };

  const kept = (target.routes || []).filter(r => {
    const sameHostPath = String(r.hostname || '').toLowerCase() === host && String(r.path || '/') === pathNorm;
    const sameName = expectedName && String(r.name || '') === expectedName;
    return !(sameHostPath || sameName);
  });

  if (kept.length === 0) {
    await manager.deleteInstance(target.id);
    return { success: true, removed: true, deletedInstance: true };
  }

  await manager.updateInstance(target.id, { routes: kept });
  return { success: true, removed: true, deletedInstance: false };
}

module.exports = {
  upsertCloudflareRouteFromHosting,
  removeCloudflareRouteFromHosting
};

