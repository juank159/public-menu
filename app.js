/*
 * =================================================================
 * Public Menu — frontend de la carta digital
 * =================================================================
 *
 * SPA vanilla JS (sin framework) para máxima velocidad en celulares
 * lentos / 3G. Toda la app vive en `index.html` + este archivo.
 *
 * Flujo:
 *   1. Lee el `code` del path (/m/CODE) o query (?c=CODE).
 *   2. GET /api/v1/public/menu/:code → renderiza la carta agrupada
 *      por categoría.
 *   3. Cliente arma carrito en memoria + localStorage.
 *   4. Form mínimo (nombre + teléfono) → POST /api/v1/public/orders.
 *   5. Pantalla de confirmación con nº de pedido.
 *
 * Decisiones explícitas:
 *   - Sin frameworks: < 5kb de JS gz, parse instantáneo en celular
 *     barato. Tailwind por CDN porque la página es de 1 sola vista
 *     y no vale la pena pipeline de build.
 *   - localStorage para preservar carrito si el cliente cambia de
 *     pestaña / le entra una llamada / se traba el navegador.
 *     Scopeado por `code` — distintos QRs no comparten carrito.
 *   - currency es_CO (COP) para empatar con el backend (es la moneda
 *     que el usuario ya usa).
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------
  const API_BASE = (() => {
    const meta = document.querySelector('meta[name="api-base"]');
    const raw = (meta && meta.content) || window.location.origin;
    return raw.replace(/\/+$/, '');
  })();

  const CURRENCY_FORMATTER = new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  });

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const state = {
    code: null,
    destination: null, // { type, label, table_element_id, zone_label }
    categories: [], // [{ id, name, products: [...] }] — agrupado en cliente
    cart: [], // [{ product_id, name, unit_price, quantity, special_instructions }]
    activeCategoryId: null,
    submitting: false,
    emptyReason: null,
    // Tracking del pedido enviado.
    trackedOrderNumber: null,
    trackingTimer: null,
    // Carta en modo libro: índice actual + lock para evitar disparar
    // doble animación mientras una está corriendo.
    bookIndex: 0,
    bookAnimating: false,
  };

  // ---------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => CURRENCY_FORMATTER.format(Number(n) || 0);

  /**
   * Extrae el `code` del QR de:
   *   - path: /m/abc123  ó  /abc123
   *   - query: ?c=abc123 ó ?code=abc123
   */
  function extractCode() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('c') || params.get('code');
    if (fromQuery) return fromQuery.trim();

    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    const parts = path.split('/');
    const last = parts[parts.length - 1];
    // /m/CODE  → last = CODE; /CODE → mismo.
    // El backend valida formato (8-32 chars alfanum + _ -), acá no
    // adelantamos: si el code es inválido el server responde 404.
    return last || null;
  }

  function showScreen(id) {
    ['screen-loading', 'screen-error', 'screen-menu', 'screen-tracking'].forEach(
      (s) => $(s).classList.add('hidden'),
    );
    $(id).classList.remove('hidden');
  }

  function showError(message) {
    $('error-message').textContent = message;
    showScreen('screen-error');
  }

  function persistCart() {
    if (!state.code) return;
    try {
      localStorage.setItem(`cart:${state.code}`, JSON.stringify(state.cart));
    } catch (_) {
      // localStorage lleno o bloqueado — fallback silencioso.
    }
  }

  function restoreCart() {
    if (!state.code) return;
    try {
      const raw = localStorage.getItem(`cart:${state.code}`);
      if (raw) state.cart = JSON.parse(raw) || [];
    } catch (_) {
      state.cart = [];
    }
  }

  function clearCart() {
    state.cart = [];
    try {
      localStorage.removeItem(`cart:${state.code}`);
    } catch (_) {}
  }

  /**
   * Agrega una línea al carrito fusionando con una existente si coincide
   * en producto + variante + notas. Distinta variante o distinta nota =
   * línea separada (intencional: la cocina ve cada combinación aparte).
   */
  function addLine(line) {
    const existingIdx = state.cart.findIndex(
      (it) =>
        it.product_id === line.product_id &&
        (it.variant_id || '') === (line.variant_id || '') &&
        (it.special_instructions || '') === (line.special_instructions || ''),
    );
    if (existingIdx >= 0) {
      state.cart[existingIdx].quantity += line.quantity;
    } else {
      state.cart.push(line);
    }
  }

  // ---------------------------------------------------------------
  // API
  // ---------------------------------------------------------------
  async function fetchMenu(code) {
    const res = await fetch(`${API_BASE}/api/v1/public/menu/${code}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) detail = body.message;
      } catch (_) {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function submitOrder(payload) {
    const res = await fetch(`${API_BASE}/api/v1/public/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function fetchOrderStatus(code, orderNumber) {
    const url =
      `${API_BASE}/api/v1/public/orders/track` +
      `?code=${encodeURIComponent(code)}` +
      `&order=${encodeURIComponent(orderNumber)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) detail = body.message;
      } catch (_) {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    return body.data || body;
  }

  // ---------------------------------------------------------------
  // Render — Menú
  // ---------------------------------------------------------------
  function renderHeader() {
    const label = state.destination?.label || 'Carta digital';
    // El backend no expone tenant.name en /public/menu (deliberado:
    // menos info filtrada sin auth). Si querés ese branding, agregar
    // al response del backend y leerlo acá.
    $('tenant-name').textContent =
      state.destination?.type === 'table' ? 'Mesa' :
      state.destination?.type === 'zone' ? 'Zona' :
      state.destination?.type === 'pickup' ? 'Pickup' : 'Carta';
    $('qr-label').textContent = label;
    document.title = `${label} — Carta`;
  }

  function renderTabs() {
    const nav = $('categories-tabs');
    if (!nav) return;
    nav.innerHTML = '';
    const mode = getBookMode();
    state.categories.forEach((cat, catIdx) => {
      const btn = document.createElement('button');
      // bookIndex 0 = portada; las categorías empiezan en bookIndex 1.
      // La categoría con catIdx N está en bookIndex N+1.
      const pageIdx = catIdx + 1;
      const isActive = pageIdx === state.bookIndex;
      btn.className = `menu-tab btn-press ${isActive ? 'is-active' : ''}`;
      btn.textContent = cat.name;
      btn.onclick = () => {
        if (mode === 'book') {
          goToPage(pageIdx);
        } else {
          state.bookIndex = pageIdx;
          state.activeCategoryId = cat.id;
          renderTabs();
          const target = document.getElementById(`cat-${cat.id}`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      };
      if (isActive) {
        requestAnimationFrame(() => {
          btn.scrollIntoView({
            behavior: 'smooth',
            inline: 'center',
            block: 'nearest',
          });
        });
      }
      nav.appendChild(btn);
    });
  }

  /// ───── Modo LEGACY ─────────────────────────────────────────────
  /// Render apilado clásico (todas las categorías en una columna,
  /// scroll vertical único, tap en tab = smooth scroll a la sección).
  /// Solo se activa si el HTML servido NO trae el contenedor de libro
  /// — caso "navegador con HTML cacheado pre-libro pero JS nuevo".
  function renderCategoriesLegacy() {
    const root = $('categories-content');
    if (!root) return;
    root.innerHTML = '';
    if (state.categories.length === 0) {
      const msg = state.emptyReason || 'Pedile al mozo más info.';
      root.innerHTML = `
        <div class="text-center text-slate-500 py-12">
          <p class="font-medium">No hay productos disponibles hoy.</p>
          <p class="text-sm mt-1">${escapeHtml(msg)}</p>
        </div>`;
      return;
    }
    state.categories.forEach((cat) => {
      const section = document.createElement('section');
      section.id = `cat-${cat.id}`;
      section.className = 'scroll-mt-16';
      section.innerHTML = `
        <h2 class="text-lg font-bold text-slate-800 mb-3">${escapeHtml(cat.name)}</h2>
        <div class="space-y-3" id="prods-${cat.id}"></div>
      `;
      root.appendChild(section);
      const prodsContainer = section.querySelector(`#prods-${cat.id}`);
      cat.products.forEach((p) => {
        prodsContainer.appendChild(buildProductCard(p));
      });
    });
  }

  /// ───── Modo LIBRO ──────────────────────────────────────────────
  /// Cada categoría se renderiza como una "página" absoluta dentro de
  /// `#book-pages`. Solo la activa se muestra; las demás están con
  /// `is-hidden`. Al cambiar, animamos un flip 3D con `transform-origin`
  /// pegado al lomo izquierdo — emula pasar una hoja real.

  /// Detecta el contenedor de categorías disponible en el DOM. Hay dos
  /// posibles porque la versión anterior usaba `categories-content` y
  /// la nueva (libro) usa `book-pages`. Si el browser todavía sirve
  /// HTML cacheado, podríamos terminar con cualquiera de los dos.
  function getBookMode() {
    if ($('book-pages')) return 'book';
    if ($('categories-content')) return 'legacy';
    return null;
  }

  /// Total de páginas del libro incluyendo la portada (índice 0).
  /// state.bookIndex 0 = portada; 1..N = categorías.
  function totalPages() {
    return state.categories.length + 1; // +1 por la portada
  }

  function renderCategories() {
    const mode = getBookMode();
    if (mode === 'legacy') return renderCategoriesLegacy();
    if (mode !== 'book') {
      console.error('[public-menu] No encontramos contenedor de categorías. ¿HTML desactualizado?');
      return;
    }
    const root = $('book-pages');
    root.innerHTML = '';

    if (state.categories.length === 0) {
      const msg = state.emptyReason || 'Pedile al mozo más info.';
      const empty = document.createElement('div');
      empty.className = 'book-page is-active';
      empty.innerHTML = `
        <div class="book-page-back"></div>
        <div class="book-page-inner">
          <div class="menu-empty">
            <p>La carta aún no fue servida.</p>
            <p style="font-size: 14px; font-style: italic; opacity: 0.8;">${escapeHtml(msg)}</p>
          </div>
        </div>
        <div class="book-page-shadow"></div>`;
      root.appendChild(empty);
      updateNavButtons();
      return;
    }

    // Página 0 = portada; 1..N = categorías. Acotar bookIndex.
    if (state.bookIndex >= totalPages()) state.bookIndex = 0;
    if (state.bookIndex < 0) state.bookIndex = 0;

    const cover = buildCoverPage();
    if (state.bookIndex === 0) cover.classList.add('is-active');
    else cover.classList.add('is-hidden');
    root.appendChild(cover);

    state.categories.forEach((cat, catIdx) => {
      const pageIdx = catIdx + 1; // 0 reservado para portada
      const page = buildCategoryPage(cat, pageIdx);
      if (pageIdx === state.bookIndex) {
        page.classList.add('is-active');
      } else {
        page.classList.add('is-hidden');
      }
      root.appendChild(page);
    });

    updateNavButtons();
    bindBookGestures(root);
  }

  /// Pasa 1, 2, 3... a romanos clásicos (I, II, III...) hasta XX.
  /// Para una carta de restaurante 20 categorías es más que suficiente
  /// — si hubiera más cae al arábigo.
  function toRoman(n) {
    const romans = [
      '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
      'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
    ];
    return romans[n] || String(n);
  }

  /// Construye un elemento `.book-page` con los hijos comunes (backface,
  /// inner, sombra proyectada, número de página). El contenido específico
  /// lo monta el caller dentro de `inner`.
  function buildPageShell(idx, total) {
    const page = document.createElement('article');
    page.className = 'book-page';

    const back = document.createElement('div');
    back.className = 'book-page-back';
    page.appendChild(back);

    const inner = document.createElement('div');
    inner.className = 'book-page-inner';
    page.appendChild(inner);

    // Sombra de proyección durante el flip — vive como hijo para que
    // podamos animar su opacity/transform en GPU. Evita animar
    // box-shadow (que va por CPU y come frames).
    const shadow = document.createElement('div');
    shadow.className = 'book-page-shadow';
    page.appendChild(shadow);

    // Número de página al pie en romano (sin "Capítulo X" — esa
    // etiqueta era demasiado pretenciosa para una carta normal).
    if (idx > 0) {
      const pageno = document.createElement('div');
      pageno.className = 'book-pageno';
      pageno.textContent = `~ ${toRoman(idx)} ~`;
      page.appendChild(pageno);
    }

    return { page, inner };
  }

  /// Portada del libro — primera página visible cuando se abre la carta.
  /// Mostrar una "tapa" antes del contenido refuerza la sensación de
  /// libro físico (siempre lo abrís por la tapa, no en el medio).
  function buildCoverPage() {
    const { page, inner } = buildPageShell(0, 0);
    page.dataset.isCover = '1';
    inner.innerHTML = `
      <div class="cover">
        <div class="cover-ornament-top">
          <svg width="80" height="20" viewBox="0 0 80 20" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M0 10 L30 10" />
            <circle cx="40" cy="10" r="4" />
            <path d="M50 10 L80 10" />
            <path d="M36 10 L40 6 L44 10 L40 14 Z" fill="currentColor" stroke="none" />
          </svg>
        </div>
        <p class="cover-pretitle">la</p>
        <h1 class="cover-title">Carta</h1>
        <div class="cover-rule"></div>
        <p class="cover-tenant" id="cover-tenant"></p>
        <p class="cover-destination" id="cover-destination"></p>
        <div class="cover-ornament-bottom">
          <svg width="60" height="20" viewBox="0 0 60 20" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M0 10 L25 10" />
            <path d="M28 10 L30 7 L32 10 L30 13 Z" fill="currentColor" stroke="none" />
            <path d="M35 10 L60 10" />
          </svg>
        </div>
      </div>
      <div class="cover-hint">Pasá la página para empezar</div>
    `;

    // Inyectar tenant + destino del QR (ya tenemos esos datos en state).
    requestAnimationFrame(() => {
      const tEl = inner.querySelector('#cover-tenant');
      const dEl = inner.querySelector('#cover-destination');
      if (tEl) tEl.textContent = state.destination?.label ? 'Bienvenido a' : '';
      if (dEl) dEl.textContent = state.destination?.label || '';
    });

    return page;
  }

  /// Página de categoría: ornamento + título + divisor + lista de
  /// productos. Sin "Capítulo X" — solo el título grande + el número de
  /// página al pie.
  function buildCategoryPage(cat, idx) {
    const { page, inner } = buildPageShell(idx, state.categories.length);
    page.dataset.categoryId = cat.id;
    page.dataset.idx = String(idx);
    inner.innerHTML = `
      <div class="chapter-ornament">
        <div class="line"></div>
        <div class="diamond"></div>
        <div class="line"></div>
      </div>
      <h2 class="chapter-title">${escapeHtml(cat.name)}</h2>
      <div class="chapter-divider">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1" style="color: var(--gold-dark);">
          <circle cx="7" cy="7" r="2.5" />
          <path d="M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3" />
        </svg>
      </div>
      <div id="prods-${cat.id}"></div>
    `;

    const prodsContainer = inner.querySelector(`#prods-${cat.id}`);
    cat.products.forEach((p) => {
      prodsContainer.appendChild(buildProductCard(p));
    });
    return page;
  }

  /// Mantenemos `buildPage(cat, idx)` por compatibilidad con código
  /// que pudiera llamarlo, ahora delega en el helper específico.
  function buildPage(cat, idx) {
    return buildCategoryPage(cat, idx);
  }

  function updateNavButtons() {
    const prev = $('book-prev');
    const next = $('book-next');
    if (!prev || !next) return;
    const last = totalPages() - 1;
    prev.disabled = state.bookIndex <= 0;
    next.disabled = state.bookIndex >= last;
  }

  /// Cambio de página con animación premium.
  ///
  /// **Forward** (avanzar): la página ACTUAL se voltea hacia la
  /// izquierda y cae detrás del lomo. La siguiente queda visible.
  ///
  /// **Backward** (retroceder): la página ANTERIOR — que conceptualmente
  /// estaba "doblada" detrás del lomo — viene levantándose desde -180°
  /// y se asienta sobre la actual. La actual queda visible debajo.
  /// En un libro real de UNA página visible, esto es lo correcto:
  /// siempre giramos desde el mismo lomo (izquierda), nunca desde el
  /// borde derecho.
  function goToPage(targetIdx) {
    if (state.bookAnimating) return;
    if (targetIdx === state.bookIndex) return;
    if (targetIdx < 0 || targetIdx >= totalPages()) return;

    const root = $('book-pages');
    if (!root) return;
    const pages = root.querySelectorAll('.book-page');
    const current = pages[state.bookIndex];
    const target = pages[targetIdx];
    if (!current || !target) return;

    const forward = targetIdx > state.bookIndex;
    state.bookAnimating = true;

    // Reduce motion: crossfade sin flip 3D para respetar accesibilidad.
    const reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (forward) {
      // FORWARD: target queda como preview debajo, current sale girando.
      target.classList.remove('is-hidden');
      target.classList.remove('is-active');
      target.classList.add('is-next-preview');

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          current.classList.remove('is-active');
          current.classList.add('is-leaving-forward');
        });
      });

      const onEnd = () => {
        current.removeEventListener('animationend', onEnd);
        current.classList.remove('is-leaving-forward');
        current.classList.add('is-hidden');
        target.classList.remove('is-next-preview');
        target.classList.add('is-active');
        finalize(targetIdx);
      };
      current.addEventListener('animationend', onEnd);
      if (reduceMotion) {
        // En reduce-motion la animación dura 240ms; forzamos finalize
        // por timeout por si animationend no dispara.
        setTimeout(() => onEnd(), 260);
      }
    } else {
      // BACKWARD: current queda como preview debajo, target ENTRA
      // volteándose hacia abajo (de -180° a 0°). Sensación de "la hoja
      // anterior cae sobre la actual".
      current.classList.remove('is-active');
      current.classList.add('is-next-preview');

      target.classList.remove('is-hidden');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          target.classList.add('is-entering-backward-flip');
        });
      });

      const onEnd = () => {
        target.removeEventListener('animationend', onEnd);
        target.classList.remove('is-entering-backward-flip');
        target.classList.add('is-active');
        current.classList.remove('is-next-preview');
        current.classList.add('is-hidden');
        finalize(targetIdx);
      };
      target.addEventListener('animationend', onEnd);
      if (reduceMotion) {
        setTimeout(() => onEnd(), 260);
      }
    }

    function finalize(idx) {
      state.bookIndex = idx;
      // Si la nueva página es la portada (idx 0), no hay categoría
      // activa. Si es una categoría, sincronizamos el id.
      if (idx === 0) {
        state.activeCategoryId = null;
      } else {
        state.activeCategoryId = state.categories[idx - 1].id;
      }
      state.bookAnimating = false;
      renderTabs();
      updateNavButtons();
      const inner = pages[idx].querySelector('.book-page-inner');
      if (inner) inner.scrollTop = 0;
    }
  }

  function nextPage() {
    goToPage(state.bookIndex + 1);
  }
  function prevPage() {
    goToPage(state.bookIndex - 1);
  }

  /// Gestos para pasar página — touch + mouse drag.
  ///   - Touch (mobile): touchstart/move/end con lock direccional para
  ///     no chocar con scroll vertical interno.
  ///   - Mouse (desktop): mousedown + drag horizontal. Sin scroll
  ///     interno horizontal, así que es directo.
  ///   - Threshold: 60px o 25% del ancho, lo que sea menor.
  let gesturesBound = false;
  function bindBookGestures(root) {
    if (gesturesBound) return;
    gesturesBound = true;
    let startX = 0;
    let startY = 0;
    let active = false;
    let lockedDirection = null;

    function start(x, y) {
      if (state.bookAnimating) return;
      startX = x;
      startY = y;
      active = true;
      lockedDirection = null;
    }
    function move(x, y) {
      if (!active) return;
      const dx = x - startX;
      const dy = y - startY;
      if (!lockedDirection) {
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          lockedDirection = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
      }
    }
    function end(x) {
      if (!active) return;
      active = false;
      if (lockedDirection !== 'x') return;
      const dx = x - startX;
      const stageW = root.getBoundingClientRect().width || 320;
      const threshold = Math.min(60, stageW * 0.25);
      if (Math.abs(dx) < threshold) return;
      if (dx < 0) nextPage();
      else prevPage();
    }

    // Touch
    root.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1) return;
      start(ev.touches[0].clientX, ev.touches[0].clientY);
    }, { passive: true });
    root.addEventListener('touchmove', (ev) => {
      if (ev.touches.length !== 1) return;
      move(ev.touches[0].clientX, ev.touches[0].clientY);
    }, { passive: true });
    root.addEventListener('touchend', (ev) => {
      end(ev.changedTouches[0].clientX);
    }, { passive: true });

    // Mouse (desktop drag horizontal). Solo activamos si el target
    // NO es un elemento interactivo (botón, link, input) — para no
    // chocar con clicks reales.
    root.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return; // sólo botón principal
      const tag = (ev.target && ev.target.tagName) || '';
      if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (ev.target.closest && ev.target.closest('.menu-item')) return;
      start(ev.clientX, ev.clientY);
    });
    window.addEventListener('mousemove', (ev) => {
      if (!active) return;
      move(ev.clientX, ev.clientY);
    });
    window.addEventListener('mouseup', (ev) => {
      end(ev.clientX);
    });
  }

  /// Variantes "limpias" de un producto: solo las disponibles, con el
  /// precio ABSOLUTO ya calculado (base_price + price_modifier) para no
  /// recalcularlo en cada render. Si el producto no tiene variantes
  /// devuelve []. El backend ya filtra is_available, pero defendemos.
  function normalizeVariants(product) {
    const base = Number(product.base_price) || 0;
    return (product.variants || []).map((v) => ({
      id: v.id,
      name: v.name,
      price: base + (Number(v.price_modifier) || 0),
      is_default: !!v.is_default,
    }));
  }

  /// Precio mínimo a mostrar como "desde $X" cuando hay variantes.
  function minVariantPrice(variants) {
    return variants.reduce(
      (min, v) => (v.price < min ? v.price : min),
      variants[0].price,
    );
  }

  function buildProductCard(product) {
    // Card "menu-item" estilo carta impresa: nombre en serifa, puntos
    // hasta el precio, descripción en cursiva. Sin border-radius / fondo
    // — el "paper" es la página del libro, así que cualquier card flota.
    const card = document.createElement('div');
    card.className = 'menu-item btn-press';
    card.onclick = () => App.openProduct(product);

    const hasImage = !!product.image_url;
    const badgeText = product.badge || product.badge_label;
    const variants = normalizeVariants(product);
    const hasVariants = variants.length > 0;
    const hasDiscount =
      !hasVariants &&
      product.special_price != null &&
      product.special_price < product.base_price;

    let priceHtml;
    if (hasVariants) {
      // Con variantes el precio del plato no es único — mostramos "desde".
      priceHtml = `<span class="from">desde</span>${fmt(
        minVariantPrice(variants),
      )}`;
    } else if (hasDiscount) {
      priceHtml = `<span class="strike">${fmt(product.base_price)}</span>${fmt(
        product.effective_price ?? product.special_price,
      )}`;
    } else {
      priceHtml = fmt(product.effective_price ?? product.base_price);
    }

    card.innerHTML = `
      ${
        hasImage
          ? `<div class="menu-item-thumb">
               <img src="${escapeAttr(product.image_url)}" alt="" loading="lazy" />
             </div>`
          : ''
      }
      <div class="menu-item-body">
        ${badgeText ? `<span class="menu-item-badge">${escapeHtml(badgeText)}</span>` : ''}
        <div class="menu-item-line">
          <span class="menu-item-name">${escapeHtml(product.name)}</span>
          <span class="menu-item-dots"></span>
          <span class="menu-item-price">${priceHtml}</span>
        </div>
        ${
          product.description
            ? `<p class="menu-item-desc">${escapeHtml(product.description)}</p>`
            : ''
        }
      </div>
      <button class="menu-item-add btn-press" type="button" aria-label="Agregar ${escapeAttr(
        product.name,
      )}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    `;

    // El "+" agrega sin abrir el modal cuando el plato no tiene variantes;
    // si tiene, abrimos el modal para que el cliente elija cuál. En ambos
    // casos `stopPropagation` evita que también dispare el onclick de la card.
    const addBtn = card.querySelector('.menu-item-add');
    addBtn.onclick = (ev) => {
      ev.stopPropagation();
      if (hasVariants) {
        App.openProduct(product);
      } else {
        App.quickAdd(product, addBtn);
      }
    };
    return card;
  }

  // ---------------------------------------------------------------
  // Render — Detalle producto (modal)
  // ---------------------------------------------------------------
  let modalProductState = null;

  function renderProductModal(product) {
    const variants = normalizeVariants(product);
    const hasVariants = variants.length > 0;

    // Variante por defecto: la marcada is_default, o la primera. El
    // precio del modal arranca según la variante seleccionada; sin
    // variantes usamos el effective_price del producto.
    let selectedVariantIdx = -1;
    let unitPrice;
    if (hasVariants) {
      const defIdx = variants.findIndex((v) => v.is_default);
      selectedVariantIdx = defIdx >= 0 ? defIdx : 0;
      unitPrice = variants[selectedVariantIdx].price;
    } else {
      unitPrice = Number(
        product.effective_price ??
          product.special_price ??
          product.base_price ??
          0,
      );
    }

    modalProductState = {
      product,
      variants,
      selectedVariantIdx,
      quantity: 1,
      special_instructions: '',
      unit_price: unitPrice,
    };

    const variantsHtml = hasVariants
      ? `
        <div class="pm-section-label">Elegí una opción</div>
        <div class="pm-variants">
          ${variants
            .map(
              (v, i) => `
            <button
              type="button"
              class="pm-variant btn-press ${i === selectedVariantIdx ? 'is-selected' : ''}"
              data-variant-idx="${i}"
              onclick="App.selectVariant(${i})"
            >
              <span class="pm-variant-radio"></span>
              <span class="pm-variant-name">${escapeHtml(v.name)}</span>
              <span class="pm-variant-price">${fmt(v.price)}</span>
            </button>`,
            )
            .join('')}
        </div>`
      : '';

    const root = $('product-detail');
    root.innerHTML = `
      <div class="sheet-handle"></div>
      ${
        product.image_url
          ? `<img src="${escapeAttr(product.image_url)}" alt="" class="pm-img" />`
          : ''
      }
      <div class="pm-head">
        <h2 class="pm-title">${escapeHtml(product.name)}</h2>
        <button class="pm-close btn-press" onclick="App.closeProduct(true)" aria-label="Cerrar">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M6 6L18 18M6 18L18 6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      ${
        product.description
          ? `<p class="pm-desc">${escapeHtml(product.description)}</p>`
          : ''
      }
      <div class="pm-price" id="prod-price">${fmt(unitPrice)}</div>

      ${variantsHtml}

      <div class="pm-section-label">Notas para la cocina (opcional)</div>
      <textarea
        id="prod-notes"
        class="pm-notes"
        rows="2"
        maxlength="300"
        placeholder="Ej: sin cebolla, bien cocido…"
        oninput="App.updateNotes(this.value)"
      ></textarea>

      <div class="pm-qty-row">
        <span class="pm-qty-label">Cantidad</span>
        <div class="pm-qty">
          <button class="pm-qty-btn" onclick="App.changeQty(-1)" aria-label="Disminuir">−</button>
          <span id="prod-qty" class="pm-qty-val">1</span>
          <button class="pm-qty-btn" onclick="App.changeQty(1)" aria-label="Aumentar">+</button>
        </div>
      </div>

      <button class="pm-add btn-press" onclick="App.addToCart()">
        <span>Agregar al pedido</span>
        <span id="prod-total" class="pm-add-total">${fmt(unitPrice)}</span>
      </button>
    `;
    $('modal-product').classList.remove('hidden');
  }

  // ---------------------------------------------------------------
  // Render — Carrito (modal)
  // ---------------------------------------------------------------
  function renderCartModal() {
    const root = $('cart-detail');
    const total = state.cart.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0,
    );

    const closeBtn = `
      <button class="pm-close btn-press" onclick="App.closeCart(true)" aria-label="Cerrar">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M6 6L18 18M6 18L18 6" stroke-linecap="round" />
        </svg>
      </button>`;

    if (state.cart.length === 0) {
      root.innerHTML = `
        <div class="sheet-handle"></div>
        <div class="cart-head">
          <h2 class="cart-title">Mi pedido</h2>
          ${closeBtn}
        </div>
        <p class="cart-empty">Tu pedido está vacío.</p>
      `;
      $('modal-cart').classList.remove('hidden');
      return;
    }

    const itemsHtml = state.cart
      .map(
        (item, i) => `
        <div class="cart-row">
          <div style="flex: 1; min-width: 0;">
            <p class="cart-row-name">${escapeHtml(item.name)}</p>
            ${
              item.variant_name
                ? `<p class="cart-row-sub">${escapeHtml(item.variant_name)}</p>`
                : ''
            }
            ${
              item.special_instructions
                ? `<p class="cart-row-sub">“${escapeHtml(
                    item.special_instructions,
                  )}”</p>`
                : ''
            }
            <p class="cart-row-price">${fmt(item.unit_price)} c/u</p>
          </div>
          <div class="cart-stepper">
            <button class="cart-step-btn" onclick="App.updateCartQty(${i}, -1)" aria-label="Quitar uno">−</button>
            <span class="cart-step-val">${item.quantity}</span>
            <button class="cart-step-btn" onclick="App.updateCartQty(${i}, 1)" aria-label="Agregar uno">+</button>
          </div>
        </div>
      `,
      )
      .join('');

    root.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="cart-head">
        <h2 class="cart-title">Mi pedido</h2>
        ${closeBtn}
      </div>

      <div>${itemsHtml}</div>

      <div class="cart-total-row">
        <span class="l">Total</span>
        <span class="v">${fmt(total)}</span>
      </div>

      <label class="cart-field-label">Tu nombre <span class="req">*</span></label>
      <input
        id="cust-name"
        class="cart-input"
        type="text"
        maxlength="100"
        placeholder="Ej: Juan Pérez"
      />

      <label class="cart-field-label">Teléfono <span class="req">*</span></label>
      <input
        id="cust-phone"
        class="cart-input"
        type="tel"
        inputmode="tel"
        maxlength="20"
        placeholder="Ej: 3001234567"
      />

      <label class="cart-field-label">Notas para el mesero (opcional)</label>
      <textarea
        id="order-notes"
        class="cart-input"
        rows="2"
        maxlength="500"
        placeholder="Ej: cumpleaños, sin gluten…"
        style="resize: none;"
      ></textarea>

      <button id="submit-btn" class="cart-submit btn-press" onclick="App.submitOrder()">
        Enviar pedido
      </button>

      <p id="submit-error" class="cart-error hidden"></p>

      <p class="cart-note">
        El mesero confirmará tu pedido antes de mandarlo a la cocina.
        El pago se hace en caja al terminar.
      </p>
    `;
    $('modal-cart').classList.remove('hidden');
  }

  // ---------------------------------------------------------------
  // FAB carrito (botón inferior)
  // ---------------------------------------------------------------
  function renderCartFab() {
    const count = state.cart.reduce((s, i) => s + i.quantity, 0);
    const total = state.cart.reduce(
      (s, i) => s + i.unit_price * i.quantity,
      0,
    );
    const fab = $('cart-fab');
    if (count === 0) {
      fab.classList.add('hidden');
      return;
    }
    fab.classList.remove('hidden');
    $('cart-count').textContent = String(count);
    $('cart-total').textContent = fmt(total);
  }

  // ---------------------------------------------------------------
  // Escape helpers (prevenir XSS desde el menú del tenant)
  // ---------------------------------------------------------------
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // ---------------------------------------------------------------
  // Render — Tracking del pedido
  // ---------------------------------------------------------------
  /**
   * Steps del timeline visual. El stage activo se pinta naranja
   * (brand), los anteriores verdes (done), los siguientes grises.
   */
  const TRACKING_STEPS = [
    { stage: 'pending_review', label: 'Recibido', sub: 'Esperando aprobación' },
    { stage: 'preparing', label: 'En preparación', sub: 'Cocina trabajando' },
    { stage: 'ready', label: 'Listo', sub: 'Para servir / retirar' },
    { stage: 'completed', label: 'Finalizado', sub: 'Pedido cerrado' },
  ];

  function renderTracking(payload) {
    // Header con icono y mensaje según el stage.
    const stage = payload.stage || 'pending_review';
    const stageMeta = stageVisual(stage);

    $('track-icon').className = `track-icon-wrap ${stageMeta.bg}`;
    $('track-icon').innerHTML = stageMeta.icon;

    $('track-title').textContent = stageMeta.title;
    $('track-message').textContent =
      payload.message || stageMeta.fallbackMessage;
    $('track-order-number').textContent = payload.order_number || '—';

    // Timeline.
    renderTrackingTimeline(stage, payload);

    // Items.
    const itemsEl = $('track-items');
    itemsEl.innerHTML = '';
    (payload.items || []).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'track-item';
      row.innerHTML = `
        <span>
          <span class="track-item-q">${it.quantity}×</span>
          ${escapeHtml(it.name)}
        </span>
      `;
      itemsEl.appendChild(row);

      if (it.special_instructions) {
        const note = document.createElement('div');
        note.className = 'track-item-note';
        note.textContent = it.special_instructions;
        itemsEl.appendChild(note);
      }
    });

    // Total.
    $('track-total').textContent = fmt(payload.total_amount || 0);

    // Mensaje de refresh con timestamp.
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    $('track-refresh-status').textContent =
      `Actualizado a las ${hh}:${mm} · Se refresca solo cada 15s`;
  }

  function stageVisual(stage) {
    // El color del trazo lo hereda el SVG vía `currentColor` desde la
    // clase `track-icon-*` del wrapper (definidas en index.html).
    switch (stage) {
      case 'pending_review':
        return {
          bg: 'track-icon-amber',
          icon: `<svg width="44" height="44" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>`,
          title: 'Recibimos tu pedido',
          fallbackMessage: 'El mesero lo está revisando.',
        };
      case 'preparing':
        return {
          bg: 'track-icon-brand',
          icon: `<svg width="44" height="44" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
                </svg>`,
          title: 'En preparación',
          fallbackMessage: 'La cocina está haciendo tu pedido.',
        };
      case 'ready':
        return {
          bg: 'track-icon-green',
          icon: `<svg width="44" height="44" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
                </svg>`,
          title: '¡Pedido listo!',
          fallbackMessage: 'El mesero te lo trae enseguida.',
        };
      case 'delivered':
      case 'completed':
        return {
          bg: 'track-icon-green',
          icon: `<svg width="44" height="44" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
                </svg>`,
          title: '¡Gracias por tu visita!',
          fallbackMessage: 'Pedido finalizado.',
        };
      case 'cancelled':
        return {
          bg: 'track-icon-red',
          icon: `<svg width="44" height="44" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"/>
                </svg>`,
          title: 'Pedido cancelado',
          fallbackMessage: 'Hablá con el mesero para más info.',
        };
      default:
        return {
          bg: 'track-icon-muted',
          icon: '',
          title: 'Procesando…',
          fallbackMessage: '',
        };
    }
  }

  function renderTrackingTimeline(currentStage, payload) {
    const root = $('track-timeline');
    root.innerHTML = '';

    // Si el pedido fue cancelado, NO mostramos timeline (no aplica).
    if (currentStage === 'cancelled') return;

    // Determinar qué stage está done vs pending vs current.
    const stageOrder = ['pending_review', 'preparing', 'ready', 'completed'];
    const currentIdx = Math.max(0, stageOrder.indexOf(currentStage));

    // Línea vertical que conecta los círculos.
    const line = document.createElement('div');
    line.className = 'tl-line';
    root.appendChild(line);

    TRACKING_STEPS.forEach((step, idx) => {
      const isDone = idx < currentIdx;
      const isCurrent = idx === currentIdx;
      const stateClass = isDone ? 'done' : isCurrent ? 'current' : 'todo';

      const row = document.createElement('div');
      row.className = 'tl-row';

      // Timestamp del paso si lo tenemos.
      let timestamp = '';
      const tsField = {
        pending_review: payload.created_at,
        preparing: payload.preparing_at ?? payload.confirmed_at,
        ready: payload.ready_at,
        completed: payload.completed_at,
      }[step.stage];
      if (tsField) {
        const dt = new Date(tsField);
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        timestamp = `<div class="tl-time">${hh}:${mm}</div>`;
      }

      row.innerHTML = `
        <div class="tl-dot ${stateClass}">${isDone ? '✓' : idx + 1}</div>
        <div style="flex: 1;">
          <div class="tl-label ${stateClass}">${step.label}</div>
          <div class="tl-sub">${step.sub}</div>
          ${timestamp}
        </div>
      `;
      root.appendChild(row);
    });
  }

  /**
   * Inicia el polling de tracking. Se detiene si la orden alcanza
   * un estado terminal (completed/cancelled) o si el usuario sale
   * de la pantalla.
   */
  async function startTracking(orderNumber) {
    state.trackedOrderNumber = orderNumber;
    stopTracking(); // limpia timer previo si quedó

    const tick = async () => {
      if (!state.trackedOrderNumber) return;
      try {
        const payload = await fetchOrderStatus(
          state.code,
          state.trackedOrderNumber,
        );
        renderTracking(payload);

        // Detener polling si el pedido llegó a un estado terminal.
        if (
          payload.stage === 'completed' ||
          payload.stage === 'cancelled' ||
          payload.stage === 'delivered'
        ) {
          stopTracking();
        }
      } catch (err) {
        // Errores transitorios — seguimos intentando. Mostramos un
        // hint discreto en el indicador de refresh.
        $('track-refresh-status').textContent =
          'No pudimos refrescar. Reintentando…';
      }
    };

    // Primer tick inmediato + interval de 15s.
    await tick();
    state.trackingTimer = setInterval(tick, 15000);

    // Persistimos el orderNumber para que si el cliente cierra la
    // pestaña y vuelve a escanear el QR, vea el tracking de su
    // último pedido (cuando reabre la app, restoreCart restaura).
    try {
      sessionStorage.setItem(`tracking:${state.code}`, orderNumber);
    } catch (_) {}
  }

  function stopTracking() {
    if (state.trackingTimer) {
      clearInterval(state.trackingTimer);
      state.trackingTimer = null;
    }
  }

  // ---------------------------------------------------------------
  // Public API (expuesta para onclick handlers en el HTML)
  // ---------------------------------------------------------------
  const App = {
    // Navegación de páginas del libro
    nextPage,
    prevPage,
    goToPage,

    openProduct(product) {
      renderProductModal(product);
    },

    closeProduct(forceOrEvent) {
      // Si fue click en el backdrop, `event.target === event.currentTarget`.
      if (
        forceOrEvent &&
        forceOrEvent.target &&
        forceOrEvent.target !== forceOrEvent.currentTarget
      )
        return;
      $('modal-product').classList.add('hidden');
      modalProductState = null;
    },

    /// Selección de variante dentro del modal. Actualiza el precio
    /// unitario + los totales en el DOM sin re-renderizar todo el modal
    /// (así no perdemos lo que el cliente ya escribió en las notas).
    selectVariant(idx) {
      if (!modalProductState) return;
      const variant = modalProductState.variants[idx];
      if (!variant) return;
      modalProductState.selectedVariantIdx = idx;
      modalProductState.unit_price = variant.price;

      // Marcar visualmente la opción elegida.
      const root = $('product-detail');
      root.querySelectorAll('.pm-variant').forEach((el) => {
        el.classList.toggle(
          'is-selected',
          Number(el.dataset.variantIdx) === idx,
        );
      });

      // Refrescar precio mostrado + total del botón "Agregar".
      $('prod-price').textContent = fmt(variant.price);
      $('prod-total').textContent = fmt(
        variant.price * modalProductState.quantity,
      );
    },

    changeQty(delta) {
      if (!modalProductState) return;
      const next = Math.max(1, modalProductState.quantity + delta);
      modalProductState.quantity = next;
      $('prod-qty').textContent = String(next);
      $('prod-total').textContent = fmt(
        modalProductState.unit_price * next,
      );
    },

    updateNotes(value) {
      if (!modalProductState) return;
      modalProductState.special_instructions = value;
    },

    /// Agregado rápido desde el "+" de la card (solo productos SIN
    /// variantes — los que tienen variante abren el modal para elegir).
    /// Suma cantidad 1 sin notas, con un pulso visual de confirmación.
    quickAdd(product, btnEl) {
      const unit_price = Number(
        product.effective_price ??
          product.special_price ??
          product.base_price ??
          0,
      );
      addLine({
        product_id: product.id,
        variant_id: undefined,
        variant_name: '',
        name: product.name,
        unit_price,
        quantity: 1,
        special_instructions: '',
      });
      persistCart();
      renderCartFab();
      if (btnEl) {
        btnEl.classList.remove('pulsing');
        // reflow para reiniciar la animación si se toca rápido seguido
        void btnEl.offsetWidth;
        btnEl.classList.add('pulsing');
      }
    },

    addToCart() {
      if (!modalProductState) return;
      const {
        product,
        quantity,
        special_instructions,
        unit_price,
        variants,
        selectedVariantIdx,
      } = modalProductState;

      const variant =
        selectedVariantIdx >= 0 ? variants[selectedVariantIdx] : null;

      addLine({
        product_id: product.id,
        variant_id: variant ? variant.id : undefined,
        variant_name: variant ? variant.name : '',
        name: product.name,
        unit_price,
        quantity,
        special_instructions: special_instructions || '',
      });
      persistCart();
      renderCartFab();
      App.closeProduct(true);
    },

    openCart() {
      renderCartModal();
    },

    closeCart(forceOrEvent) {
      if (
        forceOrEvent &&
        forceOrEvent.target &&
        forceOrEvent.target !== forceOrEvent.currentTarget
      )
        return;
      $('modal-cart').classList.add('hidden');
    },

    updateCartQty(index, delta) {
      const item = state.cart[index];
      if (!item) return;
      item.quantity += delta;
      if (item.quantity <= 0) {
        state.cart.splice(index, 1);
      }
      persistCart();
      renderCartFab();
      if (state.cart.length === 0) {
        App.closeCart(true);
      } else {
        renderCartModal();
      }
    },

    async submitOrder() {
      if (state.submitting) return;

      const name = $('cust-name').value.trim();
      const phone = $('cust-phone').value.trim();
      const notes = $('order-notes').value.trim();
      const errEl = $('submit-error');
      errEl.classList.add('hidden');

      if (name.length < 2) {
        errEl.textContent = 'Ingresá tu nombre.';
        errEl.classList.remove('hidden');
        return;
      }
      // Validación mínima de teléfono (al menos 7 dígitos, no
      // estricta — distintos países tienen formatos distintos).
      const phoneDigits = phone.replace(/\D/g, '');
      if (phoneDigits.length < 7) {
        errEl.textContent = 'Teléfono inválido.';
        errEl.classList.remove('hidden');
        return;
      }
      if (state.cart.length === 0) {
        errEl.textContent = 'Agregá al menos un producto.';
        errEl.classList.remove('hidden');
        return;
      }

      const btn = $('submit-btn');
      state.submitting = true;
      btn.disabled = true;
      btn.textContent = 'Enviando…';

      try {
        const payload = {
          code: state.code,
          customer_name: name,
          customer_phone: phone,
          notes: notes || undefined,
          items: state.cart.map((it) => ({
            product_id: it.product_id,
            variant_id: it.variant_id || undefined,
            quantity: it.quantity,
            special_instructions: it.special_instructions || undefined,
          })),
        };

        const result = await submitOrder(payload);

        clearCart();
        renderCartFab();
        $('modal-cart').classList.add('hidden');

        const orderNumber =
          (result && (result.order_number || result.data?.order_number)) ||
          '';

        // Arrancamos tracking inmediatamente — el usuario ve la
        // pantalla de tracking con estado live + auto-refresh cada 15s
        // hasta que el pedido termine.
        showScreen('screen-tracking');
        await startTracking(orderNumber);
      } catch (err) {
        errEl.textContent =
          err.message ||
          'No se pudo enviar el pedido. Intentá de nuevo o llamá al mozo.';
        errEl.classList.remove('hidden');
      } finally {
        state.submitting = false;
        btn.disabled = false;
        btn.textContent = 'Enviar pedido';
      }
    },

    startOver() {
      // Detenemos tracking + limpiamos session storage para que el QR
      // vuelva a abrir la carta limpia. El localStorage del cart ya
      // se limpió al enviar.
      stopTracking();
      try {
        sessionStorage.removeItem(`tracking:${state.code}`);
      } catch (_) {}
      state.trackedOrderNumber = null;
      window.location.reload();
    },
  };

  // Exponer App globalmente (para los onclick="App.xxx()" del HTML).
  window.App = App;

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function boot() {
    const code = extractCode();
    if (!code) {
      showError('Falta el código del QR. Pedile el QR al mesero.');
      return;
    }
    state.code = code;
    restoreCart();

    // Si el cliente volvió a escanear y tenía un pedido reciente en
    // tracking, lo retomamos directo — evita el "¿en qué estado va
    // mi pedido?" sin tener que reingresar nada.
    try {
      const lastOrder = sessionStorage.getItem(`tracking:${code}`);
      if (lastOrder) {
        showScreen('screen-tracking');
        await startTracking(lastOrder);
        return;
      }
    } catch (_) {}

    try {
      const data = await fetchMenu(code);
      // Backend responde con shape FLAT:
      //   { destination, categories: [...], products: [...], empty_reason? }
      // El TransformInterceptor global puede envolverlo en
      // `{ success, data }`. Manejamos ambos casos.
      const payload = data.data || data;

      state.destination = payload.destination || null;
      state.emptyReason = payload.empty_reason || null;

      // Agrupar productos por categoría (el backend no lo hace por
      // razones de tamaño de payload — frontend lo arma).
      const rawCats = payload.categories || [];
      const rawProducts = payload.products || [];
      const productsByCategory = new Map();
      for (const p of rawProducts) {
        const arr = productsByCategory.get(p.category_id) || [];
        arr.push(p);
        productsByCategory.set(p.category_id, arr);
      }
      state.categories = rawCats
        .map((c) => ({
          ...c,
          products: productsByCategory.get(c.id) || [],
        }))
        .filter((c) => c.products.length > 0);

      // Arrancar siempre en la PORTADA (índice 0). Las categorías
      // empiezan en índice 1. Esto refuerza la sensación de libro
      // físico: lo abrís por la tapa, no por la mitad.
      state.bookIndex = 0;
      state.activeCategoryId = null;

      renderHeader();
      renderTabs();
      renderCategories();
      renderCartFab();

      showScreen('screen-menu');
    } catch (err) {
      if (err.status === 404) {
        showError('Este QR no es válido. Pedile al mozo el QR nuevo.');
      } else if (err.status === 410) {
        showError('Este QR ya no está activo. Pedile el QR nuevo al mozo.');
      } else if (err.status === 429) {
        showError('Estás haciendo muchas peticiones. Esperá un momento.');
      } else {
        showError(
          err.message ||
            'No pudimos conectar con el restaurante. Probá de nuevo.',
        );
      }
    }
  }

  // Esperar a que el DOM esté listo (Tailwind por CDN tarda unos ms).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
