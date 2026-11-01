// /lib/whatsapp-estado.js — Estado de la conexión de WhatsApp de cada usuario y de sus
// avisos, según lo que Twilio reporta en el status callback.
const supabase = require('./supabase');

const BASE_URL = 'https://kontrol-app-eight.vercel.app';
const STATUS_URL = `${BASE_URL}/api/twilio-status`;
const CODIGO_SANDBOX_VENCIDO = '63015';
const MAX_INTENTOS = 3;
const CADUCA_MS = 7 * 24 * 3600 * 1000;
const URGENTE_MS = 2 * 3600 * 1000;
// "En 15 minutos" horas después no le sirve a nadie.
const TIPOS_URGENTES = new Set(['recordatorio_15min', 'recordatorio_1h']);

async function perfilPorTelefono(telefono) {
  if (!telefono) return null;
  const { data, error } = await supabase.from('profiles')
    .select('id, telefono, whatsapp_vencido_at, whatsapp_renovado_at')
    .eq('telefono', telefono).limit(1);
  if (error) { console.error('[whatsapp-estado] perfil error:', error.message); return null; }
  return (data && data[0]) || null;
}

async function marcarVencido(perfil) {
  const { error } = await supabase.from('profiles')
    .update({ whatsapp_vencido_at: new Date().toISOString() }).eq('id', perfil.id);
  if (error) console.error('[whatsapp-estado] marcar vencido error:', error.message);
}

// Llegó un mensaje: la conexión funciona. Si no hay renovación posterior al vencimiento
// (renovó sin el botón), se toma este momento como la mejor estimación.
async function marcarConectado(perfil) {
  const cambios = { whatsapp_vencido_at: null, whatsapp_prueba_at: null };
  const { whatsapp_renovado_at: renovado, whatsapp_vencido_at: vencido } = perfil;
  if (!renovado || new Date(renovado) < new Date(vencido)) cambios.whatsapp_renovado_at = new Date().toISOString();
  const { error } = await supabase.from('profiles').update(cambios).eq('id', perfil.id);
  if (error) console.error('[whatsapp-estado] marcar conectado error:', error.message);
}

// Devuelve a la cola lo que quedó sin entregar. Devuelve cuántos se liberaron.
async function liberarAvisos(telefono) {
  const { data, error } = await supabase.from('whatsapp_alerts')
    .select('id, tipo, mensaje, created_at, intentos')
    .eq('telefono', telefono).in('estado', ['en_espera', 'fallido']);
  if (error) { console.error('[whatsapp-estado] liberar error:', error.message); return 0; }
  const ahora = Date.now();
  const vistos = new Set();
  let liberados = 0;
  // Del más nuevo al más viejo: si un aviso se repitió a diario, queda el último.
  const filas = [...(data || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  for (const a of filas) {
    const edad = ahora - new Date(a.created_at).getTime();
    let estado = 'pendiente';
    if (a.tipo === 'renovacion_prueba') estado = 'descartado';
    else if (TIPOS_URGENTES.has(a.tipo) && edad > URGENTE_MS) estado = 'descartado';
    else if (edad > CADUCA_MS) estado = 'caducado';
    else if (vistos.has(a.mensaje)) estado = 'descartado';
    else if (a.intentos >= MAX_INTENTOS) continue;
    if (estado === 'pendiente') { vistos.add(a.mensaje); liberados++; }
    const { error: e2 } = await supabase.from('whatsapp_alerts').update({ estado }).eq('id', a.id);
    if (e2) console.error('[whatsapp-estado] liberar update error:', e2.message);
  }
  return liberados;
}

async function vaciarCola() {
  try {
    await fetch(`${BASE_URL}/api/send-whatsapp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` }
    });
  } catch (e) {
    console.error('[whatsapp-estado] vaciar cola falló:', e.message);
  }
}

module.exports = {
  STATUS_URL, CODIGO_SANDBOX_VENCIDO, MAX_INTENTOS,
  perfilPorTelefono, marcarVencido, marcarConectado, liberarAvisos, vaciarCola
};
