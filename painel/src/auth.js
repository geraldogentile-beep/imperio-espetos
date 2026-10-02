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

// Login vencido: volta para a tela do PIN SEM recarregar a pagina. Recarregar
// fazia o Chrome esquecer a impressora Bluetooth do caixa (so voltava
// pareando de novo); sem recarregar, a impressora continua conectada.
export const EVENTO_SESSAO_EXPIRADA = "imperio:sessao-expirada";

export async function authFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...opts.headers } });
  if (res.status === 401 && getToken()) {
    clearToken();
    window.dispatchEvent(new Event(EVENTO_SESSAO_EXPIRADA));
  }
  return res;
}

// Enquanto o app esta aberto, troca o token por um novo de tempos em tempos,
// para o login nao vencer no meio do servico.
export async function renovarToken(backendUrl) {
  if (!getToken()) return false;
  try {
    const res = await fetch(backendUrl + "/auth/renovar", { method: "POST", headers: authHeaders() });
    if (!res.ok) return false;   // 404: servidor ainda sem a rota; 401: ja venceu
    const { token } = await res.json();
    if (token && getToken()) setToken(token);
    return true;
  } catch { return false; }
}
