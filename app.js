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
    nav.innerHTML = '';
    state.categories.forEach((cat, idx) => {
      const btn = document.createElement('button');
      const isActive = idx === state.bookIndex;
      btn.className = `flex-shrink-0 px-4 py-2 rounded-full text-sm font-semibold btn-press whitespace-nowrap ${
        isActive
          ? 'bg-brand text-white'
          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`;
      btn.textContent = cat.name;
      btn.onclick = () => goToPage(idx);
      // Scroll horizontal: si la tab activa quedó fuera del viewport
      // (caso típico al saltar 5 categorías), centrarla suavemente.
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

  /// ───── Modo LIBRO ──────────────────────────────────────────────
  /// Cada categoría se renderiza como una "página" absoluta dentro de
  /// `#book-pages`. Solo la activa se muestra; las demás están con
  /// `is-hidden`. Al cambiar, animamos un flip 3D con `transform-origin`
  /// pegado al lomo izquierdo — emula pasar una hoja real.

  function renderCategories() {
    const root = $('book-pages');
    root.innerHTML = '';

    if (state.categories.length === 0) {
      const msg = state.emptyReason || 'Pedile al mozo más info.';
      const empty = document.createElement('div');
      empty.className = 'book-page is-active';
      empty.innerHTML = `
        <div class="book-page-inner">
          <div class="text-center text-slate-500 py-16">
            <p class="font-medium">No hay productos disponibles hoy.</p>
            <p class="text-sm mt-1">${escapeHtml(msg)}</p>
          </div>
        </div>`;
      root.appendChild(empty);
      updateNavButtons();
      return;
    }

    // Acotar bookIndex por si las categorías cambiaron y el índice
    // anterior quedó fuera de rango.
    if (state.bookIndex >= state.categories.length) state.bookIndex = 0;
    if (state.bookIndex < 0) state.bookIndex = 0;

    state.categories.forEach((cat, idx) => {
      const page = buildPage(cat, idx);
      if (idx === state.bookIndex) {
        page.classList.add('is-active');
      } else {
        page.classList.add('is-hidden');
      }
      root.appendChild(page);
    });

    updateNavButtons();
    bindBookGestures(root);
  }

  function buildPage(cat, idx) {
    const page = document.createElement('article');
    page.className = 'book-page';
    page.dataset.categoryId = cat.id;
    page.dataset.idx = String(idx);

    const inner = document.createElement('div');
    inner.className = 'book-page-inner';
    inner.innerHTML = `
      <p class="book-chapter-subtitle">Categoría ${idx + 1}</p>
      <h2 class="book-chapter-title">${escapeHtml(cat.name)}</h2>
      <div class="book-chapter-divider"></div>
      <div class="space-y-3" id="prods-${cat.id}"></div>
    `;
    page.appendChild(inner);

    // Número de página (estilo libro físico).
    const pageno = document.createElement('div');
    pageno.className = 'book-pageno';
    pageno.textContent = `${idx + 1} / ${state.categories.length}`;
    page.appendChild(pageno);

    const prodsContainer = inner.querySelector(`#prods-${cat.id}`);
    cat.products.forEach((p) => {
      prodsContainer.appendChild(buildProductCard(p));
    });

    return page;
  }

  function updateNavButtons() {
    const prev = $('book-prev');
    const next = $('book-next');
    if (!prev || !next) return;
    const last = state.categories.length - 1;
    prev.disabled = state.bookIndex <= 0;
    next.disabled = state.bookIndex >= last;
  }

  /// Pasar a la página `targetIdx` con animación. Dirección automática:
  /// si vamos adelante usamos pageOutForward, si vamos atrás usamos
  /// pageOutBackward — el efecto es que la hoja siempre se voltea hacia
  /// el lado correcto.
  function goToPage(targetIdx) {
    if (state.bookAnimating) return;
    if (targetIdx === state.bookIndex) return;
    if (targetIdx < 0 || targetIdx >= state.categories.length) return;

    const root = $('book-pages');
    const pages = root.querySelectorAll('.book-page');
    const current = pages[state.bookIndex];
    const target = pages[targetIdx];
    if (!current || !target) return;

    const forward = targetIdx > state.bookIndex;
    state.bookAnimating = true;

    // Página entrante: arranca visible debajo, sin animación de salida.
    target.classList.remove('is-hidden');
    target.classList.remove('is-active');
    target.classList.add(
      forward ? 'is-entering-forward' : 'is-entering-backward',
    );

    // Página saliente: flip.
    current.classList.remove('is-active');
    current.classList.add(
      forward ? 'is-leaving-forward' : 'is-leaving-backward',
    );

    const onEnd = () => {
      current.removeEventListener('animationend', onEnd);
      current.classList.remove(
        'is-leaving-forward',
        'is-leaving-backward',
      );
      current.classList.add('is-hidden');
      target.classList.remove(
        'is-entering-forward',
        'is-entering-backward',
      );
      target.classList.add('is-active');
      state.bookIndex = targetIdx;
      state.activeCategoryId = state.categories[targetIdx].id;
      state.bookAnimating = false;
      renderTabs(); // refresca la tab activa
      updateNavButtons();
      // Llevar el scroll de la nueva página al tope (cada categoría
      // tiene su propio área de scroll interna).
      const inner = target.querySelector('.book-page-inner');
      if (inner) inner.scrollTop = 0;
    };
    current.addEventListener('animationend', onEnd);
  }

  function nextPage() {
    goToPage(state.bookIndex + 1);
  }
  function prevPage() {
    goToPage(state.bookIndex - 1);
  }

  /// Swipe horizontal sobre el book-stage para pasar páginas. Tres
  /// reglas pragmáticas para que el gesto se sienta natural:
  ///  1. Si el desplazamiento vertical supera al horizontal antes del
  ///     umbral, NO interpretamos como swipe (es scroll interno).
  ///  2. Umbral de 60px o 25% del ancho del stage — lo que sea menor.
  ///  3. Si el dedo se suelta antes del umbral, no pasamos página.
  let gesturesBound = false;
  function bindBookGestures(root) {
    if (gesturesBound) return;
    gesturesBound = true;
    let startX = 0;
    let startY = 0;
    let active = false;
    let lockedDirection = null; // 'x' | 'y' | null

    root.addEventListener(
      'touchstart',
      (ev) => {
        if (state.bookAnimating) return;
        if (ev.touches.length !== 1) return;
        startX = ev.touches[0].clientX;
        startY = ev.touches[0].clientY;
        active = true;
        lockedDirection = null;
      },
      { passive: true },
    );

    root.addEventListener(
      'touchmove',
      (ev) => {
        if (!active) return;
        const dx = ev.touches[0].clientX - startX;
        const dy = ev.touches[0].clientY - startY;
        if (!lockedDirection) {
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            lockedDirection = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          }
        }
      },
      { passive: true },
    );

    root.addEventListener(
      'touchend',
      (ev) => {
        if (!active) return;
        active = false;
        if (lockedDirection !== 'x') return;
        const dx = ev.changedTouches[0].clientX - startX;
        const stageW = root.getBoundingClientRect().width || 320;
        const threshold = Math.min(60, stageW * 0.25);
        if (Math.abs(dx) < threshold) return;
        // Swipe a la izquierda = avanzar (siguiente categoría).
        if (dx < 0) nextPage();
        else prevPage();
      },
      { passive: true },
    );
  }

  function buildProductCard(product) {
    const card = document.createElement('button');
    card.className =
      'w-full text-left bg-white rounded-2xl border border-slate-200 hover:border-brand p-4 flex gap-3 btn-press';
    card.onclick = () => App.openProduct(product);

    const hasImage = !!product.image_url;
    const badgeText = product.badge || product.badge_label;
    const badge = badgeText
      ? `<span class="inline-block bg-amber-100 text-amber-800 text-xs font-bold px-2 py-0.5 rounded mb-1.5">${escapeHtml(
          badgeText,
        )}</span>`
      : '';

    const priceHtml =
      product.special_price != null && product.special_price < product.base_price
        ? `<div class="flex items-baseline gap-2">
             <span class="text-brand font-bold text-lg">${fmt(
               product.effective_price ?? product.special_price,
             )}</span>
             <span class="text-slate-400 line-through text-sm">${fmt(
               product.base_price,
             )}</span>
           </div>`
        : `<span class="text-brand font-bold text-lg">${fmt(
            product.effective_price ?? product.base_price,
          )}</span>`;

    card.innerHTML = `
      <div class="flex-1 min-w-0">
        ${badge}
        <h3 class="font-bold text-slate-900 truncate">${escapeHtml(
          product.name,
        )}</h3>
        ${
          product.description
            ? `<p class="text-sm text-slate-500 line-clamp-2 mt-0.5">${escapeHtml(
                product.description,
              )}</p>`
            : ''
        }
        <div class="mt-2">${priceHtml}</div>
      </div>
      ${
        hasImage
          ? `<div class="w-24 h-24 rounded-xl bg-slate-100 overflow-hidden flex-shrink-0">
               <img src="${escapeAttr(
                 product.image_url,
               )}" alt="" class="w-full h-full object-cover" loading="lazy" />
             </div>`
          : ''
      }
    `;
    return card;
  }

  // ---------------------------------------------------------------
  // Render — Detalle producto (modal)
  // ---------------------------------------------------------------
  let modalProductState = null;

  function renderProductModal(product) {
    const effectivePrice = Number(
      product.effective_price ??
        product.special_price ??
        product.base_price ??
        0,
    );
    modalProductState = {
      product,
      quantity: 1,
      special_instructions: '',
      unit_price: effectivePrice,
    };

    const root = $('product-detail');
    root.innerHTML = `
      ${
        product.image_url
          ? `<img src="${escapeAttr(
              product.image_url,
            )}" alt="" class="w-full h-56 object-cover rounded-2xl mb-4" />`
          : ''
      }
      <div class="flex justify-between items-start gap-3 mb-1">
        <h2 class="text-2xl font-bold flex-1">${escapeHtml(product.name)}</h2>
        <button
          onclick="App.closeProduct(true)"
          class="text-slate-400 hover:text-slate-700 -mr-2 -mt-1 p-2"
          aria-label="Cerrar"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M6 6L18 18M6 18L18 6" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      ${
        product.description
          ? `<p class="text-slate-600 mb-4">${escapeHtml(
              product.description,
            )}</p>`
          : ''
      }
      <div class="text-2xl font-bold text-brand mb-5">${fmt(
        effectivePrice,
      )}</div>

      <label class="block text-sm font-semibold text-slate-700 mb-1.5">
        Notas para la cocina (opcional)
      </label>
      <textarea
        id="prod-notes"
        rows="2"
        maxlength="300"
        placeholder="Ej: sin cebolla, bien cocido…"
        class="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm resize-none focus:border-brand focus:outline-none mb-5"
        oninput="App.updateNotes(this.value)"
      ></textarea>

      <div class="flex items-center justify-between gap-4 mb-5">
        <span class="font-semibold">Cantidad</span>
        <div class="flex items-center gap-3 bg-slate-100 rounded-full p-1">
          <button
            onclick="App.changeQty(-1)"
            class="w-10 h-10 rounded-full bg-white shadow font-bold text-xl btn-press"
            aria-label="Disminuir"
          >−</button>
          <span id="prod-qty" class="font-bold w-6 text-center">1</span>
          <button
            onclick="App.changeQty(1)"
            class="w-10 h-10 rounded-full bg-white shadow font-bold text-xl btn-press"
            aria-label="Aumentar"
          >+</button>
        </div>
      </div>

      <button
        onclick="App.addToCart()"
        class="w-full bg-brand hover:bg-brand-dark text-white py-4 rounded-2xl font-bold btn-press flex justify-between px-5"
      >
        <span>Agregar al pedido</span>
        <span id="prod-total">${fmt(effectivePrice)}</span>
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

    if (state.cart.length === 0) {
      root.innerHTML = `
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-bold">Mi pedido</h2>
          <button onclick="App.closeCart(true)" class="text-slate-400 p-2 -mr-2"
                  aria-label="Cerrar">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M6 6L18 18M6 18L18 6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        <p class="text-slate-500 text-center py-10">Tu pedido está vacío.</p>
      `;
      $('modal-cart').classList.remove('hidden');
      return;
    }

    const itemsHtml = state.cart
      .map(
        (item, i) => `
        <div class="flex gap-3 py-3 border-b border-slate-100 last:border-0">
          <div class="flex-1 min-w-0">
            <p class="font-semibold truncate">${escapeHtml(item.name)}</p>
            ${
              item.special_instructions
                ? `<p class="text-xs text-slate-500 mt-0.5">${escapeHtml(
                    item.special_instructions,
                  )}</p>`
                : ''
            }
            <p class="text-sm text-slate-600 mt-0.5">${fmt(
              item.unit_price,
            )} c/u</p>
          </div>
          <div class="flex items-center gap-2">
            <div class="flex items-center gap-2 bg-slate-100 rounded-full px-1 py-1">
              <button onclick="App.updateCartQty(${i}, -1)"
                      class="w-7 h-7 rounded-full bg-white font-bold btn-press">−</button>
              <span class="font-bold w-5 text-center">${item.quantity}</span>
              <button onclick="App.updateCartQty(${i}, 1)"
                      class="w-7 h-7 rounded-full bg-white font-bold btn-press">+</button>
            </div>
          </div>
        </div>
      `,
      )
      .join('');

    root.innerHTML = `
      <div class="flex justify-between items-center mb-3">
        <h2 class="text-2xl font-bold">Mi pedido</h2>
        <button onclick="App.closeCart(true)" class="text-slate-400 p-2 -mr-2"
                aria-label="Cerrar">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M6 6L18 18M6 18L18 6" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="space-y-0 mb-4">${itemsHtml}</div>

      <div class="flex justify-between text-lg font-bold py-3 border-t border-slate-200">
        <span>Total</span>
        <span class="text-brand">${fmt(total)}</span>
      </div>

      <div class="mt-5">
        <label class="block text-sm font-semibold mb-1">
          Tu nombre <span class="text-red-500">*</span>
        </label>
        <input
          id="cust-name"
          type="text"
          maxlength="100"
          placeholder="Ej: Juan Pérez"
          class="w-full border border-slate-300 rounded-xl px-3 py-3 mb-3 focus:border-brand focus:outline-none"
        />

        <label class="block text-sm font-semibold mb-1">
          Teléfono <span class="text-red-500">*</span>
        </label>
        <input
          id="cust-phone"
          type="tel"
          inputmode="tel"
          maxlength="20"
          placeholder="Ej: 3001234567"
          class="w-full border border-slate-300 rounded-xl px-3 py-3 mb-3 focus:border-brand focus:outline-none"
        />

        <label class="block text-sm font-semibold mb-1">
          Notas para el mesero (opcional)
        </label>
        <textarea
          id="order-notes"
          rows="2"
          maxlength="500"
          placeholder="Ej: cumpleaños, sin gluten…"
          class="w-full border border-slate-300 rounded-xl px-3 py-2 text-sm resize-none focus:border-brand focus:outline-none mb-4"
        ></textarea>

        <button
          id="submit-btn"
          onclick="App.submitOrder()"
          class="w-full bg-brand hover:bg-brand-dark text-white py-4 rounded-2xl font-bold btn-press disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Enviar pedido
        </button>

        <p id="submit-error" class="hidden mt-3 text-sm text-red-600"></p>

        <p class="text-xs text-slate-500 mt-3 leading-relaxed">
          El mesero confirmará tu pedido antes de mandarlo a la cocina.
          El pago se hace en caja al terminar.
        </p>
      </div>
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

    $('track-icon').className =
      `w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-5 transition-colors ${stageMeta.bg}`;
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
      row.className = 'flex justify-between text-sm';
      row.innerHTML = `
        <span class="text-slate-700">
          <span class="font-bold text-brand">${it.quantity}×</span>
          ${escapeHtml(it.name)}
        </span>
      `;
      itemsEl.appendChild(row);

      if (it.special_instructions) {
        const note = document.createElement('div');
        note.className = 'text-xs text-slate-500 italic pl-5';
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
    switch (stage) {
      case 'pending_review':
        return {
          bg: 'bg-amber-100',
          icon: `<svg class="w-12 h-12 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>`,
          title: 'Recibimos tu pedido',
          fallbackMessage: 'El mesero lo está revisando.',
        };
      case 'preparing':
        return {
          bg: 'bg-orange-100',
          icon: `<svg class="w-12 h-12 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
                </svg>`,
          title: 'En preparación',
          fallbackMessage: 'La cocina está haciendo tu pedido.',
        };
      case 'ready':
        return {
          bg: 'bg-emerald-100',
          icon: `<svg class="w-12 h-12 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
                </svg>`,
          title: '¡Pedido listo!',
          fallbackMessage: 'El mesero te lo trae enseguida.',
        };
      case 'delivered':
      case 'completed':
        return {
          bg: 'bg-emerald-100',
          icon: `<svg class="w-12 h-12 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>
                </svg>`,
          title: '¡Gracias por tu visita!',
          fallbackMessage: 'Pedido finalizado.',
        };
      case 'cancelled':
        return {
          bg: 'bg-red-100',
          icon: `<svg class="w-12 h-12 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M6 18L18 6M6 6l12 12"/>
                </svg>`,
          title: 'Pedido cancelado',
          fallbackMessage: 'Hablá con el mesero para más info.',
        };
      default:
        return {
          bg: 'bg-slate-100',
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
    line.className = 'absolute left-3 top-2 bottom-2 w-0.5 bg-slate-200';
    root.appendChild(line);

    TRACKING_STEPS.forEach((step, idx) => {
      const isDone = idx < currentIdx;
      const isCurrent = idx === currentIdx;

      const row = document.createElement('div');
      row.className = 'relative flex items-start gap-3 pb-5 last:pb-0';

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
        timestamp = `<div class="text-xs text-slate-400 mt-0.5">${hh}:${mm}</div>`;
      }

      let dotClass, labelClass;
      if (isDone) {
        dotClass = 'bg-emerald-500 border-emerald-500 text-white';
        labelClass = 'text-slate-500 font-medium';
      } else if (isCurrent) {
        dotClass = 'bg-brand border-brand text-white animate-pulse';
        labelClass = 'text-brand font-bold';
      } else {
        dotClass = 'bg-white border-slate-300 text-slate-300';
        labelClass = 'text-slate-400';
      }

      row.innerHTML = `
        <div class="relative z-10 w-6 h-6 rounded-full border-2 ${dotClass} flex items-center justify-center text-xs font-bold flex-shrink-0">
          ${isDone ? '✓' : idx + 1}
        </div>
        <div class="flex-1 -mt-0.5">
          <div class="${labelClass} text-sm">${step.label}</div>
          <div class="text-xs text-slate-400">${step.sub}</div>
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

    addToCart() {
      if (!modalProductState) return;
      const { product, quantity, special_instructions, unit_price } =
        modalProductState;

      // Si ya existe el mismo producto con las MISMAS notas, sumamos
      // cantidad en vez de duplicar línea. Si las notas difieren se
      // crea otra línea (intencional: cocina ve cada nota separada).
      const existingIdx = state.cart.findIndex(
        (it) =>
          it.product_id === product.id &&
          (it.special_instructions || '') === (special_instructions || ''),
      );

      if (existingIdx >= 0) {
        state.cart[existingIdx].quantity += quantity;
      } else {
        state.cart.push({
          product_id: product.id,
          name: product.name,
          unit_price,
          quantity,
          special_instructions: special_instructions || '',
        });
      }
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

      // Arrancar el "libro" en la primera categoría. Sincronizamos
      // activeCategoryId por si quedó algo del estado anterior.
      state.bookIndex = 0;
      state.activeCategoryId =
        state.categories.length > 0 ? state.categories[0].id : null;

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
