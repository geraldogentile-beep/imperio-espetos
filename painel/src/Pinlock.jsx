import { useState, useEffect } from "react";

const PIN_CORRETO = "1234"; // PIN padrão — trocar nas configurações
const PIN_STORAGE_KEY = "imperio_pin_auth";
const PIN_EXPIRY_HOURS = 8; // horas que fica logado sem pedir PIN de novo
const MAX_TENTATIVAS = 3;
const BLOQUEIO_SEGUNDOS = 30;

export default function PinLock({ onUnlock, pinConfigurado }) {
  const pin = pinConfigurado || PIN_CORRETO;
  const [digitado, setDigitado] = useState([]);
  const [erro, setErro] = useState(false);
  const [tentativas, setTentativas] = useState(0);
  const [bloqueado, setBloqueado] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [shake, setShake] = useState(false);

  // Verifica se já está autenticado (sessão salva)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PIN_STORAGE_KEY);
      if (saved) {
        const { timestamp } = JSON.parse(saved);
        const horasPassadas = (Date.now() - timestamp) / (1000 * 60 * 60);
        if (horasPassadas < PIN_EXPIRY_HOURS) {
          onUnlock();
          return;
        }
        localStorage.removeItem(PIN_STORAGE_KEY);
      }
    } catch {}
  }, []);

  // Countdown de bloqueio
  useEffect(() => {
    if (bloqueado && countdown > 0) {
      const t = setTimeout(() => setCountdown(c => c - 1), 1000);
      return () => clearTimeout(t);
    }
    if (bloqueado && countdown === 0) {
      setBloqueado(false);
      setTentativas(0);
    }
  }, [bloqueado, countdown]);

  function pressDigit(d) {
    if (bloqueado || digitado.length >= 4) return;
    const novo = [...digitado, d];
    setDigitado(novo);
    setErro(false);

    if (novo.length === 4) {
      setTimeout(() => verificarPin(novo), 100);
    }
  }

  function verificarPin(digits) {
    if (digits.join("") === pin) {
      // Salva sessão
      try {
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({ timestamp: Date.now() }));
      } catch {}
      onUnlock();
    } else {
      const novasTentativas = tentativas + 1;
      setTentativas(novasTentativas);
      setErro(true);
      setShake(true);
      setTimeout(() => { setShake(false); setDigitado([]); setErro(false); }, 600);

      if (novasTentativas >= MAX_TENTATIVAS) {
        setBloqueado(true);
        setCountdown(BLOQUEIO_SEGUNDOS);
        setDigitado([]);
      }
    }
  }

  function apagar() {
    if (bloqueado) return;
    setDigitado(d => d.slice(0, -1));
    setErro(false);
  }

  const teclas = [
    ["1","2","3"],
    ["4","5","6"],
    ["7","8","9"],
    [null,"0","⌫"],
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(160deg, #3d0a05 0%, #6b1c0e 40%, #8b2510 100%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Segoe UI', Tahoma, sans-serif",
      padding: 24,
      userSelect: "none",
    }}>

      {/* Logo */}
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <div style={{ fontSize: 56, marginBottom: 8 }}>👑</div>
        <div style={{ color: "#f0c040", fontWeight: 900, fontSize: 22, letterSpacing: 1 }}>
          Império dos Espetos
        </div>
        <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: 4 }}>
          Painel do Dono
        </div>
      </div>

      {/* Indicador de PIN */}
      <div style={{ marginBottom: 12, color: "rgba(255,255,255,0.7)", fontSize: 14 }}>
        {bloqueado ? `🔒 Bloqueado por ${countdown}s` : "Digite seu PIN"}
      </div>

      <div style={{
        display: "flex",
        gap: 16,
        marginBottom: 40,
        animation: shake ? "shake 0.5s" : "none",
      }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: erro
              ? "#ef4444"
              : digitado.length > i
                ? "#f0c040"
                : "rgba(255,255,255,0.25)",
            border: "2px solid " + (erro ? "#ef4444" : digitado.length > i ? "#f0c040" : "rgba(255,255,255,0.4)"),
            transition: "all 0.15s",
            transform: digitado.length > i ? "scale(1.2)" : "scale(1)",
          }} />
        ))}
      </div>

      {/* Teclado numérico */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {teclas.map((linha, li) => (
          <div key={li} style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            {linha.map((tecla, ti) => (
              tecla === null
                ? <div key={ti} style={{ width: 72, height: 72 }} />
                : (
                  <button
                    key={ti}
                    onClick={() => tecla === "⌫" ? apagar() : pressDigit(tecla)}
                    disabled={bloqueado}
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: "50%",
                      border: "none",
                      background: tecla === "⌫"
                        ? "rgba(255,255,255,0.08)"
                        : "rgba(255,255,255,0.12)",
                      color: "#fff",
                      fontSize: tecla === "⌫" ? 22 : 26,
                      fontWeight: 600,
                      cursor: bloqueado ? "not-allowed" : "pointer",
                      opacity: bloqueado ? 0.4 : 1,
                      transition: "all 0.1s",
                      backdropFilter: "blur(4px)",
                      WebkitTapHighlightColor: "transparent",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
                    }}
                    onTouchStart={e => { if (!bloqueado) e.currentTarget.style.background = "rgba(255,255,255,0.25)"; }}
                    onTouchEnd={e => { e.currentTarget.style.background = tecla === "⌫" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.12)"; }}
                    onMouseDown={e => { if (!bloqueado) e.currentTarget.style.background = "rgba(255,255,255,0.25)"; }}
                    onMouseUp={e => { e.currentTarget.style.background = tecla === "⌫" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.12)"; }}
                  >
                    {tecla}
                  </button>
                )
            ))}
          </div>
        ))}
      </div>

      {/* Mensagem de erro */}
      {erro && !bloqueado && (
        <div style={{ marginTop: 20, color: "#fca5a5", fontSize: 13, fontWeight: 600 }}>
          PIN incorreto — {MAX_TENTATIVAS - tentativas} tentativa{MAX_TENTATIVAS - tentativas !== 1 ? "s" : ""} restante{MAX_TENTATIVAS - tentativas !== 1 ? "s" : ""}
        </div>
      )}
      {bloqueado && (
        <div style={{ marginTop: 20, color: "#fca5a5", fontSize: 13, fontWeight: 600, textAlign: "center" }}>
          Muitas tentativas incorretas.<br />Aguarde {countdown} segundos.
        </div>
      )}

      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-8px); }
          40% { transform: translateX(8px); }
          60% { transform: translateX(-6px); }
          80% { transform: translateX(6px); }
        }
      `}</style>
    </div>
  );
}
