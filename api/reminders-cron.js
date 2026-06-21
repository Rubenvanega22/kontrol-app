// /api/reminders-cron.js
// Diseñado para correr cada 1 min en cron-job.org (Vercel Hobby no permite
// crons sub-diarios). En cada tick ejecuta los modos "rolling":
//   • modoQuinceMinAntes — ventana [-15, +30] min vs hora del evento
//   • modoUnaHoraAntes  — ventana [+15, +90] min vs hora del evento
// Dedup garantizado por los flags notificado_15min / notificado_1h de events.
//
// En horas específicas Colombia se disparan además modos diarios:
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
// Solo avisa eventos cuya fecha es HOY. Antes incluía "mañana", pero el flag
// único notificado_agenda se consumía en ese aviso previo y el evento nunca
// se anunciaba el día real (BUG 2/3). Ahora avisa exactamente el día del evento.
async function modoResumenDiario() {
  const ahora = new Date();
  const hoy = colombiaDateString(ahora);

  console.log('[reminders-cron daily] hoy=', hoy);

  const { data: eventos, error } = await supabase
    .from('events').select('*')
    .eq('fecha', hoy)
    .eq('notificado_agenda', false);
  if (error) { console.error('[reminders-cron daily] query error:', error.message); return { error: error.message }; }

  if (!eventos || !eventos.length) return { alertas: 0, message: 'sin eventos' };

  const porUsuario = {};
  for (const e of eventos) {
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

  let alertas = 0;
  const eventoIds = [];
  for (const userId of userIds) {
    const info = tels[userId];
    if (!info) continue;
    const eHoy = porUsuario[userId];
    if (!eHoy.length) continue;
    const lista = '📅 *Hoy:*\n' + eHoy.map(e => `• ${formatearEvento(e)}`).join('\n');
    const saludo = info.nombre ? `Hola ${info.nombre}, ` : '';
    const mensaje = `${saludo}aquí tus recordatorios de Kontrol:\n\n${lista}`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_agenda', mensaje, telefono: info.telefono, enviado: false
    });
    if (insErr) { console.error('[reminders-cron daily] insert failed', userId, insErr.message); continue; }
    alertas++;
    for (const e of eHoy) eventoIds.push(e.id);
  }
  if (eventoIds.length) await supabase.from('events').update({ notificado_agenda: true }).in('id', eventoIds);
  return { alertas, marcados: eventoIds.length, hoy };
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

  // Ventana 15-90 min desde ahora. El borde -15 (ahora 15) tolera que el
  // cron se haya caído ~15 min y vuelva: si un evento cuya hora-1h cayó
  // durante el outage entra ahora, igual se notifica. El flag
  // notificado_1h previene duplicados en ticks subsiguientes.
  const candidatos = (eventos || []).filter(e => {
    const t = eventToDate(e);
    if (!t) return false;
    const diff = (t.getTime() - nowMs) / 60000;
    return diff >= 15 && diff <= 90;
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

  // Ventana -15 a +30 min desde ahora. Asume cron cada 1 min (cron-job.org).
  // El borde -15 tolera eventos creados "en 5 minutos" que el cron alcanzó
  // a procesar tarde (ej. tick se saltó 10 min por outage de cron-job.org).
  // El flag notificado_15min previene duplicados — un mismo evento no
  // se notifica dos veces aunque entre en múltiples ticks consecutivos.
  const candidatos = (eventos || []).filter(e => {
    const t = eventToDate(e);
    if (!t) return false;
    const diff = (t.getTime() - nowMs) / 60000;
    return diff >= -15 && diff <= 30;
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

// ─── PAGOS: recordatorio diario hasta que se pague (BUG 1) ──────────
// Antes había dos modos (matutino solo a las 8am exactas + vespertino que
// dependía de que el matutino hubiera corrido). Un pago creado después de
// las 8am nunca se notificaba. Ahora:
//   • Corre en ventana 8am-6pm Col → captura pagos creados tarde el mismo día.
//   • Recuerda CADA día (dedup por notificado_fecha) hasta status=pagado.
//   • Incluye vencidos no pagados (fecha_limite <= hoy), no solo "hoy exacto".
//   • FECHA_CORTE_PAGOS evita avisos retroactivos de pagos viejos previos al deploy.
const FECHA_CORTE_PAGOS = '2026-06-20'; // día del deploy del ARREGLO 2

async function modoPagos() {
  const hoy = colombiaDateString(new Date());

  const { data: pagos, error } = await supabase
    .from('payments').select('*')
    .neq('status', 'pagado')
    .lte('fecha_limite', hoy)
    .gte('fecha_limite', FECHA_CORTE_PAGOS)
    .or(`notificado_fecha.is.null,notificado_fecha.lt.${hoy}`);
  if (error) { console.error('[reminders-cron pagos] query error:', error.message); return { error: error.message, hoy }; }
  if (!pagos || !pagos.length) return { alertas: 0, hoy };

  const userIds = [...new Set(pagos.map(p => p.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);
  const fmt = n => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', minimumFractionDigits:0 }).format(n);

  let alertas = 0;
  for (const pago of pagos) {
    const tel = tels[pago.user_id]; if (!tel) continue;
    const cuando = pago.fecha_limite === hoy ? 'vence hoy' : `venció el ${pago.fecha_limite} y sigue pendiente`;
    const msg = `🔔 *${pago.nombre}* por ${fmt(pago.monto)} ${cuando}.\n\n¿Lo pagaste?\n\n1️⃣ Sí, ya está pagado\n2️⃣ No, lo aplazaré`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'pago_recordatorio', mensaje: msg, telefono: tel, enviado: false
    });
    if (insErr) { console.error('[reminders-cron pagos] insert alerta fail', pago.id, insErr.message); continue; }
    // notificado_pago=true para que whatsapp.js (pagoEnEspera) asocie la respuesta
    // "1"/"2" del usuario a este pago. notificado_fecha=hoy = dedup del día.
    const { error: upErr } = await supabase
      .from('payments').update({ notificado_pago: true, notificado_fecha: hoy }).eq('id', pago.id);
    if (upErr) console.warn('[reminders-cron pagos] no se pudo marcar pago', pago.id, upErr.message);
    alertas++;
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

    // Modo forzado (testing): ?modo=diario|1h|15min|pagos
    if (force) {
      if (force === 'diario')    results.diario    = await modoResumenDiario();
      if (force === '1h')        results.h1        = await modoUnaHoraAntes();
      if (force === '15min')     results.q15       = await modoQuinceMinAntes();
      if (force === 'pagos')     results.pagos     = await modoPagos();
    } else {
      // Rolling cada tick (cron-job.org cada 15 min): 15-min + 1h
      results.q15 = await modoQuinceMinAntes();
      results.h1  = await modoUnaHoraAntes();
      // Resumen de agenda: una vez al día a las 8am Col.
      if (utcHour === DAILY_UTC_HOUR) {
        results.diario = await modoResumenDiario();
      }
      // Pagos: ventana 8am-6pm Col. El dedup por notificado_fecha garantiza
      // un solo recordatorio por día aunque el cron corra cada 15 min.
      if (utcHour >= DAILY_UTC_HOUR && utcHour <= EVENING_UTC_HOUR) {
        results.pagos = await modoPagos();
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
