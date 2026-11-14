// Prueba REAL de "¿dónde compro esto?" contra Google Places (gasta llamadas de verdad).
// No toca la base: Supabase va simulado, así que no cuenta en los topes del día.
//
//   node --env-file=.env.local scripts/probar-compra-real.js [producto] [lat] [lng]
//
// Por defecto: el ventilador de la prueba fallida, en Jamundí (Valle).
// Muestra cada intento (texto buscado y cuántos volvió Google) y la respuesta final.

const path = require('path');

require.cache[path.resolve(__dirname, '../lib/supabase.js')] = {
  id: 'supabase', filename: 'supabase', loaded: true,
  exports: {
    from: () => {
      const q = new Proxy(function () {}, {
        get(_, prop) {
          if (prop === 'then') return (ok) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok);
          return () => q;
        }
      });
      return q;
    }
  }
};

if (!process.env.GOOGLE_PLACES_KEY) {
  console.error('Falta GOOGLE_PLACES_KEY. Corre: vercel env pull .env.local y luego node --env-file=.env.local scripts/probar-compra-real.js');
  process.exit(1);
}

const { buscarCerca } = require('../lib/lugares');
const DC = require('../lib/donde-compro');

const [producto = 'ventilador de pared', lat = '3.2610', lng = '-76.5390'] = process.argv.slice(2);
const origen = { lat: Number(lat), lng: Number(lng) };
// Lo mismo que respondió Haiku en la prueba fallida, más las tiendas generales nuevas.
const p = {
  reconocido: true, producto, generico: producto.split(' ')[0], conArticulo: `un ${producto}`,
  tienda: 'tienda de electrónica', tiendas: 'tiendas de electrónica', otras: ['Éxito', 'Homecenter']
};

(async () => {
  console.log(`Buscando "${producto}" cerca de ${origen.lat}, ${origen.lng}\n`);
  const respuesta = await buscarCerca('prueba', origen, DC.opcionesDeBusqueda(p));
  console.log('\n──── Respuesta que llegaría por WhatsApp ────\n');
  console.log(respuesta);
})().catch(e => { console.error('Falló:', e.message); process.exit(1); });
