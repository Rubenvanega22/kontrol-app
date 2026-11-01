// /lib/twilio-signature.js — Verifica X-Twilio-Signature de los webhooks entrantes.
// Twilio firma con HMAC-SHA1 (auth token como clave) la URL completa seguida de
// cada parámetro POST, ordenados por nombre y concatenados como nombre+valor.
const crypto = require('crypto');

function calcularFirma(authToken, url, params) {
  const datos = Object.keys(params || {}).sort()
    .reduce((acc, k) => acc + k + (params[k] == null ? '' : params[k]), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(datos, 'utf-8')).digest('base64');
}

function firmaValida(authToken, firma, url, params) {
  if (!authToken || !firma) return false;
  const esperada = Buffer.from(calcularFirma(authToken, url, params));
  const recibida = Buffer.from(String(firma));
  return esperada.length === recibida.length && crypto.timingSafeEqual(esperada, recibida);
}

// La URL que Twilio firmó: la pública que llamó, con su query string.
// El host viene de la petición, pero sin el auth token no se puede falsificar la firma.
function urlDelWebhook(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}${req.url}`;
}

module.exports = { calcularFirma, firmaValida, urlDelWebhook };
