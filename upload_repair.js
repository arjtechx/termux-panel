const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const conn = new Client();

const localFiles = [
  'modules/cloudflared/manager.js'
];

conn.on('ready', () => {
  console.log('SSH Conectado. Enviando manager.js corrigido...');
  conn.sftp((err, sftp) => {
    if (err) throw err;

    let uploads = 0;
    
    localFiles.forEach(file => {
      const localPath = path.join(__dirname, file);
      const remotePath = `/data/data/com.termux/files/home/termux-panel/${file}`;
      
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) {
            console.error('Erro ao enviar ' + file + ':', err.message);
        } else {
            console.log('✅ ' + file + ' enviado!');
        }
        uploads++;
        
        if (uploads === localFiles.length) {
            console.log('Todos os arquivos foram enviados. Reparando banco de dados corrompido...');
            conn.exec(`node -e "
                const fs = require('fs');
                const path = require('path');
                const dbPath = '/data/data/com.termux/files/home/termux-panel/data/cloudflared-instances.json';
                if (fs.existsSync(dbPath)) {
                    let data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                    data = data.filter(i => i.name !== 'Túneis Legados (Migração)');
                    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
                    console.log('Banco de dados reparado com sucesso.');
                }
            "`, (err, stream) => {
                if (err) throw err;
                stream.on('close', () => {
                    console.log('Reparo concluído. Reiniciando Node...');
                    conn.exec('pkill node', (err, stream2) => {
                         stream2.on('close', () => { conn.end(); });
                    });
                }).on('data', (d) => console.log('STDOUT: ' + d));
            });
        }
      });
    });
  });
}).connect({
  host: '192.168.1.107',
  port: 8022,
  username: 'u0_a164',
  password: 'mapamundi'
});
