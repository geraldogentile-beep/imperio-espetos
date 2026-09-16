import { useEffect, useRef, useState } from "react";

// ── AVISO DE NOVA VERSÃO ─────────────────────────────────────
// Toda correção do painel dependia de alguém dar F5 em cada aparelho. Quando
// o PC do caixa ficava aberto a noite inteira, ele seguia com a versão velha:
// a observação da mesa saía do celular do garçom com o texto, e o ticket
// impresso saía sem — porque quem monta o papel é o aparelho da impressora.
//
// Como descobre: o nome do arquivo do painel muda a cada publicação
// (assets/index-XXXX.js). Basta comparar o que está carregado aqui com o que
// o servidor entrega agora.
const INTERVALO_CHECAGEM = 3 * 60 * 1000;   // 3 min
const OCIOSO_PARA_RECARREGAR = 3 * 60 * 1000;

function arquivoAtual() {
  const s = [...document.scripts].map(x => x.src).find(src => /\/assets\/index-.*\.js$/.test(src || ""));
  return s ? s.split("/").pop() : null;
}

async function arquivoNoServidor() {
  const r = await fetch("/?v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/);
  return m ? m[1] : null;
}

export default function AvisoAtualizacao() {
  const [nova, setNova] = useState(false);
  const meu = useRef(arquivoAtual());
  const ultimoToque = useRef(Date.now());

  // Em desenvolvimento não existe assets/index-*.js: não faz nada.
  const ativo = !!meu.current;

  useEffect(() => {
    if (!ativo) return;
    const marcar = () => { ultimoToque.current = Date.now(); };
    for (const ev of ["pointerdown", "keydown", "touchstart"]) window.addEventListener(ev, marcar, { passive: true });
    return () => { for (const ev of ["pointerdown", "keydown", "touchstart"]) window.removeEventListener(ev, marcar); };
  }, [ativo]);

  useEffect(() => {
    if (!ativo) return;
    let vivo = true;

    async function checar() {
      if (!vivo || !navigator.onLine) return;
      try {
        const doServidor = await arquivoNoServidor();
        if (vivo && doServidor && doServidor !== meu.current) setNova(true);
      } catch { /* sem rede: tenta de novo depois */ }
    }

    checar();
    const t = setInterval(checar, INTERVALO_CHECAGEM);
    const aoVoltar = () => { if (document.visibilityState === "visible") checar(); };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => { vivo = false; clearInterval(t); document.removeEventListener("visibilitychange", aoVoltar); };
  }, [ativo]);

  // Recarrega sozinho só com o aparelho parado e ninguém digitando: no meio de
  // um fechamento isso apagaria o que o operador acabou de preencher.
  useEffect(() => {
    if (!nova) return;
    const t = setInterval(() => {
      const digitando = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (!digitando && Date.now() - ultimoToque.current > OCIOSO_PARA_RECARREGAR) window.location.reload();
    }, 15000);
    return () => clearInterval(t);
  }, [nova]);

  if (!nova) return null;

  return (
    <div style={{
      position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 100000,
      background: "linear-gradient(135deg,#1d4ed8,#2563eb)", color: "#fff",
      padding: "10px 14px", display: "flex", alignItems: "center", gap: 12,
      boxShadow: "0 -4px 16px rgba(0,0,0,0.25)", fontFamily: "'DM Sans',sans-serif",
    }}>
      <div style={{ flex: 1, fontSize: 13, lineHeight: 1.35 }}>
        <strong>Nova versão disponível.</strong> Atualize para usar as correções mais recentes.
      </div>
      <button onClick={() => window.location.reload()} style={{
        background: "#fff", color: "#1d4ed8", border: "none", borderRadius: 10,
        padding: "9px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer", flexShrink: 0,
      }}>Atualizar agora</button>
    </div>
  );
}
