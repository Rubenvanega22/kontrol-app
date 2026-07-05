// /api/validar-invitacion.js
// Valida un código de invitación contra la tabla `invitaciones` en el servidor.
// Se usa service key (lib/supabase) que bypassa RLS — el frontend no puede leer
// `invitaciones` con la clave anón (RLS deny-all). Reemplaza la validación
// hardcodeada que estaba en el JS del cliente (trivial de saltar).
//
// Opción A: valida existencia + activo (+ chequeo defensivo de usos_maximos).
// NO consume usos (no descuenta) — el descuento por registro es un follow-up.
const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const codigo = String((req.body && req.body.codigo) || '').trim().toUpperCase();
    if (!codigo) return res.json({ ok: true, valid: false, reason: 'vacio' });

    const { data, error } = await supabase
      .from('invitaciones')
      .select('codigo, activo, usos_maximos, usos_actuales')
      .eq('codigo', codigo)
      .maybeSingle();

    if (error) {
      console.error('[validar-invitacion] query error:', error.message);
      return res.status(500).json({ error: 'No se pudo validar el código' });
    }

    if (!data || data.activo !== true) {
      return res.json({ ok: true, valid: false, reason: 'invalido' });
    }
    // Chequeo defensivo: si algún día se descuentan usos, el límite se respeta.
    if (data.usos_maximos != null && data.usos_actuales != null
        && data.usos_actuales >= data.usos_maximos) {
      return res.json({ ok: true, valid: false, reason: 'agotado' });
    }

    return res.json({ ok: true, valid: true });
  } catch (e) {
    console.error('[validar-invitacion] uncaught:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
