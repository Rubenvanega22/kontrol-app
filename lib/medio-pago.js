// /lib/medio-pago.js — Medio con que se pagó (efectivo, tarjeta, Nequi) y límites mensuales.
const supabase = require('./supabase');
const { colombiaDateString } = require('./datetime');

const MEDIOS = ['efectivo', 'tarjeta', 'nequi'];
const NOMBRE_MEDIO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', nequi: 'Nequi' };
const PREGUNTA_MEDIO = '¿Con qué lo pagaste: efectivo, tarjeta o Nequi?';

// El código lee el medio, no la IA. Si nombra dos medios distintos no se adivina.
function medioDelTexto(texto) {
  const t = String(texto || '').toLowerCase();
  const hallados = new Set();
  if (/\b(efectivo|cash|billetes?)\b/.test(t)) hallados.add('efectivo');
  if (/\b(tarjeta|tc|cr[eé]dito|d[eé]bito|dat[aá]fono)\b/.test(t)) hallados.add('tarjeta');
  if (/\bnequi\b/.test(t)) hallados.add('nequi');
  return hallados.size === 1 ? [...hallados][0] : null;
}

const fmtPesos = n => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Lo pagado del mes por medio: los mismos pagos que suma la tarjeta verde de la app
// (pagados con fecha límite en el mes en curso).
async function pagadoPorMedio(userId, mes) {
  const [a, m] = mes.split('-').map(Number);
  const desde = `${mes}-01`;
  const hasta = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  const { data, error } = await supabase.from('payments').select('monto, medio_pago')
    .eq('user_id', userId).eq('status', 'pagado').not('medio_pago', 'is', null)
    .gte('fecha_limite', desde).lt('fecha_limite', hasta);
  if (error) throw new Error(error.message);
  const tot = { efectivo: 0, tarjeta: 0, nequi: 0 };
  for (const p of data || []) if (tot[p.medio_pago] != null) tot[p.medio_pago] += Number(p.monto) || 0;
  return tot;
}

function mensajeLimite(medio, nivel, usado, limite) {
  const cifras = `${fmtPesos(usado)} de ${fmtPesos(limite)}`;
  return nivel === 100
    ? `🔴 Llegaste a tu límite de ${NOMBRE_MEDIO[medio]} de este mes: ${cifras}.`
    : `⚠️ Ya vas en el 80 % de tu límite de ${NOMBRE_MEDIO[medio]} de este mes: ${cifras}.`;
}

// Devuelve los avisos de límite que tocan ahora y los deja reclamados: cada nivel sale una
// vez por mes. Si se pasa directo al 100 %, el 80 % se da por avisado y solo sale el 100 %.
// `perfil` evita releer los límites cuando el que llama ya los tiene.
async function avisosDeLimite(userId, perfil) {
  try {
    let p = perfil;
    if (!p) {
      const { data, error } = await supabase.from('profiles')
        .select('limite_efectivo, limite_tarjeta, limite_nequi').eq('id', userId).maybeSingle();
      if (error) throw new Error(error.message);
      p = data;
    }
    const conLimite = MEDIOS.filter(m => Number(p?.[`limite_${m}`]) > 0);
    if (!conLimite.length) return [];
    const mes = colombiaDateString().slice(0, 7);
    const usado = await pagadoPorMedio(userId, mes);
    const mensajes = [];
    for (const medio of conLimite) {
      const limite = Number(p[`limite_${medio}`]);
      const pct = usado[medio] / limite * 100;
      const niveles = pct >= 100 ? [80, 100] : pct >= 80 ? [80] : [];
      if (!niveles.length) continue;
      const { data: nuevos, error } = await supabase.from('pagos_limite_avisos')
        .upsert(niveles.map(nivel => ({ user_id: userId, mes, medio, nivel })),
          { onConflict: 'user_id,mes,medio,nivel', ignoreDuplicates: true })
        .select('nivel');
      if (error) { console.error('[limites] reclamo falló:', error.message); continue; }
      const reclamados = (nuevos || []).map(n => n.nivel);
      if (!reclamados.length) continue;
      const nivel = Math.max(...reclamados);
      mensajes.push({ medio, nivel, mes, texto: mensajeLimite(medio, nivel, usado[medio], limite) });
    }
    return mensajes;
  } catch (e) {
    console.error('[limites] error:', e.message);
    return [];
  }
}

// Si el aviso no pudo salir, se suelta el reclamo para que el próximo intento lo envíe.
async function soltarAviso(userId, { mes, medio, nivel }) {
  const niveles = nivel === 100 ? [80, 100] : [80];
  await supabase.from('pagos_limite_avisos').delete()
    .eq('user_id', userId).eq('mes', mes).eq('medio', medio).in('nivel', niveles);
}

module.exports = { MEDIOS, NOMBRE_MEDIO, PREGUNTA_MEDIO, medioDelTexto, avisosDeLimite, soltarAviso };
