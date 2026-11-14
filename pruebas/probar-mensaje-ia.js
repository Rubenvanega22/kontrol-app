// Pruebas de mensajes programados en el webhook de WhatsApp — npm run probar-mensaje-ia
//
// Corre /api/whatsapp de verdad (firma de Twilio válida). Twilio, la asistente (ai-chat),
// Claude Haiku y Supabase van simulados. Revisa las tres capas:
//   1. El código reconoce la frase que falló el 14-nov-2026 sin pasar por la asistente.
//   2. Si el código no la entiende pero habla de escribirle a alguien, Haiku saca las partes.
//   3. Si la asistente igual dice "no puedo enviar mensajes", se descarta esa respuesta.

const assert = require('assert');
const path = require('path');

process.env.TWILIO_ACCOUNT_SID = 'AC_prueba';
process.env.TWILIO_AUTH_TOKEN = 'token_prueba';
process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
process.env.CRON_SECRET = 'secreto';

// ─── Supabase simulado: perfil del usuario, sin contactos ni estado ─
function consulta(tabla) {
  let unico = false;
  const q = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        const data = unico ? (tabla === 'profiles' ? { id: 'u1', telefono: '+573001112233' } : null) : [];
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
let llamadas, enviados, respuestaAsistente, respuestaHaiku;
global.fetch = async (url, opciones = {}) => {
  const json = d => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
  if (url.includes('/Messages.json')) { enviados.push(new URLSearchParams(opciones.body).get('Body')); return json({ sid: 'SM1' }); }
  if (url.endsWith('/api/ai-chat')) { llamadas.push('asistente'); return json({ ok: true, respuesta: respuestaAsistente, acciones: [] }); }
  if (url.includes('api.anthropic.com')) {
    llamadas.push('haiku');
    if (respuestaHaiku instanceof Error) throw respuestaHaiku;
    return json({ content: [{ type: 'text', text: respuestaHaiku }] });
  }
  throw new Error('fetch no simulado: ' + url);
};

const { calcularFirma } = require('../lib/twilio-signature');
const handler = require('../api/whatsapp');

async function decir(texto) {
  llamadas = []; enviados = [];
  const body = { From: 'whatsapp:+573001112233', Body: texto, NumMedia: '0', MessageType: 'text' };
  const url = 'https://kontrol-app-eight.vercel.app/api/whatsapp';
  const req = { method: 'POST', url: '/api/whatsapp', body,
    headers: { host: 'kontrol-app-eight.vercel.app', 'x-forwarded-proto': 'https', 'x-twilio-signature': calcularFirma('token_prueba', url, body) } };
  const res = { setHeader() {}, status() { return this; }, send() { return this; } };
  await handler(req, res);
  return enviados.at(-1) || '';
}

const NIEGA = 'No puedo enviar mensajes a otras personas. Solo gestiono tu agenda, pagos, listas y recordatorios.';
const PIDE_NUMERO = /No tengo el número de Johanny/;
let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.log = ((orig) => (...a) => { if (!/^\[(whatsapp|mensaje)\]/.test(String(a[0]))) orig(...a); })(console.log);
  console.error = () => {}; console.warn = () => {};
  respuestaAsistente = NIEGA;

  console.log('1. El código la reconoce: ni asistente ni Haiku');
  for (const frase of ['escríbele un mensaje a Johanny a las 3 y 5', 'Escribe a Johanny a las 3 y 5. Hola, por favor.',
    'Mándale un WhatsApp a Johanny a las 3 y 5: ya voy', 'envíame un mensaje a Johanny a las 3 y 5 diciendo que ya voy']) {
    await caso(frase, async () => {
      const r = await decir(frase);
      assert.match(r, PIDE_NUMERO, r);
      assert.deepStrictEqual(llamadas, []);
    });
  }

  console.log('2. El código no la entiende, pero habla de escribirle a alguien: Haiku');
  await caso('"Johanny tiene que saber que ya voy, avísale a las 3 y 5"', async () => {
    respuestaHaiku = '{"es_mensaje":true,"nombre":"Johanny","texto":"que ya voy","cuando":"a las 3 y 5"}';
    const r = await decir('Johanny tiene que saber que ya voy, avísale a las 3 y 5');
    assert.match(r, PIDE_NUMERO, r);
    assert.deepStrictEqual(llamadas, ['haiku'], 'no debe pasar por la asistente');
  });
  await caso('"a Johanny le escribes que ya voy"', async () => {
    respuestaHaiku = '{"es_mensaje":true,"nombre":"Johanny","texto":"que ya voy","cuando":""}';
    assert.match(await decir('a Johanny le escribes que ya voy'), PIDE_NUMERO);
  });
  await caso('Haiku dice que no es mensaje: sigue a la asistente', async () => {
    respuestaHaiku = '{"es_mensaje":false}';
    respuestaAsistente = '✅ Listo.';
    const r = await decir('quiero que le escribas una carta bonita a mi novia');
    assert.deepStrictEqual(llamadas, ['haiku', 'asistente']);
    assert.strictEqual(r, '✅ Listo.');
    respuestaAsistente = NIEGA;
  });
  await caso('si Haiku falla, sigue a la asistente sin romperse', async () => {
    respuestaHaiku = new Error('se cayó');
    respuestaAsistente = '✅ Listo.';
    assert.strictEqual(await decir('a Johanny le escribes que ya voy'), '✅ Listo.');
    respuestaAsistente = NIEGA;
  });

  console.log('3. La asistente dice "no puedo enviar mensajes": se descarta');
  await caso('se arma el mensaje con lo que entiende Haiku', async () => {
    respuestaHaiku = '{"es_mensaje":true,"nombre":"Johanny","texto":"un saludo","cuando":"a las 3 y 5"}';
    const r = await decir('¿le puedes hacer llegar a Johanny un saludo a las 3 y 5?');
    assert.deepStrictEqual(llamadas, ['asistente', 'haiku']);
    assert.match(r, PIDE_NUMERO, r);
    assert.ok(!r.includes('No puedo enviar'));
  });
  await caso('si Haiku no ve un pedido, explica cómo pedirlo (nunca "no puedo")', async () => {
    respuestaHaiku = '{"es_mensaje":false}';
    const r = await decir('¿tú puedes hacer llegar recados?');
    assert.match(r, /te aviso a la hora que digas con su chat abierto/);
    assert.ok(!r.includes('No puedo enviar'));
  });
  await caso('una respuesta normal de la asistente no se toca', async () => {
    respuestaAsistente = '✅ Agendé tu cita mañana a las 3:00 pm.';
    const r = await decir('agéndame una cita mañana a las 3 con el dentista');
    assert.deepStrictEqual(llamadas, ['asistente']);
    assert.strictEqual(r, respuestaAsistente);
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
