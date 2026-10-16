// ==========================================
// CONFIGURACIÓN AUTOMÁTICA POR URL
// ==========================================

// Extrae el dominio actual de la URL automáticamente
var _domain = window.location.hostname;
if (!_domain) { _domain = "local_test"; }

// Limpia el nombre para que Firebase lo acepte (cambia puntos por guiones bajos)
var SITE_ID = _domain.replace(/[^a-zA-Z0-9]/g, '_') + '_s2x0';