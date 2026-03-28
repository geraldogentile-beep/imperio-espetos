import { useState, useEffect } from "react";
import PainelPedidos from "./PainelPedidos.jsx";

function getPins() {
  try {
    const saved = localStorage.getItem("imperio_pins");
    return saved ? JSON.parse(saved) : { dono: "9999", garcom: "1234", caixa: "5678" };
  } catch { return { dono: "9999", garcom: "1234", caixa: "5678" }; }
}
function savePins(pins) {
  try { localStorage.setItem("imperio_pins", JSON.stringify(pins)); } catch {}
}

function TelaLogin({ onLogin }) {
  const [pin, setPin] = useState("");
  const [erro, setErro] = useState(false);

  function digitar(n) {
    if (pin.length >= 4) return;
    const novo = pin + n;
    setPin(novo);
    setErro(false);
    if (novo.length === 4) {
      setTimeout(() => {
        const pins = getPins();
        if (novo === pins.dono)        onLogin("dono");
        else if (novo === pins.garcom) onLogin("garcom");
        else if (novo === pins.caixa)  onLogin("caixa");
        else { setErro(true); setPin(""); }
      }, 200);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#6b1c0e,#3d0a04)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Segoe UI', sans-serif", padding: 20 }}>
      <div style={{ fontSize: 64, marginBottom: 8 }}>👑</div>
      <div style={{ color: "#fff", fontWeight: 800, fontSize: 24, marginBottom: 4 }}>Império dos Espetos</div>
      <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, marginBottom: 36 }}>Digite seu PIN para entrar</div>

      {/* Pontos */}
      <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{ width: 18, height: 18, borderRadius: "50%", background: i < pin.length ? "#f0c040" : "rgba(255,255,255,0.2)", transition: "background 0.15s", boxShadow: i < pin.length ? "0 0 8px #f0c040" : "none" }} />
        ))}
      </div>

      {erro
        ? <div style={{ color: "#fca5a5", fontSize: 13, fontWeight: 600, marginBottom: 16, height: 20 }}>❌ PIN incorreto. Tente novamente.</div>
        : <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 16, height: 20 }}>{pin.length > 0 ? "•".repeat(pin.length) + "○".repeat(4 - pin.length) : "Digite 4 dígitos"}</div>
      }

      {/* Teclado */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, width: 250, marginBottom: 20 }}>
        {[1,2,3,4,5,6,7,8,9].map(n => (
          <button key={n} onClick={() => digitar(String(n))} style={{ height: 68, borderRadius: 16, border: "none", background: "rgba(255,255,255,0.12)", fontSize: 26, fontWeight: 700, color: "#fff", cursor: "pointer", backdropFilter: "blur(10px)", transition: "background 0.1s" }}
            onMouseDown={e => e.currentTarget.style.background = "rgba(255,255,255,0.25)"}
            onMouseUp={e => e.currentTarget.style.background = "rgba(255,255,255,0.12)"}
          >{n}</button>
        ))}
        <div />
        <button onClick={() => digitar("0")} style={{ height: 68, borderRadius: 16, border: "none", background: "rgba(255,255,255,0.12)", fontSize: 26, fontWeight: 700, color: "#fff", cursor: "pointer" }}>0</button>
        <button onClick={() => setPin(p => p.slice(0,-1))} style={{ height: 68, borderRadius: 16, border: "none", background: "rgba(255,255,255,0.08)", fontSize: 22, color: "rgba(255,255,255,0.7)", cursor: "pointer" }}>⌫</button>
      </div>

      {/* Dica de perfis */}

    </div>
  );
}

export default function App() {
  const [perfil, setPerfil] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
      setShowInstall(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function instalarApp() {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") setShowInstall(false);
  }

  if (!perfil) return (
    <>
      <TelaLogin onLogin={setPerfil} />
      {showInstall && (
        <div style={{ position: "fixed", bottom: 20, left: 16, right: 16, background: "#fff", borderRadius: 16, padding: "14px 16px", boxShadow: "0 8px 30px rgba(0,0,0,0.2)", display: "flex", alignItems: "center", gap: 12, zIndex: 999, fontFamily: "'Segoe UI', sans-serif" }}>
          <div style={{ fontSize: 32 }}>👑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: "#1a1a1a" }}>Instalar o app</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Adicione à tela inicial para acesso rápido</div>
          </div>
          <button onClick={instalarApp} style={{ background: "linear-gradient(135deg,#6b1c0e,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Instalar</button>
          <button onClick={() => setShowInstall(false)} style={{ background: "none", border: "none", color: "#ccc", fontSize: 20, cursor: "pointer", padding: 0 }}>×</button>
        </div>
      )}
    </>
  );

  // Garçom e Caixa vão direto para o salão
  if (perfil === "garcom" || perfil === "caixa") {
    return <PainelPedidos abrirSalao={perfil} onSair={() => setPerfil(null)} />;
  }

  // Dono vê o painel completo
  return <PainelPedidos onSair={() => setPerfil(null)} />;
}
