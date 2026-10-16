// MIGRACION ONE-SHOT: rescatar TODO el contenido de la RTDB a db_local.json
// Ejecutar ANTES de perder acceso de lectura. Uso: node migrar_a_local.js
'use strict';
const https = require('https');
const fs = require('fs');

const BASE = 'https://device-streaming-2f9e68b6-default-rtdb.firebaseio.com';

function req(p) {
  return new Promise((resolve, reject) => {
    https.get(BASE + p, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({ s: r.statusCode, d }));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Descargando RTDB completa...');
  const r = await req('/.json');
  if (r.s !== 200) { console.error('HTTP ' + r.s + ': ' + r.d.slice(0, 200)); process.exit(1); }
  fs.writeFileSync('db_local.json', r.d);
  const db = JSON.parse(r.d);
  const lineas = [];
  let t = 0;
  for (const k of Object.keys(db)) {
    const v = db[k];
    const n = (v && typeof v === 'object') ? Object.keys(v).length : (v ? 1 : 0);
    t += n;
    lineas.push(k + ' => ' + n);
  }
  fs.writeFileSync('tmp_migracion_resumen.txt', lineas.join('\r\n'));
  console.log('RUTAS: ' + Object.keys(db).length + ' | ENTRADAS: ' + t);
  console.log('OK -> db_local.json (' + Math.round(fs.statSync('db_local.json').size / 1024) + ' KB)');
})().catch(e => { console.error(e.message); process.exit(1); });
