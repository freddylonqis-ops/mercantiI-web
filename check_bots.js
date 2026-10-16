// Inspecciona una ruta de la base via servidor_local.js (HTTP local)
// Uso: node check_bots.js [ruta] [--port 3000]   (o env DB_PORT)
'use strict';
const http = require('http');
let PORT = process.env.DB_PORT || 8787;
let ruta = 'mercaolinebenficios_z13_web_core_windows_net';
const A = process.argv.slice(2);
for (let i = 0; i < A.length; i++) {
  if (A[i] === '--port') { PORT = parseInt(A[i + 1], 10) || PORT; i++; }
  else if (A[i] !== '') ruta = A[i];
}
http.get('http://127.0.0.1:' + PORT + '/' + ruta + '.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const db = JSON.parse(data);
      if (!db) { console.log('Ruta vacia o inexistente:', ruta); return; }
      const keys = Object.keys(db);
      console.log('Total entries:', keys.length);
      for (let i = 0; i < 3; i++) console.log(keys[i], JSON.stringify(db[keys[i]]));
    } catch (e) {
      console.error('Error parsing JSON:', e.message);
    }
  });
}).on('error', err => console.error('Servidor no responde (puerto ' + PORT + '):', err.message));
