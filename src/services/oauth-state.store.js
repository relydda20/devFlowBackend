const TTL_MS = 5 * 60 * 1000;
const store = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.createdAt > TTL_MS) store.delete(k);
  }
}

export function set(state, value) {
  sweep();
  store.set(state, { ...value, createdAt: Date.now() });
}

export function consume(state) {
  sweep();
  const v = store.get(state);
  if (!v) return null;
  store.delete(state);
  return v;
}
