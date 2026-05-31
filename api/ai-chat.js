// /api/ai-chat.js — Claude + Mem0 memoria profesional
const supabase = require('../lib/supabase');
const { colombiaDateString, colombiaDateLongEs, colombiaTimeString, colombiaDateParts } = require('../lib/datetime');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [], imagen_base64, user_id, voz = false } = req.body;
  if (!message && !imagen_base64) return res.status(400).json({ error: 'Mensaje requerido' });
  if (!user_id) return res.status(400).json({ error: 'user_id requerido' });

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

    // 4. Llamar al LLM — siempre Claude Haiku (fiabilidad sobre velocidad)
    //    Groq llama-3.1-8b no seguía consistentemente el formato [ACCION:...]
    const respuesta = await llamarClaude(systemPrompt, history, message, imagen_base64, voz ? 200 : 600);
    console.log('[ai-chat] RAW LLM response:', JSON.stringify(respuesta));
    const respuestaLimpia = respuesta
      .replace(/\[ACCION:[^\]]+\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 5. Ejecutar acciones (registrar gastos, eventos, etc.)
    const accionMatches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
    const accionesIntencion = accionMatches.length;
    console.log('[ai-chat] markers [ACCION:] encontrados:', accionesIntencion, accionMatches.map(m => m[0]));
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id);
    console.log('[ai-chat] acciones realmente ejecutadas:', acciones.length, JSON.stringify(acciones));

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
      } else if (a.accion === 'evento' && a.ok) {
        partesEvento.push(`✅ Listo, te aviso ${formatearCuando(a.fecha, a.hora)} sobre ${a.titulo}.`);
      } else if (a.accion === 'evento' && a.error === 'sin_hora') {
        partesEvento.push('❌ Necesito una hora exacta para programarte el aviso. ¿A qué hora te aviso?');
      } else if (a.accion === 'evento' && a.error === 'hora_pasada') {
        partesEvento.push('❌ Esa hora ya pasó. ¿Para qué hora te aviso?');
      } else if (a.accion === 'evento' && a.error === 'db') {
        partesEvento.push('❌ Hubo un error guardando. Por favor intenta de nuevo.');
      } else if (a.accion === 'recordatorio' && a.error === 'db') {
        partesEvento.push('❌ Hubo un error guardando. Por favor intenta de nuevo.');
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
          const verifSys = `Eres Ana, agente financiero. Recibes el resultado REAL de acciones ejecutadas en la base de datos. Confirma al usuario en MÁXIMO 2 LÍNEAS exactamente lo que se hizo, basándote SOLO en los datos del array. No inventes. Si el array está vacío o algún campo dice error, di "No se pudo ejecutar el cambio". Sin emojis salvo ✅. Español colombiano cálido.`;
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

    return res.json({ ok: true, respuesta: respuestaFinal, acciones });
  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ═══ CONTEXTO FINANCIERO COMPLETO ═══
async function buildContexto(userId) {
  // inicioMes debe ser el día 1 del mes ACTUAL en Colombia, no UTC.
  // Después de 7pm Col del último día del mes, el UTC ya avanzó al mes siguiente.
  const { anio: aMes, mes: mMes } = colombiaDateParts();
  const inicioMes = `${aMes}-${String(mMes + 1).padStart(2, '0')}-01`;
  const [
    { data: cuentas },
    { data: movsMes },
    { data: movsRecientes },
    { data: pagos },
    { data: eventos },
    { data: cajas },
    { data: cajaMovsMes, error: cajaMovsErr },
    { data: metas },
    { data: recordatorios },
    { data: ubicaciones }
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('movements').select('*').eq('user_id', userId)
      .gte('fecha', inicioMes)
      .order('fecha', { ascending: false }).limit(50),
    supabase.from('movements').select('*').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments').select('*').eq('user_id', userId).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', userId)
      .gte('fecha', colombiaDateString()).order('fecha').limit(10),
    supabase.from('cajas').select('*').eq('user_id', userId),
    supabase.from('caja_movimientos').select('*').eq('user_id', userId)
      .gte('fecha', inicioMes)
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('metas').select('*, micrometas(*)').eq('user_id', userId).eq('estado', 'activa'),
    supabase.from('reminders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
    supabase.from('ubicaciones').select('id, nombre, latitud, longitud').eq('user_id', userId).order('nombre')
  ]);
  if (cajaMovsErr) console.warn('[buildContexto] caja_movimientos error:', cajaMovsErr.message);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const totalCajas = (cajas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const esReal = m => m.categoria !== 'caja' && m.categoria !== 'transferencia';
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso' && esReal(m)).reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto' && esReal(m)).reduce((a, m) => a + parseFloat(m.monto), 0);

  return {
    totalSaldo, totalCajas, ingresosMes, gastosMes,
    cuentas: cuentas || [], movimientos: movsMes || [],
    movsRecientes: movsRecientes || [], pagos: pagos || [],
    eventos: eventos || [], cajas: cajas || [],
    cajaMovimientos: cajaMovsMes || [],
    metas: metas || [], recordatorios: recordatorios || [],
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

  return `⚠️ REGLA DE ORO (PRIORIDAD MÁXIMA): Cuando el usuario mencione un gasto, SIEMPRE pregunta primero de qué cuenta o caja sale el dinero, listando las cuentas disponibles con sus saldos. NUNCA ejecutes [ACCION:gasto] sin que el usuario haya confirmado la fuente. Excepción: si el usuario ya mencionó explícitamente la cuenta en el mismo mensaje.

Eres Ana, agente financiero personal. Tienes MEMORIA COMPLETA del usuario y acceso TOTAL a sus finanzas.

HOY: ${hoy}
HORA actual (Colombia): ${hora}

═══ LO QUE SABES DEL USUARIO (memoria persistente) ═══
${memoria || 'Primera vez que hablas con este usuario — aprende todo lo posible.'}

═══ ESTADO FINANCIERO EN TIEMPO REAL ═══
Total bancos: ${fmt(ctx.totalSaldo)}
Total efectivo: ${fmt(ctx.totalCajas)}
TOTAL DISPONIBLE: ${fmt(ctx.totalSaldo + ctx.totalCajas)}

Cuentas: ${ctx.cuentas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Cajas: ${ctx.cajas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Mes: Ingresos ${fmt(ctx.ingresosMes)} | Gastos ${fmt(ctx.gastosMes)} | Balance ${fmt(ctx.ingresosMes - ctx.gastosMes)}

Movimientos de cajas este mes (usa el ID exacto cuando el usuario pida borrarlos):
${(ctx.cajaMovimientos || []).map(cm => {
  const cajaNom = (ctx.cajas.find(c => String(c.id) === String(cm.caja_id)) || {}).nombre || '?';
  return `• ${cm.tipo==='ingreso'?'+':'-'}${fmt(cm.monto)} ${cm.descripcion||'(sin nota)'} en ${cajaNom} (${cm.fecha}) [ID:${cm.id}]`;
}).join('\n') || 'ninguno'}

Últimos movimientos:
${ctx.movsRecientes.map(m => `• ${m.tipo==='ingreso'?'↑':'↓'} ${fmt(m.monto)} — ${m.descripcion} (${m.fecha}) [ID:${m.id}]`).join('\n') || 'ninguno'}

Todos del mes:
${ctx.movimientos.map(m => `• ${m.tipo==='ingreso'?'+':'-'}${fmt(m.monto)} ${m.descripcion} ${m.fecha} [ID:${m.id}]`).join('\n') || 'ninguno'}

Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} vence ${p.fecha_limite} [ID:${p.id}]`).join('\n') || 'ninguno'}

Eventos próximos:
${ctx.eventos.map(e => `• ${e.titulo} — ${e.fecha} ${e.hora||''} [ID:${e.id}]`).join('\n') || 'ninguno'}

Metas activas:
${ctx.metas.map(m => {
  const mms = (m.micrometas || []).map(mm => `   ${mm.completada ? '✓' : '○'} ${mm.titulo || mm.descripcion || ''} [ID:${mm.id}]`).join('\n');
  return `• ${m.titulo} — ${m.progreso||0}% [ID:${m.id}]${mms ? '\n' + mms : ''}`;
}).join('\n') || 'ninguna'}

Recordatorios (notas sin ítems):
${ctx.recordatorios.filter(r => r.tipo === 'nota' || r.tipo === 'definicion').map(r => `• ${r.titulo} [ID:${r.id}]`).join('\n') || 'ninguno'}

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

Usuario: "gasté 25000 en mercado de Bancolombia"
Tu respuesta:
  ✅ Listo, registré $25.000 en mercado desde Bancolombia.
  [ACCION:gasto|25000|mercado|alimentacion|abc-123-id-bancolombia]

Usuario: "anota un ingreso de 500000 de freelance en Nequi"
Tu respuesta:
  ✅ Ingreso de $500.000 registrado en Nequi.
  [ACCION:ingreso|500000|freelance|freelance|xyz-456-id-nequi]

Usuario: "saca 30000 de mi caja diaria para gasolina"
Tu respuesta:
  ✅ Saqué $30.000 de Caja diaria para gasolina.
  [ACCION:caja_salida|caja-789-id|30000|gasolina]

EJEMPLOS INCORRECTOS (NO hagas esto):
  ❌ [ACCION: gasto, 25000, mercado]            (usa pipe, no comas; sin espacios sobrantes)
  ❌ [ACCION:gasto|$25.000|mercado]              (monto sin símbolos ni puntos)
  ❌ ACCION:gasto|25000|mercado                  (faltan los corchetes)
  ❌ [ACCION:gasto|25000|mercado|alimentacion|Bancolombia]  (usa el ID, no el nombre)

🚨 REGLA CRÍTICA: CUENTA vs CAJA — NUNCA LAS CONFUNDAS 🚨

Mira el listado de "Cuentas: …" y "Cajas: …" más arriba. Cada uno está separado.
- Si la fuente del dinero está en el listado de CUENTAS (banco/billetera/efectivo):
    → [ACCION:gasto|monto|desc|cat|<cuenta_id>]
    → [ACCION:ingreso|monto|desc|cat|<cuenta_id>]
- Si la fuente del dinero está en el listado de CAJAS:
    → [ACCION:caja_salida|<caja_id>|monto|desc]   (NUNCA gasto)
    → [ACCION:caja_entrada|<caja_id>|monto|desc]  (NUNCA ingreso)

❌ NUNCA hagas esto: [ACCION:gasto|230000|odontologia|salud|4]  cuando "4" es una CAJA.
   El sistema lo va a registrar como gasto normal sin descontar de la caja.
✅ Hazlo así:        [ACCION:caja_salida|4|230000|odontologia]  ← descuenta de la caja correctamente.

Cómo distinguirlas: revisa los IDs listados arriba. Si el ID que mencionó el usuario
aparece en la línea "Cajas:", usa caja_salida/caja_entrada. Si aparece en "Cuentas:",
usa gasto/ingreso. Nunca metas un caja_id en el campo cuenta_id_opcional de gasto/ingreso.

— Movimientos
[ACCION:gasto|monto|descripcion|categoria|cuenta_id_opcional]
[ACCION:ingreso|monto|descripcion|categoria|cuenta_id_opcional]
[ACCION:editar_movimiento|ID|nuevo_monto|nueva_descripcion|nueva_fecha]
  Deja vacíos los campos que NO quieras cambiar. Ej: [ACCION:editar_movimiento|abc123||Almuerzo|]
[ACCION:borrar_movimiento|ID]
— Pagos
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:marcar_pago_pagado|ID]
[ACCION:borrar_pago|ID]
— Eventos y recordatorios
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
[ACCION:recordatorio|texto]
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
— Cuentas (no se crean desde aquí — el usuario las crea en Config)
[ACCION:editar_cuenta|cuenta_id|nuevo_saldo|nuevo_nombre]
  Deja vacíos los campos que NO quieras cambiar. Ej: [ACCION:editar_cuenta|abc||Nuevo nombre]
[ACCION:borrar_cuenta|cuenta_id]
  ⚠️ REQUIERE confirmación del usuario en pantalla — solo emite la acción, el frontend pregunta.

— Cajas (efectivo)
[ACCION:caja_entrada|caja_id|monto|descripcion]
[ACCION:caja_salida|caja_id|monto|descripcion]
[ACCION:editar_caja|caja_id|nuevo_saldo|nuevo_nombre]
  Deja vacíos los campos que NO quieras cambiar.
[ACCION:borrar_caja|caja_id]
  ⚠️ REQUIERE confirmación del usuario en pantalla — solo emite la acción.
[ACCION:borrar_caja_movimiento|caja_movimiento_id]
  Borra un movimiento individual de una caja (no la caja entera). El sistema
  revierte automáticamente el efecto sobre el saldo (si era gasto, suma de
  vuelta; si era ingreso, resta). El ID es el del LISTADO "Movimientos de
  cajas este mes" de arriba — NO confundas con el id de la caja.
  Ejemplo: usuario dice "borra el gasto de odontología de la caja" →
  buscas la fila de odontología en el listado → [ACCION:borrar_caja_movimiento|<id>]

— Transferencias (entre cuentas o cajas)
[ACCION:transferir|origen_tipo|origen_id|destino_tipo|destino_id|monto]
  origen_tipo y destino_tipo deben ser "cuenta" o "caja". Usa los IDs de arriba.
— Metas
[ACCION:meta|titulo|tipo|monto_objetivo|YYYY-MM-DD]
[ACCION:borrar_meta|ID]
[ACCION:completar_micrometa|ID]

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
  Secciones válidas: resumen, movimientos, cajas, pagos, agenda, recordar, metas, ia
  Úsala cuando el usuario diga "llévame a X", "abre Y", "muéstrame Z", "ve a W".
  Ejemplos:
    "llévame a pagos"        → [ACCION:navegar|pagos]
    "abre la agenda"         → [ACCION:navegar|agenda]
    "muéstrame mis metas"    → [ACCION:navegar|metas]
    "ve a movimientos"       → [ACCION:navegar|movimientos]
    "abre cajas"             → [ACCION:navegar|cajas]
    "vuelve al resumen"      → [ACCION:navegar|resumen]
    "ve a recordatorios"     → [ACCION:navegar|recordar]

IMPORTANTE: si el usuario menciona una cuenta o caja específica por nombre, busca su ID en el listado de arriba y úsalo en la acción.

═══ REGLAS ═══
1. NUNCA muestres [ACCION:...] — son invisibles
2. Registra gastos/ingresos INMEDIATAMENTE cuando los mencionen
3. Confirma: "✅ Registré $X en Y"
4. TODO lo que registres aparece visible en la app
5. Respuestas CORTAS — máx 3 líneas salvo análisis
6. Español colombiano, tono cálido y cercano
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

    B) "Recuérdame X" / "Avísame X" SIN hora → pregunta "¿A qué hora
       quieres que te avise?" antes de emitir cualquier acción. Cuando
       el usuario responda con hora, emite [ACCION:evento|...].

    C) "Agéndame pago de X para el día Y" SIN hora → [ACCION:pago|...].
       El batch matutino de las 8am Col le avisará ese día.

    D) "Anota X" / "Guarda lista de Y" / "memo: Z" / definición →
       [ACCION:recordatorio|texto]. Nota persistente, NO se notifica
       individualmente. Solo para info pasiva sin tiempo.

    EJEMPLOS DETERMINANTES:

    Usuario: "recuérdame a las 7am pagar la factura $170.000"
    Tu respuesta:
      ✅ Listo, te aviso mañana a las 7:00 am sobre el pago de $170.000.
      [ACCION:evento|Pagar factura $170.000|2026-05-28|07:00]
    (UNA sola acción. NO crear [ACCION:pago] en paralelo.)

    Usuario: "recuérdame comprar pan"
    Tu respuesta:
      ¿A qué hora quieres que te avise?
    (NO emites ninguna acción hasta tener la hora.)

    Usuario: "agéndame pago luz $80.000 el 15 de junio"
    Tu respuesta:
      ✅ Pago de luz por $80.000 agendado para el 15 de junio.
      [ACCION:pago|Luz|80000|2026-06-15]
    (Sin hora → batch matutino del día.)

    Usuario: "agéndame pago luz $80.000 el 15 de junio a las 9am"
    Tu respuesta:
      ✅ Te aviso el 15 de junio a las 9:00 am del pago de luz $80.000.
      [ACCION:evento|Pago luz $80.000|2026-06-15|09:00]
    (Con hora → evento, NO pago. UNA acción.)

    Usuario: "anota lista de mercado: leche, pan, huevos"
    Tu respuesta:
      ✅ Lista guardada.
      [ACCION:recordatorio|Lista de mercado: leche, pan, huevos]
    (Sin hora — info pasiva, no se notifica.)

    Usuario: "recuérdame el lunes 9am reunión con Juan"
    Tu respuesta:
      ✅ Te aviso el lunes a las 9:00 am de la reunión con Juan.
      [ACCION:evento|Reunión con Juan|<fecha del lunes>|09:00]
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
      [ACCION:evento|Tomar agua|<hoy>|14:35]

    HORA actual = 14:30. Usuario: "avísame en 2 horas hacer la llamada"
    Tu respuesta:
      ✅ Te aviso a las 16:30 sobre la llamada.
      [ACCION:evento|Llamada|<hoy>|16:30]

    HORA actual = 23:50. Usuario: "recuérdame en 30 minutos cerrar la ventana"
    Tu respuesta:
      ✅ Te aviso a las 00:20 (ya cruzaste medianoche) que cierres la ventana.
      [ACCION:evento|Cerrar ventana|<mañana>|00:20]
    (Cruza medianoche → fecha avanza al día siguiente.)

    HORA actual = 14:30. Usuario: "en un rato me acuerdas comprar pan"
    Tu respuesta:
      ¿En cuánto tiempo? Dame los minutos exactos.
    (Frase vaga sin tiempo concreto → pregunta antes de actuar.)

12. ⚠️ INTENCIÓN: CREAR vs CONSULTAR (desambiguación de "agenda").

    "agenda" es AMBIGUA: puede ser el VERBO (crear algo) o el SUSTANTIVO
    (la pantalla de eventos). Decide así:

    VERBOS que indican CREAR → emite la acción correspondiente:
      recuérdame, recordame, agéndame, "agenda" + objeto + tiempo,
      programa, programame, "anota" + objeto + tiempo, "crea" + objeto.

    Palabras que indican CONSULTAR → [ACCION:navegar|agenda] (o la
    sección pedida), SIN crear nada:
      muéstrame, ver, "qué tengo", "qué eventos", "mi agenda" (sola),
      lista, "abre la agenda".

    REGLA DE ORO: si el mensaje trae un OBJETO concreto Y un TIEMPO
    específico, prioriza CREAR sobre CONSULTAR.

    EJEMPLOS:
      "agenda"                               → [ACCION:navegar|agenda]   (consultar)
      "mi agenda" / "qué tengo esta semana"  → [ACCION:navegar|agenda]   (consultar)
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
       (Si es evento aplica la regla 10: necesita HORA exacta; si no la dan, pídela.)

    B) Empieza con un VERBO DE VER (muéstrame, dime, ver, lista, "qué tengo",
       "qué hay", "qué eventos") → CONSULTAR, NO crear. Navega a la sección:
         "muéstrame la agenda" / "dime qué tengo en agenda" → [ACCION:navegar|agenda]
         "qué hay en agenda mañana"                          → [ACCION:navegar|agenda]
         "muéstrame mis listados" / "ver mis recordatorios"  → [ACCION:navegar|recordar]

    C) CASOS ESPECIALES (mandan sobre A). Mira QUÉ viene justo después de "agenda":
       • NADA → consultar:  "agenda" → [ACCION:navegar|agenda]
         (y "listados"/"recordatorios" solos → [ACCION:navegar|recordar])
       • SOLO una palabra de TIEMPO y nada más (hoy/mañana/lunes/una fecha) → consultar:
         "agenda hoy" / "agenda mañana" / "agenda el lunes" → [ACCION:navegar|agenda]
       • CUALQUIER OTRA palabra (para, algo, una, un, el…) aunque incluya un día,
         PERO sin un QUÉ concreto Y una HORA → NO crees ni muestres: PREGUNTA.
         "agenda para mañana" / "agenda algo mañana" / "agenda una cita"
           → responde: "¿Qué quieres agendar y a qué hora?"
       REGLA FINA: "agenda" + <palabra de tiempo SOLA> = mostrar.
                   "agenda" + (relleno como "para"/"algo"/"una"…) = intención de crear
                   → si falta el QUÉ o la HORA, PREGUNTA (nunca muestres la agenda).
                   "agenda" + objeto concreto + hora = CREAR evento (regla 10).

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
    borrado. Si no hay esa pregunta previa, usa "preguntar".`;
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

// ═══ Formatea "YYYY-MM-DD" + "HH:MM" a texto humano en hora Colombia:
// "hoy a las 7:00 am", "mañana a las 2:30 pm", "el lunes 3 de junio a las 9:00 am".
// Usado por el override determinístico de eventos (BUG 2/3) para garantizar que
// la confirmación SIEMPRE incluya día + hora exacta.
function formatearCuando(fecha, hora) {
  const hoy = colombiaDateString();
  const manana = colombiaDateString(new Date(Date.now() + 24 * 3600 * 1000));
  let dia;
  if (fecha === hoy) dia = 'hoy';
  else if (fecha === manana) dia = 'mañana';
  else {
    // colombiaDateLongEs → "lunes, 3 de junio de 2026"; lo dejamos "el lunes 3 de junio".
    const largo = colombiaDateLongEs(new Date(`${fecha}T12:00:00-05:00`));
    dia = 'el ' + largo.replace(/,/g, '').replace(/ de \d{4}$/, '');
  }
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
  console.log(`[saldo] ${opLabel} → ${tabla} "${row.nombre}" (id=${id}) | antes=${antes} | delta=${delta >= 0 ? '+' : ''}${delta} | después=${despues}`);
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

// ═══ EJECUTAR ACCIONES — todo queda visible en la app ═══
async function ejecutarAcciones(respuesta, contexto, userId) {
  console.log('[ejecutarAcciones] respuesta cruda (longitud=' + respuesta.length + '):', JSON.stringify(respuesta));
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  console.log('[ejecutarAcciones] matches encontrados:', matches.length, matches.map(m => m[0]));
  const ejecutadas = [];
  const errores = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0].trim();

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
          monto: parseMontoSeguro(parts[2]), fecha_limite: parts[3], status: 'pendiente'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'marcar_pago_pagado') {
        const { error } = await supabase.from('payments').update({ status: 'pagado' }).eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion, id: parts[1] });

      } else if (accion === 'evento') {
        const titulo = (parts[1] || '').trim();
        const fecha = (parts[2] || '').trim();
        // BUG 3: la hora es OBLIGATORIA para un evento. Normalizar H:MM → HH:MM.
        let hora = (parts[3] || '').trim();
        const mHora = hora.match(/^(\d{1,2}):(\d{2})$/);
        if (!titulo || !fecha || !mHora) {
          console.warn('[evento] sin hora/fecha válida, no se crea:', JSON.stringify(parts));
          ejecutadas.push({ accion: 'evento', error: 'sin_hora', titulo });
          continue;
        }
        hora = `${mHora[1].padStart(2, '0')}:${mHora[2]}`;
        // BUG 2 (REGLA 3): el cron notifica con ventanas relativas a "ahora" hacia
        // adelante; una hora ya pasada (>15 min) nunca dispararía. No la programamos.
        const cuando = new Date(`${fecha}T${hora}:00-05:00`);
        if (isNaN(cuando.getTime()) || cuando.getTime() < Date.now() - 15 * 60 * 1000) {
          console.warn('[evento] hora pasada o inválida, no se crea:', fecha, hora);
          ejecutadas.push({ accion: 'evento', error: 'hora_pasada', titulo });
          continue;
        }
        const { data: ev, error } = await supabase.from('events').insert({
          user_id: userId, titulo, fecha, hora, nota: 'Creado por IA'
        }).select().single();
        if (error || !ev) {
          console.error('[evento] insert events falló:', error?.message);
          ejecutadas.push({ accion: 'evento', error: 'db', titulo });
        } else {
          ejecutadas.push({ accion: 'evento', ok: true, id: ev.id, titulo, fecha, hora });
        }

      } else if (accion === 'recordatorio') {
        const { error } = await supabase.from('reminders').insert({
          user_id: userId, tipo: 'nota', titulo: parts[1],
          content: { texto: parts[1] }, fecha: colombiaDateString()
        });
        if (error) {
          console.error('[recordatorio] insert reminders falló:', error.message);
          ejecutadas.push({ accion: 'recordatorio', error: 'db', detalle: parts[1] });
        } else {
          ejecutadas.push({ accion: 'recordatorio', ok: true, detalle: parts[1] });
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
        const validas = ['resumen','movimientos','cajas','pagos','agenda','recordar','metas','ia'];
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
