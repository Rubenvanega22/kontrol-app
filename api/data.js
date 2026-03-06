// /api/data.js
const supabase = require('../lib/supabase');

const TABLES = {
  movements: 'movements',
  accounts: 'accounts',
  payments: 'payments',
  events: 'events',
  cajas: 'cajas',
  caja_entries: 'caja_entries',
  reminders: 'reminders',
  email_accounts: 'email_accounts',
  ai_memory: 'ai_memory',
  config: 'config'
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, id, limit = 100, desde } = req.query;
  const table = TABLES[type];

  if (!table) return res.status(400).json({ error: 'Tipo no válido' });

  try {
    if (req.method === 'GET') {
      let query = supabase.from(table).select('*');
      if (type === 'movements') {
        query = query.order('fecha', { ascending: false }).order('created_at', { ascending: false });
        if (desde) query = query.gte('fecha', desde);
      }
      if (type === 'events') query = query.order('fecha');
      if (type === 'payments') query = query.order('fecha_limite');
      if (type === 'reminders') query = query.order('created_at', { ascending: false });
      if (limit) query = query.limit(parseInt(limit));
      const { data, error } = await query;
      if (error) throw error;
      return res.json({ ok: true, data });
    }

    if (req.method === 'POST') {
      const body = req.body;
      const { data, error } = await supabase.from(table).insert(body).select();
      if (error) throw error;
      if (type === 'movements' && body.account_id) {
        await actualizarSaldo(body.account_id, body.tipo, parseFloat(body.monto));
      }
      return res.json({ ok: true, data: data[0] });
    }

    if (req.method === 'PUT') {
      if (!id) return res.status(400).json({ error: 'ID requerido' });
      const { data, error } = await supabase.from(table).update(req.body).eq('id', id).select();
      if (error) throw error;
      return res.json({ ok: true, data: data[0] });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ error: 'ID requerido' });
      if (type === 'movements') {
        const { data: mov } = await supabase.from('movements').select('*').eq('id', id).single();
        if (mov?.account_id) {
          const tipoReverso = mov.tipo === 'ingreso' ? 'gasto' : 'ingreso';
          await actualizarSaldo(mov.account_id, tipoReverso, parseFloat(mov.monto));
        }
      }
      const { error } = await supabase.from(table).delete().eq('id', id);
      if (error) throw error;
      return res.json({ ok: true });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

async function actualizarSaldo(accountId, tipo, monto) {
  const { data: account } = await supabase.from('accounts').select('saldo').eq('id', accountId).single();
  if (!account) return;
  const nuevoSaldo = tipo === 'ingreso'
    ? parseFloat(account.saldo) + monto
    : parseFloat(account.saldo) - monto;
  await supabase.from('accounts').update({ saldo: nuevoSaldo }).eq('id', accountId);
}
