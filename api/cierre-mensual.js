// /api/cierre-mensual.js
// Archiva a historial_mensual los MOVIMIENTOS y PAGOS de un mes y los borra de
// sus tablas. NO toca accounts/cajas/events/reminders/metas: los saldos son
// valores ALMACENADOS (no derivados de movimientos), así que archivar no los altera.
//
// Modos:
//   • MANUAL: POST con Authorization: Bearer <jwt de usuario>. Archiva el mes del
//     body ({mes:"2026-05"}, o el mes actual Colombia) SOLO para ese usuario.
//   • AUTOMÁTICO: GET (cron de Vercel). Si hoy es día 1 en Colombia, archiva el mes
//     ANTERIOR para todos los usuarios con datos de ese mes. Si no, no-op.

const supabase = require('../lib/supabase');
const { colombiaDateParts } = require('../lib/datetime');

// "YYYY-MM" del mes actual en Colombia.
function mesActual() {
  const { anio, mes } = colombiaDateParts(); // mes 0-11
  return `${anio}-${String(mes + 1).padStart(2, '0')}`;
}

// "YYYY-MM" del mes anterior al actual (Colombia).
function mesAnterior() {
  const { anio, mes } = colombiaDateParts();
  let y = anio, m = mes - 1;
  if (m < 0) { m = 11; y -= 1; }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

// Rango [inicio, fin) para un mes "YYYY-MM".
function rangoMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const inicio = `${y}-${String(m).padStart(2, '0')}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const fin = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { inicio, fin };
}

async function archivarMes(userId, mes) {
  const { inicio, fin } = rangoMes(mes);
  const out = { movimientos: 0, pagos: 0 };

  // ── Movimientos (por fecha) ──
  const { data: movs, error: eMov } = await supabase.from('movements')
    .select('*').eq('user_id', userId).gte('fecha', inicio).lt('fecha', fin);
  if (eMov) throw new Error('select movements: ' + eMov.message);
  if (movs && movs.length) {
    const filas = movs.map(m => ({ user_id: userId, mes_cerrado: mes, tipo: 'movement', data: m }));
    const { error: eIns } = await supabase.from('historial_mensual').insert(filas);
    if (eIns) throw new Error('insert historial movements: ' + eIns.message);
    const { error: eDel } = await supabase.from('movements').delete().in('id', movs.map(m => m.id)).eq('user_id', userId);
    if (eDel) throw new Error('delete movements: ' + eDel.message);
    out.movimientos = movs.length;
  }

  // ── Pagos (por fecha_limite) ──
  const { data: pagos, error: ePag } = await supabase.from('payments')
    .select('*').eq('user_id', userId).gte('fecha_limite', inicio).lt('fecha_limite', fin);
  if (ePag) throw new Error('select payments: ' + ePag.message);
  if (pagos && pagos.length) {
    const filas = pagos.map(p => ({ user_id: userId, mes_cerrado: mes, tipo: 'payment', data: p }));
    const { error: eIns } = await supabase.from('historial_mensual').insert(filas);
    if (eIns) throw new Error('insert historial payments: ' + eIns.message);
    const { error: eDel } = await supabase.from('payments').delete().in('id', pagos.map(p => p.id)).eq('user_id', userId);
    if (eDel) throw new Error('delete payments: ' + eDel.message);
    out.pagos = pagos.length;
  }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();

    // ── MODO MANUAL: token de usuario (distinto del CRON_SECRET) ──
    if (req.method === 'POST' && token && token !== process.env.CRON_SECRET) {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: 'Token inválido' });
      const mes = (req.body && req.body.mes) || mesActual();
      const r = await archivarMes(user.id, mes);
      return res.json({ ok: true, modo: 'manual', mes, ...r });
    }

    // ── MODO AUTOMÁTICO (cron de Vercel): solo el día 1 en Colombia ──
    if (req.method !== 'GET' && token !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    const { dia } = colombiaDateParts();
    const force = req.query && req.query.force;
    if (dia !== 1 && !force) {
      return res.json({ ok: true, skipped: 'no es día 1 en Colombia', dia });
    }
    const mes = (req.query && req.query.mes) || mesAnterior();
    const { inicio, fin } = rangoMes(mes);
    const [{ data: mu }, { data: pu }] = await Promise.all([
      supabase.from('movements').select('user_id').gte('fecha', inicio).lt('fecha', fin),
      supabase.from('payments').select('user_id').gte('fecha_limite', inicio).lt('fecha_limite', fin)
    ]);
    const userIds = [...new Set([...(mu || []), ...(pu || [])].map(r => r.user_id).filter(Boolean))];
    const resultados = [];
    for (const uid of userIds) {
      try { resultados.push({ user_id: uid, ...(await archivarMes(uid, mes)) }); }
      catch (e) { resultados.push({ user_id: uid, error: e.message }); }
    }
    return res.json({ ok: true, modo: 'auto', mes, usuarios: userIds.length, resultados });
  } catch (error) {
    console.error('[cierre-mensual] error:', error);
    return res.status(500).json({ error: error.message });
  }
};
