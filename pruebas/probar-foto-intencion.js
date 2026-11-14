// Pruebas de foto + texto en el webhook de WhatsApp — npm run probar-foto-intencion
//
// Corre /api/whatsapp de verdad (con firma de Twilio válida). Twilio, Claude, Google Places
// y Supabase van simulados. Revisa qué camino toma una foto según su texto:
//   - "Sonde compro esto" (prueba real fallida del 14-nov-2026): va a dónde comprar,
//     sin leerla como factura ni lista.
//   - Un texto que no es claro ("y esto quién lo vende?"): Haiku decide la intención antes.
//   - Texto claro de lista o factura: no se le pregunta a Haiku, sigue como antes.
//   - Texto de otra cosa, o si Haiku falla: sigue al lector de facturas y listas.

const assert = require('assert');
const path = require('path');

process.env.TWILIO_ACCOUNT_SID = 'AC_prueba';
process.env.TWILIO_AUTH_TOKEN = 'token_prueba';
process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
process.env.GOOGLE_PLACES_KEY = 'clave-de-prueba';
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';

// ─── Supabase simulado ────────────────────────────────────────────
const PERFIL = { id: 'u1', telefono: '+573001112233', ubicacion_lat: 3.2610, ubicacion_lng: -76.5390, ubicacion_at: null };
function consulta(tabla) {
  let unico = false;
  const q = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        let data = unico ? null : [];
        if (tabla === 'profiles' && unico) data = { ...PERFIL, ubicacion_at: new Date().toISOString() };
        return (ok, mal) => Promise.resolve({ data, error: null, count: 0 }).then(ok, mal);
      }
      if (prop === 'maybeSingle' || prop === 'single') unico = true;
      return () => q;
    },
    apply() { return q; }
  });
  return q;
}
require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true, exports: { from: consulta }
};

// ─── Red simulada ─────────────────────────────────────────────────
let llamadas, enviados, intencionResponde;
const PRODUCTO = '{"reconocido":true,"producto":"ventilador de pared","generico":"ventilador","con_articulo":"un ventilador de pared","tienda":"almacén de electrodomésticos","tiendas":"almacenes de electrodomésticos","otras":["Éxito"]}';
global.fetch = async (url, opciones = {}) => {
  const json = (d, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => d, text: async () => JSON.stringify(d), arrayBuffer: async () => new ArrayBuffer(8) });
  if (url.includes('/Messages.json')) {
    enviados.push(new URLSearchParams(opciones.body).get('Body'));
    return json({ sid: 'SM1' });
  }
  if (url.startsWith('https://api.twilio.com/media')) { llamadas.push('descarga'); return json({}); }
  if (url.includes('api.anthropic.com')) {
    const { system } = JSON.parse(opciones.body);
    if (system.startsWith('Clasificas')) {
      llamadas.push('intencion');
      if (intencionResponde instanceof Error) throw intencionResponde;
      return json({ content: [{ type: 'text', text: intencionResponde }] });
    }
    if (system.startsWith('Eres un asistente de compras')) { llamadas.push('producto'); return json({ content: [{ type: 'text', text: PRODUCTO }] }); }
    llamadas.push('lector'); // lector de facturas, comprobantes y listas
    return json({ content: [{ type: 'text', text: '{"tipo":"otro"}' }] });
  }
  if (url.includes('places.googleapis.com')) {
    llamadas.push('places');
    const place = (id, n, km) => ({ id, displayName: { text: n }, shortFormattedAddress: 'Calle 1', location: { latitude: 3.2610 + km / 111.2, longitude: -76.5390 }, rating: 4.4, userRatingCount: 80, businessStatus: 'OPERATIONAL' });
    return json({ places: [place('a', 'Electro Jamundí', 1), place('b', 'Almacén Sur', 2), place('c', 'Éxito Jamundí', 3)] });
  }
  throw new Error('fetch no simulado: ' + url);
};

const { calcularFirma } = require('../lib/twilio-signature');
const handler = require('../api/whatsapp');

async function mandarFoto(texto) {
  llamadas = []; enviados = [];
  const body = { From: 'whatsapp:+573001112233', Body: texto, NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1', MediaContentType0: 'image/jpeg', MessageType: 'image' };
  const url = 'https://kontrol-app-eight.vercel.app/api/whatsapp';
  const req = { method: 'POST', url: '/api/whatsapp', body,
    headers: { host: 'kontrol-app-eight.vercel.app', 'x-forwarded-proto': 'https', 'x-twilio-signature': calcularFirma('token_prueba', url, body) } };
  let estado = 0;
  const res = { setHeader() {}, status(s) { estado = s; return this; }, send() { return this; } };
  await handler(req, res);
  assert.strictEqual(estado, 200, 'el webhook debe responder 200');
  return enviados.at(-1) || '';
}

const ES_COMPRA = /^🛒 Parece un ventilador de pared\. Lo venden normalmente en:/;
const NO_PARECE = /no parece una factura, un comprobante ni una lista/;
let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.log = ((orig) => (...a) => { if (!/^\[(whatsapp|lugares)\]/.test(String(a[0]))) orig(...a); })(console.log);
  console.error = () => {};
  console.warn = () => {};

  console.log('Foto + texto en WhatsApp');
  for (const texto of ['Sonde compro esto', 'sonde compro esto', 'onde lo venden', 'dnd consigo esto', 'DONDE COMPRO ESTO', 'Dónde lo puedo comprar?']) {
    await caso(`"${texto}" → dónde comprar, sin leerla como factura ni lista`, async () => {
      intencionResponde = '{"intencion":"otro"}';
      const r = await mandarFoto(texto);
      assert.match(r, ES_COMPRA, r);
      assert.ok(!llamadas.includes('lector'), 'no debe pasar por el lector de facturas');
      assert.ok(!llamadas.includes('intencion'), 'el código ya lo reconoce, no hace falta Haiku');
    });
  }
  await caso('"y esto quién lo vende?" → Haiku dice comprar → dónde comprar', async () => {
    intencionResponde = '{"intencion":"comprar"}';
    const r = await mandarFoto('y esto quién lo vende?');
    assert.deepStrictEqual(llamadas.slice(0, 1), ['intencion']);
    assert.match(r, ES_COMPRA, r);
    assert.ok(!llamadas.includes('lector'));
  });
  await caso('"necesito uno igualito" → Haiku dice comprar', async () => {
    intencionResponde = '```json\n{"intencion":"comprar"}\n```';
    assert.match(await mandarFoto('necesito uno igualito'), ES_COMPRA);
  });
  await caso('"factura de la luz" es claro: no pregunta a Haiku, va al lector', async () => {
    const r = await mandarFoto('factura de la luz');
    assert.ok(!llamadas.includes('intencion'));
    assert.ok(llamadas.includes('lector'));
    assert.match(r, NO_PARECE);
  });
  await caso('"guárdala" es claro: no pregunta a Haiku', async () => {
    await mandarFoto('guárdala');
    assert.ok(!llamadas.includes('intencion'));
  });
  await caso('"a la lista de mercado": va a la lista, sin preguntar a Haiku', async () => {
    await mandarFoto('a la lista de mercado');
    assert.ok(!llamadas.includes('intencion') && !llamadas.includes('producto'));
  });
  await caso('sin texto: como antes, directo al lector', async () => {
    await mandarFoto('');
    assert.deepStrictEqual(llamadas.filter(l => l !== 'descarga'), ['lector']);
  });
  await caso('"mira qué lindo" → Haiku dice otro → lector → "no parece…" + la pista de comprar', async () => {
    intencionResponde = '{"intencion":"otro"}';
    const r = await mandarFoto('mira qué lindo');
    assert.deepStrictEqual(llamadas.filter(l => l !== 'descarga'), ['intencion', 'lector']);
    assert.match(r, NO_PARECE);
    assert.match(r, /¿dónde compro esto\?/);
  });
  await caso('si Haiku falla al decidir, sigue al lector sin romperse', async () => {
    intencionResponde = new Error('se cayó');
    const r = await mandarFoto('mira qué lindo');
    assert.ok(llamadas.includes('lector'));
    assert.match(r, NO_PARECE);
  });
  await caso('respuesta rara de Haiku cuenta como otro', async () => {
    intencionResponde = 'no sé';
    const r = await mandarFoto('mira qué lindo');
    assert.match(r, NO_PARECE);
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
