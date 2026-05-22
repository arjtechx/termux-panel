const fs = require('fs');
const path = require('path');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PANEL_DIR, 'data');
const LOG_DIR = path.join(PANEL_DIR, 'logs', 'autoconfig');

const FILES = {
  services: path.join(DATA_DIR, 'services.json'),
  routes: path.join(DATA_DIR, 'routes.json'),
  tunnelConfig: path.join(DATA_DIR, 'tunnel-config.json')
};

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDirs();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function logLine(kind, message) {
  ensureDirs();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(path.join(LOG_DIR, `${kind}.log`), line);
}

module.exports = { PANEL_DIR, DATA_DIR, LOG_DIR, FILES, ensureDirs, readJson, writeJson, logLine };
