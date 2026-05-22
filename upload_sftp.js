const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const conn = new Client();

const localFiles = [
  'modules/cloudflared/manager.js',
  'modules/cloudflared/routes.js',
  'public/app.js',
  'public/index.html',
  'migrar_legado.js'
];

conn.on('ready', () => {
  console.log('SSH Conectado. Iniciando envio dos arquivos atualizados...');
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
            console.log('Todos os arquivos foram enviados. Reiniciando Node.js...');
            conn.exec('pkill node', (err, stream) => {
                if (err) throw err;
                stream.on('close', () => {
                    console.log('Processo do Node antigo finalizado. O painel será reiniciado pelo seu gerenciador ou pode ser reiniciado manualmente.');
                    conn.end();
                });
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
