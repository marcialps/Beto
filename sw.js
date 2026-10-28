/* Agrovel — service worker com caminhos relativos ao escopo.
   Funciona tanto em https://agrovel.agr.br/ quanto em
   https://marcialps.github.io/Beto/. */
const CACHE_NAME = 'agrovel-v19';
const SCOPE = self.registration.scope;
const STATIC_PATHS = [
  'index.html',
  'app.js',
  'firebase-config.js',
  'admin-config.js',
  'bombastico.js',
  'css/style.css',
  'img/logo.webp'
];
const STORAGE_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com'];

function scopeUrl(path) {
  return new URL(path, SCOPE).href;
}

async function openCache() {
  return caches.open(CACHE_NAME);
}

function isStorageRequest(url) {
  return STORAGE_HOSTS.indexOf(url.hostname) !== -1;
}

function supportsMediaCache(url) {
  return url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.gstatic.com';
}

// Adiciona ao cache com timeout: em rede lenta um arquivo grande nao pode
// pendurar a instalacao do service worker para sempre.
function cacheAddTimed(cache, url, ms) {
  // cache:'reload' ignora o cache HTTP e garante que a instalacao guarde a
  // versao recem-publicada (GitHub Pages costuma responder com max-age).
  const fresh = fetch(url, { cache: 'reload' }).then(function (response) {
    if (response && response.ok) return cache.put(url, response);
  }).catch(function () {});
  return Promise.race([
    fresh,
    new Promise(function (res) { setTimeout(res, ms); })
  ]);
}

// Serve do cache IMEDIATAMENTE e atualiza o cache em segundo plano.
async function staleWhileRevalidate(request, fallbackUrl) {
  const cache = await openCache();
  let cached = await cache.match(request);
  if (!cached && fallbackUrl) {
    cached = await cache.match(fallbackUrl);
  }

  const networkFetch = fetch(request).then(function (response) {
    if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
      try { cache.put(request, response.clone()); } catch (e) {}
    }
    return response;
  }).catch(function () {
    return cached || OFFLINE_RESPONSE;
  });

  if (cached) {
    networkFetch.then(function () {});
    return cached;
  }
  return networkFetch;
}

// Fallback minimo quando nao ha cache e a rede falhou.
const OFFLINE_RESPONSE = new Response(
  '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>' +
  '<style>body{font-family:system-ui,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#14532d}.box{text-align:center;padding:24px}.c{width:36px;height:36px;border:4px solid #bbf7d0;border-top-color:#16a34a;border-radius:50%;animation:s 1s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}</style></head>' +
  '<body><div class="box"><div class="c"></div><h2>Sem conex&atilde;o</h2><p style="color:#166534">Conecte-se &agrave; internet e tente novamente.</p><button onclick="location.reload()" style="margin-top:12px;background:#16a34a;color:#fff;border:none;padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer">Tentar novamente</button></div></body></html>',
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
);

self.addEventListener('install', function (event) {
  event.waitUntil(
    openCache().then(function (cache) {
      return Promise.allSettled(
        STATIC_PATHS.map(function (path) {
          return cacheAddTimed(cache, scopeUrl(path), 15000);
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; }).map(function (key) {
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (isStorageRequest(url) && /(uploadType=resumable|\/upload\?)/.test(event.request.url)) return;

  // Imagens do catalogo (Firebase Storage): cache-first + revalidacao.
  if (isStorageRequest(url)) {
    event.respondWith(staleWhileRevalidate(event.request, null));
    return;
  }

  // Navegacao: entrega o HTML em cache na hora e atualiza em segundo plano.
  // O shell do index.html tem <base> recalculado por script, entao pode ser
  // usado como fallback de qualquer rota (inclusive produto/blog).
  if (event.request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event.request, scopeUrl('index.html')));
    return;
  }

  // CDNs estaveis (Font Awesome / fontes) e assets locais: cache + revalidacao.
  if (supportsMediaCache(url) || url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request, null));
    return;
  }
});
