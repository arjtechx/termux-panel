const fs = require('fs');
const path = require('path');
const os = require('os');
const { FILES, ensureDirs, logLine } = require('./autoConfigStorage');
const systemConfig = require('../utils/env');

const HOME = process.env.HOME || os.homedir();
const BACKUP_ROOT = path.join(HOME, '.termux-panel', 'backups');

function ensureBackupDirs() {
  for (const d of ['cloudflared','nginx','routes']) {
    const p = path.join(BACKUP_ROOT, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
}

function copyIfExists(src, dst) {
  if (!src || !fs.existsSync(src)) return false;
  fs.copyFileSync(src, dst);
  return true;
}

function createBackup() {
  ensureDirs();
  ensureBackupDirs();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const nginxConf = path.join(systemConfig.nginx_conf_dir, 'termux-panel-autoconfig.conf');
  const cloudConf = path.join(HOME, '.cloudflared', 'config.yml');
  const snap = {
    timestamp: ts,
    files: {
      routes: path.join(BACKUP_ROOT, 'routes', `routes-${ts}.json`),
      services: path.join(BACKUP_ROOT, 'routes', `services-${ts}.json`),
      tunnelConfig: path.join(BACKUP_ROOT, 'routes', `tunnel-config-${ts}.json`),
      nginx: path.join(BACKUP_ROOT, 'nginx', `nginx-${ts}.conf`),
      cloudflared: path.join(BACKUP_ROOT, 'cloudflared', `cloudflared-${ts}.yml`)
    }
  };
  copyIfExists(FILES.routes, snap.files.routes);
  copyIfExists(FILES.services, snap.files.services);
  copyIfExists(FILES.tunnelConfig, snap.files.tunnelConfig);
  copyIfExists(nginxConf, snap.files.nginx);
  copyIfExists(cloudConf, snap.files.cloudflared);
  const marker = path.join(BACKUP_ROOT, 'last-backup.json');
  fs.writeFileSync(marker, JSON.stringify(snap, null, 2));
  logLine('backup', `Backup criado: ${ts}`);
  return { success: true, backup: snap };
}

function restoreLastBackup() {
  const marker = path.join(BACKUP_ROOT, 'last-backup.json');
  if (!fs.existsSync(marker)) throw new Error('Nenhum backup encontrado.');
  const snap = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const nginxConf = path.join(systemConfig.nginx_conf_dir, 'termux-panel-autoconfig.conf');
  const cloudConf = path.join(HOME, '.cloudflared', 'config.yml');
  copyIfExists(snap.files.routes, FILES.routes);
  copyIfExists(snap.files.services, FILES.services);
  copyIfExists(snap.files.tunnelConfig, FILES.tunnelConfig);
  copyIfExists(snap.files.nginx, nginxConf);
  copyIfExists(snap.files.cloudflared, cloudConf);
  logLine('backup', `Backup restaurado: ${snap.timestamp}`);
  return { success: true, backup: snap };
}

module.exports = { createBackup, restoreLastBackup, BACKUP_ROOT };
