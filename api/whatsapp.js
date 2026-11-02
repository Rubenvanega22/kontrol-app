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
//        - Imagen → solo lectura: una lista crea un listado o se agrega a uno; una factura
//          pregunta y crea el pago si responden sí
//        - Texto → /api/ai-chat (mismo Claude/Mem0/acciones que el chat web)
//   3. Responder vía Twilio REST API (no TwiML — evita el timeout de 5s)
//
// Rechaza con 403 lo que no traiga una X-Twilio-Signature válida: identificar por
// From no basta, porque sin firma cualquiera podría suplantar un número.

const supabase = require('../lib/supabase');
const { colombiaDateString } = require('../lib/datetime');
const { firmaValida, urlDelWebhook } = require('../lib/twilio-signature');
const { STATUS_URL } = require('../lib/whatsapp-estado');
const { esPreguntaDeAgenda } = require('../lib/evento-completo');
const { leerListaDeImagen, leerFotoDeImagen, interpretarLectura, interpretarFoto, destinoDelTexto, elegirLista } = require('../lib/lista-foto');

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

// Twilio parsea la respuesta del webhook como TwiML; si recibe texto plano
// ("OK") dispara error 12200 "Content is not allowed in prolog" y, acumulado,
// marca el número como Offline. La reply al usuario sale por sendTwilio
// (REST API), así que el body TwiML va vacío — solo ack.
function twimlOk(res, status = 200) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');
  return res.status(status).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
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
        Body: String(body).slice(0, 1500),
        StatusCallback: STATUS_URL
      })
    }
  );
  const data = await r.json();
  if (!data.sid) console.error('[whatsapp] Twilio send error, code=', data.code, 'status=', data.status);
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
// Twilio a veces entrega From con "+" literal en el body URL-encoded; el
// parser de form-urlencoded lo decodifica como espacio, así que recibimos
// "whatsapp: 573024087608" en vez de "whatsapp:+573024087608". Re-prefijamos
// "+" si falta para que el match contra profiles.telefono (E.164) no falle.
function normalizePhone(rawFrom) {
  let phone = rawFrom.replace(/^whatsapp:/, '').trim();
  if (phone && !phone.startsWith('+')) phone = '+' + phone;
  return phone;
}

async function findUserByPhone(rawFrom) {
  const phone = normalizePhone(rawFrom);
  const { data, error } = await supabase
    .from('profiles')
    .select('id, telefono')
    .eq('telefono', phone)
    .maybeSingle();
  if (error) console.error('[whatsapp] findUserByPhone error:', error.message);
  if (data) return data;

  // Respaldo: teléfonos guardados sin +57 o con otro formato. Solo si hay una única
  // coincidencia, para no confundir a una persona con otra.
  const ultimos10 = phone.replace(/\D/g, '').slice(-10);
  if (ultimos10.length === 10) {
    const { data: parecidos, error: e2 } = await supabase
      .from('profiles').select('id, telefono').like('telefono', `%${ultimos10}`).limit(2);
    if (e2) console.error('[whatsapp] findUserByPhone respaldo error:', e2.message);
    if (parecidos && parecidos.length === 1) return parecidos[0];
  }
  // Sin el número completo en los logs: los últimos 4 bastan para diagnosticar.
  console.warn('[whatsapp] número sin perfil, termina en', phone.slice(-4));
  return null;
}

// ─── Estado conversacional (multi-turno) ──────────────────────
const FACTURA_ESPERA = 'factura_confirmar';
const FACTURA_VENCIDA = 'factura_vencida';
const FACTURA_ATENDIDA = 'factura_atendida';
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
    // Un "sí" tardío a una factura no debe marcar como pagado otro pago.
    return data.awaiting === FACTURA_ESPERA ? { awaiting: FACTURA_VENCIDA, context: data.context } : null;
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
  return !error;
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

// ─── ¿Ana acaba de preguntar algo de un evento? ───────────────
// Si es así y no ha llegado un aviso de pago después, la respuesta corta es para ella.
const ESPERA_PREGUNTA_AGENDA_MS = 60 * 60 * 1000;

async function anaEsperaRespuesta(phone) {
  const { data: ultimo, error } = await supabase
    .from('whatsapp_conversations').select('role, content, created_at')
    .eq('phone', phone)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[whatsapp] anaEsperaRespuesta error:', error.message); return false; }
  if (!ultimo || ultimo.role !== 'assistant' || !esPreguntaDeAgenda(ultimo.content)) return false;
  if (Date.now() - new Date(ultimo.created_at).getTime() > ESPERA_PREGUNTA_AGENDA_MS) return false;
  const { data: avisos } = await supabase
    .from('whatsapp_alerts').select('id')
    .eq('telefono', phone).eq('tipo', 'pago_recordatorio')
    .gt('created_at', ultimo.created_at)
    .limit(1);
  return !avisos?.length;
}

// ─── Parser de fechas en español (delegado a Claude — corto y robusto) ───
async function parsearFechaEspanol(texto) {
  const hoy = colombiaDateString();
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
// Mantiene contexto conversacional cargando los últimos 8 turnos desde
// whatsapp_conversations (phone como clave) y persistiendo ambos lados
// tras la respuesta. Sin esto cada mensaje se procesa aislado y la IA
// "olvida" lo que se acaba de decir.
async function procesarConIA(userId, phone, message) {
  // Cargar últimos 8 turnos (más reciente primero) y revertir a orden cronológico
  let history = [];
  try {
    const { data: prev, error } = await supabase
      .from('whatsapp_conversations')
      .select('role, content')
      .eq('phone', phone)
      // Por id: cada par usuario/asistente se guarda con el mismo created_at, y
      // ordenar solo por fecha podía invertir los turnos que recibe la IA.
      .order('id', { ascending: false })
      .limit(8);
    if (error) console.warn('[whatsapp] load history error:', error.message);
    else if (prev) history = prev.reverse().map(m => ({ role: m.role, content: m.content }));
  } catch (e) {
    console.warn('[whatsapp] load history excepción:', e.message);
  }

  const url = `${baseUrl()}/api/ai-chat`;
  console.log('[whatsapp] → ai-chat', url, 'history.len=', history.length);
  let r, raw;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
      body: JSON.stringify({ message, user_id: userId, history })
    });
    raw = await r.text();
  } catch (e) {
    console.error('[whatsapp] ai-chat fetch falló:', e.message);
    return 'No pude conectar con el motor de IA.';
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    console.error('[whatsapp] ai-chat respuesta no-JSON. status=', r.status);
    return 'El motor de IA devolvió una respuesta inesperada.';
  }
  if (!r.ok) {
    console.error('[whatsapp] ai-chat HTTP', r.status);
    return data.error ? `Error IA: ${data.error}` : 'No pude procesar tu mensaje.';
  }
  const respuesta = data.respuesta || 'No tengo respuesta para eso.';

  // Persistir ambos turnos. Fire-and-forget para no añadir latencia al envío
  // por Twilio — si falla, lo loggeamos pero igual respondemos.
  supabase.from('whatsapp_conversations').insert([
    { user_id: userId, phone, role: 'user', content: message },
    { user_id: userId, phone, role: 'assistant', content: respuesta }
  ]).then(({ error }) => {
    if (error) console.warn('[whatsapp] save history error:', error.message);
  });

  return respuesta;
}

// ─── Transcribir audio (Groq Whisper vía /api/transcribe) ──────
async function transcribirAudio(buf, contentType) {
  const url = `${baseUrl()}/api/transcribe`;
  let r, raw;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType || 'audio/ogg', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
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
    console.error('[whatsapp] transcribe respuesta no-JSON. status=', r.status);
    return '';
  }
  if (!r.ok) {
    console.error('[whatsapp] transcribe HTTP', r.status);
    return '';
  }
  return data.texto || '';
}

// ─── Fotos: listas y facturas ─────────────────────────────────
// Usa los lectores de la app: solo leen. Ni la foto ni su texto pasan por el asistente,
// así que no pueden ejecutar acciones; el texto solo elige la lista destino.
const FACTURA_TTL_MIN = 24 * 60;
const FOTO_TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const FOTO_MAX_BYTES = 3.7 * 1024 * 1024; // en base64 queda bajo el límite de 5 MB del lector
const SIN_LISTA = '🔍 No encontré ninguna lista en esa foto. Prueba con más luz y de cerca.';
const NI_FACTURA_NI_LISTA = '🔍 Esa foto no parece una factura ni una lista. Prueba con más luz y de cerca, o escríbeme lo que necesitas.';
const cuentaItems = (n) => `${n} ${n === 1 ? 'ítem' : 'ítems'}`;

// El lector se elige afuera: con destino se lee como lista; sin destino, se clasifica.
async function leerFoto(mediaUrl, mediaCt, lector) {
  const tipo = String(mediaCt).split(';')[0].trim().toLowerCase();
  if (!FOTO_TIPOS.includes(tipo)) return { error: 'No pude abrir ese tipo de imagen. Mándala como foto normal de WhatsApp.' };
  let buf;
  try { buf = await fetchTwilioMedia(mediaUrl); }
  catch (e) {
    console.error('[whatsapp] foto: descarga falló:', e.message);
    return { error: 'No pude descargar la foto. Intenta de nuevo.' };
  }
  if (buf.length > FOTO_MAX_BYTES) return { error: 'Esa foto es muy pesada. Mándala otra vez como foto normal, no como documento.' };
  try {
    return await lector(buf.toString('base64'), tipo);
  } catch (e) {
    console.error('[whatsapp] foto: lectura falló:', e.message);
    return { error: 'No pude leer la foto. Intenta de nuevo.' };
  }
}

async function crearListaDeFoto(userId, titulo, items) {
  const { data, error } = await supabase.from('reminders').insert({
    user_id: userId, tipo: 'listado', titulo, content: { items: items.map((text) => ({ text, done: false })) },
    fecha: colombiaDateString()
  }).select('id').single();
  if (error || !data) {
    console.error('[whatsapp] foto: no se creó la lista:', error?.message);
    return '❌ Leí la lista, pero no pude guardarla. Intenta de nuevo.';
  }
  return `📋 Listo, creé la lista ${titulo} con ${cuentaItems(items.length)}.`;
}

async function agregarAListaDeFoto(userId, lista, items) {
  const falla = '❌ Leí los ítems, pero no pude guardarlos en la lista. Intenta de nuevo.';
  // Se relee justo antes de escribir: la lectura de la foto tarda varios segundos.
  const { data: actual, error: e1 } = await supabase.from('reminders').select('content')
    .eq('id', lista.id).eq('user_id', userId).maybeSingle();
  if (e1 || !actual) {
    console.error('[whatsapp] foto: no se releyó la lista:', e1?.message);
    return falla;
  }
  const content = actual.content || {};
  const existentes = Array.isArray(content.items) ? content.items : [];
  const nuevos = items.map((text) => ({ text, done: false }));
  const { data, error } = await supabase.from('reminders').update({ content: { ...content, items: [...existentes, ...nuevos] } })
    .eq('id', lista.id).eq('user_id', userId).select('id');
  if (error || !data?.length) {
    console.error('[whatsapp] foto: no se agregó a la lista:', error?.message);
    return falla;
  }
  return `📋 Listo, agregué ${cuentaItems(items.length)} a la lista ${lista.titulo}.`;
}

async function responderFoto(userId, phone, mediaUrl, mediaCt, caption) {
  const destino = destinoDelTexto(caption);
  let lista = null;
  // La lista se resuelve antes de leer: si hay que preguntar, no se gasta la lectura.
  if (destino) {
    if (!destino.nombre) return '¿A cuál lista lo agrego? Mándame la foto otra vez con el nombre, por ejemplo: "a la lista de mercado".';
    const { data: listas, error } = await supabase.from('reminders').select('id, titulo')
      .eq('user_id', userId).in('tipo', ['listado', 'lista']);
    if (error) {
      console.error('[whatsapp] foto: no se cargaron las listas:', error.message);
      return '❌ No pude revisar tus listas. Intenta de nuevo.';
    }
    const opciones = elegirLista(listas || [], destino.nombre);
    if (opciones.length > 1) {
      return `Tengo varias listas con "${destino.nombre}":\n${opciones.slice(0, 8).map((l) => `• ${l.titulo}`).join('\n')}\n\nMándame la foto otra vez con el nombre completo.`;
    }
    if (!opciones.length) {
      const nombres = (listas || []).slice(0, 8).map((l) => `• ${l.titulo}`).join('\n');
      return `No encontré la lista "${destino.nombre}" y no agregué nada.${nombres ? `\n\nTus listas:\n${nombres}` : ''}\n\nMándame la foto otra vez con el nombre exacto, o sin texto para crear una lista nueva.`;
    }
    lista = opciones[0];
  }
  if (lista) {
    const leida = await leerFoto(mediaUrl, mediaCt, async (b64, tipo) => interpretarLectura(await leerListaDeImagen(b64, tipo)));
    if (leida.error) return leida.error;
    if (!leida.items.length) return SIN_LISTA;
    console.log('[whatsapp] foto: ítems agregados=', leida.items.length);
    return agregarAListaDeFoto(userId, lista, leida.items);
  }
  const foto = await leerFoto(mediaUrl, mediaCt, async (b64, tipo) => interpretarFoto(await leerFotoDeImagen(b64, colombiaDateString(), tipo)));
  if (foto.error) return foto.error;
  console.log('[whatsapp] foto: tipo=', foto.tipo);
  if (foto.tipo === 'lista') return crearListaDeFoto(userId, foto.titulo, foto.items);
  if (foto.tipo === 'factura') return prepararFactura(userId, phone, foto, mediaUrl, mediaCt);
  return NI_FACTURA_NI_LISTA;
}

// ─── Factura: pregunta y solo crea el pago si responden sí ─────
// Mientras espera se guarda la dirección de la foto en Twilio, no el archivo: con "no" no
// queda nada. "sí" y "no" son de la factura; 1 y 2 siguen siendo de los avisos de pago.
const FACTURA_SI = /^(s[ií]|sip|dale|ok|okay|claro|de una|gu[aá]rdalo)(?:[\s,]+(?:gu[aá]rdalo|por favor|porfa|gracias|claro|dale))*\s*[.!]*$/i;
const FACTURA_NO = /^(no|nop|nope|cancela|cancelar|d[eé]jalo|ol[vb][ií]dalo)(?:[\s,]+(?:lo guardes|gracias|por favor|porfa))*\s*[.!]*$/i;
const RESPUESTA_AVISO = /^(1|1️⃣|2|2️⃣|listo|pagu[eé]|ya\s+pagu[eé]|aplazar|despu[eé]s)\s*[.,!]?\s*$/i;
const fmtPesos = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function fmtDiaCorto(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const mes = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
  return `${d} ${mes}${a === Number(colombiaDateString().slice(0, 4)) ? '' : ' ' + a}`;
}
function resumenFactura(f) {
  const vence = f.fecha < colombiaDateString() ? 'venció' : 'vence';
  return `${f.nombre} · ${fmtPesos(f.valor)} · ${vence} ${fmtDiaCorto(f.fecha)}`;
}

async function prepararFactura(userId, phone, f, mediaUrl, mediaCt) {
  const faltan = [!f.nombre && 'quién cobra', !f.valor && 'el valor', !f.fecha && 'la fecha límite'].filter(Boolean);
  if (faltan.length) {
    const leido = [f.nombre, f.valor && fmtPesos(f.valor), f.fecha && `vence ${fmtDiaCorto(f.fecha)}`].filter(Boolean).join(' · ');
    return `🧾 ${leido ? `Leí: ${leido}. ` : ''}No encontré ${faltan.join(' ni ')}, así que no guardé nada. Mándala con más luz o créala en la app: Pagos → Desde factura.`;
  }
  const anterior = await loadState(phone);
  // Sin el estado guardado no se pregunta: un "sí" caería en los avisos de pago y podría
  // marcar otro pago como pagado.
  const ok = await saveState(phone, userId, FACTURA_ESPERA, { nombre: f.nombre, valor: f.valor, fecha: f.fecha, media_url: mediaUrl, media_ct: mediaCt }, FACTURA_TTL_MIN);
  if (!ok) return '⚠️ Leí la factura, pero no pude dejarla pendiente. Mándala otra vez.';
  const aviso = anterior?.awaiting === FACTURA_ESPERA ? `Dejé sin guardar la factura anterior (${anterior.context?.nombre || 'sin nombre'}).\n\n` : '';
  return `${aviso}🧾 ${resumenFactura(f)}. ¿Lo guardo? Responde sí o no`;
}

async function adjuntarFactura(userId, pagoId, ctx) {
  try {
    const buf = await fetchTwilioMedia(ctx.media_url);
    const tipo = String(ctx.media_ct).split(';')[0].trim().toLowerCase();
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[tipo];
    if (!ext) throw new Error('tipo no admitido: ' + tipo);
    // soporte_url guarda la ruta, no una URL: el bucket es privado.
    const ruta = `${userId}/${pagoId}-${Date.now()}.${ext}`;
    const { error: e1 } = await supabase.storage.from('facturas').upload(ruta, buf, { contentType: tipo });
    if (e1) throw new Error(e1.message);
    const { error: e2 } = await supabase.from('payments').update({ soporte_url: ruta }).eq('id', pagoId).eq('user_id', userId);
    if (e2) {
      await supabase.storage.from('facturas').remove([ruta]);
      throw new Error(e2.message);
    }
    return true;
  } catch (e) {
    console.error('[whatsapp] factura: no se adjuntó la foto:', e.message);
    return false;
  }
}

async function confirmarFactura(userId, phone, ctx) {
  // Se reclama borrando el estado: dos "sí" seguidos no crean dos pagos.
  const { data: reclamado, error: e0 } = await supabase.from('whatsapp_state').delete()
    .eq('phone', phone).eq('awaiting', FACTURA_ESPERA).select('phone');
  if (e0) {
    console.error('[whatsapp] factura: no se reclamó el estado:', e0.message);
    return '❌ No pude guardar el pago. Responde sí otra vez.';
  }
  if (!reclamado?.length) return 'Esa factura ya la atendí.';
  const { data: pago, error } = await supabase.from('payments').insert({
    user_id: userId, nombre: ctx.nombre, monto: ctx.valor, fecha_limite: ctx.fecha, status: 'pendiente'
  }).select('id').single();
  if (error || !pago) {
    console.error('[whatsapp] factura: no se creó el pago:', error?.message);
    await saveState(phone, userId, FACTURA_ESPERA, ctx, FACTURA_TTL_MIN);
    return '❌ No pude guardar el pago. Responde sí otra vez.';
  }
  // Un segundo "sí" seguido no debe caer en los avisos y marcar otro pago como pagado.
  await saveState(phone, userId, FACTURA_ATENDIDA, { nombre: ctx.nombre }, 2);
  const conFoto = await adjuntarFactura(userId, pago.id, ctx);
  return conFoto
    ? `✅ Guardé ${resumenFactura(ctx)}, con su factura.`
    : `✅ Guardé ${resumenFactura(ctx)}, pero no pude guardar la foto. Agrégala en la app, en el detalle del pago.`;
}

async function guardarTurno(userId, phone, entrada, respuesta) {
  const { error } = await supabase.from('whatsapp_conversations').insert([
    { user_id: userId, phone, role: 'user', content: entrada },
    { user_id: userId, phone, role: 'assistant', content: respuesta }
  ]);
  if (error) console.warn('[whatsapp] save history error:', error.message);
}

async function procesarFoto(userId, phone, mediaUrl, mediaCt, caption) {
  const respuesta = await responderFoto(userId, phone, mediaUrl, mediaCt, caption);
  // Para que el bot sepa de qué se habla si le escriben justo después.
  await guardarTurno(userId, phone, caption ? `[Foto] ${caption}` : '[Foto]', respuesta);
  return respuesta;
}

// ─── Ubicaciones (lugares guardados) ──────────────────────────
// Mensaje canónico cuando hay colisión de nombre. Numerado para UX consistente
// con respuestas rápidas tipo botón.
function mensajeConflictoUbicacion(nombre) {
  return `⚠️ Ya tienes "${nombre}" guardada.\n\nResponde:\n1️⃣ Reemplazar la anterior\n2️⃣ Guardar con otro nombre\n3️⃣ Cancelar`;
}

// INSERT con dedup case-insensitive (índice ubicaciones_user_nombre_unique).
// Devuelve { ok, id } en éxito, { conflicto: {id, nombre} } si 23505, {} si otro error.
async function guardarUbicacion(userId, nombre, lat, lng, direccion, label) {
  const { data: nuevo, error } = await supabase.from('ubicaciones').insert({
    user_id: userId,
    nombre,
    latitud: lat,
    longitud: lng,
    direccion_texto: direccion || null,
    notas: label && label !== nombre ? `WhatsApp Label: ${label}` : null,
    created_via: 'whatsapp'
  }).select().single();

  if (!error) return { ok: true, id: nuevo.id };

  if (error.code === '23505') {
    const { data: existente } = await supabase
      .from('ubicaciones').select('id, nombre')
      .eq('user_id', userId)
      .ilike('nombre', nombre)
      .maybeSingle();
    return { conflicto: existente || { nombre, id: null } };
  }
  console.error('[ubicaciones] insert error:', error.message);
  return {};
}

// Maneja una ubicación entrante. Si trae caption/Label corto y razonable
// la guarda directo; si no, pide nombre via whatsapp_state.
async function procesarUbicacion(userId, phone, lat, lng, label, address, caption) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return '⚠️ No pude leer las coordenadas de la ubicación.';
  }

  const sugerido = (caption || label || '').trim();
  const pareceComando = /(\$|\b\d{4,}\b|gast[oeé]|ingres[oa]|recuerd|agenda|registr|elimin|borr)/i.test(sugerido);

  if (sugerido && sugerido.length <= 100 && !pareceComando) {
    const resultado = await guardarUbicacion(userId, sugerido, lat, lng, address, label);
    if (resultado.ok) return `✅ Guardé "${sugerido}" en tu lista de lugares.`;
    if (resultado.conflicto) {
      await saveState(phone, userId, 'location_conflict_resolution', {
        nuevo_lat: lat, nuevo_lng: lng,
        nuevo_direccion: address || null,
        nuevo_label: label || null,
        nombre_existente: resultado.conflicto.nombre,
        ubicacion_existente_id: resultado.conflicto.id
      }, 5);
      return mensajeConflictoUbicacion(resultado.conflicto.nombre);
    }
    return '⚠️ No pude guardar la ubicación. Inténtalo de nuevo.';
  }

  // Pedir nombre. Si vino Label de un rich location, ofrecerlo como sugerencia.
  await saveState(phone, userId, 'location_name', {
    lat, lng,
    direccion: address || null,
    label: label || null
  }, 10);

  const labelHint = label ? `\n(WhatsApp dice "${label}" — puedes usar ese nombre si quieres)` : '';
  return `📍 Recibí tu ubicación. ¿Con qué nombre la guardo? (responde solo el nombre)${labelHint}`;
}

// ─── Handler principal ────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return twimlOk(res, 405);

  const urlFirmada = urlDelWebhook(req);
  if (!firmaValida(TWILIO_TOKEN, req.headers['x-twilio-signature'], urlFirmada, req.body)) {
    console.warn('[whatsapp] firma de Twilio inválida. url=', urlFirmada, 'trae firma=', !!req.headers['x-twilio-signature']);
    return twimlOk(res, 403);
  }

  const from = req.body?.From || '';
  const text = (req.body?.Body || '').trim();
  const numMedia = parseInt(req.body?.NumMedia || '0', 10);
  const mediaUrl = req.body?.MediaUrl0;
  const mediaCt = req.body?.MediaContentType0 || '';
  // Ubicación: Twilio manda Latitude/Longitude/MessageType='location' cuando
  // el usuario comparte un pin. NumMedia=0 (no es media). Address/Label son
  // opcionales (Address solo si WhatsApp resolvió, Label solo en rich locations).
  const messageType = req.body?.MessageType || '';
  const latRaw = req.body?.Latitude;
  const lngRaw = req.body?.Longitude;
  const locAddress = req.body?.Address || '';
  const locLabel = req.body?.Label || '';

  console.log('[whatsapp] in:', {
    hasText: !!text, numMedia, mediaCt,
    messageType, hasLatLng: !!(latRaw && lngRaw)
  });

  // Sin From no hay nada que hacer.
  if (!from) return twimlOk(res);

  const usuario = await findUserByPhone(from);
  if (!usuario) {
    await sendTwilio(from,
      'Tu número no está vinculado a Kontrol. Agrégalo en la app: ⚙️ Configuración → Mi perfil.');
    return twimlOk(res);
  }

  const phone = normalizePhone(from);

  try {
    // ─── Ubicación entrante: preempte cualquier estado o flujo. ──
    // El pin es una acción explícita; debe tener prioridad sobre flujos
    // anteriores (ej. usuario abandonó un payment_date y mandó un lugar).
    if (messageType === 'location' || (latRaw && lngRaw)) {
      const lat = parseFloat(latRaw);
      const lng = parseFloat(lngRaw);
      const respuesta = await procesarUbicacion(usuario.id, phone, lat, lng, locLabel, locAddress, text);
      await sendTwilio(from, respuesta);
      return twimlOk(res);
    }

    // ─── PRIMER PASO: ¿es respuesta a un flujo multi-turno? ──────
    // Solo para mensajes de texto (no audio/foto).
    if (text && numMedia === 0) {
      const estado = await loadState(phone);
      const flujo = await despacharRespuestaPago(usuario.id, phone, text, estado);
      if (flujo) {
        await sendTwilio(from, flujo);
        return twimlOk(res);
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
        console.log('[whatsapp] audio transcrito, longitud=', texto.length);
        const estado = await loadState(phone);
        const flujo = estado?.awaiting === FACTURA_ESPERA ? await despacharRespuestaPago(usuario.id, phone, texto, estado) : null;
        respuesta = flujo || await procesarConIA(usuario.id, phone, texto);
      }
    } else if (numMedia > 0 && mediaUrl && mediaCt.startsWith('image/')) {
      respuesta = await procesarFoto(usuario.id, phone, mediaUrl, mediaCt, text);
    } else if (text) {
      respuesta = await procesarConIA(usuario.id, phone, text);
    } else {
      respuesta = 'Envíame un mensaje o una nota de voz.';
    }

    await sendTwilio(from, respuesta);
    return twimlOk(res);
  } catch (e) {
    console.error('[whatsapp] error:', e.message, e.stack);
    await sendTwilio(from, '⚠️ Hubo un error procesando tu mensaje.');
    return twimlOk(res);
  }
};

// ─── Dispatcher para flujos de pagos / multi-turno ───────────────
// Devuelve la respuesta a enviar (string), o null si no aplica
// (entonces el caller continúa al flujo normal AI).
async function despacharRespuestaPago(userId, phone, text, estado) {
  const lower = text.toLowerCase().trim();
  const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);

  // 0. Factura esperando respuesta. Va primero: aquí "sí" guarda la factura y NO marca
  //    como pagado el último pago avisado.
  const facturaPendiente = estado?.awaiting === FACTURA_ESPERA ? estado.context : null;
  if (facturaPendiente) {
    const t = text.trim();
    if (FACTURA_SI.test(t)) {
      const r = await confirmarFactura(userId, phone, facturaPendiente);
      await guardarTurno(userId, phone, t, r);
      return r;
    }
    if (FACTURA_NO.test(t)) {
      await clearState(phone);
      const r = '👍 Listo, no guardé nada.';
      await guardarTurno(userId, phone, t, r);
      return r;
    }
    // Otra cosa la atiende la IA y la factura sigue pendiente.
    if (!RESPUESTA_AVISO.test(t)) return null;
    // 1, 2, "listo"… son de los avisos. Sin aviso pendiente, se aclara y no se adivina.
    if (!(await pagoEnEspera(userId))) return `Para la factura de ${facturaPendiente.nombre} responde sí o no.`;
  }
  if (estado?.awaiting === FACTURA_ATENDIDA && (FACTURA_SI.test(text.trim()) || FACTURA_NO.test(text.trim()))) {
    return `La factura de ${estado.context?.nombre || 'tu foto'} ya quedó guardada. Si respondías un aviso de pago, usa 1 o 2.`;
  }
  if (estado?.awaiting === FACTURA_VENCIDA && (FACTURA_SI.test(text.trim()) || FACTURA_NO.test(text.trim()))) {
    return `La factura de ${estado.context?.nombre || 'tu foto'} ya venció y no guardé nada. Mándala otra vez si la quieres registrar. Si respondías un aviso de pago, usa 1 o 2.`;
  }

  // 1d. Estado event_1h_response: respuesta a "¿necesitas recordatorio de salida?"
  //     1 = sí (no hacemos nada — el modoQuinceMinAntes automático lo enviará)
  //     2 = no (marca notificado_15min=true para suprimir el aviso automático)
  if (estado?.awaiting === 'event_1h_response') {
    // Solo "1" o "2" exactos: "2 pm" puede ser la respuesta a "¿A qué hora?" de otro evento.
    const num = /^[12](️?⃣)?\s*[.,!]?$/.test(lower) ? parseInt(lower, 10) : NaN;
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
    const { payment_id, factura } = estado.context || {};
    await clearState(phone);
    // Si había una factura pendiente vuelve a quedar esperando su respuesta.
    const conFactura = async (msg) => {
      if (!factura) return msg;
      const ok = await saveState(phone, userId, FACTURA_ESPERA, factura, FACTURA_TTL_MIN);
      return ok ? `${msg}\n\n🧾 Sigo con tu factura: ${resumenFactura(factura)}. ¿La guardo? Responde sí o no` : `${msg}\n\n⚠️ Perdí la factura pendiente de ${factura.nombre}. Mándala otra vez.`;
    };
    const nuevaFecha = await parsearFechaEspanol(text);
    if (!nuevaFecha) return conFactura('No entendí la fecha. Cámbiala desde la app cuando puedas.');
    // Reseteamos las flags de notificación para que vuelva a recordar en la nueva fecha.
    // notificado_fecha=null limpia el dedup diario del recordatorio de pagos.
    const { error } = await supabase.from('payments')
      .update({ fecha_limite: nuevaFecha, notificado_pago: false, notificado_6pm: false, notificado_fecha: null })
      .eq('id', payment_id).eq('user_id', userId);
    if (error) { console.error('[whatsapp] postpone error:', error.message); return conFactura('⚠️ No pude posponer el pago.'); }
    return conFactura(`🗓️ Listo, lo aplacé para ${nuevaFecha}.`);
  }

  // 2b. Estado location_name: usuario mandó ubicación, le pedimos el nombre.
  //     Orden: cancelar → comando (cae a IA normal) → nombre → guardar.
  if (estado?.awaiting === 'location_name') {
    const txt = text.trim();
    if (/^(no|nop|cancelar|ol[vw][íi]dalo|d[ée]jalo)\s*\.?$/i.test(txt)) {
      await clearState(phone);
      return 'Ok, no la guardé.';
    }
    if (/(\$|\b\d{4,}\b|gast[oeé]|ingres[oa]|recuerd|agenda|registr|elimin|borr)/i.test(txt)) {
      // Comando: el usuario abandonó el flujo. Limpiamos y delegamos a IA.
      await clearState(phone);
      return null;
    }
    if (txt.length > 100) return 'El nombre es muy largo. Dame uno más corto (máx 100 caracteres).';

    const { lat, lng, direccion, label } = estado.context || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      await clearState(phone);
      return '⚠️ Se perdió la ubicación. Mándamela de nuevo.';
    }
    const resultado = await guardarUbicacion(userId, txt, lat, lng, direccion, label);
    if (resultado.ok) {
      await clearState(phone);
      return `✅ Guardé "${txt}" en tu lista de lugares.`;
    }
    if (resultado.conflicto) {
      await saveState(phone, userId, 'location_conflict_resolution', {
        nuevo_lat: lat, nuevo_lng: lng,
        nuevo_direccion: direccion, nuevo_label: label,
        nombre_existente: resultado.conflicto.nombre,
        ubicacion_existente_id: resultado.conflicto.id
      }, 5);
      return mensajeConflictoUbicacion(resultado.conflicto.nombre);
    }
    return '⚠️ No pude guardar. Intenta de nuevo.';
  }

  // 2c. Estado location_conflict_resolution: 3 opciones numeradas.
  //     1 = reemplazar, 2 = guardar con otro nombre (sub-estado), 3 = cancelar.
  //     Acepta dígitos, emojis (1️⃣), palabras (uno/dos/tres) y verbales
  //     (reemplazar/cancelar/sí/no).
  if (estado?.awaiting === 'location_conflict_resolution') {
    const txt = text.trim();
    const lower2 = txt.toLowerCase();
    const ctx = estado.context || {};
    const { nuevo_lat, nuevo_lng, nuevo_direccion, nuevo_label,
            nombre_existente, ubicacion_existente_id } = ctx;

    // Opción 3 — cancelar
    if (/^(3|3️⃣|tres|cancelar|no|nop|ol[vw][íi]dalo|d[ée]jalo)\s*\.?$/i.test(lower2)) {
      await clearState(phone);
      return 'Ok, no la guardé.';
    }
    // Opción 1 — reemplazar
    if (/^(1|1️⃣|uno|reemplazar|reempl[áa]zal[ao]|cambia|s[íi])\s*\.?$/i.test(lower2)) {
      if (!ubicacion_existente_id) {
        await clearState(phone);
        return '⚠️ Se perdió la referencia. Mándamela de nuevo.';
      }
      const { error } = await supabase.from('ubicaciones').update({
        latitud: nuevo_lat,
        longitud: nuevo_lng,
        direccion_texto: nuevo_direccion || null,
        notas: nuevo_label && nuevo_label !== nombre_existente ? `WhatsApp Label: ${nuevo_label}` : null,
        updated_at: new Date().toISOString()
      }).eq('id', ubicacion_existente_id).eq('user_id', userId);
      await clearState(phone);
      if (error) { console.error('[ubicaciones] reemplazar error:', error.message); return '⚠️ No pude reemplazar.'; }
      return `✅ Actualicé "${nombre_existente}" con la nueva ubicación.`;
    }
    // Opción 2 — guardar con otro nombre → sub-estado a espera del nombre
    if (/^(2|2️⃣|dos|nuevo|otro|usar\s+otro)\b/i.test(lower2)) {
      await saveState(phone, userId, 'location_new_name_after_conflict', ctx, 5);
      return '📝 Dale, ¿con qué nombre la guardo? (responde solo el nombre)';
    }
    // No matchea — ayuda
    return 'No entendí. Responde:\n1️⃣ Reemplazar\n2️⃣ Guardar con otro nombre\n3️⃣ Cancelar';
  }

  // 2d. Estado location_new_name_after_conflict: el usuario eligió opción 2 y
  //     ahora le pedimos el nombre nuevo. Si TAMBIÉN colisiona, volvemos al
  //     location_conflict_resolution con los nuevos datos.
  if (estado?.awaiting === 'location_new_name_after_conflict') {
    const txt = text.trim();
    if (/^(no|nop|cancelar|ol[vw][íi]dalo|d[ée]jalo)\s*\.?$/i.test(txt)) {
      await clearState(phone);
      return 'Ok, no la guardé.';
    }
    if (/(\$|\b\d{4,}\b|gast[oeé]|ingres[oa]|recuerd|agenda|registr|elimin|borr)/i.test(txt)) {
      await clearState(phone);
      return null;
    }
    if (txt.length > 100) return 'El nombre es muy largo. Dame uno más corto (máx 100 caracteres).';

    const ctx = estado.context || {};
    const { nuevo_lat, nuevo_lng, nuevo_direccion, nuevo_label } = ctx;
    if (!Number.isFinite(nuevo_lat) || !Number.isFinite(nuevo_lng)) {
      await clearState(phone);
      return '⚠️ Se perdió la ubicación. Mándamela de nuevo.';
    }
    const resultado = await guardarUbicacion(userId, txt, nuevo_lat, nuevo_lng, nuevo_direccion, nuevo_label);
    if (resultado.ok) {
      await clearState(phone);
      return `✅ Guardé "${txt}" en tu lista de lugares.`;
    }
    if (resultado.conflicto) {
      // El nombre nuevo también existe — volver al menú numerado.
      await saveState(phone, userId, 'location_conflict_resolution', {
        nuevo_lat, nuevo_lng, nuevo_direccion, nuevo_label,
        nombre_existente: resultado.conflicto.nombre,
        ubicacion_existente_id: resultado.conflicto.id
      }, 5);
      return mensajeConflictoUbicacion(resultado.conflicto.nombre);
    }
    return '⚠️ No pude guardar. Intenta de nuevo.';
  }

  // 3. Sin estado pero el texto se parece a una confirmación SI/NO/1/2.
  //    Buscamos el pago activo del usuario y lo procesamos.
  // Regex expandida — acepta dígitos, emojis 1️⃣/2️⃣, sí/si/listo/ok/pagué,
  // no/aplazar/después. Mensajes que no encajen y haya pago activo: pedimos
  // que aclare (solo si el msg es corto, para no interceptar comandos largos).
  const esSi = /^(s[ií]|1|1️⃣|listo|ok|pagu[eé]|ya\s+pagu[eé])\s*[.,!]?\s*$/i.test(lower);
  const esNo = /^(no|2|2️⃣|aplazar|despu[ée]s)\s*[.,!]?\s*$/i.test(lower);
  if ((esSi || esNo) && await anaEsperaRespuesta(phone)) return null;

  const pago = await pagoEnEspera(userId);
  if (!pago) return null; // No hay pago esperando → procesar como AI normal

  if (esSi) {
    const hoy = colombiaDateString();
    const { error } = await supabase.from('payments')
      .update({ status: 'pagado', fecha_pago: hoy })
      .eq('id', pago.id).eq('user_id', userId);
    if (error) { console.error('[whatsapp] confirm paid error:', error.message); return '⚠️ Error marcando como pagado.'; }
    return `✅ Marqué *${pago.nombre}* (${cop(pago.monto)}) como pagado hoy.`;
  }

  if (esNo) {
    await saveState(phone, userId, 'payment_date', { payment_id: pago.id, ...(facturaPendiente ? { factura: facturaPendiente } : {}) }, 60);
    return `OK, ¿para cuándo lo pospones? Dime la fecha (ej: "25 de mayo" o "el viernes").`;
  }

  // Cualquier otra cosa no es respuesta al pago: "ya hice lo del contador" o "agéndame
  // X" son pedidos normales, por cortos que sean. La IA los atiende, y el aviso del
  // pago vuelve a preguntar al día siguiente.
  return null;
}
