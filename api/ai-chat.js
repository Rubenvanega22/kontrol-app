// /api/ai-chat.js — Claude + Mem0 memoria profesional
const supabase = require('../lib/supabase');
const { leerListaDeImagen, leerFacturaDeImagen, interpretarFactura } = require('../lib/lista-foto');
const { colombiaDateString, colombiaDateLongEs, colombiaTimeString, colombiaDateParts } = require('../lib/datetime');
const { esTemprano, resolverAviso, fechaHoraColombia, momentoAviso, eventoADate } = require('../lib/avisos-evento');
const { preguntaAntesDeGuardar, horasDelPedido, avisoDelPedido, fechasDelPedido } = require('../lib/evento-completo');
const { MEDIOS, medioDelTexto } = require('../lib/medio-pago');

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_BASE = 'https://api.mem0.ai/v1';

// ═══ MEM0 — guardar memoria ═══
async function mem0Guardar(userId, mensajes) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${MEM0_API_KEY}`
      },
      body: JSON.stringify({
        messages: mensajes,
        user_id: userId,
        output_format: 'v1.1'
      })
    });
    const data = await res.json();
    return data;
  } catch(e) {
    console.error('Mem0 guardar error:', e.message);
    return null;
  }
}

// ═══ MEM0 — buscar memorias relevantes ═══
async function mem0Buscar(userId, query) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/search/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${MEM0_API_KEY}`
      },
      body: JSON.stringify({
        query,
        user_id: userId,
        limit: 20,
        output_format: 'v1.1'
      })
    });
    const data = await res.json();
    return (data.results || []).map(m => m.memory).join('\n');
  } catch(e) {
    console.error('Mem0 buscar error:', e.message);
    return '';
  }
}

// ═══ MEM0 — traer todas las memorias del usuario ═══
async function mem0TraerTodo(userId) {
  try {
    const res = await fetch(`${MEM0_BASE}/memories/?user_id=${userId}&output_format=v1.1`, {
      headers: { 'Authorization': `Token ${MEM0_API_KEY}` }
    });
    const data = await res.json();
    return (data.results || []).map(m => m.memory).join('\n');
  } catch(e) {
    console.error('Mem0 traer error:', e.message);
    return '';
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [], imagen_base64, voz = false } = req.body;

  // Este endpoint usa la service key, así que el usuario nunca se toma de lo que
  // diga el cliente: sale de su token. Solo /api/whatsapp (autenticado con
  // CRON_SECRET) puede indicar el user_id, que ya resolvió por el teléfono.
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  let user_id = null;
  if (token && process.env.CRON_SECRET && token === process.env.CRON_SECRET) {
    user_id = req.body.user_id || null;
  } else if (token) {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error) user_id = data?.user?.id || null;
  }
  if (!user_id) return res.status(401).json({ error: 'Sesión no válida. Recarga la página.' });

  if (!message && !imagen_base64) return res.status(400).json({ error: 'Mensaje requerido' });

  // Foto de una lista: solo se lee. Sin el asistente ni sus acciones, lo escrito en la
  // foto no puede crear pagos ni borrar nada.
  if (req.body.modo === 'foto_factura') {
    if (!imagen_base64) return res.status(400).json({ error: 'Falta la foto' });
    try {
      const factura = interpretarFactura(await leerFacturaDeImagen(imagen_base64, colombiaDateString()));
      return res.json({ ok: true, factura });
    } catch (e) {
      console.error('[ai-chat] foto_factura:', e.message);
      return res.status(502).json({ error: 'No se pudo leer la factura. Intenta de nuevo.' });
    }
  }
  if (req.body.modo === 'foto_listado') {
    if (!imagen_base64) return res.status(400).json({ error: 'Falta la foto' });
    try {
      const respuesta = await leerListaDeImagen(imagen_base64);
      return res.json({ ok: true, respuesta });
    } catch (e) {
      console.error('[ai-chat] foto_listado:', e.message);
      return res.status(502).json({ error: 'No se pudo leer la foto. Intenta de nuevo.' });
    }
  }

  try {
    // 1. Contexto financiero en tiempo real
    const contexto = await buildContexto(user_id);

    // 2. Buscar memorias en Mem0 con timeout de 5 segundos
    let memoria = 'Sin memoria previa.';
    try {
      const memPromise = mem0TraerTodo(user_id);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
      memoria = await Promise.race([memPromise, timeout]) || 'Sin memoria previa.';
    } catch(e) {
      console.log('Mem0 no disponible, continuando sin memoria');
    }

    // 3. Construir system prompt con contexto + memoria
    let systemPrompt = buildSystemPrompt(contexto, memoria);
    if (voz) {
      systemPrompt = `MODO VOZ: responde máximo 2 oraciones cortas y directas.\n\n${systemPrompt}`;
    }
    const fechasDichas = fechasDelPedido(message, history).filter(f => f.fecha);
    if (fechasDichas.length) {
      systemPrompt += `\n\n⚠️ FECHAS YA CALCULADAS EN ESTE PEDIDO (son definitivas, no las recalcules):\n${fechasDichas.map(f => `• "${f.dicho}" = ${f.fecha}, ${colombiaDateLongEs(new Date(`${f.fecha}T12:00:00-05:00`)).split(',')[0]}`).join('\n')}`;
    }
    const dichas = horasDelPedido(message, history);
    if (dichas.length) {
      systemPrompt += `\n\n⚠️ HORAS YA INTERPRETADAS EN ESTE PEDIDO (son definitivas, ver regla 11B):\n${dichas.map(d => `• "${d.dicho}" = ${d.hora}, UNA sola hora`).join('\n')}`;
    }

    // 4. Llamar al LLM — siempre Claude Haiku (fiabilidad sobre velocidad)
    //    Groq llama-3.1-8b no seguía consistentemente el formato [ACCION:...]
    let respuesta = await llamarClaude(systemPrompt, history, message, imagen_base64, voz ? 200 : 600);

    // Solo el resultado de una acción puede confirmar algo. Si el modelo dice "✅ Listo,
    // agendado" sin emitir ninguna, el usuario cree que quedó guardado y no es cierto.
    if (!imagen_base64 && afirmaHaberHecho(respuesta)) {
      console.warn('[ai-chat] confirmó sin acción; se reintenta');
      const correccion = `${systemPrompt}\n\n⚠️ CORRECCIÓN: tu respuesta anterior confirmó algo sin emitir ninguna [ACCION:...], así que NO se guardó nada. Si el usuario pide crear algo, emite la acción. Si falta un dato, pregúntalo sin decir que ya está hecho.`;
      respuesta = await llamarClaude(correccion, history, message, null, voz ? 200 : 600);
      if (afirmaHaberHecho(respuesta)) {
        console.warn('[ai-chat] volvió a confirmar sin acción');
        respuesta = 'No alcancé a guardar eso. ¿Me lo repites con el qué, el día y la hora?';
      }
    }

    // Antes de guardar: un evento sin qué, día u hora, dos iguales que no pidió, o una hora
    // distinta a la que dijo, se preguntan en vez de crearse.
    const pregunta = preguntaAntesDeGuardar({ mensaje: message, respuesta, history, conImagen: !!imagen_base64 });
    if (pregunta) {
      console.warn('[ai-chat] evento incompleto o en duda; se pregunta en vez de guardar');
      respuesta = pregunta;
    }

    const respuestaLimpia = respuesta
      .replace(/\[ACCION:[^\]]+\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 5. Ejecutar acciones (registrar gastos, eventos, etc.)
    const accionMatches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
    const accionesIntencion = accionMatches.length;
    console.log('[ai-chat] markers [ACCION:] encontrados:', accionesIntencion);
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id, {
      avisoDicho: avisoDelPedido(message, history),
      fechaDicha: fechasDichas.length === 1 ? fechasDichas[0].fecha : null,
      medioDicho: medioDelTexto(message)
    });
    console.log('[ai-chat] acciones realmente ejecutadas:', acciones.length, acciones.map(a => a.accion));

    // 5b. Override determinístico para acciones de ubicación.
    // Claude tiende a parafrasear ("perfecto, encontré...") y romper el formato
    // del link Maps. Para get_/listar_/borrar_/guardar_ubicacion construimos
    // la respuesta nosotros y saltamos la verification pass.
    let respuestaFinal = respuestaLimpia;
    const partesUbicacion = [];
    const partesEvento = [];
    for (const a of acciones) {
      if (a.accion === 'get_ubicacion' && a.encontrado) {
        partesUbicacion.push(`📍 ${a.nombre}\n${a.url}`);
      } else if (a.accion === 'get_ubicacion' && !a.encontrado) {
        partesUbicacion.push(`No encontré "${a.nombre_buscado}" en tu lista.`);
      } else if (a.accion === 'listar_ubicaciones') {
        if (a.count === 0) {
          partesUbicacion.push('No tienes lugares guardados todavía.');
        } else {
          const plural = a.count > 1;
          partesUbicacion.push(`Tienes ${a.count} lugar${plural ? 'es' : ''} guardado${plural ? 's' : ''}:\n${a.nombres.map(n => `• ${n}`).join('\n')}`);
        }
      } else if (a.accion === 'borrar_ubicacion' && a.encontrado) {
        partesUbicacion.push(`✅ Borré "${a.nombre}" de tu lista.`);
      } else if (a.accion === 'borrar_ubicacion' && !a.encontrado) {
        partesUbicacion.push(`No encontré "${a.nombre_buscado}" en tu lista.`);
      } else if (a.accion === 'guardar_ubicacion' && a.conflicto) {
        partesUbicacion.push(`⚠️ Ya tienes "${a.nombre}" guardada. Pídeme borrarla primero o usa otro nombre.`);
      } else if (a.accion === 'guardar_ubicacion' && a.id) {
        partesUbicacion.push(`✅ Guardé "${a.nombre}".\n${a.url}`);
      // BUG 2/3: respuesta DETERMINÍSTICA para eventos — el ✅ solo si el insert
      // se confirmó, y SIEMPRE con día + hora exacta + qué. Salta la verification pass.
      } else if (a.accion === 'evento' && a.error === 'sin_hora') {
        partesEvento.push('¿A qué hora?');
      } else if (a.accion === 'evento' && a.ok && !a.aviso) {
        const pasado = a.aviso_pasado ? ' Esa hora de aviso ya pasó.' : '';
        const pregunta = a.temprano
          ? `¿Te aviso como siempre (${a.noche_vigente ? 'el día anterior a las 8 pm y 1 hora antes' : '1 hora antes'}) o a otra hora?`
          : '¿Te aviso como siempre o a otra hora?';
        partesEvento.push(`✅ Listo, agendé ${a.titulo} para ${formatearCuando(a.fecha, a.hora)}.${pasado} ${pregunta}`);
      } else if (a.accion === 'evento' && a.ok && a.aviso.fecha === a.fecha && a.aviso.hora === a.hora) {
        partesEvento.push(`✅ Listo, te aviso ${formatearCuando(a.fecha, a.hora)} sobre ${a.titulo}.`);
      } else if (a.accion === 'evento' && a.ok) {
        partesEvento.push(`✅ Listo, agendé ${a.titulo} para ${formatearCuando(a.fecha, a.hora)}. Te aviso ${formatearCuando(a.aviso.fecha, a.aviso.hora)}.`);
      } else if (a.accion === 'aviso_evento') {
        if (a.ok && a.aviso) partesEvento.push(`✅ Listo, te aviso de ${a.titulo} ${formatearCuando(a.aviso.fecha, a.aviso.hora)}.`);
        else if (a.ok && a.temprano) partesEvento.push(`✅ Listo, de ${a.titulo} te aviso ${a.noche_vigente ? 'el día anterior a las 8 pm y 1 hora antes' : '1 hora antes'}.`);
        else if (a.ok) partesEvento.push(`✅ Listo, de ${a.titulo} te aviso como siempre: en el resumen de las 8 am, 1 hora antes y 15 minutos antes.`);
        else if (a.error === 'aviso_pasado') partesEvento.push('❌ Esa hora de aviso ya pasó. ¿Te aviso como siempre o a otra hora?');
        else if (a.error === 'hora_invalida') partesEvento.push('No entendí cuándo avisarte. ¿Te aviso como siempre o a otra hora?');
        else if (a.error === 'no_encontrado') partesEvento.push('No encontré ese evento en tu agenda.');
        else partesEvento.push('❌ Hubo un error guardando. Por favor intenta de nuevo.');
      } else if (a.accion === 'evento' && a.error === 'sin_fecha') {
        partesEvento.push(a.titulo ? '¿Para qué día?' : '¿Qué quieres agendar?');
      } else if (a.accion === 'evento' && a.error === 'fecha_pasada') {
        partesEvento.push('❌ No lo agendé porque esa fecha ya pasó. ¿Para qué día lo dejo?');
      } else if (a.accion === 'evento' && a.error === 'hora_pasada') {
        partesEvento.push('❌ Esa hora ya pasó. ¿Para qué hora te aviso?');
      } else if (a.accion === 'evento' && a.error === 'db') {
        partesEvento.push('❌ Hubo un error guardando. Por favor intenta de nuevo.');
      } else if (a.accion === 'recordatorio' && a.error === 'db') {
        partesEvento.push('❌ Hubo un error guardando. Por favor intenta de nuevo.');
      } else if (a.accion === 'recordatorio' && a.error === 'sin_titulo') {
        partesEvento.push('❌ No anoté nada porque me faltó el qué. ¿Qué quieres que anote?');
      } else if (a.accion === 'recordatorio' && a.ok) {
        const valor = a.valor ? ` por ${fmtValorExacto(a.valor)}` : '';
        const aviso = a.recordar_fecha
          ? `Te aviso ${formatearDia(a.recordar_fecha)}${a.recordar_fecha === colombiaDateString() ? '' : ' a las 8 am'} por WhatsApp.`
          : 'Queda guardado como registro, sin aviso.';
        partesEvento.push(`✅ Anoté "${a.detalle}"${valor}. ${aviso}`);
      } else if (a.accion === 'buscar_recordatorio') {
        partesEvento.push(textoBusquedaRecordatorios(a));
      } else if (a.accion === 'desmarcar_recordatorio') {
        if (a.ok) partesEvento.push(`↩ Listo, "${a.titulo}" ya no está marcado como hecho.`);
        else if (a.error === 'no_hecho') partesEvento.push(`"${a.titulo}" no estaba marcado como hecho.`);
        else if (a.error === 'varios') partesEvento.push(`Encontré varios hechos:\n${a.titulos.map(t => `• ${t}`).join('\n')}\n\n¿Cuál desmarco? Dime una palabra que lo distinga.`);
        else if (a.error === 'no_encontrado') partesEvento.push(`No encontré ningún recordatorio sobre "${a.consulta}".`);
        else partesEvento.push('❌ No pude desmarcarlo. Intenta de nuevo.');
      } else if (a.accion === 'marcar_recordatorio_hecho') {
        if (a.ok) partesEvento.push(`✅ Marqué "${a.titulo}" como hecho.`);
        else if (a.error === 'ya_hecho') partesEvento.push(`"${a.titulo}" ya estaba marcado como hecho.`);
        else if (a.error === 'varios') partesEvento.push(`Encontré varios pendientes:\n${a.titulos.map(t => `• ${t}`).join('\n')}\n\n¿Cuál hiciste? Dime una palabra que lo distinga.`);
        else if (a.error === 'no_encontrado') partesEvento.push(`No encontré ningún recordatorio sobre "${a.consulta}".`);
        else partesEvento.push('❌ No pude marcarlo. Intenta de nuevo.');
      // Listados — respuesta determinística (✅ solo si la operación se confirmó).
      } else if (a.accion === 'lista' && a.op === 'creada') {
        const n = (a.items || []).length;
        partesEvento.push(`✅ Listo, creé el listado "${a.titulo}"${n ? ` con ${n} ${n === 1 ? 'ítem' : 'ítems'}` : ''}.`);
      } else if (a.accion === 'lista' && a.op === 'item_agregado') {
        partesEvento.push(`✅ Agregué "${a.item}" a tu listado "${a.titulo}".`);
      } else if (a.accion === 'lista' && a.op === 'item_marcado') {
        partesEvento.push(`✅ Marqué "${a.item}" en "${a.titulo}".`);
      } else if (a.accion === 'lista' && a.op === 'depurada') {
        partesEvento.push(`🧹 Depuré "${a.titulo}": quité ${a.borrados} ${a.borrados === 1 ? 'ítem marcado' : 'ítems marcados'}.`);
      } else if (a.accion === 'lista' && a.error === 'no_encontrada') {
        partesEvento.push(`❌ No encontré un listado llamado "${a.titulo}". ¿Quieres que lo cree?`);
      } else if (a.accion === 'lista' && a.error === 'item_no_encontrado') {
        partesEvento.push(`❌ No encontré "${a.item}" en "${a.titulo}".`);
      } else if (a.accion === 'lista' && a.error === 'sin_titulo') {
        partesEvento.push('❌ ¿Cómo quieres que se llame el listado?');
      } else if (a.accion === 'lista' && a.error === 'sin_item') {
        partesEvento.push('❌ ¿Qué ítem quieres agregar?');
      } else if (a.accion === 'lista' && a.error === 'db') {
        partesEvento.push('❌ Hubo un error con el listado. Intenta de nuevo.');
      // Borrado masivo — 2 pasos con confirmación determinística.
      } else if (a.accion === 'borrado_masivo' && a.fase === 'preguntar') {
        const c = a.counts || {};
        const total = Object.values(c).reduce((s, n) => s + n, 0);
        if (total === 0) {
          partesEvento.push('No hay nada que borrar ahí — ya está vacío.');
        } else {
          const lineas = [];
          if ('agenda' in c)        lineas.push(`• ${c.agenda} evento(s) en Agenda`);
          if ('pagos' in c)         lineas.push(`• ${c.pagos} pago(s)`);
          if ('listados' in c)      lineas.push(`• ${c.listados} listado(s)`);
          if ('recordatorios' in c) lineas.push(`• ${c.recordatorios} recordatorio(s)`);
          partesEvento.push(`⚠️ ¿Estás seguro? Voy a borrar:\n${lineas.join('\n')}\n\nResponde *SÍ* para confirmar, o *cancelar* para dejar todo intacto.`);
        }
      } else if (a.accion === 'borrado_masivo' && a.fase === 'confirmado') {
        const c = a.counts || {};
        const total = Object.values(c).reduce((s, n) => s + n, 0);
        partesEvento.push(a.alcance === 'borrar_todo'
          ? `🧹 Listo, borré todo (${total} elemento(s)). Mes nuevo comenzando.`
          : `🧹 Listo, borré ${total} elemento(s).`);
      }
    }

    if (partesUbicacion.length > 0) {
      respuestaFinal = partesUbicacion.join('\n\n');
    } else if (partesEvento.length > 0) {
      respuestaFinal = partesEvento.join('\n\n');
    } else if (accionesIntencion > 0) {
      if (acciones.length === 0) {
        respuestaFinal = 'No se pudo ejecutar el cambio.';
      } else if (!voz) {
        // En modo voz no hacemos segunda llamada para mantener latencia baja
        try {
          const verifSys = `Eres Ana, la asistente personal de Kontrol. Recibes el resultado REAL de acciones ejecutadas en la base de datos. Confirma al usuario en MÁXIMO 2 LÍNEAS exactamente lo que se hizo, basándote SOLO en los datos del array. No inventes. Si el array está vacío o algún campo dice error, di "No se pudo ejecutar el cambio". Sin emojis salvo ✅. Español colombiano cálido.`;
          const verifUser = `Mi respuesta intencional fue: "${respuestaLimpia}"\n\nAcciones REALMENTE ejecutadas (JSON): ${JSON.stringify(acciones)}\n\nConfirma al usuario.`;
          const verif = await llamarClaude(verifSys, [], verifUser, null, 200);
          const verifLimpia = (verif || '').replace(/\[ACCION:[^\]]+\]/g, '').trim();
          if (verifLimpia) respuestaFinal = verifLimpia;
        } catch (e) {
          console.error('Verificación falló:', e.message);
        }
      }
    }

    // 6. Guardar en Mem0 en segundo plano — no bloquea la respuesta
    mem0Guardar(user_id, [
      { role: 'user', content: message },
      { role: 'assistant', content: respuestaFinal }
    ]).catch(e => console.log('Mem0 guardar falló silenciosamente:', e.message));

    // WhatsApp pregunta el medio de un pago marcado sin él.
    const sinMedio = acciones.find(a => a.accion === 'marcar_pago_pagado' && a.medio === 'sin decir');
    return res.json({ ok: true, respuesta: respuestaFinal, acciones,
      ...(sinMedio ? { pago_sin_medio: { id: sinMedio.id, nombre: sinMedio.nombre } } : {}) });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ¿La respuesta dice que algo quedó hecho sin traer ninguna acción?
function afirmaHaberHecho(texto) {
  if (/\[ACCION:/.test(texto)) return false;
  // Solo afirmaciones de haber actuado. "Tienes 3 lugares guardados" o una lista de
  // ayuda con ✅ son respuestas normales y no deben reintentarse.
  const t = texto.trim();
  return t.startsWith('✅') || /(^|[\s,.!¡])(listo|agendé|registré|guardé|anoté|creé)(?=$|[\s,.!:;])/i.test(t);
}

// ═══ CONTEXTO: pagos, agenda, listados, recordatorios y lugares ═══
async function buildContexto(userId) {
  const [
    { data: pagos },
    { data: eventos },
    { data: recordatorios },
    { data: ubicaciones }
  ] = await Promise.all([
    supabase.from('payments').select('*').eq('user_id', userId).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', userId)
      .gte('fecha', colombiaDateString()).order('fecha').limit(30),
    supabase.from('reminders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(60),
    supabase.from('ubicaciones').select('id, nombre, latitud, longitud').eq('user_id', userId).order('nombre')
  ]);

  return {
    pagos: pagos || [],
    eventos: eventos || [],
    recordatorios: recordatorios || [],
    ubicaciones: ubicaciones || []
  };
}

// ═══ SYSTEM PROMPT ═══
function buildSystemPrompt(ctx, memoria) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  // Fecha y hora SIEMPRE en zona Colombia. Sin esto, después de 7pm Col
  // (medianoche UTC), Claude veía la fecha de UTC y respondía "hoy es mañana".
  const hoy = colombiaDateLongEs();
  const hora = colombiaTimeString();

  // Fechas ya resueltas: el modelo se equivoca menos que calculando "mañana" o "el viernes".
  const proximosDias = [...Array(8).keys()].slice(1).map(i => {
    const d = new Date(Date.now() + i * 24 * 3600 * 1000);
    const dia = colombiaDateLongEs(d).split(',')[0];
    return `${i === 1 ? `mañana (${dia})` : dia} = ${colombiaDateString(d)}`;
  }).join(' · ');

  return `Eres Ana, la asistente personal de Kontrol. Ayudas a consultar y registrar cosas en 4 módulos: Agenda, Listado, Pagos y Recordatorios.

Hablas sencillo, como una persona: respuestas cortas y naturales, sin tecnicismos ni explicaciones de más.

⚠️ NO eres asesora financiera. No das consejos de dinero, ahorro, inversión o presupuesto, ni analizas gastos. Kontrol tampoco lleva movimientos, cuentas, cajas, saldos, transferencias ni metas: si te piden algo de eso, dilo en una línea y ofrece lo que sí puedes hacer. Ignora las cifras de saldos o gastos que aparezcan en la memoria. Registrar un pago pendiente o anotar un valor sí es parte de tu trabajo.

🔒 CAJA FUERTE: las claves del usuario están cifradas y tú NO tienes acceso a ellas: no las ves ni sabes cuáles hay. Si te preguntan por una clave, contraseña o PIN, o por la Caja fuerte, responde en una línea que no puedes verlas y que están en la pestaña Recordatorios, hoja Caja. Nunca inventes ni deduzcas una. Si el usuario te escribe una clave, no la repitas, no la anotes en ningún lado ni emitas acciones con ella; dile que la guarde en la Caja fuerte.

HOY: ${hoy}
HORA actual (Colombia): ${hora}
PRÓXIMOS DÍAS: ${proximosDias}

═══ LO QUE SABES DEL USUARIO (memoria persistente) ═══
${memoria || 'Primera vez que hablas con este usuario — aprende todo lo posible.'}

═══ DATOS DEL USUARIO EN TIEMPO REAL ═══
Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} vence ${p.fecha_limite} [ID:${p.id}]`).join('\n') || 'ninguno'}

Eventos próximos:
${ctx.eventos.map(e => `• ${e.titulo} — ${e.fecha} ${e.hora||''}${e.nota ? ` (nota: ${e.nota})` : ''}${e.aviso_en ? ` (aviso: ${Object.values(fechaHoraColombia(new Date(e.aviso_en))).join(' ')})` : ''} [ID:${e.id}]`).join('\n') || 'ninguno'}

Recordatorios (notas sin ítems):
${ctx.recordatorios.filter(r => r.tipo === 'nota' || r.tipo === 'definicion').map(r => `• ${r.titulo}${r.recordar_fecha ? ` (aviso ${r.recordar_fecha})` : ''}${r.hecho ? ' (hecho)' : ''} [ID:${r.id}]`).join('\n') || 'ninguno'}

Listados (listas con ítems marcables — usa el título EXACTO):
${ctx.recordatorios.filter(r => r.tipo === 'listado' || r.tipo === 'lista').map(l => {
  const items = ((l.content && l.content.items) || []).map(it => `${it.done ? '✓' : '○'} ${it.text}`).join(', ');
  return `• "${l.titulo}" [ID:${l.id}]: ${items || '(vacío)'}`;
}).join('\n') || 'ninguno'}

Lugares guardados (ubicaciones del usuario):
${(ctx.ubicaciones || []).map(u => `• ${u.nombre}: https://maps.google.com/?q=${u.latitud},${u.longitud} [ID:${u.id}]`).join('\n') || 'ninguno'}

═══ ACCIONES INVISIBLES — úsalas al final de tu respuesta ═══

⚠️ FORMATO OBLIGATORIO Y EXACTO ⚠️
- Cada acción va en una línea APARTE al final del mensaje.
- Empieza con corchete abierto [ACCION: y termina con corchete cerrado ].
- Los campos van separados por el carácter pipe |  (NO uses comas, NO uses dos puntos).
- Los montos van en NÚMEROS PUROS sin separadores ni símbolos: 50000 (no 50.000, no $50.000, no "50 mil").
- NUNCA muestres el bloque [ACCION:...] al usuario en tu texto visible. El sistema lo lee y lo elimina.
- Si emites una acción, ESCRÍBELA TEXTUAL — el sistema la parsea con regex /\[ACCION:([^\]]+)\]/.

EJEMPLOS CORRECTOS (copia exactamente este formato):

Usuario: "agéndame pago luz $80.000 el 15 de junio"
Tu respuesta:
  ✅ Pago de luz por $80.000 agendado para el 15 de junio.
  [ACCION:pago|Luz|80000|2026-06-15]

EJEMPLOS INCORRECTOS (NO hagas esto):
  ❌ [ACCION: pago, Luz, 80000]            (usa pipe, no comas; sin espacios sobrantes)
  ❌ [ACCION:pago|Luz|$80.000|2026-06-15]  (monto sin símbolos ni puntos)
  ❌ ACCION:pago|Luz|80000|2026-06-15      (faltan los corchetes)

— Pagos
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:marcar_pago_pagado|ID|medio]
  medio: efectivo, tarjeta o nequi si el usuario lo dijo. Si no lo dijo, déjalo vacío y no lo preguntes: el sistema pregunta.
[ACCION:borrar_pago|ID]
— Eventos y recordatorios
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
  Título, día y hora son obligatorios (regla 10). Si falta uno, pregúntalo sin emitir la acción.
  Campos completos: [ACCION:evento|titulo|YYYY-MM-DD|HH:MM|nota|aviso]. La nota es opcional: si dio un detalle (dirección, qué llevar), va ahí.
  El último campo es CUÁNDO AVISAR, si ya lo dijo. Si no lo dijo, déjalo vacío y crea el evento igual: el sistema le pregunta después. Tú no preguntes cuándo avisar antes de crearlo. Valores:
    antes:MINUTOS       "2 horas antes" → antes:120 · "media hora antes" → antes:30
    hora:HH:MM          "a las 7 de la mañana" → hora:07:00
    dia_anterior:HH:MM  "el día anterior a las 6 pm" → dia_anterior:18:00
    dia_anterior        "el día anterior", sin hora
[ACCION:aviso_evento|ID|aviso]
  Cambia cuándo avisar de un evento ya creado, con el ID de "Eventos próximos" y los mismos valores.
  Si tu mensaje anterior preguntó "¿Te aviso como siempre o a otra hora?" y responde cuándo, emite esta acción. Si dice "a las 9" y no se sabe si es mañana o noche, pregunta cuál, sin emitirla.
  Si responde "como siempre", "no", "así está bien" o "como sea": [ACCION:aviso_evento|ID|siempre]
[ACCION:recordatorio|qué recordar|YYYY-MM-DD|valor|nota]
  Solo "qué recordar" es obligatorio; deja vacíos los demás campos que no dijo.
  Con fecha, ese día le llega aviso por WhatsApp a las 8 am. Sin fecha queda como registro.
[ACCION:buscar_recordatorio|palabra clave]
  Busca en todos sus recordatorios por texto y nota. Usa solo las palabras clave.
[ACCION:marcar_recordatorio_hecho|palabra clave]
  Marca como hecho el recordatorio que coincida. Usa solo las palabras clave.
[ACCION:desmarcar_recordatorio|palabra clave]
  Quita la marca de hecho. Usa solo las palabras clave.
[ACCION:borrar_evento|ID]
[ACCION:borrar_recordatorio|ID]
  Usa el ID del listado "Recordatorios" de arriba.
— Listados (listas con ítems marcables: mercado, tareas, etc.)
[ACCION:crear_lista|titulo|item1;item2;item3]
[ACCION:agregar_item|titulo_lista|item]
[ACCION:marcar_item|titulo_lista|item]   (marca un ítem como hecho ✓)
[ACCION:depurar_lista|titulo_lista]      (borra los ítems ya marcados ✓)
  Usa el título EXACTO de un listado de "Listados" de arriba. Si el usuario
  pide agregar/marcar en una lista que NO existe, créala con crear_lista.
— Borrado MASIVO (2 pasos, ver regla 14). Segundo campo: "preguntar" o "confirmar".
[ACCION:borrar_todo|preguntar]          (agenda + pagos + listados + recordatorios)
[ACCION:borrar_agenda|preguntar]        (solo eventos de agenda)
[ACCION:borrar_pagos|preguntar]
[ACCION:borrar_listados|preguntar]
[ACCION:borrar_recordatorios|preguntar]
  El sistema cuenta y pide confirmación. Solo cuando el usuario confirma, repite
  la MISMA acción con "confirmar" (ej. [ACCION:borrar_todo|confirmar]).
— Ubicaciones (lugares guardados del usuario)
[ACCION:guardar_ubicacion|nombre|lat|lng]
  Solo si el usuario te DA coordenadas explícitas en texto (raro). El
  flujo normal "manda pin de WhatsApp → bot guarda" lo maneja el webhook
  directamente sin pasar por esta acción.
[ACCION:get_ubicacion|nombre]
  Cuando el usuario pida una ubicación de su lista. Usa el nombre EXACTO
  del listado "Lugares guardados" de arriba. En tu respuesta visible
  formatea así (incluye el link de Maps que ya tienes en el listado):
    📍 [nombre]
    https://maps.google.com/?q=[lat],[lng]
[ACCION:listar_ubicaciones]
  Cuando el usuario pregunte qué lugares tiene guardados. Lista los
  nombres del listado de arriba en tu respuesta visible.
[ACCION:borrar_ubicacion|nombre]
  Cuando el usuario pida borrar una ubicación. Usa el nombre EXACTO del
  listado.

— Navegación (cambiar la pantalla activa de la app)
[ACCION:navegar|seccion]
  Secciones válidas: agenda, listado, pagos, recordatorios, ia
  Úsala cuando el usuario diga "llévame a X", "abre Y", "muéstrame Z", "ve a W".
  Ejemplos:
    "llévame a pagos"        → [ACCION:navegar|pagos]
    "abre la agenda"         → [ACCION:navegar|agenda]
    "muéstrame mis listas"   → [ACCION:navegar|listado]
    "ve a recordatorios"     → [ACCION:navegar|recordatorios]

═══ REGLAS ═══
1. NUNCA muestres [ACCION:...] — son invisibles
2. Crea pagos, eventos, listados y recordatorios INMEDIATAMENTE cuando los pidan con los datos completos
3. Confirma: "✅ Listo" con lo que hiciste
4. TODO lo que registres aparece visible en la app
5. Respuestas CORTAS — máx 3 líneas
6. Español colombiano, natural y cercano, sin rodeos
7. RECUERDAS TODO — úsalo naturalmente
8. Si te preguntan qué recuerdas → cuéntale todo
9. Ubicaciones: si el nombre que pide el usuario está en el listado "Lugares guardados" de arriba, emite [ACCION:get_ubicacion|nombre] y formatea la respuesta con el link que ya tienes en ese listado. Si NO está guardado (lugar público conocido), genera un link de Google Maps genérico así: https://maps.google.com/?q=[lugar+ciudad]. Ejemplo lugar guardado: "📍 Bodega Juan\nhttps://maps.google.com/?q=4.0847,-76.1956". Ejemplo lugar público: "📍 Éxito Jamundí\nhttps://maps.google.com/?q=Éxito+Jamundí+Valle+del+Cauca".
10. ⚠️ REGLA UNIVERSAL — HORA ESPECÍFICA SIEMPRE CREA EVENTO. SIN EXCEPCIONES.

    Si el usuario menciona una hora específica (7am, 14:00, "a las nueve")
    en CUALQUIER frase — sea para recordarle algo, agendar un pago, o un
    evento — la acción correcta es UNA SOLA y siempre es
    [ACCION:evento|titulo|YYYY-MM-DD|HH:MM]. Porque events es la única
    tabla con notificación a hora exacta (cron de 15min + 1h antes).

    NUNCA dupliques acciones por una sola intención. "Recuérdame pagar
    la factura a las 7am" es UNA cosa (un aviso a las 7am), NO dos
    (un aviso + un pago programado paralelo).

    Reglas por intención del usuario:

    A) Hay hora explícita → SIEMPRE [ACCION:evento|titulo|fecha|hora].
       UNA acción. Aplica aun si la frase incluye "pagar"/"pago"/"factura"
       — la hora gana sobre la palabra "pago".

    A2) ⚠️ TODO EVENTO NECESITA CUATRO COSAS: QUÉ es, qué DÍA, a qué HORA y CUÁNDO AVISAR.
       Si falta qué, día u hora, pregunta SOLO lo que falta, UNA cosa a la vez y en este orden:
       qué → día → hora. No emitas ninguna acción hasta tener esas tres.
       Con las tres, crea el evento de una. CUÁNDO AVISAR nunca lo preguntas tú: si lo dijo,
       va en el último campo; si no, queda vacío y el sistema pregunta después de guardar.
       Lo que ya dijo, en este mensaje o en anteriores de esta conversación, NO se vuelve a
       preguntar. Si responde varias cosas juntas ("mañana a las 2, avísame una hora antes"), tómalas todas.
       NUNCA inventes un día ni una hora: ni "hoy" ni 08:00 por defecto.
       El título debe decir de qué se trata, con los detalles que dio: "Cita con el
       dentista", "Reunión con Juan". NUNCA un título genérico como "Cita", "Reunión",
       "Evento" o "Algo": pregunta "¿De qué es la cita?". La nota es opcional: nunca la pidas.

    B) "Recuérdame X" / "Avísame X" sin día → pregunta "¿Para qué día?". Con día y sin
       hora → pregunta "¿A qué hora?". Siguen la regla A2.

    C) "Agéndame pago de X para el día Y" SIN hora → [ACCION:pago|...].
       El batch matutino de las 8am Col le avisará ese día.

    D) "Anota X" / "Apunta X" / "Guarda X" / "memo: Z" / definición, sin hora →
       [ACCION:recordatorio|X||valor|nota]. Ver regla 18.

    EJEMPLOS DETERMINANTES:

    Usuario: "agéndame una cita hoy a las 9 y 20"
    Tu respuesta:
      ¿De qué es la cita?
    Usuario: "con el dentista"
    Tu respuesta:
      ✅ Listo.
      [ACCION:evento|Cita con el dentista|<hoy>|09:20]
    (El día y la hora ya los había dicho: no se vuelven a preguntar.)

    Usuario: "agéndame cita con el odontólogo mañana"
    Tu respuesta:
      ¿A qué hora?
    (Solo falta la hora.)

    Usuario: "cita con el odontólogo mañana a las 2 pm, avísame una hora antes"
    Tu respuesta:
      ✅ Listo.
      [ACCION:evento|Cita con el odontólogo|<mañana>|14:00||antes:60]
    (Tiene las cuatro cosas: se crea sin preguntar nada.)

    Usuario: "una cita mañana a las 2 pm, avísame una hora antes"
    Tu respuesta:
      ¿De qué es la cita?
    (Solo falta el qué. Al responder, se crea con hora 14:00 y aviso antes:60.)

    Usuario: "recuérdame mañana a las 7am pagar la factura $170.000"
    Tu respuesta:
      ✅ Listo, te aviso mañana a las 7:00 am sobre el pago de $170.000.
      [ACCION:evento|Pagar factura $170.000|2026-05-28|07:00||hora:07:00]
    (UNA sola acción. NO crear [ACCION:pago] en paralelo. "Recuérdame a las X" pide el
    aviso a esa hora: X va también en el último campo, y no se pregunta cuándo avisar.)

    Usuario: "tengo vuelo mañana a las 5am"
    Tu respuesta:
      ✅ Listo.
      [ACCION:evento|Vuelo|<mañana>|05:00]
    (Dijo a qué hora es, no cuándo avisarle: último campo vacío, el sistema le pregunta.)
    Con "recuérdame" o "avísame" y una hora, esa hora también es la del aviso.

    Usuario: "recuérdame comprar pan"
    Tu respuesta:
      ¿Para qué día?
    (NO emites ninguna acción hasta tener qué, día y hora.)

    Usuario: "agéndame para mañana bañar a Luffy"
    Tu respuesta:
      ¿A qué hora?
    (Falta la hora. NO uses 08:00 ni ninguna otra hora inventada.)

    Usuario: "agéndame pago luz $80.000 el 15 de junio"
    Tu respuesta:
      ✅ Pago de luz por $80.000 agendado para el 15 de junio.
      [ACCION:pago|Luz|80000|2026-06-15]
    (Sin hora → batch matutino del día.)

    Usuario: "agéndame pago luz $80.000 el 15 de junio a las 9am"
    Tu respuesta:
      ✅ Te aviso el 15 de junio a las 9:00 am del pago de luz $80.000.
      [ACCION:evento|Pago luz $80.000|2026-06-15|09:00||]
    (Con hora → evento, NO pago. UNA acción.)

    Usuario: "anota lista de mercado: leche, pan, huevos"
    Tu respuesta:
      ✅ Lista guardada.
      [ACCION:recordatorio|Lista de mercado: leche, pan, huevos]
    (Sin hora — info pasiva, no se notifica.)

    Usuario: "recuérdame el lunes 9am reunión con Juan"
    Tu respuesta:
      ✅ Te aviso el lunes a las 9:00 am de la reunión con Juan.
      [ACCION:evento|Reunión con Juan|<fecha del lunes>|09:00||hora:09:00]
    (Resuelves "el lunes" a YYYY-MM-DD relativo a HOY.)

11. ⚠️ DURACIÓN RELATIVA → CALCULA HORA ABSOLUTA Y EMITE EVENT.

    Si el usuario dice "en X minutos", "en X horas", "en media hora",
    "en un rato" con tiempo aproximado, etc., **NUNCA** uses
    [ACCION:recordatorio]. Calcula la HORA absoluta basada en la
    "HORA actual (Colombia)" que tienes arriba y emite
    [ACCION:evento|titulo|YYYY-MM-DD|HH:MM] con esa hora calculada.

    Si el cálculo cruza medianoche, ajusta la fecha al día siguiente.

    EJEMPLOS:

    HORA actual = 14:30. Usuario: "recuérdame en 5 minutos tomar agua"
    Tu respuesta:
      ✅ Te aviso a las 14:35 que tomes agua.
      [ACCION:evento|Tomar agua|<hoy>|14:35||hora:14:35]

    HORA actual = 14:30. Usuario: "avísame en 2 horas hacer la llamada"
    Tu respuesta:
      ✅ Te aviso a las 16:30 sobre la llamada.
      [ACCION:evento|Hacer la llamada|<hoy>|16:30||hora:16:30]

    HORA actual = 23:50. Usuario: "recuérdame en 30 minutos cerrar la ventana"
    Tu respuesta:
      ✅ Te aviso a las 00:20 (ya cruzaste medianoche) que cierres la ventana.
      [ACCION:evento|Cerrar ventana|<mañana>|00:20||hora:00:20]
    (Cruza medianoche → fecha avanza al día siguiente. La hora calculada va también
    en el último campo, porque es la hora del aviso.)

    HORA actual = 14:30. Usuario: "en un rato me acuerdas comprar pan"
    Tu respuesta:
      ¿En cuánto tiempo? Dame los minutos exactos.
    (Frase vaga sin tiempo concreto → pregunta antes de actuar.)

11B. ⚠️ FORMAS DE DECIR LA HORA EN COLOMBIA. Son UNA sola hora, nunca dos eventos:
    "las 9 y 10" = 9:10
    "las 9 y media" = 9:30
    "las 9 y cuarto" = 9:15
    "un cuarto para las 10" = 9:45
    "5 para las 10" = 9:55
    "las 10 menos 5" = 9:55
    "las 10 menos cuarto" = 9:45
    "de 9 a 10" = un solo evento que empieza a las 9:00

    Crea DOS eventos solo si dijo claramente que son dos: "dos citas, a las 9 y a las 10",
    "una a las 9 y otra a las 10". Si hay duda, pregunta sin emitir ninguna acción.

    Usuario: "agéndame una cita con el dentista hoy a las 9 y 10"
    Tu respuesta:
      ✅ Listo.
      [ACCION:evento|Cita con el dentista|<hoy>|09:10]
    (UNA acción. NUNCA una a las 09:00 y otra a las 10:00.)

    Usuario: "hoy una cita con el dentista a las 9 y otra a las 10"
    Tu respuesta:
      ✅ Listo.
      [ACCION:evento|Cita con el dentista|<hoy>|09:00]
      [ACCION:evento|Cita con el dentista|<hoy>|10:00]

    Si corrige algo ya creado ("no, era a las 9:10"), borra lo equivocado con
    [ACCION:borrar_evento|ID] usando los ID de "Eventos próximos" y crea SOLO lo correcto.

12. ⚠️ INTENCIÓN: CREAR vs CONSULTAR (desambiguación de "agenda").

    "agenda" es AMBIGUA: puede ser el VERBO (crear algo) o el SUSTANTIVO
    (la pantalla de eventos). Decide así:

    VERBOS que indican CREAR → emite la acción correspondiente:
      recuérdame, recordame, agéndame, "agenda" + objeto + tiempo,
      programa, programame, "anota" + objeto + tiempo, "crea" + objeto.

    PREGUNTAS ("qué tengo", "qué eventos", "qué debo pagar") → responde con los
    datos, SIN crear nada (regla 20).
    Pedidos de VER LA PANTALLA (muéstrame, abre, "mi agenda" sola, "abre la agenda")
    → [ACCION:navegar|agenda] o la sección pedida, SIN crear nada.

    REGLA DE ORO: si el mensaje trae un OBJETO concreto Y un TIEMPO
    específico, prioriza CREAR sobre CONSULTAR.

    EJEMPLOS:
      "agenda"                               → [ACCION:navegar|agenda]   (consultar)
      "mi agenda"                            → [ACCION:navegar|agenda]   (consultar)
      "qué tengo esta semana"                → responde con sus eventos (regla 20)
      "agenda una cita médica mañana a las 10am" → [ACCION:evento|Cita médica|<mañana>|10:00]  (crear)
      "agéndame el dentista el viernes 3pm"  → [ACCION:evento|Dentista|<viernes>|15:00]        (crear)
    (En los de CREAR aplica la regla 10: hora explícita → evento, UNA acción.)

13. ⚠️ RUTEO POR LA PRIMERA PALABRA — ¿CREAR o CONSULTAR?

    Fíjate con qué EMPIEZA el mensaje:

    A) Empieza con el NOMBRE de una sección (agenda / listado / listados /
       recordatorio / recordatorios) → intención de CREAR/REGISTRAR:
         "agenda cita médica mañana a las 10am" → [ACCION:evento|Cita médica|<mañana>|10:00]
         "listado mercado: pan, leche"          → [ACCION:crear_lista|mercado|pan;leche]
         "listado tareas"                        → [ACCION:crear_lista|tareas|]  (listado vacío)
         "recordatorio mi clave es 1234"        → [ACCION:recordatorio|mi clave es 1234]
       (Si es evento aplica la regla 10 A2: con QUÉ, DÍA y HORA se crea; si falta algo, pregúntalo.)

    B) Empieza con un VERBO DE VER o una pregunta → CONSULTAR, NO crear:
         "dime qué tengo en agenda" / "qué hay en agenda mañana" → responde con los datos (regla 20)
         "muéstrame la agenda"                                    → [ACCION:navegar|agenda]
         "muéstrame mis listados"                            → [ACCION:navegar|listado]
         "ver mis recordatorios"                             → [ACCION:navegar|recordatorios]

    C) CASOS ESPECIALES (mandan sobre A). Mira QUÉ viene justo después de "agenda":
       • NADA → consultar:  "agenda" → [ACCION:navegar|agenda]
         (y "listados" solo → [ACCION:navegar|listado]; "recordatorios" solo → [ACCION:navegar|recordatorios])
       • SOLO una palabra de TIEMPO y nada más (hoy/mañana/lunes/una fecha) → consultar:
         "agenda hoy" / "agenda mañana" / "agenda el lunes" → responde con los eventos de ese día (regla 20)
       • CUALQUIER OTRA palabra (para, algo, una, un, el…) PERO sin un QUÉ concreto
         o sin un DÍA → NO crees ni muestres: PREGUNTA lo que falte.
         "agenda para mañana" / "agenda algo mañana" → responde: "¿Qué quieres agendar?"
         "agenda una cita" → responde: "¿De qué es la cita?"
       REGLA FINA: "agenda" + <palabra de tiempo SOLA> = mostrar.
                   "agenda" + (relleno como "para"/"algo"/"una"…) = intención de crear
                   → si falta el QUÉ, el DÍA o la HORA, PREGUNTA (nunca muestres la agenda).
                   "agenda" + objeto concreto + día + hora = CREAR evento (regla 10 A2).

    D) Operar sobre un listado EXISTENTE (sin importar la primera palabra):
         "agrega arroz a mi lista de mercado" → [ACCION:agregar_item|mercado|arroz]
         "marca leche como comprado"          → [ACCION:marcar_item|mercado|leche]
         "depura mi lista de mercado"          → [ACCION:depurar_lista|mercado]

    RESUMEN: sección + (objeto/hora/ítems) = CREAR · verbo de ver, o solo la
    sección, o sección+día = CONSULTAR · sección + algo vago = PREGUNTA.

14. ⚠️ BORRADO MASIVO — SIEMPRE en 2 pasos (nunca borres a la primera).

    Detecta intención de borrar en bloque (NO confundir con ver):
      "borra todo" / "borra todo lo viejo" / "borra todo para empezar el mes"
        → [ACCION:borrar_todo|preguntar]
      "borra agenda" / "limpia agenda" / "borra los eventos"
        → [ACCION:borrar_agenda|preguntar]
      "borra pagos" / "limpia pagos"            → [ACCION:borrar_pagos|preguntar]
      "borra listados" / "borra mis listas"     → [ACCION:borrar_listados|preguntar]
      "borra recordatorios" / "borra mis notas" → [ACCION:borrar_recordatorios|preguntar]

    PASO 1 (usuario pide borrar): emite la acción con "preguntar". El sistema
    cuenta y muestra la confirmación con los números — tú NO inventes el conteo,
    solo emite la acción y un texto corto; el sistema arma el "⚠️ ¿Estás seguro?".

    PASO 2 (el usuario responde tras esa pregunta):
      • "sí" / "SÍ" / "confirmar" / "dale" / "hazlo" → repite la MISMA acción con
        "confirmar" (ej. [ACCION:borrar_todo|confirmar]). El sistema borra.
      • "no" / "cancelar" / "mejor no" → NO emitas ninguna acción y responde:
        "👍 No borré nada. Tu información sigue intacta."

    Solo emite "confirmar" si en el turno ANTERIOR tú pediste confirmación de
    borrado. Si no hay esa pregunta previa, usa "preguntar".

15. ⚠️ NUNCA CONFIRMES SIN ACCIÓN. No digas "✅", "listo", "agendado", "registrado" ni
    "guardado" si en ESE MISMO mensaje no emites la [ACCION:...] correspondiente. El
    historial no cuenta: lo que dijiste antes no significa que el pedido actual esté hecho.
    Responde solo a lo que pide el mensaje actual; no vuelvas a listar lo de turnos anteriores.

16. ⚠️ FECHAS. Calcula SIEMPRE a partir de HOY (arriba), nunca de fechas del historial o
    la memoria. Un día sin mes ("el 5") es su próxima ocurrencia desde HOY. Nunca generes
    una fecha pasada.

18. ⚠️ ANOTAR Y BUSCAR RECORDATORIOS.
    - La fecha del recordatorio es el día del AVISO FUTURO. Algo que ya pasó ("hoy pagué")
      es un registro: va SIN fecha. El sistema guarda solo el día en que se anotó.
    - El valor va en números puros. La nota es el detalle adicional, si lo dio.
    - Para "qué día anoté X", "cuánto pagué de X", "dónde anoté X" o "busca X", emite SIEMPRE
      [ACCION:buscar_recordatorio|X]. No respondas de memoria ni inventes la fecha: el
      sistema arma la respuesta con lo que encuentre.

    Usuario: "anota que hoy pagué el SOAT, 386.500"
    Tu respuesta:
      ✅ Listo.
      [ACCION:recordatorio|Pagué el SOAT||386500|]

    Usuario: "anota renovar el SOAT el 5 de diciembre, 386.500, es con Sura"
    Tu respuesta:
      ✅ Listo.
      [ACCION:recordatorio|Renovar el SOAT|2026-12-05|386500|Es con Sura]

    Usuario: "qué día anoté lo del SOAT"
    Tu respuesta:
      Déjame buscar.
      [ACCION:buscar_recordatorio|SOAT]

19. ⚠️ "YA HICE X". Si el usuario dice que ya hizo, terminó o resolvió algo ("ya hice lo del
    contador", "listo lo del banco"), emite [ACCION:marcar_recordatorio_hecho|contador] con
    las palabras clave, sin "lo del". El sistema responde con el resultado. Si es un pago que
    aparece en "Pagos pendientes" ("ya pagué la luz con tarjeta"), usa [ACCION:marcar_pago_pagado|ID|tarjeta].

20. ⚠️ CONSULTAS: responde tú mismo con los datos de arriba, corto y sin [ACCION]. Usa PRÓXIMOS
    DÍAS para ubicar las fechas. Si no hay nada, dilo en una línea.
    "¿qué debo pagar esta semana?" → los de "Pagos pendientes" que vencen de HOY a 7 días, más
      los vencidos. Ej: "Esta semana: Internet $90.000 el jueves y Arriendo $1.200.000 el viernes."
    "¿qué tengo mañana?" → los "Eventos próximos" de esa fecha y los recordatorios con aviso
      ese día. Ej: "Mañana tienes dentista a las 3 pm."
    "¿qué día anoté lo del SOAT?" → usa [ACCION:buscar_recordatorio|SOAT] (regla 18).

21. "YA NO LO HICE". Si dice que algo marcado como hecho aún no está ("desmarca lo del contador",
    "lo del banco no lo he hecho"), emite [ACCION:desmarcar_recordatorio|contador].

17. ⚠️ ACLARAR UN PAGO NO ES AGENDAR. Si el usuario habla de la fecha de un pago que ya
    existe ("el pago es para el 5"), NO crees un evento. Dile la fecha que tiene según
    "Pagos pendientes"; si quiere cambiarla, no puedes hacerlo desde aquí: dile que no
    quedó cambiada.`;
}

// ═══ LLAMAR A CLAUDE ═══
async function llamarClaude(system, history, message, imagen, maxTokens = 600) {
  const userContent = [];
  if (imagen) userContent.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagen } });
  userContent.push({ type: 'text', text: message || 'Analiza esta imagen' });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system,
      messages: [...history.slice(-14), { role: 'user', content: userContent }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

// ═══ LLAMAR A GROQ (modo voz — más rápido que Claude) ═══
async function llamarGroq(system, history, message, maxTokens = 150) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY no configurada');

  // Groq usa formato OpenAI: system va dentro de messages, content como string
  const messages = [
    { role: 'system', content: system },
    ...history.slice(-14).map(h => ({ role: h.role, content: typeof h.content === 'string' ? h.content : '' })),
    { role: 'user', content: message || '' }
  ];

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: maxTokens,
      temperature: 0.5,
      messages
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.choices?.[0]?.message?.content || '';
}

// ═══ Parser robusto de montos — Claude a veces escribe "25.000" (punto como separador de miles)
// parseFloat("25.000") = 25, lo cual es un bug crítico. Aquí strippeamos todo lo no-numérico.
function parseMontoSeguro(s) {
  if (typeof s === 'number') return s;
  if (s === null || s === undefined) return 0;
  const limpio = String(s).replace(/[^\d]/g, '');
  return limpio ? parseFloat(limpio) : 0;
}

// $386.500, exacto y con puntos de miles.
function fmtValorExacto(n) {
  return `$${Math.round(Number(n)).toLocaleString('es-CO')}`;
}

// "1 nov 2026" en hora Colombia.
function fechaCorta(fecha) {
  const f = new Date(`${fecha}T12:00:00-05:00`);
  return f.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Bogota' })
    .replace(/\s+de\s+/g, ' ').replace('.', '');
}

// Busca en todos los recordatorios del usuario por texto y nota, sin distinguir
// mayúsculas ni tildes. Se filtra aquí para no armar la consulta con lo que escribió.
const PALABRAS_VACIAS = new Set(['lo', 'la', 'el', 'los', 'las', 'de', 'del', 'que', 'un', 'una', 'y', 'a', 'en', 'mi', 'mis']);
const normalizarTexto = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
async function buscarRecordatorios(consulta, userId) {
  const terminos = normalizarTexto(consulta).split(/[^a-z0-9ñ]+/).filter(t => t && !PALABRAS_VACIAS.has(t));
  const { data, error } = await supabase.from('reminders')
    .select('id, titulo, nota, valor, recordar_fecha, created_at, hecho')
    .eq('user_id', userId).in('tipo', ['nota', 'definicion'])
    .order('created_at', { ascending: false }).limit(1000);
  if (error) return { error: error.message };
  const filas = (data || []).filter(r => {
    const texto = normalizarTexto(`${r.titulo} ${r.nota || ''}`);
    return terminos.length > 0 && terminos.every(t => texto.includes(t));
  });
  return { filas };
}

function textoBusquedaRecordatorios(a) {
  if (a.error) return '❌ No pude buscar en este momento. Intenta de nuevo.';
  if (!a.total) return `No encontré nada anotado sobre "${a.consulta}".`;
  const lineas = a.filas.map(r => {
    const anotado = r.created_at ? colombiaDateString(new Date(r.created_at)) : null;
    let t = `• *${r.titulo}*`;
    if (anotado) t += `\n  Anotado el ${fechaCorta(anotado)}`;
    if (Number(r.valor) > 0) t += `\n  💰 ${fmtValorExacto(r.valor)}`;
    if (r.recordar_fecha) t += `\n  🔔 Aviso el ${fechaCorta(r.recordar_fecha)}`;
    if (r.nota) t += `\n  📝 ${r.nota}`;
    if (r.hecho) t += '\n  ✅ Hecho';
    return t;
  });
  const extra = a.total > a.filas.length ? `\n\nHay ${a.total} en total; te muestro los ${a.filas.length} más recientes.` : '';
  return `🔎 Esto encontré:\n${lineas.join('\n')}${extra}`;
}

// ═══ Formatea "YYYY-MM-DD" + "HH:MM" a texto humano en hora Colombia:
// "hoy a las 7:00 am", "mañana a las 2:30 pm", "el lunes 3 de junio a las 9:00 am".
// Usado por el override determinístico de eventos (BUG 2/3) para garantizar que
// la confirmación SIEMPRE incluya día + hora exacta.
function formatearDia(fecha) {
  const hoy = colombiaDateString();
  const manana = colombiaDateString(new Date(Date.now() + 24 * 3600 * 1000));
  if (fecha === hoy) return 'hoy';
  if (fecha === manana) return 'mañana';
  // colombiaDateLongEs → "lunes, 3 de junio de 2026"; lo dejamos "el lunes 3 de junio".
  const largo = colombiaDateLongEs(new Date(`${fecha}T12:00:00-05:00`));
  return 'el ' + largo.replace(/,/g, '').replace(/ de \d{4}$/, '');
}

function formatearCuando(fecha, hora) {
  const dia = formatearDia(fecha);
  const [h, m] = hora.split(':').map(Number);
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dia} a las ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ═══ Busca un listado del usuario por título (case-insensitive, match exacto
// y luego parcial). Usado por las acciones de listas del bot (agregar/marcar/depurar).
async function buscarListaPorTitulo(titulo, userId) {
  const t = (titulo || '').trim().toLowerCase();
  if (!t) return null;
  const { data } = await supabase.from('reminders').select('*')
    .eq('user_id', userId).in('tipo', ['listado', 'lista']);
  if (!data || !data.length) return null;
  return data.find(l => (l.titulo || '').toLowerCase() === t)
      || data.find(l => (l.titulo || '').toLowerCase().includes(t))
      || null;
}

// ═══ Helpers de saldo: SIEMPRE leer fresh de la DB antes de actualizar.
// Esto evita drift contra contexto cacheado al inicio del request (race conditions
// si el usuario hizo un cambio manual entre el buildContexto y el ejecutarAcciones).
// Cada helper devuelve { antes, delta, despues, nombre } o null en caso de error.
async function ajustarSaldo(tabla, id, userId, delta, opLabel) {
  if (!id) { console.error(`[${opLabel}] sin id, no se ajusta saldo`); return null; }
  const { data: row, error: ferr } = await supabase
    .from(tabla)
    .select('saldo, nombre')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (ferr || !row) {
    console.error(`[${opLabel}] no se pudo leer ${tabla}#${id}:`, ferr?.message || 'no encontrado');
    return null;
  }
  const antes = parseFloat(row.saldo || 0);
  const despues = antes + delta;
  const { error: uerr } = await supabase
    .from(tabla)
    .update({ saldo: despues })
    .eq('id', id)
    .eq('user_id', userId);
  if (uerr) {
    console.error(`[${opLabel}] update saldo ${tabla}#${id} falló:`, uerr.message);
    return null;
  }
  console.log(`[saldo] ${opLabel} → ${tabla} (id=${id}) actualizado`);
  return { antes, delta, despues, nombre: row.nombre };
}

async function leerMovimientoFresh(movId, userId) {
  const { data, error } = await supabase
    .from('movements')
    .select('id, tipo, monto, descripcion, account_id, fecha, categoria')
    .eq('id', movId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('[leerMovimientoFresh] error:', error.message); return null; }
  return data;
}

async function leerCajaMovimientoFresh(movId, userId) {
  const { data, error } = await supabase
    .from('caja_movimientos')
    .select('id, caja_id, tipo, monto, descripcion, fecha')
    .eq('id', movId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('[leerCajaMovimientoFresh] error:', error.message); return null; }
  return data;
}

// Módulos retirados de Kontrol: estas acciones ya no se ejecutan aunque el modelo las
// emita (por ejemplo, por una memoria vieja de Mem0). Sus tablas siguen intactas.
const ACCIONES_RETIRADAS = new Set([
  'gasto', 'ingreso', 'editar_movimiento', 'borrar_movimiento', 'transferir',
  'caja_entrada', 'caja_salida', 'borrar_caja_movimiento', 'editar_caja', 'borrar_caja',
  'editar_cuenta', 'borrar_cuenta', 'meta', 'borrar_meta', 'completar_micrometa'
]);

// ═══ EJECUTAR ACCIONES — todo queda visible en la app ═══
async function ejecutarAcciones(respuesta, contexto, userId, { avisoDicho = null, fechaDicha = null, medioDicho = null } = {}) {
  // "mañana" o "el viernes" los calcula el código. Queda en los registros qué escribió la IA.
  const fechaFinal = (tipo, delModelo) => {
    const propia = (delModelo || '').trim();
    const final = fechaDicha || propia;
    console.log(`[fecha] ${tipo}: ia=${propia || '(vacía)'} codigo=${fechaDicha || '(no aplica)'} guardada=${final || '(vacía)'}`);
    return final;
  };
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  console.log('[ejecutarAcciones] matches encontrados:', matches.length);
  const ejecutadas = [];
  const errores = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0].trim();
    if (ACCIONES_RETIRADAS.has(accion)) continue;

    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseMontoSeguro(parts[1]);
        const desc = (parts[2] || 'Sin descripción').trim();
        const cat = (parts[3] || 'otro').trim();
        const cuentaIdEspecificada = (parts[4] || '').trim();
        if (!monto || monto <= 0) { console.warn(`[${accion}] monto inválido, ignorado`); continue; }

        // 🛡️ Guardia defensiva: si Claude mete un caja_id en el slot de cuenta_id_opcional,
        // re-enruta a caja_salida/caja_entrada en vez de hacer un movements insert huérfano.
        // Síntoma observado en logs: [ACCION:gasto|230000|odontologia|salud|4] donde 4 es caja.
        if (cuentaIdEspecificada) {
          const matchCaja = contexto.cajas.find(c => String(c.id) === String(cuentaIdEspecificada));
          const matchCuenta = contexto.cuentas.find(c => String(c.id) === String(cuentaIdEspecificada));
          if (matchCaja && !matchCuenta) {
            console.warn(`[${accion}] auto-reroute → caja: id=${cuentaIdEspecificada}`);
            const tipoMov = accion; // 'gasto' | 'ingreso'
            const { error: errCajaMov } = await supabase.from('caja_movimientos').insert({
              user_id: userId, caja_id: matchCaja.id, tipo: tipoMov,
              descripcion: desc, monto, fecha: colombiaDateString()
            });
            if (errCajaMov) { console.error('[auto-reroute] caja_movimientos insert error:', errCajaMov.message); continue; }
            const delta = accion === 'ingreso' ? monto : -monto;
            const ajuste = await ajustarSaldo('cajas', matchCaja.id, userId, delta, `auto-reroute ${accion}→caja`);
            if (!ajuste) continue;
            ejecutadas.push({
              accion: accion === 'gasto' ? 'caja_salida' : 'caja_entrada',
              monto, desc, caja: ajuste.nombre,
              saldo_antes: ajuste.antes, saldo_despues: ajuste.despues,
              auto_rerouteado_desde: accion
            });
            continue;
          }
        }

        // Resolver cuenta: la específica o la primera disponible
        const cuenta = cuentaIdEspecificada
          ? contexto.cuentas.find(c => String(c.id) === String(cuentaIdEspecificada))
          : contexto.cuentas[0];
        const cuentaId = cuenta?.id || null;

        const { data: mov, error } = await supabase
          .from('movements')
          .insert({
            user_id: userId, tipo: accion, descripcion: desc,
            monto, fecha: colombiaDateString(),
            account_id: cuentaId, categoria: cat, source: 'ia'
          })
          .select().single();

        if (error) { console.error(`[${accion}] insert movements falló:`, error.message); continue; }

        let ajuste = null;
        if (cuentaId) {
          const delta = accion === 'ingreso' ? monto : -monto;
          ajuste = await ajustarSaldo('accounts', cuentaId, userId, delta, accion);
        }
        ejecutadas.push({
          accion, monto, desc, id: mov.id, cuenta_id: cuentaId,
          saldo_antes: ajuste?.antes, saldo_despues: ajuste?.despues
        });

      } else if (accion === 'editar_movimiento') {
        const movId = parts[1];
        const nuevoMonto = parts[2] && parts[2].trim() ? parseMontoSeguro(parts[2]) : null;
        const nuevaDesc = (parts[3] || '').trim() || null;
        const nuevaFecha = (parts[4] || '').trim() || null;
        // SIEMPRE leer fresh de la DB para tipo/monto/account_id confiables.
        const movActual = await leerMovimientoFresh(movId, userId);
        if (!movActual) { console.warn(`[editar_movimiento] mov ${movId} no encontrado`); continue; }
        const updates = {};
        if (nuevoMonto !== null) updates.monto = nuevoMonto;
        if (nuevaDesc) updates.descripcion = nuevaDesc;
        if (nuevaFecha) updates.fecha = nuevaFecha;
        if (Object.keys(updates).length === 0) { console.log(`[editar_movimiento] sin cambios`); continue; }
        const { error } = await supabase.from('movements').update(updates).eq('id', movId).eq('user_id', userId);
        if (error) { console.error(`[editar_movimiento] update falló:`, error.message); continue; }

        let ajuste = null;
        if (nuevoMonto !== null && movActual.account_id) {
          const diff = nuevoMonto - parseFloat(movActual.monto);
          // Si era ingreso, subir el saldo por el diff (positivo si sube, negativo si baja);
          // si era gasto, bajar el saldo por el diff.
          const delta = movActual.tipo === 'ingreso' ? diff : -diff;
          ajuste = await ajustarSaldo('accounts', movActual.account_id, userId, delta, `editar_movimiento(${movActual.tipo})`);
        }
        ejecutadas.push({
          accion, id: movId, cambios: updates,
          mov_anterior: { tipo: movActual.tipo, monto: parseFloat(movActual.monto) },
          saldo_antes: ajuste?.antes, saldo_despues: ajuste?.despues
        });

      } else if (accion === 'borrar_movimiento') {
        const movId = parts[1];
        // 1. Leer fresh el movimiento de la DB ANTES de borrar.
        const mov = await leerMovimientoFresh(movId, userId);
        if (!mov) { console.warn(`[borrar_movimiento] mov ${movId} no encontrado`); continue; }

        // 2. Revertir el saldo ANTES de borrar (si la reversión falla queremos saber, no borrar a ciegas).
        let ajuste = null;
        if (mov.account_id) {
          // Reversa: si era gasto, devolver al saldo; si era ingreso, restar.
          const delta = mov.tipo === 'ingreso' ? -parseFloat(mov.monto) : parseFloat(mov.monto);
          ajuste = await ajustarSaldo('accounts', mov.account_id, userId, delta, `borrar_movimiento(reverso ${mov.tipo})`);
          if (!ajuste) { console.error(`[borrar_movimiento] no se pudo revertir saldo, abortando borrado de ${movId}`); continue; }
        }

        // 3. Solo ahora borrar la fila.
        const { error } = await supabase.from('movements').delete().eq('id', movId).eq('user_id', userId);
        if (error) { console.error(`[borrar_movimiento] delete falló:`, error.message); continue; }
        ejecutadas.push({
          accion: 'borrado', tipo: 'movimiento', id: movId,
          mov_borrado: { tipo: mov.tipo, monto: parseFloat(mov.monto), descripcion: mov.descripcion },
          saldo_antes: ajuste?.antes, saldo_despues: ajuste?.despues
        });

      } else if (accion === 'borrar_pago') {
        const { error } = await supabase.from('payments').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'pago' });

      } else if (accion === 'borrar_evento') {
        const { error } = await supabase.from('events').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'evento' });

      } else if (accion === 'borrar_recordatorio') {
        const { error } = await supabase.from('reminders').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'recordatorio', id: parts[1] });

      } else if (accion === 'borrar_todo' || accion === 'borrar_agenda' || accion === 'borrar_pagos' || accion === 'borrar_listados' || accion === 'borrar_recordatorios') {
        // Borrado MASIVO en 2 pasos. parts[1]: 'confirmar' ejecuta; cualquier otra
        // cosa ('preguntar'/vacío) solo cuenta y pide confirmación. Siempre scoped al user.
        const fase = (parts[1] || '').trim().toLowerCase();
        const quiere = {
          borrar_todo:          { agenda: true, pagos: true, listados: true, recordatorios: true },
          borrar_agenda:        { agenda: true },
          borrar_pagos:         { pagos: true },
          borrar_listados:      { listados: true },
          borrar_recordatorios: { recordatorios: true }
        }[accion];
        const contar = async (tabla, tipos) => {
          let q = supabase.from(tabla).select('*', { count: 'exact', head: true }).eq('user_id', userId);
          if (tipos) q = q.in('tipo', tipos);
          const { count } = await q;
          return count || 0;
        };
        const counts = {};
        if (quiere.agenda)        counts.agenda = await contar('events');
        if (quiere.pagos)         counts.pagos = await contar('payments');
        if (quiere.listados)      counts.listados = await contar('reminders', ['listado', 'lista']);
        if (quiere.recordatorios) counts.recordatorios = await contar('reminders', ['nota', 'definicion']);

        if (fase === 'confirmar') {
          if (quiere.agenda)        await supabase.from('events').delete().eq('user_id', userId);
          if (quiere.pagos)         await supabase.from('payments').delete().eq('user_id', userId);
          if (quiere.listados)      await supabase.from('reminders').delete().eq('user_id', userId).in('tipo', ['listado', 'lista']);
          if (quiere.recordatorios) await supabase.from('reminders').delete().eq('user_id', userId).in('tipo', ['nota', 'definicion']);
          ejecutadas.push({ accion: 'borrado_masivo', fase: 'confirmado', alcance: accion, counts });
        } else {
          ejecutadas.push({ accion: 'borrado_masivo', fase: 'preguntar', alcance: accion, counts });
        }

      } else if (accion === 'borrar_meta') {
        const { error } = await supabase.from('metas').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'meta' });

      } else if (accion === 'pago') {
        const { error } = await supabase.from('payments').insert({
          user_id: userId, nombre: parts[1],
          monto: parseMontoSeguro(parts[2]), fecha_limite: fechaFinal('pago', parts[3]), status: 'pendiente'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'marcar_pago_pagado') {
        // El medio lo lee el código del mensaje; el de la IA solo si el código no lo encontró.
        const delModelo = (parts[2] || '').trim().toLowerCase();
        const medio = medioDicho || (MEDIOS.includes(delModelo) ? delModelo : null);
        const { data: marcado, error } = await supabase.from('payments')
          .update({ status: 'pagado', fecha_pago: colombiaDateString(), medio_pago: medio })
          .eq('id', parts[1]).eq('user_id', userId).neq('status', 'pagado')
          .select('id, nombre, monto');
        if (error) ejecutadas.push({ accion, error: 'db' });
        else if (!marcado?.length) ejecutadas.push({ accion, error: 'ya_estaba_pagado_o_no_existe' });
        else ejecutadas.push({ accion, id: marcado[0].id, nombre: marcado[0].nombre, monto: Number(marcado[0].monto), medio: medio || 'sin decir' });

      } else if (accion === 'evento') {
        const titulo = (parts[1] || '').trim();
        const fecha = fechaFinal('evento', parts[2]);
        // Normalizar H:MM → HH:MM. Por la IA la hora es obligatoria; solo el formulario
        // de la app permite eventos sin hora.
        const mHora = (parts[3] || '').trim().match(/^(\d{1,2}):(\d{2})$/);
        const hora = mHora ? `${mHora[1].padStart(2, '0')}:${mHora[2]}` : null;
        const fechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !isNaN(new Date(`${fecha}T12:00:00-05:00`).getTime());
        if (!titulo || !fechaValida) {
          console.warn('[evento] sin título o fecha válida, no se crea');
          ejecutadas.push({ accion: 'evento', error: 'sin_fecha', titulo });
          continue;
        }
        if (fecha < colombiaDateString()) {
          console.warn('[evento] fecha pasada, no se crea:', fecha);
          ejecutadas.push({ accion: 'evento', error: 'fecha_pasada', titulo });
          continue;
        }
        if (!hora) {
          ejecutadas.push({ accion: 'evento', error: 'sin_hora', titulo });
          continue;
        }
        // BUG 2 (REGLA 3): el cron notifica con ventanas relativas a "ahora" hacia
        // adelante; una hora ya pasada (>15 min) nunca dispararía. No la programamos.
        const cuando = new Date(`${fecha}T${hora}:00-05:00`);
        if (isNaN(cuando.getTime()) || cuando.getTime() < Date.now() - 15 * 60 * 1000) {
          console.warn('[evento] hora pasada o inválida, no se crea:', fecha, hora);
          ejecutadas.push({ accion: 'evento', error: 'hora_pasada', titulo });
          continue;
        }
        const temprano = esTemprano({ hora });
        // Lo que se lee directo del usuario manda sobre el campo que escribió el modelo.
        // Un aviso que ya pasó se descarta y el usuario recibe la pregunta de siempre.
        const elegido = resolverAviso(avisoDicho || parts[5], fecha, hora);
        const aTiempo = elegido.en && (elegido.en.getTime() > Date.now() || elegido.en.getTime() >= cuando.getTime());
        const aviso_en = aTiempo ? elegido.en.toISOString() : null;
        const { data: ev, error } = await supabase.from('events').insert({
          user_id: userId, titulo, fecha, hora, nota: (parts[4] || '').trim() || null, aviso_en
        }).select().single();
        if (error || !ev) {
          console.error('[evento] insert events falló:', error?.message);
          ejecutadas.push({ accion: 'evento', error: 'db', titulo });
        } else {
          ejecutadas.push({
            accion: 'evento', ok: true, id: ev.id, titulo, fecha, hora, temprano,
            aviso: aviso_en ? fechaHoraColombia(new Date(aviso_en)) : null,
            aviso_pasado: !!elegido.en && !aviso_en,
            noche_vigente: temprano && !aviso_en && momentoAviso(ev).getTime() > Date.now()
          });
        }

      } else if (accion === 'aviso_evento') {
        const id = (parts[1] || '').trim();
        const { data: ev } = /^\d+$/.test(id)
          ? await supabase.from('events').select('*').eq('id', id).eq('user_id', userId).maybeSingle()
          : { data: null };
        if (!ev) { ejecutadas.push({ accion, error: 'no_encontrado' }); continue; }
        const elegido = resolverAviso(avisoDicho || parts[2], ev.fecha, ev.hora);
        if (!elegido.ok) { ejecutadas.push({ accion, error: 'hora_invalida' }); continue; }
        const evento = eventoADate(ev);
        if (elegido.en && elegido.en.getTime() <= Date.now() && elegido.en.getTime() < evento.getTime()) {
          ejecutadas.push({ accion, error: 'aviso_pasado' });
          continue;
        }
        const aviso_en = elegido.en ? elegido.en.toISOString() : null;
        // "Como siempre" sobre un evento sin aviso elegido no cambia nada: si se tocara
        // el flag, el aviso de las 8 pm ya enviado podría repetirse.
        if (aviso_en || ev.aviso_en) {
          const { error } = await supabase.from('events')
            .update({ aviso_en, notificado_aviso: false }).eq('id', ev.id).eq('user_id', userId);
          if (error) {
            console.error('[aviso_evento] update falló:', error.message);
            ejecutadas.push({ accion, error: 'db' });
            continue;
          }
        }
        const temprano = esTemprano(ev);
        ejecutadas.push({
          accion, ok: true, titulo: ev.titulo, temprano,
          aviso: aviso_en ? fechaHoraColombia(new Date(aviso_en)) : null,
          noche_vigente: temprano && !aviso_en && momentoAviso({ ...ev, aviso_en }).getTime() > Date.now()
        });

      } else if (accion === 'recordatorio') {
        const titulo = (parts[1] || '').trim();
        if (!titulo) {
          ejecutadas.push({ accion: 'recordatorio', error: 'sin_titulo' });
          continue;
        }
        // Solo una fecha válida de hoy en adelante programa aviso; lo pasado queda como registro.
        // Sin fecha de la IA es una nota sin aviso: "anota que hoy pagué" no programa nada.
        const fechaTxt = (parts[2] || '').trim() ? fechaFinal('recordatorio', parts[2]) : '';
        const fechaOk = /^\d{4}-\d{2}-\d{2}$/.test(fechaTxt) && !isNaN(new Date(`${fechaTxt}T12:00:00-05:00`).getTime()) && fechaTxt >= colombiaDateString();
        const recordar_fecha = fechaOk ? fechaTxt : null;
        const valor = parseMontoSeguro(parts[3]) || null;
        const nota = (parts[4] || '').trim() || null;
        const { error } = await supabase.from('reminders').insert({
          user_id: userId, tipo: 'nota', titulo, content: { texto: titulo },
          fecha: colombiaDateString(), recordar_fecha, valor, nota
        });
        if (error) {
          console.error('[recordatorio] insert reminders falló:', error.message);
          ejecutadas.push({ accion: 'recordatorio', error: 'db', detalle: titulo });
        } else {
          ejecutadas.push({ accion: 'recordatorio', ok: true, detalle: titulo, recordar_fecha, valor });
        }

      } else if (accion === 'desmarcar_recordatorio') {
        const consulta = (parts[1] || '').trim();
        const { filas, error } = await buscarRecordatorios(consulta, userId);
        if (error) {
          console.error('[desmarcar_recordatorio] error:', error);
          ejecutadas.push({ accion, ok: false, error: 'db' });
          continue;
        }
        const hechos = filas.filter(r => r.hecho);
        if (!filas.length) {
          ejecutadas.push({ accion, ok: false, error: 'no_encontrado', consulta });
        } else if (!hechos.length) {
          ejecutadas.push({ accion, ok: false, error: 'no_hecho', titulo: filas[0].titulo });
        } else if (hechos.length > 1) {
          ejecutadas.push({ accion, ok: false, error: 'varios', titulos: hechos.slice(0, 5).map(r => r.titulo) });
        } else {
          const { error: errUp } = await supabase.from('reminders').update({ hecho: false })
            .eq('id', hechos[0].id).eq('user_id', userId);
          if (errUp) {
            console.error('[desmarcar_recordatorio] update falló:', errUp.message);
            ejecutadas.push({ accion, ok: false, error: 'db' });
          } else {
            ejecutadas.push({ accion, ok: true, id: hechos[0].id, titulo: hechos[0].titulo });
          }
        }

      } else if (accion === 'marcar_recordatorio_hecho') {
        // ok:false evita que la app salte de pestaña cuando no se marcó nada.
        const consulta = (parts[1] || '').trim();
        const { filas, error } = await buscarRecordatorios(consulta, userId);
        if (error) {
          console.error('[marcar_recordatorio_hecho] error:', error);
          ejecutadas.push({ accion, ok: false, error: 'db' });
          continue;
        }
        const pendientes = filas.filter(r => !r.hecho);
        if (!filas.length) {
          ejecutadas.push({ accion, ok: false, error: 'no_encontrado', consulta });
        } else if (!pendientes.length) {
          ejecutadas.push({ accion, ok: false, error: 'ya_hecho', titulo: filas[0].titulo });
        } else if (pendientes.length > 1) {
          // Nunca adivina cuál: se marcaría algo que no se ha hecho.
          ejecutadas.push({ accion, ok: false, error: 'varios', titulos: pendientes.slice(0, 5).map(r => r.titulo) });
        } else {
          const { error: errUp } = await supabase.from('reminders').update({ hecho: true })
            .eq('id', pendientes[0].id).eq('user_id', userId);
          if (errUp) {
            console.error('[marcar_recordatorio_hecho] update falló:', errUp.message);
            ejecutadas.push({ accion, ok: false, error: 'db' });
          } else {
            ejecutadas.push({ accion, ok: true, id: pendientes[0].id, titulo: pendientes[0].titulo });
          }
        }

      } else if (accion === 'buscar_recordatorio') {
        const consulta = (parts[1] || '').trim();
        const { filas, error } = await buscarRecordatorios(consulta, userId);
        if (error) {
          console.error('[buscar_recordatorio] error:', error);
          ejecutadas.push({ accion, consulta, error: 'db' });
        } else {
          ejecutadas.push({ accion, consulta, total: filas.length, filas: filas.slice(0, 5) });
        }

      } else if (accion === 'crear_lista') {
        const titulo = (parts[1] || '').trim();
        const items = (parts[2] || '').split(';').map(s => s.trim()).filter(Boolean)
          .map(t => ({ text: t, done: false }));
        if (!titulo) { ejecutadas.push({ accion: 'lista', error: 'sin_titulo' }); continue; }
        const { data, error } = await supabase.from('reminders').insert({
          user_id: userId, tipo: 'listado', titulo, content: { items }, fecha: colombiaDateString()
        }).select().single();
        if (error || !data) {
          console.error('[crear_lista] insert falló:', error?.message);
          ejecutadas.push({ accion: 'lista', error: 'db', titulo });
        } else {
          ejecutadas.push({ accion: 'lista', op: 'creada', titulo, items: items.map(i => i.text) });
        }

      } else if (accion === 'agregar_item' || accion === 'marcar_item' || accion === 'depurar_lista') {
        const lista = await buscarListaPorTitulo(parts[1], userId);
        if (!lista) { ejecutadas.push({ accion: 'lista', error: 'no_encontrada', titulo: (parts[1] || '').trim() }); continue; }
        const content = lista.content || {};
        const items = Array.isArray(content.items) ? content.items : [];
        if (accion === 'agregar_item') {
          const item = (parts[2] || '').trim();
          if (!item) { ejecutadas.push({ accion: 'lista', error: 'sin_item', titulo: lista.titulo }); continue; }
          items.push({ text: item, done: false });
          const { error } = await supabase.from('reminders').update({ content: { ...content, items } }).eq('id', lista.id).eq('user_id', userId);
          if (error) { ejecutadas.push({ accion: 'lista', error: 'db', titulo: lista.titulo }); continue; }
          ejecutadas.push({ accion: 'lista', op: 'item_agregado', titulo: lista.titulo, item });
        } else if (accion === 'marcar_item') {
          const objetivo = (parts[2] || '').trim().toLowerCase();
          const it = objetivo ? items.find(i => (i.text || '').toLowerCase().includes(objetivo)) : null;
          if (!it) { ejecutadas.push({ accion: 'lista', error: 'item_no_encontrado', titulo: lista.titulo, item: parts[2] }); continue; }
          it.done = true;
          const { error } = await supabase.from('reminders').update({ content: { ...content, items } }).eq('id', lista.id).eq('user_id', userId);
          if (error) { ejecutadas.push({ accion: 'lista', error: 'db', titulo: lista.titulo }); continue; }
          ejecutadas.push({ accion: 'lista', op: 'item_marcado', titulo: lista.titulo, item: it.text });
        } else { // depurar_lista
          const quedan = items.filter(i => !i.done);
          const borrados = items.length - quedan.length;
          const { error } = await supabase.from('reminders').update({ content: { ...content, items: quedan } }).eq('id', lista.id).eq('user_id', userId);
          if (error) { ejecutadas.push({ accion: 'lista', error: 'db', titulo: lista.titulo }); continue; }
          ejecutadas.push({ accion: 'lista', op: 'depurada', titulo: lista.titulo, borrados });
        }

      } else if (accion === 'meta') {
        const { error } = await supabase.from('metas').insert({
          user_id: userId, titulo: parts[1], tipo: parts[2] || 'personal',
          monto_objetivo: parseMontoSeguro(parts[3]) || null,
          fecha_limite: parts[4] || null,
          año: colombiaDateParts().anio, estado: 'activa', progreso: 0
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'completar_micrometa') {
        const { error } = await supabase.from('micrometas').update({ completada: true }).eq('id', parts[1]);
        if (!error) ejecutadas.push({ accion, id: parts[1] });

      } else if (accion === 'transferir') {
        const origenTipo = (parts[1] || '').trim();
        const origenId = (parts[2] || '').trim();
        const destinoTipo = (parts[3] || '').trim();
        const destinoId = (parts[4] || '').trim();
        const monto = parseMontoSeguro(parts[5]);
        if (!(monto > 0)) { console.warn('[transferir] monto inválido'); continue; }
        if (!['cuenta','caja'].includes(origenTipo) || !['cuenta','caja'].includes(destinoTipo)) {
          console.warn('[transferir] tipos inválidos', { origenTipo, destinoTipo }); continue;
        }
        const tablaOrigen = origenTipo === 'caja' ? 'cajas' : 'accounts';
        const tablaDestino = destinoTipo === 'caja' ? 'cajas' : 'accounts';
        const ajusteOrigen = await ajustarSaldo(tablaOrigen, origenId, userId, -monto, `transferir(origen ${origenTipo})`);
        if (!ajusteOrigen) { console.error('[transferir] origen falló, abortando'); continue; }
        const ajusteDestino = await ajustarSaldo(tablaDestino, destinoId, userId, +monto, `transferir(destino ${destinoTipo})`);
        if (!ajusteDestino) {
          console.error('[transferir] destino falló, REVIRTIENDO el origen');
          await ajustarSaldo(tablaOrigen, origenId, userId, +monto, `transferir(rollback origen)`);
          continue;
        }
        const fecha = colombiaDateString();
        await supabase.from('movements').insert([
          {
            user_id: userId, tipo: 'gasto',
            descripcion: `Transferencia a ${destinoTipo} ${ajusteDestino.nombre}`,
            monto, fecha,
            account_id: origenTipo === 'cuenta' ? origenId : null,
            categoria: 'transferencia', source: 'ia'
          },
          {
            user_id: userId, tipo: 'ingreso',
            descripcion: `Transferencia desde ${origenTipo} ${ajusteOrigen.nombre}`,
            monto, fecha,
            account_id: destinoTipo === 'cuenta' ? destinoId : null,
            categoria: 'transferencia', source: 'ia'
          }
        ]);
        ejecutadas.push({
          accion, monto,
          origen: `${origenTipo}:${ajusteOrigen.nombre}`,
          destino: `${destinoTipo}:${ajusteDestino.nombre}`,
          saldos: {
            origen_antes: ajusteOrigen.antes, origen_despues: ajusteOrigen.despues,
            destino_antes: ajusteDestino.antes, destino_despues: ajusteDestino.despues
          }
        });

      } else if (accion === 'caja_entrada' || accion === 'caja_salida') {
        const cajaId = (parts[1] || '').trim();
        const monto = parseMontoSeguro(parts[2]);
        const desc = (parts[3] || (accion === 'caja_entrada' ? 'Entrada de caja' : 'Salida de caja')).trim();
        if (!cajaId || !(monto > 0)) { console.warn(`[${accion}] datos inválidos`); continue; }
        const tipoMov = accion === 'caja_entrada' ? 'ingreso' : 'gasto';
        const { error: errMov } = await supabase.from('caja_movimientos').insert({
          user_id: userId, caja_id: cajaId, tipo: tipoMov,
          descripcion: desc, monto, fecha: colombiaDateString()
        });
        if (errMov) {
          console.error(`[${accion}] insert caja_movimientos falló:`, errMov.message);
          continue;
        }
        const delta = accion === 'caja_entrada' ? +monto : -monto;
        const ajuste = await ajustarSaldo('cajas', cajaId, userId, delta, accion);
        if (!ajuste) continue;
        ejecutadas.push({
          accion, monto, desc, caja: ajuste.nombre,
          saldo_antes: ajuste.antes, saldo_despues: ajuste.despues
        });

      } else if (accion === 'borrar_caja_movimiento') {
        const movId = (parts[1] || '').trim();
        if (!movId) { console.warn('[borrar_caja_movimiento] sin id'); continue; }
        // 1. Leer fresh el movimiento.
        const mov = await leerCajaMovimientoFresh(movId, userId);
        if (!mov) { console.warn(`[borrar_caja_movimiento] mov ${movId} no encontrado`); continue; }

        // 2. Revertir saldo de la caja ANTES de borrar.
        const delta = mov.tipo === 'ingreso' ? -parseFloat(mov.monto) : parseFloat(mov.monto);
        const ajuste = await ajustarSaldo('cajas', mov.caja_id, userId, delta, `borrar_caja_movimiento(reverso ${mov.tipo})`);
        if (!ajuste) { console.error(`[borrar_caja_movimiento] reversión saldo falló, abortando borrado`); continue; }

        // 3. Solo ahora borrar.
        const { error: errDel } = await supabase.from('caja_movimientos').delete().eq('id', movId).eq('user_id', userId);
        if (errDel) {
          console.error(`[borrar_caja_movimiento] delete falló:`, errDel.message);
          // Intentar rollback del saldo
          await ajustarSaldo('cajas', mov.caja_id, userId, -delta, `borrar_caja_movimiento(rollback)`);
          continue;
        }
        ejecutadas.push({
          accion, id: movId,
          mov_borrado: { tipo: mov.tipo, monto: parseFloat(mov.monto), descripcion: mov.descripcion },
          caja: ajuste.nombre,
          saldo_antes: ajuste.antes, saldo_despues: ajuste.despues
        });

      } else if (accion === 'navegar') {
        // No muta DB — solo devuelve la sección para que el frontend cambie de tab
        const seccion = (parts[1] || '').trim();
        const validas = ['agenda','listado','pagos','recordatorios','ia'];
        if (seccion && validas.includes(seccion)) {
          ejecutadas.push({ accion, seccion });
        }

      } else if (accion === 'editar_cuenta') {
        const cuentaId = (parts[1] || '').trim();
        const nuevoSaldoStr = (parts[2] || '').trim();
        const nuevoNombre = (parts[3] || '').trim();
        const updates = {};
        if (nuevoSaldoStr) updates.saldo = parseMontoSeguro(nuevoSaldoStr);
        if (nuevoNombre) updates.nombre = nuevoNombre;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('accounts').update(updates).eq('id', cuentaId).eq('user_id', userId);
          if (!error) ejecutadas.push({ accion, id: cuentaId, cambios: updates });
        }

      } else if (accion === 'editar_caja') {
        const cajaId = (parts[1] || '').trim();
        const nuevoSaldoStr = (parts[2] || '').trim();
        const nuevoNombre = (parts[3] || '').trim();
        const updates = {};
        if (nuevoSaldoStr) updates.saldo = parseMontoSeguro(nuevoSaldoStr);
        if (nuevoNombre) updates.nombre = nuevoNombre;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('cajas').update(updates).eq('id', cajaId).eq('user_id', userId);
          if (!error) ejecutadas.push({ accion, id: cajaId, cambios: updates });
        }

      } else if (accion === 'borrar_cuenta') {
        // NO eliminar acá — devolver confirmación requerida para el frontend
        const cuentaId = (parts[1] || '').trim();
        const cuenta = contexto.cuentas.find(c => String(c.id) === String(cuentaId));
        if (cuenta) {
          ejecutadas.push({
            accion,
            confirmacion_requerida: true,
            tipo: 'cuenta',
            id: cuentaId,
            nombre: cuenta.nombre
          });
        }

      } else if (accion === 'borrar_caja') {
        // NO eliminar acá — devolver confirmación requerida para el frontend
        const cajaId = (parts[1] || '').trim();
        const caja = contexto.cajas.find(c => String(c.id) === String(cajaId));
        if (caja) {
          ejecutadas.push({
            accion,
            confirmacion_requerida: true,
            tipo: 'caja',
            id: cajaId,
            nombre: caja.nombre
          });
        }

      } else if (accion === 'guardar_ubicacion') {
        // Path raro: usuario da coords por texto. El flujo normal (pin WhatsApp)
        // lo maneja el webhook sin pasar por aquí.
        const nombre = (parts[1] || '').trim();
        const lat = parseFloat(parts[2]);
        const lng = parseFloat(parts[3]);
        if (!nombre || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          console.warn('[guardar_ubicacion] datos inválidos'); continue;
        }
        const { data, error } = await supabase.from('ubicaciones').insert({
          user_id: userId, nombre, latitud: lat, longitud: lng, created_via: 'ia'
        }).select().single();
        if (error) {
          if (error.code === '23505') {
            ejecutadas.push({ accion, conflicto: true, nombre });
          } else {
            console.error('[guardar_ubicacion] error:', error.message);
          }
          continue;
        }
        ejecutadas.push({
          accion, nombre: data.nombre, id: data.id,
          url: `https://maps.google.com/?q=${lat},${lng}`
        });

      } else if (accion === 'get_ubicacion') {
        const nombre = (parts[1] || '').trim();
        if (!nombre) continue;
        const { data, error } = await supabase.from('ubicaciones')
          .select('id, nombre, latitud, longitud')
          .eq('user_id', userId)
          .ilike('nombre', nombre)
          .maybeSingle();
        if (error) { console.error('[get_ubicacion] error:', error.message); continue; }
        if (!data) {
          ejecutadas.push({ accion, encontrado: false, nombre_buscado: nombre });
        } else {
          ejecutadas.push({
            accion, encontrado: true,
            nombre: data.nombre,
            url: `https://maps.google.com/?q=${data.latitud},${data.longitud}`
          });
        }

      } else if (accion === 'listar_ubicaciones') {
        const { data, error } = await supabase.from('ubicaciones')
          .select('id, nombre')
          .eq('user_id', userId)
          .order('nombre');
        if (error) { console.error('[listar_ubicaciones] error:', error.message); continue; }
        ejecutadas.push({
          accion,
          count: data?.length || 0,
          nombres: (data || []).map(u => u.nombre)
        });

      } else if (accion === 'borrar_ubicacion') {
        const nombre = (parts[1] || '').trim();
        if (!nombre) continue;
        const { data, error } = await supabase.from('ubicaciones')
          .delete()
          .eq('user_id', userId)
          .ilike('nombre', nombre)
          .select();
        if (error) { console.error('[borrar_ubicacion] error:', error.message); continue; }
        if (!data || data.length === 0) {
          ejecutadas.push({ accion, encontrado: false, nombre_buscado: nombre });
        } else {
          ejecutadas.push({ accion, encontrado: true, nombre: data[0].nombre });
        }
      }
    } catch(e) {
      console.error('[ejecutarAcciones] Error acción:', accion, e.message, e.stack);
      errores.push({ accion, error: e.message });
    }
  }
  if (matches.length > 0 && ejecutadas.length === 0) {
    console.warn('[ejecutarAcciones] ⚠️ se encontraron', matches.length, 'markers pero NINGUNO se ejecutó. Errores:', JSON.stringify(errores));
  } else if (errores.length > 0) {
    console.warn('[ejecutarAcciones] errores parciales:', JSON.stringify(errores));
  }
  console.log('[ejecutarAcciones] total ejecutadas:', ejecutadas.length, 'de', matches.length, 'markers');
  return ejecutadas;
}
