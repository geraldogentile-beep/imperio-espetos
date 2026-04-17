// ── AUTH HELPERS (compartilhado entre App e PainelPedidos) ───

export function getToken() { return sessionStorage.getItem("imperio_token"); }
export function setToken(token) { sessionStorage.setItem("imperio_token", token); }
export function clearToken() { sessionStorage.removeItem("imperio_token"); sessionStorage.removeItem("imperio_login"); }
export function getSavedLogin() {
  try { const s = sessionStorage.getItem("imperio_login"); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function saveLogin(login) { sessionStorage.setItem("imperio_login", JSON.stringify(login)); }

export function authHeaders() {
  const token = getToken();
  return token ? { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } : { "Content-Type": "application/json" };
}

export async function authFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...opts.headers } });
  if (res.status === 401) { clearToken(); window.location.reload(); }
  return res;
}
