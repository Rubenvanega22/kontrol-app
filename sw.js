// /sw.js — Service Worker para Kontrol
// Estrategia: stale-while-revalidate para HTML y assets estáticos.
//   - Visita 1: cache miss → fetch del network → guarda en cache → sirve
//   - Visita 2+: sirve del cache INSTANTÁNEO → revalida en background → updates aplican en visita 3
// API calls (/api/*) y Supabase auth/REST (*.supabase.co) SIEMPRE pasan al network.
//
// El nombre del cache lleva versión: bump CACHE_VERSION cuando cambie la estructura
// del SW o se quiera invalidar todo lo cacheado.

const CACHE_VERSION = 'v1';
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
      .then((cache) => cache.addAll(PRECACHE_URLS).catch((e) => {
        // Si algún recurso del precache falla, no abortamos la instalación.
        // El SW se activa igual y caché irá llenándose en runtime.
        console.warn('[sw] precache parcial:', e.message);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo cacheamos GET. POSTs (login, ai-chat, etc.) pasan directo.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // No cachear API propia — son datos dinámicos por usuario.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // No cachear llamadas a Supabase (REST, auth, realtime). Cambian cada request.
  if (url.hostname.endsWith('supabase.co')) return;

  // No cachear el propio sw.js — Vercel también pone Cache-Control: no-cache (commit E).
  if (url.pathname === '/sw.js') return;

  // Stale-while-revalidate para todo lo demás (HTML, JS, CSS, fonts, imagenes inline).
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req).then((resp) => {
          // Solo cacheamos respuestas exitosas. Opaque (cross-origin no-cors) también pasan.
          if (resp && (resp.ok || resp.type === 'opaque')) {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        }).catch(() => cached); // si red falla, devolvemos lo cacheado (si hay)

        // Si hay cache, devolvemos YA (instantáneo) y revalidamos en background.
        return cached || networkFetch;
      })
    )
  );
});
