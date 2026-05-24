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
  // Why hardcoded: VERCEL_URL inyectado en runtime suele ser la URL específica
  // del deployment (kontrol-app-<hash>-<team>.vercel.app), que en planes con
  // Deployment Protection devuelve 401 + HTML para fetches sin bypass token.
  // El alias público kontrol-app-eight.vercel.app no tiene esa protección.
  // (Mismo patrón que api/reminders-cron.js.)
  return process.env.VERCEL_PUBLIC_URL || 'https://kontrol-app-eight.vercel.app';
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

// ─── Estado conversacional (multi-turno) ──────────────────────
// Tabla whatsapp_state: phone (PK), user_id, awaiting, context jsonb, expires_at.
// Solo se usa para flujos multi-turno (date-postpone, photo-match).
// El SI/NO/1/2 simple se resuelve sin estado consultando payments.
async function loadState(phone) {
  const { data, error } = await supabase
    .from('whatsapp_state')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
  if (error) { console.warn('[whatsapp] loadState error:', error.message); return null; }
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await clearState(phone);
    return null;
  }
  return data;
}
async function saveState(phone, userId, awaiting, context, ttlMin = 30) {
  const expires_at = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();
  const { error } = await supabase.from('whatsapp_state').upsert(
    { phone, user_id: userId, awaiting, context, expires_at },
    { onConflict: 'phone' }
  );
  if (error) console.warn('[whatsapp] saveState error:', error.message);
}
async function clearState(phone) {
  await supabase.from('whatsapp_state').delete().eq('phone', phone);
}

// ─── Pago activo para un usuario (espera SI/NO) ───────────────
// Devuelve el pago más reciente que ya recibió alerta y sigue pendiente.
async function pagoEnEspera(userId) {
  const { data, error } = await supabase
    .from('payments').select('*')
    .eq('user_id', userId)
    .neq('status', 'pagado')
    .or('notificado_pago.eq.true,notificado_6pm.eq.true')
    .order('notificado_6pm', { ascending: false })
    .order('fecha_limite', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[whatsapp] pagoEnEspera error:', error.message); return null; }
  return data;
}

// ─── Parser de fechas en español (delegado a Claude — corto y robusto) ───
async function parsearFechaEspanol(texto) {
  const hoy = new Date().toISOString().split('T')[0];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 40,
        system: `Eres un parser de fechas en español colombiano. HOY es ${hoy}. ` +
          `Responde SOLO con la fecha en formato YYYY-MM-DD. Si no es interpretable, responde "NULL".`,
        messages: [{ role: 'user', content: texto }]
      })
    });
    const data = await r.json();
    const out = (data.content?.[0]?.text || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
    return null;
  } catch (e) {
    console.error('[whatsapp] parsearFechaEspanol error:', e.message);
    return null;
  }
}

// ─── Procesar texto vía ai-chat (reutiliza prompts + acciones + Mem0) ──
async function procesarConIA(userId, message) {
  const url = `${baseUrl()}/api/ai-chat`;
  console.log('[whatsapp] → ai-chat', url);
  let r, raw;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, user_id: userId, history: [] })
    });
    raw = await r.text();
  } catch (e) {
    console.error('[whatsapp] ai-chat fetch falló:', e.message);
    return 'No pude conectar con el motor de IA.';
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    console.error('[whatsapp] ai-chat respuesta no-JSON. status=', r.status, 'body=', raw.slice(0, 300));
    return 'El motor de IA devolvió una respuesta inesperada.';
  }
  if (!r.ok) {
    console.error('[whatsapp] ai-chat HTTP', r.status, JSON.stringify(data));
    return data.error ? `Error IA: ${data.error}` : 'No pude procesar tu mensaje.';
  }
  return data.respuesta || 'No tengo respuesta para eso.';
}

// ─── Transcribir audio (Groq Whisper vía /api/transcribe) ──────
async function transcribirAudio(buf, contentType) {
  const url = `${baseUrl()}/api/transcribe`;
  let r, raw;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'audio/ogg' },
      body: buf
    });
    raw = await r.text();
  } catch (e) {
    console.error('[whatsapp] transcribe fetch falló:', e.message);
    return '';
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    console.error('[whatsapp] transcribe respuesta no-JSON. status=', r.status, 'body=', raw.slice(0, 300));
    return '';
  }
  if (!r.ok) {
    console.error('[whatsapp] transcribe HTTP', r.status, JSON.stringify(data));
    return '';
  }
  return data.texto || '';
}

// ─── Procesar foto: Claude Vision extrae transacción + INSERT ──
async function procesarFoto(userId, phone, buf, contentType) {
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
  let respuesta = `✅ Registré ${signo}${fmt}\n${mov.descripcion}`;

  // Flujo de seguimiento — dos preguntas encadenadas vía whatsapp_state:
  //   1. ¿corresponde a un pago programado? (photo_match, 0 = saltar)
  //   2. ¿de qué cuenta descuento / a cuál sumo? (photo_account)
  // Si NO hay pagos pendientes, saltamos directo a la cuenta.
  const { data: pendientes } = await supabase
    .from('payments').select('id, nombre, monto')
    .eq('user_id', userId)
    .neq('status', 'pagado')
    .order('fecha_limite', { ascending: true })
    .limit(5);

  if (pendientes && pendientes.length) {
    const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
    const lista = pendientes.map((p, i) => `${i + 1}. ${p.nombre} (${cop(p.monto)})`).join('\n');
    respuesta += `\n\n¿Este pago corresponde a un pago programado?\n${lista}\nO responde *0* para solo registrar el gasto.`;
    await saveState(phone, userId, 'photo_match', {
      movement_id: mov.id,
      monto: mov.monto,
      tipo: mov.tipo,
      payment_ids: pendientes.map(p => p.id)
    });
  } else {
    // Sin pagos pendientes → directo al paso de cuenta
    const seg = await askAccountQuestion(userId, phone, mov.id, mov.monto, mov.tipo);
    respuesta += `\n\n${seg}`;
  }
  return respuesta;
}

// ─── Pregunta de selección de cuenta + setea estado photo_account ─────
// Devuelve el texto a enviar. Si no hay cuentas, deja el movimiento
// huérfano y retorna un aviso (no setea estado — no hay flujo que esperar).
async function askAccountQuestion(userId, phone, movementId, monto, tipo) {
  const { data: cuentas, error } = await supabase
    .from('accounts').select('id, nombre, saldo')
    .eq('user_id', userId)
    .order('nombre', { ascending: true });
  if (error) {
    console.error('[whatsapp] askAccountQuestion accounts error:', error.message);
    return 'No pude leer tus cuentas. Asocia el movimiento desde la app.';
  }
  if (!cuentas || !cuentas.length) {
    return 'No tienes cuentas activas. Crea una en la app y luego asocia el movimiento.';
  }
  const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const lista = cuentas.map((c, i) => `${i + 1}. ${c.nombre} (${cop(c.saldo)})`).join('\n');
  const verbo = tipo === 'ingreso' ? 'sumo' : 'descuento';
  await saveState(phone, userId, 'photo_account', {
    movement_id: movementId, monto, tipo,
    account_ids: cuentas.map(c => c.id)
  });
  return `¿De qué cuenta ${verbo} ${cop(monto)}?\n${lista}\n(responde con el número)`;
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

  const phone = from.replace(/^whatsapp:/, '').trim();

  try {
    // ─── PRIMER PASO: ¿es respuesta a un flujo multi-turno? ──────
    // Solo para mensajes de texto (no audio/foto).
    if (text && numMedia === 0) {
      const estado = await loadState(phone);
      const flujo = await despacharRespuestaPago(usuario.id, phone, text, estado);
      if (flujo) {
        await sendTwilio(from, flujo);
        return res.status(200).send('OK');
      }
    }

    // ─── Fallback: procesamiento normal ──────────────────────────
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
      respuesta = await procesarFoto(usuario.id, phone, buf, mediaCt);
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

// ─── Dispatcher para flujos de pagos / multi-turno ───────────────
// Devuelve la respuesta a enviar (string), o null si no aplica
// (entonces el caller continúa al flujo normal AI).
async function despacharRespuestaPago(userId, phone, text, estado) {
  const lower = text.toLowerCase().trim();
  const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);

  // 1. Estado photo_match: usuario respondió con un número (0 = saltar)
  //    para asociar el gasto a un pago programado. Luego SIEMPRE encadenamos
  //    a la pregunta de cuenta (photo_account).
  if (estado?.awaiting === 'photo_match') {
    const num = parseInt(lower, 10);
    const { movement_id, monto, tipo, payment_ids } = estado.context || {};
    if (!Number.isFinite(num) || num < 0 || num > (payment_ids?.length || 0)) {
      await clearState(phone);
      return 'No entendí el número. Movimiento queda sin asociar.';
    }
    // 0 = saltar match de pago. 1..N = marcar el pago N como pagado.
    let prefijo = '';
    if (num >= 1) {
      const pagoId = payment_ids[num - 1];
      const hoy = new Date().toISOString().split('T')[0];
      const { error: upErr } = await supabase.from('payments')
        .update({ status: 'pagado', fecha_pago: hoy })
        .eq('id', pagoId).eq('user_id', userId);
      if (upErr) {
        console.error('[whatsapp] mark paid error:', upErr.message);
        prefijo = '⚠️ No pude marcar el pago.\n\n';
      } else {
        prefijo = '✅ Pago marcado como pagado.\n\n';
      }
    }
    // Encadenar: ahora preguntar de qué cuenta descontar.
    const accountQ = await askAccountQuestion(userId, phone, movement_id, monto, tipo);
    return prefijo + accountQ;
  }

  // 1b. Estado photo_account: usuario eligió cuenta — verificar saldo,
  //     aplicar deducción O preguntar por cuenta secundaria si no alcanza.
  if (estado?.awaiting === 'photo_account') {
    const num = parseInt(lower, 10);
    const { movement_id, monto, tipo, account_ids } = estado.context || {};
    if (!Number.isFinite(num) || num < 1 || num > (account_ids?.length || 0)) {
      await clearState(phone);
      return 'No entendí el número. Movimiento queda sin cuenta — asócialo desde la app.';
    }
    const accountId = account_ids[num - 1];

    const { data: cuenta, error: cErr } = await supabase
      .from('accounts').select('id, nombre, saldo')
      .eq('id', accountId).eq('user_id', userId).maybeSingle();
    if (cErr || !cuenta) {
      await clearState(phone);
      console.error('[whatsapp] photo_account cuenta no encontrada:', cErr?.message);
      return '⚠️ No pude leer esa cuenta. Asocia desde la app.';
    }

    const saldoActual = parseFloat(cuenta.saldo || 0);

    // ── Split flow: solo si es gasto y la cuenta primaria NO alcanza ──
    if (tipo === 'gasto' && saldoActual < monto) {
      const diferencia = monto - saldoActual;
      const { data: otras } = await supabase
        .from('accounts').select('id, nombre, saldo')
        .eq('user_id', userId)
        .neq('id', accountId)
        .order('nombre');
      let msg = `⚠️ En *${cuenta.nombre}* solo tienes ${cop(saldoActual)} pero el gasto es ${cop(monto)}. Te faltan ${cop(diferencia)}.\n¿Cómo pagaste el resto?`;
      if (otras && otras.length) {
        const lista = otras.map((c, i) => `${i + 1}. ${c.nombre} (${cop(c.saldo)})`).join('\n');
        msg += `\n${lista}\nO responde *0* para dejar el saldo en negativo.`;
      } else {
        msg += `\nResponde *0* para dejar el saldo en negativo (es tu única cuenta).`;
      }
      await saveState(phone, userId, 'photo_split', {
        movement_id, monto, tipo,
        primary_account_id: accountId,
        primary_monto: saldoActual,        // lo que drenamos del primario
        remaining_monto: diferencia,        // lo que falta — va al secundario
        secondary_account_ids: (otras || []).map(c => c.id)
      });
      return msg;
    }

    // ── Caso normal: ingreso o gasto con saldo suficiente ──
    await clearState(phone);
    const delta = tipo === 'ingreso' ? +monto : -monto;
    const nuevoSaldo = saldoActual + delta;
    const { error: sErr } = await supabase.from('accounts')
      .update({ saldo: nuevoSaldo }).eq('id', accountId).eq('user_id', userId);
    if (sErr) {
      console.error('[whatsapp] photo_account update saldo error:', sErr.message);
      return '⚠️ No pude ajustar el saldo. Asocia desde la app.';
    }

    const { error: mErr } = await supabase.from('movements')
      .update({ account_id: accountId, confirmado: true })
      .eq('id', movement_id).eq('user_id', userId);
    if (mErr) console.warn('[whatsapp] photo_account link movement error:', mErr.message);

    const verbo = tipo === 'ingreso' ? 'Sumé' : 'Desconté';
    return `✅ ${verbo} ${cop(monto)} ${tipo === 'ingreso' ? 'a' : 'de'} *${cuenta.nombre}*. Saldo actual: ${cop(nuevoSaldo)}`;
  }

  // 1c. Estado photo_split: el primario no alcanzó; el usuario eligió
  //     una segunda cuenta (1..N) o "0" para permitir saldo negativo.
  if (estado?.awaiting === 'photo_split') {
    const num = parseInt(lower, 10);
    const {
      movement_id, monto, tipo,
      primary_account_id, primary_monto, remaining_monto,
      secondary_account_ids
    } = estado.context || {};
    await clearState(phone);

    if (!Number.isFinite(num) || num < 0 || num > (secondary_account_ids?.length || 0)) {
      return 'No entendí el número. Movimiento queda sin terminar — ajusta desde la app.';
    }

    // Leer cuenta primaria fresh (puede haber cambiado entre turnos).
    const { data: primaria, error: pErr } = await supabase
      .from('accounts').select('id, nombre, saldo')
      .eq('id', primary_account_id).eq('user_id', userId).maybeSingle();
    if (pErr || !primaria) return '⚠️ No pude leer la cuenta primaria. Ajusta desde la app.';

    // ── Opción 0: saldo negativo permitido en la primaria ──
    if (num === 0) {
      const nuevoPrim = parseFloat(primaria.saldo || 0) - monto;
      const { error: e1 } = await supabase.from('accounts')
        .update({ saldo: nuevoPrim }).eq('id', primary_account_id).eq('user_id', userId);
      if (e1) { console.error('[whatsapp] split-neg saldo error:', e1.message); return '⚠️ Error ajustando saldo.'; }
      const { error: e2 } = await supabase.from('movements')
        .update({ account_id: primary_account_id, confirmado: true, nota: 'Saldo insuficiente al registrar' })
        .eq('id', movement_id).eq('user_id', userId);
      if (e2) console.warn('[whatsapp] split-neg link movement error:', e2.message);
      return `✅ Desconté ${cop(monto)} de *${primaria.nombre}*. Saldo actual: ${cop(nuevoPrim)} (negativo).`;
    }

    // ── Opción 1..N: dividir entre primaria y secundaria ──
    const secondaryId = secondary_account_ids[num - 1];
    const { data: secundaria, error: sErr } = await supabase
      .from('accounts').select('id, nombre, saldo')
      .eq('id', secondaryId).eq('user_id', userId).maybeSingle();
    if (sErr || !secundaria) return '⚠️ No pude leer la cuenta secundaria. Ajusta desde la app.';

    const nuevoPrim = parseFloat(primaria.saldo || 0) - primary_monto;
    const nuevoSec  = parseFloat(secundaria.saldo || 0) - remaining_monto;

    // Aplicar ambos UPDATE en paralelo. Si uno falla, el otro queda — no
    // hay transacción real en supabase-js, pero registramos y avisamos.
    const [up1, up2] = await Promise.all([
      supabase.from('accounts').update({ saldo: nuevoPrim }).eq('id', primary_account_id).eq('user_id', userId),
      supabase.from('accounts').update({ saldo: nuevoSec  }).eq('id', secondaryId).eq('user_id', userId)
    ]);
    if (up1.error || up2.error) {
      console.error('[whatsapp] split update errors:', up1.error?.message, up2.error?.message);
      return '⚠️ Error parcial aplicando el split. Revisa los saldos en la app.';
    }

    // El movement original queda con la cuenta primaria y SU porción del
    // monto. Insertamos un segundo movement para la porción del secundario,
    // copiando descripcion/fecha/categoria del original.
    const { data: orig } = await supabase
      .from('movements').select('descripcion, fecha, categoria')
      .eq('id', movement_id).eq('user_id', userId).maybeSingle();

    await supabase.from('movements').update({
      account_id: primary_account_id,
      monto: primary_monto,
      confirmado: true,
      nota: `Pago dividido con ${secundaria.nombre} (${cop(remaining_monto)})`
    }).eq('id', movement_id).eq('user_id', userId);

    await supabase.from('movements').insert({
      user_id: userId,
      tipo,
      descripcion: orig?.descripcion || 'Movimiento',
      monto: remaining_monto,
      fecha: orig?.fecha || new Date().toISOString().split('T')[0],
      categoria: orig?.categoria || 'otro',
      source: 'whatsapp_foto',
      account_id: secondaryId,
      confirmado: true,
      nota: `Pago dividido con ${primaria.nombre} (${cop(primary_monto)})`
    });

    return `✅ Pago dividido:\n• ${cop(primary_monto)} de *${primaria.nombre}* → ${cop(nuevoPrim)}\n• ${cop(remaining_monto)} de *${secundaria.nombre}* → ${cop(nuevoSec)}`;
  }

  // 1d. Estado event_1h_response: respuesta a "¿necesitas recordatorio de salida?"
  //     1 = sí (no hacemos nada — el modoQuinceMinAntes automático lo enviará)
  //     2 = no (marca notificado_15min=true para suprimir el aviso automático)
  if (estado?.awaiting === 'event_1h_response') {
    const num = parseInt(lower, 10);
    const { event_id, titulo } = estado.context || {};
    await clearState(phone);
    if (num === 1) {
      return `✅ Listo, te aviso 15 min antes de *${titulo}*.`;
    }
    if (num === 2) {
      const { error } = await supabase.from('events')
        .update({ notificado_15min: true })
        .eq('id', event_id).eq('user_id', userId);
      if (error) console.warn('[whatsapp] event_1h opt-out error:', error.message);
      return `👍 OK, no te aviso de nuevo sobre *${titulo}*.`;
    }
    return null; // respuesta no esperada → pasa al AI normal
  }

  // 2. Estado payment_date: usuario está dando la nueva fecha para un pago aplazado
  if (estado?.awaiting === 'payment_date') {
    const { payment_id } = estado.context || {};
    await clearState(phone);
    const nuevaFecha = await parsearFechaEspanol(text);
    if (!nuevaFecha) return 'No entendí la fecha. Cámbiala desde la app cuando puedas.';
    // Reseteamos las flags de notificación para que vuelva a recordar en la nueva fecha.
    const { error } = await supabase.from('payments')
      .update({ fecha_limite: nuevaFecha, notificado_pago: false, notificado_6pm: false })
      .eq('id', payment_id).eq('user_id', userId);
    if (error) { console.error('[whatsapp] postpone error:', error.message); return '⚠️ No pude posponer el pago.'; }
    return `🗓️ Listo, lo aplacé para ${nuevaFecha}.`;
  }

  // 3. Sin estado pero el texto se parece a una confirmación SI/NO/1/2.
  //    Buscamos el pago activo del usuario y lo procesamos.
  const esSi = /^(s[ií]|1|pagu[eé]|ya\s+pagu[eé]|listo|ok)$/i.test(lower);
  const esNo = /^(no|2)$/i.test(lower);
  if (!esSi && !esNo) return null; // No es respuesta de pago → procesar como AI normal

  const pago = await pagoEnEspera(userId);
  if (!pago) return null; // No hay pago esperando → procesar como AI normal

  if (esSi) {
    const hoy = new Date().toISOString().split('T')[0];
    const { error } = await supabase.from('payments')
      .update({ status: 'pagado', fecha_pago: hoy })
      .eq('id', pago.id).eq('user_id', userId);
    if (error) { console.error('[whatsapp] confirm paid error:', error.message); return '⚠️ Error marcando como pagado.'; }
    return `✅ Marqué *${pago.nombre}* (${cop(pago.monto)}) como pagado hoy.`;
  }

  // esNo: setear estado esperando fecha
  await saveState(phone, userId, 'payment_date', { payment_id: pago.id }, 60);
  return `OK, ¿para cuándo lo pospones? Dime la fecha (ej: "25 de mayo" o "el viernes").`;
}
