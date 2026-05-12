function loadAdminSet() {
  const raw = process.env.ADMIN_USER_IDS;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function isAdmin(userId) {
  if (!userId) return false;
  return loadAdminSet().has(userId);
}
