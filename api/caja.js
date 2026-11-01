// /api/caja.js — Llave de la Caja fuerte.
// Las filas se cifran en el celular. Aquí solo se guarda la llave, cifrada con CAJA_SECRETO,
// y se entrega a quien dé el PIN correcto. Sin ese secreto la base no sirve para leerlas.
// Nunca registrar en logs el PIN, la contraseña ni la llave.
const crypto = require('crypto');
const { promisify } = require('util');
const supabase = require('../lib/supabase');

const scrypt = promisify(crypto.scrypt);
// Clave pública de la app (la misma de index.html): solo sirve para verificar la contraseña.
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5yb3VqYm1sZnFid29wY2hpam1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDMyMjYsImV4cCI6MjA4ODM3OTIyNn0.wXmHdg46SCuCbubLEzBZH2C0VgUgEtjTf20TSxpipdc';
const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 15;
const BLOQUEO_MAX_MIN = 24 * 60;
const pinValido = (p) => typeof p === 'string' && /^\d{4}$/.test(p);

function llaveMaestra(uid) {
  return Buffer.from(crypto.hkdfSync('sha256', process.env.CAJA_SECRETO, uid, 'kontrol-caja-v1', 32));
}
function envolver(llave, uid) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', llaveMaestra(uid), iv);
  c.setAAD(Buffer.from(uid));
  const cifrado = Buffer.concat([c.update(llave), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), cifrado]).toString('base64');
}
function desenvolver(texto, uid) {
  const b = Buffer.from(texto, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', llaveMaestra(uid), b.subarray(0, 12));
  d.setAAD(Buffer.from(uid));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}
// Con el secreto en el HMAC, el hash no se puede atacar teniendo solo la base.
async function hashPin(pin, sal, uid) {
  const base = crypto.createHmac('sha256', process.env.CAJA_SECRETO).update(`${uid}:${pin}`).digest();
  return scrypt(base, Buffer.from(sal, 'base64'), 32);
}
async function nuevoPin(pin, uid) {
  const pin_sal = crypto.randomBytes(16).toString('base64');
  return { pin_sal, pin_hash: (await hashPin(pin, pin_sal, uid)).toString('base64') };
}
const minutosRestantes = (hasta) => Math.max(1, Math.ceil((new Date(hasta) - Date.now()) / 60000));

async function leerFila(uid) {
  const { data, error } = await supabase.from('caja_llaves').select('*').eq('user_id', uid).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function abrir(res, uid, pin) {
  if (!pinValido(pin)) return res.status(400).json({ error: 'pin_invalido' });
  const fila = await leerFila(uid);
  if (!fila) return res.status(404).json({ error: 'sin_caja' });
  if (fila.bloqueada_hasta && new Date(fila.bloqueada_hasta) > new Date()) {
    return res.status(423).json({ error: 'bloqueada', minutos: minutosRestantes(fila.bloqueada_hasta) });
  }
  // El intento se cuenta ANTES de comprobar: pedidos en paralelo no se saltan el límite.
  const intentos = fila.intentos >= MAX_INTENTOS ? 1 : fila.intentos + 1;
  const cambios = { intentos, updated_at: new Date().toISOString() };
  let bloqueos = fila.bloqueos;
  if (intentos >= MAX_INTENTOS) {
    bloqueos += 1;
    const min = Math.min(BLOQUEO_MIN * 2 ** (bloqueos - 1), BLOQUEO_MAX_MIN);
    cambios.bloqueos = bloqueos;
    cambios.bloqueada_hasta = new Date(Date.now() + min * 60000).toISOString();
  }
  const { data: contado, error: e1 } = await supabase.from('caja_llaves').update(cambios)
    .eq('user_id', uid).eq('intentos', fila.intentos).select('user_id');
  if (e1) throw new Error(e1.message);
  if (!contado?.length) return res.status(409).json({ error: 'reintenta' });

  const esperado = Buffer.from(fila.pin_hash, 'base64');
  const dado = await hashPin(pin, fila.pin_sal, uid);
  if (!crypto.timingSafeEqual(esperado, dado)) {
    if (cambios.bloqueada_hasta) return res.status(423).json({ error: 'bloqueada', minutos: minutosRestantes(cambios.bloqueada_hasta) });
    return res.status(401).json({ error: 'pin_incorrecto', restantes: MAX_INTENTOS - intentos });
  }
  const { error: e2 } = await supabase.from('caja_llaves')
    .update({ intentos: 0, bloqueos: 0, bloqueada_hasta: null }).eq('user_id', uid);
  if (e2) throw new Error(e2.message);
  return res.json({ llave: desenvolver(fila.llave_cifrada, uid).toString('base64') });
}

async function crear(res, uid, pin) {
  if (!pinValido(pin)) return res.status(400).json({ error: 'pin_invalido' });
  const llave = crypto.randomBytes(32);
  const { error } = await supabase.from('caja_llaves').insert({
    user_id: uid, llave_cifrada: envolver(llave, uid), ...(await nuevoPin(pin, uid))
  });
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'ya_existe' });
    throw new Error(error.message);
  }
  return res.json({ llave: llave.toString('base64') });
}

// Olvidó el PIN: se comprueba la contraseña de Kontrol contra Supabase, sin crear otra
// sesión en la app. La llave no cambia, así que las claves guardadas se conservan.
async function restablecer(res, usuario, { pin, correo, password }) {
  if (!pinValido(pin)) return res.status(400).json({ error: 'pin_invalido' });
  if (typeof correo !== 'string' || typeof password !== 'string' || !correo || !password) {
    return res.status(400).json({ error: 'faltan_datos' });
  }
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPA_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: correo.trim(), password })
  });
  const sesion = r.ok ? await r.json() : null;
  if (!sesion?.user || sesion.user.id !== usuario.id) return res.status(403).json({ error: 'credenciales' });

  const fila = await leerFila(usuario.id);
  if (!fila) return res.status(404).json({ error: 'sin_caja' });
  const { error } = await supabase.from('caja_llaves').update({
    ...(await nuevoPin(pin, usuario.id)), intentos: 0, bloqueos: 0, bloqueada_hasta: null,
    updated_at: new Date().toISOString()
  }).eq('user_id', usuario.id);
  if (error) throw new Error(error.message);
  return res.json({ llave: desenvolver(fila.llave_cifrada, usuario.id).toString('base64') });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const { data: auth, error: authError } = token ? await supabase.auth.getUser(token) : { data: null, error: true };
  if (authError || !auth?.user) return res.status(401).json({ error: 'sin_sesion' });
  if (!process.env.CAJA_SECRETO) {
    console.error('[caja] falta CAJA_SECRETO');
    return res.status(503).json({ error: 'sin_configurar' });
  }
  const uid = auth.user.id;
  const body = req.body || {};
  try {
    if (body.accion === 'estado') {
      const fila = await leerFila(uid);
      return res.json({ existe: !!fila });
    }
    if (body.accion === 'crear') return await crear(res, uid, body.pin);
    if (body.accion === 'abrir') return await abrir(res, uid, body.pin);
    if (body.accion === 'restablecer') return await restablecer(res, auth.user, body);
    return res.status(400).json({ error: 'accion_invalida' });
  } catch (e) {
    console.error('[caja] error en', String(body.accion).slice(0, 20), e.message);
    return res.status(500).json({ error: 'interno' });
  }
};
