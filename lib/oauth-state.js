// lib/oauth-state.js
// Firma y verifica el `state` de OAuth con HMAC-SHA256.
// Previene que un atacante manipule el user_id incrustado.
//
// Formato: "<payload>:<hmac16>"
// Donde payload es por ejemplo "gmail" o "gmail:<userId>".

const crypto = require('crypto');

function getSecret() {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.CRON_SECRET;
  if (!secret) throw new Error('OAUTH_STATE_SECRET (o CRON_SECRET como fallback) no configurado');
  return secret;
}

function signState(payload) {
  if (typeof payload !== 'string' || !payload.length) {
    throw new Error('Payload de state vacío');
  }
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${hmac}`;
}

// Devuelve el payload original si la firma es válida; null si no.
function verifyState(state) {
  if (!state || typeof state !== 'string') return null;
  const parts = state.split(':');
  if (parts.length < 2) return null;
  const hmac = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(':');
  try {
    const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex').slice(0, 16);
    if (hmac.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hmac, 'utf8'), Buffer.from(expected, 'utf8'))) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { signState, verifyState };
