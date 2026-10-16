// Auto-Cleaner autónomo que corre en Node.js y purga los bots en tiempo real
const https = require("https");
const base = "https://device-streaming-2f9e68b6-default-rtdb.firebaseio.com/informacion_jorel_s_a_workers_dev_s2x0";

console.log("🛡️ Auto-Cleaner iniciado. Protegiendo en tiempo real...");

async function cleanCycle() {
  try {
    const keys = await new Promise((resolve, reject) => {
      https.get(base + ".json?shallow=true", (res) => {
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
          const req = https.request(base + ".json", {
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
      console.log(`[${new Date().toLocaleTimeString()}] 🔥 ${botKeys.length} bots eliminados al instante.`);
    }
  } catch (err) {
    console.error("Error en ciclo:", err.message);
  }
}

// Ejecutar cada 3 segundos indefinidamente
cleanCycle();
setInterval(cleanCycle, 3000);
