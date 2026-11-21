const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeStore, readStore, saveStore,
  parsePostPath, cleanTitle, relativeViewedAt,
  buildHistoryEntry, upsertHistory, removeHistoryEntry,
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
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, viewedAt: 30 - i }));
  const out = upsertHistory(many, { id: 'new', viewedAt: 100 });
  assert.equal(out.length, 30);
  assert.equal(out[0].id, 'new');
  assert.equal(out.some((x) => x.id === 'p29'), false);
});

test('removeHistoryEntry: убирает только совпавший id', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(removeHistoryEntry(list, 'a'), [{ id: 'b' }]);
});
