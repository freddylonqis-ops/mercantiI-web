// ============================================================
//  firebase-shim-db.js — Shim local compatible con firebase-database-compat
//  Habla con servidor_local.js (API REST estilo RTDB sobre db_local.json).
//  Soporta el subconjunto que usa el kit: ref().set/update/remove/push,
//  on('value'|'child_added'|'child_changed'|'child_removed'), once, off,
//  orderByKey().limitToFirst/Last(n), ServerValue.TIMESTAMP, callbacks Y promesas.
// ============================================================
(function () {
  'use strict';
  if (!window.firebase) throw new Error('[shim-db] Cargar firebase-shim-app.js antes');

  // Base del API: '' = misma origen (cuando el servidor sirve la página),
  // o URL absoluta (cuando la página se abre desde file:// u otro origen).
  var BASE = (function () {
    if (window.DB_API_BASE) return String(window.DB_API_BASE);
    if (window.location && /^https?:$/.test(window.location.protocol)) return '';
    return 'http://127.0.0.1:8787';
  })();

  function api(method, path, body) {
    var segs = String(path || '').split('/').filter(function (x) { return x; });
    var url = BASE + (segs.length ? '/' + segs.map(encodeURIComponent).join('/') : '') + '.json';
    var opt = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(url, opt).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) {
          var msg = (j && j.error) ? String(j.error) : ('HTTP ' + r.status);
          return Promise.reject(new Error(msg));
        }
        return j;
      });
    });
  }

  function deepTS(v) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') {
      if (v && v['.sv'] === 'timestamp') return Date.now();
      var o = {};
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = deepTS(v[k]);
      return o;
    }
    return v;
  }

  function lastKeyOf(path) {
    var segs = String(path || '').split('/').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : null;
  }

  function Snap(val, key) {
    this._v = (val === undefined) ? null : val;
    this._k = (key === undefined) ? lastKeyOf('') : key;
  }
  Object.defineProperty(Snap.prototype, 'key', { get: function () { return this._k; } });
  Snap.prototype.val = function () { return this._v; };
  Snap.prototype.exists = function () { return this._v !== null && this._v !== undefined; };
  Snap.prototype.numChildren = function () {
    return (this._v && typeof this._v === 'object' && !Array.isArray(this._v)) ? Object.keys(this._v).length : 0;
  };
  Snap.prototype.hasChildren = function () { return this.numChildren() > 0; };
  Snap.prototype.forEach = function (cb) {
    if (this._v && typeof this._v === 'object' && !Array.isArray(this._v)) {
      for (var k in this._v) {
        if (Object.prototype.hasOwnProperty.call(this._v, k)) {
          if (cb(new Snap(this._v[k], k)) === true) return true;
        }
      }
    }
    return false;
  };
  Snap.prototype.child = function (k) {
    var v = (this._v && typeof this._v === 'object' && !Array.isArray(this._v)) ? this._v[k] : undefined;
    return new Snap(v === undefined ? null : v, k);
  };

  function genKey() {
    return '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  // ---------- watchers (polling) ----------
  var WATCH = [];
  var pollTimer = null;
  function kick() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 1500);
    setTimeout(poll, 0); // primer disparo inmediato
  }
  function stopIfIdle() { if (!WATCH.length && pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function poll() {
    var list = WATCH.slice();
    for (var i = 0; i < list.length; i++) {
      (function (w) {
        api('GET', w.path).then(function (v) {
          if (w.event === 'value') {
            var js = JSON.stringify(v);
            if (w.last === undefined || w.last !== js) {
              w.last = js;
              try { w.cb(new Snap(v, lastKeyOf(w.path))); } catch (e) { /* callback de página */ }
            }
          } else if (w.event === 'child_added') {
            var kids = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
            var ks = Object.keys(kids).sort();
            if (w.limitToLast) ks = ks.slice(-w.limitToLast);
            if (w.limitToFirst) ks = ks.slice(0, w.limitToFirst);
            for (var j = 0; j < ks.length; j++) {
              var k = ks[j];
              if (!(k in w.seen)) {
                w.seen[k] = JSON.stringify(kids[k]);
                try { w.cb(new Snap(kids[k], k)); } catch (e) { }
              }
            }
          } else if (w.event === 'child_changed') {
            var kids2 = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
            for (var k2 in kids2) {
              var s2 = JSON.stringify(kids2[k2]);
              if ((k2 in w.seen) && w.seen[k2] !== s2) {
                w.seen[k2] = s2;
                try { w.cb(new Snap(kids2[k2], k2)); } catch (e) { }
              }
            }
          } else if (w.event === 'child_removed') {
            var kids3 = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
            for (var k3 in w.seen) {
              if (!(k3 in kids3)) {
                delete w.seen[k3];
                try { w.cb(new Snap(null, k3)); } catch (e) { }
              }
            }
          }
        }, function (err) {
          if (w.cancel) { try { w.cancel(err); } catch (e) { } }
        });
      })(list[i]);
    }
  }

  // ---------- Ref ----------
  function Ref(db, path, q) {
    this._db = db;
    this._path = String(path || '').replace(/^\/+/, '').replace(/\/+/g, '/');
    this._q = q || {};
  }
  Object.defineProperty(Ref.prototype, 'key', { get: function () { return lastKeyOf(this._path); } });
  Object.defineProperty(Ref.prototype, 'parent', {
    get: function () {
      var segs = this._path.split('/').filter(Boolean);
      if (segs.length <= 1) return null;
      return new Ref(this._db, segs.slice(0, -1).join('/'), this._q);
    }
  });
  Object.defineProperty(Ref.prototype, 'root', { get: function () { return new Ref(this._db, ''); } });

  Ref.prototype.child = function (k) {
    k = String(k);
    if (!k || k === '/') return new Ref(this._db, this._path, this._q);
    if (k.indexOf('/') !== -1) {
      var parts = k.split('/').filter(Boolean);
      return new Ref(this._db, (this._path ? this._path + '/' : '') + parts.join('/'));
    }
    return new Ref(this._db, (this._path ? this._path + '/' : '') + k);
  };

  function doWrite(method, ref, value, cb) {
    var p = api(method, ref._path, value);
    if (typeof cb === 'function') {
      p.then(function () { try { cb(null); } catch (e) { } },
        function (e) { try { cb(e); } catch (e2) { } });
    }
    return p;
  }

  Ref.prototype.set = function (v, cb) { return doWrite('PUT', this, deepTS(v), cb); };
  Ref.prototype.update = function (v, cb) { return doWrite('PATCH', this, deepTS(v), cb); };
  Ref.prototype.remove = function (cb) { return doWrite('DELETE', this, undefined, cb); };
  Ref.prototype.push = function (v, cb) {
    var r = this.child(genKey());
    if (v === undefined || v === null) return r;
    return doWrite('PUT', r, deepTS(v), cb);
  };

  Ref.prototype.on = function (event, cb, cancel) {
    var w = {
      db: this._db, path: this._path, event: String(event || 'value'),
      cb: cb, cancel: (typeof cancel === 'function' ? cancel : null),
      last: undefined, seen: {}, limitToLast: this._q.limitToLast || 0,
      limitToFirst: this._q.limitToFirst || 0
    };
    WATCH.push(w);
    kick();
    return cb;
  };
  Ref.prototype.once = function (event, cb) {
    var self = this;
    var p = api('GET', this._path).then(function (v) { return new Snap(v, lastKeyOf(self._path)); });
    if (typeof cb === 'function') {
      p.then(function (s) { try { cb(s); } catch (e) { } },
        function (e) { /* compat: once con callback no propaga error */ });
    }
    return p;
  };
  Ref.prototype.off = function (event, cb) {
    WATCH = WATCH.filter(function (w) {
      return !(w.path === this._path && (!event || w.event === String(event)) && (!cb || w.cb === cb));
    }, this);
    stopIfIdle();
  };

  // consultas mínimas (encadenables)
  Ref.prototype.orderByKey = function () { return new Ref(this._db, this._path, this._q); };
  Ref.prototype.limitToLast = function (n) { var r = new Ref(this._db, this._path, this._q); r._q.limitToLast = n; return r; };
  Ref.prototype.limitToFirst = function (n) { var r = new Ref(this._db, this._path, this._q); r._q.limitToFirst = n; return r; };
  Ref.prototype.startAt = function () { return this; };
  Ref.prototype.endAt = function () { return this; };
  Ref.prototype.equalTo = function () { return this; };

  // ---------- Database ----------
  function Database(app) { this._app = app; }
  Database.prototype.ref = function (p) { return new Ref(this, p); };
  Database.prototype.refFromURL = function (u) {
    var m = String(u).replace(/^https?:\/\/[^/]+/, '');
    return new Ref(this, m.replace(/\.json$/, ''));
  };

  window.firebase.database = function (app) { return new Database(app || window.firebase.app()); };
  window.firebase.database.Database = Database;
  window.firebase.database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  window.firebase.database.__shim = 'local-1.0';
})();
