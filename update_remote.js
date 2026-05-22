const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connectado. Atualizando servidor remoto...');
  conn.exec('cd ~/termux-panel && git pull && node index.js', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: '192.168.1.107',
  port: 8022, // Termux usually uses 8022
  username: 'u0_a164',
  password: 'mapamundi'
});
