// /sw.js — Service Worker para Kontrol
// Estrategia: stale-while-revalidate para HTML y assets estáticos.
//   - Con caché: sirve al instante y revalida en background.
//   - Sin caché: va a la red y guarda.
// /api/*, Supabase y /version.json SIEMPRE pasan al network.
//
// Las actualizaciones las detecta la página comparando su versión con /version.json.
// Antes de recargar borra el HTML de esta caché, así la recarga trae el nuevo.
//
// El nombre del cache lleva versión: bump CACHE_VERSION cuando cambie la estructura
// del SW o se quiera invalidar todo lo cacheado.

const CACHE_VERSION = 'v3';
const CACHE_NAME = `kontrol-${CACHE_VERSION}`;

// Recursos a pre-cachear en install. Estos son los que bloquean el primer paint.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  'https://unpkg.com/@supabase/supabase-js@2.105.4/dist/umd/supabase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache:'reload' evita guardar una copia vieja de la caché HTTP. Uno por uno: si
      // alguno falla, los demás quedan y la caché se sigue llenando en runtime.
      .then((cache) => Promise.allSettled(
        PRECACHE_URLS.map((u) => cache.add(new Request(u, { cache: 'reload' })))
      ))
      .then(() => self.skipWaiting())
  );
});

// "Compartir → Kontrol" (share_target del manifest): lo compartido espera aquí hasta que la
// página lo lea. Es una caché aparte para que una actualización no lo borre en el camino.
const CACHE_COMPARTIDO = 'kontrol-compartido';
const CLAVE_COMPARTIDO = '/__compartido';
const MAX_COMPARTIDO = 256 * 1024;

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME && k !== CACHE_COMPARTIDO).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Recibe un contacto compartido desde la app de Contactos (archivo .vcf o texto vCard),
// lo deja en CACHE_COMPARTIDO y abre Kontrol, que lo guarda con la sesión del usuario.
async function recibirCompartido(req) {
  const textos = [];
  let titulo = '';
  try {
    const datos = await req.formData();
    titulo = String(datos.get('title') || '').slice(0, 200);
    for (const archivo of datos.getAll('contacto')) {
      if (archivo && typeof archivo.text === 'function' && archivo.size <= MAX_COMPARTIDO) textos.push(await archivo.text());
    }
    const texto = String(datos.get('text') || '');
    if (texto && texto.length <= MAX_COMPARTIDO) textos.push(texto);
  } catch (e) {
    textos.length = 0;
  }
  const cache = await caches.open(CACHE_COMPARTIDO);
  await cache.put(CLAVE_COMPARTIDO, new Response(JSON.stringify({ textos, titulo, at: Date.now() }), {
    headers: { 'Content-Type': 'application/json' }
  }));
  return Response.redirect(new URL('/?compartido=1', self.location.origin).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/compartir-contacto') {
    event.respondWith(recibirCompartido(req));
    return;
  }

  // Solo cacheamos GET. POSTs (login, ai-chat, etc.) pasan directo.
  if (req.method !== 'GET') return;

  // No cachear API propia — son datos dinámicos por usuario.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // No cachear llamadas a Supabase (REST, auth, realtime). Cambian cada request.
  if (url.hostname.endsWith('supabase.co')) return;

  // No cachear el propio sw.js ni la versión publicada.
  if (url.pathname === '/sw.js' || url.pathname === '/version.json') return;

  // El HTML revalida contra el servidor, sin confiar en la caché HTTP del navegador.
  const esHtml = req.mode === 'navigate' || (url.origin === self.location.origin && (url.pathname === '/' || url.pathname === '/index.html'));
  const aRed = esHtml ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' }) : req;

  // Stale-while-revalidate para todo lo demás (HTML, JS, CSS, fonts, imagenes inline).
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req, { ignoreSearch: esHtml }).then((cached) => {
        const networkFetch = fetch(aRed).then((resp) => {
          // Solo cacheamos respuestas exitosas. Opaque (cross-origin no-cors) también pasan.
          if (resp && (resp.ok || resp.type === 'opaque')) {
            cache.put(esHtml ? url.origin + url.pathname : req, resp.clone()).catch(() => {});
          }
          return resp;
        }).catch(() => cached); // si red falla, devolvemos lo cacheado (si hay)

        // Si hay cache, devolvemos YA (instantáneo) y revalidamos en background.
        return cached || networkFetch;
      })
    )
  );
});
