// Pruebas del vocabulario para Whisper — npm run probar-whisper-prompt
//
// NO llama a Groq ni a la base: van simulados.
//   1. construirPromptWhisper: palabras de Kontrol + contactos, sin repetir, sin pasar el tope.
//   2. /api/transcribe de verdad: el prompt que le llega a Groq lleva los contactos del
//      usuario, venga el audio de WhatsApp (sistema + x-kontrol-usuario) o de la app (sesión).
//      Si la base falla, transcribe igual con el vocabulario base.

const assert = require('assert');
const path = require('path');

process.env.CRON_SECRET = 'secreto';
process.env.GROQ_API_KEY = 'clave-de-prueba';

// ─── Supabase simulado ────────────────────────────────────────────
const CONTACTOS = {
  'u-whatsapp': ['Johanny', 'Paola Gómez', 'Rubén'],
  'u-app': ['Yuliana', 'Jhon Fredy']
};
let baseCaida = false;
function from(tabla) {
  let usuario = null;
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    eq(c, v) { if (c === 'user_id') usuario = v; return q; },
    then(ok, mal) {
      if (baseCaida) return Promise.resolve({ data: null, error: { message: 'caída' } }).then(ok, mal);
      return Promise.resolve({ data: (CONTACTOS[usuario] || []).map(nombre => ({ nombre })), error: null }).then(ok, mal);
    }
  };
  return q;
}
const auth = { getUser: async token => (token === 'sesion-app' ? { data: { user: { id: 'u-app' } }, error: null } : { data: null, error: { message: 'no' } }) };
require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true, exports: { from, auth }
};

// ─── Groq simulado ────────────────────────────────────────────────
let promptRecibido = null;
global.fetch = async (url, opciones) => {
  assert.ok(url.includes('api.groq.com'));
  promptRecibido = opciones.body.get('prompt');
  return { ok: true, status: 200, text: async () => 'Escríbele a Johanny a las 3 y 5' };
};

const { construirPromptWhisper, MAX_CARACTERES } = require('../lib/whisper-prompt');

function peticion(headers) {
  const audio = Buffer.from('audio-de-prueba');
  return {
    method: 'POST', headers: { 'content-type': 'audio/ogg', ...headers },
    async *[Symbol.asyncIterator]() { yield audio; }
  };
}
function respuesta() {
  const r = { estado: 200, cuerpo: null };
  r.status = s => { r.estado = s; return r; };
  r.json = c => { r.cuerpo = c; return r; };
  r.end = () => r;
  return r;
}

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.warn = () => {};
  const { default: transcribir } = await import('../api/transcribe.js');

  console.log('1. El vocabulario');
  await caso('palabras de Kontrol siempre', () => {
    const p = construirPromptWhisper();
    for (const w of ['Kontrol', 'Agenda', 'Listado', 'Pagos', 'Caja fuerte', 'Nequi']) assert.ok(p.includes(w), w);
    assert.ok(!p.includes('Contactos'));
  });
  await caso('contactos sin repetir y sin signos raros', () => {
    const p = construirPromptWhisper(['Johanny', 'johanny', 'Paola <b>', '  ', 'Rubén']);
    assert.ok(p.endsWith('Contactos: Johanny, Paola b, Rubén.'), p);
  });
  await caso('con muchos contactos no pasa el tope', () => {
    const muchos = Array.from({ length: 200 }, (_, i) => `Contacto Número ${i}`);
    const p = construirPromptWhisper(muchos);
    assert.ok(p.length <= MAX_CARACTERES, `${p.length}`);
    assert.ok(p.includes('Contacto Número 0'));
  });

  console.log('2. /api/transcribe le pasa el vocabulario a Groq');
  await caso('audio de WhatsApp: contactos del usuario que dice el bot', async () => {
    const r = respuesta();
    await transcribir(peticion({ authorization: 'Bearer secreto', 'x-kontrol-usuario': 'u-whatsapp' }), r);
    assert.strictEqual(r.estado, 200);
    assert.strictEqual(r.cuerpo.texto, 'Escríbele a Johanny a las 3 y 5');
    assert.ok(promptRecibido.includes('Contactos: Johanny, Paola Gómez, Rubén.'), promptRecibido);
  });
  await caso('audio de la app: contactos del usuario de la sesión', async () => {
    const r = respuesta();
    await transcribir(peticion({ authorization: 'Bearer sesion-app' }), r);
    assert.ok(promptRecibido.includes('Contactos: Yuliana, Jhon Fredy.'), promptRecibido);
  });
  await caso('un usuario no puede pedir los contactos de otro con la cabecera', async () => {
    const r = respuesta();
    await transcribir(peticion({ authorization: 'Bearer sesion-app', 'x-kontrol-usuario': 'u-whatsapp' }), r);
    assert.ok(!promptRecibido.includes('Johanny'), promptRecibido);
  });
  await caso('sin sesión: 401', async () => {
    const r = respuesta();
    await transcribir(peticion({}), r);
    assert.strictEqual(r.estado, 401);
  });
  await caso('si la base falla, transcribe igual con el vocabulario base', async () => {
    baseCaida = true;
    const r = respuesta();
    await transcribir(peticion({ authorization: 'Bearer secreto', 'x-kontrol-usuario': 'u-whatsapp' }), r);
    baseCaida = false;
    assert.strictEqual(r.estado, 200);
    assert.ok(promptRecibido.includes('Kontrol') && !promptRecibido.includes('Contactos'));
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
