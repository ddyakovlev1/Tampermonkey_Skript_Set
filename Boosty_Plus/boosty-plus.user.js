// ==UserScript==
// @name         Boosty Plus
// @namespace    danil.boosty.plus
// @version      2.0.0
// @description  Звёздочка у постов, «Избранное» и «История» последних 30 просмотров на Boosty. Всё хранится в браузере.
// @match        https://boosty.to/*
// @icon         https://boosty.to/favicon.png?v=15
// @grant        none
// @sandbox      DOM
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/ddyakovlev1/tampermonkey_skript_set/main/Boosty_Plus/boosty-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/ddyakovlev1/tampermonkey_skript_set/main/Boosty_Plus/boosty-plus.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'tm-boosty-plus';
  const LEGACY_STORE_KEY = 'tm-boosty-favorites';
  const HISTORY_LIMIT = 30;
  const EXCERPT_LIMIT = 160;
  const POST_ID_RE = /\/posts\/([0-9a-zA-Z-]{8,})/;

  // ── Иконки ────────────────────────────────────────────────────────────────
  // ровная симметричная пятиконечная звезда: R = 10, r = 4.2, центр 12×12
  const STAR_PATH = 'M12 2L14.469 8.602L21.511 8.91L15.995 13.298L17.878 20.09L12 16.2L6.122 20.09L8.005 13.298L2.489 8.91L9.531 8.602Z';
  function starSVG(size) {
    return '<svg class="tm-bo-star-svg" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" aria-hidden="true" focusable="false"><path d="' + STAR_PATH + '"/></svg>';
  }

  // часы со стрелкой против часовой — как иконка истории в интерфейсах
  const CLOCK_PARTS =
    '<polyline points="1 4 1 10 7 10"/>' +
    '<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>' +
    '<path d="M12 7v5l3 2"/>';
  function clockSVG(size) {
    return '<svg class="tm-bo-clock-svg" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" aria-hidden="true" focusable="false">' + CLOCK_PARTS + '</svg>';
  }

  // ── Состояние и хранилище ─────────────────────────────────────────────────
  const state = {
    items: {},
    history: [],
    filter: '',
    tab: 'favorites',
    open: false,
    lastFocus: null
  };
  let panel = null;
  let overlay = null;
  let topBtn = null;
  let historyBtn = null;
  let tabsEl = null;
  let favCountEl = null;
  let histCountEl = null;
  let toolsEl = null;
  let footEl = null;
  let listEl = null;
  let searchWrap = null;
  let searchInput = null;
  let toastEl = null;
  let toastTimer = 0;
  let scanTimer = 0;

  function parseJson(raw) {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      return null;
    }
  }

  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

  function sanitizeHistory(list) {
    const sorted = (Array.isArray(list) ? list : [])
      .filter((item) =>
        isObject(item) &&
        typeof item.id === 'string' && item.id &&
        typeof item.url === 'string' && item.url
      )
      .sort((a, b) => (b.viewedAt || 0) - (a.viewedAt || 0));

    const seen = new Set();
    const out = [];
    for (const item of sorted) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out.slice(0, HISTORY_LIMIT);
  }

  function normalizeStore(newRaw, oldRaw) {
    const nw = parseJson(newRaw);
    const old = parseJson(oldRaw);
    let items = {};
    let history = [];

    if (isObject(nw)) {
      if (isObject(nw.items)) items = nw.items;
      else if (isObject(nw.favorites)) items = nw.favorites;
      history = sanitizeHistory(nw.history);
    } else if (isObject(old)) {
      items = isObject(old.items) ? old.items : old;
    }

    return { items, history };
  }

  function readStore(storage) {
    return normalizeStore(storage.getItem(STORE_KEY), storage.getItem(LEGACY_STORE_KEY));
  }

  function saveStore(storage, items, history) {
    try {
      storage.setItem(STORE_KEY, JSON.stringify({ v: 1, items, history }));
    } catch (err) {
      console.warn('[Boosty Plus] не удалось сохранить данные', err);
    }
  }

  function load() {
    return readStore(localStorage);
  }

  function save() {
    saveStore(localStorage, state.items, state.history);
  }

  // ── Модель истории ────────────────────────────────────────────────────────
  const POST_PAGE_RE = /^\/([^/]+)\/posts\/([0-9a-zA-Z-]{8,})\/?$/;
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function parsePostPath(pathname) {
    const m = (pathname || '').match(POST_PAGE_RE);
    return m ? { slug: m[1], id: m[2] } : null;
  }

  function cleanTitle(raw, author) {
    let title = clean(raw);
    if (!title) return '';
    const suffixes = [];
    if (author) suffixes.push(' - ' + clean(author));
    suffixes.push(' - Boosty', ' | Boosty');
    for (const suffix of suffixes) {
      if (suffix && title.endsWith(suffix)) {
        title = title.slice(0, -suffix.length).trim();
        break;
      }
    }
    title = title.replace(/^[-|]\s*/, '').trim();
    if (!title || title === 'Boosty' || (author && title === clean(author))) return '';
    return title;
  }

  function relativeViewedAt(ts, now) {
    if (!ts) return '';
    const date = new Date(ts);
    if (isNaN(date.getTime())) return '';
    const current = new Date(now == null ? Date.now() : now);

    const sameDay = date.getFullYear() === current.getFullYear() &&
      date.getMonth() === current.getMonth() &&
      date.getDate() === current.getDate();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    if (sameDay) return 'сегодня, ' + hh + ':' + mm;

    const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
    const isYesterday = date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();
    if (isYesterday) return 'вчера, ' + hh + ':' + mm;

    const dayMonth = date.getDate() + ' ' + MONTHS_SHORT[date.getMonth()];
    return date.getFullYear() === current.getFullYear()
      ? dayMonth
      : dayMonth + ' ' + date.getFullYear();
  }

  function buildHistoryEntry(input) {
    const data = input || {};
    return {
      id: String(data.id || ''),
      path: data.path || '',
      url: data.url || ((data.origin || '') + (data.path || '')),
      title: clean(data.title) || 'Пост',
      author: clean(data.author),
      authorUrl: data.authorUrl || '',
      avatar: data.avatar || '',
      image: data.image || '',
      excerpt: data.excerpt || '',
      date: clean(data.date),
      type: data.type === 'video' ? 'video' : 'post',
      viewedAt: typeof data.viewedAt === 'number' ? data.viewedAt : Date.now()
    };
  }

  function upsertHistory(list, entry, limit) {
    const max = typeof limit === 'number' ? limit : HISTORY_LIMIT;
    const rest = (Array.isArray(list) ? list : []).filter((item) => item && item.id !== entry.id);
    return [entry].concat(rest).slice(0, max);
  }

  function removeHistoryEntry(list, id) {
    return (Array.isArray(list) ? list : []).filter((item) => item && item.id !== id);
  }

  // ── Запись просмотра ──────────────────────────────────────────────────────
  let lastUrl = '';
  let captureTimer = 0;
  let videoWatchTimer = 0;

  function metaContent(property) {
    const meta = document.querySelector('meta[property="' + property + '"]');
    return meta ? (meta.getAttribute('content') || '').trim() : '';
  }

  function detectVideo(root) {
    if (!root || !root.querySelector) return false;
    return !!root.querySelector(
      'video, iframe[src*="ok.ru/video"], iframe[src*="vk.com/video"], iframe[src*="vkvideo"], iframe[src*="youtube.com/embed"], [class*="VideoPlayer"], [data-test-id*="VIDEO"]'
    );
  }

  function currentPostEntry() {
    const info = parsePostPath(location.pathname);
    if (!info) return null;

    const post = document.querySelector('[data-post-id="' + info.id + '"]');
    const titleEl = post ? post.querySelector('[data-test-id="COMMON_POST_POSTCONTENT:TITLE"]') : null;
    const authorCard = post ? document.querySelector('[class*="AuthorCard"]') : null;
    const authorLink = authorCard
      ? authorCard.querySelector('a[href="/' + info.slug + '"]') || authorCard.querySelector('a[href^="/' + info.slug + '?"]')
      : null;
    const authorNameEl = authorCard ? authorCard.querySelector('[class*="authorName"]') : null;
    const avatarEl = authorLink ? authorLink.querySelector('img') : null;
    const dateEl = post ? document.querySelector('[data-test-id="COMMON_CREATEDAT:ROOT"]') : null;

    const author = clean(authorNameEl ? authorNameEl.textContent : (authorLink ? authorLink.textContent : ''));
    const title = cleanTitle(titleEl ? titleEl.textContent : '', author) ||
      cleanTitle(metaContent('og:title'), author) ||
      cleanTitle(document.title, author) ||
      'Пост';

    return buildHistoryEntry({
      origin: location.origin,
      id: info.id,
      path: location.pathname.replace(/\/$/, ''),
      title: title,
      author: author || info.slug,
      authorUrl: location.origin + '/' + info.slug,
      avatar: avatarEl ? (avatarEl.currentSrc || avatarEl.getAttribute('src') || '') : '',
      image: metaContent('og:image') || firstImage(post),
      date: dateEl ? clean(dateEl.textContent) : '',
      type: detectVideo(post) ? 'video' : 'post'
    });
  }

  function capturePostView() {
    const info = parsePostPath(location.pathname);
    if (!info) return;

    const url = location.href;
    let attempts = 0;
    clearTimeout(captureTimer);

    const attempt = () => {
      if (location.href !== url) return;
      const ready = !!document.querySelector('[data-post-id="' + info.id + '"]');
      if (!ready && attempts++ < 8) {
        captureTimer = setTimeout(attempt, 250);
        return;
      }

      const entry = currentPostEntry();
      if (!entry) return;
      state.history = upsertHistory(state.history, entry);
      save();
      updateBadge();
      if (state.open && state.tab === 'history') renderList();
      watchVideoUpgrade(entry.id, url);
    };

    attempt();
  }

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (parsePostPath(location.pathname)) capturePostView();
  }

  function watchVideoUpgrade(id, url) {
    clearTimeout(videoWatchTimer);
    let attempts = 0;
    const tick = () => {
      if (location.href !== url || attempts++ >= 20) return;
      if (detectVideo(document)) {
        const entry = state.history.find((item) => item.id === id);
        if (entry && entry.type !== 'video') {
          entry.type = 'video';
          entry.viewedAt = Date.now();
          state.history = upsertHistory(state.history, entry);
          save();
          if (state.open && state.tab === 'history') renderList();
        }
        return;
      }
      videoWatchTimer = setTimeout(tick, 500);
    };
    videoWatchTimer = setTimeout(tick, 500);
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
    toast('Добавлено в избранное', 'Открыть', () => openPanel('favorites'));
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

  function removeHistoryItem(id) {
    const index = state.history.findIndex((item) => item.id === id);
    if (index < 0) return;
    const entry = state.history[index];
    state.history = removeHistoryEntry(state.history, id);
    save();
    syncUI();
    toast('Убрано из истории', 'Вернуть', () => {
      state.history.splice(Math.min(index, state.history.length), 0, entry);
      save();
      syncUI();
    });
  }

  function clearHistory() {
    if (!state.history.length) return;
    const old = state.history.slice();
    state.history = [];
    save();
    syncUI();
    toast('История очищена', 'Вернуть', () => {
      state.history = old;
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

  // ── Верхние кнопки ────────────────────────────────────────────────────────
  function buildTopButton(kind) {
    const isHistory = kind === 'history';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tm-bo-top';
    btn.dataset.tmBo = kind;
    btn.innerHTML = isHistory ? clockSVG(24) : starSVG(24);
    btn.title = isHistory ? 'История' : 'Избранное';
    btn.setAttribute('aria-label', isHistory ? 'Открыть историю' : 'Открыть избранное');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.open && state.tab === kind) closePanel();
      else openPanel(kind);
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

  function ensureTopButtons() {
    if (!topBtn) topBtn = buildTopButton('favorites');
    if (!historyBtn) historyBtn = buildTopButton('history');
    if (topBtn.isConnected && historyBtn.isConnected) return;
    const holder = topMenuCandidate();
    if (!holder) return;
    if (!topBtn.isConnected) holder.insertBefore(topBtn, holder.firstElementChild);
    if (!historyBtn.isConnected) holder.insertBefore(historyBtn, topBtn);
  }

  function updateBadge() {
    const n = itemCount();
    if (topBtn) {
      topBtn.title = n ? 'Избранное: ' + n : 'Избранное';
      topBtn.setAttribute('aria-label', n ? 'Открыть избранное, постов: ' + n : 'Открыть избранное');
    }
    if (historyBtn) {
      const h = state.history.length;
      historyBtn.title = h ? 'История: ' + h : 'История';
      historyBtn.setAttribute('aria-label', h ? 'Открыть историю, записей: ' + h : 'Открыть историю');
    }
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
    panel.setAttribute('aria-label', 'Boosty Plus');
    panel.setAttribute('aria-hidden', 'true');

    const head = el('div', 'tm-bo-panel__head');
    tabsEl = el('div', 'tm-bo-tabs');
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', 'Разделы Boosty Plus');

    const favTab = el('button', 'tm-bo-tab');
    favTab.type = 'button';
    favTab.dataset.tab = 'favorites';
    favTab.setAttribute('role', 'tab');
    favTab.innerHTML = starSVG(18) + '<span>Избранное</span>';
    favCountEl = el('span', 'tm-bo-panel__count', '0');
    favTab.append(favCountEl);
    favTab.addEventListener('click', () => switchTab('favorites'));

    const histTab = el('button', 'tm-bo-tab');
    histTab.type = 'button';
    histTab.dataset.tab = 'history';
    histTab.setAttribute('role', 'tab');
    histTab.innerHTML = clockSVG(18) + '<span>История</span>';
    histCountEl = el('span', 'tm-bo-panel__count', '0');
    histTab.append(histCountEl);
    histTab.addEventListener('click', () => switchTab('history'));

    tabsEl.append(histTab, favTab);

    const close = el('button', 'tm-bo-icon-btn', '✕');
    close.type = 'button';
    close.title = 'Закрыть';
    close.setAttribute('aria-label', 'Закрыть Boosty Plus');
    close.addEventListener('click', closePanel);

    head.append(tabsEl, close);

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

    toolsEl = el('div', 'tm-bo-panel__tools');
    toolsEl.append(el('span', 'tm-bo-panel__tools-text', 'Последние 30'));
    const clear = el('button', 'tm-bo-panel__clear', 'Очистить');
    clear.type = 'button';
    clear.addEventListener('click', clearHistory);
    toolsEl.append(clear);

    listEl = el('div', 'tm-bo-panel__list');

    footEl = el('div', 'tm-bo-panel__foot', 'Хранится в этом браузере');

    panel.append(head, searchWrap, toolsEl, listEl, footEl);

    toastEl = el('div', 'tm-bo-toast');
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');

    document.body.append(overlay, panel, toastEl);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) closePanel();
    });
  }

  function switchTab(tab) {
    state.tab = tab === 'history' ? 'history' : 'favorites';
    state.filter = '';
    if (searchInput) searchInput.value = '';
    renderTabs();
    renderList();
  }

  function openPanel(tab) {
    if (!panel) buildPanel();
    if (tab === 'favorites' || tab === 'history') state.tab = tab;
    state.open = true;
    state.lastFocus = document.activeElement;
    panel.classList.add('is-open');
    overlay.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    topBtn && topBtn.classList.toggle('is-open', state.tab === 'favorites');
    historyBtn && historyBtn.classList.toggle('is-open', state.tab === 'history');
    if (searchInput) searchInput.value = state.filter;
    renderTabs();
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
    historyBtn && historyBtn.classList.remove('is-open');
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

  function thumbNode(item, placeholder) {
    const box = el('div', 'tm-bo-item__thumb');
    if (item.image) {
      const img = el('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      box.append(img);
    } else {
      const icon = el('span', 'tm-bo-item__thumb-star');
      icon.innerHTML = placeholder === 'clock' ? clockSVG(26) : starSVG(26);
      box.append(icon);
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

  function historyItemNode(item) {
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
    const metaText = [item.author, relativeViewedAt(item.viewedAt)].filter(Boolean).join(' · ');
    meta.append(el('span', 'tm-bo-item__meta-text', metaText || 'Boosty'));
    body.append(meta);

    if (item.type === 'video') body.append(el('span', 'tm-bo-item__badge', 'видео'));

    const remove = el('button', 'tm-bo-item__remove tm-bo-item__remove_text', '×');
    remove.type = 'button';
    remove.title = 'Убрать из истории';
    remove.setAttribute('aria-label', 'Убрать из истории');
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeHistoryItem(item.id);
    });

    node.append(thumbNode(item, 'clock'), body, remove);
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

  function historyEmptyNode() {
    const box = el('div', 'tm-bo-empty');
    const clock = el('div', 'tm-bo-empty__clock');
    clock.innerHTML = clockSVG(46);
    box.append(
      clock,
      el('div', 'tm-bo-empty__title', 'Пока пусто'),
      el('div', 'tm-bo-empty__text', 'Открой любой пост или видео на Boosty — он появится здесь.')
    );
    return box;
  }

  function renderTabs() {
    if (!tabsEl) return;
    const isHistory = state.tab === 'history';
    const favCount = itemCount();
    const histCount = state.history.length;

    if (favCountEl) favCountEl.textContent = favCount > 99 ? '99+' : String(favCount);
    if (histCountEl) histCountEl.textContent = histCount > 99 ? '99+' : String(histCount);

    tabsEl.querySelectorAll('.tm-bo-tab').forEach((tab) => {
      const active = tab.dataset.tab === state.tab;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    searchWrap.hidden = isHistory || favCount === 0;
    toolsEl.hidden = !isHistory;
    if (footEl) {
      footEl.textContent = isHistory
        ? 'Последние 30 · хранится в этом браузере'
        : 'Хранится в этом браузере';
    }
  }

  function renderList() {
    if (!listEl) return;
    renderTabs();
    listEl.textContent = '';

    if (state.tab === 'history') {
      if (!state.history.length) {
        listEl.append(historyEmptyNode());
        return;
      }
      const historyFrag = document.createDocumentFragment();
      for (const item of state.history) historyFrag.append(historyItemNode(item));
      listEl.append(historyFrag);
      return;
    }

    const all = sortedItems();
    const q = state.filter.trim().toLowerCase();
    const items = q
      ? all.filter((it) => (it.title + ' ' + it.author + ' ' + it.excerpt).toLowerCase().includes(q))
      : all;

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
      .tm-bo-empty__star .tm-bo-star-svg path {
        fill: currentColor;
      }

      .tm-bo-clock-svg path,
      .tm-bo-clock-svg polyline {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linejoin: round;
        stroke-linecap: round;
      }
      .tm-bo-top .tm-bo-clock-svg path,
      .tm-bo-top .tm-bo-clock-svg polyline { stroke-width: 1.8; }

      /* вкладки панели */
      .tm-bo-tabs { display: flex; align-items: center; gap: 4px; min-width: 0; }
      .tm-bo-tab {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        height: 34px;
        padding: 0 10px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--var-color-text-secondary, #8c8c8c);
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: background .15s ease, color .15s ease;
        -webkit-tap-highlight-color: transparent;
      }
      .tm-bo-tab:hover { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--var-color-text-primary, #f1f1f1); }
      .tm-bo-tab.is-active { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); color: var(--var-color-text-primary, #f1f1f1); }
      .tm-bo-tab .tm-bo-star-svg path { fill: currentColor; }
      .tm-bo-tab .tm-bo-panel__count { min-width: 20px; height: 20px; font-size: 11px; }

      /* инструменты истории */
      .tm-bo-panel__tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 18px 2px;
        flex: 0 0 auto;
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 12px;
      }
      .tm-bo-panel__search[hidden],
      .tm-bo-panel__tools[hidden] { display: none; }
      .tm-bo-panel__clear {
        border: 0;
        padding: 4px 8px;
        border-radius: 8px;
        background: transparent;
        color: var(--color-brand, #f15f2c);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .tm-bo-panel__clear:hover { background: var(--var-color-chip-bg, rgba(127,127,127,.14)); }

      /* бейдж «видео» */
      .tm-bo-item__badge {
        display: inline-flex;
        align-self: flex-start;
        margin-top: 6px;
        padding: 2px 7px;
        border-radius: 7px;
        background: var(--var-color-chip-bg, rgba(127,127,127,.14));
        color: var(--var-color-text-secondary, #8c8c8c);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .01em;
      }
      .tm-bo-item__remove_text { font-size: 18px; line-height: 1; color: var(--var-color-text-secondary, #8c8c8c); }
      .tm-bo-item__remove_text:hover { color: var(--var-color-text-primary, #f1f1f1); }
      .tm-bo-empty__clock { color: var(--var-color-text-secondary, #8c8c8c); opacity: .5; margin-bottom: 14px; }

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
        background: var(--var-color-chip-bg, rgba(127,127,127,.14));
        color: var(--var-color-text-primary, #f1f1f1);
        cursor: pointer;
        flex: 0 0 auto;
        transition: background .15s ease, color .15s ease;
        -webkit-tap-highlight-color: transparent;
      }
      // звезда в шапке — та же обводка, что у иконок уведомлений и сообщений
      .tm-bo-top .tm-bo-star-svg path { stroke-width: 1.8; }
      .tm-bo-top:hover { background: var(--var-color-chip-bg-hover, rgba(127,127,127,.2)); color: var(--color-brand, #f15f2c); }
      .tm-bo-top.is-open { background: var(--var-color-chip-bg-hover, rgba(127,127,127,.2)); color: var(--color-brand, #f15f2c); }

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
    onUrlChange();
    injectStyles();
    ensureTopButtons();
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

    const stored = readStore(localStorage);
    state.items = stored.items;
    state.history = stored.history;
    if (!localStorage.getItem(STORE_KEY)) save();

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
      const stored = readStore(localStorage);
      state.items = stored.items;
      state.history = stored.history;
      syncUI();
    });

    console.log('[Boosty Plus] запущен');
  }

  if (typeof document === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = {
      normalizeStore, readStore, saveStore,
      parsePostPath, cleanTitle, relativeViewedAt,
      buildHistoryEntry, upsertHistory, removeHistoryEntry,
      STORE_KEY, LEGACY_STORE_KEY, HISTORY_LIMIT
    };
  } else {
    init();
  }
})();
