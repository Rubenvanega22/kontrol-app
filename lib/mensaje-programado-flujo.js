// /lib/mensaje-programado-flujo.js — la conversación por WhatsApp de un mensaje programado.
//
// Pregunta lo que falte, una cosa a la vez: a cuál contacto (si hay varios), el número
// (una sola vez, queda en contactos), qué le digo, a qué hora, am o pm, o si lo deja para
// mañana. Mientras pregunta usa whatsapp_state (awaiting='mensaje_programado', 10 min) y
// guarda el estado que hubiera antes (una factura, un comprobante) para devolverlo al final.
// Al terminar crea un evento tipo 'mensaje' en la Agenda; el aviso lo manda el cron.

const supabase = require('./supabase');
const M = require('./mensaje-programado');
const { colombiaDateString } = require('./datetime');

const ESPERA = 'mensaje_programado';
const TTL_MIN = 10;
const CANCELAR = /^(no|nop|nope|cancela|cancelar|cancelalo|cancélalo|d[eé]jalo|ol[vb][ií]dalo|nada|ya no)\s*[.!]*$/i;
const SI = /^(s[ií]|sip|dale|ok|okay|claro|de una|listo|bueno|perfecto|hag[aá]moslo)\b/i;
const NO_PROGRAME = '👍 Listo, no programé nada.';

const contactoCorto = c => ({ id: c.id, nombre: c.nombre, telefono: c.telefono });

async function contactosDe(userId) {
  const { data, error } = await supabase.from('contactos').select('id, nombre, telefono')
    .eq('user_id', userId).order('nombre');
  if (error) { console.error('[mensaje] contactos error:', error.message); return null; }
  return data || [];
}

async function guardarEspera(phone, userId, ctx) {
  const expires_at = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
  const { error } = await supabase.from('whatsapp_state').upsert(
    { phone, user_id: userId, awaiting: ESPERA, context: ctx, expires_at }, { onConflict: 'phone' });
  if (error) console.error('[mensaje] guardar estado error:', error.message);
  return !error;
}

// Cierra la conversación y devuelve el estado que había antes, si sigue vigente.
async function terminar(phone, userId, ctx) {
  await supabase.from('whatsapp_state').delete().eq('phone', phone).eq('awaiting', ESPERA);
  const p = ctx?.previo;
  if (p?.awaiting && p.expires_at && new Date(p.expires_at) > new Date()) {
    const { error } = await supabase.from('whatsapp_state').upsert(
      { phone, user_id: userId, awaiting: p.awaiting, context: p.context, expires_at: p.expires_at }, { onConflict: 'phone' });
    if (error) console.error('[mensaje] devolver estado anterior error:', error.message);
  }
}

async function preguntar(phone, userId, ctx, paso, texto) {
  ctx.paso = paso;
  if (!(await guardarEspera(phone, userId, ctx))) return '⚠️ No pude seguir con el mensaje. Pídemelo otra vez.';
  return texto;
}

async function crearEvento(userId, phone, ctx, fecha, hora) {
  const { error } = await supabase.from('events').insert({
    user_id: userId, titulo: `Mensaje a ${ctx.contacto.nombre}`.slice(0, 120), fecha, hora,
    nota: ctx.texto, tipo: 'mensaje', contacto_id: ctx.contacto.id
  });
  if (error) {
    console.error('[mensaje] crear evento error:', error.message);
    return preguntar(phone, userId, ctx, ctx.paso || 'hora', '❌ No pude guardarlo. Dime otra vez la hora.');
  }
  await terminar(phone, userId, ctx);
  return `✅ ${M.cuandoTexto(fecha)} a las ${M.hora12(hora)} te aviso para escribirle a ${ctx.contacto.nombre}:\n«${ctx.texto}»\n\n` +
    'Te llega un enlace que abre su chat con el mensaje ya escrito. Lo ves en la Agenda, donde puedes cambiarlo o borrarlo.';
}

// Revisa qué falta y lo pregunta; si no falta nada, guarda.
async function avanzar(userId, phone, ctx, prefijo = '') {
  const con = async r => (prefijo ? `${prefijo}\n\n${await r}` : r);
  if (!ctx.contacto) {
    if (ctx.opciones?.length > 1) {
      const lista = ctx.opciones.map((c, i) => `${i + 1}. ${c.nombre}`).join('\n');
      return con(preguntar(phone, userId, ctx, 'elegir', `Tienes varios contactos con "${ctx.nombre}":\n${lista}\n\n¿A cuál le escribo? Responde con el número o el nombre.`));
    }
    return con(preguntar(phone, userId, ctx, 'telefono', `No tengo el número de ${ctx.nombre}. ¿Cuál es? Por ejemplo: 300 123 4567`));
  }
  const nombre = ctx.contacto.nombre;
  if (!ctx.texto) return con(preguntar(phone, userId, ctx, 'texto', `¿Qué le digo a ${nombre}?`));

  const r = M.resolverMomento(ctx.hora, ctx.fecha);
  if (r.ahora) {
    await terminar(phone, userId, ctx);
    return con(`💬 Toca para escribirle a ${nombre} con el mensaje listo:\n${M.enlaceWa(ctx.contacto.telefono, ctx.texto)}`);
  }
  if (r.pregunta === 'hora') return con(preguntar(phone, userId, ctx, 'hora', `¿A qué hora te aviso para escribirle a ${nombre}?`));
  if (r.pregunta === 'ampm') {
    ctx.ampm = { h: r.h, m: r.m, fecha: r.fecha };
    return con(preguntar(phone, userId, ctx, 'ampm', `¿${r.h}:${String(r.m).padStart(2, '0')} de la mañana o de la tarde?`));
  }
  if (r.pregunta === 'manana') {
    ctx.propuesta = { fecha: r.fecha, hora: r.hora };
    return con(preguntar(phone, userId, ctx, 'manana', `Las ${M.hora12(r.hora)} de hoy ya pasaron. ¿Te aviso mañana a las ${M.hora12(r.hora)}? Responde sí o no, o dime otra hora.`));
  }
  return con(crearEvento(userId, phone, ctx, r.fecha, r.hora));
}

/**
 * Si el mensaje pide escribirle a alguien, arranca la conversación y devuelve la respuesta.
 * null = no es un mensaje programado (sigue el flujo normal).
 * @param estadoActual  fila vigente de whatsapp_state (se guarda para devolverla al final).
 */
async function iniciarMensajeProgramado(userId, phone, texto, estadoActual) {
  const d = M.detectarMensajeProgramado(texto);
  if (!d || !d.nombre) return null;
  const contactos = await contactosDe(userId);
  if (contactos === null) return '❌ No pude revisar tus contactos. Intenta de nuevo.';
  const opciones = M.elegirContacto(contactos, d.nombre);
  // Ana es la asistente: "dile a Ana…" solo es para una persona si hay un contacto Ana.
  if (M.norm(d.nombre).split(' ')[0] === 'ana' && !opciones.length) return null;
  console.log('[mensaje] pedido detectado; contactos que coinciden=', opciones.length);

  const hoy = colombiaDateString();
  const ctx = {
    nombre: d.nombre,
    texto: d.texto || null,
    hora: M.horaDelTexto(d.control),
    fecha: M.fechaDelTexto(d.control, hoy),
    contacto: opciones.length === 1 ? contactoCorto(opciones[0]) : null,
    opciones: opciones.length > 1 ? opciones.slice(0, 6).map(contactoCorto) : null,
    previo: estadoActual?.expires_at && estadoActual.awaiting !== ESPERA
      ? { awaiting: estadoActual.awaiting, context: estadoActual.context, expires_at: estadoActual.expires_at }
      : null
  };
  return avanzar(userId, phone, ctx);
}

async function guardarContacto(userId, nombre, telefono) {
  const { data, error } = await supabase.from('contactos')
    .insert({ user_id: userId, nombre: nombre.slice(0, 60), telefono }).select('id, nombre, telefono').single();
  if (!error) return data;
  if (error.code === '23505') {
    // Ya existía con ese nombre (otra conversación lo guardó): se actualiza el número.
    const { data: upd, error: e2 } = await supabase.from('contactos').update({ telefono })
      .eq('user_id', userId).ilike('nombre', nombre).select('id, nombre, telefono');
    if (!e2 && upd?.length) return upd[0];
  }
  console.error('[mensaje] guardar contacto error:', error.message);
  return null;
}

/**
 * Respuesta mientras la conversación espera algo. null = el mensaje no era para ella
 * (se cierra, se devuelve el estado anterior y sigue el flujo normal).
 */
async function responderMensajeProgramado(userId, phone, texto, estado) {
  const ctx = { ...(estado?.context || {}) };
  const t = String(texto || '').trim();
  const salir = async () => { await terminar(phone, userId, ctx); return null; };

  if (ctx.paso !== 'texto' && CANCELAR.test(t)) { await terminar(phone, userId, ctx); return NO_PROGRAME; }
  if (ctx.paso === 'texto' && /^(cancela|cancelar|cancelalo|cancélalo|ol[vb][ií]dalo)\s*[.!]*$/i.test(t)) {
    await terminar(phone, userId, ctx); return NO_PROGRAME;
  }

  if (ctx.paso === 'elegir') {
    const opciones = ctx.opciones || [];
    const n = t.match(/^(\d)\b/);
    const elegidos = n ? [opciones[Number(n[1]) - 1]].filter(Boolean) : M.elegirContacto(opciones, t);
    if (elegidos.length !== 1) {
      if (!n && t.split(/\s+/).length > 4) return salir();
      return preguntar(phone, userId, ctx, 'elegir', `¿A cuál? Responde con el número:\n${opciones.map((c, i) => `${i + 1}. ${c.nombre}`).join('\n')}`);
    }
    ctx.contacto = elegidos[0];
    ctx.opciones = null;
    return avanzar(userId, phone, ctx);
  }

  if (ctx.paso === 'telefono') {
    const tel = M.normalizarTelefono(t);
    if (!tel) {
      if (!/\d{3}/.test(t)) return salir();
      return preguntar(phone, userId, ctx, 'telefono', 'Ese número no se ve completo. Mándamelo con los 10 dígitos, por ejemplo 300 123 4567, o con el + si es de otro país.');
    }
    const c = await guardarContacto(userId, ctx.nombre, tel);
    if (!c) return preguntar(phone, userId, ctx, 'telefono', '❌ No pude guardar el número. Mándamelo otra vez.');
    ctx.contacto = contactoCorto(c);
    return avanzar(userId, phone, ctx, `📇 Guardé a ${c.nombre} en tus contactos.`);
  }

  if (ctx.paso === 'texto') {
    ctx.texto = t.replace(/^["“«']+|["”»']+$/g, '').trim().slice(0, 1000);
    if (!ctx.texto) return preguntar(phone, userId, ctx, 'texto', `¿Qué le digo a ${ctx.contacto?.nombre || ctx.nombre}?`);
    return avanzar(userId, phone, ctx);
  }

  if (ctx.paso === 'hora') {
    const hora = M.horaDelTexto(t) || (/^\d{1,2}([:.]\d{2})?\s*(am|pm|a\.?\s?m\.?|p\.?\s?m\.?)?\s*$/i.test(t) ? M.horaDelTexto(`a las ${t}`) : null);
    const fecha = M.fechaDelTexto(t);
    if (!hora) {
      if (!/\d/.test(t) && !fecha) return salir();
      if (fecha) ctx.fecha = fecha;
      return preguntar(phone, userId, ctx, 'hora', 'No entendí la hora. Dime por ejemplo "a las 6:05 pm" o "en 20 minutos".');
    }
    ctx.hora = hora;
    if (fecha) ctx.fecha = fecha;
    return avanzar(userId, phone, ctx);
  }

  if (ctx.paso === 'ampm') {
    const b = M.norm(t);
    const periodo = /\b(manana|madrugada|am|a m)\b/.test(b) ? 'am' : /\b(tarde|noche|pm|p m)\b/.test(b) ? 'pm' : null;
    if (!periodo) {
      const otra = M.horaDelTexto(t);
      if (!otra) return preguntar(phone, userId, ctx, 'ampm', 'Responde "de la mañana" o "de la tarde".');
      ctx.hora = otra;
      return avanzar(userId, phone, ctx);
    }
    ctx.hora = { h: ctx.ampm.h, m: ctx.ampm.m, periodo };
    ctx.fecha = ctx.ampm.fecha;
    return avanzar(userId, phone, ctx);
  }

  if (ctx.paso === 'manana') {
    if (SI.test(t)) {
      const [h, m] = ctx.propuesta.hora.split(':').map(Number);
      ctx.hora = { h, m, periodo: h >= 12 ? 'pm' : 'am' };
      ctx.fecha = ctx.propuesta.fecha;
      return avanzar(userId, phone, ctx);
    }
    const otra = M.horaDelTexto(t);
    if (otra) {
      ctx.hora = otra;
      ctx.fecha = M.fechaDelTexto(t) || null;
      return avanzar(userId, phone, ctx);
    }
    return salir();
  }

  return salir();
}

module.exports = { ESPERA, iniciarMensajeProgramado, responderMensajeProgramado };
