// /api/reminders-cron.js
// Diseñado para correr cada 1 min en cron-job.org (Vercel Hobby no permite
// crons sub-diarios). En cada tick ejecuta los modos "rolling":
//   • modoQuinceMinAntes — ventana [-15, +15] min vs hora del evento
//   • modoUnaHoraAntes  — ventana (+15, +60] min vs hora del evento
//   • modoAvisosPropios — aviso elegido y eventos antes de las 8 am, reglas en lib/avisos-evento.js
// Dedup garantizado por los flags notificado_* de events. Los modos rolling corren a
// cualquier hora, también de madrugada: solo el resumen, pagos y recordatorios tienen horario.
//
// En horas específicas Colombia se disparan además modos diarios:
//   • 13:00 UTC (8am Col) → resumen agenda + recordatorio matutino de pagos
//   • 23:00 UTC (6pm Col) → recordatorio vespertino de pagos no confirmados
// Vercel cron en vercel.json conserva los disparos a 13/23 UTC como respaldo.

const supabase = require('../lib/supabase');
const { colombiaDateString } = require('../lib/datetime');
const {
  entraEnResumen, debeSalirAviso, debeSalirUnaHoraAntes, horaCorta,
  minutosFaltantes, tocaUnaHoraNormal, tocaQuinceNormal, textoFaltan
} = require('../lib/avisos-evento');

const DAILY_UTC_HOUR = 13;   // 13:00 UTC = 8:00 am Colombia
const EVENING_UTC_HOUR = 23; // 23:00 UTC = 6:00 pm Colombia

function lineaNotaEvento(e) {
  const nota = (e.nota || '').trim();
  return nota ? `\n📝 Nota: ${nota}` : '';
}

function formatearEvento(e) {
  const hora = e.hora ? ` a las ${horaCorta(e.hora)}` : '';
  return `${e.titulo}${hora}${lineaNotaEvento(e)}`;
}

async function disparoSendWhatsApp() {
  try {
    // VERCEL_URL apunta al deployment específico (protegido en algunos planes);
    // usamos el alias público estable.
    const baseUrl = 'https://kontrol-app-eight.vercel.app';
    const r = await fetch(`${baseUrl}/api/send-whatsapp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` }
    });
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

  const delResumen = (eventos || []).filter(entraEnResumen);
  if (!delResumen.length) return { alertas: 0, message: 'sin eventos' };

  const porUsuario = {};
  for (const e of delResumen) {
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

  // Reclamo atómico: marcamos notificado_agenda de los eventos de usuarios CON
  // teléfono antes de encolar, para que ticks concurrentes no dupliquen el envío.
  const recipientUserIds = userIds.filter(u => tels[u]);
  const recipientEventIds = recipientUserIds.flatMap(u => porUsuario[u].map(e => e.id));
  const claimed = await reclamar('events', recipientEventIds,
    { notificado_agenda: true }, q => q.eq('notificado_agenda', false));

  const claimedPorUsuario = {};
  for (const e of claimed) {
    if (!claimedPorUsuario[e.user_id]) claimedPorUsuario[e.user_id] = [];
    claimedPorUsuario[e.user_id].push(e);
  }

  let alertas = 0;
  for (const userId of Object.keys(claimedPorUsuario)) {
    const info = tels[userId];
    if (!info) continue;
    const eHoy = claimedPorUsuario[userId];
    const lista = '📅 *Hoy:*\n' + eHoy.map(e => `• ${formatearEvento(e)}`).join('\n');
    const saludo = info.nombre ? `Hola ${info.nombre}, ` : '';
    const mensaje = `${saludo}aquí tus recordatorios de Kontrol:\n\n${lista}`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_agenda', mensaje, telefono: info.telefono, enviado: false
    });
    if (insErr) {
      console.error('[reminders-cron daily] insert failed', userId, insErr.message);
      // revertir el reclamo para reintentar en el próximo tick
      await supabase.from('events').update({ notificado_agenda: false }).in('id', eHoy.map(e => e.id));
      continue;
    }
    alertas++;
  }
  return { alertas, marcados: claimed.length, hoy };
}

// ─── MODO C: recordatorios de la pestaña "Recordar" (tabla reminders) ──
// Solo los que tienen recordar_fecha = hoy reciben WhatsApp ese día. Los que
// no tienen recordar_fecha (null) viven solo en la app. Un WhatsApp consolidado
// por usuario con sus notas y listados del día. Dedup por flag notificado.
async function modoRecordatorios() {
  const hoy = colombiaDateString(new Date());

  const { data: recs, error } = await supabase
    .from('reminders').select('*')
    .eq('recordar_fecha', hoy)
    .eq('notificado', false)
    .eq('hecho', false) // lo ya hecho no necesita aviso
    .eq('avisar', true); // apagado desde el menú de la fila
  if (error) { console.error('[reminders-cron recordar] query error:', error.message); return { error: error.message, hoy }; }
  if (!recs || !recs.length) return { alertas: 0, hoy };

  const porUsuario = {};
  for (const r of recs) {
    if (!r.user_id) continue;
    if (!porUsuario[r.user_id]) porUsuario[r.user_id] = [];
    porUsuario[r.user_id].push(r);
  }

  const userIds = Object.keys(porUsuario);
  const { data: profiles } = await supabase
    .from('profiles').select('id, telefono, nombre').in('id', userIds);
  const tels = {};
  for (const p of (profiles || [])) {
    if (p.telefono) tels[p.id] = { telefono: p.telefono, nombre: p.nombre };
  }

  // Reclamo atómico de los recordatorios de usuarios CON teléfono (anti-duplicados).
  const recipientUserIds = userIds.filter(u => tels[u]);
  const recipientIds = recipientUserIds.flatMap(u => porUsuario[u].map(r => r.id));
  const claimed = await reclamar('reminders', recipientIds,
    { notificado: true }, q => q.eq('notificado', false));

  const claimedPorUsuario = {};
  for (const r of claimed) {
    if (!claimedPorUsuario[r.user_id]) claimedPorUsuario[r.user_id] = [];
    claimedPorUsuario[r.user_id].push(r);
  }

  let alertas = 0;
  for (const userId of Object.keys(claimedPorUsuario)) {
    const info = tels[userId];
    if (!info) continue;
    const items = claimedPorUsuario[userId];
    const lista = items.map(r => {
      const esListado = (r.tipo === 'listado' || r.tipo === 'lista');
      const subitems = (r.content && r.content.items) || [];
      if (esListado && subitems.length) {
        const its = subitems.map(it => `   ${it.done ? '✓' : '○'} ${it.text}`).join('\n');
        return `📋 *${r.titulo}*\n${its}`;
      }
      let linea = `🔔 *${r.titulo || 'Recordatorio'}*`;
      if (Number(r.valor) > 0) linea += `\n💰 $${Math.round(Number(r.valor)).toLocaleString('es-CO')}`;
      if (r.nota) linea += `\n📝 ${r.nota}`;
      return linea;
    }).join('\n\n');
    const saludo = info.nombre ? `Hola ${info.nombre}, ` : '';
    const mensaje = `${saludo}recordatorio para hoy:\n\n${lista}`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_nota', mensaje, telefono: info.telefono, enviado: false
    });
    if (insErr) {
      console.error('[reminders-cron recordar] insert failed', userId, insErr.message);
      await supabase.from('reminders').update({ notificado: false }).in('id', items.map(r => r.id));
      continue;
    }
    alertas++;
  }
  return { alertas, marcados: claimed.length, hoy };
}

// ─── Helpers de teléfonos por user_id ──────────────────────────────
async function telefonosPorUsuario(userIds) {
  const { data: profiles } = await supabase
    .from('profiles').select('id, telefono').in('id', userIds);
  const tels = {};
  for (const p of (profiles || [])) if (p.telefono) tels[p.id] = p.telefono;
  return tels;
}

// ─── Anti-duplicados: reclamo atómico de filas ─────────────────────
// Marca como notificadas SOLO las filas que ESTA ejecución logra reclamar y
// las devuelve. Si dos ticks del cron corren a la vez (cron-job.org + Vercel),
// el UPDATE ... RETURNING toma lock por fila: el primero obtiene las filas; el
// segundo, al re-evaluar la condición (ya marcada), no obtiene ninguna. Así la
// misma alerta no se encola dos veces. `aplicarCond` re-aplica el filtro de
// "no notificado" dentro del UPDATE para que el lock haga el trabajo.
async function reclamar(tabla, ids, patch, aplicarCond) {
  if (!ids || !ids.length) return [];
  let q = supabase.from(tabla).update(patch).in('id', ids);
  q = aplicarCond(q);
  const { data, error } = await q.select();
  if (error) { console.error(`[reminders-cron] reclamar ${tabla} error:`, error.message); return []; }
  return data || [];
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

  // Sale al llegar a los 60 min. Hasta los 15 min tolera que el cron se haya caído o
  // que el evento se creara tarde. El flag notificado_1h evita repetirlo.
  const candidatos = (eventos || []).filter(e => tocaUnaHoraNormal(e, nowMs));
  if (!candidatos.length) return { alertas: 0, candidatos: 0, hoyCol };

  const userIds = [...new Set(candidatos.map(e => e.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);

  // Reclamo atómico de los eventos con teléfono antes de encolar (anti-duplicados).
  const destinatarios = candidatos.filter(e => tels[e.user_id]);
  const claimed = await reclamar('events', destinatarios.map(e => e.id),
    { notificado_1h: true }, q => q.eq('notificado_1h', false));

  let alertas = 0;
  for (const e of claimed) {
    const tel = tels[e.user_id];
    const mensaje =
      `⏰ *${textoFaltan(minutosFaltantes(e, nowMs))}:* ${formatearEvento(e)}\n` +
      `\n¿Necesitas recordatorio de salida?\n` +
      `1. Sí, avísame 15 min antes\n` +
      `2. No es necesario`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_1h', mensaje, telefono: tel, enviado: false
    });
    if (insErr) {
      console.error('[reminders-cron 1h] insert failed event', e.id, insErr.message);
      await supabase.from('events').update({ notificado_1h: false }).eq('id', e.id);
      continue;
    }
    alertas++;
    // Guardamos estado para que el "1"/"2" del usuario se asocie a este evento.
    await setStateEvento1h(tel, e.user_id, e);
  }
  return { alertas, marcados: claimed.length, candidatos: candidatos.length, hoyCol };
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

  // Sale al llegar a los 15 min. Asume cron cada 1 min (cron-job.org). El flag
  // notificado_15min evita repetirlo aunque entre en varios ticks seguidos.
  const candidatos = (eventos || []).filter(e => tocaQuinceNormal(e, nowMs));
  if (!candidatos.length) return { alertas: 0, candidatos: 0, hoyCol };

  const userIds = [...new Set(candidatos.map(e => e.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);

  // Reclamo atómico de los eventos con teléfono antes de encolar (anti-duplicados).
  const destinatarios = candidatos.filter(e => tels[e.user_id]);
  const claimed = await reclamar('events', destinatarios.map(e => e.id),
    { notificado_15min: true }, q => q.eq('notificado_15min', false));

  let alertas = 0;
  for (const e of claimed) {
    const tel = tels[e.user_id];
    const mensaje = `🕐 *${textoFaltan(minutosFaltantes(e, nowMs))}:* ${formatearEvento(e)}`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'recordatorio_15min', mensaje, telefono: tel, enviado: false
    });
    if (insErr) {
      console.error('[reminders-cron 15m] insert failed event', e.id, insErr.message);
      await supabase.from('events').update({ notificado_15min: false }).eq('id', e.id);
      continue;
    }
    alertas++;
  }
  return { alertas, marcados: claimed.length, candidatos: candidatos.length, hoyCol };
}

// ─── MODO F: avisos propios ─────────────────────────────────────────
// El aviso elegido, a la hora elegida (ventana amplia: debeSalirAviso decide). Y los eventos
// antes de las 8 am sin elegir, cuyo aviso puede caer la noche anterior: de ahí mirar mañana.
async function modoAvisosPropios() {
  const ahora = new Date();
  const nowMs = ahora.getTime();
  const hoyCol = colombiaDateString(ahora);
  const mananaCol = colombiaDateString(new Date(nowMs + 24 * 3600 * 1000));

  const [tempranos, elegidos] = await Promise.all([
    supabase.from('events').select('*')
      .in('fecha', [hoyCol, mananaCol])
      .lt('hora', '08:00'),
    supabase.from('events').select('*')
      .eq('notificado_aviso', false)
      .lte('aviso_en', ahora.toISOString())
      .gte('aviso_en', new Date(nowMs - 3 * 3600 * 1000).toISOString())
  ]);
  const error = tempranos.error || elegidos.error;
  if (error) { console.error('[reminders-cron propios] query error:', error.message); return { error: error.message }; }

  const porId = new Map([...(tempranos.data || []), ...(elegidos.data || [])].map(e => [e.id, e]));
  const eventos = [...porId.values()];
  const avisos = eventos.filter(e => debeSalirAviso(e, nowMs));
  const unaHora = eventos.filter(e => debeSalirUnaHoraAntes(e, nowMs));
  if (!avisos.length && !unaHora.length) return { alertas: 0, candidatos: 0, hoyCol };

  const userIds = [...new Set([...avisos, ...unaHora].map(e => e.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);

  const enviar = async (lista, flag, tipo, texto) => {
    const destinatarios = lista.filter(e => tels[e.user_id]);
    const claimed = await reclamar('events', destinatarios.map(e => e.id),
      { [flag]: true }, q => q.eq(flag, false));
    let enviadas = 0;
    for (const e of claimed) {
      const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
        tipo, mensaje: texto(e), telefono: tels[e.user_id], enviado: false
      });
      if (insErr) {
        console.error('[reminders-cron propios] insert failed event', e.id, insErr.message);
        await supabase.from('events').update({ [flag]: false }).eq('id', e.id);
        continue;
      }
      enviadas++;
    }
    return enviadas;
  };

  const cuando = e => {
    if (e.fecha === hoyCol) return 'Hoy';
    if (e.fecha === mananaCol) return 'Mañana';
    const [, mes, dia] = e.fecha.split('-').map(Number);
    return `El ${dia}/${mes}`;
  };
  const alertasAviso = await enviar(avisos, 'notificado_aviso', 'recordatorio_temprano', e =>
    `🔔 *${cuando(e)}:* ${formatearEvento(e)}`);
  const alertasHora = await enviar(unaHora, 'notificado_1h', 'recordatorio_1h', e =>
    `⏰ *${textoFaltan(minutosFaltantes(e, nowMs))}:* ${formatearEvento(e)}`);
  return { alertas: alertasAviso + alertasHora, candidatos: avisos.length + unaHora.length, hoyCol };
}

// ─── PAGOS: recordatorio diario hasta que se pague (BUG 1) ──────────
// Antes había dos modos (matutino solo a las 8am exactas + vespertino que
// dependía de que el matutino hubiera corrido). Un pago creado después de
// las 8am nunca se notificaba. Ahora:
//   • Corre en ventana 8am-6pm Col → captura pagos creados tarde el mismo día.
//   • Recuerda hasta status=pagado (dedup por notificado_fecha): el día que vence, a
//     diario la primera semana después de vencer, y luego solo los lunes.
//   • Incluye vencidos no pagados (fecha_limite <= hoy), no solo "hoy exacto".
//   • FECHA_CORTE_PAGOS evita avisos retroactivos de pagos viejos previos al deploy.
const FECHA_CORTE_PAGOS = '2026-06-20'; // día del deploy del ARREGLO 2

// ¿Hoy toca avisar este pago? Solo se llama con fecha_limite <= hoy.
function tocaAvisoPago(fechaLimite, hoy) {
  const aMs = f => new Date(`${f}T12:00:00-05:00`).getTime();
  const diasVencido = Math.round((aMs(hoy) - aMs(fechaLimite)) / (24 * 3600 * 1000));
  if (diasVencido <= 7) return true;
  return new Date(aMs(hoy)).getUTCDay() === 1; // lunes en Colombia
}

async function modoPagos() {
  const hoy = colombiaDateString(new Date());

  const { data: pagos, error } = await supabase
    .from('payments').select('*')
    .neq('status', 'pagado')
    .lte('fecha_limite', hoy)
    .gte('fecha_limite', FECHA_CORTE_PAGOS)
    .or(`notificado_fecha.is.null,notificado_fecha.lt.${hoy}`);
  if (error) { console.error('[reminders-cron pagos] query error:', error.message); return { error: error.message, hoy }; }
  const pagosHoy = (pagos || []).filter(p => tocaAvisoPago(p.fecha_limite, hoy));
  if (!pagosHoy.length) return { alertas: 0, hoy };

  const userIds = [...new Set(pagosHoy.map(p => p.user_id).filter(Boolean))];
  const tels = await telefonosPorUsuario(userIds);
  const fmt = n => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', minimumFractionDigits:0 }).format(n);

  // Reclamo atómico de los pagos con teléfono (anti-duplicados). notificado_pago=true
  // mantiene la asociación de respuesta en whatsapp.js; notificado_fecha=hoy = dedup
  // diario. La condición re-aplicada evita reclamar un pago ya avisado hoy por otro tick.
  const destinatarios = pagosHoy.filter(p => tels[p.user_id]);
  const claimed = await reclamar('payments', destinatarios.map(p => p.id),
    { notificado_pago: true, notificado_fecha: hoy },
    q => q.or(`notificado_fecha.is.null,notificado_fecha.lt.${hoy}`));

  let alertas = 0;
  for (const pago of claimed) {
    const tel = tels[pago.user_id];
    const cuando = pago.fecha_limite === hoy ? 'vence hoy' : `venció el ${pago.fecha_limite} y sigue pendiente`;
    const nota = pago.nota && pago.nota.trim() ? `\n📝 Nota: ${pago.nota.trim()}` : '';
    const msg = `🔔 *${pago.nombre}* por ${fmt(pago.monto)} ${cuando}.${nota}\n\n¿Lo pagaste?\n\n1️⃣ Sí, ya está pagado\n2️⃣ No, lo aplazaré`;
    const { error: insErr } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'pago_recordatorio', mensaje: msg, telefono: tel, enviado: false
    });
    if (insErr) {
      console.error('[reminders-cron pagos] insert alerta fail', pago.id, insErr.message);
      // revertir el dedup del día para reintentar en el próximo tick
      await supabase.from('payments').update({ notificado_fecha: null }).eq('id', pago.id);
      continue;
    }
    alertas++;
  }
  return { alertas, hoy };
}

// ─── Confirmar una renovación de WhatsApp ───────────────────────────
// Twilio atiende el join sin avisar, así que tocar "Renovar" no prueba que se haya enviado.
// Un solo mensaje lo confirma: si se entrega, /api/twilio-status quita el aviso rojo y
// libera los pendientes; si vuelve a dar 63015, sigue vencido hasta que renueve de nuevo.
const ESPERA_RENOVACION_MS = 90 * 1000; // tiempo para que alcance a tocar enviar

async function modoRenovaciones() {
  const { data, error } = await supabase.from('profiles')
    .select('id, telefono, whatsapp_vencido_at, whatsapp_renovado_at, whatsapp_prueba_at')
    .not('whatsapp_vencido_at', 'is', null);
  if (error) { console.error('[reminders-cron renovaciones] query error:', error.message); return { error: error.message }; }
  let alertas = 0;
  for (const p of data || []) {
    const renovado = p.whatsapp_renovado_at ? new Date(p.whatsapp_renovado_at).getTime() : 0;
    const yaProbado = p.whatsapp_prueba_at && new Date(p.whatsapp_prueba_at).getTime() >= renovado;
    if (!p.telefono || !renovado || renovado <= new Date(p.whatsapp_vencido_at).getTime()) continue;
    if (yaProbado || Date.now() - renovado < ESPERA_RENOVACION_MS) continue;
    // Reclamo optimista: dos ticks a la vez no envían dos confirmaciones.
    let reclamo = supabase.from('profiles').update({ whatsapp_prueba_at: new Date().toISOString() }).eq('id', p.id);
    reclamo = p.whatsapp_prueba_at ? reclamo.eq('whatsapp_prueba_at', p.whatsapp_prueba_at) : reclamo.is('whatsapp_prueba_at', null);
    const { data: ok, error: e2 } = await reclamo.select('id');
    if (e2 || !ok?.length) continue;
    const { error: e3 } = await supabase.from('whatsapp_alerts').insert({
      tipo: 'renovacion_prueba', telefono: p.telefono, enviado: false,
      mensaje: '✅ Tu WhatsApp quedó conectado con Kontrol. Ya te llegarán tus avisos.'
    });
    if (e3) console.error('[reminders-cron renovaciones] insert error:', e3.message);
    else alertas++;
  }
  return { alertas };
}

// ─── Handler: cada tick corre rolling + time-specific ──────────────
module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  // Vercel (GET) y cron-job.org (POST) envían el secreto. Sin esto, cualquiera podía
  // forzar los avisos con ?modo=.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const utcHour = new Date().getUTCHours();
    const force = (req.query && req.query.modo) || null;

    console.log('[reminders-cron] tick utcHour=', utcHour, 'force=', force);

    const results = {};

    // Modo forzado (testing): ?modo=diario|1h|15min|propios|pagos|recordatorios
    if (force) {
      if (force === 'propios')       results.propios       = await modoAvisosPropios();
      if (force === 'diario')        results.diario        = await modoResumenDiario();
      if (force === '1h')            results.h1            = await modoUnaHoraAntes();
      if (force === '15min')         results.q15           = await modoQuinceMinAntes();
      if (force === 'pagos')         results.pagos         = await modoPagos();
      if (force === 'recordatorios') results.recordatorios = await modoRecordatorios();
      if (force === 'renovaciones')  results.renovaciones  = await modoRenovaciones();
    } else {
      // Rolling cada tick (cron-job.org cada 15 min): 15-min + 1h
      results.q15 = await modoQuinceMinAntes();
      results.h1  = await modoUnaHoraAntes();
      results.propios = await modoAvisosPropios();
      results.renovaciones = await modoRenovaciones();
      // Resumen de agenda: una vez al día a las 8am Col.
      if (utcHour === DAILY_UTC_HOUR) {
        results.diario = await modoResumenDiario();
      }
      // Recordatorios con fecha de hoy: salen a las 8am Col. La ventana hasta las 6pm
      // cubre los creados más tarde para ese mismo día; el flag notificado evita repetir.
      if (utcHour >= DAILY_UTC_HOUR && utcHour <= EVENING_UTC_HOUR) {
        results.recordatorios = await modoRecordatorios();
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
