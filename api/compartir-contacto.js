// /api/compartir-contacto.js — Respaldo de "Compartir → Kontrol" cuando el service worker
// todavía no controla la página (primera vez tras instalar). Normalmente el service worker
// recibe el contacto (.vcf) en el teléfono y este endpoint nunca se llama.
// No lee ni guarda nada: sin la sesión del usuario no se puede saber de quién es.
module.exports = function handler(req, res) {
  res.statusCode = 303;
  res.setHeader('Location', '/?compartido=sin-sw');
  res.end();
};
