// /api/ai-chat.js — Claude + Mem0 memoria profesional
const supabase = require('../lib/supabase');

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

    // 4. Llamar al LLM
    //    - voz=true sin imagen → Groq llama-3.1-8b-instant (más rápido, ~300-800ms)
    //    - cualquier otro caso → Claude (default, soporta visión)
    const respuesta = (voz && !imagen_base64)
      ? await llamarGroq(systemPrompt, history, message, 150)
      : await llamarClaude(systemPrompt, history, message, imagen_base64, voz ? 150 : 600);
    const respuestaLimpia = respuesta
      .replace(/\[ACCION:[^\]]+\]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 5. Ejecutar acciones (registrar gastos, eventos, etc.)
    const accionesIntencion = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)].length;
    const acciones = await ejecutarAcciones(respuesta, contexto, user_id);

    // 5b. Verificación con Claude — si hubo intención de ejecutar acciones,
    // pedirle que confirme con base en lo que realmente se ejecutó.
    let respuestaFinal = respuestaLimpia;
    if (accionesIntencion > 0) {
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
  const [
    { data: cuentas },
    { data: movsMes },
    { data: movsRecientes },
    { data: pagos },
    { data: eventos },
    { data: cajas },
    { data: metas },
    { data: recordatorios }
  ] = await Promise.all([
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('movements').select('*').eq('user_id', userId)
      .gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
      .order('fecha', { ascending: false }).limit(50),
    supabase.from('movements').select('*').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('payments').select('*').eq('user_id', userId).neq('status', 'pagado'),
    supabase.from('events').select('*').eq('user_id', userId)
      .gte('fecha', new Date().toISOString().split('T')[0]).order('fecha').limit(10),
    supabase.from('cajas').select('*').eq('user_id', userId),
    supabase.from('metas').select('*, micrometas(*)').eq('user_id', userId).eq('estado', 'activa'),
    supabase.from('reminders').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
  ]);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const totalCajas = (cajas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const esReal = m => m.categoria !== 'caja' && m.categoria !== 'transferencia';
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso' && esReal(m)).reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto' && esReal(m)).reduce((a, m) => a + parseFloat(m.monto), 0);

  return {
    totalSaldo, totalCajas, ingresosMes, gastosMes,
    cuentas: cuentas || [], movimientos: movsMes || [],
    movsRecientes: movsRecientes || [], pagos: pagos || [],
    eventos: eventos || [], cajas: cajas || [], metas: metas || [],
    recordatorios: recordatorios || []
  };
}

// ═══ SYSTEM PROMPT ═══
function buildSystemPrompt(ctx, memoria) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const hoy = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `⚠️ REGLA DE ORO (PRIORIDAD MÁXIMA): Cuando el usuario mencione un gasto, SIEMPRE pregunta primero de qué cuenta o caja sale el dinero, listando las cuentas disponibles con sus saldos. NUNCA ejecutes [ACCION:gasto] sin que el usuario haya confirmado la fuente. Excepción: si el usuario ya mencionó explícitamente la cuenta en el mismo mensaje.

Eres Ana, agente financiero personal. Tienes MEMORIA COMPLETA del usuario y acceso TOTAL a sus finanzas.

HOY: ${hoy}

═══ LO QUE SABES DEL USUARIO (memoria persistente) ═══
${memoria || 'Primera vez que hablas con este usuario — aprende todo lo posible.'}

═══ ESTADO FINANCIERO EN TIEMPO REAL ═══
Total bancos: ${fmt(ctx.totalSaldo)}
Total efectivo: ${fmt(ctx.totalCajas)}
TOTAL DISPONIBLE: ${fmt(ctx.totalSaldo + ctx.totalCajas)}

Cuentas: ${ctx.cuentas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Cajas: ${ctx.cajas.map(c => `${c.nombre}(${fmt(c.saldo)})[ID:${c.id}]`).join(' | ') || 'ninguna'}
Mes: Ingresos ${fmt(ctx.ingresosMes)} | Gastos ${fmt(ctx.gastosMes)} | Balance ${fmt(ctx.ingresosMes - ctx.gastosMes)}

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

Recordatorios recientes:
${ctx.recordatorios.map(r => {
  const tipoEmoji = r.tipo === 'lista' ? '✅' : r.tipo === 'definicion' ? '📖' : '📝';
  return `• ${tipoEmoji} ${r.titulo} (${r.fecha || ''}) [ID:${r.id}]`;
}).join('\n') || 'ninguno'}

═══ ACCIONES INVISIBLES — úsalas al final de tu respuesta ═══
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
  Usa el ID del listado "Recordatorios recientes" de arriba.
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

— Transferencias (entre cuentas o cajas)
[ACCION:transferir|origen_tipo|origen_id|destino_tipo|destino_id|monto]
  origen_tipo y destino_tipo deben ser "cuenta" o "caja". Usa los IDs de arriba.
— Metas
[ACCION:meta|titulo|tipo|monto_objetivo|YYYY-MM-DD]
[ACCION:borrar_meta|ID]
[ACCION:completar_micrometa|ID]

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
8. Si te preguntan qué recuerdas → cuéntale todo`;
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

// ═══ EJECUTAR ACCIONES — todo queda visible en la app ═══
async function ejecutarAcciones(respuesta, contexto, userId) {
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  const ejecutadas = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0].trim();

    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseFloat(parts[1]);
        const desc = (parts[2] || 'Sin descripción').trim();
        const cat = (parts[3] || 'otro').trim();
        const cuentaIdEspecificada = (parts[4] || '').trim();
        if (!monto || monto <= 0) continue;

        const cuenta = cuentaIdEspecificada
          ? contexto.cuentas.find(c => c.id === cuentaIdEspecificada)
          : contexto.cuentas[0];
        const cuentaId = cuenta?.id || null;

        const { data: mov, error } = await supabase
          .from('movements')
          .insert({
            user_id: userId, tipo: accion, descripcion: desc,
            monto, fecha: new Date().toISOString().split('T')[0],
            account_id: cuentaId, categoria: cat, source: 'ia'
          })
          .select().single();

        if (error) { console.error('Error movimiento:', error.message); continue; }

        if (cuenta) {
          const saldo = parseFloat(cuenta.saldo || 0);
          const nuevo = accion === 'ingreso' ? saldo + monto : saldo - monto;
          await supabase.from('accounts').update({ saldo: nuevo }).eq('id', cuenta.id).eq('user_id', userId);
        }
        ejecutadas.push({ accion, monto, desc, id: mov.id, cuenta_id: cuentaId });

      } else if (accion === 'editar_movimiento') {
        const movId = parts[1];
        const nuevoMonto = parts[2] && !isNaN(parseFloat(parts[2])) ? parseFloat(parts[2]) : null;
        const nuevaDesc = (parts[3] || '').trim() || null;
        const nuevaFecha = (parts[4] || '').trim() || null;
        const movActual = contexto.movimientos.find(m => m.id === movId) || contexto.movsRecientes.find(m => m.id === movId);
        const updates = {};
        if (nuevoMonto !== null) updates.monto = nuevoMonto;
        if (nuevaDesc) updates.descripcion = nuevaDesc;
        if (nuevaFecha) updates.fecha = nuevaFecha;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('movements').update(updates).eq('id', movId).eq('user_id', userId);
          if (!error) {
            if (nuevoMonto !== null && movActual && movActual.account_id) {
              const cuenta = contexto.cuentas.find(c => c.id === movActual.account_id);
              if (cuenta) {
                const diff = nuevoMonto - parseFloat(movActual.monto);
                const ajuste = movActual.tipo === 'ingreso' ? diff : -diff;
                await supabase.from('accounts').update({ saldo: parseFloat(cuenta.saldo) + ajuste }).eq('id', cuenta.id);
              }
            }
            ejecutadas.push({ accion, id: movId, cambios: updates });
          }
        }

      } else if (accion === 'borrar_movimiento') {
        const movId = parts[1];
        const mov = contexto.movimientos.find(m => m.id === movId) || contexto.movsRecientes.find(m => m.id === movId);
        if (mov && mov.account_id) {
          const cuenta = contexto.cuentas.find(c => c.id === mov.account_id);
          if (cuenta) {
            const ajuste = mov.tipo === 'ingreso' ? -parseFloat(mov.monto) : parseFloat(mov.monto);
            await supabase.from('accounts').update({ saldo: parseFloat(cuenta.saldo) + ajuste }).eq('id', cuenta.id);
          }
        }
        const { error } = await supabase.from('movements').delete().eq('id', movId).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'movimiento', id: movId });

      } else if (accion === 'borrar_pago') {
        const { error } = await supabase.from('payments').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'pago' });

      } else if (accion === 'borrar_evento') {
        const { error } = await supabase.from('events').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'evento' });

      } else if (accion === 'borrar_recordatorio') {
        const { error } = await supabase.from('reminders').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'recordatorio', id: parts[1] });

      } else if (accion === 'borrar_meta') {
        const { error } = await supabase.from('metas').delete().eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion: 'borrado', tipo: 'meta' });

      } else if (accion === 'pago') {
        const { error } = await supabase.from('payments').insert({
          user_id: userId, nombre: parts[1],
          monto: parseFloat(parts[2]), fecha_limite: parts[3], status: 'pendiente'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'marcar_pago_pagado') {
        const { error } = await supabase.from('payments').update({ status: 'pagado' }).eq('id', parts[1]).eq('user_id', userId);
        if (!error) ejecutadas.push({ accion, id: parts[1] });

      } else if (accion === 'evento') {
        const { error } = await supabase.from('events').insert({
          user_id: userId, titulo: parts[1],
          fecha: parts[2], hora: parts[3] || null, nota: 'Creado por IA'
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'recordatorio') {
        const { error } = await supabase.from('reminders').insert({
          user_id: userId, tipo: 'nota', titulo: parts[1],
          content: { texto: parts[1] }, fecha: new Date().toISOString().split('T')[0]
        });
        if (!error) ejecutadas.push({ accion, detalle: parts[1] });

      } else if (accion === 'meta') {
        const { error } = await supabase.from('metas').insert({
          user_id: userId, titulo: parts[1], tipo: parts[2] || 'personal',
          monto_objetivo: parseFloat(parts[3]) || null,
          fecha_limite: parts[4] || null,
          año: new Date().getFullYear(), estado: 'activa', progreso: 0
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
        const monto = parseFloat(parts[5]);
        if (monto > 0 && (origenTipo === 'cuenta' || origenTipo === 'caja') && (destinoTipo === 'cuenta' || destinoTipo === 'caja')) {
          const tablaOrigen = origenTipo === 'caja' ? 'cajas' : 'accounts';
          const tablaDestino = destinoTipo === 'caja' ? 'cajas' : 'accounts';
          const fuenteOrigen = origenTipo === 'caja' ? contexto.cajas : contexto.cuentas;
          const fuenteDestino = destinoTipo === 'caja' ? contexto.cajas : contexto.cuentas;
          const origen = fuenteOrigen.find(x => x.id === origenId);
          const destino = fuenteDestino.find(x => x.id === destinoId);
          if (origen && destino) {
            await supabase.from(tablaOrigen).update({ saldo: parseFloat(origen.saldo) - monto }).eq('id', origenId);
            await supabase.from(tablaDestino).update({ saldo: parseFloat(destino.saldo) + monto }).eq('id', destinoId);
            const fecha = new Date().toISOString().split('T')[0];
            await supabase.from('movements').insert([
              {
                user_id: userId, tipo: 'gasto',
                descripcion: `Transferencia a ${destinoTipo} ${destino.nombre}`,
                monto, fecha,
                account_id: origenTipo === 'cuenta' ? origenId : null,
                categoria: 'transferencia', source: 'ia'
              },
              {
                user_id: userId, tipo: 'ingreso',
                descripcion: `Transferencia desde ${origenTipo} ${origen.nombre}`,
                monto, fecha,
                account_id: destinoTipo === 'cuenta' ? destinoId : null,
                categoria: 'transferencia', source: 'ia'
              }
            ]);
            ejecutadas.push({ accion, monto, origen: `${origenTipo}:${origen.nombre}`, destino: `${destinoTipo}:${destino.nombre}` });
          }
        }

      } else if (accion === 'caja_entrada' || accion === 'caja_salida') {
        const cajaId = (parts[1] || '').trim();
        const monto = parseFloat(parts[2]);
        const desc = (parts[3] || (accion === 'caja_entrada' ? 'Entrada de caja' : 'Salida de caja')).trim();
        const caja = contexto.cajas.find(c => c.id === cajaId);
        if (caja && monto > 0) {
          const nuevoSaldo = accion === 'caja_entrada'
            ? parseFloat(caja.saldo) + monto
            : parseFloat(caja.saldo) - monto;
          await supabase.from('cajas').update({ saldo: nuevoSaldo }).eq('id', cajaId);
          const tipoMov = accion === 'caja_entrada' ? 'ingreso' : 'gasto';
          await supabase.from('movements').insert({
            user_id: userId, tipo: tipoMov,
            descripcion: `${desc} — ${caja.nombre} [caja:${cajaId}]`,
            monto, fecha: new Date().toISOString().split('T')[0],
            account_id: null, categoria: 'caja', source: 'ia'
          });
          ejecutadas.push({ accion, monto, desc, caja: caja.nombre, nuevo_saldo: nuevoSaldo });
        }

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
        if (nuevoSaldoStr && !isNaN(parseFloat(nuevoSaldoStr))) updates.saldo = parseFloat(nuevoSaldoStr);
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
        if (nuevoSaldoStr && !isNaN(parseFloat(nuevoSaldoStr))) updates.saldo = parseFloat(nuevoSaldoStr);
        if (nuevoNombre) updates.nombre = nuevoNombre;
        if (Object.keys(updates).length > 0) {
          const { error } = await supabase.from('cajas').update(updates).eq('id', cajaId).eq('user_id', userId);
          if (!error) ejecutadas.push({ accion, id: cajaId, cambios: updates });
        }

      } else if (accion === 'borrar_cuenta') {
        // NO eliminar acá — devolver confirmación requerida para el frontend
        const cuentaId = (parts[1] || '').trim();
        const cuenta = contexto.cuentas.find(c => c.id === cuentaId);
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
        const caja = contexto.cajas.find(c => c.id === cajaId);
        if (caja) {
          ejecutadas.push({
            accion,
            confirmacion_requerida: true,
            tipo: 'caja',
            id: cajaId,
            nombre: caja.nombre
          });
        }
      }
    } catch(e) {
      console.error('Error acción:', accion, e.message);
    }
  }
  return ejecutadas;
}
