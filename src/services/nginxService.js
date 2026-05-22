const fs = require('fs');
const path = require('path');
const env = require('../utils/env');

function wsHeaders() {
  return `proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;`;
}

function buildNginxConfig({ domain, services }) {
  const lines = [];
  lines.push('server {');
  lines.push('    listen 8090;');
  lines.push(`    server_name ${domain};`);
  for (const svc of services) {
    if (!svc.enabled) continue;
    if (!svc.protocol.startsWith('http')) continue;
    const p = (svc.path || '/').replace(/\/$/, '') || '/';
    const locationPath = p === '/' ? '/' : `${p}/`;
    let target = svc.target;
    if (svc.id === 'phpmyadmin' && !target.endsWith('/')) target += '/';
    lines.push(`    location ${locationPath} {`);
    lines.push(`        proxy_pass ${target};`);
    lines.push(`        ${wsHeaders()}`);
    lines.push('    }');
  }
  lines.push('}');
  return lines.join('\n');
}

function writeNginxConfig(content) {
  const dir = env.nginx_conf_dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'termux-panel-autoconfig.conf');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

module.exports = { buildNginxConfig, writeNginxConfig };
