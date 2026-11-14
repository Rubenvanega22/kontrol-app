// Pruebas de "¿dónde compro esto?" — se ejecuta con: npm run probar-donde-compro
//
// NO llama a Google, ni a Claude, ni a la base: Supabase y fetch van simulados.
//   1. detectarDondeCompro: frases que sí son el pedido (con "esto" o con el producto).
//   2. Frases que NO lo son: textos de fotos de listas y facturas, lugares cercanos…
//   3. interpretarProducto: lo que responda Haiku (bien, no reconocido, raro, con markdown).
//   4. Los intentos: "producto tienda", solo el producto y tiendas generales (Éxito…).
//   5. Jamundí (el caso real que falló): locationBias 15 km, log por intento, 8 → 15 km.
//   6. Con el tope de búsquedas alcanzado no se busca.

const assert = require('assert');
const path = require('path');

// ─── Supabase simulado (antes de cargar lugares) ──────────────────
let conteoBusquedas = 0;
const anotadas = [];
function consulta(tabla) {
  let unico = false;
  const q = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') {
        const resultado = { data: unico ? null : [], error: null, count: tabla === 'busquedas_lugares' ? conteoBusquedas : 0 };
        return (ok, mal) => Promise.resolve(resultado).then(ok, mal);
      }
      if (prop === 'maybeSingle' || prop === 'single') unico = true;
      if (prop === 'insert') return (datos) => { if (tabla === 'busquedas_lugares') anotadas.push(datos); return q; };
      return () => q;
    },
    apply() { return q; }
  });
  return q;
}
require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true, exports: { from: consulta }
};
process.env.GOOGLE_PLACES_KEY = 'clave-de-prueba';


// ─── Google Places simulado: responde según el texto buscado ──────
// Jamundí (Valle), donde falló la prueba real del 14-nov-2026.
const ORIGEN = { lat: 3.2610, lng: -76.5390 };
let respuestas = {};
let porDefecto = [];
const llamadas = [];
global.fetch = async (url, opciones) => {
  const cuerpo = JSON.parse(opciones.body);
  llamadas.push({ url, cuerpo });
  const places = cuerpo.textQuery in respuestas ? respuestas[cuerpo.textQuery] : porDefecto;
  return { ok: true, status: 200, json: async () => ({ places }) };
};
// km hacia el norte (1° de latitud ≈ 111 km).
const lugar = (id, nombre, km, rating = 4.5, abierto = true) => ({
  id, displayName: { text: nombre }, shortFormattedAddress: `Calle ${id}`,
  location: { latitude: ORIGEN.lat + km / 111.2, longitude: ORIGEN.lng },
  rating, userRatingCount: 120, businessStatus: 'OPERATIONAL',
  currentOpeningHours: { openNow: abierto, nextCloseTime: '2026-11-15T00:00:00Z' }
});
const logs = [];
const logOriginal = console.log;
console.log = (...a) => { if (String(a[0]).startsWith('[lugares]')) logs.push(a.join(' ')); else logOriginal(...a); };

const DC = require('../lib/donde-compro');
const { buscarCerca, intentosDeCompra } = require('../lib/lugares');

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); logOriginal('  ✓', nombre); }
  catch (e) { fallas++; logOriginal('  ✗', nombre, '\n     ', e.message); }
}
const reiniciar = () => { respuestas = {}; porDefecto = []; llamadas.length = 0; logs.length = 0; anotadas.length = 0; conteoBusquedas = 0; };

(async () => {
  logOriginal('1. Sí es "¿dónde compro esto?"');
  const si = [
    ['¿Dónde puedo comprar esto?', null], ['dónde lo venden', null], ['Dónde consigo esto?', null],
    ['donde venden esto', null], ['¿En qué tienda venden esto?', null], ['donde se compra esto', null],
    ['dónde lo puedo comprar', null], ['Dónde encuentro esto.', null],
    ['dónde compro un taladro', 'taladro'], ['donde puedo conseguir una licuadora barata', 'licuadora'],
  ];
  for (const [frase, producto] of si) {
    await caso(frase, () => assert.deepStrictEqual(DC.detectarDondeCompro(frase), { producto }));
  }

  logOriginal('2. No es este pedido');
  const no = ['', 'a la lista de mercado', 'agrégalo a la lista del súper', 'factura de la luz', 'qué es esto',
    'dónde queda la droguería', '¿dónde compraste eso?', 'guárdala', 'lista de compras'];
  for (const frase of no) await caso(JSON.stringify(frase), () => assert.strictEqual(DC.detectarDondeCompro(frase), null));

  logOriginal('3. Lo que responde Haiku');
  await caso('respuesta completa', () => {
    assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":true,"producto":"ventilador de pared","generico":"ventilador","con_articulo":"un ventilador de pared","tienda":"almacén de electrodomésticos","tiendas":"almacenes de electrodomésticos","otras":["Éxito","Homecenter","Alkosto"]}'),
      { reconocido: true, producto: 'ventilador de pared', generico: 'ventilador', conArticulo: 'un ventilador de pared',
        tienda: 'almacén de electrodomésticos', tiendas: 'almacenes de electrodomésticos', otras: ['Éxito', 'Homecenter'] });
  });
  await caso('sin generico ni otras: usa el producto', () => {
    const p = DC.interpretarProducto('{"reconocido":true,"producto":"taladro","con_articulo":"un taladro","tienda":"ferretería","tiendas":"ferreterías"}');
    assert.strictEqual(p.generico, 'taladro');
    assert.deepStrictEqual(p.otras, []);
  });
  await caso('con markdown alrededor', () => {
    assert.strictEqual(DC.interpretarProducto('```json\n{"reconocido":true,"producto":"croquetas","con_articulo":"unas croquetas","tienda":"tienda de mascotas","tiendas":"tiendas de mascotas"}\n```').producto, 'croquetas');
  });
  await caso('no reconocido', () => assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":false}'), { reconocido: false }));
  await caso('respuesta rara = no reconocido', () => {
    assert.deepStrictEqual(DC.interpretarProducto('no sé qué es'), { reconocido: false });
    assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":true,"producto":"","tienda":"x"}'), { reconocido: false });
  });

  const ventilador = { reconocido: true, producto: 'ventilador de pared', generico: 'ventilador', conArticulo: 'un ventilador de pared',
    tienda: 'tienda de electrónica', tiendas: 'tiendas de electrónica', otras: ['Éxito', 'Homecenter'] };
  const opciones = DC.opcionesDeBusqueda(ventilador);

  logOriginal('4. Los intentos de búsqueda');
  await caso('de lo preciso a lo general, sin repetir, máximo 4', () => {
    assert.deepStrictEqual(intentosDeCompra(opciones.compra),
      ['ventilador de pared tienda de electrónica', 'ventilador', 'Éxito', 'Homecenter']);
    assert.deepStrictEqual(intentosDeCompra({ producto: 'taladro', generico: 'taladro', tienda: 'ferretería', otras: ['ferretería', 'Homecenter'] }),
      ['taladro ferretería', 'taladro', 'ferretería', 'Homecenter']);
  });

  logOriginal('5. Jamundí: el caso que falló');
  await caso('la búsqueda precisa da 0 → prueba "ventilador" y "Éxito" y muestra 3', async () => {
    reiniciar();
    respuestas['ventilador de pared tienda de electrónica'] = [];
    respuestas['ventilador'] = [lugar('a', 'Almacén El Ventilador', 1.2), lugar('b', 'Electro Jamundí', 2.5)];
    respuestas['Éxito'] = [lugar('c', 'Éxito Jamundí', 3.1), lugar('d', 'Éxito Sur Cali', 12)];
    const r = await buscarCerca('u1', ORIGEN, opciones);
    assert.deepStrictEqual(llamadas.map(l => l.cuerpo.textQuery), ['ventilador de pared tienda de electrónica', 'ventilador', 'Éxito']);
    assert.ok(r.startsWith('🛒 Parece un ventilador de pared. Lo venden normalmente en:'), r);
    for (const n of ['Almacén El Ventilador', 'Electro Jamundí', 'Éxito Jamundí']) assert.ok(r.includes(n), n);
    assert.ok(!r.includes('Éxito Sur Cali'));
    assert.strictEqual((r.match(/Cómo llegar: /g) || []).length, 3);
    assert.ok(r.trim().endsWith(DC.PIE));
  });
  await caso('Text Search con locationBias de 15 km, nunca locationRestriction', () => {
    for (const l of llamadas) {
      assert.ok(l.url.endsWith(':searchText'));
      assert.strictEqual(l.cuerpo.locationBias.circle.radius, 15000);
      assert.strictEqual(l.cuerpo.locationRestriction, undefined);
    }
  });
  await caso('el log dice qué se buscó y cuántos volvió cada intento', () => {
    assert.ok(logs.some(l => l.includes('compra intento 1: texto="ventilador de pared tienda de electrónica" google=0 hasta8km=0 hasta15km=0')), logs.join('\n'));
    assert.ok(logs.some(l => l.includes('compra intento 2: texto="ventilador" google=2 hasta8km=2 hasta15km=2')));
    assert.ok(logs.some(l => l.includes('compra intento 3: texto="Éxito" google=2 hasta8km=1 hasta15km=2')));
    assert.deepStrictEqual(anotadas.map(a => [a.consulta, a.resultados]),
      [['ventilador de pared tienda de electrónica', 0], ['ventilador', 2], ['Éxito', 2]]);
  });
  await caso('con 3 a 8 km en el primer intento no gasta más búsquedas', async () => {
    reiniciar();
    porDefecto = [lugar('a', 'Uno', 1), lugar('b', 'Dos', 2), lugar('c', 'Tres', 3)];
    await buscarCerca('u1', ORIGEN, opciones);
    assert.strictEqual(llamadas.length, 1);
  });
  await caso('nada a 8 km: completa con lo que hay hasta 15 km', async () => {
    reiniciar();
    respuestas['Éxito'] = [lugar('x', 'Éxito Lejos', 11), lugar('y', 'Muy Lejos', 20)];
    const r = await buscarCerca('u1', ORIGEN, opciones);
    assert.strictEqual(llamadas.length, 4);
    assert.ok(r.includes('Éxito Lejos') && r.includes('11,0 km'), r);
    assert.ok(!r.includes('Muy Lejos'));
  });
  await caso('nada hasta 15 km: lo dice y no inventa tiendas', async () => {
    reiniciar();
    const r = await buscarCerca('u1', ORIGEN, opciones);
    assert.strictEqual(r, '🛒 Parece un ventilador de pared, pero no encontré dónde lo vendan cerca de ti (busqué hasta 15 km).');
  });
  await caso('pedir ubicación', () => {
    assert.match(DC.pedirUbicacion(ventilador), /Parece un ventilador de pared\. Lo venden normalmente en tiendas de electrónica\.\n\n📍 Para buscarte dónde/);
  });

  logOriginal('6. Topes');
  await caso('con 20 búsquedas hoy no se busca', async () => {
    reiniciar();
    conteoBusquedas = 20;
    const r = await buscarCerca('u1', ORIGEN, opciones);
    assert.match(r, /Ya hiciste las 20 búsquedas de lugares de hoy/);
    assert.strictEqual(llamadas.length, 0);
  });

  logOriginal(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
