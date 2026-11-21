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
