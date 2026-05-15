// /api/reminders-cron.js
// Cron horario. Dos modos según la hora UTC:
//   • 13:00 UTC (8am Colombia) → resumen diario de eventos de hoy + mañana
//   • Cualquier otra hora       → recordatorio "en 1 hora" para eventos de hoy
// Programado en vercel.json a "0 * * * *" (cada hora en minuto 0).

const supabase = require('../lib/supabase');

const COLOMBIA_OFFSET_HOURS = -5;
const DAILY_UTC_HOUR = 13; // 13:00 UTC = 8:00 am Colombia

function formatearEvento(e) {
  const hora = e.hora ? ` a las ${e.hora}` : '';
  return `${e.titulo}${hora}`;
}

function colombiaDateString(date) {
  const ms = date.getTime() + COLOMBIA_OFFSET_HOURS * 3600 * 1000;
  return new Date(ms).toISOString().split('T')[0];
}

async function disparoSendWhatsApp() {
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://kontrol-app-eight.vercel.app';
    const r = await fetch(`${baseUrl}/api/send-whatsapp`, { method: 'POST' });
    return await r.json().catch(() => null);
  } catch (e) {
    console.error('[reminders-cron] fetch send-whatsapp failed:', e.message);
    return null;
  }
}

// ─── MODO A: resumen diario (8am Colombia) ──────────────────────────
async function modoResumenDiario(res) {
  const ahora = new Date();
  const hoy = colombiaDateString(ahora);
  const manana = colombiaDateString(new Date(ahora.getTime() + 24 * 3600 * 1000));

  console.log('[reminders-cron daily] buscando eventos para fechas Colombia:', { hoy, manana, utcNow: ahora.toISOString() });

  const { data: eventos, error: eventsError } = await supabase
    .from('events')
    .select('*')
    .in('fecha', [hoy, manana])
    .eq('notificado', false);

  if (eventsError) {
    console.error('[reminders-cron daily] query error:', eventsError);
    return res.status(500).json({ error: eventsError.message });
  }

  console.log('[reminders-cron daily] eventos encontrados:', (eventos || []).length);

  if (!eventos || !eventos.length) {
    return res.json({ ok: true, modo: 'diario', message: 'Sin eventos', alertas_creadas: 0, hoy, manana });
  }

  const porUsuario = {};
  for (const e of eventos) {
    if (!e.user_id) continue;
    if (!porUsuario[e.user_id]) porUsuario[e.user_id] = { hoy: [], manana: [] };
    if (e.fecha === hoy) porUsuario[e.user_id].hoy.push(e);
    else porUsuario[e.user_id].manana.push(e);
  }

  const userIds = Object.keys(porUsuario);
  const { data: profiles } = await supabase
    .from('profiles').select('id, telefono, nombre').in('id', userIds);
  const tels = {};
  for (const p of (profiles || [])) {
    if (p.telefono) tels[p.id] = { telefono: p.telefono, nombre: p.nombre };
  }

  let alertasCreadas = 0;
  const eventoIds = [];

  for (const userId of userIds) {
    const info = tels[userId];
    if (!info) continue;

    const { hoy: eHoy, manana: eMan } = porUsuario[userId];
    const partes = [];
    if (eHoy.length) partes.push('📅 *Hoy:*\n' + eHoy.map(e => `• ${formatearEvento(e)}`).join('\n'));
    if (eMan.length) partes.push('📆 *Mañana:*\n' + eMan.map(e => `• ${formatearEvento(e)}`).join('\n'));
    if (!partes.length) continue;

    const saludo = info.nombre ? `Hola ${info.nombre}, ` : '';
    const mensaje = `${saludo}aquí tus recordatorios de Kontrol:\n\n${partes.join('\n\n')}`;

    const { error: insertError } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_agenda', mensaje, telefono: info.telefono, enviado: false
    });
    if (insertError) {
      console.error('[reminders-cron daily] insert failed for', userId, insertError.message);
      continue;
    }

    alertasCreadas++;
    for (const e of eHoy) eventoIds.push(e.id);
    for (const e of eMan) eventoIds.push(e.id);
  }

  if (eventoIds.length) {
    await supabase.from('events').update({ notificado: true }).in('id', eventoIds);
  }

  const sendResp = alertasCreadas > 0 ? await disparoSendWhatsApp() : null;

  return res.json({
    ok: true, modo: 'diario',
    fecha_hoy: hoy, fecha_manana: manana,
    eventos_encontrados: eventos.length,
    alertas_creadas: alertasCreadas,
    eventos_marcados: eventoIds.length,
    send_whatsapp_response: sendResp
  });
}

// ─── MODO B: recordatorio 1 hora antes (cada hora no-13UTC) ────────
async function modoUnaHoraAntes(res) {
  const ahora = new Date();
  const hoyCol = colombiaDateString(ahora);
  const nowMs = ahora.getTime();

  console.log('[reminders-cron 1h] buscando eventos para fecha Colombia:', { hoyCol, utcNow: ahora.toISOString() });

  const { data: eventos, error: eventsError } = await supabase
    .from('events')
    .select('*')
    .eq('fecha', hoyCol)
    .eq('notificado_1h', false);

  if (eventsError) {
    console.error('[reminders-cron 1h] query error:', eventsError);
    // Si la columna no existe (42703), devolvemos mensaje claro
    if (eventsError.code === '42703') {
      return res.status(500).json({
        error: 'Falta la columna events.notificado_1h. Corre: ALTER TABLE events ADD COLUMN notificado_1h boolean DEFAULT false;'
      });
    }
    return res.status(500).json({ error: eventsError.message });
  }

  console.log('[reminders-cron 1h] eventos del día encontrados:', (eventos || []).length);

  // Filtrar a los que ocurren entre 30 y 90 min desde ahora (ventana de 60 min centrada en 1h)
  const candidatos = (eventos || []).filter(e => {
    if (!e.hora) return false;
    const eventTime = new Date(`${e.fecha}T${e.hora}:00-05:00`);
    if (isNaN(eventTime.getTime())) return false;
    const diffMin = (eventTime.getTime() - nowMs) / 60000;
    return diffMin >= 30 && diffMin <= 90;
  });

  console.log('[reminders-cron 1h] candidatos en ventana 30-90 min:', candidatos.length);

  if (!candidatos.length) {
    return res.json({ ok: true, modo: '1h', message: 'Sin eventos en la próxima hora', alertas_creadas: 0, hoyCol });
  }

  const porUsuario = {};
  for (const e of candidatos) {
    if (!e.user_id) continue;
    if (!porUsuario[e.user_id]) porUsuario[e.user_id] = [];
    porUsuario[e.user_id].push(e);
  }

  const userIds = Object.keys(porUsuario);
  const { data: profiles } = await supabase
    .from('profiles').select('id, telefono, nombre').in('id', userIds);
  const tels = {};
  for (const p of (profiles || [])) {
    if (p.telefono) tels[p.id] = { telefono: p.telefono, nombre: p.nombre };
  }

  let alertasCreadas = 0;
  const eventoIds = [];

  for (const userId of userIds) {
    const info = tels[userId];
    if (!info) continue;

    for (const e of porUsuario[userId]) {
      const mensaje = `⏰ *En 1 hora:* ${e.titulo}${e.hora ? ` a las ${e.hora}` : ''}${e.nota ? `\n${e.nota}` : ''}`;
      const { error: insertError } = await supabase.from('whatsapp_alerts').insert({
        tipo: 'recordatorio_1h', mensaje, telefono: info.telefono, enviado: false
      });
      if (insertError) {
        console.error('[reminders-cron 1h] insert failed for event', e.id, insertError.message);
        continue;
      }
      alertasCreadas++;
      eventoIds.push(e.id);
    }
  }

  if (eventoIds.length) {
    await supabase.from('events').update({ notificado_1h: true }).in('id', eventoIds);
  }

  const sendResp = alertasCreadas > 0 ? await disparoSendWhatsApp() : null;

  return res.json({
    ok: true, modo: '1h',
    fecha: hoyCol,
    candidatos_total: candidatos.length,
    alertas_creadas: alertasCreadas,
    eventos_marcados: eventoIds.length,
    send_whatsapp_response: sendResp
  });
}

// ─── Handler principal: rutea por hora UTC ─────────────────────────
module.exports = async function handler(req, res) {
  // Auth: cron de Vercel viene como GET sin header; manual con CRON_SECRET
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const utcHour = new Date().getUTCHours();
    const force = (req.query && req.query.modo) || null; // ?modo=diario o ?modo=1h para forzar
    const modo = force === 'diario' ? 'diario'
              : force === '1h' ? '1h'
              : (utcHour === DAILY_UTC_HOUR ? 'diario' : '1h');

    console.log('[reminders-cron] start, utcHour=', utcHour, 'modo=', modo);

    if (modo === 'diario') return await modoResumenDiario(res);
    return await modoUnaHoraAntes(res);
  } catch (error) {
    console.error('[reminders-cron] uncaught:', error);
    return res.status(500).json({ error: error.message });
  }
};
