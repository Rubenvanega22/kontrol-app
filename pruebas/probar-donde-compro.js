// Pruebas de "¿dónde compro esto?" — se ejecuta con: npm run probar-donde-compro
//
// NO llama a Google, ni a Claude, ni a la base: Supabase y fetch van simulados.
//   1. detectarDondeCompro: frases que sí son el pedido (con "esto" o con el producto).
//   2. Frases que NO lo son: textos de fotos de listas y facturas, lugares cercanos…
//   3. interpretarProducto: lo que responda Haiku (bien, no reconocido, raro, con markdown).
//   4. buscarCerca con los textos de la compra: encabezado, 3 opciones con "Cómo llegar",
//      el aviso de existencias, búsqueda por texto "producto + tienda", y el caso sin nada.
//   5. Con el tope de búsquedas alcanzado no se busca.

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

// ─── Google Places simulado ───────────────────────────────────────
const ORIGEN = { lat: 4.0847, lng: -76.1956 };
let lugaresDeGoogle = [];
const llamadas = [];
global.fetch = async (url, opciones) => {
  llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
  return { ok: true, status: 200, json: async () => ({ places: lugaresDeGoogle }) };
};
const lugar = (id, nombre, dLat, rating = 4.5, abierto = true) => ({
  id, displayName: { text: nombre }, shortFormattedAddress: `Calle ${id}`,
  location: { latitude: ORIGEN.lat + dLat, longitude: ORIGEN.lng },
  rating, userRatingCount: 120, businessStatus: 'OPERATIONAL',
  currentOpeningHours: { openNow: abierto, nextCloseTime: '2026-11-15T00:00:00Z' }
});

const DC = require('../lib/donde-compro');
const { buscarCerca } = require('../lib/lugares');

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}

(async () => {
  console.log('1. Sí es "¿dónde compro esto?"');
  const si = [
    ['¿Dónde puedo comprar esto?', null], ['dónde lo venden', null], ['Dónde consigo esto?', null],
    ['donde venden esto', null], ['¿En qué tienda venden esto?', null], ['donde se compra esto', null],
    ['dónde lo puedo comprar', null], ['Dónde encuentro esto.', null],
    ['dónde compro un taladro', 'taladro'], ['donde puedo conseguir una licuadora barata', 'licuadora'],
  ];
  for (const [frase, producto] of si) {
    await caso(frase, () => assert.deepStrictEqual(DC.detectarDondeCompro(frase), { producto }));
  }

  console.log('2. No es este pedido');
  const no = ['', 'a la lista de mercado', 'agrégalo a la lista del súper', 'factura de la luz', 'qué es esto',
    'dónde queda la droguería', '¿dónde compraste eso?', 'guárdala', 'lista de compras'];
  for (const frase of no) await caso(JSON.stringify(frase), () => assert.strictEqual(DC.detectarDondeCompro(frase), null));

  console.log('3. Lo que responde Haiku');
  await caso('respuesta normal', () => {
    assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":true,"producto":"taladro","con_articulo":"un taladro","tienda":"ferretería","tiendas":"ferreterías"}'),
      { reconocido: true, producto: 'taladro', conArticulo: 'un taladro', tienda: 'ferretería', tiendas: 'ferreterías' });
  });
  await caso('con markdown alrededor', () => {
    assert.strictEqual(DC.interpretarProducto('```json\n{"reconocido":true,"producto":"croquetas","con_articulo":"unas croquetas","tienda":"tienda de mascotas","tiendas":"tiendas de mascotas"}\n```').producto, 'croquetas');
  });
  await caso('no reconocido', () => assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":false}'), { reconocido: false }));
  await caso('respuesta rara = no reconocido', () => {
    assert.deepStrictEqual(DC.interpretarProducto('no sé qué es'), { reconocido: false });
    assert.deepStrictEqual(DC.interpretarProducto('{"reconocido":true,"producto":"","tienda":"x"}'), { reconocido: false });
  });
  await caso('limpia saltos de línea y formato', () => {
    const p = DC.interpretarProducto('{"reconocido":true,"producto":"taladro\\n*gratis*","con_articulo":"un taladro","tienda":"ferretería","tiendas":"ferreterías"}');
    assert.strictEqual(p.producto, 'taladro gratis');
  });

  console.log('4. Búsqueda con los textos de la compra');
  const p = { reconocido: true, producto: 'taladro', conArticulo: 'un taladro', tienda: 'ferretería', tiendas: 'ferreterías' };
  await caso('3 mejores con Cómo llegar y el aviso de existencias', async () => {
    lugaresDeGoogle = [lugar('a', 'Ferretería Uno', 0.005), lugar('b', 'Ferretería Dos', 0.002), lugar('c', 'Ferretería Tres', 0.008), lugar('d', 'Ferretería Cuatro', 0.01)];
    llamadas.length = 0;
    const r = await buscarCerca('u1', ORIGEN, DC.opcionesDeBusqueda(p));
    assert.ok(r.startsWith('🛒 Parece un taladro. Lo venden normalmente en ferreterías:'), r);
    assert.strictEqual((r.match(/Cómo llegar: https:\/\/www\.google\.com\/maps\/dir\//g) || []).length, 3);
    assert.ok(r.includes('Ferretería Dos'));
    assert.ok(!r.includes('Ferretería Cuatro'));
    assert.ok(r.trim().endsWith(DC.PIE));
    assert.ok(llamadas[0].url.endsWith(':searchText'), 'debe buscar por texto');
    assert.strictEqual(llamadas[0].cuerpo.textQuery, 'taladro ferretería');
  });
  await caso('sin resultados: lo dice y no inventa tiendas', async () => {
    lugaresDeGoogle = [];
    const r = await buscarCerca('u1', ORIGEN, DC.opcionesDeBusqueda(p));
    assert.strictEqual(r, '🛒 Parece un taladro, pero no encontré ferreterías que lo vendan cerca de ti (busqué hasta 8 km).');
  });
  await caso('pedir ubicación', () => {
    assert.match(DC.pedirUbicacion(p), /Parece un taladro\. Lo venden normalmente en ferreterías\.\n\n📍 Para buscarte dónde, compárteme tu ubicación/);
  });

  console.log('5. Topes');
  await caso('con 20 búsquedas hoy no se busca', async () => {
    conteoBusquedas = 20;
    llamadas.length = 0;
    const r = await buscarCerca('u1', ORIGEN, DC.opcionesDeBusqueda(p));
    assert.match(r, /Ya hiciste las 20 búsquedas de lugares de hoy/);
    assert.strictEqual(llamadas.length, 0);
    conteoBusquedas = 0;
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
