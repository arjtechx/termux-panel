const fs = require('fs');
const { execSync } = require('child_process');

// Global state to compute speed over real time intervals
let state = {
  lastInterface: null,
  lastRx: 0,
  lastTx: 0,
  lastTime: 0,
  downloadSpeed: 0,
  uploadSpeed: 0
};

let rootModeEnabled = false;

function setRootMode(enabled) {
  rootModeEnabled = !!enabled;
}

function getRootMode() {
  return rootModeEnabled;
}

function detectNetworkError(error) {
  const msg = String(error.message || "").toLowerCase();

  if (msg.includes("permission denied") || msg.includes("eacces")) {
    return "PERMISSION_DENIED";
  }

  if (msg.includes("no such file") || msg.includes("enoent")) {
    return "FILE_NOT_FOUND";
  }

  if (msg.includes("timed out") || msg.includes("timeout")) {
    return "TIMEOUT";
  }

  if (msg.includes("not found")) {
    return "COMMAND_NOT_FOUND";
  }

  return "UNKNOWN_ERROR";
}

function getAvailableInterfaces(rootMode = false) {
  try {
    if (!rootMode) {
      return fs.readdirSync('/sys/class/net');
    } else {
      try {
        return fs.readdirSync('/sys/class/net');
      } catch (_) {
        const output = execSync("su -c 'ls /sys/class/net'", { encoding: 'utf8', timeout: 1500 });
        return output.split(/\s+/).filter(Boolean);
      }
    }
  } catch (err) {
    return [];
  }
}

function chooseInterface(rootMode = false) {
  const interfaces = getAvailableInterfaces(rootMode);
  
  if (interfaces.length === 0) {
    const fallbackList = ['wlan0', 'rmnet_data0', 'rmnet0', 'ccmni0', 'eth0'];
    for (const iface of fallbackList) {
      const rxPath = `/sys/class/net/${iface}/statistics/rx_bytes`;
      if (!rootMode) {
        if (fs.existsSync(rxPath)) return iface;
      } else {
        try {
          execSync(`su -c 'test -f ${rxPath}'`, { timeout: 1000 });
          return iface;
        } catch (_) {}
      }
    }
    return null;
  }

  if (interfaces.includes('wlan0')) return 'wlan0';
  if (interfaces.includes('rmnet_data0')) return 'rmnet_data0';
  if (interfaces.includes('rmnet0')) return 'rmnet0';
  
  const rmnetIface = interfaces.find(i => i.startsWith('rmnet'));
  if (rmnetIface) return rmnetIface;
  
  const otherIface = interfaces.find(i => i !== 'lo');
  if (otherIface) return otherIface;

  return null;
}

function readBytes(iface, rootMode = false) {
  const rxPath = `/sys/class/net/${iface}/statistics/rx_bytes`;
  const txPath = `/sys/class/net/${iface}/statistics/tx_bytes`;

  if (!rootMode) {
    const rx = parseInt(fs.readFileSync(rxPath, 'utf8').trim(), 10);
    const tx = parseInt(fs.readFileSync(txPath, 'utf8').trim(), 10);
    return { rx, tx };
  } else {
    const rxStr = execSync(`su -c 'cat ${rxPath}'`, { encoding: 'utf8', timeout: 1000 }).trim();
    const txStr = execSync(`su -c 'cat ${txPath}'`, { encoding: 'utf8', timeout: 1000 }).trim();
    const rx = parseInt(rxStr, 10);
    const tx = parseInt(txStr, 10);
    return { rx, tx };
  }
}

function testNetworkAccess(rootMode = false) {
  try {
    const iface = chooseInterface(rootMode);

    if (!iface) {
      return {
        success: false,
        reason: "NO_INTERFACE",
        message: "Nenhuma interface de rede encontrada"
      };
    }

    const { rx, tx } = readBytes(iface, rootMode);

    if (!Number.isFinite(rx) || !Number.isFinite(tx)) {
      return {
        success: false,
        reason: "INVALID_VALUE",
        message: "A leitura retornou valor inválido"
      };
    }

    return {
      success: true,
      interface: iface,
      rx,
      tx,
      root: rootMode
    };

  } catch (error) {
    return {
      success: false,
      reason: detectNetworkError(error),
      message: error.message,
      root: rootMode
    };
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!Number.isFinite(bytes) || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  if (i === 0) {
    return `${val} B`;
  }
  return `${val.toFixed(2)} ${sizes[i]}`;
}

function updateMetrics(rootMode = false) {
  const now = Date.now();
  const iface = chooseInterface(rootMode);
  if (!iface) {
    throw new Error("Nenhuma interface de rede encontrada");
  }

  const { rx, tx } = readBytes(iface, rootMode);
  
  if (state.lastInterface === iface && state.lastTime > 0) {
    const timeDiffSec = (now - state.lastTime) / 1000;
    if (timeDiffSec > 0.1) {
      state.downloadSpeed = Math.max(0, (rx - state.lastRx) / timeDiffSec);
      state.uploadSpeed = Math.max(0, (tx - state.lastTx) / timeDiffSec);
    }
  } else {
    state.downloadSpeed = 0;
    state.uploadSpeed = 0;
  }

  state.lastInterface = iface;
  state.lastRx = rx;
  state.lastTx = tx;
  state.lastTime = now;

  return {
    interface: iface,
    downloadSpeed: formatBytes(state.downloadSpeed) + '/s',
    uploadSpeed: formatBytes(state.uploadSpeed) + '/s',
    totalReceived: formatBytes(rx),
    totalSent: formatBytes(tx)
  };
}

module.exports = {
  setRootMode,
  getRootMode,
  testNetworkAccess,
  updateMetrics,
  formatBytes
};
