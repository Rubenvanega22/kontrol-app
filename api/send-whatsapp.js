// /api/send-whatsapp.js
// Envía alertas WhatsApp pendientes
// Se llama desde sync-emails o manualmente

const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  try {
    // Obtener alertas pendientes
    const { data: alertas } = await supabase
      .from('whatsapp_alerts')
      .select('*')
      .eq('enviado', false)
      .limit(10);

    if (!alertas?.length) return res.json({ ok: true, enviadas: 0 });

    const { data: cfgRow } = await supabase
      .from('config').select('value').eq('key', 'notificaciones').single();
    const cfg = cfgRow?.value || {};

    let enviadas = 0;

    for (const alerta of alertas) {
      const telefono = alerta.telefono || cfg.whatsapp_numero;
      if (!telefono) continue;

      let exito = false;

      if (process.env.TWILIO_ACCOUNT_SID) {
        exito = await enviarTwilio(alerta.mensaje, telefono);
      } else if (process.env.MANYCHAT_API_KEY) {
        exito = await enviarManyChat(alerta.mensaje, telefono, cfg);
      }

      if (exito) {
        await supabase.from('whatsapp_alerts')
          .update({ enviado: true })
          .eq('id', alerta.id);
        enviadas++;
      }
    }

    return res.json({ ok: true, enviadas });
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
          Body: mensaje
        })
      }
    );
    const data = await r.json();
    return !!data.sid;
  } catch (e) {
    console.error('Twilio error:', e.message);
    return false;
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
