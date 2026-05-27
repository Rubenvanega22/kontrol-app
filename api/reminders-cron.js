// /api/reminders-cron.js
// Diseñado para correr cada 15 min en cron-job.org.
// En cada tick ejecuta los modos "rolling" (15-min antes + 1-hora antes)
// y, en horas específicas Colombia, también los modos diarios:
//   • 13:00 UTC (8am Col) → resumen agenda + recordatorio matutino de pagos
//   • 23:00 UTC (6pm Col) → recordatorio vespertino de pagos no confirmados
// Vercel cron en vercel.json conserva los disparos a 13/23 UTC como respaldo.

const supabase = require('../lib/supabase');

const COLOMBIA_OFFSET_HOURS = -5;
const DAILY_UTC_HOUR = 13;   // 13:00 UTC = 8:00 am Colombia
const EVENING_UTC_HOUR = 23; // 23:00 UTC = 6:00 pm Colombia

function formatearEvento(e) {
  const hora = e.hora ? ` a las ${e.hora}` : '';
  return `${e.titulo}${hora}`;
}

function colombiaDateString(date) {
  const ms = date.getTime() + COLOMBIA_OFFSET_HOURS * 3600 * 1000;
  return new Date(ms).toISOString().split('T')[0];
}

// Postgres TIME llega como "HH:MM:SS" vía PostgREST; toleramos "HH:MM" por si
// algún cliente lo guardó corto. Sin esto, concatenar ":00" producía
// "HH:MM:SS:00-05:00" y new Date(...) devolvía Invalid Date.
function eventToDate(e) {
  if (!e.hora) return null;
  const h = /^\d{2}:\d{2}$/.test(e.hora) ? `${e.hora}:00` : e.hora;
  const t = new Date(`${e.fecha}T${h}-05:00`);
  return isNaN(t.getTime()) ? null : t;
}

async function disparoSendWhatsApp() {
  try {
    // VERCEL_URL apunta al deployment específico (protegido en algunos planes);
    // usamos el alias público estable.
    const baseUrl = 'https://kontrol-app-eight.vercel.app';
    const r = await fetch(`${baseUrl}/api/send-whatsapp`, { method: 'POST' });
    return await r.json().catch(() => null);
  } catch (e) {
    console.error('[reminders-cron] fetch send-whatsapp failed:', e.message);
    return null;
  }
}

// ─── MODO A: resumen diario (8am Colombia) ──────────────────────────
async function modoResumenDiario() {
  const ahora = new Date();
  const hoy = colombiaDateString(ahora);
  const manana = colombiaDateString(new Date(ahora.getTime() + 24 * 3600 * 1000));

  console.log('[reminders-cron daily] hoy=', hoy, 'manana=', manana);

  const { data: eventos, error } = await supabase
    .from('events').select('*')
    .in('fecha', [hoy, manana])
    .eq('notificado_agenda', false);
  if (error) { console.error('[reminders-cron daily] query error:', error.message); return { error: error.message }; }

  if (!eventos || !eventos.length) return { alertas: 0, message: 'sin eventos' };

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

  let alertas = 0;
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
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_agenda', mensaje, telefono: info.telefono, enviado: false
    });
    if (insErr) { console.error('[reminders-cron daily] insert failed', userId, insErr.message); continue; }
    alertas++;
    for (const e of eHoy) eventoIds.push(e.id);
    for (const e of eMan) eventoIds.push(e.id);
  }
  if (eventoIds.length) await supabase.from('events').update({ notificado_agenda: true }).in('id', eventoIds);
  return { alertas, marcados: eventoIds.length, hoy, manana };
}

// ─── Helpers de teléfonos por user_id ──────────────────────────────
async function telefonosPorUsuario(userIds) {
  const { data: profiles } = await supabase
    .from('profiles').select('id, telefono').in('id', userIds);
  const tels = {};
  for (const p of (profiles || [])) if (p.telefono) tels[p.id] = p.telefono;
  return tels;
}

// Guarda estado conversacional event_1h_response para el usuario.
// Permite que /api/whatsapp.js sepa a qué evento se refiere el "1" o "2"
// del usuario. TTL 60 min — si no contesta, se vence y el auto-15min sigue.
async function setStateEvento1h(telefono, userId, evento) {
  const expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('whatsapp_state').upsert({
    phone: telefono, user_id: userId,
    awaiting: 'event_1h_response',
    context: { event_id: evento.id, titulo: evento.titulo, hora: evento.hora },
    expires_at
  }, { onConflict: 'phone' });
  if (error) console.warn('[reminders-cron 1h] no se pudo guardar state:', error.message);
}

// ─── MODO B: recordatorio 1 hora antes ──────────────────────────────
async function modoUnaHoraAntes() {
  const ahora = new Date();
  const hoyCol = colombiaDateString(ahora);
  const nowMs = ahora.getTime();

  const { data: eventos, error } = await supabase
    .from('events').select('*')
    .eq('fecha', hoyCol)
    .eq('notificado_1h', false);
  if (error) { console.error('[reminders-cron 1h] query error:', error.message); return { error: error.message }; }

  // Ventana 30-90 min desde ahora.
  const candidatos = (eventos || []).filter(e => {
    const t = eventToDate(e);
    if (!t) return false;
    const diff = (t.getTime() - nowMs) / 60000;
    return diff >= 30 && diff <= 90;
  });
  if (!candidatos.length) return { alertas: 0, candidatos: 0, hoyCol };

  const userIds = [...new Set(candidatos.map(e => e.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);

  let alertas = 0;
  const eventoIds = [];
  for (const e of candidatos) {
    const tel = tels[e.user_id];
    if (!tel) continue;
    const mensaje =
      `⏰ *En 1 hora:* ${e.titulo}${e.hora ? ` a las ${e.hora}` : ''}${e.nota ? `\n${e.nota}` : ''}\n` +
      `\n¿Necesitas recordatorio de salida?\n` +
      `1. Sí, avísame en 15 min\n` +
      `2. No es necesario`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_1h', mensaje, telefono: tel, enviado: false
    });
    if (insErr) { console.error('[reminders-cron 1h] insert failed event', e.id, insErr.message); continue; }
    alertas++;
    eventoIds.push(e.id);
    // Guardamos estado para que el "1"/"2" del usuario se asocie a este evento.
    await setStateEvento1h(tel, e.user_id, e);
  }
  if (eventoIds.length) await supabase.from('events').update({ notificado_1h: true }).in('id', eventoIds);
  return { alertas, marcados: eventoIds.length, candidatos: candidatos.length, hoyCol };
}

// ─── MODO E: recordatorio 15 min antes ──────────────────────────────
// Se suprime si el usuario respondió "2" al recordatorio de 1h
// (que setea notificado_15min=true desde /api/whatsapp.js).
async function modoQuinceMinAntes() {
  const ahora = new Date();
  const hoyCol = colombiaDateString(ahora);
  const nowMs = ahora.getTime();

  const { data: eventos, error } = await supabase
    .from('events').select('*')
    .eq('fecha', hoyCol)
    .eq('notificado_15min', false);
  if (error) { console.error('[reminders-cron 15m] query error:', error.message); return { error: error.message }; }

  // Ventana 0-30 min desde ahora (centrada en 15 min, tolerando cron cada 15).
  const candidatos = (eventos || []).filter(e => {
    const t = eventToDate(e);
    if (!t) return false;
    const diff = (t.getTime() - nowMs) / 60000;
    return diff >= 0 && diff <= 30;
  });
  if (!candidatos.length) return { alertas: 0, candidatos: 0, hoyCol };

  const userIds = [...new Set(candidatos.map(e => e.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);

  let alertas = 0;
  const eventoIds = [];
  for (const e of candidatos) {
    const tel = tels[e.user_id];
    if (!tel) continue;
    const mensaje = `🕐 *En ~15 min:* ${e.titulo}${e.hora ? ` a las ${e.hora}` : ''}${e.nota ? `\n${e.nota}` : ''}`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_15min', mensaje, telefono: tel, enviado: false
    });
    if (insErr) { console.error('[reminders-cron 15m] insert failed event', e.id, insErr.message); continue; }
    alertas++;
    eventoIds.push(e.id);
  }
  if (eventoIds.length) await supabase.from('events').update({ notificado_15min: true }).in('id', eventoIds);
  return { alertas, marcados: eventoIds.length, candidatos: candidatos.length, hoyCol };
}

// ─── PAGOS: helper común — busca pagos que vencen HOY con filtro ────
async function pagosQueVencenHoy(extraFilter) {
  const ahora = new Date();
  const hoy = colombiaDateString(ahora);
  let q = supabase.from('payments').select('*')
    .eq('fecha_limite', hoy).neq('status', 'pagado');
  q = extraFilter(q);
  const { data, error } = await q;
  if (error) { console.error('[reminders-cron pagos] query error:', error.message); return { hoy, pagos: [] }; }
  return { hoy, pagos: data || [] };
}

async function crearAlertaPago(pago, telefono, mensaje, marcarCol) {
  const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
    tipo: 'pago_recordatorio', mensaje, telefono, enviado: false
  });
  if (insErr) { console.error('[reminders-cron pagos] insert alerta fail', pago.id, insErr.message); return false; }
  const { error: upErr } = await supabase
    .from('payments').update({ [marcarCol]: true }).eq('id', pago.id);
  if (upErr) console.warn('[reminders-cron pagos] no se pudo marcar', marcarCol, 'en pago', pago.id, upErr.message);
  return true;
}

async function modoPagosMatutino() {
  const { hoy, pagos } = await pagosQueVencenHoy(q => q.eq('notificado_pago', false));
  if (!pagos.length) return { alertas: 0 };
  const userIds = [...new Set(pagos.map(p => p.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);
  const fmt = n => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', minimumFractionDigits:0 }).format(n);
  let alertas = 0;
  for (const pago of pagos) {
    const tel = tels[pago.user_id]; if (!tel) continue;
    const msg = `🔔 *${pago.nombre}* por ${fmt(pago.monto)} vence hoy.\n\n¿Lo pagaste?\n\n1️⃣ Sí, ya está pagado\n2️⃣ No, lo aplazaré`;
    if (await crearAlertaPago(pago, tel, msg, 'notificado_pago')) alertas++;
  }
  return { alertas, hoy };
}

async function modoPagosVespertino() {
  const { hoy, pagos } = await pagosQueVencenHoy(q =>
    q.eq('notificado_pago', true).eq('notificado_6pm', false));
  if (!pagos.length) return { alertas: 0 };
  const userIds = [...new Set(pagos.map(p => p.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);
  const fmt = n => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', minimumFractionDigits:0 }).format(n);
  let alertas = 0;
  for (const pago of pagos) {
    const tel = tels[pago.user_id]; if (!tel) continue;
    const msg = `🔔 *${pago.nombre}* por ${fmt(pago.monto)} vence hoy.\n\n¿Lo pagaste?\n\n1️⃣ Sí, ya está pagado\n2️⃣ No, lo aplazaré`;
    if (await crearAlertaPago(pago, tel, msg, 'notificado_6pm')) alertas++;
  }
  return { alertas, hoy };
}

// ─── Handler: cada tick corre rolling + time-specific ──────────────
module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const utcHour = new Date().getUTCHours();
    const force = (req.query && req.query.modo) || null;

    console.log('[reminders-cron] tick utcHour=', utcHour, 'force=', force);

    const results = {};

    // Modo forzado (testing): ?modo=diario|1h|15min|pagos_am|pagos_pm
    if (force) {
      if (force === 'diario')    results.diario    = await modoResumenDiario();
      if (force === '1h')        results.h1        = await modoUnaHoraAntes();
      if (force === '15min')     results.q15       = await modoQuinceMinAntes();
      if (force === 'pagos_am')  results.pagos_am  = await modoPagosMatutino();
      if (force === 'pagos_pm')  results.pagos_pm  = await modoPagosVespertino();
    } else {
      // Rolling cada tick (cron-job.org cada 15 min): 15-min + 1h
      results.q15 = await modoQuinceMinAntes();
      results.h1  = await modoUnaHoraAntes();
      // Time-specific (Vercel cron también dispara estas como respaldo)
      if (utcHour === DAILY_UTC_HOUR) {
        results.diario   = await modoResumenDiario();
        results.pagos_am = await modoPagosMatutino();
      }
      if (utcHour === EVENING_UTC_HOUR) {
        results.pagos_pm = await modoPagosVespertino();
      }
    }

    // Una sola pasada de envío al final para drenar la cola.
    const hayAlertas = Object.values(results).some(r => r && r.alertas > 0);
    const sendResp = hayAlertas ? await disparoSendWhatsApp() : null;

    return res.json({ ok: true, utcHour, results, send_whatsapp_response: sendResp });
  } catch (error) {
    console.error('[reminders-cron] uncaught:', error);
    return res.status(500).json({ error: error.message });
  }
};
