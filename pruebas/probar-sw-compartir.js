// Pruebas de "Compartir → Kontrol" en el service worker y el manifest — npm run probar-sw-compartir
//
// Carga sw.js de verdad en un contexto aislado (self, caches y fetch simulados):
//   1. El manifest declara share_target con POST multipart y acepta .vcf; index.html lo usa.
//   2. Un POST a /compartir-contacto con un .vcf lo deja en la caché 'kontrol-compartido' y
//      redirige a /?compartido=1. También acepta el contacto como texto.
//   3. Una actualización del service worker no borra lo compartido que espera.
//   4. vercel.json manda /compartir-contacto al respaldo y sirve el manifest y los íconos.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const raiz = path.join(__dirname, '..');
const leer = f => fs.readFileSync(path.join(raiz, f), 'utf8');

function cargarSw() {
  const oyentes = {};
  const cachesGuardadas = {};
  const borradas = [];
  const caches = {
    open: async nombre => {
      const c = (cachesGuardadas[nombre] = cachesGuardadas[nombre] || new Map());
      return { put: async (k, r) => c.set(String(k), await r.text()), match: async k => c.get(String(k)), delete: async k => c.delete(String(k)), add: async () => {} };
    },
    keys: async () => Object.keys(cachesGuardadas),
    delete: async n => { borradas.push(n); delete cachesGuardadas[n]; return true; }
  };
  const self = { addEventListener: (ev, fn) => { oyentes[ev] = fn; }, location: { origin: 'https://kontrol-app-eight.vercel.app' }, skipWaiting: () => {}, clients: { claim: async () => {} } };
  vm.runInNewContext(leer('sw.js'), { self, caches, fetch: async () => { throw new Error('sin red'); }, Response, Request, URL, Promise, JSON, console });
  return { oyentes, cachesGuardadas, borradas, caches };
}

function peticionCompartir({ archivos = [], texto = '', titulo = '' } = {}) {
  return {
    method: 'POST', url: 'https://kontrol-app-eight.vercel.app/compartir-contacto',
    formData: async () => ({
      get: k => (k === 'text' ? texto : k === 'title' ? titulo : null),
      getAll: k => (k === 'contacto' ? archivos.map(t => ({ size: t.length, text: async () => t })) : [])
    })
  };
}
async function enviar(sw, req) {
  let respuesta = null;
  sw.oyentes.fetch({ request: req, respondWith: p => { respuesta = p; } });
  return respuesta && await respuesta;
}

let fallas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log('  ✓', nombre); }
  catch (e) { fallas++; console.log('  ✗', nombre, '\n     ', e.message); }
}
const VCF = 'BEGIN:VCARD\nVERSION:3.0\nFN:George\nTEL;TYPE=CELL:300 123 4567\nEND:VCARD\n';

(async () => {
  console.log('1. Manifest');
  await caso('share_target por POST multipart que acepta .vcf', () => {
    const m = JSON.parse(leer('manifest.webmanifest'));
    assert.strictEqual(m.share_target.action, '/compartir-contacto');
    assert.strictEqual(m.share_target.method, 'POST');
    assert.strictEqual(m.share_target.enctype, 'multipart/form-data');
    const archivos = m.share_target.params.files[0];
    assert.strictEqual(archivos.name, 'contacto');
    assert.ok(archivos.accept.includes('text/vcard') && archivos.accept.includes('.vcf'));
    assert.deepStrictEqual(m.icons.map(i => i.src), ['/icono-192.png', '/icono-512.png']);
    for (const i of m.icons) assert.ok(fs.existsSync(path.join(raiz, i.src)), i.src);
  });
  await caso('index.html usa el manifest real (no data:)', () => {
    const h = leer('index.html');
    assert.ok(h.includes('<link rel="manifest" href="/manifest.webmanifest"/>'));
    assert.ok(!/rel="manifest" href="data:/.test(h));
  });

  console.log('2. El service worker recibe lo compartido');
  await caso('un .vcf: lo guarda y abre /?compartido=1', async () => {
    const sw = cargarSw();
    const r = await enviar(sw, peticionCompartir({ archivos: [VCF], titulo: 'George' }));
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.get('location'), 'https://kontrol-app-eight.vercel.app/?compartido=1');
    const guardado = JSON.parse(sw.cachesGuardadas['kontrol-compartido'].get('/__compartido'));
    assert.deepStrictEqual(guardado.textos, [VCF]);
    assert.strictEqual(guardado.titulo, 'George');
  });
  await caso('el contacto como texto (algunas apps lo mandan así)', async () => {
    const sw = cargarSw();
    await enviar(sw, peticionCompartir({ texto: VCF }));
    assert.deepStrictEqual(JSON.parse(sw.cachesGuardadas['kontrol-compartido'].get('/__compartido')).textos, [VCF]);
  });
  await caso('un archivo gigante no se guarda', async () => {
    const sw = cargarSw();
    await enviar(sw, peticionCompartir({ archivos: ['x'.repeat(300 * 1024)] }));
    assert.deepStrictEqual(JSON.parse(sw.cachesGuardadas['kontrol-compartido'].get('/__compartido')).textos, []);
  });
  await caso('otros POST no se tocan', async () => {
    const sw = cargarSw();
    const r = await enviar(sw, { method: 'POST', url: 'https://kontrol-app-eight.vercel.app/api/ai-chat' });
    assert.strictEqual(r, null);
  });

  console.log('3. Actualizar el service worker no borra lo compartido');
  await caso('activate borra cachés viejas, no la de lo compartido', async () => {
    const sw = cargarSw();
    await (await sw.caches.open('kontrol-v1')).put('/x', new Response('viejo'));
    await enviar(sw, peticionCompartir({ archivos: [VCF] }));
    let espera;
    sw.oyentes.activate({ waitUntil: p => { espera = p; } });
    await espera;
    assert.ok(sw.borradas.includes('kontrol-v1'));
    assert.ok(!sw.borradas.includes('kontrol-compartido'));
  });

  console.log('4. vercel.json');
  await caso('rutas del manifest, los íconos y el respaldo, antes de la ruta a index.html', () => {
    const v = JSON.parse(leer('vercel.json'));
    const i = src => v.routes.findIndex(r => r.src === src);
    const todo = i('/(.*)');
    for (const src of ['/manifest\\.webmanifest', '/icono-(192|512)\\.png', '/compartir-contacto']) {
      assert.ok(i(src) >= 0 && i(src) < todo, src);
    }
    assert.strictEqual(v.routes[i('/manifest\\.webmanifest')].headers['Content-Type'], 'application/manifest+json');
    assert.deepStrictEqual(v.routes[i('/compartir-contacto')].methods, ['POST']);
  });
  await caso('el respaldo redirige a /?compartido=sin-sw', () => {
    const handler = require('../api/compartir-contacto');
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { this.fin = true; } };
    handler({}, res);
    assert.strictEqual(res.statusCode, 303);
    assert.strictEqual(res.headers.Location, '/?compartido=sin-sw');
  });

  console.log(fallas ? `\n${fallas} prueba(s) fallaron` : '\nTodo bien');
  process.exit(fallas ? 1 : 0);
})();
