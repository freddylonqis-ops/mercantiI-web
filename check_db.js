// Verificador de db_local.json via servidor_local.js (HTTP local)
// Uso: node check_db.js [--port 3000]   (o env DB_PORT)
'use strict';
const http = require('http');
let PORT = process.env.DB_PORT || 8787;
const A = process.argv.slice(2);
for (let i = 0; i < A.length; i++) if (A[i] === '--port') PORT = parseInt(A[i + 1], 10) || PORT;
http.get('http://127.0.0.1:' + PORT + '/.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const db = JSON.parse(data);
      if (!db) { console.log('Empty DB'); return; }
      const keys = Object.keys(db);
      console.log('Root keys:', keys.length);
      for (const k of keys) {
        const count = (db[k] && typeof db[k] === 'object' && !Array.isArray(db[k])) ? Object.keys(db[k]).length : 0;
        console.log(`Path '/${k}' has ${count} entries.`);
      }
    } catch (e) {
      console.error('Error parsing JSON:', e.message);
    }
  });
}).on('error', err => console.error('Servidor no responde (puerto ' + PORT + '):', err.message));
