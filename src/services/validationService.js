const { exec } = require('child_process');
const http = require('http');

function run(cmd, timeout = 12000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout || ''}${stderr || ''}`.trim(), code: error ? error.code : 0 });
    });
  });
}

function httpHead(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'HEAD', timeout }, (res) => {
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
      req.destroy();
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

async function validateAll(mode) {
  const checks = [];
  const normalizedMode = mode || 'cloudflare_nginx';

  if (normalizedMode !== 'cloudflare_only') {
    checks.push({ key:'nginx', ...(await run('nginx -t')) });
  }
  if (normalizedMode !== 'proxy_only') {
    checks.push({ key:'cloudflared', ...(await run('cloudflared tunnel ingress validate')) });
  }

  // 8090 só é obrigatório quando o fluxo usa Nginx como entrypoint local.
  if (normalizedMode === 'cloudflare_nginx' || normalizedMode === 'proxy_only') {
    const local8090 = await httpHead('http://127.0.0.1:8090');
    checks.push({ key:'curl8090', ok: local8090.ok, output: `status=${local8090.status}` });
  }

  const local8088 = await httpHead('http://127.0.0.1:8088');
  checks.push({ key:'curl8088', ok: local8088.ok, output: `status=${local8088.status}` });
  return { success: checks.every(c => c.ok), checks };
}

module.exports = { validateAll, run };
