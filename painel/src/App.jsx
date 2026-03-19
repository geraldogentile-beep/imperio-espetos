import { useState, useEffect } from "react";
import PinLock from "./PinLock.jsx";
import PainelPedidos from "./PainelPedidos.jsx";

const PIN_STORAGE_KEY = "imperio_pin_auth";
const PIN_CONFIG_KEY  = "imperio_pin_config";
const PIN_EXPIRY_HOURS = 8;

export default function App() {
  const [autenticado, setAutenticado] = useState(false);
  const [pinConfigurado, setPinConfigurado] = useState(() => {
    try { return localStorage.getItem(PIN_CONFIG_KEY) || "1234"; } catch { return "1234"; }
  });

  // Verifica sessão salva ao iniciar
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PIN_STORAGE_KEY);
      if (saved) {
        const { timestamp } = JSON.parse(saved);
        const horasPassadas = (Date.now() - timestamp) / (1000 * 60 * 60);
        if (horasPassadas < PIN_EXPIRY_HOURS) {
          setAutenticado(true);
        } else {
          localStorage.removeItem(PIN_STORAGE_KEY);
        }
      }
    } catch {}
  }, []);

  function handleUnlock() {
    setAutenticado(true);
  }

  function handleLogout() {
    try { localStorage.removeItem(PIN_STORAGE_KEY); } catch {}
    setAutenticado(false);
  }

  function handlePinChange(novoPin) {
    try { localStorage.setItem(PIN_CONFIG_KEY, novoPin); } catch {}
    setPinConfigurado(novoPin);
  }

  if (!autenticado) {
    return <PinLock onUnlock={handleUnlock} pinConfigurado={pinConfigurado} />;
  }

  return <PainelPedidos onLogout={handleLogout} onPinChange={handlePinChange} pinAtual={pinConfigurado} />;
}
