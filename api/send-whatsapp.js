// /api/send-whatsapp.js
// Envía alertas WhatsApp pendientes
// Se llama desde reminders-cron o manualmente

const supabase = require('../lib/supabase');
const { esSistema } = require('../lib/auth');
const { STATUS_URL, MAX_INTENTOS } = require('../lib/whatsapp-estado');

const UNA_HORA = 3600 * 1000;

// Un aviso que espera desde hace rato dice de cuándo es: su "hoy" ya no es hoy.
function textoAviso(alerta) {
  const creado = new Date(alerta.created_at);
  if (alerta.tipo === 'renovacion_prueba' || isNaN(creado) || Date.now() - creado.getTime() < UNA_HORA) return alerta.mensaje;
  const dia = creado.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'America/Bogota' }).replace(/\s+de\s+/, ' ').replace('.', '');
  return `⏰ Aviso pendiente del ${dia}:\n\n${alerta.mensaje}`;
}

module.exports = async function handler(req, res) {
  if (!esSistema(req)) return res.status(401).json({ error: 'No autorizado' });
  try {
    // Un envío que murió a medias vuelve a la cola.
    await supabase.from('whatsapp_alerts').update({ estado: 'pendiente' })
      .eq('estado', 'enviando').lt('ultimo_intento_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    // Obtener alertas pendientes
    const { data: alertas } = await supabase
      .from('whatsapp_alerts')
      .select('*')
      .eq('enviado', false)
      .eq('estado', 'pendiente')
      .order('id', { ascending: true })
      .limit(10);

    if (!alertas?.length) return res.json({ ok: true, enviadas: 0 });

    const { data: cfgRow } = await supabase
      .from('config').select('value').eq('key', 'notificaciones').single();
    const cfg = cfgRow?.value || {};

    // Con el sandbox vencido, enviar solo gastaría cupo: el aviso espera a que renueve.
    const telefonos = [...new Set(alertas.map(a => a.telefono).filter(Boolean))];
    const { data: perfiles } = telefonos.length
      ? await supabase.from('profiles').select('telefono, whatsapp_vencido_at').in('telefono', telefonos)
      : { data: [] };
    const vencidos = new Set((perfiles || []).filter(p => p.whatsapp_vencido_at).map(p => p.telefono));

    let enviadas = 0, enEspera = 0;

    for (const alerta of alertas) {
      const telefono = alerta.telefono || cfg.whatsapp_numero;
      if (!telefono) continue;

      if (vencidos.has(telefono) && alerta.tipo !== 'renovacion_prueba') {
        await supabase.from('whatsapp_alerts').update({ estado: 'en_espera' }).eq('id', alerta.id).eq('estado', 'pendiente');
        enEspera++;
        continue;
      }

      // Reclamo: dos ejecuciones a la vez no envían el mismo aviso.
      const intentos = (alerta.intentos || 0) + 1;
      const { data: reclamado } = await supabase.from('whatsapp_alerts')
        .update({ estado: 'enviando', intentos, ultimo_intento_at: new Date().toISOString() })
        .eq('id', alerta.id).eq('estado', 'pendiente').select('id');
      if (!reclamado?.length) continue;

      let sid = null, exito = false;
      if (process.env.TWILIO_ACCOUNT_SID) {
        sid = await enviarTwilio(textoAviso(alerta), telefono);
        exito = !!sid;
      } else if (process.env.MANYCHAT_API_KEY) {
        exito = await enviarManyChat(textoAviso(alerta), telefono, cfg);
      }

      // "Aceptado" no es "entregado": el resultado final llega a /api/twilio-status, que
      // lo devuelve a no enviado si falla. El filtro no pisa un callback que ya llegó.
      if (exito) {
        await supabase.from('whatsapp_alerts')
          .update({ enviado: true, estado: 'aceptado', twilio_sid: sid })
          .eq('id', alerta.id).eq('estado', 'enviando');
        enviadas++;
      } else {
        await supabase.from('whatsapp_alerts')
          .update({ estado: intentos >= MAX_INTENTOS ? 'fallido' : 'pendiente' })
          .eq('id', alerta.id).eq('estado', 'enviando');
      }
    }

    return res.json({ ok: true, enviadas, en_espera: enEspera });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

async function enviarTwilio(mensaje, telefono) {
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          From: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
          To: `whatsapp:${telefono}`,
          Body: mensaje,
          StatusCallback: STATUS_URL
        })
      }
    );
    const data = await r.json();
    if (!data.sid) console.error('Twilio rechazó el envío, código', data.code);
    return data.sid || null;
  } catch (e) {
    console.error('Twilio error:', e.message);
    return null;
  }
}

async function enviarManyChat(mensaje, telefono, cfg) {
  try {
    // ManyChat API - enviar mensaje por número
    const r = await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MANYCHAT_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        subscriber_id: cfg.manychat_subscriber_id,
        data: {
          version: 'v2',
          content: {
            messages: [{ type: 'text', text: mensaje }]
          }
        },
        message_tag: 'ACCOUNT_UPDATE'
      })
    });
    const data = await r.json();
    return data.status === 'success';
  } catch (e) {
    console.error('ManyChat error:', e.message);
    return false;
  }
}
