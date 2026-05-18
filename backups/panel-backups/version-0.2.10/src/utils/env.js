const fs = require('fs');
const path = require('path');

const SYSTEM_FILE = path.join(__dirname, '..', '..', 'config', 'system.json');

let systemConfig = {};

(function detectEnvironment() {
    const _plat = process.platform;
    const _isTermux = !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));

    let _isWSL = false;
    try {
        if (_plat === 'linux' && fs.existsSync('/proc/version')) {
            const _pv = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
            _isWSL = _pv.includes('microsoft') || _pv.includes('wsl');
        }
    } catch (_) {}

    const _isMac = _plat === 'darwin';

    let _pkg = 'apt', _distro = 'debian';
    if (_plat === 'linux' && !_isTermux) {
        try {
            if (fs.existsSync('/etc/os-release')) {
                const _or = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
                if (_or.includes('arch') || _or.includes('manjaro'))                     { _distro = 'arch';     _pkg = 'pacman'; }
                else if (_or.includes('fedora') || _or.includes('centos') || _or.includes('rhel')) { _distro = 'fedora';   _pkg = 'dnf';    }
                else if (_or.includes('alpine'))                                         { _distro = 'alpine';   _pkg = 'apk';    }
                else if (_or.includes('opensuse'))                                       { _distro = 'opensuse'; _pkg = 'zypper'; }
                else                                                                     { _distro = 'debian';   _pkg = 'apt';    }
            }
        } catch (_) {}
    }

    const _prefix = _isTermux
        ? (process.env.PREFIX || '/data/data/com.termux/files/usr')
        : _isMac ? '/usr/local' : '/usr';

    let _phpSock = `${_prefix}/var/run/php-fpm.sock`;
    if (!_isTermux) {
        const phpCandidates = [
            '/run/php/php8.2-fpm.sock', '/run/php/php8.1-fpm.sock', '/run/php/php8.0-fpm.sock',
            '/var/run/php/php8.1-fpm.sock', '/var/run/php-fpm/php-fpm.sock', '/var/run/php-fpm.sock'
        ];
        for (const s of phpCandidates) { if (fs.existsSync(s)) { _phpSock = s; break; } }
    }

    systemConfig = {
        type:           _isTermux ? 'termux' : (_isWSL ? 'wsl' : (_isMac ? 'macos' : (_plat === 'linux' ? 'linux' : 'windows'))),
        is_termux:      _isTermux,
        is_wsl:         _isWSL,
        is_macos:       _isMac,
        is_linux:       _plat === 'linux' && !_isTermux,
        has_root:       !_isTermux,
        package_manager: _isTermux ? 'pkg' : (_isMac ? 'brew' : _pkg),
        distro:         _isTermux ? 'termux' : (_isWSL ? 'wsl' : (_isMac ? 'macos' : _distro)),
        prefix:         _prefix,
        storage_path:   _isTermux ? '/data' : '/',
        nginx_conf_dir: _isTermux ? `${_prefix}/etc/nginx/conf.d` : (_isMac ? '/usr/local/etc/nginx/servers' : '/etc/nginx/conf.d'),
        mysql_data_dir: _isTermux ? `${_prefix}/var/lib/mysql` : '/var/lib/mysql',
        php_fpm_sock:   _phpSock,
    };

    try {
        if (fs.existsSync(SYSTEM_FILE)) {
            const _saved = JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf8'));
            if (typeof _saved.has_root === 'boolean') systemConfig.has_root = _saved.has_root;
        }
        fs.writeFileSync(SYSTEM_FILE, JSON.stringify(systemConfig, null, 4));
    } catch(_) {}

    console.log(`[ENV] Ambiente detectado: ${systemConfig.type} | Distro: ${systemConfig.distro} | Pkg: ${systemConfig.package_manager} | Prefix: ${systemConfig.prefix}`);
})();

module.exports = systemConfig;
