const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();
const DEFAULT_CONFIG = path.join(HOME, '.cloudflared', 'config.yml');

function readExistingHeader() {
  if (!fs.existsSync(DEFAULT_CONFIG)) return { tunnel: '', credentialsFile: '' };
  const text = fs.readFileSync(DEFAULT_CONFIG, 'utf8');
  const tunnelMatch = text.match(/^\s*tunnel:\s*["']?([^"'\n]+)["']?\s*$/m);
  const credMatch = text.match(/^\s*credentials-file:\s*["']?([^"'\n]+)["']?\s*$/m);
  return {
    tunnel: tunnelMatch ? tunnelMatch[1].trim() : '',
    credentialsFile: credMatch ? credMatch[1].trim() : ''
  };
}

function buildCloudflaredConfig({ domain, mode, services }) {
  const ingress = [];
  if (mode === 'cloudflare_nginx') {
    ingress.push({ hostname: domain, service: 'http://127.0.0.1:8090' });
  } else if (mode === 'cloudflare_only') {
    for (const svc of services) {
      if (!svc.enabled || !svc.public) continue;
      const routePath = svc.path || '/';
      if (routePath !== '/' && svc.protocol.startsWith('http')) {
        ingress.push({ hostname: domain, path: `${routePath.replace(/\/$/, '')}.*`, service: svc.target.replace(/\/api$/, '') });
      } else {
        ingress.push({ hostname: domain, service: svc.target.replace(/\/api$/, '') });
      }
    }
  }
  ingress.push({ service: 'http_status:404' });

  const legacyHeader = readExistingHeader();
  let txt = '';
  if (legacyHeader.tunnel) txt += `tunnel: "${legacyHeader.tunnel}"\n`;
  if (legacyHeader.credentialsFile) txt += `credentials-file: "${legacyHeader.credentialsFile}"\n`;
  txt += 'protocol: quic\n';
  txt += 'ingress:\n';
  for (const rule of ingress) {
    if (rule.hostname) txt += `  - hostname: \"${rule.hostname}\"\n`;
    if (rule.path) txt += `    path: \"${rule.path}\"\n`;
    txt += `    service: \"${rule.service}\"\n`;
  }
  return txt;
}

function writeCloudflaredConfig(content) {
  const dir = path.join(HOME, '.cloudflared');
  const file = path.join(dir, 'config.yml');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

module.exports = { buildCloudflaredConfig, writeCloudflaredConfig };
