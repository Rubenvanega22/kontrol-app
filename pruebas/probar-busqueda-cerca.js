// Pruebas de lugares cercanos — se ejecuta con: npm run probar-busqueda-cerca
//
// NO llama a Google, ni a Claude, ni a la base: Supabase y fetch van simulados.
//   1. detectarBusquedaCerca con frases reales, en texto y como las devuelve la
//      transcripción de un audio (mayúscula inicial, signos, punto final).
//   2. Frases que NO son buscar un lugar (agenda, pagos, rutas…).
//   3. respuestaInventaLugar con la respuesta real que falló (13-nov-2026, 21:10 UTC).
//   4. El handler de /api/ai-chat de verdad:
//      - "la ferretería más cerca" sin ubicación → pide el pin, deja la búsqueda
//        pendiente y NO llama a Claude.
//      - el modelo inventa un lugar → se descarta y se pide la ubicación.
//      - un pedido de agenda sigue yendo al modelo.

const assert = require('assert');
const path = require('path');

// ─── Supabase simulado (antes de cargar ai-chat) ──────────────────
const actualizaciones = [];
function consulta(tabla) {
  let unico = false;
  const q = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        const resultado = { data: unico ? null : [], error: null, count: 0 };
        return (ok, mal) => Promise.resolve(resultado).then(ok, mal);
      }
      if (prop === 'maybeSingle' || prop === 'single') unico = true;
      if (prop === 'update') return (datos) => { actualizaciones.push({ tabla, datos }); return q; };
      return () => q;
    },
  });
  return q;
}
const supabaseFalso = { from: consulta, auth: { getUser: async () => ({ data: null, error: new Error('sin token') }) } };
require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true, exports: supabaseFalso,
};

// ─── fetch simulado: Mem0 vacío; Claude responde lo que diga cada prueba ──
let respuestaClaude = null;
let llamadasClaude = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.anthropic.com')) {
    llamadasClaude++;
    return { json: async () => ({ content: [{ text: respuestaClaude ?? 'Hola' }] }) };
  }
  if (u.includes('places.googleapis.com')) throw new Error('No se debe llamar a Google en estas pruebas');
  return { json: async () => ({ results: [] }) };
};

process.env.CRON_SECRET = 'secreto-de-prueba';
process.env.GOOGLE_PLACES_KEY = 'clave-de-prueba';
const handler = require('../api/ai-chat');
const { detectarBusquedaCerca, respuestaInventaLugar } = require('../lib/busqueda-cerca');
const { PEDIR_UBICACION } = require('../lib/lugares');

async function llamar(message) {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer secreto-de-prueba' },
    body: { message, history: [], user_id: '00000000-0000-0000-0000-000000000001' },
  };
  const res = {
    code: 200, body: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
  await handler(req, res);
  return res;
}

// ─── Casos ──────────────────────────────────────────────────────
const FRASES = [
  ['la ferretería más cerca', 'ferretería', 'hardware_store'],
  ['búscame una droguería', 'droguería', 'pharmacy'],
  ['dónde hay un cajero', 'cajero', 'atm'],
  ['necesito una farmacia cerca', 'farmacia', 'pharmacy'],
];
// Como llegan de la transcripción de un audio (Whisper).
const COMO_AUDIO = (f) => [
  f.charAt(0).toUpperCase() + f.slice(1) + '.',
  `¿${f.charAt(0).toUpperCase() + f.slice(1)}?`,
  `Hola, oye, ${f}, por favor.`,
];

const casos = [];

for (const [frase, consulta, tipo] of FRASES) {
  casos.push([`Texto "${frase}" -> buscar_cerca|${consulta}|${tipo}`, () => {
    assert.deepStrictEqual(detectarBusquedaCerca(frase), { consulta, tipo });
  }]);
  for (const audio of COMO_AUDIO(frase)) {
    casos.push([`Audio transcrito "${audio}" -> buscar_cerca|${consulta}`, () => {
      assert.deepStrictEqual(detectarBusquedaCerca(audio), { consulta, tipo });
    }]);
  }
}

const OTRAS_QUE_SI = [
  ['un cajero de Bancolombia cerca', 'cajero bancolombia', ''],
  ['dónde echo gasolina', 'gasolinera', 'gas_station'],
  ['una papelería por aquí', 'papelería', ''],
  ['La droguería más cercana', 'droguería', 'pharmacy'],
  ['hay alguna barbería cerca de mí', 'barbería', 'hair_care'],
  ['conoces alguna ferretería buena?', 'ferretería', 'hardware_store'],
];
for (const [frase, consulta, tipo] of OTRAS_QUE_SI) {
  casos.push([`También "${frase}" -> buscar_cerca|${consulta}`, () => {
    assert.deepStrictEqual(detectarBusquedaCerca(frase), { consulta, tipo });
  }]);
}

const NO_SON = [
  'agéndame cita en el hospital mañana a las 3',
  'el banco me cobró la cuota',
  'búscame el recordatorio de la luz',
  'pagué en la droguería con Nequi',
  'cómo llego al Éxito de Jamundí',
  'estoy cerca del banco, ya llego',
  'crea una lista de ferretería: tornillos; martillo',
  'hola, cómo estás',
];
for (const frase of NO_SON) {
  casos.push([`No es búsqueda de lugar: "${frase}"`, () => {
    assert.strictEqual(detectarBusquedaCerca(frase), null);
  }]);
}

// La respuesta real que falló.
const INVENTADA = 'La ferretería más cerca que te puedo recomendar está en el centro comercial Jardín Plaza, a unos 18 minutos en carro.';
casos.push(['La respuesta real que falló (centro comercial a 18 minutos) -> se detecta como inventada', () => {
  assert.strictEqual(respuestaInventaLugar(INVENTADA, 'la ferretería más cerca'), true);
}]);
casos.push(['Respuesta con dirección y tiempo a una pregunta de sitio -> inventada', () => {
  assert.strictEqual(respuestaInventaLugar('Te recomiendo la Ferretería El Tornillo, Calle 10 # 5-20, a 5 minutos.', 'conoces alguna ferretería buena?'), true);
}]);
casos.push(['Respuesta normal de agenda (con hora y "minutos") -> NO se toca', () => {
  assert.strictEqual(respuestaInventaLugar('Te aviso 15 minutos antes de la reunión.', 'avísame 15 minutos antes de la reunión'), false);
}]);
casos.push(['Respuesta sobre un lugar guardado -> NO se toca', () => {
  assert.strictEqual(respuestaInventaLugar('📍 Bodega Juan\nhttps://maps.google.com/?q=4.08,-76.19', 'dónde queda la bodega juan', ['Bodega Juan']), false);
}]);

// Handler real de /api/ai-chat.
casos.push(['Handler: "la ferretería más cerca" sin ubicación -> pide el pin, deja pendiente y NO llama a Claude', async () => {
  llamadasClaude = 0; actualizaciones.length = 0;
  const r = await llamar('la ferretería más cerca');
  assert.strictEqual(r.body.respuesta, PEDIR_UBICACION('ferretería'));
  assert.strictEqual(llamadasClaude, 0);
  assert.strictEqual(r.body.acciones[0].accion, 'buscar_cerca');
  assert.deepStrictEqual(
    actualizaciones.find(a => a.tabla === 'profiles' && a.datos.busqueda_pendiente)?.datos.busqueda_pendiente.consulta, 'ferretería');
}]);
casos.push(['Handler: audio transcrito "Búscame una droguería." -> pide el pin sin llamar a Claude', async () => {
  llamadasClaude = 0;
  const r = await llamar('Búscame una droguería.');
  assert.strictEqual(r.body.respuesta, PEDIR_UBICACION('droguería'));
  assert.strictEqual(llamadasClaude, 0);
}]);
casos.push(['Handler: el modelo inventa un lugar -> se descarta y se pide la ubicación', async () => {
  llamadasClaude = 0;
  respuestaClaude = 'Claro, te recomiendo la Ferretería El Tornillo en el centro comercial Jardín Plaza, a 18 minutos.';
  // Sin "cerca", "búscame" ni "dónde hay": la detección previa no lo toma y va al modelo.
  const r = await llamar('y ferreterías buenas?');
  respuestaClaude = null;
  assert.ok(llamadasClaude >= 1, 'debía pasar por el modelo');
  assert.ok(!/jard[ií]n plaza|tornillo|18 minutos/i.test(r.body.respuesta), `salió el lugar inventado: ${r.body.respuesta}`);
  assert.strictEqual(r.body.respuesta, PEDIR_UBICACION('ferretería'));
}]);
casos.push(['Handler: el modelo inventa y no se sabe qué busca -> pregunta qué lugar', async () => {
  respuestaClaude = 'El más cercano es el centro comercial Unicentro, a 10 minutos.';
  const r = await llamar('y dónde queda eso?');
  respuestaClaude = null;
  assert.ok(/qué lugar te busco/i.test(r.body.respuesta), r.body.respuesta);
}]);
casos.push(['Handler: un pedido normal sigue yendo al modelo', async () => {
  llamadasClaude = 0;
  respuestaClaude = 'Hola, ¿en qué te ayudo?';
  const r = await llamar('hola, cómo estás');
  respuestaClaude = null;
  assert.strictEqual(llamadasClaude, 1);
  assert.strictEqual(r.body.respuesta, 'Hola, ¿en qué te ayudo?');
}]);

(async () => {
  let fallos = 0;
  for (const [descripcion, probar] of casos) {
    try {
      await probar();
      console.log(`✓ ${descripcion}`);
    } catch (e) {
      fallos++;
      console.log(`✗ ${descripcion}\n    ${e.message.split('\n')[0]}`);
    }
  }
  console.log(fallos ? `\n${fallos} prueba(s) FALLARON.` : `\nLas ${casos.length} pruebas pasaron. 🎉`);
  process.exit(fallos ? 1 : 0);
})();
