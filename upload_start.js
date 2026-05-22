const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const conn = new Client();

const localFiles = [
  'scripts/start.sh'
];

conn.on('ready', () => {
  console.log('SSH Conectado. Enviando start.sh modificado...');
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
            console.log('Arquivo enviado com sucesso. Como start.sh é um script de shell, vou dar permissão de execução (chmod +x) nele...');
            conn.exec('chmod +x /data/data/com.termux/files/home/termux-panel/scripts/start.sh', (err, stream2) => {
                 stream2.on('close', () => { conn.end(); });
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
