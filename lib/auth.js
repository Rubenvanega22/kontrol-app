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

module.exports = { esSistema, esSistemaOUsuario };
