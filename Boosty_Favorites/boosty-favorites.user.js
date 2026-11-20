// ==UserScript==
// @name         Boosty: избранное (звёздочка)
// @namespace    danil.boosty.favorites
// @version      1.0.1
// @description  Звёздочка у каждого поста и раздел «Избранное» в шапке Boosty. Сохранённые посты хранятся в браузере.
// @match        https://boosty.to/*
// @icon         https://boosty.to/favicon.png?v=15
// @grant        none
// @sandbox      DOM
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/ddyakovlev1/tampermonkey_skript_set/main/Boosty_Favorites/boosty-favorites.user.js
// @downloadURL  https://raw.githubusercontent.com/ddyakovlev1/tampermonkey_skript_set/main/Boosty_Favorites/boosty-favorites.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'tm-boosty-favorites';
  const EXCERPT_LIMIT = 160;
  const POST_ID_RE = /\/posts\/([0-9a-zA-Z-]{8,})/;

  // ── Иконки ────────────────────────────────────────────────────────────────
  // ровная симметричная пятиконечная звезда: R = 10, r = 4.2, центр 12×12
  const STAR_PATH = 'M12 2L14.469 8.602L21.511 8.91L15.995 13.298L17.878 20.09L12 16.2L6.122 20.09L8.005 13.298L2.489 8.91L9.531 8.602Z';
  function starSVG(size) {
    return '<svg class="tm-bo-star-svg" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" aria-hidden="true" focusable="false"><path d="' + STAR_PATH + '"/></svg>';
  }

  // ── Состояние и хранилище ─────────────────────────────────────────────────
  const state = {
    items: load(),
    filter: '',
    open: false,
    lastFocus: null
  };
  let panel = null;
  let overlay = null;
  let topBtn = null;
  let listEl = null;
  let countEl = null;
  let searchWrap = null;
  let searchInput = null;
  let toastEl = null;
  let toastTimer = 0;
  let scanTimer = 0;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return {};
      if (data.items && typeof data.items === 'object') return data.items;
      // на случай старого формата — просто словарь постов
      return data;
    } catch (err) {
      console.warn('[Boosty fav] не удалось прочитать избранное', err);
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, items: state.items }));
    } catch (err) {
      console.warn('[Boosty fav] не удалось сохранить избранное', err);
    }
  }

  const itemCount = () => Object.keys(state.items).length;

  function sortedItems() {
    return Object.values(state.items).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  // ── Разбор поста из DOM ───────────────────────────────────────────────────
  const clean = (str) => (str || '').replace(/\s+/g, ' ').trim();

  function postPath(post) {
    const ownId = (post.getAttribute('data-post-id') || '').trim();
    let fallback = null;
    const links = post.querySelectorAll('a[href*="/posts/"]');
    for (const a of links) {
      let url;
      try {
        url = new URL(a.getAttribute('href'), location.origin);
      } catch (err) {
        continue;
      }
      if (!POST_ID_RE.test(url.pathname)) continue;
      const path = url.pathname.replace(/\/$/, '');
      // в карточке может быть ссылка на другой пост (репост) — берём свою
      if (ownId && path.includes(ownId)) return path;
      if (!fallback) fallback = path;
    }
    return fallback;
  }

  function postId(post) {
    const raw = post.getAttribute('data-post-id');
    if (raw && raw.trim()) return raw.trim();
    const path = postPath(post);
    const m = path && path.match(POST_ID_RE);
    return m ? m[1] : null;
  }

  function blogSlugFromPath(path) {
    const m = (path || '').match(/^\/([^/]+)\/posts\//);
    return m ? m[1] : null;
  }

  function findAuthor(post, slug) {
    if (!slug) return { name: '', url: '', avatar: '' };

    const scopes = [post];
    if (post.parentElement) scopes.push(post.parentElement);
    const article = post.closest('article');
    if (article && article !== post) scopes.push(article);

    const selectors = [
      'a[href="/' + slug + '"]',
      'a[href="' + location.origin + '/' + slug + '"]',
      'a[href^="/' + slug + '?"]'
    ].join(',');

    for (const scope of scopes) {
      let link = null;
      try {
        link = scope.querySelector(selectors);
      } catch (err) {
        link = null;
      }
      if (!link) continue;

      const img = link.querySelector('img');
      return {
        name: clean(link.textContent),
        url: location.origin + '/' + slug,
        avatar: img ? (img.currentSrc || img.getAttribute('src') || '') : ''
      };
    }

    // на странице поста подпись автора может быть вне карточки поста
    return { name: slug, url: location.origin + '/' + slug, avatar: '' };
  }

  function firstImage(root) {
    if (!root) return '';
    const imgs = root.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (src && !src.startsWith('data:')) return src;
      const srcset = img.getAttribute('srcset') || img.getAttribute('srcSet') || '';
      if (srcset) return srcset.split(',')[0].trim().split(/\s+/)[0];
    }
    return '';
  }

  function makeItem(post) {
    const path = postPath(post);
    const id = postId(post);
    if (!path || !id) return null;

    const slug = blogSlugFromPath(path);
    const author = findAuthor(post, slug);

    const content = post.querySelector('[data-test-id="COMMON_POST_POSTCONTENT:ROOT"]') || post;

    const titleEl = post.querySelector(
      '[data-test-id="COMMON_POST_POSTCONTENT:TITLE"], [class*="Post-scss--module_title"]'
    );
    const title = clean(titleEl ? titleEl.textContent : '');

    let excerpt = '';
    const markups = content.querySelectorAll('[class*="module_markup"], [data-test-id*="POSTCONTENT:TEXT"]');
    for (const el of markups) {
      const text = clean(el.textContent);
      if (text && text !== title) {
        excerpt = text;
        break;
      }
    }
    if (!excerpt) {
      excerpt = clean(content.textContent);
      if (title && excerpt.startsWith(title)) excerpt = excerpt.slice(title.length);
    }
    if (excerpt.length > EXCERPT_LIMIT) {
      excerpt = excerpt.slice(0, EXCERPT_LIMIT).replace(/[\s.,;:!?-]+$/, '') + '…';
    }

    const dateEl = post.querySelector(
      '[data-test-id="COMMON_CREATEDAT:ROOT"], [class*="CreatedAt-scss--module"]'
    );
    const date = clean(dateEl ? dateEl.textContent : '');

    let finalTitle = title || excerpt.slice(0, 70);
    if (!finalTitle) finalTitle = date ? 'Пост от ' + date : 'Пост';

    return {
      id: id,
      path: path,
      url: location.origin + path,
      title: finalTitle,
      author: author.name || (slug || ''),
      authorUrl: author.url,
      avatar: author.avatar,
      image: firstImage(content),
      excerpt: excerpt && excerpt !== finalTitle ? excerpt : '',
      date: date,
      addedAt: Date.now()
    };
  }

  // ── Добавление / удаление ─────────────────────────────────────────────────
  function toggle(item) {
    const existing = state.items[item.id];
    if (existing) {
      delete state.items[item.id];
      save();
      syncUI();
      toast('Убрано из избранного', 'Вернуть', () => {
        state.items[item.id] = existing;
        save();
        syncUI();
      });
      return false;
    }

    state.items[item.id] = item;
    save();
    syncUI();
    toast('Добавлено в избранное', 'Открыть', () => openPanel());
    return true;
  }

  function removeItem(id) {
    const existing = state.items[id];
    if (!existing) return;
    delete state.items[id];
    save();
    syncUI();
    toast('Убрано из избранного', 'Вернуть', () => {
      state.items[id] = existing;
      save();
      syncUI();
    });
  }

  // ── Кнопка у поста ────────────────────────────────────────────────────────
  function updateStar(btn) {
    const post = btn.closest('[data-post-id]');
    const id = post ? postId(post) : null;
    const active = !!(id && state.items[id]);
    btn.classList.toggle('is-active', active);
    btn.title = active ? 'Убрать из избранного' : 'Добавить в избранное';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function makePostStar(post) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tm-bo-star-btn';
    btn.innerHTML = starSVG(18);
    updateStar(btn);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = makeItem(post);
      if (!item) return;
      toggle(item);
      btn.classList.remove('tm-bo-pop');
      void btn.offsetWidth;
      btn.classList.add('tm-bo-pop');
    });

    // не даём карточке открыть пост и не ломаем контекстное меню
    ['mousedown', 'pointerdown', 'dblclick', 'contextmenu'].forEach((type) => {
      btn.addEventListener(type, (e) => e.stopPropagation());
    });

    return btn;
  }

  function mountPostStars() {
    const posts = document.querySelectorAll('[data-post-id]');
    for (const post of posts) {
      // вложенные элементы с тем же id не трогаем — звезда нужна один раз на карточку
      if (post.parentElement && post.parentElement.closest('[data-post-id]')) continue;

      const right = post.querySelector('[class*="headerRightBlock"]');
      const header = post.querySelector('[class*="BasePostHeader"], [class*="PostHeader"]');

      // если React перерисовал шапку, кнопки в ней уже нет — вернём
      if (post.querySelectorAll('.tm-bo-star-btn').length > 1) {
        post.querySelectorAll('.tm-bo-star-btn').forEach((extra, index) => {
          if (index > 0) extra.remove();
        });
      }

      let btn = post.querySelector('.tm-bo-star-btn');
      if (btn) {
        updateStar(btn);
        continue;
      }

      if (!right && !header) {
        // редкая карточка без шапки — вешаем звезду поверх неё
        btn = makePostStar(post);
        btn.classList.add('tm-bo-star-float');
        if (window.getComputedStyle(post).position === 'static') post.style.position = 'relative';
        post.appendChild(btn);
        continue;
      }

      btn = makePostStar(post);

      if (right) {
        // левее замка и «...», как раз у правого края шапки поста
        right.insertBefore(btn, right.firstElementChild);
      } else {
        header.appendChild(btn);
      }
    }
  }

  // ── Верхняя кнопка ────────────────────────────────────────────────────────
  function buildTopButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tm-bo-top';
    btn.dataset.tmBo = 'top';
    btn.innerHTML = starSVG(24);
    btn.title = 'Избранное';
    btn.setAttribute('aria-label', 'Открыть избранное');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.open) closePanel();
      else openPanel();
    });
    return btn;
  }

  function topMenuCandidate() {
    const direct = document.querySelector('[class*="TopMenu-scss--module_right"]');
    if (direct) return direct;
    const menu = document.getElementById('topMenu');
    if (!menu) return null;
    return menu.querySelector('[class*="RightButtons"]') || menu.lastElementChild;
  }

  function ensureTopButton() {
    if (!topBtn) topBtn = buildTopButton();
    if (topBtn.isConnected) return;
    const holder = topMenuCandidate();
    if (!holder) return;
    holder.insertBefore(topBtn, holder.firstElementChild);
  }

  function updateBadge() {
    if (!topBtn) return;
    const n = itemCount();
    topBtn.title = n ? 'Избранное: ' + n : 'Избранное';
    topBtn.setAttribute('aria-label', n ? 'Открыть избранное, постов: ' + n : 'Открыть избранное');
  }

  // ── Панель «Избранное» ────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildPanel() {
    overlay = el('div', 'tm-bo-overlay');
    overlay.addEventListener('click', closePanel);

    panel = el('aside', 'tm-bo-panel');
    panel.tabIndex = -1;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Избранное');
    panel.setAttribute('aria-hidden', 'true');

    const head = el('div', 'tm-bo-panel__head');
    const titleWrap = el('div', 'tm-bo-panel__title');
    const star = el('span', 'tm-bo-panel__title-star');
    star.innerHTML = starSVG(20);
    countEl = el('span', 'tm-bo-panel__count', '0');
    titleWrap.append(star, el('span', null, 'Избранное'), countEl);

    const close = el('button', 'tm-bo-icon-btn', '✕');
    close.type = 'button';
    close.title = 'Закрыть';
    close.setAttribute('aria-label', 'Закрыть избранное');
    close.addEventListener('click', closePanel);

    head.append(titleWrap, close);

    searchWrap = el('div', 'tm-bo-panel__search');
    searchInput = el('input', 'tm-bo-panel__input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Поиск по избранному';
    searchInput.setAttribute('aria-label', 'Поиск по избранному');
    searchInput.addEventListener('input', () => {
      state.filter = searchInput.value;
      renderList();
    });
    searchWrap.append(searchInput);

    listEl = el('div', 'tm-bo-panel__list');

    const foot = el('div', 'tm-bo-panel__foot', 'Хранится в этом браузере');

    panel.append(head, searchWrap, listEl, foot);

    toastEl = el('div', 'tm-bo-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');

    document.body.append(overlay, panel, toastEl);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) closePanel();
    });
  }

  function openPanel() {
    if (!panel) buildPanel();
    state.open = true;
    state.lastFocus = document.activeElement;
    panel.classList.add('is-open');
    overlay.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    topBtn && topBtn.classList.add('is-open');
    if (searchInput) searchInput.value = state.filter;
    renderList();
    panel.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!panel) return;
    state.open = false;
    panel.classList.remove('is-open');
    overlay.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    topBtn && topBtn.classList.remove('is-open');
    state.filter = '';
    if (searchInput) searchInput.value = '';
    if (state.lastFocus && state.lastFocus.focus) {
      try {
        state.lastFocus.focus({ preventScroll: true });
      } catch (err) {
        /* ignore */
      }
    }
  }

  function avatarNode(item) {
    if (item.avatar) {
      const img = el('img', 'tm-bo-item__avatar');
      img.src = item.avatar;
      img.alt = '';
      img.loading = 'lazy';
      return img;
    }
    const letter = el('span', 'tm-bo-item__avatar tm-bo-item__avatar_letter');
    letter.textContent = (item.author || '?').trim().charAt(0).toUpperCase();
    return letter;
  }

  function thumbNode(item) {
    const box = el('div', 'tm-bo-item__thumb');
    if (item.image) {
      const img = el('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      box.append(img);
    } else {
      const star = el('span', 'tm-bo-item__thumb-star');
      star.innerHTML = starSVG(26);
      box.append(star);
    }
    return box;
  }

  function itemNode(item) {
    const node = el('div', 'tm-bo-item');
    node.tabIndex = 0;
    node.setAttribute('role', 'link');
    node.setAttribute('aria-label', 'Открыть пост: ' + item.title);

    const open = () => {
      location.href = item.url;
    };
    node.addEventListener('click', (e) => {
      if (e.target.closest('.tm-bo-item__remove')) return;
      open();
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        if (e.target.closest('.tm-bo-item__remove')) return;
        e.preventDefault();
        open();
      }
    });

    const body = el('div', 'tm-bo-item__body');
    body.append(el('div', 'tm-bo-item__title', item.title));

    const meta = el('div', 'tm-bo-item__meta');
    meta.append(avatarNode(item));
    const metaText = [item.author, item.date].filter(Boolean).join(' · ');
    meta.append(el('span', 'tm-bo-item__meta-text', metaText || 'Boosty'));
    body.append(meta);

    if (item.excerpt) body.append(el('div', 'tm-bo-item__excerpt', item.excerpt));

    const remove = el('button', 'tm-bo-item__remove');
    remove.type = 'button';
    remove.title = 'Убрать из избранного';
    remove.setAttribute('aria-label', 'Убрать из избранного');
    remove.innerHTML = starSVG(18);
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeItem(item.id);
    });

    node.append(thumbNode(item), body, remove);
    return node;
  }

  function emptyNode() {
    const box = el('div', 'tm-bo-empty');
    const star = el('div', 'tm-bo-empty__star');
    star.innerHTML = starSVG(46);
    box.append(
      star,
      el('div', 'tm-bo-empty__title', 'Пока пусто'),
      el('div', 'tm-bo-empty__text', 'Нажми звёздочку у любого поста на Boosty — он появится здесь.')
    );
    return box;
  }

  function renderList() {
    if (!listEl) return;
    const all = sortedItems();
    countEl.textContent = all.length > 99 ? '99+' : String(all.length);

    const q = state.filter.trim().toLowerCase();
    const items = q
      ? all.filter((it) => (it.title + ' ' + it.author + ' ' + it.excerpt).toLowerCase().includes(q))
      : all;

    searchWrap.hidden = all.length === 0;
    listEl.textContent = '';

    if (!items.length) {
      if (!all.length) {
        listEl.append(emptyNode());
      } else {
        listEl.append(el('div', 'tm-bo-empty__text tm-bo-empty__text_center', 'Ничего не найдено'));
      }
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) frag.append(itemNode(item));
    listEl.append(frag);
  }

  // ── Тост ──────────────────────────────────────────────────────────────────
  function toast(message, actionLabel, action) {
    if (!toastEl) {
      if (!panel) buildPanel();
    }
    toastEl.textContent = '';
    toastEl.append(el('span', 'tm-bo-toast__text', message));

    if (actionLabel && action) {
      const btn = el('button', 'tm-bo-toast__action', actionLabel);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        hideToast();
        action();
      });
      toastEl.append(btn);
    }

    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3000);
  }

  function hideToast() {
    if (toastEl) toastEl.classList.remove('is-visible');
    clearTimeout(toastTimer);
  }

  // ── Синхронизация интерфейса ──────────────────────────────────────────────
  function syncUI() {
    updateBadge();
    document.querySelectorAll('.tm-bo-star-btn').forEach(updateStar);
    if (state.open) renderList();
  }

  // ── Стили ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('tm-bo-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-bo-style';
    style.textContent = `
      .tm-bo-star-svg path {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linejoin: round;
        transition: fill .15s ease, stroke .15s ease;
      }
      .tm-bo-star-btn.is-active .tm-bo-star-svg path,
      .tm-bo-item__remove .tm-bo-star-svg path,
      .tm-bo-empty__star .tm-bo-star-svg path,
      .tm-bo-panel__title-star .tm-bo-star-svg path {
        fill: currentColor;
      }

      /* кнопка в шапке */
      .tm-bo-top {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        margin: 0 2px;
        padding: 0;
        border: 0;
        border-radius: 12px;
        background: transparent;
        color: var(--var-color-text-primary, #f1f1f1);
        cursor: pointer;
        flex: 0 0 auto;
        transition: background .15s ease, color .15s ease;
        -webkit-tap-highlight-color: transparent;
      }
      // звезда в шапке — та же обводка, что у иконок уведомлений и сообщений
      .tm-bo-top .tm-bo-star-svg path { stroke-width: 1.8; }
      .tm-bo-top:hover { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--color-brand, #f15f2c); }
      .tm-bo-top.is-open { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--color-brand, #f15f2c); }

      /* звезда в карточке поста */
      .tm-bo-star-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin-right: 2px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--var-color-text-secondary, #8c8c8c);
        cursor: pointer;
        flex: 0 0 auto;
        transition: background .15s ease, color .15s ease;
        -webkit-tap-highlight-color: transparent;
      }
      .tm-bo-star-btn:hover { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--color-brand, #f15f2c); }
      .tm-bo-star-btn.is-active { color: var(--color-brand, #f15f2c); }
      .tm-bo-star-btn.tm-bo-star-float {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 2;
        background: var(--var-color-chip-bg, rgba(0,0,0,.45));
      }
      .tm-bo-pop .tm-bo-star-svg { animation: tm-bo-pop .34s ease; }
      @keyframes tm-bo-pop {
        0% { transform: scale(1); }
        45% { transform: scale(1.35); }
        100% { transform: scale(1); }
      }

      /* затемнение и панель */
      .tm-bo-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        background: rgba(0, 0, 0, .5);
        opacity: 0;
        visibility: hidden;
        transition: opacity .22s ease, visibility .22s ease;
      }
      .tm-bo-overlay.is-open { opacity: 1; visibility: visible; }

      .tm-bo-panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 2147483001;
        display: flex;
        flex-direction: column;
        width: 420px;
        max-width: 100vw;
        background: var(--var-color-popup-bg, #262626);
        color: var(--var-color-text-primary, #f1f1f1);
        border-left: 1px solid var(--var-color-base-border, #3c3c3c);
        box-shadow: -12px 0 40px rgba(0, 0, 0, .28);
        transform: translateX(102%);
        visibility: hidden;
        transition: transform .24s ease, visibility .24s ease;
        font-family: inherit;
        outline: none;
      }
      .tm-bo-panel.is-open { transform: none; visibility: visible; }

      .tm-bo-panel__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 18px 14px;
        border-bottom: 1px solid var(--var-color-base-border, #3c3c3c);
        flex: 0 0 auto;
      }
      .tm-bo-panel__title {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -.01em;
      }
      .tm-bo-panel__title-star { display: inline-flex; color: var(--color-brand, #f15f2c); }
      .tm-bo-panel__count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 22px;
        padding: 0 7px;
        border-radius: 11px;
        background: var(--var-color-chip-bg, rgba(127,127,127,.14));
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 12px;
        font-weight: 600;
      }

      .tm-bo-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        transition: background .15s ease, color .15s ease;
      }
      .tm-bo-icon-btn:hover { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--var-color-text-primary, #f1f1f1); }

      .tm-bo-panel__search { padding: 12px 18px 4px; flex: 0 0 auto; }
      .tm-bo-panel__input {
        width: 100%;
        box-sizing: border-box;
        height: 38px;
        padding: 0 14px;
        border: 1px solid transparent;
        border-radius: 12px;
        background: var(--var-color-chip-bg, rgba(127,127,127,.12));
        color: var(--var-color-text-primary, #f1f1f1);
        font: inherit;
        font-size: 14px;
        outline: none;
        transition: border-color .15s ease, background .15s ease;
      }
      .tm-bo-panel__input::placeholder { color: var(--var-color-text-secondary, #8c8c8c); }
      .tm-bo-panel__input:focus { border-color: var(--color-brand, #f15f2c); background: transparent; }

      .tm-bo-panel__list {
        flex: 1 1 auto;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 10px 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tm-bo-panel__list::-webkit-scrollbar { width: 8px; }
      .tm-bo-panel__list::-webkit-scrollbar-thumb {
        background: var(--var-color-chip-bg, rgba(127,127,127,.3));
        border-radius: 4px;
      }

      .tm-bo-item {
        position: relative;
        display: flex;
        gap: 12px;
        align-items: flex-start;
        padding: 10px;
        border-radius: 14px;
        background: var(--var-color-chip-bg, rgba(127,127,127,.08));
        border: 1px solid transparent;
        cursor: pointer;
        transition: border-color .15s ease, background .15s ease;
      }
      .tm-bo-item:hover,
      .tm-bo-item:focus-visible {
        background: var(--var-color-chip-bg-hover, rgba(127,127,127,.14));
        border-color: var(--var-color-base-border, #3c3c3c);
        outline: none;
      }
      .tm-bo-item__thumb {
        flex: 0 0 auto;
        width: 62px;
        height: 62px;
        border-radius: 10px;
        overflow: hidden;
        background: var(--var-color-chip-bg, rgba(127,127,127,.12));
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .tm-bo-item__thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .tm-bo-item__thumb-star { color: var(--var-color-text-secondary, #8c8c8c); opacity: .55; }
      .tm-bo-item__body { flex: 1 1 auto; min-width: 0; padding-right: 22px; }
      .tm-bo-item__title {
        font-size: 14px;
        font-weight: 600;
        line-height: 1.35;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .tm-bo-item__meta {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 5px;
        min-width: 0;
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 12px;
      }
      .tm-bo-item__avatar {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        object-fit: cover;
        flex: 0 0 auto;
        background: var(--var-color-chip-bg, rgba(127,127,127,.2));
      }
      .tm-bo-item__avatar_letter {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
        font-weight: 700;
        color: var(--var-color-text-primary, #f1f1f1);
      }
      .tm-bo-item__meta-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-bo-item__excerpt {
        margin-top: 5px;
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 12px;
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .tm-bo-item__remove {
        position: absolute;
        top: 8px;
        right: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--color-brand, #f15f2c);
        cursor: pointer;
        opacity: .85;
        transition: background .15s ease, opacity .15s ease;
      }
      .tm-bo-item__remove:hover { opacity: 1; background: var(--var-color-chip-bg, rgba(127,127,127,.16)); }

      .tm-bo-empty {
        margin: auto;
        padding: 40px 24px;
        text-align: center;
        color: var(--var-color-text-secondary, #8c8c8c);
      }
      .tm-bo-empty__star { color: var(--var-color-text-secondary, #8c8c8c); opacity: .5; margin-bottom: 14px; }
      .tm-bo-empty__title { font-size: 16px; font-weight: 700; color: var(--var-color-text-primary, #f1f1f1); margin-bottom: 6px; }
      .tm-bo-empty__text { font-size: 13px; line-height: 1.45; max-width: 280px; }
      .tm-bo-empty__text_center { text-align: center; padding: 28px 12px; }

      .tm-bo-panel__foot {
        flex: 0 0 auto;
        padding: 10px 18px 14px;
        border-top: 1px solid var(--var-color-base-border, #3c3c3c);
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 11px;
      }

      .tm-bo-toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        z-index: 2147483002;
        display: flex;
        align-items: center;
        gap: 12px;
        max-width: calc(100vw - 32px);
        padding: 11px 16px;
        border-radius: 12px;
        background: var(--var-color-popup-bg, #262626);
        border: 1px solid var(--var-color-base-border, #3c3c3c);
        box-shadow: 0 10px 30px rgba(0, 0, 0, .3);
        color: var(--var-color-text-primary, #f1f1f1);
        font-size: 13px;
        transform: translate(-50%, 20px);
        opacity: 0;
        visibility: hidden;
        transition: opacity .2s ease, transform .2s ease, visibility .2s ease;
      }
      .tm-bo-toast.is-visible { transform: translate(-50%, 0); opacity: 1; visibility: visible; }
      .tm-bo-toast__action {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--color-brand, #f15f2c);
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }

      @media (max-width: 520px) {
        .tm-bo-panel { width: 100%; border-left: 0; }
        .tm-bo-top { margin: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .tm-bo-panel, .tm-bo-overlay, .tm-bo-toast, .tm-bo-star-svg path { transition: none; }
        .tm-bo-pop .tm-bo-star-svg { animation: none; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── Запуск и слежение за SPA ──────────────────────────────────────────────
  function scan() {
    injectStyles();
    ensureTopButton();
    mountPostStars();
    updateBadge();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 120);
  }

  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }

    scan();
    buildPanel();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target && mutation.target.closest && mutation.target.closest('.tm-bo-panel, .tm-bo-toast, .tm-bo-top')) {
          continue;
        }
        scheduleScan();
        return;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Boosty — SPA: подстраховка на случай, если разметка поменялась без мутаций
    setInterval(scan, 2500);

    // синхронизация между вкладками
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY) return;
      state.items = load();
      syncUI();
    });

    console.log('[Boosty fav] избранное запущено');
  }

  init();
})();
