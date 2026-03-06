// /api/ai-chat.js
// Chat IA con acceso completo a datos + memoria persistente

const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje requerido' });

  try {
    const { data: cfgRow } = await supabase
      .from('config').select('value').eq('key', 'ia').single();
    const cfg = cfgRow?.value || {};

    // Construir contexto financiero completo
    const contexto = await buildContexto();

    // Cargar memoria de IA
    const { data: memorias } = await supabase
      .from('ai_memory')
      .select('contenido, tipo')
      .order('importancia', { ascending: false })
      .limit(20);

    const memoriaTxt = (memorias || [])
      .map(m => `[${m.tipo}] ${m.contenido}`)
      .join('\n');

    const systemPrompt = buildSystemPrompt(contexto, memoriaTxt, cfg);

    // Llamar a IA
    let respuesta = '';
    const proveedor = cfg.proveedor || 'groq';

    if (proveedor === 'groq') {
      respuesta = await llamarGroq(systemPrompt, history, message, cfg);
    } else if (proveedor === 'claude') {
      respuesta = await llamarClaude(systemPrompt, history, message, cfg);
    } else if (proveedor === 'gemini') {
      respuesta = await llamarGemini(systemPrompt, history, message, cfg);
    }

    // Ejecutar acciones si las hay
    const acciones = await ejecutarAcciones(respuesta, message);

    // Guardar aprendizaje si IA detectó algo útil
    await guardarMemoria(message, respuesta);

    return res.json({
      ok: true,
      respuesta,
      acciones
    });

  } catch (error) {
    console.error('AI chat error:', error);
    return res.status(500).json({ error: error.message });
  }
};

async function buildContexto() {
  const [
    { data: cuentas },
    { data: movsMes },
    { data: pagos },
    { data: eventos },
    { data: emailAccounts },
    { data: ultimoSync }
  ] = await Promise.all([
    supabase.from('accounts').select('*'),
    supabase.from('movements').select('*')
      .gte('fecha', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0])
      .order('fecha', { ascending: false }).limit(20),
    supabase.from('payments').select('*').neq('status', 'pagado'),
    supabase.from('events').select('*')
      .gte('fecha', new Date().toISOString().split('T')[0])
      .order('fecha').limit(5),
    supabase.from('email_accounts').select('email, tipo, ultimo_sync').eq('activo', true),
    supabase.from('config').select('value').eq('key', 'sync').single()
  ]);

  const totalSaldo = (cuentas || []).reduce((a, c) => a + parseFloat(c.saldo || 0), 0);
  const ingresosMes = (movsMes || []).filter(m => m.tipo === 'ingreso').reduce((a, m) => a + parseFloat(m.monto), 0);
  const gastosMes = (movsMes || []).filter(m => m.tipo === 'gasto').reduce((a, m) => a + parseFloat(m.monto), 0);

  return {
    totalSaldo, ingresosMes, gastosMes,
    cuentas: cuentas || [],
    movimientos: movsMes || [],
    pagos: pagos || [],
    eventos: eventos || [],
    correos: emailAccounts || [],
    ultimoSync: ultimoSync?.value?.ultima_sync
  };
}

function buildSystemPrompt(ctx, memoria, cfg) {
  const fmt = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(n);
  const nombre = cfg.usuarioNombre || 'usuario';
  const iaName = cfg.nombre || 'Ana';

  return `Eres ${iaName}, asistente financiero IA de ${nombre}. Tienes acceso COMPLETO y TIEMPO REAL a sus finanzas.

═══ SITUACIÓN FINANCIERA ACTUAL ═══
Saldo total: ${fmt(ctx.totalSaldo)}
Cuentas: ${ctx.cuentas.map(c => `${c.nombre}(${fmt(c.saldo)})`).join(', ') || 'ninguna'}
Ingresos este mes: ${fmt(ctx.ingresosMes)}
Gastos este mes: ${fmt(ctx.gastosMes)}
Balance del mes: ${fmt(ctx.ingresosMes - ctx.gastosMes)}

Últimos movimientos:
${ctx.movimientos.slice(0, 8).map(m => `• ${m.tipo === 'ingreso' ? '+' : '-'}${fmt(m.monto)} — ${m.descripcion} (${m.fecha})`).join('\n') || 'ninguno'}

Pagos pendientes:
${ctx.pagos.map(p => `• ${p.nombre}: ${fmt(p.monto)} vence ${p.fecha_limite}`).join('\n') || 'ninguno'}

Próximos eventos:
${ctx.eventos.map(e => `• ${e.titulo} el ${e.fecha}${e.hora ? ' a las ' + e.hora : ''}`).join('\n') || 'ninguno'}

Correos conectados: ${ctx.correos.map(c => `${c.email}(${c.tipo})`).join(', ') || 'ninguno'}
Último sync correos: ${ctx.ultimoSync || 'nunca'}

═══ MEMORIA (lo que he aprendido) ═══
${memoria || 'Sin aprendizajes previos aún'}

═══ LO QUE PUEDES HACER ═══
Incluye comandos al final de tu respuesta:
[ACCION:gasto|monto|descripcion|categoria]
[ACCION:ingreso|monto|descripcion|categoria]
[ACCION:pago|nombre|monto|YYYY-MM-DD]
[ACCION:evento|titulo|YYYY-MM-DD|HH:MM]
[ACCION:recordatorio|nota|texto]
[ACCION:memoria|aprendizaje importante sobre el usuario]

═══ REGLAS ═══
- Responde siempre en español, tono amigable
- Analiza patrones cuando el usuario pregunte
- Si detectas algo inusual en los gastos, menciónalo
- Cuando ejecutes una acción, confírmalo
- Nunca digas que no tienes acceso — tienes acceso a todo
- Hoy es ${new Date().toLocaleDateString('es-CO')}`;
}

async function llamarGroq(system, history, message, cfg) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: cfg.modelo || 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages: [
        { role: 'system', content: system },
        ...history.slice(-10),
        { role: 'user', content: message }
      ]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content;
}

async function llamarClaude(system, history, message, cfg) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: cfg.modelo || 'claude-haiku-4-5',
      max_tokens: 600,
      system,
      messages: [...history.slice(-10), { role: 'user', content: message }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

async function llamarGemini(system, history, message, cfg) {
  const modelo = cfg.modelo || 'gemini-1.5-flash';
  const msgs = [
    { role: 'user', parts: [{ text: system }] },
    { role: 'model', parts: [{ text: 'Entendido, estoy listo.' }] },
    ...history.slice(-8).map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })),
    { role: 'user', parts: [{ text: message }] }
  ];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: msgs, generationConfig: { maxOutputTokens: 600 } })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
}

async function ejecutarAcciones(respuesta, mensaje) {
  const matches = [...respuesta.matchAll(/\[ACCION:([^\]]+)\]/g)];
  const ejecutadas = [];

  for (const match of matches) {
    const parts = match[1].split('|');
    const accion = parts[0];

    try {
      if (accion === 'gasto' || accion === 'ingreso') {
        const monto = parseFloat(parts[1]);
        const desc = parts[2] || 'Sin descripción';
        const cat = parts[3] || 'otro';
        if (monto > 0) {
          const { data: acct } = await supabase.from('accounts').select('id').limit(1).single();
          await supabase.from('movements').insert({
            tipo: accion, descripcion: desc, monto, fecha: new Date().toISOString().split('T')[0],
            account_id: acct?.id, categoria: cat, source: 'ia'
          });
          ejecutadas.push({ accion, detalle: `${accion} ${monto} ${desc}` });
        }
      } else if (accion === 'pago') {
        const { data: acct } = await supabase.from('accounts').select('id').limit(1).single();
        await supabase.from('payments').insert({
          nombre: parts[1], monto: parseFloat(parts[2]),
          fecha_limite: parts[3], account_id: acct?.id
        });
        ejecutadas.push({ accion, detalle: `Pago ${parts[1]}` });
      } else if (accion === 'evento') {
        await supabase.from('events').insert({
          titulo: parts[1], fecha: parts[2], hora: parts[3] || null, nota: 'Creado por IA'
        });
        ejecutadas.push({ accion, detalle: `Evento ${parts[1]}` });
      } else if (accion === 'recordatorio') {
        await supabase.from('reminders').insert({
          tipo: parts[1] || 'nota', titulo: parts[2],
          content: { texto: parts[2] }, fecha: new Date().toISOString().split('T')[0]
        });
        ejecutadas.push({ accion, detalle: `Recordatorio ${parts[2]}` });
      } else if (accion === 'memoria') {
        await supabase.from('ai_memory').insert({
          tipo: 'usuario', contenido: parts[1], importancia: 2
        });
        ejecutadas.push({ accion: 'memoria', detalle: 'Aprendizaje guardado' });
      }
    } catch (e) {
      console.error('Error ejecutando acción IA:', e.message);
    }
  }
  return ejecutadas;
}

async function guardarMemoria(mensaje, respuesta) {
  // Si la IA detectó un patrón o hecho importante, guardarlo
  const patronesImportantes = [
    /siempre gast/i, /pattern|patrón/i, /nota que/i, /observo que/i,
    /tu perfil/i, /tiendes a/i
  ];
  if (patronesImportantes.some(p => p.test(respuesta))) {
    const resumen = respuesta.substring(0, 200);
    await supabase.from('ai_memory').insert({
      tipo: 'patron_detectado',
      contenido: `[${new Date().toLocaleDateString('es-CO')}] ${resumen}`,
      importancia: 3
    }).catch(() => {});
  }
}
