const CACHE_NAME = 'agrovel-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/firebase-config.js',
  '/admin-config.js',
  '/css/style.css',
  '/img/logo.gif'
];
const STORAGE_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com'];

async function openCache() {
  return caches.open(CACHE_NAME);
}

function isStorageRequest(url) {
  return STORAGE_HOSTS.indexOf(url.hostname) !== -1;
}

function supportsMediaCache(url) {
  return url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.gstatic.com';
}

// Adiciona ao cache com timeout: em rede lenta um arquivo grande (ex.: logo.gif)
// nao pode pendurar a instalacao do service worker para sempre.
function cacheAddTimed(cache, url, ms) {
  return Promise.race([
    cache.add(url).catch(function () {}),
    new Promise(function (res) { setTimeout(res, ms); })
  ]);
}

// Serve do cache IMEDIATAMENTE e atualiza o cache em segundo plano.
// É o padrão ideal para internet lenta: nada precisa esperar a rede.
async function staleWhileRevalidate(request, useIndexFallback) {
  const cache = await openCache();
  let cached = await cache.match(request);
  if (!cached && useIndexFallback) {
    cached = await cache.match('/index.html');
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
    // Atualiza o cache em background, sem bloquear a resposta atual.
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
      // Instalacao resiliente: se um asset falhar (ex.: internet lenta),
      // os demais ainda sao cacheados e o service worker instala normalmente.
      return Promise.allSettled(
        STATIC_ASSETS.map(function (url) {
          return cacheAddTimed(cache, url, 15000);
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

  // Nao interceptar uploads do Storage (resumable upload usa POST) nem
  // qualquer metodo que nao seja GET.
  if (event.request.method !== 'GET') return;

  // Uploads do Storage tambem sao GETs de verificacao de upload; evita cachear.
  if (isStorageRequest(url) && /(uploadType=resumable|\/upload\?)/.test(event.request.url)) return;

  // Imagens do catalogo (Firebase Storage): cache-first + revalidacao.
  if (isStorageRequest(url)) {
    event.respondWith(staleWhileRevalidate(event.request, false));
    return;
  }

  // Navegacao: abre IMEDIATAMENTE o HTML do cache e atualiza em background.
  if (event.request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event.request, true));
    return;
  }

  // CDNs estaveis (Font Awesome / fontes) e assets locais: cache + revalidacao.
  if (supportsMediaCache(url) || url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request, false));
    return;
  }
});