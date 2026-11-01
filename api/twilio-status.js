// /api/twilio-status.js — Status callback de Twilio: dice si cada mensaje se entregó o falló.
// Twilio llama varias veces por mensaje (queued, sent, delivered...). Solo importan los
// estados finales. Lo que no traiga una firma válida de Twilio se rechaza.
const supabase = require('../lib/supabase');
const { firmaValida, urlDelWebhook } = require('../lib/twilio-signature');
const {
  CODIGO_SANDBOX_VENCIDO, perfilPorTelefono, marcarVencido, marcarConectado, liberarAvisos, vaciarCola
} = require('../lib/whatsapp-estado');

const ENTREGADO = new Set(['delivered', 'read']);
const FALLIDO = new Set(['undelivered', 'failed']);

async function buscarAviso(sid) {
  const { data, error } = await supabase.from('whatsapp_alerts')
    .select('id, telefono, ultimo_intento_at').eq('twilio_sid', sid).limit(1);
  if (error) console.error('[twilio-status] buscar error:', error.message);
  return (data && data[0]) || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!firmaValida(process.env.TWILIO_AUTH_TOKEN, req.headers['x-twilio-signature'], urlDelWebhook(req), req.body)) {
    console.warn('[twilio-status] firma inválida');
    return res.status(403).end();
  }

  const { MessageSid: sid, MessageStatus: estado, ErrorCode, To } = req.body || {};
  if (!sid || (!ENTREGADO.has(estado) && !FALLIDO.has(estado))) return res.status(200).end();
  const codigo = ErrorCode ? String(ErrorCode) : null;

  try {
    let aviso = await buscarAviso(sid);
    if (!aviso) {
      // El callback puede ganarle a send-whatsapp al guardar el sid.
      await new Promise((r) => setTimeout(r, 1500));
      aviso = await buscarAviso(sid);
    }
    // Sin aviso es una respuesta del bot: cuenta igual para saber si la conexión funciona.
    const telefono = aviso?.telefono || String(To || '').replace(/^whatsapp:/, '').trim();
    const perfil = await perfilPorTelefono(telefono);

    if (ENTREGADO.has(estado)) {
      if (aviso) {
        await supabase.from('whatsapp_alerts')
          .update({ estado: 'entregado', enviado: true, error_code: null }).eq('id', aviso.id);
      }
      if (perfil?.whatsapp_vencido_at) await marcarConectado(perfil);
      if (telefono && (await liberarAvisos(telefono)) > 0) await vaciarCola();
      return res.status(200).end();
    }

    const vencido = codigo === CODIGO_SANDBOX_VENCIDO;
    if (aviso) {
      await supabase.from('whatsapp_alerts')
        .update({ estado: vencido ? 'en_espera' : 'fallido', enviado: false, error_code: codigo }).eq('id', aviso.id);
    }
    if (vencido && perfil) {
      // Un fallo de un envío anterior a renovar no dice nada de la renovación.
      const enviadoAntes = aviso?.ultimo_intento_at && perfil.whatsapp_renovado_at
        && new Date(aviso.ultimo_intento_at) < new Date(perfil.whatsapp_renovado_at);
      if (!enviadoAntes) await marcarVencido(perfil);
    }
    console.warn('[twilio-status] no entregado, código', codigo);
    return res.status(200).end();
  } catch (e) {
    console.error('[twilio-status] error:', e.message);
    return res.status(500).end(); // Twilio no reintenta, pero queda en sus logs.
  }
};
