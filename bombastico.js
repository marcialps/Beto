/* ============================================================
 * BOMBÁSTICO — super oferta com popup animado
 * ------------------------------------------------------------
 * Persistência: Firestore, documento único
 *   agrovel_data/bombastico  ->  { v: { product_id, offer_price, active, updated_at } }
 *
 * O formato de documento único garante a regra de negócio: só pode existir
 * UMA oferta ativa por vez. Ao salvar uma nova configuração, a anterior é
 * substituída automaticamente.
 *
 * O componente público é montado em #bombastico-root (root layout) e o painel
 * administrativo é renderizado pelo renderAdminSection() em index.html.
 * ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'agrovel_bombastico_config_v1';
  var SESSION_SEEN_KEY = 'agrovel_bombastico_seen_v1';
  var SESSION_CLOSED_KEY = 'agrovel_bombastico_closed_v1';
  var DELAY_MS = 30000;          // 30s após a entrada no site
  var FUSE_PHASE_MS = 1200;      // 0 - 1.2s: bomba caindo
  var OFFER_PHASE_MS = 1600;     // 1.2 - 1.6s: explosão; 1.6s+: card
  var COMBO_LIMIT = 150;

  var EMPTY_CONFIG = { product_id: null, offer_price: 0, active: false, updated_at: null };

  var state = readCache();
  var remoteLoaded = false;
  var loadAttempted = false;
  var loadPromise = null;
  var loadError = null;

  var initialized = false;
  var timer = null;
  var stageTimers = [];
  var popupOpen = false;
  var lastFocus = null;

  var adminProductsCache = null;
  var comboIndex = -1;

  /* ------------------------------------------------------------
   * Utilidades
   * ---------------------------------------------------------- */
  function cloneConfig(cfg) {
    return {
      product_id: cfg && cfg.product_id ? String(cfg.product_id) : null,
      offer_price: Number(cfg && cfg.offer_price) || 0,
      active: !!(cfg && cfg.active),
      updated_at: (cfg && cfg.updated_at) || null
    };
  }

  function normalizeConfig(raw) {
    raw = raw || {};
    var productId = raw.product_id != null ? raw.product_id : raw.productId;
    var price = raw.offer_price != null ? raw.offer_price : raw.offerPrice;
    price = Number(price);
    if (!isFinite(price) || price < 0) price = 0;
    return {
      product_id: productId ? String(productId) : null,
      offer_price: price,
      active: raw.active === true || raw.active === 'true' || raw.active === 1,
      updated_at: raw.updated_at || raw.updatedAt || null
    };
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeConfig(JSON.parse(raw));
    } catch (e) {}
    return cloneConfig(EMPTY_CONFIG);
  }

  function writeCache() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function getDb() {
    try {
      if (window.firebase && firebase.apps && firebase.apps.length) return firebase.firestore();
    } catch (e) {}
    return null;
  }

  function configRef() {
    var db = getDb();
    if (!db) return null;
    return db.collection('agrovel_data').doc('bombastico');
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBRL(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function formatPriceNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parsePriceInput(text) {
    var digits = String(text == null ? '' : text).replace(/\D/g, '');
    if (!digits) return 0;
    return parseInt(digits, 10) / 100;
  }

  function normalizeText(value) {
    var s = String(value == null ? '' : value);
    try {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } catch (e) {}
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function toast(message, type) {
    try {
      if (typeof showToast === 'function') {
        showToast(message, type || 'success');
        return;
      }
    } catch (e) {}
    try { console.log('[Bombástico] ' + message); } catch (e2) {}
  }

  function currentAdminSection() {
    try { return typeof State !== 'undefined' ? State.adminSection : null; } catch (e) { return null; }
  }

  function currentView() {
    try { return typeof State !== 'undefined' ? String(State.view || '') : ''; } catch (e) { return ''; }
  }

  function rerenderAdminIfNeeded() {
    if (currentAdminSection() !== 'bombastico') return;
    try {
      if (typeof renderAdminSection === 'function') renderAdminSection();
    } catch (e) {}
  }

  function retrieveProduct(id) {
    if (!id) return null;
    try {
      var list = (typeof DB !== 'undefined' && DB.products) ? (DB.products() || []) : [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && String(list[i].id) === String(id)) return list[i];
      }
    } catch (e) {}
    return null;
  }

  function allProducts() {
    if (adminProductsCache) return adminProductsCache;
    var list = [];
    try {
      if (typeof DB !== 'undefined' && DB.products) list = DB.products() || [];
    } catch (e) {}
    adminProductsCache = list.filter(function (p) {
      return p && p.id && p.name;
    }).sort(function (a, b) {
      return String(a.name).localeCompare(String(b.name), 'pt-BR');
    });
    return adminProductsCache;
  }

  function productCountLabel(total) {
    return total + ' produto' + (total === 1 ? '' : 's') + ' cadastrado' + (total === 1 ? '' : 's') + '. Digite para buscar.';
  }

  function summaryHTML(cfg, products) {
    if (!cfg.product_id) {
      return 'Nenhuma oferta configurada ainda. Selecione um produto e salve para começar.';
    }
    var selected = null;
    for (var i = 0; i < products.length; i++) {
      if (String(products[i].id) === String(cfg.product_id)) { selected = products[i]; break; }
    }
    return 'Produto atual: <strong class="text-gray-700">' + escapeHTML(selected ? selected.name : 'produto não encontrado no catálogo') + '</strong>' +
      ' &middot; Oferta: <strong class="text-red-600">' + formatBRL(cfg.offer_price) + '</strong>';
  }

  // O catálogo chega em lotes: atualiza o combobox sem remontar o painel,
  // preservando o texto que o administrador está digitando.
  function refreshProducts() {
    adminProductsCache = null;
    var count = document.getElementById('bombastico-product-count');
    if (!count) return;
    var products = allProducts();
    count.textContent = productCountLabel(products.length);
    var summary = document.getElementById('bombastico-summary');
    if (summary) summary.innerHTML = summaryHTML(state, products);
    var box = document.getElementById('bombastico-product-options');
    var input = document.getElementById('bombastico-product-search');
    if (box && input && !box.classList.contains('hidden')) {
      renderProductOptions(input.value || '');
    }
  }

  /* ------------------------------------------------------------
   * Firestore — leitura / gravação / toggle
   * ---------------------------------------------------------- */
  function loadConfig(force) {
    if (loadPromise) return loadPromise;
    if (remoteLoaded && !force) return Promise.resolve(cloneConfig(state));

    var ref = configRef();
    if (!ref) return Promise.resolve(cloneConfig(state)); // Firebase ainda não inicializado

    loadAttempted = true;
    loadPromise = ref.get().then(function (snap) {
      var data = snap.exists ? (snap.data() || {}) : {};
      var payload = (data && data.v && typeof data.v === 'object') ? data.v : data;
      state = normalizeConfig(payload);
      writeCache();
      remoteLoaded = true;
      loadError = null;
      return cloneConfig(state);
    }).catch(function (err) {
      console.error('Bombástico: falha ao carregar configuração', err);
      loadError = err;
      return cloneConfig(state);
    }).then(function (out) {
      loadPromise = null;
      rerenderAdminIfNeeded();
      return out;
    }, function (err) {
      loadPromise = null;
      rerenderAdminIfNeeded();
      throw err;
    });

    return loadPromise;
  }

  function saveConfig(payload) {
    var next = normalizeConfig({
      product_id: payload && payload.product_id !== undefined ? payload.product_id : state.product_id,
      offer_price: payload && payload.offer_price !== undefined ? payload.offer_price : state.offer_price,
      active: payload && payload.active !== undefined ? payload.active : state.active,
      updated_at: new Date().toISOString()
    });

    var ref = configRef();
    if (!ref) return Promise.reject(new Error('Firebase não inicializado. Verifique a conexão.'));

    // Documento único: substitui a configuração anterior (e, portanto, desativa
    // qualquer oferta antiga) em uma única escrita atômica.
    return ref.set({ v: next }).then(function () {
      state = next;
      writeCache();
      remoteLoaded = true;
      loadError = null;
      return cloneConfig(state);
    }).catch(function (err) {
      console.error('Bombástico: falha ao salvar configuração', err);
      throw err;
    });
  }

  // Equivalente ao PATCH /toggle: alterna apenas o estado ativo da configuração.
  function toggleActive() {
    if (!state.product_id || !(Number(state.offer_price) > 0)) {
      return Promise.reject(new Error('Selecione um produto e salve a oferta antes de ativar.'));
    }
    return saveConfig({ active: !state.active });
  }

  /* ------------------------------------------------------------
   * Sessão do navegador
   * ---------------------------------------------------------- */
  function readSession(key) {
    try { return sessionStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  function writeSession(key) {
    try { sessionStorage.setItem(key, '1'); } catch (e) {}
  }

  function sessionConsumed() {
    return readSession(SESSION_SEEN_KEY) || readSession(SESSION_CLOSED_KEY);
  }

  function markSeen() {
    writeSession(SESSION_SEEN_KEY);
  }

  function markClosed() {
    writeSession(SESSION_CLOSED_KEY);
    writeSession(SESSION_SEEN_KEY);
  }

  /* ------------------------------------------------------------
   * Painel administrativo
   * ---------------------------------------------------------- */
  function toggleSwitch(on) {
    if (typeof toggleSwitchHtml === 'function') {
      return toggleSwitchHtml(!!on, 'Bombastico.toggleFromAdmin()');
    }
    return '<button type="button" onclick="Bombastico.toggleFromAdmin()" style="width:44px;height:24px;border-radius:999px;background:' +
      (on ? '#16a34a' : '#d1d5db') + ';border:none;position:relative;cursor:pointer;flex-shrink:0">' +
      '<span style="position:absolute;top:4px;left:' + (on ? '24px' : '4px') + ';width:16px;height:16px;border-radius:999px;background:#fff"></span>' +
      '</button>';
  }

  function renderAdminPage() {
    adminProductsCache = null;
    var cfg = state;
    var active = !!cfg.active;
    var products = allProducts();
    var selected = null;
    for (var i = 0; i < products.length; i++) {
      if (String(products[i].id) === String(cfg.product_id)) { selected = products[i]; break; }
    }

    if (!remoteLoaded && !loadPromise && !loadAttempted) {
      loadConfig().then(function () { rerenderAdminIfNeeded(); });
    }

    var syncLine = '';
    if (loadError) {
      syncLine = '<span class="text-xs font-medium text-red-600"><i class="fas fa-exclamation-circle mr-1"></i>Não foi possível sincronizar. ' +
        '<button type="button" onclick="bombasticoRetryLoad()" class="underline font-bold hover:text-red-700">Tentar novamente</button></span>';
    } else if (!remoteLoaded) {
      syncLine = '<span class="text-xs font-medium text-amber-600"><i class="fas fa-spinner fa-spin mr-1"></i>Sincronizando configuração...</span>';
    } else {
      syncLine = '<span class="text-xs font-medium text-green-600"><i class="fas fa-check-circle mr-1"></i>Configuração sincronizada</span>';
    }

    var statusPill = active
      ? '<span class="inline-flex items-center gap-1.5 text-xs font-bold text-green-700 bg-green-100 px-2.5 py-1 rounded-full"><i class="fas fa-circle" style="font-size:7px"></i>Ativado</span>'
      : '<span class="inline-flex items-center gap-1.5 text-xs font-bold text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full"><i class="fas fa-circle" style="font-size:7px"></i>Desativado</span>';

    var summary = summaryHTML(cfg, products);

    var warning = active
      ? '<div class="mb-6 flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3.5 text-amber-900">' +
          '<div class="w-9 h-9 rounded-xl bg-amber-200 text-amber-700 flex items-center justify-center flex-shrink-0"><i class="fas fa-clock"></i></div>' +
          '<div><div class="text-sm font-bold">Serviço ativo</div>' +
          '<p class="text-sm leading-relaxed text-amber-800 mt-0.5">Este produto aparecerá como Bombástico no site após 30s da visita.</p></div>' +
        '</div>'
      : '';

    return '<div class="p-4 md:p-8 fade-in max-w-4xl">' +
      '<div class="mb-6">' +
        '<h1 class="text-xl md:text-2xl font-bold text-gray-900 flex items-center gap-2"><i class="fas fa-bomb text-amber-500"></i>Bombástico</h1>' +
        '<p class="text-gray-400 text-sm mt-1">Configure a super oferta que explode na tela do cliente 30 segundos após a visita.</p>' +
      '</div>' +

      '<div class="bg-white rounded-2xl p-4 md:p-5 shadow-sm border border-gray-100 mb-6">' +
        '<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">' +
          '<div class="flex items-center gap-3 min-w-0">' +
            '<div class="w-11 h-11 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center flex-shrink-0"><i class="fas fa-bolt text-lg"></i></div>' +
            '<div class="min-w-0">' +
              '<div class="flex items-center gap-2 flex-wrap"><span class="font-bold text-gray-800">Ativar serviço</span>' + statusPill + '</div>' +
              '<div id="bombastico-summary" class="text-xs text-gray-400 mt-0.5">' + summary + '</div>' +
            '</div>' +
          '</div>' +
          '<div id="bombastico-toggle-wrap" class="flex items-center gap-3 flex-shrink-0">' + toggleSwitch(active) + '</div>' +
        '</div>' +
        '<div class="mt-3 pt-3 border-t border-gray-50">' + syncLine + '</div>' +
      '</div>' +

      warning +

      '<div class="bg-white rounded-2xl p-5 md:p-6 shadow-sm border border-gray-100">' +
        '<div class="flex items-start gap-3 mb-5">' +
          '<div class="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center flex-shrink-0"><i class="fas fa-bomb"></i></div>' +
          '<div>' +
            '<h2 class="font-bold text-gray-800">Configuração da super oferta</h2>' +
            '<p class="text-xs text-gray-400 mt-0.5 leading-relaxed">Apenas uma oferta fica ativa por vez. Ao salvar uma nova, a anterior é substituída automaticamente.</p>' +
          '</div>' +
        '</div>' +

        '<form onsubmit="bombasticoSave(event)" novalidate class="space-y-5">' +
          '<div>' +
            '<label for="bombastico-product-search" class="text-sm font-medium text-gray-600 mb-1.5 block">Produto *</label>' +
            '<div id="bombastico-combo" class="relative">' +
              '<i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none"></i>' +
              '<input id="bombastico-product-search" type="text" role="combobox" aria-expanded="false" aria-controls="bombastico-product-options" aria-autocomplete="list" autocomplete="off"' +
                ' value="' + escapeHTML(selected ? selected.name : '') + '"' +
                ' placeholder="Digite o nome do produto..."' +
                ' onfocus="bombasticoOpenProducts()" oninput="bombasticoFilterProducts(this.value)"' +
                ' onkeydown="bombasticoSearchKeydown(event)" onblur="bombasticoCloseProductsSoon()"' +
                ' class="w-full pl-11 pr-11 py-3 border border-gray-200 rounded-xl focus:border-green-500 focus:ring-2 focus:ring-green-100 outline-none text-sm text-gray-800 bg-white">' +
              '<input id="bombastico-product-id" type="hidden" value="' + escapeHTML(cfg.product_id || '') + '">' +
              '<button type="button" id="bombastico-product-clear" onclick="bombasticoClearProduct()" aria-label="Limpar produto selecionado"' +
                ' class="absolute right-2.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center transition-colors">' +
                '<i class="fas fa-times text-xs"></i></button>' +
              '<div id="bombastico-product-options" role="listbox" aria-label="Produtos cadastrados" class="bombastico-combo-options hidden"></div>' +
            '</div>' +
            '<p id="bombastico-product-count" class="text-xs text-gray-400 mt-1.5">' + productCountLabel(products.length) + '</p>' +
          '</div>' +

          '<div>' +
            '<label for="bombastico-offer-price" class="text-sm font-medium text-gray-600 mb-1.5 block">Valor da oferta *</label>' +
            '<div class="relative">' +
              '<span class="absolute left-4 top-1/2 -translate-y-1/2 text-green-700 font-bold text-base pointer-events-none">R$</span>' +
              '<input id="bombastico-offer-price" type="text" inputmode="numeric" autocomplete="off"' +
                ' value="' + escapeHTML(cfg.offer_price ? formatPriceNumber(cfg.offer_price) : '') + '"' +
                ' placeholder="0,00" oninput="bombasticoPriceMask(this)"' +
                ' class="w-full pl-12 pr-4 py-3.5 border border-gray-200 rounded-xl focus:border-green-500 focus:ring-2 focus:ring-green-100 outline-none text-lg font-bold text-gray-900 bg-white">' +
            '</div>' +
            '<p class="text-xs text-gray-400 mt-1.5">O valor será exibido em destaque no popup, abaixo do preço original.</p>' +
          '</div>' +

          '<div class="flex flex-col sm:flex-row gap-3 pt-1">' +
            '<button id="bombastico-save-btn" type="submit" class="bg-green-600 hover:bg-green-500 text-white font-bold px-6 py-3 rounded-xl transition-colors flex items-center justify-center gap-2">' +
              '<i class="fas fa-save"></i>Salvar</button>' +
            '<button type="button" onclick="bombasticoReloadConfig()" class="px-6 py-3 border border-gray-200 rounded-xl hover:bg-gray-50 text-gray-600 font-medium transition-colors flex items-center justify-center gap-2">' +
              '<i class="fas fa-rotate-right"></i>Recarregar</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
  }

  function retryLoadFromAdmin() {
    loadError = null;
    loadAttempted = false;
    return loadConfig(true).then(function () {
      rerenderAdminIfNeeded();
      return !loadError;
    }).catch(function () {
      rerenderAdminIfNeeded();
      return false;
    });
  }

  function reloadConfigFromAdmin() {
    retryLoadFromAdmin().then(function (ok) {
      toast(
        ok ? 'Configuração do Bombástico atualizada.' : 'Não foi possível recarregar a configuração do Bombástico.',
        ok ? 'info' : 'error'
      );
    });
  }

  function openProducts() {
    var input = document.getElementById('bombastico-product-search');
    var box = document.getElementById('bombastico-product-options');
    if (!input || !box) return;
    box.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    renderProductOptions('');
  }

  function closeProducts() {
    var input = document.getElementById('bombastico-product-search');
    var box = document.getElementById('bombastico-product-options');
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    if (box) box.classList.add('hidden');
    comboIndex = -1;
  }

  function closeProductsSoon() {
    setTimeout(closeProducts, 160);
  }

  function renderProductOptions(query) {
    var box = document.getElementById('bombastico-product-options');
    if (!box) return;
    var hidden = document.getElementById('bombastico-product-id');
    var selectedId = hidden ? String(hidden.value || '') : '';
    var list = allProducts();
    var q = normalizeText(query);
    if (q) {
      list = list.filter(function (p) { return normalizeText(p.name).indexOf(q) >= 0; });
    }
    var total = list.length;
    var shown = list.slice(0, COMBO_LIMIT);
    comboIndex = -1;

    if (!shown.length) {
      box.innerHTML = '<div class="bombastico-combo-note">Nenhum produto encontrado.</div>';
      return;
    }

    var html = shown.map(function (p, index) {
      var isSelected = String(p.id) === selectedId;
      return '<button type="button" id="bombastico-opt-' + index + '" role="option" aria-selected="' + (isSelected ? 'true' : 'false') + '"' +
        ' data-bombastico-product-option="' + escapeHTML(p.id) + '"' +
        ' class="bombastico-combo-option' + (isSelected ? ' is-selected' : '') + '">' + escapeHTML(p.name) + '</button>';
    }).join('');

    if (total > COMBO_LIMIT) {
      html += '<div class="bombastico-combo-note">Mostrando ' + COMBO_LIMIT + ' de ' + total + '. Digite para refinar a busca.</div>';
    }
    box.innerHTML = html;
  }

  function filterProducts(value) {
    var box = document.getElementById('bombastico-product-options');
    var input = document.getElementById('bombastico-product-search');
    if (!box || !input) return;
    // Se o texto digitado nao corresponde mais ao produto escolhido, invalida
    // a selecao: evita salvar sem querer o produto anterior.
    var hidden = document.getElementById('bombastico-product-id');
    if (hidden && hidden.value) {
      var chosen = null;
      var list = allProducts();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(hidden.value)) { chosen = list[i]; break; }
      }
      if (!chosen || normalizeText(chosen.name) !== normalizeText(value)) hidden.value = '';
    }
    if (box.classList.contains('hidden')) {
      box.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
    }
    renderProductOptions(value || '');
  }

  function selectProduct(id) {
    var product = null;
    var list = allProducts();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) { product = list[i]; break; }
    }
    if (!product) return;
    var input = document.getElementById('bombastico-product-search');
    var hidden = document.getElementById('bombastico-product-id');
    if (input) input.value = product.name;
    if (hidden) hidden.value = product.id;
    closeProducts();
  }

  function clearProduct() {
    var input = document.getElementById('bombastico-product-search');
    var hidden = document.getElementById('bombastico-product-id');
    if (input) input.value = '';
    if (hidden) hidden.value = '';
    closeProducts();
    if (input) input.focus();
  }

  function updateComboHighlight(options) {
    var input = document.getElementById('bombastico-product-search');
    options.forEach(function (opt, index) {
      var on = index === comboIndex;
      opt.classList.toggle('is-highlighted', on);
      if (on && input) input.setAttribute('aria-activedescendant', opt.id);
    });
    if (comboIndex >= 0 && options[comboIndex]) {
      try { options[comboIndex].scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
    if (comboIndex < 0 && input) input.removeAttribute('aria-activedescendant');
  }

  function searchKeydown(event) {
    if (!event) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeProducts();
      return;
    }
    var box = document.getElementById('bombastico-product-options');
    if (!box || box.classList.contains('hidden')) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        openProducts();
      }
      return;
    }
    var options = Array.prototype.slice.call(box.querySelectorAll('[data-bombastico-product-option]'));
    if (!options.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowDown') comboIndex = Math.min(comboIndex + 1, options.length - 1);
      else comboIndex = Math.max(comboIndex - 1, 0);
      updateComboHighlight(options);
      return;
    }
    if (event.key === 'Enter' && comboIndex >= 0 && options[comboIndex]) {
      event.preventDefault();
      selectProduct(options[comboIndex].getAttribute('data-bombastico-product-option'));
    }
  }

  function priceMask(input) {
    if (!input) return;
    var digits = String(input.value || '').replace(/\D/g, '');
    if (digits.length > 11) digits = digits.slice(0, 11);
    input.value = digits ? formatPriceNumber(parseInt(digits, 10) / 100) : '';
  }

  function saveFromAdmin(event) {
    if (event && event.preventDefault) event.preventDefault();
    var hidden = document.getElementById('bombastico-product-id');
    var priceInput = document.getElementById('bombastico-offer-price');
    var productId = hidden ? String(hidden.value || '').trim() : '';
    var price = priceInput ? parsePriceInput(priceInput.value) : 0;

    if (!productId) {
      toast('Selecione um produto para a super oferta.', 'warn');
      return;
    }
    if (!price || price <= 0) {
      toast('Informe um valor de oferta maior que zero.', 'warn');
      return;
    }

    var button = document.getElementById('bombastico-save-btn');
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>Salvando...';
    }

    saveConfig({
      product_id: productId,
      offer_price: price,
      active: state.active
    }).then(function (cfg) {
      toast('Bombástico salvo com sucesso!' + (cfg.active ? ' O serviço está ativo.' : ''), 'success');
      rerenderAdminIfNeeded();
    }).catch(function (err) {
      console.error('Bombástico: erro ao salvar', err);
      toast('Não foi possível salvar o Bombástico. Verifique a conexão e tente novamente.', 'error');
      if (button) {
        button.disabled = false;
        button.innerHTML = '<i class="fas fa-save"></i>Salvar';
      }
    });
  }

  function toggleFromAdmin() {
    var wrap = document.getElementById('bombastico-toggle-wrap');
    var button = wrap ? wrap.querySelector('button') : null;
    if (button) button.disabled = true;

    var ready = remoteLoaded ? Promise.resolve(cloneConfig(state)) : loadConfig();
    ready.then(function () {
      if (!state.product_id || !(Number(state.offer_price) > 0)) {
        toast('Selecione um produto e salve a oferta antes de ativar o serviço.', 'warn');
        rerenderAdminIfNeeded();
        return;
      }
      return toggleActive().then(function (cfg) {
        toast(
          cfg.active
            ? 'Bombástico ativado! O popup aparecerá após 30s da visita.'
            : 'Bombástico desativado.',
          'success'
        );
        rerenderAdminIfNeeded();
      });
    }).catch(function (err) {
      console.error('Bombástico: erro ao alternar estado', err);
      toast('Não foi possível alterar o estado do Bombástico. Tente novamente.', 'error');
      rerenderAdminIfNeeded();
    });
  }

  /* ------------------------------------------------------------
   * Componente público — popup animado
   * ---------------------------------------------------------- */
  function bombSVG() {
    return '<svg class="bombastico-bomb" viewBox="0 0 140 150" aria-hidden="true" focusable="false">' +
      '<defs>' +
        '<radialGradient id="bombasticoBody" cx="32%" cy="28%" r="78%">' +
          '<stop offset="0%" stop-color="#6ee7b7"></stop>' +
          '<stop offset="38%" stop-color="#02a95c"></stop>' +
          '<stop offset="100%" stop-color="#014d2c"></stop>' +
        '</radialGradient>' +
        '<linearGradient id="bombasticoFuse" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" stop-color="#fbd341"></stop>' +
          '<stop offset="100%" stop-color="#fde482"></stop>' +
        '</linearGradient>' +
        '<filter id="bombasticoSparkGlow" x="-120%" y="-120%" width="340%" height="340%">' +
          '<feGaussianBlur stdDeviation="3.2" result="blur"></feGaussianBlur>' +
          '<feMerge><feMergeNode in="blur"></feMergeNode><feMergeNode in="SourceGraphic"></feMergeNode></feMerge>' +
        '</filter>' +
      '</defs>' +
      '<g class="bombastico-bomb-shake">' +
        '<path class="bombastico-fuse" d="M89 49 C105 35, 105 19, 92 12" fill="none" stroke="url(#bombasticoFuse)" stroke-width="6" stroke-linecap="round"></path>' +
        '<rect x="76" y="36" width="24" height="17" rx="5" transform="rotate(40 88 44)" fill="#045c38" stroke="#01291a" stroke-width="2"></rect>' +
        '<circle cx="58" cy="96" r="44" fill="url(#bombasticoBody)"></circle>' +
        '<circle cx="42" cy="79" r="12" fill="rgba(255,255,255,.2)"></circle>' +
        '<circle cx="43" cy="80" r="5" fill="rgba(255,255,255,.28)"></circle>' +
        '<g class="bombastico-spark" filter="url(#bombasticoSparkGlow)">' +
          '<circle cx="92" cy="11" r="8" fill="#fbd341"></circle>' +
          '<path d="M92 -5 L97 6 L108 11 L97 15 L92 27 L87 15 L76 11 L87 6 Z" fill="#fde482"></path>' +
        '</g>' +
      '</g>' +
    '</svg>';
  }

  function stageMarkup() {
    return '<div class="bombastico-stage">' +
      '<div class="bombastico-glow"></div>' +
      '<div class="bombastico-bomb-wrap">' + bombSVG() + '</div>' +
      '<p class="bombastico-teaser"><span>Prepare-se...</span>uma super oferta está prestes a explodir</p>' +
    '</div>';
  }

  function particlesMarkup() {
    var colors = ['#02a95c', '#fbd341', '#fde482', '#5eead4', '#ffffff', '#017a43'];
    var parts = [];
    var count = 34;
    for (var i = 0; i < count; i++) {
      var angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.35;
      var distance = 100 + Math.random() * 190;
      var tx = (Math.cos(angle) * distance).toFixed(1);
      var ty = (Math.sin(angle) * distance * 0.86).toFixed(1);
      var size = (5 + Math.random() * 8).toFixed(1);
      var color = colors[i % colors.length];
      var radius = i % 3 === 0 ? '2px' : '999px';
      var delay = (Math.random() * 0.07).toFixed(2);
      parts.push('<span class="bombastico-particle" style="--bomb-c:' + color + ';--tx:' + tx + 'px;--ty:' + ty + 'px;width:' + size + 'px;height:' + size + 'px;border-radius:' + radius + ';animation-delay:' + delay + 's"></span>');
    }
    return parts.join('');
  }

  function openOffer() {
    var id = state.product_id;
    closePopup();
    if (id && typeof navigate === 'function') {
      try { navigate('product', { productId: String(id) }); } catch (e) {}
    }
  }

  function closePopup() {
    if (!popupOpen) return;
    markClosed();
    popupOpen = false;
    clearStageTimers();
    var root = document.getElementById('bombastico-root');
    if (root) root.innerHTML = '';
    document.body.classList.remove('bombastico-open');
    document.removeEventListener('keydown', onKeydown, true);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus({ preventScroll: true }); } catch (e) { try { lastFocus.focus(); } catch (e2) {} }
    }
    lastFocus = null;
  }

  function onKeydown(event) {
    if (!popupOpen || !event) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePopup();
      return;
    }
    if (event.key !== 'Tab') return;
    var modal = document.querySelector('#bombastico-root .bombastico-modal');
    if (!modal) return;
    var focusables = Array.prototype.slice.call(
      modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function cardMarkup(cfg, product) {
    var offer = Number(cfg.offer_price) || 0;

    var imageSrc = '';
    try {
      if (typeof productCardImgSrc === 'function') imageSrc = productCardImgSrc(product) || '';
    } catch (e) {}
    if (!imageSrc && product.images && product.images[0]) imageSrc = product.images[0];
    if (!imageSrc && product.thumbs && product.thumbs[0]) imageSrc = product.thumbs[0];

    var focal = '';
    try {
      if (typeof imgFocal === 'function') focal = imgFocal(product, 0) || '';
    } catch (e) {}

    var isIdbImage = String(imageSrc).indexOf('idb:') === 0;
    var image = '';
    if (imageSrc) {
      var imgAttrs = 'class="bombastico-product-img" alt="' + escapeHTML(product.name) + '" loading="eager" decoding="async" style="' + focal + '"' +
        ' onload="this.closest(\'.bombastico-media\').classList.add(\'has-image\')"' +
        ' onerror="this.style.display=\'none\';this.closest(\'.bombastico-media\').classList.remove(\'has-image\')"';
      if (isIdbImage) {
        // Foto ainda presa no IndexedDB local: resolveIdbMedia() define o src.
        image = '<img data-idb="' + escapeHTML(imageSrc) + '" ' + imgAttrs + '>';
      } else {
        image = '<img src="' + escapeHTML(imageSrc) + '" ' + imgAttrs + '>';
      }
    }

    var price = formatBRL(offer).replace(/^R\$\s*/, '<span class="bombastico-price-currency">R$</span> ');

    return '<button type="button" class="bombastico-close" data-bombastico-close aria-label="Fechar oferta">' +
        '<i class="fas fa-times" aria-hidden="true"></i>' +
      '</button>' +
      '<button type="button" class="bombastico-offer" data-bombastico-cta title="Ver oferta" aria-label="Ver oferta de ' + escapeHTML(product.name) + '">' +
        '<span class="bombastico-media' + (imageSrc && !isIdbImage ? ' has-image' : '') + '">' +
          '<span class="bombastico-burst" aria-hidden="true">' +
            '<span class="bombastico-rays"></span>' +
            '<span class="bombastico-wave"></span>' +
            '<span class="bombastico-wave bombastico-wave-late"></span>' +
          '</span>' +
          '<span class="bombastico-product-frame">' +
            '<span class="bombastico-media-fallback" aria-hidden="true"><i class="fas fa-box-open"></i></span>' +
            image +
          '</span>' +
        '</span>' +
        '<span class="bombastico-content">' +
          '<span class="bombastico-product-name" id="bombastico-title">' + escapeHTML(product.name) + '</span>' +
          '<span class="bombastico-price" id="bombastico-price">' + price + '</span>' +
        '</span>' +
      '</button>';
  }

  function explosionPhase(overlay) {
    var fx = overlay ? overlay.querySelector('.bombastico-fx') : null;
    if (!fx) return;
    overlay.classList.add('is-exploding');
    fx.innerHTML = '<div class="bombastico-flash"></div>' +
      '<div class="bombastico-shockwave"></div>' +
      '<div class="bombastico-shockwave" style="animation-delay:.07s"></div>' +
      '<div class="bombastico-particles">' + particlesMarkup() + '</div>';
  }

  function offerPhase(overlay, cfg, product) {
    if (!overlay || !popupOpen) return;

    // Mantem a explosao viva por instantes atras do produto: o card entra no
    // mesmo centro/foco da bomba, emendando o clarão com a revelação da oferta.
    var fx = overlay.querySelector('.bombastico-fx');
    if (fx) {
      stageTimers.push(setTimeout(function () {
        if (fx.parentNode) fx.remove();
      }, 900));
    }

    var modal = document.createElement('div');
    modal.className = 'bombastico-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'bombastico-title');
    modal.setAttribute('aria-describedby', 'bombastico-price');
    modal.innerHTML = cardMarkup(cfg, product);

    overlay.appendChild(modal);
    try { if (typeof resolveIdbMedia === 'function') resolveIdbMedia(modal); } catch (e) {}

    modal.addEventListener('click', function (event) {
      var closer = event.target && event.target.closest ? event.target.closest('[data-bombastico-close]') : null;
      if (closer) {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        return;
      }
      openOffer();
    });

    var closeBtn = modal.querySelector('[data-bombastico-close]');
    if (closeBtn) {
      setTimeout(function () {
        if (!popupOpen) return;
        try { closeBtn.focus({ preventScroll: true }); } catch (e) { try { closeBtn.focus(); } catch (e2) {} }
      }, 60);
    }
  }

  function mountPopup(cfg, product) {
    if (popupOpen || sessionConsumed()) return;
    var root = document.getElementById('bombastico-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'bombastico-root';
      root.setAttribute('aria-live', 'polite');
      document.body.appendChild(root);
    }

    markSeen();
    popupOpen = true;
    lastFocus = document.activeElement;

    var overlay = document.createElement('div');
    overlay.className = 'bombastico-overlay';
    overlay.id = 'bombastico-overlay';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = '<div class="bombastico-backdrop" data-bombastico-backdrop></div>' +
      '<div class="bombastico-fx" aria-hidden="true">' + stageMarkup() + '</div>';
    root.appendChild(overlay);

    document.body.classList.add('bombastico-open');
    document.addEventListener('keydown', onKeydown, true);
    try { overlay.focus({ preventScroll: true }); } catch (e) { try { overlay.focus(); } catch (e2) {} }

    var backdrop = overlay.querySelector('[data-bombastico-backdrop]');
    if (backdrop) backdrop.addEventListener('click', function () {
      // Durante a queda da bomba ainda nao ha card: evita perder a oferta
      // com um clique acidental antes da explosao.
      if (overlay.querySelector('.bombastico-modal')) closePopup();
    });

    try {
      if (typeof trackEvent === 'function') trackEvent('promo_view', { title: 'Bombástico: ' + product.name });
    } catch (e) {}

    stageTimers.push(setTimeout(function () { explosionPhase(overlay); }, FUSE_PHASE_MS));
    stageTimers.push(setTimeout(function () { offerPhase(overlay, cfg, product); }, OFFER_PHASE_MS));
  }

  function clearStageTimers() {
    stageTimers.forEach(function (id) { try { clearTimeout(id); } catch (e) {} });
    stageTimers = [];
  }

  function attemptShow() {
    if (sessionConsumed()) return;

    if (!remoteLoaded) {
      // Tenta de novo no momento de exibir: uma falha passageira de rede no
      // boot nao pode impedir o popup de aparecer 30s depois.
      loadConfig().then(function () {
        if (remoteLoaded) attemptShow();
      });
      return;
    }

    var cfg = state;
    if (!cfg.active || !cfg.product_id || !(Number(cfg.offer_price) > 0)) return;

    var view = currentView();
    if (view === 'login' || view.indexOf('admin') === 0) return;

    var product = retrieveProduct(cfg.product_id);
    if (product) {
      mountPopup(cfg, product);
      return;
    }

    // O catálogo pode estar carregando: busca o documento completo e tenta de novo.
    try {
      if (typeof DB !== 'undefined' && DB._loadProduct) {
        DB._loadProduct(cfg.product_id).then(function (ok) {
          if (!ok || sessionConsumed()) return;
          var latest = state;
          if (!latest.active || String(latest.product_id) !== String(cfg.product_id)) return;
          var loadedProduct = retrieveProduct(cfg.product_id);
          if (loadedProduct) mountPopup(latest, loadedProduct);
        }).catch(function () {});
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------
   * Ciclo de vida
   * ---------------------------------------------------------- */
  function init() {
    if (!initialized) {
      initialized = true;
      if (!sessionConsumed()) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          attemptShow();
        }, DELAY_MS);
      }
      try { window.addEventListener('pagehide', destroy); } catch (e) {}
    }

    if (!remoteLoaded) {
      loadConfig().then(function () {
        if (remoteLoaded) rerenderAdminIfNeeded();
      });
    }
  }

  function destroy() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    clearStageTimers();
    if (popupOpen) closePopup();
  }

  function onDocumentClick(event) {
    var target = event && event.target;
    if (!target || !target.closest) return;
    var option = target.closest('[data-bombastico-product-option]');
    if (option) {
      event.preventDefault();
      selectProduct(option.getAttribute('data-bombastico-product-option'));
      return;
    }
    var combo = document.getElementById('bombastico-combo');
    if (combo && !combo.contains(target)) closeProducts();
  }

  try { document.addEventListener('click', onDocumentClick, false); } catch (e) {}

  /* ------------------------------------------------------------
   * API pública (usada pelo index.html e pelos handlers inline)
   * ---------------------------------------------------------- */
  window.Bombastico = {
    init: init,
    destroy: destroy,
    load: loadConfig,
    save: saveConfig,
    toggle: toggleActive,
    get: function () { return cloneConfig(state); },
    isLoaded: function () { return remoteLoaded; },
    refreshProducts: refreshProducts,
    toggleFromAdmin: toggleFromAdmin
  };

  window.renderBombasticoAdmin = renderAdminPage;
  window.bombasticoOpenProducts = openProducts;
  window.bombasticoCloseProducts = closeProducts;
  window.bombasticoCloseProductsSoon = closeProductsSoon;
  window.bombasticoFilterProducts = filterProducts;
  window.bombasticoSearchKeydown = searchKeydown;
  window.bombasticoClearProduct = clearProduct;
  window.bombasticoPriceMask = priceMask;
  window.bombasticoSave = saveFromAdmin;
  window.bombasticoRetryLoad = retryLoadFromAdmin;
  window.bombasticoReloadConfig = reloadConfigFromAdmin;
})();
