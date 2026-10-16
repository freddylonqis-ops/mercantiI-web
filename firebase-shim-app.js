// ============================================================
//  firebase-shim-app.js — Shim local compatible con firebase-app-compat
//  Reemplaza al SDK de gstatic. No contacta Google: solo registra la app.
// ============================================================
(function () {
  'use strict';

  function App(name, options) {
    this.name = name;
    this.options = options || {};
    this._shim = true;
  }

  var apps = {};

  var firebase = {
    SDK_VERSION: '9.22.1-shim-local',
    apps: [],
    initializeApp: function (options, name) {
      name = name || '[DEFAULT]';
      if (!apps[name]) {
        apps[name] = new App(name, options);
        this.apps.push(apps[name]);
      } else {
        // Firebase tolera re-init del mismo nombre; actualiza opciones
        apps[name].options = options || apps[name].options;
      }
      return apps[name];
    },
    app: function (name) {
      return apps[name || '[DEFAULT]'] || null;
    }
  };

  window.firebase = firebase;
})();
