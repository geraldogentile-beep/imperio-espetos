import { useState, useEffect } from "react";
import PainelPedidos from "./PainelPedidos.jsx";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

// ── TEMA GLOBAL ───────────────────────────────────────────────
const T = {
  cream:   "#FAFAF8",
  wine:    "#8B2635",
  wineD:   "#6B1A28",
  wineL:   "#F5E8EA",
  amber:   "#D4842A",
  amberL:  "#FDF3E7",
  gray:    "#6B6560",
  grayL:   "#F2F1EF",
  grayLL:  "#F8F7F5",
  dark:    "#1C1917",
  white:   "#FFFFFF",
  green:   "#2D7A4F",
  greenL:  "#E8F5EE",
  red:     "#C0392B",
  redL:    "#FEE8E6",
  shadow:  "0 2px 16px rgba(28,25,23,0.08)",
  shadowM: "0 4px 24px rgba(28,25,23,0.12)",
  radius:  "16px",
  radiusS: "10px",
  radiusL: "24px",
};

function getPins() {
  try {
    const saved = localStorage.getItem("imperio_pins");
    return saved ? JSON.parse(saved) : { dono: "9999", caixa: "5678" };
  } catch { return { dono: "9999", caixa: "5678" }; }
}

function TelaLogin({ onLogin }) {
  const [pin, setPin] = useState("");
  const [erro, setErro] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msgErro, setMsgErro] = useState("❌ PIN incorreto. Tente novamente.");

  async function verificarPin(novoPin) {
    setLoading(true);
    const pins = getPins();

    // Verifica dono
    if (novoPin === pins.dono) { onLogin({ role: "dono" }); return; }
    // Verifica caixa
    if (novoPin === pins.caixa) { onLogin({ role: "caixa" }); return; }

    // Verifica garçom no backend
    try {
      const res = await fetch(BACKEND_URL + "/garcons/verificar-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: novoPin }),
      });
      if (res.ok) {
        const garcom = await res.json();
        onLogin({ role: "garcom", nome: garcom.nome, id: garcom.id });
        return;
      }
    } catch {}

    // PIN não encontrado
    setMsgErro("❌ PIN incorreto. Tente novamente.");
    setErro(true);
    setPin("");
    setLoading(false);
  }

  function digitar(n) {
    if (pin.length >= 4 || loading) return;
    const novo = pin + n;
    setPin(novo);
    setErro(false);
    if (novo.length === 4) {
      setTimeout(() => verificarPin(novo), 300);
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: `linear-gradient(160deg, ${T.wineD} 0%, ${T.wine} 45%, #A93245 100%)`,
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      padding: 24, position: "relative", overflow: "hidden",
    }}>
      {/* Decorative circles */}
      <div style={{ position:"absolute", top:-80, right:-80, width:300, height:300, borderRadius:"50%", background:"rgba(255,255,255,0.04)" }} />
      <div style={{ position:"absolute", bottom:-60, left:-60, width:200, height:200, borderRadius:"50%", background:"rgba(255,255,255,0.03)" }} />
      <div style={{ position:"absolute", top:"30%", left:-40, width:120, height:120, borderRadius:"50%", background:"rgba(212,132,42,0.15)" }} />

      {/* Logo card */}
      <div style={{
        background: "rgba(255,255,255,0.1)",
        backdropFilter: "blur(20px)",
        borderRadius: T.radiusL,
        padding: "32px 40px",
        textAlign: "center",
        marginBottom: 32,
        border: "1px solid rgba(255,255,255,0.15)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>👑</div>
        <div style={{ color: T.white, fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 26, letterSpacing: "-0.5px" }}>
          Império dos Espetos
        </div>
        <div style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, marginTop: 4, letterSpacing: 2, textTransform: "uppercase" }}>
          Sistema de Gestão
        </div>
      </div>

      {/* PIN dots */}
      <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            width: 14, height: 14, borderRadius: "50%",
            background: i < pin.length ? T.amber : "rgba(255,255,255,0.2)",
            transition: "all 0.2s",
            boxShadow: i < pin.length ? `0 0 12px ${T.amber}80` : "none",
            transform: i < pin.length ? "scale(1.2)" : "scale(1)",
          }} />
        ))}
      </div>

      <div style={{ height: 20, marginBottom: 20, fontSize: 13, color: erro ? "#FFB3B3" : "rgba(255,255,255,0.4)", fontWeight: erro ? 600 : 400 }}>
        {erro ? msgErro : loading ? "Verificando..." : pin.length > 0 ? "•".repeat(pin.length) + "○".repeat(4-pin.length) : ""}
      </div>

      {/* Keypad */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, width: 260 }}>
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <button key={n} onClick={() => digitar(String(n))} disabled={loading} style={{
            height: 64, borderRadius: T.radius,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.08)",
            fontSize: 24, fontWeight: 600, color: T.white,
            cursor: "pointer", transition: "all 0.15s",
            backdropFilter: "blur(10px)",
            fontFamily: "'DM Sans', sans-serif",
            opacity: loading ? 0.5 : 1,
          }}
          onMouseEnter={e => { if(!loading){ e.currentTarget.style.background = "rgba(255,255,255,0.18)"; e.currentTarget.style.transform = "scale(1.04)"; }}}
          onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.transform = "scale(1)"; }}
          >{n}</button>
        ))}
        <div />
        <button onClick={() => digitar("0")} disabled={loading} style={{
          height: 64, borderRadius: T.radius,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,255,255,0.08)",
          fontSize: 24, fontWeight: 600, color: T.white,
          cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
          opacity: loading ? 0.5 : 1,
        }}>0</button>
        <button onClick={() => setPin(p => p.slice(0,-1))} disabled={loading} style={{
          height: 64, borderRadius: T.radius,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(255,255,255,0.04)",
          fontSize: 20, color: "rgba(255,255,255,0.6)",
          cursor: "pointer",
        }}>⌫</button>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap');
      `}</style>
    </div>
  );
}

export default function App() {
  // login = null | { role: "dono"|"garcom"|"caixa", nome?: string, id?: string }
  const [login, setLogin] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstall(true); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function instalarApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") setShowInstall(false);
  }

  if (!login) return (
    <>
      <TelaLogin onLogin={setLogin} />
      {showInstall && (
        <div style={{
          position: "fixed", bottom: 20, left: 16, right: 16,
          background: T.white, borderRadius: T.radius,
          padding: "14px 16px", boxShadow: T.shadowM,
          display: "flex", alignItems: "center", gap: 12,
          zIndex: 999, fontFamily: "'DM Sans', sans-serif",
          border: `1px solid ${T.grayL}`,
        }}>
          <div style={{ fontSize: 28 }}>👑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: T.dark }}>Instalar o app</div>
            <div style={{ fontSize: 12, color: T.gray, marginTop: 2 }}>Adicione à tela inicial para acesso rápido</div>
          </div>
          <button onClick={instalarApp} style={{ background: `linear-gradient(135deg,${T.wineD},${T.wine})`, color: T.white, border: "none", borderRadius: T.radiusS, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Instalar</button>
          <button onClick={() => setShowInstall(false)} style={{ background: "none", border: "none", color: T.gray, fontSize: 20, cursor: "pointer", padding: 0 }}>×</button>
        </div>
      )}
    </>
  );

  // Garçom e caixa vão direto para o salão
  if (login.role === "garcom" || login.role === "caixa") {
    return (
      <PainelPedidos
        abrirSalao={login.role}
        garcomLogado={login.role === "garcom" ? { nome: login.nome, id: login.id } : null}
        onSair={() => setLogin(null)}
      />
    );
  }

  return <PainelPedidos onSair={() => setLogin(null)} />;
}
