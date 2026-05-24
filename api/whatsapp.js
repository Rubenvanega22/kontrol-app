// /api/whatsapp.js — Webhook entrante de Twilio WhatsApp
//
// Twilio envía POST x-www-form-urlencoded con:
//   From="whatsapp:+57...", Body="texto", NumMedia="0|1",
//   MediaUrl0=<url>, MediaContentType0="image/jpeg" | "audio/ogg" | ...
//
// Flujo:
//   1. Identificar usuario por profiles.telefono (E.164, sin "whatsapp:")
//   2. Branch por tipo:
//        - Audio → /api/transcribe (Groq Whisper) → ai-chat
//        - Imagen → Claude Vision extrae JSON → INSERT movements
//        - Texto → /api/ai-chat (mismo Claude/Mem0/acciones que el chat web)
//   3. Responder vía Twilio REST API (no TwiML — evita el timeout de 5s)
//
// ⚠️ Esta v1 NO verifica X-Twilio-Signature. Cualquiera que conozca la URL
//    puede impersonar usuarios. Endurecer en un PR de seguridad aparte.

const supabase = require('../lib/supabase');

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUM = process.env.TWILIO_WHATSAPP_NUMBER;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function baseUrl() {
  // Vercel inyecta VERCEL_URL en runtime (sin protocolo).
  return process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';
}

// ─── Twilio: enviar mensaje saliente ──────────────────────────
async function sendTwilio(to, body) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_NUM) {
    console.error('[whatsapp] Twilio no configurado (SID/TOKEN/NUMBER faltan)');
    return false;
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: `whatsapp:${TWILIO_NUM}`,
        To: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
        // Twilio limita a 1600 chars por mensaje WhatsApp.
        Body: String(body).slice(0, 1500)
      })
    }
  );
  const data = await r.json();
  if (!data.sid) console.error('[whatsapp] Twilio send error:', JSON.stringify(data));
  return !!data.sid;
}

// ─── Descargar media de Twilio (requiere basic auth) ──────────
async function fetchTwilioMedia(url) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const r = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });
  if (!r.ok) throw new Error(`Twilio media ${r.status}: ${await r.text()}`);
  return Buffer.from(await r.arrayBuffer());
}

// ─── Resolver usuario por número de WhatsApp ──────────────────
async function findUserByPhone(rawFrom) {
  // rawFrom = "whatsapp:+57XXXXXXXXXX"
  const phone = rawFrom.replace(/^whatsapp:/, '').trim();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, telefono')
    .eq('telefono', phone)
    .maybeSingle();
  if (error) console.error('[whatsapp] findUserByPhone error:', error.message);
  return data;
}

// ─── Procesar texto vía ai-chat (reutiliza prompts + acciones + Mem0) ──
async function procesarConIA(userId, message) {
  const r = await fetch(`${baseUrl()}/api/ai-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, user_id: userId, history: [] })
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('[whatsapp] ai-chat HTTP', r.status, JSON.stringify(data));
    return 'No pude procesar tu mensaje, intenta de nuevo.';
  }
  return data.respuesta || 'No tengo respuesta para eso.';
}

// ─── Transcribir audio (Groq Whisper vía /api/transcribe) ──────
async function transcribirAudio(buf, contentType) {
  const r = await fetch(`${baseUrl()}/api/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': contentType || 'audio/ogg' },
    body: buf
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('[whatsapp] transcribe HTTP', r.status, JSON.stringify(data));
    return '';
  }
  return data.texto || '';
}

// ─── Procesar foto: Claude Vision extrae transacción + INSERT ──
async function procesarFoto(userId, buf, contentType) {
  const base64 = buf.toString('base64');
  const mediaType = (contentType || 'image/jpeg').split(';')[0];

  const systemPrompt = `Eres un parser de comprobantes/recibos colombianos.
Recibes una foto y respondes SOLO con un JSON válido:
{
  "tipo": "gasto" | "ingreso",
  "monto": <entero COP sin separadores ni símbolos>,
  "descripcion": "<comercio o concepto, máx 50 chars>",
  "categoria": "alimentacion" | "transporte" | "entretenimiento" | "salud" | "servicios" | "otro",
  "fecha": "YYYY-MM-DD"
}
Si no es un comprobante claro: {"error":"no es un comprobante"}.
NO incluyas texto adicional, solo el JSON.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Extrae la transacción de este comprobante.' }
        ]
      }]
    })
  });
  const data = await r.json();
  if (data.error) {
    console.error('[whatsapp] vision error:', JSON.stringify(data.error));
    return 'No pude analizar la imagen.';
  }
  const raw = data.content?.[0]?.text || '';
  let extraida;
  try {
    const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] || '{}';
    extraida = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[whatsapp] vision JSON parse falló:', raw);
    return 'No entendí el comprobante.';
  }
  if (extraida.error || !extraida.monto) {
    return extraida.error || 'No pude extraer una transacción de la foto.';
  }

  // Insertar movimiento sin account_id — el usuario lo asocia desde la app.
  const { data: mov, error } = await supabase.from('movements').insert({
    user_id: userId,
    tipo: extraida.tipo === 'ingreso' ? 'ingreso' : 'gasto',
    descripcion: String(extraida.descripcion || 'Sin descripción').slice(0, 60),
    monto: parseInt(String(extraida.monto).replace(/[^\d]/g, ''), 10) || 0,
    fecha: extraida.fecha || new Date().toISOString().split('T')[0],
    categoria: extraida.categoria || 'otro',
    source: 'whatsapp_foto',
    confirmado: false
  }).select().single();

  if (error || !mov) {
    console.error('[whatsapp] insert movements error:', error?.message);
    return 'Error guardando el movimiento.';
  }

  const fmt = new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 0
  }).format(mov.monto);
  const signo = mov.tipo === 'ingreso' ? '+' : '-';
  return `✅ Registré ${signo}${fmt}\n${mov.descripcion}\nAsocia la cuenta desde la app.`;
}

// ─── Handler principal ────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const from = req.body?.From || '';
  const text = (req.body?.Body || '').trim();
  const numMedia = parseInt(req.body?.NumMedia || '0', 10);
  const mediaUrl = req.body?.MediaUrl0;
  const mediaCt = req.body?.MediaContentType0 || '';

  console.log('[whatsapp] in:', {
    from, text: text.substring(0, 80), numMedia, mediaCt
  });

  // Sin From no hay nada que hacer.
  if (!from) return res.status(200).send('OK');

  const usuario = await findUserByPhone(from);
  if (!usuario) {
    await sendTwilio(from,
      'Tu número no está vinculado a Kontrol. Agrégalo en Perfil → Teléfono.');
    return res.status(200).send('OK');
  }

  try {
    let respuesta;

    if (numMedia > 0 && mediaUrl && mediaCt.startsWith('audio/')) {
      const buf = await fetchTwilioMedia(mediaUrl);
      const texto = await transcribirAudio(buf, mediaCt);
      if (!texto) {
        respuesta = 'No pude entender el audio, intenta de nuevo.';
      } else {
        console.log('[whatsapp] audio transcrito:', texto.substring(0, 80));
        respuesta = await procesarConIA(usuario.id, texto);
      }
    } else if (numMedia > 0 && mediaUrl && mediaCt.startsWith('image/')) {
      const buf = await fetchTwilioMedia(mediaUrl);
      respuesta = await procesarFoto(usuario.id, buf, mediaCt);
    } else if (text) {
      respuesta = await procesarConIA(usuario.id, text);
    } else {
      respuesta = 'Envíame un mensaje, una nota de voz o la foto de un recibo.';
    }

    await sendTwilio(from, respuesta);
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[whatsapp] error:', e.message, e.stack);
    await sendTwilio(from, '⚠️ Hubo un error procesando tu mensaje.');
    return res.status(200).send('OK');
  }
};
