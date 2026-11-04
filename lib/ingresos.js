// /lib/ingresos.js — Ingresos de la Caja: medio (banco, Nequi, efectivo) y topes mensuales.
const supabase = require('./supabase');
const { colombiaDateString } = require('./datetime');

const MEDIOS_ING = ['banco', 'nequi', 'efectivo'];
const NOMBRE_MEDIO_ING = { banco: 'Banco', nequi: 'Nequi', efectivo: 'Efectivo' };
const fmtPesos = n => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// El código lee el medio, no la IA. Si nombra dos medios distintos no se adivina.
function medioIngresoDelTexto(texto) {
  const t = String(texto || '').toLowerCase();
  const hallados = new Set();
  if (/\b(banco|cuenta|consignaci[oó]n|consignaron|transferencia|bancolombia|davivienda|bbva)\b/.test(t)) hallados.add('banco');
  if (/\bnequi\b/.test(t)) hallados.add('nequi');
  if (/\b(efectivo|cash|billetes?)\b/.test(t)) hallados.add('efectivo');
  return hallados.size === 1 ? [...hallados][0] : null;
}

function rangoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return { desde: `${mes}-01`, hasta: m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01` };
}

// Lo que entró en el mes por medio. Los mismos ingresos que suma la tarjeta verde.
async function ingresadoPorMedio(userId, mes) {
  const { desde, hasta } = rangoMes(mes);
  const { data, error } = await supabase.from('ingresos').select('monto, medio')
    .eq('user_id', userId).gte('fecha', desde).lt('fecha', hasta);
  if (error) throw new Error(error.message);
  const tot = { banco: 0, nequi: 0, efectivo: 0 };
  for (const i of data || []) if (tot[i.medio] != null) tot[i.medio] += Number(i.monto) || 0;
  return tot;
}

async function topesDe(userId) {
  const { data, error } = await supabase.from('profiles')
    .select('tope_banco, tope_nequi, tope_efectivo').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data || {};
}

function mensajeTope(medio, nivel, usado, tope) {
  const cifras = `${fmtPesos(usado)} de ${fmtPesos(tope)}`;
  return nivel === 100
    ? `🔴 Llegaste a tu tope de ${NOMBRE_MEDIO_ING[medio]} de este mes: ${cifras}.`
    : `⚠️ Ya vas en el 80 % de tu tope de ${NOMBRE_MEDIO_ING[medio]} de este mes: ${cifras}.`;
}

// Devuelve los avisos de tope que tocan ahora y los deja reclamados: cada nivel sale una vez
// por mes. Si se pasa directo al 100 %, el 80 % se da por avisado y solo sale el 100 %.
async function avisosDeTope(userId, perfil) {
  try {
    const p = perfil || await topesDe(userId);
    const conTope = MEDIOS_ING.filter(m => Number(p?.[`tope_${m}`]) > 0);
    if (!conTope.length) return [];
    const mes = colombiaDateString().slice(0, 7);
    const usado = await ingresadoPorMedio(userId, mes);
    const avisos = [];
    for (const medio of conTope) {
      const tope = Number(p[`tope_${medio}`]);
      const pct = usado[medio] / tope * 100;
      const niveles = pct >= 100 ? [80, 100] : pct >= 80 ? [80] : [];
      if (!niveles.length) continue;
      const { data: nuevos, error } = await supabase.from('ingresos_tope_avisos')
        .upsert(niveles.map(nivel => ({ user_id: userId, mes, medio, nivel })),
          { onConflict: 'user_id,mes,medio,nivel', ignoreDuplicates: true })
        .select('nivel');
      if (error) { console.error('[topes] reclamo falló:', error.message); continue; }
      const reclamados = (nuevos || []).map(n => n.nivel);
      if (!reclamados.length) continue;
      const nivel = Math.max(...reclamados);
      avisos.push({ medio, nivel, mes, texto: mensajeTope(medio, nivel, usado[medio], tope) });
    }
    return avisos;
  } catch (e) {
    console.error('[topes] error:', e.message);
    return [];
  }
}

async function soltarAvisoTope(userId, { mes, medio, nivel }) {
  const niveles = nivel === 100 ? [80, 100] : [80];
  await supabase.from('ingresos_tope_avisos').delete()
    .eq('user_id', userId).eq('mes', mes).eq('medio', medio).in('nivel', niveles);
}

// Después de registrar un ingreso: cuánto lleva del tope de ese medio. Si toca el aviso del
// 80 % o del 100 %, sale ese (y queda reclamado para que el cron no lo repita).
async function lineaDeTope(userId, medio) {
  try {
    if (!medio) return '';
    const p = await topesDe(userId);
    const tope = Number(p[`tope_${medio}`]);
    const avisos = await avisosDeTope(userId, p);
    const delMedio = avisos.find(a => a.medio === medio);
    const otros = avisos.filter(a => a.medio !== medio).map(a => a.texto);
    let linea = '';
    if (delMedio) linea = delMedio.texto;
    else if (tope > 0) {
      const usado = (await ingresadoPorMedio(userId, colombiaDateString().slice(0, 7)))[medio];
      const pct = Math.round(usado / tope * 100);
      linea = `${pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢'} ${NOMBRE_MEDIO_ING[medio]} este mes: ${fmtPesos(usado)} de ${fmtPesos(tope)} (${pct} %).`;
    }
    return [linea, ...otros].filter(Boolean).join('\n');
  } catch (e) {
    console.error('[topes] línea:', e.message);
    return '';
  }
}

module.exports = { MEDIOS_ING, NOMBRE_MEDIO_ING, fmtPesos, medioIngresoDelTexto, avisosDeTope, soltarAvisoTope, lineaDeTope };
