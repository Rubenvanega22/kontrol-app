// /api/ai-analysis.js
// Análisis automático diario — IA se autocritica y mejora
// Se ejecuta cada día a las 8am (Vercel Cron)

const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  try {
    const { data: cfg } = await supabase.from('config').select('value').eq('key', 'ia').single();
    const iaConfig = cfg?.value || {};

    // 1. Recopilar datos del mes
    const hoy = new Date();
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().split('T')[0];

    const [
      { data: movimientos },
      { data: emailLogs },
      { data: memorias }
    ] = await Promise.all([
      supabase.from('movements').select('*').gte('fecha', inicioMes),
      supabase.from('email_logs').select('*').gte('created_at', inicioMes),
      supabase.from('ai_memory').select('*').order('importancia', { ascending: false }).limit(30)
    ]);

    // 2. Calcular métricas de rendimiento
    const emailsProcesados = emailLogs?.filter(e => e.procesado).length || 0;
    const emailsTotal = emailLogs?.length || 0;
    const tasaExito = emailsTotal > 0 ? Math.round((emailsProcesados / emailsTotal) * 100) : 0;

    const movAutoEmail = movimientos?.filter(m => m.source === 'email').length || 0;
    const movManuales = movimientos?.filter(m => m.source === 'manual').length || 0;
    const movIA = movimientos?.filter(m => m.source === 'ia').length || 0;

    // 3. Análisis de gastos por categoría
    const gastos = movimientos?.filter(m => m.tipo === 'gasto') || [];
    const porCategoria = {};
    gastos.forEach(g => {
      porCategoria[g.categoria] = (porCategoria[g.categoria] || 0) + parseFloat(g.monto);
    });
    const topCategorias = Object.entries(porCategoria)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, monto]) => `${cat}: $${Math.round(monto).toLocaleString('es-CO')}`);

    // 4. Generar análisis con IA
    const prompt = `Eres un sistema de IA financiero que se autoevalúa y mejora.

MÉTRICAS DE ESTE MES:
- Correos bancarios detectados: ${emailsProcesados}/${emailsTotal} (${tasaExito}% tasa de éxito)
- Movimientos auto-detectados: ${movAutoEmail}
- Movimientos manuales: ${movManuales}
- Movimientos creados por IA: ${movIA}
- Top categorías de gasto: ${topCategorias.join(', ') || 'sin datos'}
- Total movimientos: ${movimientos?.length || 0}

MEMORIA ACUMULADA:
${memorias?.map(m => `[${m.tipo}] ${m.contenido}`).join('\n') || 'Sin memoria previa'}

Genera un informe en JSON con este formato exacto:
{
  "resumen": "2-3 oraciones sobre el estado financiero",
  "logros": ["logro 1", "logro 2"],
  "fallas_detectadas": ["falla 1 con solución propuesta"],
  "recomendaciones": ["recomendación 1 para el usuario"],
  "mejoras_ia": ["qué puede hacer la IA mejor"],
  "alerta": "null o mensaje urgente si hay algo preocupante"
}
Responde SOLO el JSON, sin markdown.`;

    let analisis = null;
    try {
      const res2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      const data = await res2.json();
      const txt = data.choices?.[0]?.message?.content || '{}';
      analisis = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch (e) {
      analisis = {
        resumen: 'Análisis automático completado.',
        logros: [`${emailsProcesados} correos bancarios procesados`],
        fallas_detectadas: [],
        recomendaciones: [],
        mejoras_ia: [],
        alerta: null
      };
    }

    // 5. Guardar análisis en memoria
    await supabase.from('ai_memory').insert({
      tipo: 'analisis_automatico',
      contenido: JSON.stringify({ fecha: hoy.toISOString().split('T')[0], ...analisis }),
      importancia: 5
    });

    // 6. Si hay alerta, enviar por WhatsApp
    if (analisis.alerta && analisis.alerta !== 'null') {
      const { data: cfgNotif } = await supabase
        .from('config').select('value').eq('key', 'notificaciones').single();
      const notifCfg = cfgNotif?.value || {};

      if (notifCfg.whatsapp_enabled && notifCfg.whatsapp_numero) {
        await supabase.from('whatsapp_alerts').insert({
          tipo: 'alerta_ia',
          mensaje: `🧠 *Kontrol IA — Alerta*\n\n${analisis.alerta}`,
          telefono: notifCfg.whatsapp_numero
        });
      }
    }

    return res.json({
      ok: true,
      fecha: hoy.toISOString().split('T')[0],
      metricas: { emailsProcesados, emailsTotal, tasaExito, movAutoEmail },
      analisis
    });

  } catch (error) {
    console.error('AI analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
};
