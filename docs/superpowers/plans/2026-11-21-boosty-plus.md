# Boosty Plus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переименовать `Boosty_Favorites` в `Boosty_Plus` и добавить раздел «История» — последние 30 открытых постов и видео Boosty.

**Architecture:** Один userscript-файл. Чистая логика (хранилище, модель истории, форматирование) вынесена в функции и тестируется через `node:test`; DOM-часть (кнопки, вкладки, перехват SPA-переходов) проверяется локальным стендом и публичной страницей Boosty. Одна панель с вкладками «Избранное» и «История», две кнопки в шапке.

**Tech Stack:** Vanilla JS (ES2019), `node:test` + `node:assert/strict` (Node 24), PowerShell, in-app browser.

**Spec:** `docs/superpowers/specs/2026-11-21-boosty-plus-design.md`

## Global Constraints

- Репозиторий: `ddyakovlev1/Tampermonkey_Skript_Set`; ветка `boosty-plus`, PR в `main`.
- Локальная копия: `C:\Users\Danil\AppData\Local\Temp\opencode\boosty-plus-work\Tampermonkey_Skript_Set-main`.
- Один файл скрипта, без сборки и зависимостей; тесты — только встроенный `node:test`.
- `@version 2.0.0`, `@name Boosty Plus`, `@namespace danil.boosty.plus`, файл `Boosty_Plus/boosty-plus.user.js`.
- `@updateURL`/`@downloadURL`: `https://raw.githubusercontent.com/ddyakovlev1/tampermonkey_skript_set/main/Boosty_Plus/boosty-plus.user.js`.
- Ключи хранилища: новый `tm-boosty-plus`, старый `tm-boosty-favorites` (только чтение при первом запуске).
- `HISTORY_LIMIT = 30`; история — массив, свежие сверху, без дублей по `id`.
- Интерфейс, README и сообщения коммитов — на русском.
- Избранное работает как раньше; меняется только слой хранения.
- Коммиты — через GitHub MCP (`push_files`/`delete_file`), локального git нет.
- Каждый шаг с командой заканчивается проверкой её вывода; без «должно работать».

## Review Focus

1. **SPA-переходы.** Открытие поста из ленты, «назад», повторное открытие — ровно одна запись на пост, повторный просмотр поднимает её наверх.
2. **Перенос избранного.** После переименования старые закладки не теряются; оба старых формата (`{v:1, items}` и словарь) читаются, битый JSON не роняет скрипт.
3. **Поздний или неполный DOM.** Закрытый/медленный пост без h1, обложки или автора всё равно даёт запись с URL и заголовком-фолбэком; не-постовые страницы не пишутся.
4. **Лимит и дубли при быстрых переходах.** 31-й пост вытесняет самый старый, повторный вход не создаёт второй записи и не сдвигает чужие.
5. **Видео.** Видео-пост получает бейдж «видео» и обновлённое время; текстовый пост без плеера остаётся постом.

---

### Task 1: Переименование, тестируемая структура и хранилище v2

**Files:**
- Create: `Boosty_Plus/boosty-plus.user.js`
- Create: `Boosty_Plus/tests/boosty-plus.test.js`
- Create: `Boosty_Plus/README.md` (заглушка, полный текст — в Task 5)
- Delete: `Boosty_Favorites/boosty-favorites.user.js`, `Boosty_Favorites/README.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `normalizeStore(newRaw: string|null, oldRaw: string|null) -> { items: Record<string, object>, history: object[] }`
- Produces: `readStore(storage: { getItem(key: string): string|null }) -> { items, history }`
- Produces: `saveStore(storage: { setItem(key: string, value: string): void }, items, history) -> void`
- Produces: `STORE_KEY = 'tm-boosty-plus'`, `LEGACY_STORE_KEY = 'tm-boosty-favorites'`, `HISTORY_LIMIT = 30`
- Consumes: текущие `load()`, `save()`, `state.items` из `Boosty_Favorites/boosty-favorites.user.js`

- [ ] **Step 1: Скопировать скрипт в новую папку и заменить шапку**

Run:
```powershell
New-Item -ItemType Directory -Force "Boosty_Plus\tests" | Out-Null
Copy-Item "Boosty_Favorites\boosty-favorites.user.js" "Boosty_Plus\boosty-plus.user.js"
```

Заменить мета-блок на:
```js
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
```

- [ ] **Step 2: Сделать файл загружаемым в Node и добавить тестовый экспорт**

В начале IIFE оставить только константы и функции; `state` инициализировать пустыми:
```js
const state = { items: {}, history: [], filter: '', tab: 'favorites', open: false, lastFocus: null };
```
Данные подтягивать в `init()`.

В конце IIFE, после `init();`, заменить вызов на:
```js
  if (typeof document === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = {
      normalizeStore, readStore, saveStore,
      STORE_KEY, LEGACY_STORE_KEY, HISTORY_LIMIT
    };
  } else {
    init();
  }
```

- [ ] **Step 3: Написать падающие тесты хранилища**

Создать `Boosty_Plus/tests/boosty-plus.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStore, readStore, saveStore,
  STORE_KEY, LEGACY_STORE_KEY, HISTORY_LIMIT
} = require('../boosty-plus.user.js');

test('normalizeStore: пустое хранилище', () => {
  assert.deepEqual(normalizeStore(null, null), { items: {}, history: [] });
});

test('normalizeStore: новый формат', () => {
  const raw = JSON.stringify({ v: 1, items: { a: { id: 'a' } }, history: [{ id: 'h', url: 'u', viewedAt: 2 }] });
  assert.deepEqual(normalizeStore(raw, null), { items: { a: { id: 'a' } }, history: [{ id: 'h', url: 'u', viewedAt: 2 }] });
});

test('normalizeStore: перенос избранного из старого ключа', () => {
  const old = JSON.stringify({ v: 1, items: { a: { id: 'a' } } });
  assert.deepEqual(normalizeStore(null, old), { items: { a: { id: 'a' } }, history: [] });
});

test('normalizeStore: старый формат-словарь', () => {
  const old = JSON.stringify({ a: { id: 'a' } });
  assert.deepEqual(normalizeStore(null, old).items, { a: { id: 'a' } });
});

test('normalizeStore: битый JSON не роняет', () => {
  assert.deepEqual(normalizeStore('{', '{'), { items: {}, history: [] });
});

test('normalizeStore: новый ключ важнее старого', () => {
  const nw = JSON.stringify({ v: 1, items: { n: { id: 'n' } }, history: [] });
  const old = JSON.stringify({ v: 1, items: { o: { id: 'o' } } });
  assert.deepEqual(Object.keys(normalizeStore(nw, old).items), ['n']);
});

test('normalizeStore: история сортируется, дедуплицируется и обрезается', () => {
  const history = Array.from({ length: 35 }, (_, i) => ({ id: 'p' + i, url: 'u' + i, viewedAt: i }));
  history.push({ id: 'p34', url: 'u34', viewedAt: 99 });
  const out = normalizeStore(JSON.stringify({ v: 1, items: {}, history }), null).history;
  assert.equal(out.length, HISTORY_LIMIT);
  assert.equal(out[0].id, 'p34');
  assert.equal(out.filter((x) => x.id === 'p34').length, 1);
});

test('readStore: новый ключ важнее старого', () => {
  const map = new Map([
    [STORE_KEY, JSON.stringify({ v: 1, items: { n: { id: 'n' } }, history: [] })],
    [LEGACY_STORE_KEY, JSON.stringify({ v: 1, items: { o: { id: 'o' } } })]
  ]);
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null) };
  assert.deepEqual(Object.keys(readStore(storage).items), ['n']);
});

test('saveStore: пишет оба раздела в новый ключ', () => {
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) };
  saveStore(storage, { a: { id: 'a' } }, [{ id: 'h', url: 'u', viewedAt: 1 }]);
  assert.deepEqual(JSON.parse(map.get(STORE_KEY)), {
    v: 1, items: { a: { id: 'a' } }, history: [{ id: 'h', url: 'u', viewedAt: 1 }]
  });
});
```

- [ ] **Step 4: Убедиться, что тесты падают**

Run:
```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
```
Expected: FAIL, `normalizeStore is not a function` (экспорт ещё не добавлен или функции нет).

- [ ] **Step 5: Реализовать хранилище**

- `parseJson(raw)` — `JSON.parse` в `try/catch`, пустая строка и ошибка → `null`.
- `normalizeStore`: если новый JSON — объект, взять `items` (или `favorites`), `history`; иначе, если старый — объект, взять `old.items` или сам объект как словарь. История проходит `sanitizeHistory`: оставить объекты со строковыми `id` и `url`, отсортировать по `viewedAt` убыв., убрать дубли по `id`, обрезать до `HISTORY_LIMIT`.
- `readStore(storage)` — `normalizeStore(storage.getItem(STORE_KEY), storage.getItem(LEGACY_STORE_KEY))`.
- `saveStore(storage, items, history)` — `storage.setItem(STORE_KEY, JSON.stringify({ v: 1, items, history }))` в `try/catch`.
- В `init()`: `const stored = readStore(localStorage); state.items = stored.items; state.history = stored.history;`
- `load()`/`save()` заменить на обёртки над `readStore`/`saveStore`, чтобы остальной код не менялся.

- [ ] **Step 6: Прогнать тесты и синтаксис**

Run:
```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
node --check Boosty_Plus\boosty-plus.user.js
```
Expected: все тесты PASS, `node --check` без вывода.

- [ ] **Step 7: Обновить README**

- В корневом `README.md` заменить строку `Boosty_Favorites` на `Boosty_Plus`, описание — «Звёздочка у постов, избранное и история просмотров», ссылка — на `Boosty_Plus/boosty-plus.user.js`.
- Создать `Boosty_Plus/README.md`: заголовок «Boosty_Plus», одна строка о скрипте, ссылка на установку `boosty-plus.user.js`. Полный текст — Task 5.

- [ ] **Step 8: Запушить задачу в ветку и удалить старую папку**

Run (MCP):
```js
create_branch({ owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus', from_branch: 'main' })
push_files({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus',
  message: 'Boosty Plus: переименование и хранилище с историей',
  files: [
    'Boosty_Plus/boosty-plus.user.js',
    'Boosty_Plus/tests/boosty-plus.test.js',
    'Boosty_Plus/README.md',
    'README.md'
  ]
})
delete_file({ owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus', path: 'Boosty_Favorites/boosty-favorites.user.js', message: 'Boosty Plus: удалить старый скрипт' })
delete_file({ owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus', path: 'Boosty_Favorites/README.md', message: 'Boosty Plus: удалить старый README' })
```

---

### Task 2: Модель истории

**Files:**
- Modify: `Boosty_Plus/boosty-plus.user.js`
- Modify: `Boosty_Plus/tests/boosty-plus.test.js`

**Interfaces:**
- Produces: `parsePostPath(pathname: string) -> { slug: string, id: string } | null`
- Produces: `cleanTitle(raw: string, author?: string) -> string`
- Produces: `relativeViewedAt(ts: number, now?: number) -> string`
- Produces: `buildHistoryEntry(input: { origin, id, path, title?, author?, authorUrl?, avatar?, image?, date?, type?, viewedAt? }) -> object`
- Produces: `upsertHistory(list: object[], entry: object, limit?: number) -> object[]`
- Produces: `removeHistoryEntry(list: object[], id: string) -> object[]`
- Consumes: `HISTORY_LIMIT` из Task 1

- [ ] **Step 1: Написать падающие тесты модели**

Добавить в `boosty-plus.test.js`:
```js
const {
  parsePostPath, cleanTitle, relativeViewedAt,
  buildHistoryEntry, upsertHistory, removeHistoryEntry
} = require('../boosty-plus.user.js');

test('parsePostPath: страница поста и мусор', () => {
  assert.deepEqual(parsePostPath('/blog/posts/123e4567-e89b-12d3-a456-426614174000'), {
    slug: 'blog', id: '123e4567-e89b-12d3-a456-426614174000'
  });
  assert.deepEqual(parsePostPath('/blog/posts/123e4567-e89b-12d3-a456-426614174000/'), {
    slug: 'blog', id: '123e4567-e89b-12d3-a456-426614174000'
  });
  assert.equal(parsePostPath('/blog'), null);
  assert.equal(parsePostPath('/blog/posts/123e4567-e89b-12d3-a456-426614174000/comments'), null);
});

test('cleanTitle: убирает хвосты автора и Boosty', () => {
  assert.equal(cleanTitle('Пост - Автор', 'Автор'), 'Пост');
  assert.equal(cleanTitle('Пост - Boosty'), 'Пост');
  assert.equal(cleanTitle('  Пост | Boosty  '), 'Пост');
  assert.equal(cleanTitle('  Пост  '), 'Пост');
});

test('relativeViewedAt: сегодня, вчера, дата', () => {
  const now = new Date(2026, 10, 21, 15, 0).getTime();
  assert.equal(relativeViewedAt(new Date(2026, 10, 21, 14, 5).getTime(), now), 'сегодня, 14:05');
  assert.equal(relativeViewedAt(new Date(2026, 10, 20, 9, 30).getTime(), now), 'вчера, 09:30');
  assert.equal(relativeViewedAt(new Date(2026, 2, 5, 12, 0).getTime(), now), '5 мар');
  assert.equal(relativeViewedAt(new Date(2024, 2, 5, 12, 0).getTime(), now), '5 мар 2024');
});

test('buildHistoryEntry: значения по умолчанию и нормализация', () => {
  const entry = buildHistoryEntry({
    origin: 'https://boosty.to', id: 'p1', path: '/blog/posts/p1',
    title: '  Заголовок  ', author: ' Автор ', viewedAt: 10
  });
  assert.equal(entry.url, 'https://boosty.to/blog/posts/p1');
  assert.equal(entry.title, 'Заголовок');
  assert.equal(entry.author, 'Автор');
  assert.equal(entry.type, 'post');
  assert.equal(entry.viewedAt, 10);
  assert.equal(buildHistoryEntry({ origin: 'https://boosty.to', id: 'p2', path: '/blog/posts/p2', viewedAt: 1 }).title, 'Пост');
  assert.equal(buildHistoryEntry({ origin: 'https://boosty.to', id: 'p3', path: '/blog/posts/p3', type: 'video', viewedAt: 1 }).type, 'video');
});

test('upsertHistory: наверх, без дублей, с лимитом', () => {
  const list = [{ id: 'a', viewedAt: 1 }, { id: 'b', viewedAt: 2 }];
  assert.deepEqual(upsertHistory(list, { id: 'a', viewedAt: 3 }).map((x) => x.id), ['a', 'b']);
  assert.equal(upsertHistory(list, { id: 'a', viewedAt: 3 }).length, 2);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, viewedAt: i }));
  const out = upsertHistory(many, { id: 'new', viewedAt: 100 });
  assert.equal(out.length, 30);
  assert.equal(out[0].id, 'new');
  assert.equal(out.some((x) => x.id === 'p0'), false);
});

test('removeHistoryEntry: убирает только совпавший id', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(removeHistoryEntry(list, 'a'), [{ id: 'b' }]);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run:
```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
```
Expected: FAIL, `parsePostPath is not a function`.

- [ ] **Step 3: Реализовать функции**

- `POST_PAGE_RE = /^\/([^/]+)\/posts\/([0-9a-zA-Z-]{8,})\/?$/`; `parsePostPath` возвращает `{ slug, id }` или `null`.
- `cleanTitle`: `trim`, убрать хвост ` - ${author}` (если автор задан), затем ` - Boosty` и ` | Boosty`.
- `relativeViewedAt`: сравнить локальные год/месяц/день с `now`; сегодня/вчера — `сегодня, HH:MM` / `вчера, HH:MM`; тот же год — `D MMM`; иначе `D MMM YYYY`. Месяцы: `['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек']`. Невалидное время → `''`.
- `buildHistoryEntry`: обрезать строки, `url = origin + path`, `title` по умолчанию `'Пост'`, `type` только `'video'`/`'post'`, `viewedAt` по умолчанию `Date.now()`.
- `upsertHistory`: убрать запись с тем же `id`, вставить в начало, `slice(0, limit)`.
- `removeHistoryEntry`: `filter`.
- Добавить все функции в тестовый экспорт.

- [ ] **Step 4: Прогнать тесты**

Run:
```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
```
Expected: все тесты PASS.

- [ ] **Step 5: Запушить**

```js
push_files({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus',
  message: 'Boosty Plus: модель истории',
  files: ['Boosty_Plus/boosty-plus.user.js', 'Boosty_Plus/tests/boosty-plus.test.js']
})
```

---

### Task 3: Запись просмотров постов

**Files:**
- Modify: `Boosty_Plus/boosty-plus.user.js`
- Create (временный стенд, не коммитить): `C:\Users\Danil\AppData\Local\Temp\opencode\boosty-plus-work\harness\index.html`, `...\harness\serve.js`

**Interfaces:**
- Produces: `metaContent(property: string) -> string`
- Produces: `detectVideo(root: ParentNode) -> boolean`
- Produces: `currentPostEntry() -> object | null`
- Produces: `capturePostView() -> void`
- Produces: `onUrlChange() -> void`
- Produces: `watchVideoUpgrade(id: string, url: string) -> void`
- Consumes: `parsePostPath`, `buildHistoryEntry`, `upsertHistory`, `state.history`, `save()`

- [ ] **Step 1: Собрать локальный стенд**

`serve.js` — статический сервер на `http://localhost:4173`: любой путь отдаёт `index.html`, `/boosty-plus.user.js` — файл скрипта. `index.html` содержит:
- `<div class="TopMenu-scss--module_right"><button></button><button></button></div>`;
- `<meta property="og:title" content="Заголовок - Автор">`, `<meta property="og:image" content="https://example.com/cover.jpg">`;
- `#page` с лентой (`[data-post-id]` + `[class*="headerRightBlock"]`) и функцией `go(path)`, которая делает `history.pushState` и перерисовывает `#page` как страницу поста: `[data-post-id="<id>"]`, `h1[data-test-id="COMMON_POST_POSTCONTENT:TITLE"]`, `[data-test-id="COMMON_POST_POSTCONTENT:ROOT"]`, `[data-test-id="COMMON_CREATEDAT:ROOT"]`, `.AuthorCard-scss--module_root a[href="/blog"] img.AuthorCard-scss--module_avatar`, `h1.AuthorCard-scss--module_authorName`;
- `<script src="/boosty-plus.user.js"></script>`.

Запустить:
```powershell
node harness\serve.js
```

- [ ] **Step 2: Проверить, что запись ещё не работает**

В браузере открыть `http://localhost:4173/blog/posts/11111111-1111-1111-1111-111111111111`, очистить `localStorage`, перезагрузить. Ожидание: `JSON.parse(localStorage.getItem('tm-boosty-plus') || '{}').history` пуст или отсутствует. Это падающая проверка.

- [ ] **Step 3: Реализовать перехват**

- `metaContent(property)`: `document.querySelector('meta[property="' + property + '"]')` → `content`.
- `detectVideo(root)`: `root.querySelector('video, iframe[src*="ok.ru/video"], iframe[src*="vk.com/video"], iframe[src*="vkvideo"], iframe[src*="youtube.com/embed"], [class*="VideoPlayer"], [data-test-id*="VIDEO"]')` → `!!el`.
- `currentPostEntry()`:
  - `const info = parsePostPath(location.pathname); if (!info) return null;`
  - `post = document.querySelector('[data-post-id="' + info.id + '"]') || document.querySelector('[data-post-id]')`
  - заголовок: `h1[data-test-id="COMMON_POST_POSTCONTENT:TITLE"]`, фолбэк — `cleanTitle(metaContent('og:title'), author)`, затем `document.title`.
  - автор: ссылка `a[href="/' + info.slug + '"]` внутри `[class*="AuthorCard"]`; имя — `[class*="authorName"]` или текст ссылки; аватар — `img` в ссылке.
  - обложка: `metaContent('og:image')`, фолбэк — `firstImage(post)`.
  - дата: `[data-test-id="COMMON_CREATEDAT:ROOT"]`.
  - тип: `detectVideo(post || document)`.
  - вернуть `buildHistoryEntry({ origin: location.origin, id: info.id, path: location.pathname.replace(/\/$/, ''), ... })`.
- `capturePostView()`: получить запись; `state.history = upsertHistory(state.history, entry); save(); updateBadge(); if (state.open && state.tab === 'history') renderList();` затем `watchVideoUpgrade(entry.id, location.href)`.
- `onUrlChange()`: сравнить `location.href` с `lastUrl`; при изменении обновить `lastUrl` и, если `parsePostPath` не `null`, вызвать `capturePostView()`.
- `watchVideoUpgrade(id, url)`: до 20 попыток раз в 500 мс, пока `location.href === url`; при `detectVideo(document)` найти запись по `id`, если `type !== 'video'` — поставить `type = 'video'`, `viewedAt = Date.now()`, `state.history = upsertHistory(state.history, entry)`, `save()`, перерисовать.
- В `scan()` первым действием вызвать `onUrlChange()`; `lastUrl` инициализировать в `init()`.

- [ ] **Step 4: Проверить стенд**

Сценарий в браузере:
1. Открыть пост `1111…`, подождать 1 с → в `history` одна запись, `title` совпадает с h1.
2. `go('/blog/posts/2222…')` → две записи, первая `2222…`.
3. `go('/blog/posts/1111…')` → всё ещё две, первая `1111…`.
4. `go('/blog')` → количество не изменилось.
5. 31 переход по разным id → в `history` ровно 30, первый — последний открытый.
6. Пост с `<iframe src="https://ok.ru/videoembed/1">` → `type === 'video'`; пост без плеера → `type === 'post'`.
7. Пост без h1 и `og:title` → запись с заголовком «Пост» и корректным URL.

- [ ] **Step 5: Проверить на живом Boosty**

В браузере открыть публичный пост `https://boosty.to/boosty/posts/de1e6f32-3a80-4824-95bd-a264ff1b00aa`, выполнить скрипт через `Runtime.evaluate`, проверить `localStorage` → одна запись с заголовком «F.A.Q. Boosty — для новичков и не только». Повторно открыть пост из ленты → запись поднялась, дубля нет.

- [ ] **Step 6: Прогнать тесты и запушить**

```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
node --check Boosty_Plus\boosty-plus.user.js
```
```js
push_files({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus',
  message: 'Boosty Plus: запись просмотров постов',
  files: ['Boosty_Plus/boosty-plus.user.js']
})
```

---

### Task 4: Вкладки, кнопка-часы и список истории

**Files:**
- Modify: `Boosty_Plus/boosty-plus.user.js`
- Modify (временный стенд): `harness/index.html`

**Interfaces:**
- Produces: `clockSVG(size: number) -> string`
- Produces: `buildTopButton(kind: 'favorites'|'history') -> HTMLButtonElement`
- Produces: `ensureTopButtons() -> void`
- Produces: `renderTabs() -> void`
- Produces: `historyItemNode(item: object) -> HTMLElement`
- Produces: `historyEmptyNode() -> HTMLElement`
- Produces: `clearHistory() -> void`
- Produces: `removeHistoryItem(id: string) -> void`
- Consumes: `state.tab`, `state.history`, `relativeViewedAt`, `upsertHistory`, `removeHistoryEntry`

- [ ] **Step 1: Добавить проверки стенда (падающие)**

Проверить в браузере до реализации:
1. `.tm-bo-top` — две кнопки; у второй `data-tm-bo="history"`.
2. Клик по кнопке истории открывает панель, активна вкладка «История», видна запись.
3. У записи есть «×»; клик убирает её и показывает тост «Убрано из истории» с «Вернуть».
4. «Очистить» очищает список и показывает тост с «Вернуть».
5. На вкладке «Избранное» поиск виден, на «Истории» — скрыт.

Ожидание: проверки падают (кнопки истории и вкладок нет).

- [ ] **Step 2: Реализовать кнопку и вкладки**

- `clockSVG(size)` — часы со стрелкой против часовой: `<polyline points="1 4 1 10 7 10"/>`, `<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>`, `<path d="M12 7v5l3 2"/>`; класс `tm-bo-clock-svg`.
- `buildTopButton(kind)`: общая плашка `.tm-bo-top`, `data-tm-bo=kind`, иконка `starSVG(24)` или `clockSVG(24)`, `title`/`aria-label`; клик — `if (state.open && state.tab === kind) closePanel(); else openPanel(kind);`.
- `ensureTopButtons()`: создать обе; вставить избранное первым, историю — перед ним (итог: часы, звезда, колокольчик, чат); если React удалил — вернуть. `scan()` вызывает `ensureTopButtons()` вместо `ensureTopButton()`; глобалы — `topBtn` (избранное) и `historyBtn` (история).
- `updateBadge()`: обновлять title/aria обеих кнопок счётчиками.
- Панель: вместо заголовка — `role="tablist"` с двумя кнопками `.tm-bo-tab` (`data-tab`, счётчики `.tm-bo-panel__count`), `aria-selected`; закрытие справа. Счётчики хранить в `favCountEl` и `histCountEl`.
- `openPanel(tab = 'favorites')`: выставить `state.tab`, отрисовать вкладки и список.
- `renderTabs()`: активная вкладка, счётчики, видимость поиска (`favorites` и есть избранное) и панели инструментов (`history`), текст футера: «Хранится в этом браузере» для избранного, «Последние 30 · хранится в этом браузере» для истории.
- `renderList()`: ветка `favorites` — как сейчас; ветка `history` — `state.history`, пусто → `historyEmptyNode()`.

- [ ] **Step 3: Реализовать список истории**

- `historyItemNode(item)`: структура как у `itemNode`; миниатюра, заголовок, мета `автор · relativeViewedAt(item.viewedAt)`; бейдж `.tm-bo-item__badge` «видео» при `item.type === 'video'`; кнопка «×» с `aria-label="Убрать из истории"`; клик/Enter открывает `item.url`.
- `historyEmptyNode()`: часы 46, «Пока пусто», «Открой любой пост или видео на Boosty — он появится здесь.»
- Панель инструментов истории: «Последние 30» слева, кнопка «Очистить» справа.
- `removeHistoryItem(id)`: запомнить индекс и запись, `state.history = removeHistoryEntry(...)`, `save()`, `syncUI()`, тост «Убрано из истории» / «Вернуть» (вернуть на прежний индекс).
- `clearHistory()`: запомнить массив, очистить, `save()`, `syncUI()`, тост «История очищена» / «Вернуть».
- Стили: `.tm-bo-tabs`, `.tm-bo-tab` (активная — подчёркивание/плашка), `.tm-bo-panel__tools`, `.tm-bo-item__badge`, `.tm-bo-clock-svg path` (stroke `currentColor`, 1.6; в `.tm-bo-top` — 1.8), мобильная ширина без изменений.

- [ ] **Step 4: Проверить стенд и живой сайт**

Повторить проверки Step 1 — все проходят. На живом Boosty: две кнопки в шапке, панель открывается на нужной вкладке, запись открывается, «×» и «Очистить» работают, вёрстка ленты не сломана. Проверить ширину 390 px.

- [ ] **Step 5: Прогнать тесты и запушить**

```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
node --check Boosty_Plus\boosty-plus.user.js
```
```js
push_files({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus',
  message: 'Boosty Plus: вкладки и список истории',
  files: ['Boosty_Plus/boosty-plus.user.js']
})
```

---

### Task 5: README, финальная проверка и PR

**Files:**
- Modify: `Boosty_Plus/README.md`
- Modify: `README.md`
- Create: `docs/superpowers/specs/2026-11-21-boosty-plus-design.md`
- Create: `docs/superpowers/plans/2026-11-21-boosty-plus.md`

**Interfaces:**
- Consumes: всё предыдущее; новых функций нет.

- [ ] **Step 1: Дописать README**

`Boosty_Plus/README.md`: что делает (звезда, избранное, история 30, вкладки), установка по новому URL, как пользоваться (звезда, часы, вкладки, «×», «Очистить»), хранение в `localStorage`, перенос избранного, ограничения (браузер/профиль, закрытые посты не обходятся), как устроено (селекторы `data-post-id`, `COMMON_POST_POSTCONTENT:TITLE`, `AuthorCard`, og-мета), необходимость переустановки после переименования.

Корневой `README.md`: строка `Boosty_Plus` с новым описанием и ссылкой.

- [ ] **Step 2: Финальная проверка**

```powershell
node --test Boosty_Plus\tests\boosty-plus.test.js
node --check Boosty_Plus\boosty-plus.user.js
```
Проверить в браузере: публичный пост записывается; лента, блог, пост; две кнопки; обе вкладки; «×»/«Очистить»; 390 px; после перезагрузки данные на месте.

- [ ] **Step 3: Запушить README, спеку и план**

```js
push_files({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set', branch: 'boosty-plus',
  message: 'Boosty Plus: README, спека и план',
  files: [
    'Boosty_Plus/README.md',
    'README.md',
    'docs/superpowers/specs/2026-11-21-boosty-plus-design.md',
    'docs/superpowers/plans/2026-11-21-boosty-plus.md'
  ]
})
```

- [ ] **Step 4: Открыть PR**

```js
create_pull_request({
  owner: 'ddyakovlev1', repo: 'Tampermonkey_Skript_Set',
  base: 'main', head: 'boosty-plus',
  title: 'Boosty Plus: переименование и история просмотров',
  body: 'Переименовывает Boosty_Favorites в Boosty_Plus и добавляет историю последних 30 постов и видео. Избранное переносится из старого ключа. После мержа нужна переустановка скрипта по новому URL.'
})
```

- [ ] **Step 5: Сообщить результат**

Дать ссылку на PR, новый install-URL и напоминание: удалить старый скрипт в Tampermonkey и установить новый.
