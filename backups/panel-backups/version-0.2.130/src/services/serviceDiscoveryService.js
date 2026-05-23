const { testTcpPort } = require('./portManager');

function baseServices() {
  return [
    { id:'panel', name:'Painel Principal', defaultPort:8088, protocol:'http', path:'/', target:'http://127.0.0.1:8088', public:true, protected:false },
    { id:'phpmyadmin', name:'phpMyAdmin', defaultPort:8080, protocol:'http', path:'/phpmyadmin', target:'http://127.0.0.1:8080/phpmyadmin', public:true, protected:true },
    { id:'filebrowser', name:'FileBrowser', defaultPort:8082, protocol:'http', path:'/files', target:'http://127.0.0.1:8082', public:false, protected:true },
    { id:'api', name:'API Painel', defaultPort:8088, protocol:'http', path:'/api', target:'http://127.0.0.1:8088/api', public:true, protected:false },
    { id:'mariadb', name:'MariaDB', defaultPort:3306, protocol:'tcp', path:null, target:'127.0.0.1:3306', public:false, protected:true, exposeOnlyWithAdvancedMode:true },
    { id:'ssh', name:'SSH Termux', defaultPort:8022, protocol:'tcp', path:null, target:'127.0.0.1:8022', public:false, protected:true, exposeOnlyWithAdvancedMode:true }
  ];
}

async function detectServices() {
  const list = baseServices();
  const out = [];
  for (const svc of list) {
    const online = await testTcpPort('127.0.0.1', svc.defaultPort);
    out.push({ ...svc, enabled: online, status: online ? 'Online' : 'Offline' });
  }
  return out;
}

module.exports = { detectServices, baseServices };
