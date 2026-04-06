import { useState, useEffect, useCallback, useRef } from "react";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";

// ── DESIGN TOKENS ─────────────────────────────────────────────
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
  blue:    "#1D4ED8",
  blueL:   "#EFF6FF",
  purple:  "#6D28D9",
  purpleL: "#EDE9FE",
  shadow:  "0 2px 16px rgba(28,25,23,0.07)",
  shadowM: "0 4px 24px rgba(28,25,23,0.1)",
  radius:  "16px",
  radiusS: "10px",
  radiusL: "24px",
};
const POLLING_INTERVAL = 8000;
const DIAS_SEMANA = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];

const STATUS_CONFIG = {
  novo:       { label: "Novo",       color: "#f59e0b", bg: "#fef3c7", icon: "🔔" },
  preparando: { label: "Preparando", color: "#3b82f6", bg: "#dbeafe", icon: "🔥" },
  entrega:    { label: "Na entrega", color: "#8b5cf6", bg: "#ede9fe", icon: "🛵" },
  entregue:   { label: "Entregue",   color: "#10b981", bg: "#d1fae5", icon: "✅" },
  cancelado:  { label: "Cancelado",  color: "#ef4444", bg: "#fee2e2", icon: "❌" },
};

const hoje = new Date();
function diasAtras(n) { const d = new Date(hoje); d.setDate(d.getDate() - n); return d.toISOString(); }
function isMesmosDias(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }

const MOCK_PEDIDOS    = [];
const MOCK_CARDAPIO   = [];
const MOCK_CUPONS     = [];
const MOCK_AVALIACOES = [];

const DEFAULT_CONFIG = {
  nomeEstabelecimento: "Império dos Espetos e Grill",
  nomeAgente: "Imperador",
  taxaEntrega: 5.00,
  tempoEntregaMin: 30,
  tempoEntregaMax: 45,
  entregaCEP: { ativo: true, cepBase: "01310100", raioKm: 5, mensagemForaRaio: "😕 Fora do nosso raio de {raio}km." },
  horarioFuncionamento: {
    0: { aberto: false, abertura: "18:00", fechamento: "23:00" },
    1: { aberto: false, abertura: "18:00", fechamento: "23:00" },
    2: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    3: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    4: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    5: { aberto: true,  abertura: "17:00", fechamento: "00:00" },
    6: { aberto: true,  abertura: "17:00", fechamento: "00:00" },
  },
  mensagensAutomaticas: {
    ativo: true,
    preparando: "👨‍🍳 Seu pedido *#{id}* está sendo preparado! 🔥",
    entrega:    "🛵 Seu pedido *#{id}* saiu para entrega!",
    entregue:   "✅ Pedido *#{id}* entregue! Obrigado, {cliente}! 🍢",
    cancelado:  "❌ Seu pedido *#{id}* foi cancelado.",
  },
  fidelidade: {
    ativo: true,
    pedidosParaGanhar: 5,
    brinde: "1 espetinho grátis",
    mensagemGanhou: "🎉 Parabéns {cliente}! Você ganhou *{brinde}*! Mencione no próximo pedido 😄",
  },
  avaliacao: {
    ativo: true,
    delayMinutos: 10,
    mensagem: "Olá {cliente}! Como foi seu pedido? Responda com uma nota de *1 a 5* ⭐",
    mensagemObrigado: "Obrigado pela avaliação, {cliente}! 💛",
  },
};

// ── HELPERS ───────────────────────────────────────────────────
function calcTotal(itens = [], desconto = 0) { return itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0) + 5 - (desconto || 0); }
function horaFmt(iso) { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
function dataFmt(iso) { return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }); }
function dtFmt(iso) { return dataFmt(iso) + " às " + horaFmt(iso); }
function tempoAtras(iso) {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "agora"; if (m < 60) return m + "min atrás";
  if (m < 1440) return Math.floor(m / 60) + "h atrás"; return Math.floor(m / 1440) + "d atrás";
}
function iniciais(nome) { return nome.split(" ").slice(0, 2).map(x => x[0]).join("").toUpperCase(); }
function corAvatar(nome) {
  const cores = ["#7b1a0a","#1d4ed8","#065f46","#7c3aed","#b45309","#be185d","#0e7490"];
  let h = 0; for (const x of nome) h = x.charCodeAt(0) + ((h << 5) - h);
  return cores[Math.abs(h) % cores.length];
}
function estrelas(nota) { return "⭐".repeat(nota) + "☆".repeat(5 - nota); }

// ── COMPONENTES BASE ──────────────────────────────────────────
function Badge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.novo;
  return <span style={{ background: c.bg, color: c.color, border: `1px solid ${c.color}40`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3, fontFamily:"'DM Sans',sans-serif" }}>{c.icon} {c.label}</span>;
}

function Toggle({ value, onChange, label, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: T.dark, fontFamily:"'DM Sans',sans-serif" }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: T.gray, marginTop: 2 }}>{sub}</div>}
      </div>
      <div onClick={() => onChange(!value)} style={{ width: 48, height: 28, borderRadius: 14, background: value ? T.wine : T.grayL, cursor: "pointer", position: "relative", transition: "background 0.25s", flexShrink: 0, boxShadow: value ? `0 2px 8px ${T.wine}40` : "none" }}>
        <div style={{ position: "absolute", top: 4, left: value ? 24 : 4, width: 20, height: 20, borderRadius: "50%", background: T.white, transition: "left 0.25s", boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }} />
      </div>
    </div>
  );
}

function Metrica({ icon, label, valor, sub, cor }) {
  return (
    <div style={{ background: T.white, borderRadius: T.radius, padding: "16px", flex: 1, minWidth: 110, boxShadow: T.shadow, border: `1px solid ${T.grayL}`, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: cor, borderRadius: "16px 16px 0 0" }} />
      <div style={{ fontSize: 22, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: T.dark, fontFamily:"'DM Sans',sans-serif", lineHeight:1 }}>{valor}</div>
      <div style={{ fontSize: 11, color: T.gray, marginTop: 4, textTransform:"uppercase", letterSpacing:0.5 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: cor, fontWeight: 600, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Barra({ label, valor, maximo, destaque }) {
  const pct = maximo > 0 ? (valor / maximo) * 100 : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: destaque ? T.wine : T.gray }}>{valor > 0 ? "R$" + valor.toFixed(0) : "—"}</div>
      <div style={{ width: "100%", height: 80, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <div style={{ width: "60%", height: Math.max(pct, valor > 0 ? 4 : 0) + "%", background: destaque ? `linear-gradient(180deg,${T.amber},${T.wine})` : `linear-gradient(180deg,${T.wineL},${T.wineL.replace("F5","E0")})`, borderRadius: "6px 6px 0 0", transition: "height 0.6s ease", minHeight: valor > 0 ? 4 : 0 }} />
      </div>
      <div style={{ fontSize: 10, color: destaque ? T.wine : T.gray, fontWeight: destaque ? 700 : 400 }}>{label}</div>
    </div>
  );
}

// ── ABA CUPONS ────────────────────────────────────────────────
function Cupons({ cupons, onReload }) {
  const [novoForm, setNovoForm] = useState(false);
  const [novo, setNovo] = useState({ codigo: "", tipo: "percentual", valor: "", usoMax: "", validade: "", descricao: "" });
  const [saving, setSaving] = useState(false);
  const [testeCodigo, setTesteCodigo] = useState("");
  const [testeSubtotal, setTesteSubtotal] = useState("50");
  const [resultadoTeste, setResultadoTeste] = useState(null);

  async function criarCupom() {
    if (!novo.codigo || !novo.valor) return;
    setSaving(true);
    try {
      await fetch(BACKEND_URL + "/cupons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...novo, valor: parseFloat(novo.valor), usoMax: novo.usoMax ? parseInt(novo.usoMax) : null }) });
      onReload();
    } catch { onReload(); }
    setSaving(false);
    setNovoForm(false);
    setNovo({ codigo: "", tipo: "percentual", valor: "", usoMax: "", validade: "", descricao: "" });
  }

  async function toggleCupom(codigo, ativo) {
    try { await fetch(BACKEND_URL + "/cupons/" + codigo + "/ativo", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo }) }); onReload(); } catch { onReload(); }
  }

  async function deletarCupom(codigo) {
    if (!window.confirm("Remover cupom " + codigo + "?")) return;
    try { await fetch(BACKEND_URL + "/cupons/" + codigo, { method: "DELETE" }); onReload(); } catch { onReload(); }
  }

  async function testarCupom() {
    try {
      const res = await fetch(BACKEND_URL + "/cupons/validar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codigo: testeCodigo, subtotal: parseFloat(testeSubtotal) }) });
      setResultadoTeste(await res.json());
    } catch { setResultadoTeste({ erro: "Erro ao testar" }); }
  }

  const inputStyle = { width: "100%", padding: "7px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };
  const tipoLabel = { percentual: "% Desconto", fixo: "R$ Fixo", frete: "Frete grátis" };

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10 }}>
        <Metrica icon="🎟️" label="Cupons ativos" valor={cupons.filter(c => c.ativo).length} cor="#7b1a0a" />
        <Metrica icon="📊" label="Total de usos" valor={cupons.reduce((s, c) => s + c.usoAtual, 0)} cor="#3b82f6" />
        <Metrica icon="💸" label="Cupons inativos" valor={cupons.filter(c => !c.ativo).length} cor="#aaa" />
      </div>

      <button onClick={() => setNovoForm(true)} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
        + Criar novo cupom
      </button>

      {novoForm && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 12px rgba(0,0,0,0.1)", border: "1.5px solid #7b1a0a" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#333", marginBottom: 12 }}>🎟️ Novo cupom</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Código *</div>
              <input value={novo.codigo} onChange={e => setNovo(p => ({ ...p, codigo: e.target.value.toUpperCase() }))} placeholder="Ex: NATAL20" style={inputStyle} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Tipo *</div>
              <select value={novo.tipo} onChange={e => setNovo(p => ({ ...p, tipo: e.target.value }))} style={inputStyle}>
                <option value="percentual">% Percentual</option>
                <option value="fixo">R$ Valor fixo</option>
                <option value="frete">Frete grátis</option>
              </select>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>{novo.tipo === "percentual" ? "Desconto (%)" : novo.tipo === "fixo" ? "Valor (R$)" : "Valor"} *</div>
              <input type="number" value={novo.valor} onChange={e => setNovo(p => ({ ...p, valor: e.target.value }))} placeholder={novo.tipo === "frete" ? "0" : "10"} disabled={novo.tipo === "frete"} style={{ ...inputStyle, background: novo.tipo === "frete" ? "#f5f5f5" : "#fff" }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Uso máximo</div>
              <input type="number" value={novo.usoMax} onChange={e => setNovo(p => ({ ...p, usoMax: e.target.value }))} placeholder="Ilimitado" style={inputStyle} />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Descrição</div>
            <input value={novo.descricao} onChange={e => setNovo(p => ({ ...p, descricao: e.target.value }))} placeholder="Ex: Desconto de fim de ano" style={inputStyle} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={criarCupom} disabled={saving} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              {saving ? "Criando..." : "✅ Criar cupom"}
            </button>
            <button onClick={() => setNovoForm(false)} style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Lista de cupons */}
      {cupons.map(c => (
        <div key={c.codigo} style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", opacity: c.ativo ? 1 : 0.55 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 800, fontSize: 15, color: "#7b1a0a", fontFamily: "monospace", letterSpacing: 1 }}>{c.codigo}</span>
                <span style={{ background: c.ativo ? "#d1fae5" : "#f0f0f0", color: c.ativo ? "#065f46" : "#888", borderRadius: 10, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>
                  {c.ativo ? "Ativo" : "Inativo"}
                </span>
                <span style={{ background: "#fef3c7", color: "#92400e", borderRadius: 10, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
                  {tipoLabel[c.tipo]}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "#333", marginTop: 4, fontWeight: 600 }}>
                {c.tipo === "percentual" ? c.valor + "% de desconto" : c.tipo === "fixo" ? "R$ " + c.valor + " de desconto" : "Frete grátis"}
              </div>
              {c.descricao && <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{c.descricao}</div>}
              <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>
                Usado {c.usoAtual}x{c.usoMax ? " de " + c.usoMax : " (ilimitado)"}
                {c.usoMax && (
                  <span style={{ marginLeft: 8 }}>
                    <span style={{ display: "inline-block", width: 60, height: 4, background: "#f0f0f0", borderRadius: 2, verticalAlign: "middle" }}>
                      <span style={{ display: "block", width: Math.min((c.usoAtual / c.usoMax) * 100, 100) + "%", height: "100%", background: "#7b1a0a", borderRadius: 2 }} />
                    </span>
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button onClick={() => toggleCupom(c.codigo, !c.ativo)} title={c.ativo ? "Desativar" : "Ativar"} style={{ background: c.ativo ? "#fee2e2" : "#d1fae5", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>
                {c.ativo ? "❌" : "✅"}
              </button>
              <button onClick={() => deletarCupom(c.codigo)} title="Remover" style={{ background: "#fee2e2", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>
                🗑️
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* Testar cupom */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>🧪 Simular cupom</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 2 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Código</div>
            <input value={testeCodigo} onChange={e => { setTesteCodigo(e.target.value.toUpperCase()); setResultadoTeste(null); }} placeholder="BEMVINDO10" style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Subtotal (R$)</div>
            <input type="number" value={testeSubtotal} onChange={e => setTesteSubtotal(e.target.value)} style={inputStyle} />
          </div>
        </div>
        <button onClick={testarCupom} disabled={!testeCodigo} style={{ width: "100%", background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          Simular desconto
        </button>
        {resultadoTeste && (
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: resultadoTeste.erro ? "#fee2e2" : "#d1fae5", border: "1px solid " + (resultadoTeste.erro ? "#ef4444" : "#10b981") }}>
            {resultadoTeste.erro
              ? <div style={{ fontWeight: 700, fontSize: 13, color: "#991b1b" }}>❌ {resultadoTeste.erro}</div>
              : <>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#065f46" }}>✅ Cupom válido!</div>
                <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
                  Desconto: <strong>R$ {resultadoTeste.desconto?.toFixed(2)}</strong>
                  {" · "}Total final: <strong>R$ {(parseFloat(testeSubtotal) + 5 - (resultadoTeste.desconto || 0)).toFixed(2)}</strong>
                </div>
              </>
            }
          </div>
        )}
      </div>
    </div>
  );
}

// ── ABA FIDELIDADE ────────────────────────────────────────────
function Fidelidade({ pedidos, config }) {
  const meta = config?.fidelidade?.pedidosParaGanhar || 5;
  const brinde = config?.fidelidade?.brinde || "1 espetinho grátis";

  // Calcula fidelidade a partir dos pedidos entregues
  const fm = {};
  pedidos.filter(p => p.status === "entregue").forEach(p => {
    if (!fm[p.telefone]) fm[p.telefone] = { nome: p.cliente, telefone: p.telefone, total: 0 };
    fm[p.telefone].total += 1;
  });
  const clientes = Object.values(fm).sort((a, b) => b.total - a.total);

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Regra atual */}
      <div style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", borderRadius: 14, padding: "16px", color: "#fff" }}>
        <div style={{ fontSize: 22, marginBottom: 6 }}>🏆</div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Programa de Fidelidade</div>
        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>
          A cada <strong>{meta} pedidos</strong> entregues, o cliente ganha:
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6, background: "rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 12px", display: "inline-block" }}>
          🎁 {brinde}
        </div>
      </div>

      {/* Métricas */}
      <div style={{ display: "flex", gap: 10 }}>
        <Metrica icon="👥" label="Clientes no programa" valor={clientes.length} cor="#7b1a0a" />
        <Metrica icon="🎁" label="Brindes gerados" valor={clientes.reduce((s, c) => s + Math.floor(c.total / meta), 0)} cor="#10b981" />
        <Metrica icon="🔥" label="Perto do brinde" valor={clientes.filter(c => (c.total % meta) >= meta - 1).length} sub={"falta 1 pedido"} cor="#f59e0b" />
      </div>

      {/* Ranking de clientes */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>📊 Progresso dos clientes</div>
        {clientes.length === 0
          ? <div style={{ textAlign: "center", padding: "20px 0", color: "#ccc", fontSize: 14 }}>Nenhum pedido entregue ainda</div>
          : clientes.map(c => {
            const progresso = c.total % meta;
            const brindesGanhos = Math.floor(c.total / meta);
            const pct = (progresso / meta) * 100;
            return (
              <div key={c.telefone} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 34, height: 34, borderRadius: "50%", background: corAvatar(c.nome), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                      {iniciais(c.nome)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>{c.nome}</div>
                      <div style={{ fontSize: 11, color: "#aaa" }}>{c.total} pedido{c.total !== 1 ? "s" : ""} entregue{c.total !== 1 ? "s" : ""}{brindesGanhos > 0 ? " · 🎁 " + brindesGanhos + " brinde" + (brindesGanhos > 1 ? "s" : "") + " ganho" + (brindesGanhos > 1 ? "s" : "") : ""}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 12 }}>
                    {progresso === 0 && c.total > 0
                      ? <span style={{ color: "#10b981", fontWeight: 700 }}>🎁 Ganhou!</span>
                      : <span style={{ color: "#888" }}>{progresso}/{meta}</span>
                    }
                  </div>
                </div>
                <div style={{ height: 6, background: "#f0f0f0", borderRadius: 3 }}>
                  <div style={{ height: "100%", width: pct + "%", background: pct >= 80 ? "linear-gradient(90deg,#f59e0b,#d97706)" : "linear-gradient(90deg,#c0392b,#7b1a0a)", borderRadius: 3, transition: "width 0.6s" }} />
                </div>
                {pct >= 80 && pct < 100 && (
                  <div style={{ fontSize: 10, color: "#d97706", fontWeight: 600, marginTop: 3 }}>
                    🔥 Falta {meta - progresso} pedido{meta - progresso !== 1 ? "s" : ""} para o brinde!
                  </div>
                )}
              </div>
            );
          })
        }
      </div>
    </div>
  );
}

// ── ABA AVALIAÇÕES ────────────────────────────────────────────
function Avaliacoes({ avaliacoes }) {
  const media = avaliacoes.length > 0 ? avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length : 0;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  avaliacoes.forEach(a => dist[a.nota]++);
  const max = Math.max(...Object.values(dist), 1);

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Nota geral */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "20px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 48, fontWeight: 900, color: "#7b1a0a", lineHeight: 1 }}>{media.toFixed(1)}</div>
          <div style={{ fontSize: 20, marginTop: 4 }}>{"⭐".repeat(Math.round(media))}</div>
          <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>{avaliacoes.length} avaliação{avaliacoes.length !== 1 ? "ões" : ""}</div>
        </div>
        <div style={{ flex: 1 }}>
          {[5, 4, 3, 2, 1].map(n => (
            <div key={n} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <div style={{ fontSize: 12, color: "#888", width: 16, textAlign: "right" }}>{n}</div>
              <span style={{ fontSize: 12 }}>⭐</span>
              <div style={{ flex: 1, height: 8, background: "#f0f0f0", borderRadius: 4 }}>
                <div style={{ height: "100%", width: ((dist[n] || 0) / max * 100) + "%", background: n >= 4 ? "linear-gradient(90deg,#10b981,#059669)" : n === 3 ? "#f59e0b" : "#ef4444", borderRadius: 4, transition: "width 0.6s" }} />
              </div>
              <div style={{ fontSize: 11, color: "#aaa", width: 20 }}>{dist[n] || 0}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Métricas */}
      <div style={{ display: "flex", gap: 10 }}>
        <Metrica icon="😍" label="Nota 5" valor={dist[5] || 0} sub={avaliacoes.length > 0 ? Math.round((dist[5] || 0) / avaliacoes.length * 100) + "%" : "0%"} cor="#10b981" />
        <Metrica icon="😐" label="Nota 3" valor={dist[3] || 0} cor="#f59e0b" />
        <Metrica icon="😞" label="Notas 1-2" valor={(dist[1] || 0) + (dist[2] || 0)} cor="#ef4444" />
      </div>

      {/* Lista de avaliações */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>📝 Últimas avaliações</div>
        {avaliacoes.length === 0
          ? <div style={{ textAlign: "center", padding: "20px 0", color: "#ccc", fontSize: 14 }}>Nenhuma avaliação ainda</div>
          : [...avaliacoes].sort((a, b) => new Date(b.horario) - new Date(a.horario)).map((a, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px dashed #f0f0f0" }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: corAvatar(a.cliente), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>
                {iniciais(a.cliente)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>{a.cliente}</div>
                <div style={{ fontSize: 11, color: "#aaa" }}>Pedido #{a.pedidoId} · {dtFmt(a.horario)}</div>
                {a.comentario && <div style={{ fontSize: 12, color: "#555", marginTop: 3, fontStyle: "italic" }}>"{a.comentario}"</div>}
              </div>
              <div style={{ fontSize: 18, flexShrink: 0 }}>
                {["😞","😕","😐","😊","😍"][a.nota - 1]}
              </div>
              <div style={{ fontWeight: 800, fontSize: 14, color: a.nota >= 4 ? "#10b981" : a.nota === 3 ? "#f59e0b" : "#ef4444", flexShrink: 0 }}>
                {a.nota}/5
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ── ABA CARDÁPIO ──────────────────────────────────────────────
function Cardapio({ cardapio, onReload }) {
  const [filtro, setFiltro] = useState("todos");
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState(null);
  const [adicionando, setAdicionando] = useState(false);
  const [saving, setSaving] = useState(false);
  const [novoItem, setNovoItem] = useState({ categoria: "", nome: "", preco: "", tempoPreparo: 10, obs: "" });

  const categorias = ["todos", ...new Set(cardapio.map(i => i.categoria))];
  const itens = cardapio.filter(i => filtro === "todos" || i.categoria === filtro).filter(i => i.nome.toLowerCase().includes(busca.toLowerCase()));
  const inputStyle = { width: "100%", padding: "7px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };

  async function toggleAtivo(item) {
    try { await fetch(BACKEND_URL + "/cardapio/" + item.id + "/ativo", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo: !item.ativo }) }); onReload(); } catch { onReload(); }
  }
  async function salvarEdicao(item) {
    setSaving(true);
    try { await fetch(BACKEND_URL + "/cardapio/" + item.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) }); onReload(); } catch { onReload(); }
    setSaving(false); setEditando(null);
  }
  async function deletarItem(id) {
    if (!window.confirm("Remover item?")) return;
    try { await fetch(BACKEND_URL + "/cardapio/" + id, { method: "DELETE" }); onReload(); } catch { onReload(); }
  }
  async function adicionarItem() {
    if (!novoItem.categoria || !novoItem.nome || !novoItem.preco) return;
    setSaving(true);
    try { await fetch(BACKEND_URL + "/cardapio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...novoItem, preco: parseFloat(novoItem.preco), tempoPreparo: parseInt(novoItem.tempoPreparo) }) }); onReload(); } catch { onReload(); }
    setSaving(false); setAdicionando(false); setNovoItem({ categoria: "", nome: "", preco: "", tempoPreparo: 10, obs: "" });
  }

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10 }}>
        <Metrica icon="🍢" label="Total" valor={cardapio.length} cor="#7b1a0a" />
        <Metrica icon="✅" label="Ativos" valor={cardapio.filter(i => i.ativo).length} cor="#10b981" />
        <Metrica icon="❌" label="Em falta" valor={cardapio.filter(i => !i.ativo).length} cor="#ef4444" />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, background: "#fff", borderRadius: 12, padding: "9px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.07)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>🔍</span>
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar item..." style={{ border: "none", outline: "none", flex: 1, fontSize: 13, background: "transparent" }} />
        </div>
        <button onClick={() => setAdicionando(true)} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 12, padding: "0 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>+ Novo</button>
      </div>
      {adicionando && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 12px rgba(0,0,0,0.1)", border: "1.5px solid #7b1a0a" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#333", marginBottom: 12 }}>➕ Novo item</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Categoria *</div><input value={novoItem.categoria} onChange={e => setNovoItem(p => ({ ...p, categoria: e.target.value }))} placeholder="Ex: Tradicionais" style={inputStyle} /></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Nome *</div><input value={novoItem.nome} onChange={e => setNovoItem(p => ({ ...p, nome: e.target.value }))} placeholder="Ex: Cordeiro" style={inputStyle} /></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Preço (R$) *</div><input type="number" step="0.50" value={novoItem.preco} onChange={e => setNovoItem(p => ({ ...p, preco: e.target.value }))} style={inputStyle} /></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>⏱️ Preparo (min)</div><input type="number" value={novoItem.tempoPreparo} onChange={e => setNovoItem(p => ({ ...p, tempoPreparo: e.target.value }))} style={inputStyle} /></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Obs.</div><input value={novoItem.obs} onChange={e => setNovoItem(p => ({ ...p, obs: e.target.value }))} style={inputStyle} /></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={adicionarItem} disabled={saving} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{saving ? "Salvando..." : "✅ Adicionar"}</button>
            <button onClick={() => setAdicionando(false)} style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 2 }}>
        {categorias.map(cat => (
          <button key={cat} onClick={() => setFiltro(cat)} style={{ whiteSpace: "nowrap", padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 12, fontWeight: filtro === cat ? 700 : 500, background: filtro === cat ? "#7b1a0a" : "#f0f0f0", color: filtro === cat ? "#fff" : "#555" }}>{cat === "todos" ? "📋 Todos" : cat}</button>
        ))}
      </div>
      {itens.map(item => (
        <div key={item.id} style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", opacity: item.ativo ? 1 : 0.55 }}>
          {editando?.id === item.id ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#7b1a0a", marginBottom: 10 }}>✏️ Editando: {item.nome}</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 2 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Nome</div><input value={editando.nome} onChange={e => setEditando(p => ({ ...p, nome: e.target.value }))} style={inputStyle} /></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Categoria</div><input value={editando.categoria} onChange={e => setEditando(p => ({ ...p, categoria: e.target.value }))} style={inputStyle} /></div>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Preço (R$)</div><input type="number" step="0.50" value={editando.preco} onChange={e => setEditando(p => ({ ...p, preco: parseFloat(e.target.value) }))} style={inputStyle} /></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>⏱️ Preparo (min)</div><input type="number" value={editando.tempoPreparo} onChange={e => setEditando(p => ({ ...p, tempoPreparo: parseInt(e.target.value) }))} style={inputStyle} /></div>
                <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Obs.</div><input value={editando.obs || ""} onChange={e => setEditando(p => ({ ...p, obs: e.target.value }))} style={inputStyle} /></div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => salvarEdicao(editando)} disabled={saving} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "9px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{saving ? "Salvando..." : "💾 Salvar"}</button>
                <button onClick={() => setEditando(null)} style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "9px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#1a1a1a" }}>{item.nome}</span>
                  {!item.ativo && <span style={{ background: "#fee2e2", color: "#ef4444", borderRadius: 10, padding: "1px 8px", fontSize: 11, fontWeight: 700 }}>Em falta</span>}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{item.categoria}{item.obs && " · " + item.obs}{" · ⏱️ " + item.tempoPreparo + "min"}</div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#7b1a0a", flexShrink: 0 }}>R$ {item.preco.toFixed(2)}</div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => toggleAtivo(item)} style={{ background: item.ativo ? "#d1fae5" : "#fee2e2", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>{item.ativo ? "✅" : "❌"}</button>
                <button onClick={() => setEditando({ ...item })} style={{ background: "#dbeafe", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>✏️</button>
                <button onClick={() => deletarItem(item.id)} style={{ background: "#fee2e2", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>🗑️</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── COMPONENTE TROCA DE PIN ───────────────────────────────────
function PinManager() {
  const [pins, setPins] = useState(() => {
    try { const s = localStorage.getItem("imperio_pins"); return s ? JSON.parse(s) : { dono: "9999", garcom: "1234", caixa: "5678" }; } catch { return { dono: "9999", garcom: "1234", caixa: "5678" }; }
  });
  const [editando, setEditando] = useState(null); // "dono" | "garcom" | "caixa"
  const [novo, setNovo] = useState("");
  const [confirma, setConfirma] = useState("");
  const [msg, setMsg] = useState(null);

  const perfis = [
    { key: "dono",   icon: "👑", label: "Dono",   desc: "Acesso completo ao painel" },
    { key: "garcom", icon: "🧑‍🍳", label: "Garçom", desc: "Acesso ao salão — lança pedidos" },
    { key: "caixa",  icon: "💁‍♀️", label: "Caixa",  desc: "Acesso ao salão — fecha contas" },
  ];

  function salvar() {
    if (novo.length !== 4 || !/^\d{4}$/.test(novo)) { setMsg({ tipo: "erro", texto: "PIN deve ter 4 números." }); return; }
    if (novo !== confirma) { setMsg({ tipo: "erro", texto: "PINs não conferem." }); return; }
    const novosPins = { ...pins, [editando]: novo };
    setPins(novosPins);
    try { localStorage.setItem("imperio_pins", JSON.stringify(novosPins)); } catch {}
    setEditando(null); setNovo(""); setConfirma("");
    setMsg({ tipo: "ok", texto: `PIN do ${perfis.find(p=>p.key===editando)?.label} alterado! ✅` });
    setTimeout(() => setMsg(null), 3000);
  }

  const inp = { width: "100%", padding: "10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 22, color: "#333", outline: "none", boxSizing: "border-box", letterSpacing: 10, textAlign: "center" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {perfis.map(p => (
        <div key={p.key} style={{ border: "1.5px solid " + (editando === p.key ? "#7b1a0a" : "#f0f0f0"), borderRadius: 12, padding: "12px 14px", background: editando === p.key ? "#fef0ed" : "#fafafa" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{p.icon} {p.label}</div>
              <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{p.desc}</div>
            </div>
            <button onClick={() => { setEditando(editando === p.key ? null : p.key); setNovo(""); setConfirma(""); setMsg(null); }}
              style={{ background: editando === p.key ? "#fee2e2" : "#f0f0f0", color: editando === p.key ? "#ef4444" : "#555", border: "none", borderRadius: 8, padding: "6px 12px", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              {editando === p.key ? "Cancelar" : "✏️ Alterar"}
            </button>
          </div>
          {editando === p.key && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Novo PIN</div>
                  <input type="password" inputMode="numeric" maxLength={4} value={novo} onChange={e => setNovo(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" style={inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Confirmar</div>
                  <input type="password" inputMode="numeric" maxLength={4} value={confirma} onChange={e => setConfirma(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="••••" style={inp} />
                </div>
              </div>
              <button onClick={salvar} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                💾 Salvar PIN do {p.label}
              </button>
            </div>
          )}
        </div>
      ))}
      {msg && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: msg.tipo === "ok" ? "#d1fae5" : "#fee2e2", color: msg.tipo === "ok" ? "#065f46" : "#991b1b", fontSize: 13, fontWeight: 600 }}>
          {msg.texto}
        </div>
      )}
    </div>
  );
}

// ── GERENCIAR GARÇONS ─────────────────────────────────────────
function GarcomManager({ garcons, onReload }) {
  const [novoForm, setNovoForm] = useState(false);
  const [novo, setNovo] = useState({ nome: "", pin: "" });
  const [editando, setEditando] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const inp = { width: "100%", padding: "9px 11px", border: "1.5px solid #e0e0e0", borderRadius: 9, fontSize: 14, color: "#333", outline: "none", boxSizing: "border-box" };

  function showMsg(texto, tipo = "ok") { setMsg({ texto, tipo }); setTimeout(() => setMsg(null), 3000); }

  async function criarGarcom() {
    if (!novo.nome.trim() || !novo.pin) return showMsg("Preencha nome e PIN.", "erro");
    setSaving(true);
    try {
      const res = await fetch(BACKEND_URL + "/garcons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: novo.nome.trim(), pin: novo.pin }),
      });
      const data = await res.json();
      if (!res.ok) return showMsg(data.erro || "Erro ao criar.", "erro");
      showMsg(`✅ ${novo.nome} cadastrado com sucesso!`);
      setNovo({ nome: "", pin: "" });
      setNovoForm(false);
      onReload();
    } catch { showMsg("Erro de conexão.", "erro"); }
    setSaving(false);
  }

  async function salvarEdicao() {
    setSaving(true);
    const body = { nome: editando.nome };
    if (editando.novoPin) body.pin = editando.novoPin;
    try {
      const res = await fetch(BACKEND_URL + "/garcons/" + editando._id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return showMsg(data.erro || "Erro ao salvar.", "erro");
      showMsg("✅ Alterações salvas!");
      setEditando(null);
      onReload();
    } catch { showMsg("Erro de conexão.", "erro"); }
    setSaving(false);
  }

  async function toggleAtivo(g) {
    try {
      await fetch(BACKEND_URL + "/garcons/" + g._id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: !g.ativo }),
      });
      onReload();
    } catch {}
  }

  async function deletarGarcom(g) {
    if (!window.confirm(`Remover ${g.nome}? Esta ação não pode ser desfeita.`)) return;
    try {
      await fetch(BACKEND_URL + "/garcons/" + g._id, { method: "DELETE" });
      showMsg(`${g.nome} removido.`, "ok");
      onReload();
    } catch { showMsg("Erro ao remover.", "erro"); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 14px", fontSize: 12, color: "#92400e" }}>
        ℹ️ Cada garçom tem um PIN único de 4 dígitos. Ao fazer login, todas as mesas abertas já saem com o nome dele.
      </div>

      {/* Métricas */}
      <div style={{ display: "flex", gap: 8 }}>
        <Metrica icon="🧑‍🍳" label="Garçons ativos" valor={garcons.filter(g => g.ativo).length} cor="#7b1a0a" />
        <Metrica icon="😴" label="Inativos" valor={garcons.filter(g => !g.ativo).length} cor="#aaa" />
      </div>

      <button onClick={() => setNovoForm(true)} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 12, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
        + Cadastrar novo garçom
      </button>

      {novoForm && (
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1.5px solid #7b1a0a", boxShadow: "0 2px 12px rgba(0,0,0,0.1)" }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>🧑‍🍳 Novo garçom</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 2 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Nome *</div>
              <input value={novo.nome} onChange={e => setNovo(p => ({ ...p, nome: e.target.value }))} placeholder="Ex: João Silva" style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>PIN (4 dígitos) *</div>
              <input type="password" inputMode="numeric" maxLength={4} value={novo.pin} onChange={e => setNovo(p => ({ ...p, pin: e.target.value.replace(/\D/g,"").slice(0,4) }))} placeholder="••••" style={{ ...inp, letterSpacing: 6, textAlign: "center" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={criarGarcom} disabled={saving} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
              {saving ? "Salvando..." : "✅ Cadastrar"}
            </button>
            <button onClick={() => { setNovoForm(false); setNovo({ nome: "", pin: "" }); }} style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          </div>
        </div>
      )}

      {/* Lista */}
      {garcons.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 0", color: "#ccc", fontSize: 14 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🧑‍🍳</div>
          Nenhum garçom cadastrado ainda
        </div>
      ) : garcons.map(g => (
        <div key={g._id} style={{ background: "#fff", borderRadius: 14, padding: 14, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", opacity: g.ativo ? 1 : 0.55 }}>
          {editando?._id === g._id ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#7b1a0a", marginBottom: 10 }}>✏️ Editando: {g.nome}</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 2 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Nome</div>
                  <input value={editando.nome} onChange={e => setEditando(p => ({ ...p, nome: e.target.value }))} style={inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>Novo PIN (opcional)</div>
                  <input type="password" inputMode="numeric" maxLength={4} value={editando.novoPin || ""} onChange={e => setEditando(p => ({ ...p, novoPin: e.target.value.replace(/\D/g,"").slice(0,4) }))} placeholder="••••" style={{ ...inp, letterSpacing: 6, textAlign: "center" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={salvarEdicao} disabled={saving} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "9px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{saving ? "Salvando..." : "💾 Salvar"}</button>
                <button onClick={() => setEditando(null)} style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "9px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 42, height: 42, borderRadius: "50%", background: corAvatar(g.nome), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16, flexShrink: 0 }}>
                {iniciais(g.nome)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{g.nome}</div>
                <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                  PIN: ••••  ·  <span style={{ color: g.ativo ? "#10b981" : "#ef4444", fontWeight: 600 }}>{g.ativo ? "Ativo" : "Inativo"}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button onClick={() => setEditando({ ...g, novoPin: "" })} style={{ background: "#dbeafe", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>✏️</button>
                <button onClick={() => toggleAtivo(g)} title={g.ativo ? "Desativar" : "Ativar"} style={{ background: g.ativo ? "#fee2e2" : "#d1fae5", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>{g.ativo ? "🔒" : "✅"}</button>
                <button onClick={() => deletarGarcom(g)} style={{ background: "#fee2e2", border: "none", borderRadius: 8, padding: "6px 8px", cursor: "pointer", fontSize: 14 }}>🗑️</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {msg && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: msg.tipo === "ok" ? "#d1fae5" : "#fee2e2", color: msg.tipo === "ok" ? "#065f46" : "#991b1b", fontSize: 13, fontWeight: 600 }}>
          {msg.texto}
        </div>
      )}
    </div>
  );
}

// ── ABA CONFIGURAÇÕES ─────────────────────────────────────────
function Configuracoes({ config, onSave, statusLoja, garcons, onReloadGarcons }) {
  const [cfg, setCfg] = useState(config);
  const [subAba, setSubAba] = useState("horario");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testeCEP, setTesteCEP] = useState("");
  const [resultadoCEP, setResultadoCEP] = useState(null);
  useEffect(() => { setCfg(config); }, [config]);
  async function salvar() { setSaving(true); await onSave(cfg); setSaving(false); setSaved(true); setTimeout(() => setSaved(false), 2500); }
  function setHorario(dia, campo, v) { setCfg(p => ({ ...p, horarioFuncionamento: { ...p.horarioFuncionamento, [dia]: { ...p.horarioFuncionamento[dia], [campo]: v } } })); }
  function setMensagem(campo, v) { setCfg(p => ({ ...p, mensagensAutomaticas: { ...p.mensagensAutomaticas, [campo]: v } })); }
  function setCEP(campo, v) { setCfg(p => ({ ...p, entregaCEP: { ...p.entregaCEP, [campo]: v } })); }
  function setFidelidade(campo, v) { setCfg(p => ({ ...p, fidelidade: { ...p.fidelidade, [campo]: v } })); }
  function setAvaliacao(campo, v) { setCfg(p => ({ ...p, avaliacao: { ...p.avaliacao, [campo]: v } })); }
  async function testarCEP() {
    try { const r = await fetch("https://viacep.com.br/ws/" + testeCEP.replace(/\D/g, "") + "/json/"); const d = await r.json(); setResultadoCEP({ valido: !d.erro, endereco: d.erro ? null : d.logradouro + ", " + d.bairro + " - " + d.localidade + "/" + d.uf }); } catch { setResultadoCEP({ valido: false }); }
  }
  const inputStyle = { width: "100%", padding: "8px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: statusLoja?.aberto ? "#d1fae5" : "#fee2e2", borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, border: "1.5px solid " + (statusLoja?.aberto ? "#10b981" : "#ef4444") }}>
        <div style={{ fontSize: 28 }}>{statusLoja?.aberto ? "✅" : "🔴"}</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, color: statusLoja?.aberto ? "#065f46" : "#991b1b" }}>Loja {statusLoja?.aberto ? "ABERTA" : "FECHADA"} agora</div>
          {!statusLoja?.aberto && <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 2 }}>Próxima abertura: {statusLoja?.proximaAbertura || "—"}</div>}
        </div>
      </div>
      <div style={{ display: "flex", background: "#f0f0f0", borderRadius: 10, padding: 3, gap: 1, flexWrap: "wrap" }}>
        {[["horario","🕐"],["mensagens","💬"],["entrega","📍"],["fidelidade","🏆"],["avaliacao","⭐"],["garcons","🧑‍🍳"],["pins","🔑"],["geral","⚙️"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubAba(k)} style={{ flexShrink: 0, padding: "7px 10px", borderRadius: 8, border: "none", background: subAba === k ? "#fff" : "transparent", color: subAba === k ? "#7b1a0a" : "#888", fontWeight: subAba === k ? 700 : 500, fontSize: 13, cursor: "pointer", boxShadow: subAba === k ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }}>{l}</button>
        ))}
      </div>

      {subAba === "horario" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 14 }}>📅 Horário de funcionamento</div>
          {Object.entries(cfg.horarioFuncionamento).map(([dia, h]) => (
            <div key={dia} style={{ borderBottom: "1px solid #f5f5f5", paddingBottom: 10, marginBottom: 10 }}>
              <Toggle value={h.aberto} onChange={v => setHorario(dia, "aberto", v)} label={DIAS_SEMANA[dia]} />
              {h.aberto && (
                <div style={{ display: "flex", gap: 10, marginTop: 4, paddingLeft: 4 }}>
                  {[["abertura","Abertura"],["fechamento","Fechamento"]].map(([campo, lbl]) => (
                    <div key={campo} style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3 }}>{lbl}</div>
                      <input type="time" value={h[campo]} onChange={e => setHorario(dia, campo, e.target.value)} style={inputStyle} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {subAba === "mensagens" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>💬 Mensagens automáticas</div>
          <Toggle value={cfg.mensagensAutomaticas.ativo} onChange={v => setMensagem("ativo", v)} label="Ativar mensagens automáticas" sub="Envia WhatsApp ao mudar status" />
          <div style={{ opacity: cfg.mensagensAutomaticas.ativo ? 1 : 0.4, pointerEvents: cfg.mensagensAutomaticas.ativo ? "auto" : "none", display: "flex", flexDirection: "column", gap: 12 }}>
            {[["preparando","🔥 Ao preparar"],["entrega","🛵 Ao sair"],["entregue","✅ Ao entregar"],["cancelado","❌ Ao cancelar"]].map(([k, l]) => (
              <div key={k}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>{l}</div>
                <textarea value={cfg.mensagensAutomaticas[k]} onChange={e => setMensagem(k, e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {subAba === "entrega" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>📍 Zona de entrega</div>
          <Toggle value={cfg.entregaCEP.ativo} onChange={v => setCEP("ativo", v)} label="Validar CEP antes de aceitar" sub="O bot verifica se está dentro do raio" />
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 2 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>CEP do estabelecimento</div><input value={cfg.entregaCEP.cepBase} onChange={e => setCEP("cepBase", e.target.value.replace(/\D/g, ""))} maxLength={8} style={inputStyle} /></div>
            <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Raio (km)</div><input type="number" value={cfg.entregaCEP.raioKm} onChange={e => setCEP("raioKm", parseInt(e.target.value))} style={inputStyle} /></div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={testeCEP} onChange={e => { setTesteCEP(e.target.value); setResultadoCEP(null); }} placeholder="Testar CEP..." maxLength={9} style={{ ...inputStyle, flex: 1 }} />
            <button onClick={testarCEP} disabled={!testeCEP} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "0 16px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Testar</button>
          </div>
          {resultadoCEP && (
            <div style={{ padding: "10px 12px", borderRadius: 10, background: resultadoCEP.valido ? "#d1fae5" : "#fee2e2", border: "1px solid " + (resultadoCEP.valido ? "#10b981" : "#ef4444") }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: resultadoCEP.valido ? "#065f46" : "#991b1b" }}>{resultadoCEP.valido ? "✅ Dentro da área" : "❌ Fora da área"}</div>
              {resultadoCEP.endereco && <div style={{ fontSize: 12, color: "#555", marginTop: 3 }}>{resultadoCEP.endereco}</div>}
            </div>
          )}
        </div>
      )}

      {subAba === "fidelidade" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🏆 Programa de fidelidade</div>
          <Toggle value={cfg.fidelidade.ativo} onChange={v => setFidelidade("ativo", v)} label="Ativar programa de fidelidade" sub="O bot avisa o cliente quando ganhar brinde" />
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Pedidos para ganhar</div><input type="number" value={cfg.fidelidade.pedidosParaGanhar} onChange={e => setFidelidade("pedidosParaGanhar", parseInt(e.target.value))} style={inputStyle} /></div>
            <div style={{ flex: 2 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Brinde</div><input value={cfg.fidelidade.brinde} onChange={e => setFidelidade("brinde", e.target.value)} placeholder="Ex: 1 espetinho grátis" style={inputStyle} /></div>
          </div>
          <div><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Mensagem ao ganhar</div><textarea value={cfg.fidelidade.mensagemGanhou} onChange={e => setFidelidade("mensagemGanhou", e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} /><div style={{ fontSize: 10, color: "#bbb", marginTop: 2 }}>Use {"{cliente}"}, {"{brinde}"}, {"{total}"} (total de pedidos)</div></div>
        </div>
      )}

      {subAba === "avaliacao" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>⭐ Avaliação pós-entrega</div>
          <Toggle value={cfg.avaliacao.ativo} onChange={v => setAvaliacao("ativo", v)} label="Ativar avaliação automática" sub="Envia mensagem pedindo nota após entrega" />
          <div><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Enviar após (minutos)</div><input type="number" value={cfg.avaliacao.delayMinutos} onChange={e => setAvaliacao("delayMinutos", parseInt(e.target.value))} style={inputStyle} /></div>
          <div><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Mensagem de avaliação</div><textarea value={cfg.avaliacao.mensagem} onChange={e => setAvaliacao("mensagem", e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} /></div>
          <div><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Mensagem de agradecimento</div><textarea value={cfg.avaliacao.mensagemObrigado} onChange={e => setAvaliacao("mensagemObrigado", e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} /></div>
        </div>
      )}

      {subAba === "garcons" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🧑‍🍳 Gerenciar Garçons</div>
          <GarcomManager garcons={garcons} onReload={onReloadGarcons} />
        </div>
      )}

      {subAba === "pins" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🔑 PINs de acesso</div>
          <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e" }}>
            ⚠️ Altere os PINs com cuidado. Informe os novos PINs aos funcionários antes de salvar.
          </div>
          <PinManager />
        </div>
      )}

      {subAba === "geral" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>⚙️ Geral</div>
          {[["nomeEstabelecimento","Nome do estabelecimento"],["nomeAgente","Nome do agente IA"]].map(([campo, lbl]) => (
            <div key={campo}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>{lbl}</div><input value={cfg[campo]} onChange={e => setCfg(p => ({ ...p, [campo]: e.target.value }))} style={inputStyle} /></div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            {[["taxaEntrega","Taxa (R$)","number",0.5],["tempoEntregaMin","Mín. (min)","number",1],["tempoEntregaMax","Máx. (min)","number",1]].map(([campo, lbl, type, step]) => (
              <div key={campo} style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>{lbl}</div><input type={type} step={step} value={cfg[campo]} onChange={e => setCfg(p => ({ ...p, [campo]: parseFloat(e.target.value) }))} style={inputStyle} /></div>
            ))}
          </div>
        </div>
      )}

      <button onClick={salvar} disabled={saving} style={{ background: saved ? "#10b981" : saving ? "#aaa" : "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 12, padding: "13px 0", fontWeight: 800, fontSize: 15, cursor: saving ? "not-allowed" : "pointer", transition: "all 0.2s" }}>
        {saved ? "✅ Salvo!" : saving ? "Salvando..." : "💾 Salvar configurações"}
      </button>
    </div>
  );
}

// ── ABA RELATÓRIOS ────────────────────────────────────────────
function totMesaRel(m) { return totMesaCompleta(m); }

function Relatorios({ pedidos, faturadoSalao = 0, mesasSalao = [], setMesasSalaoRel, historicoSalao = [], onZerarSalao, setHistoricoSalao, setFaturadoSalaoRel }) {
  const [periodo, setPeriodo] = useState("semana");
  const [subAba, setSubAba] = useState("geral");
  const [vendaAberta, setVendaAberta] = useState(null);
  const [zerarAberto, setZerarAberto] = useState(false);
  const [relGarcons, setRelGarcons] = useState([]);
  const [loadingGarcons, setLoadingGarcons] = useState(false);

  async function carregarRelGarcons() {
    setLoadingGarcons(true);
    try {
      const res = await fetch(BACKEND_URL + "/garcons/relatorio");
      if (res.ok) setRelGarcons(await res.json());
    } catch {}
    setLoadingGarcons(false);
  }

  useEffect(() => {
    if (subAba === "garcons") carregarRelGarcons();
  }, [subAba]);

  const entregues = pedidos.filter(p => p.status === "entregue");
  const diasFiltro = { hoje: 0, semana: 6, mes: 29 }[periodo];
  const corte = new Date(); corte.setDate(corte.getDate() - diasFiltro); corte.setHours(0, 0, 0, 0);
  const pp = entregues.filter(p => new Date(p.horario) >= corte);
  const totalDelivery = pp.reduce((s, p) => s + calcTotal(p.itens, p.desconto || 0), 0);
  const totalDescontos = pp.reduce((s, p) => s + (p.desconto || 0), 0);
  const ticket = pp.length > 0 ? totalDelivery / pp.length : 0;

  // Faturamento do salão — mesas abertas + já fechadas
  const totalSalaoAberto = mesasSalao.reduce((s, m) => {
    const itens = m.itens.reduce((ss, i) => ss + (i.qty||1) * i.preco, 0);
    const rodadas = m.rodadas.reduce((ss, r) => ss + r.itens.reduce((sss, i) => sss + (i.qty||1) * i.preco, 0), 0);
    return s + itens + rodadas;
  }, 0);
  const totalSalao = faturadoSalao + totalSalaoAberto;
  const totalGeral = totalDelivery + totalSalao;

  // Itens mais vendidos — delivery + salão
  const ci = {};
  pp.forEach(p => p.itens.forEach(i => { ci[i.nome] = (ci[i.nome] || 0) + (i.qty || 1); }));
  historicoSalao.forEach(v => v.itens.forEach(i => { ci[i.nome] = (ci[i.nome] || 0) + (i.qty || 1); }));
  const mv = Object.entries(ci).sort((a, b) => b[1] - a[1])[0];
  const ri = Object.entries(ci).sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Ranking por dia da semana — delivery + salão
  const ds = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const porDia = ds.map((nome, idx) => {
    const pedidosDia = entregues.filter(p => new Date(p.horario).getDay() === idx);
    const fatDelivery = pedidosDia.reduce((s, p) => s + calcTotal(p.itens, p.desconto || 0), 0);
    const fatSalao = historicoSalao.filter(v => new Date(v.fechamento).getDay() === idx).reduce((s, v) => s + v.total, 0);
    const fat = fatDelivery + fatSalao;
    return { nome, fat, qtd: pedidosDia.length + historicoSalao.filter(v => new Date(v.fechamento).getDay() === idx).length };
  });
  const maxDia = Math.max(...porDia.map(d => d.fat), 1);
  const melhorDia = [...porDia].sort((a,b) => b.fat - a.fat)[0];

  // Barras do gráfico temporal — delivery + salão
  let barras = [];
  if (periodo === "hoje") {
    for (let h = 11; h <= 23; h += 2) {
      const vDel = pp.filter(p => { const hr = new Date(p.horario).getHours(); return hr >= h && hr < h + 2; }).reduce((s, p) => s + calcTotal(p.itens, p.desconto), 0);
      const vSal = historicoSalao.filter(v => { const hr = new Date(v.fechamento).getHours(); return hr >= h && hr < h + 2; }).reduce((s, v) => s + v.total, 0);
      barras.push({ label: h + "h", valor: vDel + vSal, destaque: new Date().getHours() >= h && new Date().getHours() < h + 2 });
    }
  } else if (periodo === "semana") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const vDel = entregues.filter(p => isMesmosDias(p.horario, d)).reduce((s, p) => s + calcTotal(p.itens, p.desconto), 0);
      const vSal = historicoSalao.filter(v => isMesmosDias(v.fechamento, d)).reduce((s, v) => s + v.total, 0);
      barras.push({ label: i === 0 ? "Hoje" : ds[d.getDay()], valor: vDel + vSal, destaque: i === 0 });
    }
  } else {
    for (let s = 3; s >= 0; s--) {
      const ini = new Date(); ini.setDate(ini.getDate() - s * 7 - 6); ini.setHours(0, 0, 0, 0);
      const fim = new Date(); fim.setDate(fim.getDate() - s * 7); fim.setHours(23, 59, 59, 999);
      const vDel = entregues.filter(p => new Date(p.horario) >= ini && new Date(p.horario) <= fim).reduce((s, p) => s + calcTotal(p.itens, p.desconto), 0);
      const vSal = historicoSalao.filter(v => new Date(v.fechamento) >= ini && new Date(v.fechamento) <= fim).reduce((s, v) => s + v.total, 0);
      barras.push({ label: s === 0 ? "Esta sem." : "Sem. -" + s, valor: vDel + vSal, destaque: s === 0 });
    }
  }
  const maxB = Math.max(...barras.map(b => b.valor), 1);

  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>

      {/* Período */}
      <div style={{ display: "flex", gap: 8, background: "#fff", borderRadius: 12, padding: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.07)" }}>
        {[["hoje","Hoje"],["semana","7 dias"],["mes","30 dias"]].map(([k, l]) => (
          <button key={k} onClick={() => setPeriodo(k)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", background: periodo === k ? "#7b1a0a" : "transparent", color: periodo === k ? "#fff" : "#888", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{l}</button>
        ))}
      </div>

      {/* Sub-abas */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[["geral","📊 Geral"],["vendas","🧾 Vendas"],["diasemana","📅 Por dia"],["ranking","🏆 Ranking"],["garcons","🧑‍🍳 Garçons"]].map(([k,l]) => (
          <button key={k} onClick={() => setSubAba(k)} style={{ flex:1, padding:"8px 4px", borderRadius:10, border:"none", background:subAba===k?"#7b1a0a":"#f0f0f0", color:subAba===k?"#fff":"#666", fontWeight:subAba===k?700:500, fontSize:12, cursor:"pointer", whiteSpace:"nowrap" }}>{l}</button>
        ))}
      </div>

      {/* GERAL */}
      {subAba === "geral" && <>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Metrica icon="💰" label="Total geral" valor={"R$ " + totalGeral.toFixed(2)} cor="#7b1a0a" />
          <Metrica icon="🛵" label="Delivery" valor={"R$ " + totalDelivery.toFixed(2)} sub={pp.length + " pedido" + (pp.length !== 1 ? "s" : "")} cor="#10b981" />
          <Metrica icon="🍽️" label="Salão" valor={"R$ " + totalSalao.toFixed(2)} cor="#3b82f6" />
          <Metrica icon="🏆" label="Mais vendido" valor={mv ? mv[1] + "x" : "—"} sub={mv ? mv[0] : ""} cor="#f59e0b" />
          {totalDescontos > 0 && <Metrica icon="🎟️" label="Descontos" valor={"R$ " + totalDescontos.toFixed(2)} sub="via cupons" cor="#8b5cf6" />}
        </div>
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px 14px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>📊 {periodo === "hoje" ? "Por hora" : periodo === "semana" ? "Por dia" : "Por semana"}</div>
          <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: 120 }}>
            {barras.map((b, i) => <Barra key={i} label={b.label} valor={b.valor} maximo={maxB} destaque={b.destaque} />)}
          </div>
        </div>
      </>}

      {/* VENDAS DO SALÃO */}
      {subAba === "vendas" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Resumo */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Metrica icon="🧾" label="Vendas hoje" valor={historicoSalao.length} sub={historicoSalao.length === 0 ? "nenhuma ainda" : "mesas fechadas"} cor="#7b1a0a" />
            <Metrica icon="💰" label="Total salão" valor={"R$ " + (faturadoSalao + mesasSalao.reduce((s,m)=>s+totMesaRel(m),0)).toFixed(2)} cor="#10b981" />
            <Metrica icon="🧑‍🍳" label="Garçons" valor={[...new Set(historicoSalao.map(v=>v.garcom).filter(g=>g!=="—"))].length || "—"} cor="#3b82f6" />
          </div>

          {/* Botão zerar operação */}
          <div style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 6 }}>🔄 Fechar turno</div>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Todas as vendas já estão salvas no banco de dados. Ao fechar o turno, a tela é resetada para o próximo dia — sem perder nenhum dado.</div>
            {!zerarAberto ? (
              <button onClick={() => setZerarAberto(true)} style={{ background: "#fee2e2", color: "#ef4444", border: "1.5px solid #ef4444", borderRadius: 10, padding: "9px 20px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                🔄 Zerar operação
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ background: "#fef3c7", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "#92400e", fontWeight: 600 }}>
                  ⚠️ Esta ação não pode ser desfeita. Tem certeza?
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => {
                    // Zera histórico de vendas
                    if (setHistoricoSalao) setHistoricoSalao([]);
                    // Zera faturamento acumulado
                    if (setFaturadoSalaoRel) setFaturadoSalaoRel(0);
                    // Libera todas as mesas
                    if (setMesasSalaoRel) setMesasSalaoRel(p => [...MESAS_ESPECIAIS_BASE, ...p.filter(m=>!m.tipo).map((_,i)=>initMesa(i))]);
                    // Limpa localStorage do salão
                    try {
                      localStorage.removeItem("imperio_faturado_salao");
                      localStorage.removeItem("imperio_mesas_salao");
                      localStorage.removeItem("imperio_historico_salao");
                      localStorage.removeItem("imperio_faturado_dia");
                      localStorage.removeItem("imperio_mesas_dia");
                      localStorage.removeItem("imperio_historico_dia");
                    } catch {}
                    setZerarAberto(false);
                  }} style={{ flex: 1, background: "#ef4444", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>✅ Confirmar</button>
                  <button onClick={() => setZerarAberto(false)} style={{ flex: 1, background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
                </div>
              </div>
            )}
          </div>



          {/* Lista de vendas */}
          {historicoSalao.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "#ccc" }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🧾</div>
              <div>Nenhuma venda registrada hoje</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...historicoSalao].reverse().map(v => (
                <div key={v.id} style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", border: vendaAberta === v.id ? "2px solid #7b1a0a" : "2px solid transparent" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setVendaAberta(vendaAberta === v.id ? null : v.id)}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>Mesa {v.mesa} {v.cliente !== "—" ? `— ${v.cliente}` : ""}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                        👤 {v.garcom} · {new Date(v.fechamento).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
                        {v.abertura && ` · ⏱️ ${Math.round((new Date(v.fechamento)-new Date(v.abertura))/60000)}min`}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 800, fontSize: 16, color: "#7b1a0a" }}>R$ {v.total.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: "#888" }}>{v.pagamento === "pix" ? "🟢 Pix" : v.pagamento === "cartao" ? "💳 Cartão" : "💵 Dinheiro"}</div>
                    </div>
                  </div>
                  {vendaAberta === v.id && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #f0f0f0" }}>
                      {v.itens.map((it,i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: "#555" }}>
                          <span>{it.qty}x {it.nome}</span>
                          <span>R$ {(it.qty*it.preco).toFixed(2)}</span>
                        </div>
                      ))}
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.grayL}`, display:"flex", gap:8 }}>
                        <button onClick={(e)=>{
                          e.stopPropagation();
                          const win = window.open('','_blank','width=400,height=600');
                          win.document.write(`<!DOCTYPE html><html><head><title>Venda Mesa ${v.mesa}</title><style>
                            body{font-family:'Courier New',monospace;padding:20px;max-width:320px;margin:0 auto}
                            h2{text-align:center;font-size:16px;margin-bottom:4px}
                            .sub{text-align:center;font-size:12px;color:#666;margin-bottom:16px}
                            .linha{display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-bottom:1px dashed #eee}
                            .total{display:flex;justify-content:space-between;font-size:15px;font-weight:bold;padding:8px 0;border-top:2px solid #000;margin-top:8px}
                            .info{font-size:12px;color:#555;margin-bottom:10px}
                            .rodape{text-align:center;font-size:11px;color:#999;margin-top:16px}
                            @media print{button{display:none}}
                          </style></head><body>
                            <h2>👑 Império dos Espetos</h2>
                            <div class="sub">Relatório de Venda — Mesa ${v.mesa}</div>
                            <div class="info">${v.cliente&&v.cliente!=='—'?'Cliente: '+v.cliente+'<br>':''}${v.garcom&&v.garcom!=='—'?'Garçom: '+v.garcom+'<br>':''}Fechamento: ${new Date(v.fechamento).toLocaleString('pt-BR',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})}</div>
                            ${v.itens.map(it=>`<div class="linha"><span>${it.qty||1}x ${it.nome}</span><span>R$ ${((it.qty||1)*it.preco).toFixed(2)}</span></div>`).join('')}
                            <div class="total"><span>TOTAL</span><span>R$ ${v.total.toFixed(2)}</span></div>
                            <div class="info" style="margin-top:10px">Pagamento: ${v.pagamento==='pix'?'Pix':v.pagamento==='cartao'?'Cartão':'Dinheiro'}</div>
                            <div class="rodape">Obrigado! 🍢</div>
                            <br><button onclick="window.print()">🖨️ Imprimir</button>
                          </body></html>`);
                          win.document.close();
                          setTimeout(()=>win.print(),500);
                        }} style={{ flex:1, background:T.grayLL, color:T.gray, border:`1px solid ${T.grayL}`, borderRadius:T.radiusS, padding:"8px 0", fontWeight:600, fontSize:12, cursor:"pointer" }}>
                          🖨️ Imprimir
                        </button>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          if (window.confirm(`Excluir venda da Mesa ${v.mesa} (R$ ${v.total.toFixed(2)})?`)) {
                            // Remove do MongoDB se tiver _id
                            if (v._id) {
                              try { await fetch(BACKEND_URL + "/vendas-salao/" + v._id, { method: "DELETE" }); } catch {}
                            }
                            if (setHistoricoSalao) setHistoricoSalao(h => h.filter(x => x.id !== v.id));
                            if (setFaturadoSalaoRel) setFaturadoSalaoRel(f => Math.max(0, f - v.total));
                            setVendaAberta(null);
                          }
                        }} style={{ background: "#fee2e2", color: "#ef4444", border: "1.5px solid #ef4444", borderRadius: 10, padding: "8px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", width: "100%" }}>
                          🗑️ Excluir
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* POR DIA DA SEMANA */}
      {subAba === "diasemana" && <>
        <div style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", borderRadius: 14, padding: "14px 16px", color: "#fff" }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>Melhor dia da semana</div>
          <div style={{ fontWeight: 800, fontSize: 20, marginTop: 4 }}>📅 {melhorDia.nome}</div>
          <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>R$ {melhorDia.fat.toFixed(2)} · {melhorDia.qtd} pedidos</div>
        </div>
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 14 }}>Faturamento por dia da semana</div>
          {porDia.map((d, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 5 }}>
                <span style={{ fontWeight: 600, color: "#333" }}>{d.nome}</span>
                <span style={{ color: "#888", fontSize: 12 }}>{d.qtd} pedido{d.qtd !== 1 ? "s" : ""} · <span style={{ fontWeight: 700, color: "#7b1a0a" }}>R$ {d.fat.toFixed(2)}</span></span>
              </div>
              <div style={{ height: 8, background: "#f0f0f0", borderRadius: 4 }}>
                <div style={{ height: "100%", width: ((d.fat / maxDia) * 100) + "%", background: d.fat === melhorDia.fat ? "linear-gradient(90deg,#f59e0b,#d97706)" : "linear-gradient(90deg,#c0392b,#7b1a0a)", borderRadius: 4, transition: "width 0.6s", minWidth: d.fat > 0 ? 4 : 0 }} />
              </div>
            </div>
          ))}
        </div>
      </>}

      {/* RANKING ITENS */}
      {subAba === "ranking" && <>
        {ri.length === 0
          ? <div style={{ textAlign: "center", padding: "40px 0", color: "#ccc" }}>Nenhum dado no período</div>
          : <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 14 }}>🏆 Itens mais pedidos</div>
              {ri.map(([nome, qty], i) => (
                <div key={nome} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                    <span style={{ color: "#333", fontWeight: i < 3 ? 700 : 400 }}>{["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣"][i]} {nome}</span>
                    <span style={{ fontWeight: 700, color: "#7b1a0a" }}>{qty}x</span>
                  </div>
                  <div style={{ height: 6, background: "#f0f0f0", borderRadius: 3 }}>
                    <div style={{ height: "100%", width: ((qty / ri[0][1]) * 100) + "%", background: i === 0 ? "linear-gradient(90deg,#f59e0b,#d97706)" : "linear-gradient(90deg,#c0392b,#7b1a0a)", borderRadius: 3, transition: "width 0.6s" }} />
                  </div>
                </div>
              ))}
            </div>
        }
      </>}

      {/* DESEMPENHO GARÇONS */}
      {subAba === "garcons" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🧑‍🍳 Desempenho dos Garçons</div>
            <button onClick={carregarRelGarcons} disabled={loadingGarcons} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#555" }}>
              {loadingGarcons ? "⏳" : "↻ Atualizar"}
            </button>
          </div>

          {/* Métricas gerais */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Metrica icon="🧑‍🍳" label="Garçons ativos" valor={relGarcons.length} cor="#7b1a0a" />
            <Metrica icon="🧾" label="Total de vendas" valor={relGarcons.reduce((s,g)=>s+g.vendas,0)} cor="#3b82f6" />
            <Metrica icon="💰" label="Faturamento" valor={"R$ " + relGarcons.reduce((s,g)=>s+g.total,0).toFixed(2)} cor="#10b981" />
          </div>

          {relGarcons.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#ccc" }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🧑‍🍳</div>
              <div>{loadingGarcons ? "Carregando..." : "Nenhum dado encontrado. As vendas do salão precisam ter garçom identificado."}</div>
            </div>
          ) : (
            <>
              {/* Líder */}
              {relGarcons[0] && (
                <div style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", borderRadius: 14, padding: "16px", color: "#fff", display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>🥇</div>
                  <div>
                    <div style={{ fontSize: 11, opacity: 0.8, textTransform: "uppercase", letterSpacing: 1 }}>Melhor desempenho</div>
                    <div style={{ fontWeight: 800, fontSize: 20 }}>{relGarcons[0].nome}</div>
                    <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>
                      R$ {relGarcons[0].total.toFixed(2)} · {relGarcons[0].vendas} venda{relGarcons[0].vendas !== 1 ? "s" : ""} · ticket médio R$ {relGarcons[0].ticketMedio.toFixed(2)}
                    </div>
                  </div>
                </div>
              )}

              {/* Tabela de todos */}
              <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 14 }}>📊 Ranking completo</div>
                {relGarcons.map((g, i) => {
                  const maxTotal = relGarcons[0]?.total || 1;
                  const pct = (g.total / maxTotal) * 100;
                  return (
                    <div key={g.nome} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: i < relGarcons.length - 1 ? "1px dashed #f0f0f0" : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                        <div style={{ width: 40, height: 40, borderRadius: "50%", background: corAvatar(g.nome), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 15, flexShrink: 0 }}>
                          {iniciais(g.nome)}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>
                              {["🥇","🥈","🥉"][i] || `${i+1}º`} {g.nome}
                            </div>
                            <div style={{ fontWeight: 800, fontSize: 15, color: "#7b1a0a" }}>R$ {g.total.toFixed(2)}</div>
                          </div>
                          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                            {g.vendas} venda{g.vendas !== 1 ? "s" : ""} · {g.mesas} mesa{g.mesas !== 1 ? "s" : ""} · ticket médio R$ {g.ticketMedio.toFixed(2)}
                            {g.itemMaisVendido && g.itemMaisVendido !== "—" && ` · ❤️ ${g.itemMaisVendido}`}
                          </div>
                        </div>
                      </div>
                      <div style={{ height: 8, background: "#f0f0f0", borderRadius: 4 }}>
                        <div style={{ height: "100%", width: pct + "%", background: i === 0 ? "linear-gradient(90deg,#f59e0b,#d97706)" : "linear-gradient(90deg,#c0392b,#7b1a0a)", borderRadius: 4, transition: "width 0.6s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

    </div>
  );
}

// ── ABA CLIENTES ──────────────────────────────────────────────
function Clientes({ pedidos }) {
  const [busca, setBusca] = useState(""); const [sel, setSel] = useState(null); const [ord, setOrd] = useState("gasto");
  const cm = {}; pedidos.forEach(p => { if (!cm[p.telefone]) cm[p.telefone] = { nome: p.cliente, telefone: p.telefone, pedidos: [] }; cm[p.telefone].pedidos.push(p); });
  const clientes = Object.values(cm).map(c => {
    const ent = c.pedidos.filter(p => p.status === "entregue");
    const tg = ent.reduce((s, p) => s + calcTotal(p.itens, p.desconto), 0);
    const ci = {}; ent.forEach(p => p.itens.forEach(i => { ci[i.nome] = (ci[i.nome] || 0) + (i.qty || 1); }));
    const fav = Object.entries(ci).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
    const ds = c.pedidos.map(p => new Date(p.horario)).sort((a, b) => a - b);
    return { ...c, totalGasto: tg, ticketMedio: ent.length > 0 ? tg / ent.length : 0, totalPedidos: c.pedidos.length, entregues: ent.length, primeiroPedido: ds[0], ultimoPedido: ds[ds.length - 1], favoritos: fav };
  });
  const cf = clientes.filter(c => c.nome.toLowerCase().includes(busca.toLowerCase()) || c.telefone.includes(busca)).sort((a, b) => ord === "gasto" ? b.totalGasto - a.totalGasto : ord === "pedidos" ? b.totalPedidos - a.totalPedidos : new Date(b.ultimoPedido) - new Date(a.ultimoPedido));
  const cd = sel ? clientes.find(c => c.telefone === sel) : null;
  if (cd) {
    return (
      <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
        <button onClick={() => setSel(null)} style={{ background: "none", border: "none", color: "#7b1a0a", fontWeight: 700, fontSize: 14, cursor: "pointer", textAlign: "left", padding: 0 }}>← Voltar</button>
        <div style={{ background: "#fff", borderRadius: 14, padding: "20px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", background: corAvatar(cd.nome), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 20, flexShrink: 0 }}>{iniciais(cd.nome)}</div>
          <div><div style={{ fontWeight: 800, fontSize: 17, color: "#1a1a1a" }}>{cd.nome}</div><div style={{ fontSize: 13, color: "#888", marginTop: 2 }}>📞 {cd.telefone}</div><div style={{ fontSize: 12, color: "#aaa", marginTop: 2 }}>Cliente desde {dataFmt(cd.primeiroPedido)}</div></div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Metrica icon="💰" label="Total gasto" valor={"R$ " + cd.totalGasto.toFixed(2)} cor="#10b981" />
          <Metrica icon="📦" label="Pedidos" valor={cd.totalPedidos} sub={cd.entregues + " entregues"} cor="#3b82f6" />
          <Metrica icon="🎯" label="Ticket médio" valor={"R$ " + cd.ticketMedio.toFixed(2)} cor="#7b1a0a" />
        </div>
        {cd.favoritos.length > 0 && (
          <div style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 10 }}>❤️ Favoritos</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {cd.favoritos.map((f, i) => <span key={i} style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600 }}>{["🥇","🥈","🥉"][i]} {f}</span>)}
            </div>
          </div>
        )}
        <div style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>🧾 Histórico</div>
          {[...cd.pedidos].sort((a, b) => new Date(b.horario) - new Date(a.horario)).map(p => (
            <div key={p.id} style={{ borderBottom: "1px solid #f5f5f5", paddingBottom: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <div><span style={{ fontWeight: 700, fontSize: 13 }}>Pedido #{p.id}</span><div style={{ fontSize: 11, color: "#aaa", marginTop: 1 }}>{dtFmt(p.horario)}</div></div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <Badge status={p.status} />
                  <span style={{ fontWeight: 800, fontSize: 14, color: "#7b1a0a" }}>R$ {calcTotal(p.itens, p.desconto).toFixed(2)}</span>
                  {p.desconto > 0 && <span style={{ fontSize: 11, color: "#8b5cf6" }}>🎟️ -{p.desconto.toFixed(2)}</span>}
                </div>
              </div>
              <div style={{ background: "#fafafa", borderRadius: 8, padding: "8px 10px" }}>
                {p.itens.map((it, idx) => <div key={idx} style={{ fontSize: 12, color: "#555", padding: "2px 0", display: "flex", justifyContent: "space-between" }}><span>{it.qty || 1}x {it.nome}</span><span style={{ color: "#999" }}>R$ {((it.qty || 1) * it.preco).toFixed(2)}</span></div>)}
              </div>
              {p.obs && <div style={{ fontSize: 12, color: "#92400e", marginTop: 6 }}>⚠️ {p.obs}</div>}
              {p.cupom && <div style={{ fontSize: 11, color: "#8b5cf6", marginTop: 4 }}>🎟️ Cupom: {p.cupom}</div>}
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "10px 14px", boxShadow: "0 2px 8px rgba(0,0,0,0.07)", display: "flex", alignItems: "center", gap: 8 }}>
        <span>🔍</span><input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por nome ou telefone..." style={{ border: "none", outline: "none", flex: 1, fontSize: 14, color: "#333", background: "transparent" }} />
      </div>
      <div style={{ display: "flex", gap: 7 }}>
        {[["gasto","💰 Maior gasto"],["pedidos","📦 Mais pedidos"],["recente","🕐 Mais recente"]].map(([k, l]) => (
          <button key={k} onClick={() => setOrd(k)} style={{ flex: 1, padding: "7px 4px", borderRadius: 20, border: "none", background: ord === k ? "#7b1a0a" : "#f0f0f0", color: ord === k ? "#fff" : "#666", fontWeight: ord === k ? 700 : 500, fontSize: 11, cursor: "pointer", whiteSpace: "nowrap" }}>{l}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Metrica icon="👥" label="Clientes únicos" valor={clientes.length} cor="#7b1a0a" />
        <Metrica icon="🔁" label="Clientes fiéis" valor={clientes.filter(c => c.totalPedidos > 1).length} sub="2+ pedidos" cor="#8b5cf6" />
      </div>
      {cf.map(c => (
        <div key={c.telefone} onClick={() => setSel(c.telefone)} style={{ background: "#fff", borderRadius: 14, padding: "14px 16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }} onMouseEnter={e => e.currentTarget.style.boxShadow = "0 4px 20px rgba(123,26,10,0.12)"} onMouseLeave={e => e.currentTarget.style.boxShadow = "0 2px 10px rgba(0,0,0,0.07)"}>
          <div style={{ width: 46, height: 46, borderRadius: "50%", background: corAvatar(c.nome), display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16, flexShrink: 0 }}>{iniciais(c.nome)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#1a1a1a" }}>{c.nome}</div>
            <div style={{ fontSize: 12, color: "#aaa", marginTop: 1 }}>📞 {c.telefone}</div>
            {c.favoritos.length > 0 && <div style={{ fontSize: 11, color: "#888", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>❤️ {c.favoritos[0]}{c.favoritos[1] ? ", " + c.favoritos[1] : ""}</div>}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: "#7b1a0a" }}>R$ {c.totalGasto.toFixed(2)}</div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>{c.totalPedidos} pedido{c.totalPedidos !== 1 ? "s" : ""}</div>
            <div style={{ fontSize: 10, color: "#bbb", marginTop: 1 }}>{tempoAtras(c.ultimoPedido)}</div>
          </div>
          <div style={{ color: "#ddd", fontSize: 16 }}>›</div>
        </div>
      ))}
    </div>
  );
}

// ── CARD PEDIDO ───────────────────────────────────────────────
function PedidoCard({ pedido, onStatus, expanded, onToggle, atualizando }) {
  const total = calcTotal(pedido.itens, pedido.desconto || 0);
  const sc = STATUS_CONFIG[pedido.status] || STATUS_CONFIG.novo;
  const nxt = { novo: "preparando", preparando: "entrega", entrega: "entregue" }[pedido.status];
  const isNovo = pedido.status === "novo";
  return (
    <div style={{ background: T.white, borderRadius: T.radius, boxShadow: isNovo ? `0 0 0 2px ${T.amber}, ${T.shadowM}` : T.shadow, overflow: "hidden", opacity: atualizando ? 0.6 : 1, transition: "all 0.2s", border: `1px solid ${isNovo ? T.amber+"40" : T.grayL}` }}>
      <div onClick={onToggle} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, borderLeft: `3px solid ${sc.color}`, userSelect: "none" }}>
        <div style={{ width: 42, height: 42, borderRadius: T.radiusS, background: sc.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0, border: `1px solid ${sc.color}20` }}>{atualizando ? "⏳" : sc.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: T.dark, fontFamily:"'DM Sans',sans-serif" }}>#{pedido.id} — {pedido.cliente}</span>
            <Badge status={pedido.status} />
            {pedido.cupom && <span style={{ background: T.purpleL, color: T.purple, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 600 }}>🎟️ {pedido.cupom}</span>}
          </div>
          <div style={{ fontSize: 12, color: T.gray, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {pedido.endereco}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.wine }}>R$ {total.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: T.gray, marginTop: 1 }}>⏱️ {pedido.tempoPreparo || "—"}min</div>
        </div>
        <div style={{ color: T.grayL, fontSize: 16, flexShrink: 0 }}>{expanded ? "▴" : "▾"}</div>
      </div>
      {expanded && (
        <div style={{ borderTop: `1px solid ${T.grayL}`, padding: "14px 16px", background: T.grayLL }}>
          <div style={{ background: T.white, borderRadius: T.radiusS, padding: "12px", marginBottom: 12, border: `1px solid ${T.grayL}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.gray, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Itens do pedido</div>
            {(pedido.itens || []).map((it, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${T.grayL}`, fontSize: 13, color: T.dark }}>
                <span style={{ color: T.gray }}>{it.qty || 1}× <span style={{ color: T.dark }}>{it.nome}</span></span>
                <span style={{ fontWeight: 600, color: T.dark }}>R$ {((it.qty || 1) * it.preco).toFixed(2)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, color: T.gray }}><span>Taxa de entrega</span><span>R$ 5,00</span></div>
            {pedido.desconto > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, color: T.purple }}><span>🎟️ Desconto ({pedido.cupom})</span><span>−R$ {pedido.desconto.toFixed(2)}</span></div>}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTop: `1px solid ${T.grayL}`, fontSize: 15, fontWeight: 700, color: T.wine }}><span>Total</span><span>R$ {total.toFixed(2)}</span></div>
          </div>
          {pedido.obs && <div style={{ background: T.amberL, border: `1px solid ${T.amber}40`, borderRadius: T.radiusS, padding: "8px 12px", marginBottom: 12, fontSize: 13, color: T.amber }}>⚠️ <strong>Obs:</strong> {pedido.obs}</div>}
          <div style={{ fontSize: 12, color: T.gray, marginBottom: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>📞 {pedido.telefone}</span>
            <span>🕐 {horaFmt(pedido.horario)}</span>
            {pedido.tempoPreparo && <span>⏱️ ~{pedido.tempoPreparo}min</span>}
          </div>
          {pedido.status !== "entregue" && pedido.status !== "cancelado" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {nxt && <button onClick={() => onStatus(pedido.id, nxt)} disabled={atualizando} style={{ flex: 1, minWidth: 140, background: atualizando ? T.grayL : `linear-gradient(135deg,${T.wineD},${T.wine})`, color: T.white, border: "none", borderRadius: T.radiusS, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily:"'DM Sans',sans-serif" }}>{STATUS_CONFIG[nxt].icon} {STATUS_CONFIG[nxt].label}</button>}
              <button onClick={() => onStatus(pedido.id, "cancelado")} disabled={atualizando} style={{ background: T.white, color: T.red, border: `1.5px solid ${T.red}`, borderRadius: T.radiusS, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily:"'DM Sans',sans-serif" }}>❌ Cancelar</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── CARDÁPIO DO SALÃO ─────────────────────────────────────────
const CARDAPIO_SALAO = [
  { id:1,  cat:"Tradicionais",    nome:"Alcatra",                 preco:9.00  },
  { id:2,  cat:"Tradicionais",    nome:"Alcatra com legumes",     preco:9.00  },
  { id:3,  cat:"Tradicionais",    nome:"Frango",                  preco:9.00  },
  { id:4,  cat:"Tradicionais",    nome:"Frango com legumes",      preco:9.00  },
  { id:5,  cat:"Tradicionais",    nome:"Tulipa na mostarda",      preco:9.00  },
  { id:6,  cat:"Tradicionais",    nome:"Linguiça",                preco:9.00  },
  { id:7,  cat:"Tradicionais",    nome:"Coraçãozinho de frango",  preco:9.00  },
  { id:8,  cat:"Tradicionais",    nome:"Panceta suína",           preco:9.00  },
  { id:9,  cat:"Tradicionais",    nome:"Pão de alho",             preco:8.00  },
  { id:10, cat:"Especiais",       nome:"Picanha meia lua",        preco:15.00 },
  { id:11, cat:"Especiais",       nome:"Cordeiro",                preco:13.00 },
  { id:12, cat:"Especiais",       nome:"Kafta com queijo",        preco:11.00 },
  { id:13, cat:"Especiais",       nome:"Medalhão frango",         preco:11.00 },
  { id:14, cat:"Especiais",       nome:"Medalhão mignon",         preco:11.00 },
  { id:15, cat:"Especiais",       nome:"Medalhão suíno",          preco:11.00 },
  { id:16, cat:"Especiais",       nome:"Queijo coalho",           preco:10.00 },
  { id:17, cat:"Especiais",       nome:"Churrasco Grego",         preco:18.00 },
  { id:18, cat:"Doces",           nome:"Romeu e Julieta",         preco:11.00 },
  { id:19, cat:"Doces",           nome:"Morango com chocolate",   preco:10.00 },
  { id:20, cat:"Doces",           nome:"Uva com chocolate",       preco:10.00 },
  { id:21, cat:"Acompanhamentos", nome:"Vinagrete",               preco:2.00  },
  { id:22, cat:"Acompanhamentos", nome:"Farofa",                  preco:1.00  },
  { id:23, cat:"Acompanhamentos", nome:"Molho alho",              preco:2.00  },
  { id:24, cat:"Água",            nome:"Água com gás",            preco:4.00  },
  { id:25, cat:"Água",            nome:"Água sem gás",            preco:4.00  },
  { id:26, cat:"Suco",            nome:"Suco 200ml",              preco:6.00  },
  { id:27, cat:"Suco",            nome:"Suco 900ml",              preco:12.00 },
  { id:28, cat:"Refrigerantes",   nome:"Coca-Cola 2L",            preco:14.00 },
  { id:29, cat:"Refrigerantes",   nome:"Coca-Cola Lata",          preco:6.00  },
  { id:30, cat:"Refrigerantes",   nome:"Guaraná Lata",            preco:6.00  },
  { id:31, cat:"Cervejas",        nome:"Sol Long Neck",           preco:8.00  },
  { id:32, cat:"Cervejas",        nome:"Heineken Long Neck",      preco:10.00 },
  { id:33, cat:"Cervejas",        nome:"Brahma Lata",             preco:7.00  },
  { id:34, cat:"Cervejas",        nome:"Chopp",                   preco:10.00 },
  { id:35, cat:"Cervejas",        nome:"Chopp Vinho",             preco:12.00 },
  { id:36, cat:"Energético",      nome:"Monster",                 preco:12.00 },
];

const PIN_GARCOM = "1234";
const PIN_CAIXA  = "5678";

const STATUS_MESA = {
  livre:    { c:"#10b981", bg:"#d1fae5", e:"🍽️", l:"Livre"    },
  ocupada:  { c:"#3b82f6", bg:"#dbeafe", e:"🍢", l:"Ocupada"  },
  chamando: { c:"#f59e0b", bg:"#fef3c7", e:"🔔", l:"Chamando" },
  conta:    { c:"#8b5cf6", bg:"#ede9fe", e:"💳", l:"Conta"    },
};

function totMesa(itens=[]) { return itens.reduce((s,i)=>s+(i.qty||1)*i.preco,0); }
function totMesaCompleta(mesa) {
  const scs = mesa.subComandas || [];
  return scs.reduce((total, sc) =>
    total + totMesa(sc.itens) + (sc.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0)
  , 0);
}
function initSubComanda(id=1) { return {id, label:`Comanda ${id}`, cliente:"", itens:[], rodadas:[]}; }
function initMesa(i) {
  return {id:i+1, status:"livre", garcom:"", obs:"", abertura:null, solicitadoPor:null, solicitadoEm:null,
          subComandas:[initSubComanda(1)]};
}
function initMesaEspecial(id, nome, tipo, icon) {
  return {id, nome, tipo, icon, status:"livre", garcom:"", obs:"", abertura:null, solicitadoPor:null, solicitadoEm:null,
          subComandas:[initSubComanda(1)]};
}
const MESAS_ESPECIAIS_BASE = [
  initMesaEspecial(901, "Funcionários", "funcionarios", "👥"),
  initMesaEspecial(902, "Caixa Direto", "caixa_direto", "🛒"),
];
function migrarMesa(m) {
  if (m.subComandas) return m;
  // migra formato antigo (itens/rodadas/cliente no nível da mesa)
  return {...m, subComandas:[{id:1, label:"Comanda 1", cliente:m.cliente||"", itens:m.itens||[], rodadas:m.rodadas||[]}]};
}
function fmtR(v) { return "R$ "+v.toFixed(2); }
function tempoAberto(abertura) {
  if(!abertura) return null;
  const m = Math.floor((Date.now()-new Date(abertura))/60000);
  if(m<60) return m+"min"; return Math.floor(m/60)+"h"+(m%60>0?(m%60)+"min":"");
}

// ── PIN LOGIN ─────────────────────────────────────────────────
function PinLogin({ onLogin }) {
  const [pin, setPin] = useState("");
  const [erro, setErro] = useState(false);

  function digitar(n) {
    if(pin.length>=4) return;
    const novo = pin+n;
    setPin(novo);
    setErro(false);
    if(novo.length===4) {
      setTimeout(()=>{
        if(novo===PIN_GARCOM) onLogin("garcom");
        else if(novo===PIN_CAIXA) onLogin("caixa");
        else { setErro(true); setPin(""); }
      }, 200);
    }
  }

  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 20px",minHeight:400}}>
      <div style={{fontSize:48,marginBottom:8}}>🍽️</div>
      <div style={{fontWeight:800,fontSize:20,color:"#1a1a1a",marginBottom:4}}>Acesso ao Salão</div>
      <div style={{fontSize:13,color:"#888",marginBottom:24}}>Digite o PIN para continuar</div>
      <div style={{display:"flex",gap:12,marginBottom:8}}>
        {[0,1,2,3].map(i=>(
          <div key={i} style={{width:16,height:16,borderRadius:"50%",background:i<pin.length?"#7b1a0a":"#e0e0e0",transition:"background 0.15s"}}/>
        ))}
      </div>
      {erro && <div style={{color:"#ef4444",fontSize:12,fontWeight:600,marginBottom:8}}>❌ PIN incorreto</div>}
      {!erro && <div style={{fontSize:12,color:"#bbb",marginBottom:16,height:20}}>{pin.length>0?"•".repeat(pin.length)+" "+"○".repeat(4-pin.length):""}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,width:220,marginBottom:16}}>
        {[1,2,3,4,5,6,7,8,9].map(n=>(
          <button key={n} onClick={()=>digitar(String(n))} style={{height:56,borderRadius:12,border:"1.5px solid #e0e0e0",background:"#fff",fontSize:22,fontWeight:700,color:"#1a1a1a",cursor:"pointer",boxShadow:"0 2px 6px rgba(0,0,0,0.06)"}}>
            {n}
          </button>
        ))}
        <div/>
        <button onClick={()=>digitar("0")} style={{height:56,borderRadius:12,border:"1.5px solid #e0e0e0",background:"#fff",fontSize:22,fontWeight:700,color:"#1a1a1a",cursor:"pointer",boxShadow:"0 2px 6px rgba(0,0,0,0.06)"}}>0</button>
        <button onClick={()=>setPin(p=>p.slice(0,-1))} style={{height:56,borderRadius:12,border:"1.5px solid #e0e0e0",background:"#f8f8f8",fontSize:18,color:"#888",cursor:"pointer"}}>⌫</button>
      </div>
      <div style={{display:"flex",gap:10}}>
        <div style={{background:"#f5f5f5",borderRadius:10,padding:"5px 12px",fontSize:11,color:"#888"}}>🧑‍🍳 Garçom: 1234</div>
        <div style={{background:"#f5f5f5",borderRadius:10,padding:"5px 12px",fontSize:11,color:"#888"}}>💁‍♀️ Caixa: 5678</div>
      </div>
    </div>
  );
}

// ── SALÃO INTEGRADO ───────────────────────────────────────────
function SalaoIntegrado({ cardapio: cardapioExterno, perfilSalao, setPerfilSalao, mesasSalao, setMesasSalao, faturadoSalao, setFaturadoSalao, selSalao, setSelSalao, telaSalaoGlobal, setTelaSalaoGlobal, isDono, historicoSalao = [], setHistoricoSalao, onSairApp, garcomLogado }) {
  const perfil = perfilSalao;
  const setPerfil = setPerfilSalao;
  const mesas = mesasSalao;
  const setMesas = setMesasSalao;
  const faturado = faturadoSalao;
  const setFaturado = setFaturadoSalao;
  const sel = selSalao;
  const setSel = setSelSalao;
  const telaSalao = telaSalaoGlobal;
  const setTelaSalao = setTelaSalaoGlobal;
  const [catFiltro, setCatFiltro] = useState("todos");
  const [pagSalao, setPagSalao] = useState("pix");
  const [divSalao, setDivSalao] = useState(1);
  const [selSC, setSelSC] = useState(0); // índice da sub-comanda ativa
  const [toastSalao, setToastSalao] = useState(null);

  const cardapio = (cardapioExterno && cardapioExterno.length > 0)
    ? cardapioExterno.filter(i=>i.ativo!==false).map(i=>({...i,cat:i.categoria||i.cat}))
    : CARDAPIO_SALAO;

  function msgSalao(txt,cor="#10b981"){setToastSalao({txt,cor});setTimeout(()=>setToastSalao(null),2500);}
  const mesaRaw = mesas.find(m=>m.id===sel);
  const mesa = mesaRaw ? migrarMesa(mesaRaw) : null;
  function upd(m){setMesas(p=>p.map(x=>x.id===m.id?m:x));}

  // Sub-comanda ativa (com segurança para índice fora do range)
  const scIdx = Math.min(selSC, (mesa?.subComandas?.length||1)-1);
  const sc = mesa?.subComandas?.[scIdx] || initSubComanda(1);

  // Atualiza apenas a sub-comanda ativa
  function updSC(novoSC) {
    const scs = [...(mesa.subComandas||[initSubComanda(1)])];
    scs[scIdx] = novoSC;
    upd({...mesa, subComandas: scs});
  }

  function addItem(item){
    const itens=[...sc.itens];
    const ex=itens.find(i=>i.id===item.id);
    if(ex) ex.qty+=1; else itens.push({...item,qty:1});
    const nomeGarcom = mesa.garcom || (garcomLogado?.nome) || "";
    const novaAbertura = mesa.abertura||new Date().toISOString();
    const novoStatus = mesa.status==="livre"?"ocupada":mesa.status;
    updSC({...sc,itens});
    upd({...mesa, garcom:nomeGarcom, status:novoStatus, abertura:novaAbertura,
         subComandas: mesa.subComandas.map((s,i)=>i===scIdx?{...s,itens}:s)});
  }
  function chgQty(id,d){
    const itens=sc.itens.map(i=>i.id===id?{...i,qty:(i.qty||1)+d}:i).filter(i=>(i.qty||1)>0);
    const allEmpty = mesa.subComandas.every((s,i)=>i===scIdx?itens.length===0:s.itens.length===0&&(s.rodadas||[]).length===0);
    upd({...mesa, status:allEmpty?"livre":mesa.status,
         subComandas: mesa.subComandas.map((s,i)=>i===scIdx?{...s,itens}:s)});
  }

  // Adiciona nova sub-comanda à mesa
  function novaComanda(){
    const novoId = Math.max(...(mesa.subComandas||[]).map(s=>s.id), 0) + 1;
    const novas = [...(mesa.subComandas||[]), initSubComanda(novoId)];
    upd({...mesa, subComandas:novas});
    setSelSC(novas.length-1);
    msgSalao(`✅ Comanda ${novoId} criada!`);
  }

  // Imprime ticket de cozinha SEM VALORES
  function imprimirCozinha(rodada, mesaId, scLabel){
    const agora = new Date();
    const win = window.open('','_blank','width=360,height=520');
    const nomeGarcom = garcomLogado?.nome || mesa.garcom || "—";
    win.document.write(`<!DOCTYPE html><html>
<head><title>Cozinha — Mesa ${mesaId}</title>
<style>
  body{font-family:'Courier New',monospace;padding:16px;max-width:290px;margin:0 auto}
  h2{text-align:center;font-size:16px;margin:0 0 2px}
  .sub{text-align:center;font-size:11px;color:#555;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
  hr{border:none;border-top:2px dashed #000;margin:8px 0}
  .info{font-size:12px;margin-bottom:8px;line-height:1.6}
  .item{display:flex;gap:6px;font-size:15px;font-weight:700;padding:5px 0;border-bottom:1px dashed #ccc}
  .qty{font-size:18px;font-weight:900;min-width:28px}
  .rodape{text-align:center;font-size:11px;color:#888;margin-top:14px}
  @media print{button{display:none}}
</style>
</head>
<body>
  <h2>👑 Império dos Espetos</h2>
  <div class="sub">🔥 Pedido — Cozinha / Churrasqueira</div>
  <hr>
  <div class="info">
    Mesa: <strong>${mesaId}</strong>${scLabel !== "Comanda 1" ? ` &nbsp;|&nbsp; ${scLabel}` : ""}<br>
    ${sc.cliente ? `Cliente: <strong>${sc.cliente}</strong><br>` : ""}Garçom: <strong>${nomeGarcom}</strong><br>
    Data: <strong>${agora.toLocaleDateString('pt-BR')}</strong><br>
    Horário: <strong>${agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</strong>
  </div>
  <hr>
  ${rodada.itens.map(it=>`
    <div class="item"><span class="qty">${it.qty||1}x</span><span>${it.nome}</span></div>
  `).join('')}
  <div class="rodape">— Fim do pedido —</div>
  <br><button onclick="window.print()" style="width:100%;padding:10px;font-size:14px;cursor:pointer">🖨️ Imprimir</button>
</body></html>`);
    win.document.close();
    setTimeout(()=>win.print(),400);
  }

  async function fecharComanda(idxSC, pagamento){
    const scFechando = mesa.subComandas[idxSC];
    const todosItens = [...(scFechando.rodadas||[]).flatMap(r=>r.itens), ...scFechando.itens].reduce((acc,it)=>{
      const ex=acc.find(i=>i.id===it.id); if(ex) ex.qty+=(it.qty||1); else acc.push({...it,qty:it.qty||1}); return acc;
    }, []);
    const totalSC = totMesa(scFechando.itens) + (scFechando.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0);
    const registro = {
      id: Date.now(),
      mesa: mesa.id,
      cliente: scFechando.cliente || "—",
      garcom: garcomLogado?.nome || mesa.garcom || "—",
      garcomId: garcomLogado?.id || null,
      subComanda: scFechando.label,
      itens: todosItens,
      total: totalSC,
      pagamento: pagamento||pagSalao,
      abertura: scFechando.abertura||mesa.abertura,
      fechamento: new Date().toISOString(),
    };
    try {
      const res = await fetch(BACKEND_URL+"/vendas-salao",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(registro)});
      if(res.ok){const salvo=await res.json();registro._id=salvo._id;}
    } catch(e){console.warn("Falha ao salvar venda:",e);}
    if(setHistoricoSalao) setHistoricoSalao(h=>[...h,registro]);
    setFaturado(f=>f+totalSC);

    // Remove a comanda fechada
    const novasSCs = mesa.subComandas.filter((_,i)=>i!==idxSC);
    const novoStatus = novasSCs.length===0||novasSCs.every(s=>s.itens.length===0&&(s.rodadas||[]).length===0)?"livre":"ocupada";
    if(novasSCs.length===0) {
      // Mesa totalmente liberada
      upd(initMesa(mesa.id-1));
      setSel(null); setTelaSalao("mapa");
    } else {
      upd({...mesa, subComandas:novasSCs, status:novoStatus, solicitadoPor:null, solicitadoEm:null});
      setSelSC(Math.min(idxSC, novasSCs.length-1));
      setTelaSalao("comanda");
    }
    msgSalao(`✅ ${scFechando.label} fechada! ${fmtR(totalSC)}`);
    setDivSalao(1);
  }

  async function fecharMesa(){
    // Fecha todas as comandas de uma vez
    const todosItens = (mesa.subComandas||[]).flatMap(sc=>[...(sc.rodadas||[]).flatMap(r=>r.itens),...sc.itens])
      .reduce((acc,it)=>{const ex=acc.find(i=>i.id===it.id);if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
    const totalMesa = totMesaCompleta(mesa);
    const registro = {
      id: Date.now(), mesa: mesa.id,
      cliente: (mesa.subComandas||[]).map(s=>s.cliente).filter(Boolean).join(", ")||"—",
      garcom: garcomLogado?.nome||mesa.garcom||"—", garcomId:garcomLogado?.id||null,
      itens:todosItens, total:totalMesa, pagamento:pagSalao,
      abertura:mesa.abertura, fechamento:new Date().toISOString(),
    };
    try{const res=await fetch(BACKEND_URL+"/vendas-salao",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(registro)});if(res.ok){const salvo=await res.json();registro._id=salvo._id;}}catch(e){console.warn(e);}
    if(setHistoricoSalao) setHistoricoSalao(h=>[...h,registro]);
    setFaturado(f=>f+totalMesa);
    msgSalao(`✅ Mesa ${mesa.id} fechada! ${fmtR(totalMesa)} via ${pagSalao}`);
    upd(initMesa(mesa.id-1));
    setSel(null); setTelaSalao("mapa"); setDivSalao(1); setSelSC(0);
  }

  const totalAcumulado = totMesaCompleta(mesa||{subComandas:[]});
  const totalSCAtual = sc ? totMesa(sc.itens)+(sc.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0) : 0;

  const fat = faturado + mesas.reduce((s,m)=>s+totMesaCompleta(migrarMesa(m)),0);
  const ocup = mesas.filter(m=>m.status!=="livre").length;
  const alertas = mesas.filter(m=>m.status==="chamando"||m.status==="conta");
  const cats = ["todos",...new Set(cardapio.map(i=>i.cat||i.categoria))];
  const catIcons = {"todos":"📋","Tradicionais":"🍢","Especiais":"⭐","Doces":"🍫","Acompanhamentos":"🥗","Água":"💧","Suco":"🥤","Refrigerantes":"🥫","Cervejas":"🍺","Energético":"⚡"};

  const H2 = {background:"linear-gradient(135deg,#6b1c0e,#8b2510)",color:"#fff",padding:"12px 16px"};
  const BK2 = {background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",borderRadius:8,padding:"5px 10px",fontWeight:700,fontSize:13,cursor:"pointer"};
  const BP2 = (bg,flex=false)=>({background:bg,color:"#fff",border:"none",borderRadius:12,padding:"12px 0",fontWeight:800,fontSize:14,cursor:"pointer",...(flex?{flex:1}:{width:"100%"})});
  const card2 = {background:"#fff",borderRadius:14,padding:"14px",boxShadow:"0 2px 10px rgba(0,0,0,0.07)",marginBottom:10};

  if(!perfil) return <PinLogin onLogin={setPerfil} />;

  // TELA ADICIONAR
  if(telaSalao==="adicionar") return (
    <div style={{background:T.cream,minHeight:"100%"}}>
      {toastSalao&&<div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:12,padding:"10px 20px",fontWeight:700,zIndex:999}}>{toastSalao.txt}</div>}
      <div style={H2}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button style={BK2} onClick={()=>setTelaSalao("comanda")}>← Voltar</button>
          <div style={{fontWeight:800,fontSize:15,flex:1}}>{mesa.nome || `Mesa ${mesa.id}`} — {sc.label}</div>
          <div style={{fontWeight:800,color:"#f0c040"}}>{fmtR(totMesa(sc.itens))}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:5,flexWrap:"wrap",padding:"10px 14px",background:"#fff",borderBottom:"1px solid #eee"}}>
        {cats.map(c=>(
          <button key={c} onClick={()=>setCatFiltro(c)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"6px 8px",borderRadius:10,border:`2px solid ${catFiltro===c?"#7b1a0a":"transparent"}`,background:catFiltro===c?"#fef0ed":"#f8f8f8",cursor:"pointer",minWidth:48}}>
            <span style={{fontSize:16}}>{catIcons[c]||"🍽️"}</span>
            <span style={{fontSize:9,fontWeight:catFiltro===c?700:500,color:catFiltro===c?"#7b1a0a":"#666"}}>{c==="todos"?"Todos":c.length>7?c.slice(0,6)+".":c}</span>
          </button>
        ))}
      </div>
      <div style={{padding:"10px 14px 80px",display:"flex",flexDirection:"column",gap:8}}>
        {cardapio.filter(i=>(catFiltro==="todos"||(i.cat||i.categoria)===catFiltro)).map(item=>{
          const na=sc.itens.find(i=>i.id===item.id);
          return(
            <div key={item.id} style={{...card2,marginBottom:0,display:"flex",alignItems:"center",gap:10,border:`2px solid ${na?"#7b1a0a":"transparent"}`}}>
              <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14}}>{item.nome}</div><div style={{fontSize:12,color:"#888"}}>{fmtR(item.preco)}</div></div>
              {na?(
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>chgQty(item.id,-1)} style={{width:30,height:30,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:18,cursor:"pointer"}}>−</button>
                  <span style={{fontWeight:800,fontSize:16,minWidth:20,textAlign:"center"}}>{na.qty||1}</span>
                  <button onClick={()=>addItem(item)} style={{width:30,height:30,borderRadius:"50%",border:"none",background:"#7b1a0a",color:"#fff",fontWeight:800,fontSize:18,cursor:"pointer"}}>+</button>
                </div>
              ):(
                <button onClick={()=>addItem(item)} style={{background:"#7b1a0a",color:"#fff",border:"none",borderRadius:10,padding:"7px 12px",fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Add</button>
              )}
            </div>
          );
        })}
      </div>
      {sc.itens.length>0&&(
        <div style={{position:"sticky",bottom:0,padding:"10px 14px",background:"#fff",borderTop:"1px solid #f0f0f0"}}>
          <button onClick={()=>setTelaSalao("comanda")} style={BP2("linear-gradient(135deg,#7b1a0a,#c0392b)")}>✅ Ver comanda — {fmtR(totMesa(sc.itens))}</button>
        </div>
      )}
    </div>
  );

  // TELA FECHAR
  if(telaSalao==="fechar") {
    const fecharUma = mesa.subComandas.length > 1; // se há múltiplas, fecha só a ativa
    const totalFechar = fecharUma ? totalSCAtual : totalAcumulado;
    const todosItensFechar = fecharUma
      ? [...(sc.rodadas||[]).flatMap(r=>r.itens),...sc.itens].reduce((acc,it)=>{const ex=acc.find(i=>i.id===it.id);if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[])
      : (mesa.subComandas||[]).flatMap(s=>[...(s.rodadas||[]).flatMap(r=>r.itens),...s.itens]).reduce((acc,it)=>{const ex=acc.find(i=>i.id===it.id);if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
    return (
    <div style={{background:T.cream,minHeight:"100%"}}>
      <div style={H2}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button style={BK2} onClick={()=>setTelaSalao("comanda")}>← Voltar</button>
          <div style={{fontWeight:800,fontSize:15}}>{mesa.nome || `Mesa ${mesa.id}`}{fecharUma?` — ${sc.label}`:""} — Fechar</div>
        </div>
      </div>
      <div style={{padding:"14px",display:"flex",flexDirection:"column",gap:10}}>
        {/* Se há múltiplas comandas, mostra opção de fechar todas */}
        {mesa.subComandas.length>1&&(
          <div style={{background:"#ede9fe",borderRadius:12,padding:"10px 14px",fontSize:12,color:"#7c3aed",fontWeight:600,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>📋 Fechando: {fecharUma?sc.label:"Todas as comandas"}</span>
            <button onClick={fecharMesa} style={{background:"#7c3aed",color:"#fff",border:"none",borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>Fechar mesa inteira</button>
          </div>
        )}
        <div style={card2}>
          <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:10,textTransform:"uppercase"}}>🧾 Resumo</div>
          {todosItensFechar.map((it,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px dashed #f0f0f0",fontSize:13}}>
              <span>{it.qty}x {it.nome}</span><span style={{fontWeight:600}}>{fmtR(it.qty*it.preco)}</span>
            </div>
          ))}
          <div style={{display:"flex",justifyContent:"space-between",paddingTop:10,fontSize:16,fontWeight:800,color:"#7b1a0a"}}>
            <span>Total</span><span>{fmtR(totalFechar)}</span>
          </div>
        </div>
        <div style={card2}>
          <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:12,textTransform:"uppercase"}}>👥 Dividir</div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:20}}>
            <button onClick={()=>setDivSalao(Math.max(1,divSalao-1))} style={{width:40,height:40,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:22,cursor:"pointer"}}>−</button>
            <div style={{textAlign:"center"}}><div style={{fontWeight:800,fontSize:28}}>{divSalao}</div><div style={{fontSize:12,color:"#888"}}>pessoa{divSalao>1?"s":""}</div></div>
            <button onClick={()=>setDivSalao(divSalao+1)} style={{width:40,height:40,borderRadius:"50%",border:"none",background:"#d1fae5",color:"#10b981",fontWeight:800,fontSize:22,cursor:"pointer"}}>+</button>
          </div>
          {divSalao>1&&<div style={{marginTop:10,background:"#fef3c7",borderRadius:10,padding:10,textAlign:"center"}}>
            <div style={{fontSize:12,color:"#92400e"}}>Cada pessoa paga</div>
            <div style={{fontWeight:800,fontSize:22,color:"#7b1a0a"}}>{fmtR(totalFechar/divSalao)}</div>
          </div>}
        </div>
        <div style={card2}>
          <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:10,textTransform:"uppercase"}}>💳 Pagamento</div>
          <div style={{display:"flex",gap:8}}>
            {[["pix","🟢 Pix"],["cartao","💳 Cartão"],["dinheiro","💵 Dinheiro"]].map(([k,l])=>(
              <button key={k} onClick={()=>setPagSalao(k)} style={{flex:1,padding:"10px 4px",borderRadius:12,border:`2px solid ${pagSalao===k?"#7b1a0a":"#e0e0e0"}`,background:pagSalao===k?"#fef0ed":"#fff",fontWeight:pagSalao===k?700:500,fontSize:12,cursor:"pointer",color:pagSalao===k?"#7b1a0a":"#555"}}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>{
            const nomeGarcom = garcomLogado?.nome||mesa.garcom||"—";
            const nomeCliente = fecharUma?sc.cliente:"";
            const abertura = fecharUma?(sc.abertura||mesa.abertura):mesa.abertura;
            const win = window.open('','_blank','width=400,height=600');
            win.document.write(`<!DOCTYPE html><html><head><title>Comanda Mesa ${mesa.id}</title><style>
              body{font-family:'Courier New',monospace;padding:20px;max-width:320px;margin:0 auto}
              h2{text-align:center;font-size:16px;margin-bottom:4px}
              .sub{text-align:center;font-size:12px;color:#666;margin-bottom:16px}
              .linha{display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-bottom:1px dashed #eee}
              .total{display:flex;justify-content:space-between;font-size:15px;font-weight:bold;padding:8px 0;border-top:2px solid #000;margin-top:8px}
              .info{font-size:12px;color:#555;margin-bottom:12px}
              .rodape{text-align:center;font-size:11px;color:#999;margin-top:16px}
              @media print{button{display:none}}
            </style></head><body>
              <h2>👑 Império dos Espetos</h2>
              <div class="sub">Comanda — Mesa ${mesa.id}${fecharUma?` | ${sc.label}`:""}</div>
              <div class="info">${nomeCliente&&nomeCliente!=="—"?'Cliente: '+nomeCliente+'<br>':''}${nomeGarcom&&nomeGarcom!=="—"?'Garçom: '+nomeGarcom+'<br>':''}Abertura: ${abertura?new Date(abertura).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'-'}</div>
              ${todosItensFechar.map(it=>`<div class="linha"><span>${it.qty||1}x ${it.nome}</span><span>R$ ${((it.qty||1)*it.preco).toFixed(2)}</span></div>`).join('')}
              <div class="total"><span>TOTAL</span><span>R$ ${totalFechar.toFixed(2)}</span></div>
              <div class="info" style="margin-top:12px">Pagamento: ${pagSalao==='pix'?'Pix':pagSalao==='cartao'?'Cartão':'Dinheiro'}</div>
              <div class="rodape">Obrigado pela visita! 🍢</div>
              <br><button onclick="window.print()">🖨️ Imprimir</button>
            </body></html>`);
            win.document.close();
            setTimeout(()=>win.print(),500);
          }} style={{background:T.grayLL,color:T.gray,border:`1px solid ${T.grayL}`,borderRadius:T.radiusS,padding:"12px 0",fontWeight:600,fontSize:14,cursor:"pointer",flex:1}}>🖨️ Imprimir</button>
          <button onClick={()=>fecharUma?fecharComanda(scIdx,pagSalao):fecharMesa()} style={{...BP2("linear-gradient(135deg,#065f46,#10b981)"),flex:2}}>✅ Confirmar — {fmtR(totalFechar)}</button>
        </div>
      </div>
    </div>
    );
  }

  // TELA COMANDA
  if(telaSalao==="comanda"&&mesa) {
    return (
      <div style={{background:T.cream,minHeight:"100%"}}>
        {toastSalao&&<div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:12,padding:"10px 20px",fontWeight:700,zIndex:999}}>{toastSalao.txt}</div>}
        <div style={H2}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <button style={BK2} onClick={()=>{setSel(null);setTelaSalao("mapa");}}>← Salão</button>
            <div style={{fontWeight:800,fontSize:18,flex:1}}>{mesa.nome || `Mesa ${mesa.id}`}</div>
            <div style={{textAlign:"right"}}><div style={{fontSize:11,opacity:0.7}}>Total mesa</div><div style={{fontWeight:800,fontSize:18,color:"#f0c040"}}>{fmtR(totalAcumulado)}</div></div>
          </div>

          {/* Tabs de sub-comandas */}
          <div style={{display:"flex",gap:5,flexWrap:"nowrap",overflowX:"auto",marginBottom:8,paddingBottom:2}}>
            {(mesa.subComandas||[]).map((s,i)=>(
              <div key={s.id} style={{flexShrink:0,display:"flex",alignItems:"center",gap:0}}>
                <button onClick={()=>setSelSC(i)} style={{
                  padding:"5px 10px", borderRadius:mesa.subComandas.length>1?"20px 0 0 20px":"20px",
                  border:"none", cursor:"pointer", fontSize:12, fontWeight:i===scIdx?700:500,
                  background:i===scIdx?"rgba(255,255,255,0.95)":"rgba(255,255,255,0.2)",
                  color:i===scIdx?"#7b1a0a":"rgba(255,255,255,0.85)",
                }}>
                  {s.label}
                  {(totMesa(s.itens)+(s.rodadas||[]).reduce((ss,r)=>ss+totMesa(r.itens),0))>0 &&
                    <span style={{marginLeft:4,fontSize:10,opacity:0.8}}>
                      {fmtR(totMesa(s.itens)+(s.rodadas||[]).reduce((ss,r)=>ss+totMesa(r.itens),0))}
                    </span>
                  }
                </button>
                {/* Botão remover comanda — só aparece quando há mais de 1 */}
                {mesa.subComandas.length>1&&(perfil==="garcom"||isDono)&&(
                  <button onClick={()=>{
                    const temItens = s.itens.length>0||(s.rodadas||[]).length>0;
                    if(temItens && !window.confirm(`Remover ${s.label}? Os itens serão perdidos.`)) return;
                    const novas = mesa.subComandas.filter((_,idx)=>idx!==i);
                    upd({...mesa, subComandas:novas});
                    setSelSC(Math.min(i, novas.length-1));
                    msgSalao(`${s.label} removida.`,"#f59e0b");
                  }} style={{
                    padding:"5px 7px", borderRadius:"0 20px 20px 0",
                    border:"none", cursor:"pointer", fontSize:11,
                    background:i===scIdx?"rgba(255,255,255,0.75)":"rgba(255,255,255,0.15)",
                    color:i===scIdx?"#ef4444":"rgba(255,255,255,0.6)",
                    borderLeft:`1px solid ${i===scIdx?"rgba(239,68,68,0.3)":"rgba(255,255,255,0.1)"}`,
                  }}>✕</button>
                )}
              </div>
            ))}
            {(perfil==="garcom"||isDono)&&(
              <button onClick={novaComanda} style={{flexShrink:0,padding:"5px 10px",borderRadius:20,border:"1px dashed rgba(255,255,255,0.5)",background:"transparent",color:"rgba(255,255,255,0.7)",fontSize:12,cursor:"pointer"}}>
                + Comanda
              </button>
            )}
          </div>

          {/* Dados da sub-comanda ativa */}
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <input value={sc.cliente||""} onChange={e=>{const scs=mesa.subComandas.map((s,i)=>i===scIdx?{...s,cliente:e.target.value}:s);upd({...mesa,subComandas:scs});}} placeholder={`🧑 Cliente — ${sc.label}...`} style={{background:"rgba(255,255,255,0.95)",border:"1px solid rgba(255,255,255,0.5)",color:"#1C1917",borderRadius:8,padding:"6px 10px",fontSize:13,outline:"none"}}/>
            <div style={{display:"flex",gap:8}}>
              {garcomLogado ? (
                <div style={{flex:1,background:"rgba(255,255,255,0.95)",border:"1px solid rgba(255,255,255,0.5)",color:"#1C1917",borderRadius:8,padding:"6px 10px",fontSize:13,display:"flex",alignItems:"center",gap:6}}>
                  🧑‍🍳 <strong>{garcomLogado.nome}</strong>
                </div>
              ) : (
                <input value={mesa.garcom||""} onChange={e=>upd({...mesa,garcom:e.target.value})} placeholder="👤 Garçom..." style={{flex:1,background:"rgba(255,255,255,0.95)",border:"1px solid rgba(255,255,255,0.5)",color:"#1C1917",borderRadius:8,padding:"6px 10px",fontSize:13,outline:"none"}}/>
              )}
              <button onClick={()=>upd({...mesa,status:mesa.status==="chamando"?"ocupada":"chamando"})} style={{background:mesa.status==="chamando"?"#f59e0b":"rgba(255,255,255,0.2)",border:"none",color:"#fff",borderRadius:8,padding:"6px 10px",cursor:"pointer",fontWeight:700,fontSize:12}}>
                🔔 {mesa.status==="chamando"?"Cancelar":"Chamar"}
              </button>
            </div>
          </div>
        </div>

        <div style={{padding:"12px 14px"}}>
          {sc.itens.length===0&&(sc.rodadas||[]).length===0?(
            <div style={{textAlign:"center",padding:"30px 0",color:"#ccc"}}><div style={{fontSize:36}}>🍢</div><div style={{marginTop:6,fontSize:14}}>{sc.label} vazia</div></div>
          ):(
            <div style={card2}>
              <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:8,textTransform:"uppercase"}}>{sc.label} — Itens</div>
              {sc.itens.map((it,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderBottom:"1px dashed #f0f0f0"}}>
                  <div style={{flex:1}}><div style={{fontWeight:600,fontSize:13}}>{it.nome}</div><div style={{fontSize:11,color:"#888"}}>{fmtR(it.preco)} cada</div></div>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <button onClick={()=>chgQty(it.id,-1)} style={{width:26,height:26,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:15,cursor:"pointer"}}>−</button>
                    <span style={{fontWeight:800,minWidth:18,textAlign:"center"}}>{it.qty||1}</span>
                    <button onClick={()=>chgQty(it.id,1)} style={{width:26,height:26,borderRadius:"50%",border:"none",background:"#d1fae5",color:"#10b981",fontWeight:800,fontSize:15,cursor:"pointer"}}>+</button>
                  </div>
                  <div style={{fontWeight:800,fontSize:13,color:"#7b1a0a",minWidth:50,textAlign:"right"}}>{fmtR((it.qty||1)*it.preco)}</div>
                </div>
              ))}
              {(sc.rodadas||[]).length>0&&<div style={{fontSize:11,color:"#aaa",marginTop:6}}>+ {fmtR((sc.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0))} em {(sc.rodadas||[]).length} rodada{(sc.rodadas||[]).length>1?"s":""} anteriores</div>}
              <div style={{display:"flex",justifyContent:"space-between",paddingTop:8,fontSize:15,fontWeight:800,color:"#7b1a0a"}}><span>Total {sc.label}</span><span>{fmtR(totalSCAtual)}</span></div>
            </div>
          )}
          {(sc.rodadas||[]).length>0&&(
            <div style={card2}>
              <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:8,textTransform:"uppercase"}}>📋 Enviados à cozinha</div>
              {(sc.rodadas||[]).map((r,ri)=>(
                <div key={ri} style={{marginBottom:6,paddingBottom:6,borderBottom:"1px dashed #f0f0f0"}}>
                  <div style={{fontSize:11,color:"#aaa",marginBottom:3}}>Rodada {ri+1} — {new Date(r.hora).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}</div>
                  {r.itens.map((it,ii)=><div key={ii} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555"}}><span>{it.qty||1}x {it.nome}</span></div>)}
                </div>
              ))}
            </div>
          )}
          <div style={{...card2}}>
            <textarea value={mesa.obs||""} onChange={e=>upd({...mesa,obs:e.target.value})} placeholder="⚠️ Observações da mesa..." rows={2} style={{width:"100%",border:"none",outline:"none",fontSize:13,color:"#555",resize:"none",fontFamily:"inherit",background:"transparent",boxSizing:"border-box"}}/>
          </div>
        </div>

        <div style={{padding:"0 14px 16px",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",gap:8}}>
            {(perfil==="garcom"||isDono)&&<button onClick={()=>setTelaSalao("adicionar")} style={{...BP2("linear-gradient(135deg,#7b1a0a,#c0392b)",true)}}>🍢 Adicionar</button>}
            {(perfil==="garcom"||isDono)&&sc.itens.length>0&&(
              <button onClick={()=>{
                const rodada={hora:new Date().toISOString(),itens:[...sc.itens]};
                const novasRodadas=[...(sc.rodadas||[]),rodada];
                upd({...mesa, subComandas:mesa.subComandas.map((s,i)=>i===scIdx?{...s,itens:[],rodadas:novasRodadas}:s)});
                imprimirCozinha(rodada, mesa.id, sc.label);
                msgSalao(`🔥 ${sc.label} enviada à cozinha!`);
              }} style={{...BP2("linear-gradient(135deg,#1d4ed8,#2563eb)",true)}}>🔥 Cozinha</button>
            )}
          </div>
          {/* Botão enviar TODAS as comandas de uma vez — só aparece com 2+ comandas com itens pendentes */}
          {(perfil==="garcom"||isDono)&&mesa.subComandas.length>1&&mesa.subComandas.filter(s=>s.itens.length>0).length>1&&(
            <button onClick={()=>{
              let novasSCs = [...mesa.subComandas];
              mesa.subComandas.forEach((s,i)=>{
                if(s.itens.length===0) return;
                const rodada={hora:new Date().toISOString(),itens:[...s.itens]};
                novasSCs[i]={...novasSCs[i],itens:[],rodadas:[...(novasSCs[i].rodadas||[]),rodada]};
                imprimirCozinha(rodada, mesa.id, s.label);
              });
              upd({...mesa, subComandas:novasSCs});
              msgSalao(`🔥 Todas as comandas enviadas à cozinha!`);
            }} style={{...BP2("linear-gradient(135deg,#0e4fa8,#1d4ed8)"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              🔥 Enviar todas à cozinha
            </button>
          )}
          {(perfil==="caixa"||isDono)?(
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {/* Botão imprimir comanda para conferência */}
              {totalAcumulado>0&&(
                <button onClick={()=>{
                  const nomeGarcom = garcomLogado?.nome||mesa.garcom||"—";
                  const todosItens = (mesa.subComandas||[]).flatMap(s=>[...(s.rodadas||[]).flatMap(r=>r.itens),...s.itens])
                    .reduce((acc,it)=>{const ex=acc.find(i=>i.id===it.id);if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
                  const win = window.open('','_blank','width=400,height=650');
                  const agora = new Date();
                  win.document.write(`<!DOCTYPE html><html>
<head><title>Comanda Mesa ${mesa.id}</title>
<style>
  body{font-family:'Courier New',monospace;padding:20px;max-width:320px;margin:0 auto}
  h2{text-align:center;font-size:16px;margin:0 0 2px}
  .sub{text-align:center;font-size:12px;color:#666;margin-bottom:14px}
  hr{border:none;border-top:2px dashed #000;margin:8px 0}
  .info{font-size:12px;color:#555;margin-bottom:10px;line-height:1.7}
  .linha{display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px dashed #eee}
  .total{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;padding:10px 0;border-top:2px solid #000;margin-top:6px}
  .rodape{text-align:center;font-size:11px;color:#999;margin-top:14px}
  @media print{button{display:none}}
</style>
</head>
<body>
  <h2>👑 Império dos Espetos</h2>
  <div class="sub">Comanda — Mesa ${mesa.id}</div>
  <hr>
  <div class="info">
    ${(mesa.subComandas||[]).map(s=>s.cliente).filter(Boolean).length>0?`Cliente: <strong>${(mesa.subComandas||[]).map(s=>s.cliente).filter(Boolean).join(", ")}</strong><br>`:""}
    ${nomeGarcom&&nomeGarcom!=="—"?`Garçom: <strong>${nomeGarcom}</strong><br>`:""}
    Data: <strong>${agora.toLocaleDateString('pt-BR')}</strong> &nbsp; ${agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}
  </div>
  <hr>
  ${todosItens.map(it=>`<div class="linha"><span>${it.qty||1}x ${it.nome}</span><span>R$ ${((it.qty||1)*it.preco).toFixed(2)}</span></div>`).join('')}
  <div class="total"><span>TOTAL</span><span>R$ ${totalAcumulado.toFixed(2)}</span></div>
  <div class="rodape">Obrigado pela visita! 🍢</div>
</body></html>`);
                  win.document.close();
                  setTimeout(()=>win.print(),400);
                }} style={{background:T.grayLL,color:T.dark,border:`1px solid ${T.grayL}`,borderRadius:T.radiusS,padding:"11px 0",fontWeight:600,fontSize:14,cursor:"pointer",width:"100%"}}>
                  🖨️ Imprimir comanda
                </button>
              )}
              <button onClick={()=>setTelaSalao("fechar")} style={BP2(totalAcumulado>0?mesa.status==="conta"?"linear-gradient(135deg,#8b5cf6,#7c3aed)":"linear-gradient(135deg,#065f46,#10b981)":"#ccc")} disabled={totalAcumulado===0}>
                {mesa.status==="conta"?"💳 Receber pagamento":mesa.subComandas.length>1?`✅ Fechar ${sc.label}`:  "✅ Fechar comanda"}{totalSCAtual>0?` — ${fmtR(totalSCAtual)}`:""}
              </button>
              {mesa.status==="conta"&&mesa.solicitadoPor&&(
                <div style={{background:"#ede9fe",borderRadius:10,padding:"8px 12px",fontSize:12,color:"#7c3aed",fontWeight:600,textAlign:"center"}}>
                  📨 Solicitado por {mesa.solicitadoPor} às {new Date(mesa.solicitadoEm).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
                </div>
              )}
            </div>
          ):(
            totalAcumulado>0&&(
              <button onClick={()=>{upd({...mesa,status:"conta",solicitadoPor:mesa.garcom||garcomLogado?.nome||"Garçom",solicitadoEm:new Date().toISOString()});msgSalao("📨 Fechamento solicitado ao caixa!","#8b5cf6");}} style={BP2(mesa.status==="conta"?"#8b5cf6":"linear-gradient(135deg,#7c3aed,#6d28d9)")}>
                {mesa.status==="conta"?"✅ Fechamento já solicitado":"📨 Solicitar fechamento ao caixa"}
              </button>
            )
          )}
          <button onClick={()=>{setSel(null);setTelaSalao("mapa");}} style={{background:"none",border:"none",color:"#aaa",fontSize:13,cursor:"pointer",padding:"6px 0"}}>← Voltar ao Salão</button>
        </div>
      </div>
    );
  }

  // MAPA DE MESAS
  return (
    <div style={{background:T.cream,minHeight:"100%"}}>
      {toastSalao&&<div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:12,padding:"10px 20px",fontWeight:700,zIndex:999}}>{toastSalao.txt}</div>}
      <div style={{background:`linear-gradient(135deg,${T.wineD},${T.wine})`,color:"#fff",padding:"12px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div>
            <div style={{fontSize:11,opacity:0.7,textTransform:"uppercase"}}>{isDono?"👑 Dono":perfil==="caixa"?"💁‍♀️ Caixa":garcomLogado?`🧑‍🍳 ${garcomLogado.nome}`:"🧑‍🍳 Garçom"}</div>
            <div style={{fontWeight:800,fontSize:18}}>🍽️ Mapa do Salão</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,opacity:0.7}}>Faturamento</div>
            <div style={{fontWeight:800,fontSize:18,color:T.amber}}>{fmtR(fat)}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{background:"rgba(255,255,255,0.15)",borderRadius:10,padding:"5px 12px"}}>
            <div style={{fontWeight:800,fontSize:14}}>{ocup}/{mesas.length}</div>
            <div style={{fontSize:10,opacity:0.8}}>ocupadas</div>
          </div>
          {alertas.length>0&&<div style={{background:"rgba(139,92,246,0.4)",borderRadius:10,padding:"5px 12px",border:"1px solid #8b5cf6"}}>
            <div style={{fontWeight:800,fontSize:14}}>⚠️ {alertas.length}</div>
            <div style={{fontSize:10,opacity:0.8}}>atenção</div>
          </div>}
          <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
            {isDono&&<>
              <button onClick={()=>{const comuns=mesas.filter(m=>!m.tipo);const n=comuns.length+1;setMesas(p=>[...p,initMesa(n-1)]);msgSalao("✅ Mesa "+n+" adicionada!");}} style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",borderRadius:8,padding:"5px 12px",fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Mesa</button>
              <button onClick={()=>{const comuns=mesas.filter(m=>!m.tipo);const u=comuns[comuns.length-1];if(!u||u.status!=="livre"){msgSalao("❌ Só é possível remover mesa livre!","#ef4444");return;}setMesas(p=>p.filter(m=>m.id!==u.id));msgSalao("Mesa "+u.id+" removida.","#f59e0b");}} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.3)",color:"rgba(255,255,255,0.8)",borderRadius:8,padding:"5px 12px",fontWeight:700,fontSize:13,cursor:"pointer"}}>− Mesa</button>
            </>}
            {!isDono&&<button onClick={()=>{if(onSairApp)onSairApp();else setPerfil(null);}} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"rgba(255,255,255,0.8)",borderRadius:8,padding:"5px 10px",fontSize:12,cursor:"pointer",fontWeight:600}}>🔒 Sair</button>}
          </div>
        </div>
      </div>
      {alertas.length>0&&(
        <div style={{background:T.purpleL,borderBottom:`2px solid ${T.purple}`,padding:"8px 14px"}}>
          {alertas.map(m=>(
            <div key={m.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:700,color:"#5b21b6",marginBottom:2}}>
              <span>{m.status==="conta"?"💳":"🔔"} Mesa {m.id} — {m.status==="conta"?"fechamento solicitado":"chamando"}{m.solicitadoPor?` por ${m.solicitadoPor}`:""}</span>
              <span>{fmtR(totMesaCompleta(m))}</span>
            </div>
          ))}
        </div>
      )}

      {/* MESAS ESPECIAIS */}
      {(()=>{
        const CORES_ESPECIAL = {
          funcionarios: {bg:"#ede9fe",border:"#7c3aed",text:"#5b21b6",iconBg:"#ddd6fe"},
          caixa_direto: {bg:"#fef3c7",border:"#d97706",text:"#92400e",iconBg:"#fde68a"},
        };
        const especiais = mesas.filter(m=>m.tipo);
        if(!especiais.length) return null;
        return (
          <div style={{padding:"10px 14px 0"}}>
            <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Mesas Especiais</div>
            <div style={{display:"flex",gap:10}}>
              {especiais.map(m=>{
                const cor = CORES_ESPECIAL[m.tipo]||{bg:"#f0f0f0",border:"#aaa",text:"#555",iconBg:"#e0e0e0"};
                const totM = totMesaCompleta(m);
                const s = STATUS_MESA[m.status];
                return(
                  <div key={m.id} onClick={()=>{setSel(m.id);setSelSC(0);setTelaSalao("comanda");}} style={{flex:1,background:cor.bg,borderRadius:14,padding:"12px 10px",textAlign:"center",cursor:"pointer",border:`2px solid ${m.status==="livre"?cor.border:s.c}`,boxShadow:m.status!=="livre"?`0 0 0 2px ${s.c}40`:"none",position:"relative"}}>
                    {(m.status==="chamando"||m.status==="conta")&&<div style={{position:"absolute",top:-6,right:-6,width:16,height:16,background:s.c,borderRadius:"50%",fontSize:8,color:"#fff",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>!</div>}
                    <div style={{fontSize:24,marginBottom:2}}>{m.icon}</div>
                    <div style={{fontWeight:800,fontSize:13,color:cor.text}}>{m.nome}</div>
                    <div style={{fontSize:8,background:m.status==="livre"?cor.iconBg:s.bg,color:m.status==="livre"?cor.text:s.c,borderRadius:10,padding:"1px 7px",marginTop:3,fontWeight:700,display:"inline-block"}}>
                      {m.status==="livre"?"Livre":s.l}
                    </div>
                    {totM>0&&<div style={{fontSize:12,fontWeight:800,color:cor.text,marginTop:4}}>{fmtR(totM)}</div>}
                    {m.abertura&&<div style={{fontSize:9,color:cor.text,opacity:0.6,marginTop:2}}>⏱️{tempoAberto(m.abertura)}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* MESAS COMUNS */}
      <div style={{padding:"10px 14px 0"}}>
        <div style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Mesas</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,padding:"0 14px 14px"}}>
        {mesas.filter(m=>!m.tipo).map(m=>{
          const s=STATUS_MESA[m.status];
          const totM=totMesaCompleta(m);
          const nomeCliente = (m.subComandas||[]).map(sc=>sc.cliente).filter(Boolean).join(", ");
          return(
            <div key={m.id} onClick={()=>{setSel(m.id);setTelaSalao("comanda");}} style={{background:"#fff",borderRadius:14,padding:"10px 8px",textAlign:"center",cursor:"pointer",border:`2px solid ${m.status==="livre"?"#e8e8e8":s.c}`,boxShadow:m.status==="chamando"||m.status==="conta"?`0 0 0 2px ${s.c}`:"0 2px 8px rgba(0,0,0,0.07)",position:"relative"}}>
              {(m.status==="chamando"||m.status==="conta")&&<div style={{position:"absolute",top:-6,right:-6,width:16,height:16,background:s.c,borderRadius:"50%",fontSize:8,color:"#fff",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>!</div>}
              <div style={{fontSize:20}}>{s.e}</div>
              <div style={{fontWeight:800,fontSize:16,color:"#1a1a1a"}}>{m.id}</div>
              <div style={{fontSize:8,background:s.bg,color:s.c,borderRadius:10,padding:"1px 5px",marginTop:3,fontWeight:700,display:"inline-block"}}>{s.l}</div>
              {m.status!=="livre"&&<div style={{fontSize:11,fontWeight:800,color:"#7b1a0a",marginTop:3}}>{fmtR(totM)}</div>}
              {m.status!=="livre"&&(m.subComandas||[]).length>1&&<div style={{fontSize:9,color:"#8b5cf6",fontWeight:700,marginTop:1}}>{(m.subComandas||[]).length} comandas</div>}
              {m.abertura&&<div style={{fontSize:9,color:((Date.now()-new Date(m.abertura))/60000)>90?"#ef4444":"#aaa",marginTop:1}}>⏱️{tempoAberto(m.abertura)}</div>}
              {nomeCliente&&<div style={{fontSize:9,color:"#888",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{nomeCliente}</div>}
            </div>
          );
        })}
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",padding:"0 14px 14px"}}>
        {Object.entries(STATUS_MESA).map(([k,v])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#666"}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:v.c}}/>{v.l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ABA WHATSAPP ──────────────────────────────────────────────
function WhatsAppConexao({ conexao, backendUrl }) {
  const [qrCode, setQrCode] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [desconectando, setDesconectando] = useState(false);

  async function carregarStatus() {
    try {
      const r = await fetch(backendUrl + "/health");
      const d = await r.json();
      setStatus(d);
    } catch {}
  }

  async function carregarQR() {
    setLoading(true);
    try {
      const r = await fetch(backendUrl + "/qrcode");
      const html = await r.text();
      // Extrai o src da imagem do QR
      const match = html.match(/src="(data:image\/png;base64,[^"]+)"/);
      if (match) setQrCode(match[1]);
      else setQrCode("conectado");
    } catch { setQrCode(null); }
    setLoading(false);
  }

  async function desconectar() {
    setDesconectando(true);
    try {
      await fetch(backendUrl + "/whatsapp/logout", { method: "POST" });
      setQrCode(null);
      setStatus(null);
      setTimeout(carregarStatus, 3000);
    } catch {}
    setDesconectando(false);
  }

  useState(() => { carregarStatus(); }, []);

  const conectado = conexao === "online" || status?.whatsapp === "connected";

  return (
    <div style={{ padding: "20px", maxWidth: 500, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Status card */}
      <div style={{ background: T.white, borderRadius: T.radius, padding: "20px", boxShadow: T.shadow, border: `1px solid ${T.grayL}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.gray, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 16 }}>Status da Conexão</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: T.radius, background: conectado ? T.greenL : T.wineL, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, border: `1px solid ${conectado ? T.green+"30" : T.wine+"30"}` }}>
            {conectado ? "✅" : "📵"}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: T.dark }}>
              {conectado ? "WhatsApp Conectado" : "WhatsApp Desconectado"}
            </div>
            <div style={{ fontSize: 13, color: T.gray, marginTop: 3 }}>
              {conectado ? "Bot respondendo normalmente" : "Escaneie o QR Code para conectar"}
            </div>
          </div>
        </div>
        {status && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${T.grayL}`, display: "flex", gap: 16, fontSize: 12, color: T.gray }}>
            <span>📦 {status.pedidos || 0} pedidos</span>
            <span>🗄️ Base de Dados: {status.mongodb || "—"}</span>
            <span>⏱️ {status.uptime || "—"}</span>
          </div>
        )}
      </div>

      {/* QR Code card */}
      {!conectado && (
        <div style={{ background: T.white, borderRadius: T.radius, padding: "20px", boxShadow: T.shadow, border: `1px solid ${T.grayL}`, textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.gray, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 16 }}>Conectar WhatsApp</div>
          {qrCode && qrCode !== "conectado" ? (
            <>
              <img src={qrCode} alt="QR Code WhatsApp" style={{ width: 220, height: 220, borderRadius: T.radiusS, border: `1px solid ${T.grayL}` }} />
              <div style={{ fontSize: 12, color: T.gray, marginTop: 12 }}>
                Abra o WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong>
              </div>
              <div style={{ fontSize: 11, color: T.amber, marginTop: 6, fontWeight: 600 }}>⏱️ QR Code expira em ~60 segundos</div>
              <button onClick={carregarQR} style={{ marginTop: 12, background: T.grayLL, border: `1px solid ${T.grayL}`, color: T.gray, borderRadius: T.radiusS, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                🔄 Gerar novo QR Code
              </button>
            </>
          ) : (
            <button onClick={carregarQR} disabled={loading} style={{ background: `linear-gradient(135deg,${T.wineD},${T.wine})`, color: T.white, border: "none", borderRadius: T.radius, padding: "14px 28px", fontWeight: 700, fontSize: 15, cursor: "pointer", opacity: loading ? 0.7 : 1 }}>
              {loading ? "⏳ Carregando..." : "📱 Mostrar QR Code"}
            </button>
          )}
        </div>
      )}

      {/* Desconectar */}
      {conectado && (
        <div style={{ background: T.white, borderRadius: T.radius, padding: "16px 20px", boxShadow: T.shadow, border: `1px solid ${T.grayL}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.gray, marginBottom: 8 }}>Trocar número</div>
          <div style={{ fontSize: 12, color: T.gray, marginBottom: 12 }}>Desconecte para escanear com outro número do WhatsApp.</div>
          <button onClick={desconectar} disabled={desconectando} style={{ background: T.wineL, color: T.wine, border: `1px solid ${T.wine}30`, borderRadius: T.radiusS, padding: "9px 18px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
            {desconectando ? "⏳ Desconectando..." : "🔌 Desconectar WhatsApp"}
          </button>
        </div>
      )}

      <button onClick={carregarStatus} style={{ background: "none", border: "none", color: T.gray, fontSize: 13, cursor: "pointer", padding: "4px 0" }}>↻ Atualizar status</button>
    </div>
  );
}

// ── PAINEL PRINCIPAL ──────────────────────────────────────────
export default function PainelPedidos({ onLogout, onPinChange, pinAtual, abrirSalao, onSair, garcomLogado }) {
  const [pedidos, setPedidos] = useState(MOCK_PEDIDOS);
  const [cardapio, setCardapio] = useState(MOCK_CARDAPIO);
  const [cupons, setCupons] = useState(MOCK_CUPONS);
  const [avaliacoes, setAvaliacoes] = useState(MOCK_AVALIACOES);
  const [garcons, setGarcons] = useState([]);
  const [aba, setAba] = useState(abrirSalao ? "salao" : "pedidos");
  const [expanded, setExpanded] = useState(null);
  const [filtro, setFiltro] = useState("todos");
  const [atualizando, setAtualizando] = useState({});
  const [conexao, setConexao] = useState("offline");
  const [ultimaAtt, setUltimaAtt] = useState(null);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [statusLoja, setStatusLoja] = useState({ aberto: true, proximaAbertura: "—" });
  const [, setTick] = useState(0);
  const [perfilSalao, setPerfilSalao] = useState(abrirSalao || null); // persiste entre trocas de aba
  const [mesasSalao, setMesasSalao] = useState(() => {
    try {
      const lastDay = localStorage.getItem("imperio_mesas_dia");
      const hoje = new Date().toDateString();
      const regulares = Array.from({length:16},(_,i)=>initMesa(i));
      if (lastDay !== hoje) {
        localStorage.setItem("imperio_mesas_dia", hoje);
        return [...MESAS_ESPECIAIS_BASE, ...regulares];
      }
      const saved = localStorage.getItem("imperio_mesas_salao");
      if (!saved) return [...MESAS_ESPECIAIS_BASE, ...regulares];
      const parsed = JSON.parse(saved).map(migrarMesa);
      // Garante que as mesas especiais sempre existem
      const temFunc = parsed.some(m=>m.tipo==="funcionarios");
      const temCaixa = parsed.some(m=>m.tipo==="caixa_direto");
      const especiais = [
        temFunc ? parsed.find(m=>m.tipo==="funcionarios") : MESAS_ESPECIAIS_BASE[0],
        temCaixa ? parsed.find(m=>m.tipo==="caixa_direto") : MESAS_ESPECIAIS_BASE[1],
      ];
      const comuns = parsed.filter(m=>!m.tipo);
      return [...especiais, ...comuns];
    } catch { return [...MESAS_ESPECIAIS_BASE, ...Array.from({length:16},(_,i)=>initMesa(i))]; }
  });
  const [historicoSalao, setHistoricoSalao] = useState(() => {
    try {
      const lastDay = localStorage.getItem("imperio_historico_dia");
      const hoje = new Date().toDateString();
      if (lastDay !== hoje) return [];
      const saved = localStorage.getItem("imperio_historico_salao");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const [faturadoSalao, setFaturadoSalao] = useState(() => {
    try {
      const lastDay = localStorage.getItem("imperio_faturado_dia");
      const hoje = new Date().toDateString();
      if (lastDay !== hoje) {
        localStorage.setItem("imperio_faturado_dia", hoje);
        localStorage.setItem("imperio_faturado_salao", "0");
        return 0;
      }
      return parseFloat(localStorage.getItem("imperio_faturado_salao") || "0");
    } catch { return 0; }
  }); // persiste entre recargas, zera automaticamente a cada novo dia
  const [selSalao, setSelSalao] = useState(null); // mesa selecionada — persiste
  const [telaSalao, setTelaSalaoGlobal] = useState("mapa"); // tela atual — persiste
  const ant = useRef(new Set());
  const actx = useRef(null);

  const tocarSom = useCallback(() => {
    try {
      if (!actx.current) actx.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = actx.current; const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime); osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.3, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [rp, rc, rcu, ra, rcfg, rs, rg] = await Promise.all([
        fetch(BACKEND_URL + "/pedidos"),
        fetch(BACKEND_URL + "/cardapio"),
        fetch(BACKEND_URL + "/cupons"),
        fetch(BACKEND_URL + "/avaliacoes"),
        fetch(BACKEND_URL + "/config"),
        fetch(BACKEND_URL + "/config/status-loja"),
        fetch(BACKEND_URL + "/garcons"),
      ]);
      if (rp.ok) { const data = await rp.json(); const ids = new Set(data.map(p => p.id)); const novos = [...ids].filter(id => !ant.current.has(id)); if (novos.length > 0 && ant.current.size > 0) { setExpanded(novos[0]); tocarSom(); } ant.current = ids; setPedidos(data); }
      if (rc.ok) setCardapio(await rc.json());
      if (rcu.ok) setCupons(await rcu.json());
      if (ra.ok) setAvaliacoes(await ra.json());
      if (rcfg.ok) setConfig(await rcfg.json());
      if (rs.ok) setStatusLoja(await rs.json());
      if (rg.ok) setGarcons(await rg.json());
      setConexao("online"); setUltimaAtt(new Date());
    } catch { setConexao("offline"); }
  }, [tocarSom]);

  useEffect(() => { fetchAll(); const t = setInterval(fetchAll, POLLING_INTERVAL); return () => clearInterval(t); }, [fetchAll]);
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 30000); return () => clearInterval(t); }, []);

  // Persiste dados do salão no localStorage
  useEffect(() => { try { localStorage.setItem("imperio_faturado_salao", String(faturadoSalao)); } catch {} }, [faturadoSalao]);
  useEffect(() => { try { localStorage.setItem("imperio_historico_salao", JSON.stringify(historicoSalao)); localStorage.setItem("imperio_historico_dia", new Date().toDateString()); } catch {} }, [historicoSalao]);
  useEffect(() => { try { localStorage.setItem("imperio_mesas_salao", JSON.stringify(mesasSalao)); } catch {} }, [mesasSalao]);

  const updateStatus = async (id, novoStatus) => {
    setAtualizando(prev => ({ ...prev, [id]: true }));
    try {
      const r = await fetch(BACKEND_URL + "/pedidos/" + id + "/status", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: novoStatus }) });
      if (!r.ok) throw new Error();
      const at = await r.json();
      setPedidos(prev => prev.map(p => p.id === id ? { ...p, status: at.status } : p));
    } catch { setPedidos(prev => prev.map(p => p.id === id ? { ...p, status: novoStatus } : p)); }
    finally { setAtualizando(prev => ({ ...prev, [id]: false })); }
  };

  const saveConfig = async (novoCfg) => {
    try { await fetch(BACKEND_URL + "/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(novoCfg) }); setConfig(novoCfg); const rs = await fetch(BACKEND_URL + "/config/status-loja"); if (rs.ok) setStatusLoja(await rs.json()); } catch { setConfig(novoCfg); }
  };

  const counts = Object.keys(STATUS_CONFIG).reduce((a, s) => { a[s] = pedidos.filter(p => p.status === s).length; return a; }, {});
  const totalDeliveryHoje = pedidos.filter(p => p.status === "entregue" && isMesmosDias(p.horario, new Date())).reduce((s, p) => s + calcTotal(p.itens, p.desconto), 0);
  const totalSalaoHoje = faturadoSalao + mesasSalao.reduce((s, m) => s + totMesaCompleta(migrarMesa(m)), 0);
  const totalHoje = totalDeliveryHoje + totalSalaoHoje;
  const novos = counts["novo"] || 0;
  const pf = (filtro === "todos" ? pedidos : pedidos.filter(p => p.status === filtro)).sort((a, b) => new Date(b.horario) - new Date(a.horario));
  const mediaAv = avaliacoes.length > 0 ? (avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length).toFixed(1) : null;
  const cc = { conectando: { cor: "#f59e0b", txt: "conectando..." }, online: { cor: "#10b981", txt: "atualizado às " + (ultimaAtt ? horaFmt(ultimaAtt) : "") }, offline: { cor: "#f59e0b", txt: "modo demonstração" } }[conexao];

  const abas = [
    ["pedidos",    "📋", "Pedidos"],
    ["salao",      "🍽️", "Salão"],
    ["relatorios", "📊", "Rel."],
    ["clientes",   "👥", "Clientes"],
    ["cardapio",   "🍢", "Cardápio"],
    ["cupons",     "🎟️", "Cupons"],
    ["fidelidade", "🏆", "Fidelid."],
    ["avaliacoes", "⭐", "Aval."],
    ["whatsapp",   "📱", "WhatsApp"],
    ["config",     "⚙️", "Config"],
  ];

  const mesasPendentes = mesasSalao.filter(m => m.status === "chamando" || m.status === "conta").length;

  return (
    <div style={{ fontFamily: "'DM Sans','Segoe UI',sans-serif", minHeight: "100vh", background: T.cream, display: "flex", flexDirection: "column" }}>

      {/* HEADER DESKTOP — oculta para garçom/caixa */}
      {!abrirSalao && <div className="header-desktop" style={{ background: T.white, borderBottom: `1px solid ${T.grayL}`, color: T.dark, padding: "0 28px", position: "sticky", top: 0, zIndex: 20, boxShadow: T.shadow, height: 64 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1400, margin: "0 auto", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div>
              <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 1, textTransform: "uppercase" }}>Painel do Dono</div>
              <div style={{ fontWeight: 800, fontSize: 20 }}>👑 Império dos Espetos</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                <div key={k} style={{ background: "rgba(255,255,255,0.15)", borderRadius: 10, padding: "5px 12px", border: k === "novo" && counts[k] > 0 ? "1.5px solid #f59e0b" : "1.5px solid rgba(255,255,255,0.1)", cursor: "pointer" }} onClick={() => { setAba("pedidos"); setFiltro(k); }}>
                  <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1, textAlign: "center" }}>{counts[k] || 0}</div>
                  <div style={{ fontSize: 10, opacity: 0.8, marginTop: 1 }}>{c.icon} {c.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>Faturamento hoje</div>
              <div style={{ fontWeight: 800, fontSize: 22, color: "#f0c040" }}>R$ {totalHoje.toFixed(2)}</div>
              <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>🛵 R$ {totalDeliveryHoje.toFixed(2)} · 🍽️ R$ {totalSalaoHoje.toFixed(2)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, fontSize: 11, opacity: 0.9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: cc.cor, display: "inline-block" }} />
                {cc.txt}
                <button onClick={fetchAll} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.75)", cursor: "pointer", fontSize: 14, padding: 0 }}>↻</button>
              {onSair && <button onClick={onSair} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 13, padding: 0, marginLeft: 4 }}>🔒</button>}
              </div>
              <span style={{ background: statusLoja.aberto ? "rgba(74,222,128,0.25)" : "rgba(239,68,68,0.25)", color: statusLoja.aberto ? "#4ade80" : "#fca5a5", borderRadius: 20, padding: "2px 10px", fontWeight: 700, fontSize: 11 }}>
                {statusLoja.aberto ? "🟢 ABERTO" : "🔴 FECHADO"}
              </span>
            </div>
          </div>
        </div>
      </div>}

      {/* HEADER MOBILE — compacto, oculta para garçom/caixa */}
      {!abrirSalao && <div className="header-mobile" style={{ background: T.white, borderBottom: `1px solid ${T.grayL}`, padding: "10px 16px", position: "sticky", top: 0, zIndex: 20, boxShadow: T.shadow, display: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: `linear-gradient(135deg,${T.wineD},${T.wine})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>👑</div>
            <div>
              <div style={{ fontFamily: "'Playfair Display',Georgia,serif", fontWeight: 700, fontSize: 14, color: T.dark }}>Império dos Espetos</div>
              <div style={{ fontSize: 10, color: T.gray, marginTop: 1 }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: cc.cor, display: "inline-block", marginRight: 3 }} />
                {statusLoja.aberto ? "Aberto" : "Fechado"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: T.gray, textTransform: "uppercase", letterSpacing: 1 }}>Hoje</div>
              <div style={{ fontWeight: 700, fontSize: 17, color: T.wine }}>R$ {totalHoje.toFixed(2)}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={fetchAll} style={{ background: T.grayLL, border: `1px solid ${T.grayL}`, color: T.gray, cursor: "pointer", fontSize: 13, padding: "5px 8px", borderRadius: 8 }}>↻</button>
              {onSair && <button onClick={onSair} style={{ background: T.wineL, border: `1px solid ${T.wine}30`, color: T.wine, cursor: "pointer", fontSize: 13, padding: "5px 8px", borderRadius: 8, fontWeight: 600 }}>🔒</button>}
            </div>
          </div>
        </div>
      </div>}

      {/* BODY — sidebar + content */}
      <div style={{ display: "flex", flex: 1, maxWidth: 1400, margin: "0 auto", width: "100%" }}>

        {/* SIDEBAR DESKTOP — oculta para garçom/caixa */}
        {!abrirSalao && <div className="sidebar-desktop" style={{ width: 180, background: "#fff", borderRight: "1px solid #e8e8e8", display: "flex", flexDirection: "column", position: "sticky", top: 57, height: "calc(100vh - 57px)", overflowY: "auto", flexShrink: 0 }}>
          <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
            {abas.map(([k, icon, label]) => (
              <button key={k} onClick={() => setAba(k)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, border: "none", cursor: "pointer", background: aba === k ? "#fef0ed" : "transparent", color: aba === k ? "#7b1a0a" : "#666", fontWeight: aba === k ? 700 : 500, fontSize: 13, transition: "all 0.15s", textAlign: "left", position: "relative" }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
                <span>{label}</span>
                {k === "pedidos" && novos > 0 && <span style={{ position: "absolute", right: 10, background: "#f59e0b", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 800 }}>{novos}</span>}
                {k === "salao" && mesasPendentes > 0 && <span style={{ position: "absolute", right: 10, background: "#8b5cf6", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 800 }}>{mesasPendentes}</span>}
                {aba === k && <div style={{ position: "absolute", left: 0, top: "20%", bottom: "20%", width: 3, background: "#7b1a0a", borderRadius: "0 3px 3px 0" }} />}
              </button>
            ))}
          </div>
          <div style={{ marginTop: "auto", padding: "12px 14px", borderTop: "1px solid #f0f0f0", fontSize: 11, color: "#bbb" }}>
            {mediaAv && <div style={{ marginBottom: 4 }}>⭐ {mediaAv}</div>}
            <div style={{ marginBottom: 8 }}>v5.0 — Baileys</div>
            {onSair && (
              <button onClick={onSair} style={{ width: "100%", background: "#fee2e2", color: "#ef4444", border: "1px solid #fca5a5", borderRadius: 8, padding: "7px 0", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                🔒 Sair
              </button>
            )}
          </div>
        </div>}

        {/* CONTEÚDO PRINCIPAL */}
        <div className="main-content" style={{ flex: 1, minWidth: 0, overflow: "auto", background: T.cream }}>

          {/* Alerta novos pedidos */}
          {novos > 0 && aba === "pedidos" && (
            <div style={{ background: T.amberL, borderBottom: `2px solid ${T.amber}`, padding: "10px 20px", display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: T.amber, fontWeight: 600, borderRadius: 0 }}>
              🔔 <strong>{novos} novo{novos > 1 ? "s" : ""} pedido{novos > 1 ? "s" : ""}</strong> aguardando!
            </div>
          )}

          {/* Filtros de status */}
          {aba === "pedidos" && (
            <div style={{ background: T.white, padding: "12px 16px", display: "flex", gap: 6, flexWrap: "wrap", borderBottom: `1px solid ${T.grayL}` }}>
              {[["todos","📋 Todos"], ...Object.entries(STATUS_CONFIG).map(([k, v]) => [k, v.icon + " " + v.label])].map(([k, l]) => (
                <button key={k} onClick={() => setFiltro(k)} style={{ whiteSpace: "nowrap", padding: "6px 14px", borderRadius: 20, border: `1px solid ${filtro===k ? T.wine : T.grayL}`, cursor: "pointer", fontSize: 13, fontWeight: filtro === k ? 600 : 400, background: filtro === k ? T.wine : T.white, color: filtro === k ? T.white : T.gray, transition: "all 0.15s", fontFamily: "'DM Sans',sans-serif" }}>
                  {l}{k !== "todos" && counts[k] > 0 && <span style={{ marginLeft: 5, background: filtro===k ? "rgba(255,255,255,0.25)" : T.wineL, color: filtro===k ? T.white : T.wine, borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>{counts[k]}</span>}
                </button>
              ))}
            </div>
          )}

          {/* Conteúdo das abas */}
          {aba === "pedidos" && (
            <div style={{ padding: "20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 14 }}>
              {pf.length === 0
                ? <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "80px 20px", color: T.gray, fontSize: 16 }}><div style={{ fontSize: 50, marginBottom: 12, opacity: 0.3 }}>🍢</div>Nenhum pedido encontrado.</div>
                : pf.map(p => <PedidoCard key={p.id} pedido={p} expanded={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)} onStatus={updateStatus} atualizando={!!atualizando[p.id]} />)
              }
            </div>
          )}

          {aba === "relatorios"  && <Relatorios pedidos={pedidos} faturadoSalao={faturadoSalao} mesasSalao={mesasSalao} setMesasSalaoRel={setMesasSalao} historicoSalao={historicoSalao} setHistoricoSalao={setHistoricoSalao} setFaturadoSalaoRel={setFaturadoSalao} />}
          {aba === "clientes"    && <Clientes pedidos={pedidos} />}
          {aba === "cardapio"    && <Cardapio cardapio={cardapio} onReload={fetchAll} />}
          {aba === "cupons"      && <Cupons cupons={cupons} onReload={fetchAll} />}
          {aba === "fidelidade"  && <Fidelidade pedidos={pedidos} config={config} />}
          {aba === "avaliacoes"  && <Avaliacoes avaliacoes={avaliacoes} />}
          {aba === "salao"       && <SalaoIntegrado cardapio={cardapio} perfilSalao={abrirSalao ? perfilSalao : (perfilSalao || "caixa")} setPerfilSalao={setPerfilSalao} mesasSalao={mesasSalao} setMesasSalao={setMesasSalao} faturadoSalao={faturadoSalao} setFaturadoSalao={setFaturadoSalao} selSalao={selSalao} setSelSalao={setSelSalao} telaSalaoGlobal={telaSalao} setTelaSalaoGlobal={setTelaSalaoGlobal} isDono={!abrirSalao} historicoSalao={historicoSalao} setHistoricoSalao={setHistoricoSalao} onSairApp={onSair} garcomLogado={garcomLogado} />}
          {aba === "whatsapp"   && <WhatsAppConexao conexao={conexao} backendUrl={BACKEND_URL} />}
          {aba === "config"      && <Configuracoes config={config} onSave={saveConfig} statusLoja={statusLoja} garcons={garcons} onReloadGarcons={fetchAll} />}
        </div>
      </div>

      {/* BARRA INFERIOR MOBILE — oculta para garçom/caixa */}
      {!abrirSalao && <div className="mobile-nav" style={{ display: "none" }}>
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: T.white, borderTop: `1px solid ${T.grayL}`, display: "flex", zIndex: 50, boxShadow: "0 -4px 20px rgba(28,25,23,0.08)", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {abas.map(([k, icon, label]) => (
            <button key={k} onClick={() => setAba(k)} style={{ flex: 1, padding: "8px 2px 10px", border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, color: aba === k ? T.wine : T.gray, position: "relative", transition: "color 0.15s" }}>
              <span style={{ fontSize: aba === k ? 21 : 19, transition: "font-size 0.15s" }}>{icon}</span>
              <span style={{ fontSize: 9, fontWeight: aba === k ? 700 : 400, whiteSpace: "nowrap" }}>{label}</span>
              {aba === k && <div style={{ position: "absolute", top: 0, left: "20%", right: "20%", height: 2, background: T.wine, borderRadius: "0 0 4px 4px" }} />}
              {k === "pedidos" && novos > 0 && <span style={{ position: "absolute", top: 5, right: "18%", background: T.amber, color: T.white, borderRadius: 10, padding: "0 4px", fontSize: 9, fontWeight: 800, minWidth: 14, textAlign: "center" }}>{novos}</span>}
              {k === "salao" && mesasPendentes > 0 && <span style={{ position: "absolute", top: 5, right: "18%", background: T.purple, color: T.white, borderRadius: 10, padding: "0 4px", fontSize: 9, fontWeight: 800, minWidth: 14, textAlign: "center" }}>{mesasPendentes}</span>}
            </button>
          ))}
        </div>
      </div>}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap');
        @media (max-width: 768px) {
          .header-desktop { display: none !important; }
          .header-mobile { display: block !important; }
          .sidebar-desktop { display: none !important; }
          .mobile-nav { display: block !important; }
          .main-content { padding-bottom: 68px !important; }
        }
        @media (min-width: 769px) {
          .header-mobile { display: none !important; }
          .mobile-nav { display: none !important; }
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(139,38,53,0.15); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(139,38,53,0.3); }
        button { transition: all 0.15s ease; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
