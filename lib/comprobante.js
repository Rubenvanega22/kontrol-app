// /lib/comprobante.js — Qué es la foto de un comprobante para este usuario: algo que le
// entró (ingreso), algo que pagó (pago) o no se sabe (duda). Solo decide; no guarda nada.
const supabase = require('./supabase');

// El medio del comprobante pasa a los medios de Pagos: banco cuenta como Tarjeta.
const MEDIO_PAGO_DE = { banco: 'tarjeta', nequi: 'nequi', efectivo: 'efectivo' };

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palabras = s => norm(s).split(/[^a-z*]+/).filter(t => t.replace(/\*/g, '').length >= 3);

// ¿El nombre leído es el del usuario? Los comprobantes suelen tapar letras ("RUB*** VAN***"):
// una palabra con asteriscos coincide si lo visible (3 letras o más) es el comienzo.
// Hace falta el nombre y otra palabra del perfil, o la única que tenga el perfil.
function esElUsuario(leido, nombrePerfil) {
  const perfil = palabras(nombrePerfil).map(t => t.replace(/\*/g, ''));
  if (!leido || !perfil.length) return false;
  const leidas = palabras(leido);
  const coincide = (l, p) => {
    if (!l.includes('*')) return l === p;
    const visible = l.split('*')[0];
    return visible.length >= 3 && p.startsWith(visible);
  };
  const aciertos = perfil.filter(p => leidas.some(l => coincide(l, p)));
  return aciertos.length >= Math.min(2, perfil.length);
}

async function nombreDelPerfil(userId) {
  const { data } = await supabase.from('profiles').select('nombre').eq('id', userId).maybeSingle();
  return data?.nombre || '';
}

async function clasificarComprobante(userId, c) {
  const nombre = await nombreDelPerfil(userId);
  const paraMi = esElUsuario(c.para, nombre);
  const deMi = esElUsuario(c.de, nombre);
  return paraMi && !deMi ? 'ingreso' : deMi && !paraMi ? 'pago' : 'duda';
}

// Pagos pendientes que podrían ser este: mismo nombre o valor parecido (5 %, mínimo $1.000).
async function pagosParecidos(userId, c) {
  const { data, error } = await supabase.from('payments').select('id, nombre, monto, fecha_limite')
    .eq('user_id', userId).neq('status', 'pagado').order('fecha_limite');
  if (error) throw new Error(error.message);
  const delPara = palabras(c.para).map(t => t.replace(/\*/g, ''));
  return (data || []).filter(p => {
    const deNombre = palabras(p.nombre);
    const mismoNombre = deNombre.length && delPara.length
      && deNombre.some(t => delPara.some(x => x === t || (x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x)))));
    const monto = Number(p.monto) || 0;
    const valorParecido = c.valor && Math.abs(monto - c.valor) <= Math.max(1000, c.valor * 0.05);
    return mismoNombre || valorParecido;
  }).map(p => ({ id: p.id, nombre: p.nombre, monto: Number(p.monto), fecha_limite: p.fecha_limite }));
}

module.exports = { MEDIO_PAGO_DE, esElUsuario, clasificarComprobante, pagosParecidos, norm };
