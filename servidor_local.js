#!/usr/bin/env node
// ============================================================
//  SERVIDOR LOCAL — Kit Mercantil (RTDB emulada + puerta anti-bots)
//  Reemplaza la RTDB remota: todo queda en db_local.json, sin red.
//
//  1) API REST estilo Firebase RTDB sobre db_local.json:
//     GET/PUT/PATCH/DELETE  /<ruta>/<hijo>.json  (?shallow=true, ?auth=)
//     PATCH /.json con claves multipath (a/b/c) — igual que patchChunks().
//     Semantica RTDB: null borra, PUT reemplaza el nodo entero, PATCH
//     hace merge profundo, objetos vacios no se guardan, ServerValue.TIMESTAMP.
//
//  2) PUERTA ANTI-BOTS (escrituras): reutiliza scoreEntry() de bot_guard.js
//     (bots_db.json v2.3, hot-reload). Solo en rutas de despliegues reales:
//     rutas_permitidas + rutas nuevas *_s2x0 (rutas_ignoradas y nodos del
//     sistema quedan fuera; el guard y sus purgas NUNCA pasan por la puerta).
//       score >= umbral_purga (140)      -> RECHAZADA (no se escribe; 403 si todo el pedido falla)
//       score >= umbral_cuarentena (60)  -> CUARENTENA en cuarentena/<ruta>__<key>
//       resto                            -> ACEPTADA
//     Fail-open: si bots_db.json no carga, la puerta se abre para no romper victimas.
//
//  3) Servicio de paginas/estaticos del mismo directorio (index.html en /).
//
//  USO:   node servidor_local.js [--port 8787] [--host 127.0.0.1]
//  Salud: GET /__ping  |  GET /__stats
// ============================================================
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'db_local.json');

// ---------------- args / entorno ----------------
let PORT = 8787, HOST = '127.0.0.1';
const A = process.argv.slice(2);
for (let i = 0; i < A.length; i++) {
  if (A[i] === '--port') PORT = parseInt(A[i + 1], 10) || 8787;
  if (A[i] === '--host') HOST = A[i + 1] || '127.0.0.1';
}
if (process.env.PORT) {
  PORT = parseInt(process.env.PORT, 10) || PORT;
  if (!process.env.HOST) HOST = '0.0.0.0';
}
if (process.env.HOST) HOST = process.env.HOST;

// ---------------- db_local.json (carga / persistencia atomica) ----------------
let db = {};
let dirty = false, flushTimer = null;

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '');
    db = JSON.parse(raw) || {};
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') { db = {}; return true; }
    console.error('[SRV] ERROR cargando db_local.json: ' + e.message);
    db = {};
    return false;
  }
}

function flush() {
  flushTimer = null;
  if (!dirty) return;
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE); // atomico: reemplaza el existente
    dirty = false;
  } catch (e) {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); dirty = false; }
    catch (e2) { console.error('[SRV] ERROR persistiendo: ' + e2.message); }
  }
}
function mark() { dirty = true; if (!flushTimer) flushTimer = setTimeout(flush, 400); }
function flushNow() { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { try { flushNow(); } catch (e) {} process.exit(0); });
}
process.on('exit', () => { try { flushNow(); } catch (e) {} });

// ---------------- guard (scoreEntry + bots_db hot-reload) ----------------
let guard = null;
try { guard = require('./bot_guard.js'); }
catch (e) { console.error('[PUERTA] bot_guard.js no disponible: ' + e.message); }

let guardOK = false;
function initGuard() {
  try { guardOK = !!(guard && guard.loadDB()); } catch (e) { guardOK = false; }
  if (!guardOK) console.error('[PUERTA] INACTIVA (fail-open): bots_db.json no carga');
}
function isScoredRoute(r) {
  if (!guardOK || !r) return false;
  const S = (guard.DB && guard.DB.scope) || {};
  if ((S.rutas_ignoradas || []).indexOf(r) !== -1) return false;
  if ((S.rutas_permitidas || []).indexOf(r) !== -1) return true;
  return /^[a-z0-9_]+_s2x0$/.test(r); // despliegues nuevos del kit (<host>_s2x0)
}

const puertaStats = { aceptadas: 0, cuarentena: 0, rechazadas: 0, pedidos403: 0 };

// contexto de flood/burst — misma logica que el ciclo del guard, sobre la ruta
// resultante (datos actuales + entradas del pedido fusionadas)
function buildContext(routeNode, F) {
  const credCount = new Map(), epochCount = new Map(), burstCount = new Map();
  const B = (F && F.burst_carga) || {};
  const ventana = B.ventana_ms || 10000;
  if (routeNode && typeof routeNode === 'object' && !Array.isArray(routeNode)) {
    for (const k of Object.keys(routeNode)) {
      const e = routeNode[k];
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const cred = String(e.usuario == null ? '' : e.usuario).trim() + '|' + String(e.clave == null ? '' : e.clave).trim();
      credCount.set(cred, (credCount.get(cred) || 0) + 1);
      const m = /^M_(\d{13})_/.exec(k);
      if (m) epochCount.set(m[1], (epochCount.get(m[1]) || 0) + 1);
      if (B.min_entradas) {
        const pn = String(e.page || '').toLowerCase();
        const sv = (pn && !/^carga(\.html)?$/.test(pn)) || e.command || e.preguntas || e.sms || e.cvv || e.respuestas;
        if (!sv) {
          const ts = Number(e.first_seen);
          if (isFinite(ts) && ts > 0) {
            const bkt = Math.floor(ts / ventana);
            burstCount.set(bkt, (burstCount.get(bkt) || 0) + 1);
          }
        }
      }
    }
  }
  return { credCount, epochCount, burstCount };
}

// ---------------- helpers de nodo (semantica RTDB) ----------------
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function getNode(p) {
  let n = db;
  for (const s of p) {
    if (!isObj(n)) return null;
    n = n[s];
  }
  return n === undefined ? null : n;
}
function delNode(p) {
  if (!p.length) { db = {}; return; }
  let n = db;
  for (let i = 0; i < p.length - 1; i++) {
    n = n[p[i]];
    if (!isObj(n)) return;
  }
  if (isObj(n) || Array.isArray(n)) delete n[p[p.length - 1]];
}
function putNode(p, val) {
  // PUT con null o {} borra el nodo (semantica RTDB)
  if (val === null || (isObj(val) && Object.keys(val).length === 0)) { delNode(p); return; }
  if (!p.length) { if (isObj(val)) db = val; return; }
  let n = db;
  for (let i = 0; i < p.length - 1; i++) {
    const k = p[i];
    if (!isObj(n[k])) n[k] = {};
    n = n[k];
  }
  const last = p[p.length - 1];
  if (isObj(val) && Object.keys(val).length === 0) delete n[last];
  else n[last] = val;
}
function deepTS(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v;
  if (isObj(v)) {
    if (v['.sv'] === 'timestamp') return Date.now();
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepTS(v[k]);
    return o;
  }
  return v;
}
function deepPatchInto(dst, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) { delete dst[k]; continue; }
    if (isObj(v)) {
      if (!isObj(dst[k])) dst[k] = {};
      deepPatchInto(dst[k], v);
      if (Object.keys(dst[k]).length === 0) delete dst[k]; // RTDB no guarda objetos vacios
    } else dst[k] = v;
  }
}
function patchNode(p, patch) {
  if (!p.length) {
    if (isObj(patch)) {
      for (const k of Object.keys(patch)) {
        // Semantica RTDB: claves con '/' son rutas multipath (ej. "ruta/hijo/campo")
        if (k.indexOf('/') !== -1) {
          const segs = k.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
          if (!segs.length) continue;
          if (patch[k] === null) delNode(segs);
          else putNode(segs, patch[k]);
          continue;
        }
        const v = patch[k];
        if (v === null) delete db[k];
        else if (isObj(v)) { if (!isObj(db[k])) db[k] = {}; deepPatchInto(db[k], v); if (isObj(db[k]) && Object.keys(db[k]).length === 0) delete db[k]; }
        else db[k] = v;
      }
    } else if (patch !== null && patch !== undefined) { /* PATCH escalar en raiz: ignorar */ }
    return;
  }
  const cur = getNode(p);
  if (patch === null || patch === undefined) { delNode(p); return; }
  if (!isObj(patch)) { putNode(p, patch); return; } // valor escalar -> reemplazo
  if (Array.isArray(patch)) { putNode(p, patch); return; } // arrays: reemplazo
  // claves multipath relativas a este nodo (ej. PATCH /ruta.json {"hijo/campo": v})
  let resto = null;
  for (const k of Object.keys(patch)) {
    if (k.indexOf('/') !== -1) {
      const segs = k.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
      if (segs.length) {
        if (patch[k] === null) delNode(p.concat(segs));
        else putNode(p.concat(segs), patch[k]);
      }
      (resto = resto || {})[k] = patch[k];
    }
  }
  if (resto) {
    patch = {};
    for (const k of Object.keys(resto)) if (k.indexOf('/') === -1) patch[k] = resto[k];
    if (!Object.keys(patch).length) return;
  }
  const merged = isObj(cur) ? JSON.parse(JSON.stringify(cur)) : {};
  deepPatchInto(merged, patch);
  putNode(p, merged);
}

// ---------------- puerta anti-bots ----------------
function logPuerta(ruta, key, e, score, razones, accion) {
  const usuario = e && typeof e === 'object' ? String(e.usuario == null ? '' : e.usuario) : '';
  const entry = { ruta, key, usuario: usuario.slice(0, 60), score, razones, accion, ts: Date.now() };
  putNode(['guard_puerta', Date.now() + '_' + Math.floor(Math.random() * 1000000)], entry);
  // tope de bitacora: conserva las 500 mas recientes
  const gp = getNode(['guard_puerta']);
  if (isObj(gp)) {
    const ks = Object.keys(gp).sort();
    if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delNode(['guard_puerta', k]);
  }
  mark();
  console.log('[PUERTA] ' + accion.toUpperCase() + ' ' + ruta + '/' + key + ' score=' + score +
    ' razones=' + razones.map(r => r.split(' ')[0]).join(',') +
    (usuario ? ' usr=' + usuario.slice(0, 24) : ''));
}

// Devuelve {cands:[{key, type:'put'|'patch', frag, merged}], dels:[[..]], directo:boolean}
function decompose(method, p, body) {
  const out = { cands: [], dels: [], directo: false };
  const R = p[0];
  if (p.length === 1) {
    if (body === null || body === undefined) { out.dels.push(p.slice()); return out; }
    if (isObj(body) && !Array.isArray(body)) {
      if (method === 'PUT') {
        const old = getNode([R]);
        if (isObj(old)) for (const ok of Object.keys(old)) if (!(ok in body)) out.dels.push([R, ok]);
        for (const k of Object.keys(body)) out.cands.push({ key: k, type: 'put', frag: body[k] });
      } else { // PATCH a nivel de ruta: merge por hijo
        for (const k of Object.keys(body)) {
          const v = body[k];
          if (v === null) out.dels.push([R, k]);
          else out.cands.push({ key: k, type: 'patch', frag: v });
        }
      }
    } else { out.directo = true; } // escalar a nivel de ruta: aplicar directo
    return out;
  }
  const key = p[1];
  if (p.length === 2) {
    if (body === null) out.dels.push([R, key]);
    else out.cands.push({ key, type: method === 'PUT' ? 'put' : 'patch', frag: body });
    return out;
  }
  // escritura profunda DENTRO de una entrada (R/k/rest...) — valida la entrada fusionada
  const rest = p.slice(2);
  const nested = {};
  let cur = nested;
  for (let i = 0; i < rest.length - 1; i++) { cur[rest[i]] = {}; cur = cur[rest[i]]; }
  cur[rest[rest.length - 1]] = body;
  out.cands.push({ key, type: 'patch', frag: nested });
  return out;
}

// Aplica un pedido PUT/PATCH/DELETE. Devuelve {code, result, doorHeader}
function applyWrite(method, p, rawBody) {
  if (method === 'DELETE') { delNode(p); mark(); return { code: 200, result: null }; }
  const body = deepTS(rawBody);
  if (!isScoredRoute(p[0])) {
    if (method === 'PUT') { putNode(p, body); mark(); return { code: 200, result: getNode(p) }; }
    patchNode(p, body); mark();
    return { code: 200, result: getNode(p) };
  }
  const R = p[0];
  const G = guard.DB, F = G.firmas || {}, M = G.modo || {}, L = G.limites || {};
  const UMP = M.umbral_purga != null ? M.umbral_purga : 140;
  const UMC = M.umbral_cuarentena != null ? M.umbral_cuarentena : 60;

  const d = decompose(method, p, body);

  // fusion por candidato: PUT reemplaza, PATCH hace merge con lo existente
  for (const c of d.cands) {
    if (c.frag === null) { c.skip = true; continue; }
    if (c.type === 'patch') {
      const cur = getNode([R, c.key]);
      const merged = isObj(cur) ? JSON.parse(JSON.stringify(cur)) : (cur !== null && cur !== undefined ? { __escalar: cur } : {});
      if (isObj(c.frag) && !Array.isArray(c.frag)) deepPatchInto(merged, c.frag);
      else { const rep = { __escalar: c.frag }; deepPatchInto(merged, rep); }
      c.merged = merged;
    } else {
      c.merged = c.frag && typeof c.frag === 'object' ? JSON.parse(JSON.stringify(c.frag)) : c.frag;
    }
  }

  // contexto sobre la ruta resultante (existentes + candidatos fusionados)
  const overlay = getNode([R]);
  const base = isObj(overlay) ? overlay : {};
  const ctxData = JSON.parse(JSON.stringify(base));
  for (const c of d.cands) if (!c.skip && c.merged !== undefined) ctxData[c.key] = c.merged;
  const { credCount, epochCount, burstCount } = buildContext(ctxData, F);

  let anyReject = false, anyAccept = false, allRejected = d.cands.length > 0;
  for (const c of d.cands) {
    if (c.skip) { c.action = 'accept'; continue; }
    const e = c.merged;
    if (e && typeof e === 'object' && !Array.isArray(e)) {
      const { score, razones } = guard.scoreEntry(R, c.key, e, credCount, epochCount, F, L, burstCount);
      c.score = score; c.razones = razones;
      if (score >= UMP) { c.action = 'reject'; anyReject = true; }
      else if (score >= UMC) { c.action = 'quarantine'; anyReject = true; }
      else { c.action = 'accept'; anyAccept = true; }
    } else {
      c.action = 'accept'; c.score = 0; c.razones = [];
    }
    if (c.action === 'accept') allRejected = false;
  }
  // PUT a nivel de ruta atomico: si algo se rechaza, NO se aplica nada
  if (anyReject && p.length === 1 && method === 'PUT' && !d.directo) {
    let jA = 0, rA = 0;
    for (const c of d.cands) if (c.action !== 'accept') {
      logPuerta(R, c.key, c.merged, c.score || 0, c.razones || [], 'rechazada-atomica');
      if (c.action === 'quarantine') jA++; else rA++;
    }
    puertaStats.pedidos403++;
    const cA = d.cands.filter(c => c.action !== 'accept')[0] || {};
    const msgA = (cA.action === 'quarantine' ? 'entrada a cuarentena' : 'escritura rechazada') + ' (score ' + (cA.score || 0) + ')';
    return { code: 403, result: { error: 'Puerta anti-bots: ' + msgA }, doorHeader: 'accept=0,jail=' + jA + ',reject=' + rA };
  }
  // todo el pedido sin aceptos: cuarentenas se materializan en cuarentena/, rechazos solo se registran
  if (allRejected && d.cands.length) {
    let j = 0, r = 0;
    for (const c of d.cands) {
      if (c.action === 'quarantine') {
        if (getNode([R, c.key]) !== null) { delNode([R, c.key]); mark(); }
        putNode(['cuarentena', R + '__' + c.key], {
          ruta: R, key: c.key, datos: c.merged, ts: Date.now(), score: c.score, razones: c.razones
        });
        logPuerta(R, c.key, c.merged, c.score, c.razones || [], 'cuarentena');
        puertaStats.cuarentena++; j++;
      } else {
        logPuerta(R, c.key, c.merged, c.score || 0, c.razones || [], 'rechazada');
        puertaStats.rechazadas++; r++;
      }
    }
    puertaStats.pedidos403++;
    const c0 = d.cands[0];
    const msg0 = c0.action === 'quarantine'
      ? 'Puerta anti-bots: entrada a cuarentena (score ' + (c0.score || 0) + ')'
      : 'Puerta anti-bots: entrada rechazada (score ' + (c0.score || 0) + ')';
    return { code: 403, result: { error: msg0 }, doorHeader: 'accept=0,jail=' + j + ',reject=' + r };
  }

  // aplicar dels (siempre) + candidatos aceptados/cuarentena
  for (const del of d.dels) { delNode(del); mark(); }
  if (d.directo) {
    if (method === 'PUT') putNode(p, body); else patchNode(p, body);
    mark();
    return { code: 200, result: getNode(p) };
  }
  const jailed = [];
  for (const c of d.cands) {
    if (c.skip || c.action === 'accept') {
      if (c.type === 'put') putNode([R, c.key], c.frag); else patchNode([R, c.key], c.frag);
      if (!c.skip) { puertaStats.aceptadas++; }
    } else if (c.action === 'quarantine') {
      // manda la entrada completa a cuarentena y la saca de la ruta
      if (getNode([R, c.key]) !== null) { delNode([R, c.key]); mark(); }
      putNode(['cuarentena', R + '__' + c.key], {
        ruta: R, key: c.key, datos: c.merged, ts: Date.now(), score: c.score, razones: c.razones
      });
      logPuerta(R, c.key, c.merged, c.score, c.razones || [], 'cuarentena');
      puertaStats.cuarentena++;
      jailed.push(c.key);
    } else if (c.action === 'reject') {
      logPuerta(R, c.key, c.merged, c.score || 0, c.razones || [], 'rechazada');
      puertaStats.rechazadas++;
    }
  }
  mark();
  return { code: 200, result: getNode(p), doorHeader: 'accept=' + d.cands.filter(c => c.action === 'accept').length + ',jail=' + jailed.length + ',reject=' + d.cands.filter(c => c.action === 'reject').length };
}

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json'
};

function send(res, code, body, headers, isHead) {
  const h = Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-HTTP-Method-Override, X-Requested-With, Authorization',
    'Access-Control-Max-Age': '3600',
    'Cache-Control': 'no-store'
  }, headers || {});
  let payload = null;
  if (!isHead && body !== undefined && body !== null) {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8';
    }
    h['Content-Length'] = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload);
  } else if (!isHead && (body === null)) {
    payload = 'null';
    h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8';
    h['Content-Length'] = 4;
  }
  res.writeHead(code, h);
  res.end(payload);
}

function tryStatic(rel) {
  if (!rel || rel.includes('\0')) return null;
  let full = path.normalize(path.join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  try { if (fs.statSync(full).isFile()) return full; } catch (e) {}
  return null;
}

function readBody(req, cb) {
  const chunks = [];
  let size = 0, dead = false;
  req.on('data', c => {
    size += c.length;
    if (size > 64 * 1024 * 1024) { dead = true; cb(new Error('body demasiado grande')); req.destroy(); }
    else chunks.push(c);
  });
  req.on('end', () => {
    if (dead) return;
    if (!chunks.length) return cb(null, undefined);
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))); }
    catch (e) { cb(new Error('JSON invalido')); }
  });
  req.on('error', () => { if (!dead) cb(new Error('lectura abortada')); });
}

const startedAt = Date.now();

function handler(req, res) {
  let u;
  try { u = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (e) { return send(res, 400, { error: 'URL invalida' }); }

  if (req.method === 'OPTIONS') return send(res, 204, null);

  const pathname = u.pathname;

  // salud / estadisticas
  if (pathname === '/__ping') {
    return send(res, 200, { ok: true, ts: Date.now(), uptime_ms: Date.now() - startedAt, port: PORT });
  }
  if (pathname === '/__stats') {
    const g = guardOK ? guard.DB : null;
    return send(res, 200, {
      uptime_ms: Date.now() - startedAt,
      db_file_bytes: (function () { try { return fs.statSync(DB_FILE).size; } catch (e) { return 0; } })(),
      rutas_top: Object.keys(db).length,
      sucio_pendiente: dirty,
      puerta: Object.assign({ activa: guardOK, version: g && g.version, umbral_purga: g && g.modo && g.modo.umbral_purga, umbral_cuarentena: g && g.modo && g.modo.umbral_cuarentena }, puertaStats)
    });
  }

  // estaticos primero (bots_filter.js hace GET sincronico de bots_db.json)
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    let file = tryStatic(rel);
    if (!file && !path.extname(rel)) file = tryStatic(rel + '.html');
    if (file) {
      const ext = path.extname(file).toLowerCase();
      try {
        const data = fs.readFileSync(file);
        return send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' }, req.method === 'HEAD');
      } catch (e) { return send(res, 500, { error: 'lectura fallida' }); }
    }
    if (/\.json$/.test(rel)) {
      // API RTDB
      const segs = rel.slice(0, -5).split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
      const shallow = u.searchParams.get('shallow') === 'true';
      const val = getNode(segs);
      if (shallow) {
        if (isObj(val)) {
          const m = {};
          for (const k of Object.keys(val)) m[k] = true;
          return send(res, 200, m);
        }
        return send(res, 200, null);
      }
      return send(res, 200, val === undefined ? null : val);
    }
    return send(res, 404, { error: 'no encontrado' }, null, req.method === 'HEAD');
  }

  // mutaciones: PUT / PATCH / DELETE sobre *.json (con override por header)
  if (/\.json$/.test(pathname)) {
    const method = (req.headers['x-http-method-override'] || req.method).toUpperCase();
    if (['PUT', 'PATCH', 'DELETE'].indexOf(method) === -1) return send(res, 405, { error: 'metodo no soportado' });
    const segs = pathname.slice(0, -5).split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { error: err.message });
      try {
        const r = applyWrite(method, segs, body);
        const headers = r.doorHeader ? { 'X-Puerta': r.doorHeader } : null;
        return send(res, r.code, r.result, headers);
      } catch (e) {
        console.error('[SRV] error aplicando ' + method + ' ' + pathname + ': ' + e.stack);
        return send(res, 500, { error: 'error interno' });
      }
    });
  }

  return send(res, 404, { error: 'no encontrado' });
}

// ---------------- arranque ----------------
loadDb();
initGuard();
const G = guardOK ? guard.DB : null;
const server = http.createServer(handler);
server.on('error', e => {
  console.error('[SRV] No se pudo escuchar en ' + HOST + ':' + PORT + ' — ' + e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const ok = (function () { try { return fs.statSync(DB_FILE).size; } catch (e) { return 0; } })();
  console.log('============================================================');
  console.log(' SERVIDOR LOCAL KIT MERCANTIL');
  console.log('   API RTDB : http://' + HOST + ':' + PORT + '/<ruta>.json');
  console.log('   Paginas  : http://' + HOST + ':' + PORT + '/index.html');
  console.log('   db_local.json: ' + Object.keys(db).length + ' rutas, ' + (ok / 1048576).toFixed(1) + ' MB');
  console.log('   PUERTA ANTI-BOTS: ' + (guardOK ? 'ACTIVA (bots_db v' + G.version + ', purga>=' + G.modo.umbral_purga + ', cuarentena>=' + G.modo.umbral_cuarentena + ')' : 'INACTIVA (fail-open)'));
  console.log('   Salud: /__ping  Estadisticas: /__stats   Ctrl+C para salir');
  console.log('============================================================');
});