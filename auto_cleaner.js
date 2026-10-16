// Auto-Cleaner legado (pre-puerta). ATENCION: la puerta anti-bots del
// servidor_local.js ya purga/cuarentena los bots al recibir la escritura,
// así que NO hace falta correr este script. Si se ejecuta contra una ruta
// del kit actual BORRARIA entradas legitimas (las victimas usan claves
// M_<timestamp>_xxx, que este filtro viejo considera "bots").
// Uso solo para rutas legacy:  node auto_cleaner.js [--port 3000] [--ruta X]
'use strict';
const http = require("http");
let PORT = process.env.DB_PORT || 8787;
let base = "http://127.0.0.1:" + PORT + "/informacion_jorel_s_a_workers_dev_s2x0";
const A = process.argv.slice(2);
for (let i = 0; i < A.length; i++) {
  if (A[i] === '--port') { PORT = parseInt(A[i + 1], 10) || PORT; base = "http://127.0.0.1:" + PORT + "/informacion_jorel_s_a_workers_dev_s2x0"; }
  if (A[i] === '--ruta' && A[i + 1]) base = "http://127.0.0.1:" + PORT + "/" + A[i + 1];
}

console.log("Auto-Cleaner (legado) activo sobre " + base);

async function cleanCycle() {
  try {
    const keys = await new Promise((resolve, reject) => {
      http.get(base + ".json?shallow=true", (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            resolve(Object.keys(JSON.parse(data) || {}));
          } catch(e) { resolve([]); }
        });
      }).on("error", reject);
    });

    // Detectar claves inyectadas por bot (timestamp_rand o claves viejas)
    const botKeys = keys.filter(k => k.split("_").length >= 3 || /^M_\d{10,}/.test(k));

    if (botKeys.length > 0) {
      for (let i = 0; i < botKeys.length; i += 500) {
        const chunk = botKeys.slice(i, i + 500);
        const payload = {};
        chunk.forEach(k => payload[k] = null);

        await new Promise((resolve) => {
          const req = http.request(base + ".json", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" }
          }, (res) => {
            res.on("data", () => {});
            res.on("end", resolve);
          });
          req.on("error", () => resolve());
          req.write(JSON.stringify(payload));
          req.end();
        });
      }
      console.log(`[${new Date().toLocaleTimeString()}] ${botKeys.length} bots eliminados al instante.`);
    }
  } catch (err) {
    console.error("Error en ciclo:", err.message);
  }
}

// Ejecutar cada 3 segundos indefinidamente
cleanCycle();
setInterval(cleanCycle, 3000);
