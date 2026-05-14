// /api/reminders-cron.js
// Cron diario que envía recordatorios de WhatsApp para eventos de hoy y mañana.
// Programado a las 13:00 UTC (~8am Colombia).

const supabase = require('../lib/supabase');

function formatearEvento(e) {
  const hora = e.hora ? ` a las ${e.hora}` : '';
  return `${e.titulo}${hora}`;
}

module.exports = async function handler(req, res) {
  // Auth: cron de Vercel viene como GET sin header; manual con CRON_SECRET
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== 'GET') {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const hoy = new Date().toISOString().split('T')[0];
    const manana = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Eventos de hoy o mañana que aún no se han notificado
    const { data: eventos, error: eventsError } = await supabase
      .from('events')
      .select('*')
      .in('fecha', [hoy, manana])
      .eq('notificado', false);

    if (eventsError) {
      console.error('[reminders-cron] events query error:', eventsError);
      return res.status(500).json({ error: eventsError.message });
    }

    if (!eventos || !eventos.length) {
      return res.json({ ok: true, message: 'Sin eventos para notificar', alertas_creadas: 0 });
    }

    // Agrupar por user_id
    const porUsuario = {};
    for (const e of eventos) {
      if (!e.user_id) continue;
      if (!porUsuario[e.user_id]) porUsuario[e.user_id] = { hoy: [], manana: [] };
      if (e.fecha === hoy) porUsuario[e.user_id].hoy.push(e);
      else porUsuario[e.user_id].manana.push(e);
    }

    // Teléfonos de los profiles correspondientes
    const userIds = Object.keys(porUsuario);
    if (!userIds.length) {
      return res.json({ ok: true, message: 'Eventos sin user_id', alertas_creadas: 0 });
    }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, telefono, nombre')
      .in('id', userIds);

    const telefonosByUser = {};
    for (const p of (profiles || [])) {
      if (p.telefono) telefonosByUser[p.id] = { telefono: p.telefono, nombre: p.nombre };
    }

    let alertasCreadas = 0;
    const eventoIdsParaMarcar = [];

    for (const userId of userIds) {
      const info = telefonosByUser[userId];
      if (!info) {
        console.log('[reminders-cron] user', userId, 'sin teléfono — skip');
        continue;
      }

      const { hoy: eventosHoy, manana: eventosManana } = porUsuario[userId];
      const partes = [];
      if (eventosHoy.length) {
        partes.push('📅 *Hoy:*\n' + eventosHoy.map(e => `• ${formatearEvento(e)}`).join('\n'));
      }
      if (eventosManana.length) {
        partes.push('📆 *Mañana:*\n' + eventosManana.map(e => `• ${formatearEvento(e)}`).join('\n'));
      }
      if (!partes.length) continue;

      const saludo = info.nombre ? `Hola ${info.nombre}, ` : '';
      const mensaje = `${saludo}aquí tus recordatorios de Kontrol:\n\n${partes.join('\n\n')}`;

      const { error: insertError } = await supabase.from('whatsapp_alerts').insert({
        tipo: 'recordatorio_agenda',
        mensaje,
        telefono: info.telefono,
        enviado: false
      });

      if (insertError) {
        console.error('[reminders-cron] insert alert failed for', userId, insertError.message);
        continue;
      }

      alertasCreadas++;
      for (const e of eventosHoy) eventoIdsParaMarcar.push(e.id);
      for (const e of eventosManana) eventoIdsParaMarcar.push(e.id);
    }

    // Marcar eventos como notificados (en lote)
    if (eventoIdsParaMarcar.length) {
      await supabase.from('events').update({ notificado: true }).in('id', eventoIdsParaMarcar);
    }

    // Disparar el procesador de la cola para que envíe ya las alertas creadas
    let envioResp = null;
    if (alertasCreadas > 0) {
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : 'https://kontrol-app-eight.vercel.app';
        const r = await fetch(`${baseUrl}/api/send-whatsapp`, { method: 'POST' });
        envioResp = await r.json().catch(() => null);
      } catch (e) {
        console.error('[reminders-cron] fetch send-whatsapp failed:', e.message);
      }
    }

    return res.json({
      ok: true,
      fecha_hoy: hoy,
      fecha_manana: manana,
      eventos_encontrados: eventos.length,
      usuarios_con_eventos: userIds.length,
      alertas_creadas: alertasCreadas,
      eventos_marcados: eventoIdsParaMarcar.length,
      send_whatsapp_response: envioResp
    });
  } catch (error) {
    console.error('[reminders-cron] error:', error);
    return res.status(500).json({ error: error.message });
  }
};
