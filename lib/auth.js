// /lib/auth.js — Autenticación de endpoints que gastan APIs de pago o envían mensajes.
const supabase = require('./supabase');

function tokenDe(req) {
  return (req.headers.authorization || '').replace('Bearer ', '').trim();
}

// Llamadas del sistema: crons de Vercel, cron-job.org y otros endpoints.
function esSistema(req) {
  return !!process.env.CRON_SECRET && tokenDe(req) === process.env.CRON_SECRET;
}

// Sistema o un usuario con sesión válida de la app.
async function esSistemaOUsuario(req) {
  if (esSistema(req)) return true;
  const token = tokenDe(req);
  if (!token) return false;
  const { data, error } = await supabase.auth.getUser(token);
  return !error && !!data?.user;
}

// ¿Quién llama? { ok, userId }. El sistema puede decir de qué usuario es la petición con la
// cabecera x-kontrol-usuario (solo vale con el secreto del sistema); un usuario es el de su sesión.
async function quienLlama(req) {
  if (esSistema(req)) return { ok: true, userId: String(req.headers['x-kontrol-usuario'] || '') || null };
  const token = tokenDe(req);
  if (!token) return { ok: false };
  const { data, error } = await supabase.auth.getUser(token);
  return !error && data?.user ? { ok: true, userId: data.user.id } : { ok: false };
}

module.exports = { esSistema, esSistemaOUsuario, quienLlama };
