import { useState, useEffect, useCallback, useRef } from "react";
import { authFetch } from "./auth.js";
import { impressora } from "./bluetoothPrinter.js";

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
const TAXA_ENTREGA_PADRAO = 5;
// Abre janela de impressao verificando bloqueio de popup.
// Antes: window.open devolvia null (iOS/Safari, bloqueador ativo) e o
// win.document.write seguinte lancava TypeError. Em imprimirCozinha e no
// fechamento isso acontecia DEPOIS de gravar a venda, travando a UI no meio.
// ── FILA DE IMPRESSÃO ─────────────────────────────────────────
// A termica fica pareada num aparelho so (o caixa). Quem nao alcanca ela
// manda o ticket para o servidor; a estacao imprime.
const CHAVE_ESTACAO = "imperio_estacao_impressao";

// Ligada por padrao em quem ja pareou a impressora — se depender de alguem
// lembrar de ativar, os tickets ficam parados na fila.
function estacaoLigada() {
  try {
    const v = localStorage.getItem(CHAVE_ESTACAO);
    if (v === null) return impressora.temDispositivoSalvo();
    return v === "1";
  } catch { return false; }
}
function setEstacaoLigada(ligada) {
  try { localStorage.setItem(CHAVE_ESTACAO, ligada ? "1" : "0"); } catch {}
}

async function enfileirarImpressao(tipo, dados) {
  const r = await authFetch(BACKEND_URL + "/impressao", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo, dados }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.erro || "Falha ao enviar para a impressora do caixa");
  }
  return r.json();
}

function abrirJanelaImpressao(dimensoes = "width=400,height=600") {
  const win = window.open("", "_blank", dimensoes);
  if (!win) {
    alert("Nao foi possivel abrir a janela de impressao. Libere os pop-ups para este site nas configuracoes do navegador.");
    return null;
  }
  return win;
}

function calcTotal(itens = [], desconto = 0, taxa = TAXA_ENTREGA_PADRAO) {
  return itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0) + (Number(taxa) || 0) - (desconto || 0);
}
// O backend ja grava o total com a taxa vigente na hora do pedido.
// Esse valor e a fonte da verdade — recalcular no cliente com taxa fixa
// fazia o painel divergir do que foi realmente cobrado do cliente.
function totalPedido(pedido, taxa = TAXA_ENTREGA_PADRAO) {
  const t = Number(pedido?.total);
  if (Number.isFinite(t) && t > 0) return t;
  return calcTotal(pedido?.itens || [], pedido?.desconto || 0, taxa);
}
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
      await authFetch(BACKEND_URL + "/cupons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...novo, valor: parseFloat(novo.valor), usoMax: novo.usoMax ? parseInt(novo.usoMax) : null }) });
      onReload();
    } catch { onReload(); }
    setSaving(false);
    setNovoForm(false);
    setNovo({ codigo: "", tipo: "percentual", valor: "", usoMax: "", validade: "", descricao: "" });
  }

  async function toggleCupom(codigo, ativo) {
    try { await authFetch(BACKEND_URL + "/cupons/" + codigo + "/ativo", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo }) }); onReload(); } catch { onReload(); }
  }

  async function deletarCupom(codigo) {
    if (!window.confirm("Remover cupom " + codigo + "?")) return;
    try { await authFetch(BACKEND_URL + "/cupons/" + codigo, { method: "DELETE" }); onReload(); } catch { onReload(); }
  }

  async function testarCupom() {
    try {
      const res = await authFetch(BACKEND_URL + "/cupons/validar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codigo: testeCodigo, subtotal: parseFloat(testeSubtotal) }) });
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
    try { await authFetch(BACKEND_URL + "/cardapio/" + item.id + "/ativo", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo: !item.ativo }) }); onReload(); } catch { onReload(); }
  }
  async function salvarEdicao(item) {
    setSaving(true);
    // Variação em branco é rascunho do formulário, não erro: some no salvamento
    const limpo = { ...item, variacoes: (item.variacoes || []).filter(v => String(v.nome || "").trim() !== "") };
    try {
      const r = await authFetch(BACKEND_URL + "/cardapio/" + item.id, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(limpo),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        // Sem isso o erro do servidor sumia e o usuário achava que tinha salvo
        alert("Nao foi possivel salvar: " + (d.erro || ("erro " + r.status)));
        setSaving(false);
        return;
      }
      onReload();
    } catch { onReload(); }
    setSaving(false); setEditando(null);
  }
  async function deletarItem(id) {
    if (!window.confirm("Remover item?")) return;
    try { await authFetch(BACKEND_URL + "/cardapio/" + id, { method: "DELETE" }); onReload(); } catch { onReload(); }
  }
  async function adicionarItem() {
    if (!novoItem.categoria || !novoItem.nome || !novoItem.preco) return;
    setSaving(true);
    try { await authFetch(BACKEND_URL + "/cardapio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...novoItem, preco: parseFloat(novoItem.preco), tempoPreparo: parseInt(novoItem.tempoPreparo) }) }); onReload(); } catch { onReload(); }
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
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>🎉 Preço promocional (modo evento)</div>
                  <input type="number" step="0.50" value={editando.precoPromocional || ""} onChange={e => setEditando(p => ({ ...p, precoPromocional: e.target.value === "" ? null : parseFloat(e.target.value) }))} placeholder="Deixe vazio para não entrar no evento" style={inputStyle} />
                </div>
              </div>

              {/* Variações — mesmo prato, preço diferente conforme a escolha */}
              <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#666", marginBottom: 2 }}>🍖 Variações (opcional)</div>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 6, lineHeight: 1.5 }}>
                  Para prato que muda de preço conforme a escolha — o tipo de carne, por exemplo.
                  Cada variação leva o <strong>preço final</strong> do item, não o acréscimo.
                  Sem nenhuma variação, o item usa o preço lá em cima.
                </div>

                {(editando.variacoes || []).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>Título da escolha</div>
                    <input value={editando.variacaoRotulo || ""} placeholder="Tipo de carne"
                      onChange={e => setEditando(p => ({ ...p, variacaoRotulo: e.target.value }))}
                      style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                )}

                {(editando.variacoes || []).map((v, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 5, alignItems: "center" }}>
                    <input value={v.nome} placeholder="Picanha"
                      onChange={e => setEditando(p => ({ ...p, variacoes: (p.variacoes || []).map((x, i) => i === idx ? { ...x, nome: e.target.value } : x) }))}
                      style={{ ...inputStyle, fontSize: 12, flex: 2 }} />
                    <input type="number" step="0.50" value={v.preco} placeholder="0.00"
                      onChange={e => setEditando(p => ({ ...p, variacoes: (p.variacoes || []).map((x, i) => i === idx ? { ...x, preco: e.target.value === "" ? "" : parseFloat(e.target.value) } : x) }))}
                      style={{ ...inputStyle, fontSize: 12, flex: 1 }} />
                    <button onClick={() => setEditando(p => ({ ...p, variacoes: (p.variacoes || []).filter((_, i) => i !== idx) }))}
                      style={{ background: "#fee2e2", color: "#ef4444", border: "none", borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>✕</button>
                  </div>
                ))}

                <button onClick={() => setEditando(p => ({ ...p, variacoes: [...(p.variacoes || []), { nome: "", preco: p.preco || 0 }] }))}
                  style={{ background: "#f0f0f0", color: "#555", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer", fontWeight: 700 }}>
                  + Variação
                </button>
              </div>

              {/* Dados fiscais — quem define e o contador. Vazio = usa o padrao da config fiscal */}
              <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#666", marginBottom: 2 }}>🧾 Dados fiscais (NFC-e)</div>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 6 }}>Deixe vazio para usar o padrao definido em Config → Fiscal. Peca os valores ao contador.</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>NCM</div>
                    <input value={editando.fiscal?.ncm || ""} onChange={e => setEditando(p => ({ ...p, fiscal: { ...(p.fiscal||{}), ncm: e.target.value } }))} placeholder="padrao" style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>CFOP</div>
                    <input value={editando.fiscal?.cfop || ""} onChange={e => setEditando(p => ({ ...p, fiscal: { ...(p.fiscal||{}), cfop: e.target.value } }))} placeholder="padrao" style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>CSOSN</div>
                    <input value={editando.fiscal?.csosn || ""} onChange={e => setEditando(p => ({ ...p, fiscal: { ...(p.fiscal||{}), csosn: e.target.value } }))} placeholder="padrao" style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>CEST</div>
                    <input value={editando.fiscal?.cest || ""} onChange={e => setEditando(p => ({ ...p, fiscal: { ...(p.fiscal||{}), cest: e.target.value } }))} placeholder="se ST" style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#888", marginBottom: 2 }}>Unid.</div>
                    <input value={editando.fiscal?.unidade || ""} onChange={e => setEditando(p => ({ ...p, fiscal: { ...(p.fiscal||{}), unidade: e.target.value } }))} placeholder="UN" style={{ ...inputStyle, fontSize: 12 }} />
                  </div>
                </div>
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
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 15, color: "#7b1a0a" }}>R$ {item.preco.toFixed(2)}</div>
                {item.precoPromocional > 0 && <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600 }}>🎉 R$ {item.precoPromocional.toFixed(2)}</div>}
              </div>
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

// ── NFC-e NA LISTA DE VENDAS ──────────────────────────────────
function BadgeNota({ status }) {
  if (!status || status === "sem_nota") return null;
  const cfg = {
    autorizada:  { txt: "🧾 Com nota", bg: "#d1fae5", cor: "#065f46" },
    processando: { txt: "⏳ Emitindo",  bg: "#fef3c7", cor: "#92400e" },
    rejeitada:   { txt: "❌ Rejeitada", bg: "#fee2e2", cor: "#991b1b" },
    erro:        { txt: "⚠️ Erro",      bg: "#fee2e2", cor: "#991b1b" },
    cancelada:   { txt: "🚫 Cancelada", bg: "#f0f0f0", cor: "#666" },
  }[status];
  if (!cfg) return null;
  return (
    <div style={{ display: "inline-block", background: cfg.bg, color: cfg.cor, borderRadius: 8, padding: "2px 8px", fontSize: 10, fontWeight: 700, marginTop: 3 }}>
      {cfg.txt}
    </div>
  );
}

function BotaoEmitirNota({ venda, onEmitido }) {
  const [emitindo, setEmitindo] = useState(false);
  const [erro, setErro] = useState(null);
  const [cpf, setCpf] = useState("");
  const [pedindoCpf, setPedindoCpf] = useState(false);

  const jaTem = venda.notaFiscalStatus === "autorizada";

  async function emitir() {
    setEmitindo(true); setErro(null);
    try {
      const r = await authFetch(BACKEND_URL + "/notas/emitir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendaId: venda._id, cpfCliente: cpf.replace(/\D/g, "") }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const det = d.faltando?.length ? " Falta: " + d.faltando.join(", ")
                  : d.detalhes?.length ? " " + d.detalhes.join("; ") : "";
        setErro((d.erro || "Falha ao emitir") + det);
      } else {
        setPedindoCpf(false);
        if (onEmitido) onEmitido();
      }
    } catch { setErro("Erro de conexao ao emitir a nota."); }
    setEmitindo(false);
  }

  if (jaTem) {
    return (
      <div style={{ marginTop: 10, padding: "8px 10px", background: "#d1fae5", borderRadius: 8, fontSize: 12, color: "#065f46", fontWeight: 600 }}>
        🧾 Nota fiscal emitida para esta venda
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      {!pedindoCpf ? (
        <button onClick={() => setPedindoCpf(true)} style={{ width: "100%", background: "#fff", color: "#7b1a0a", border: "1.5px solid #7b1a0a", borderRadius: 8, padding: "8px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          🧾 Emitir NFC-e
        </button>
      ) : (
        <div style={{ background: "#faf9f8", borderRadius: 10, padding: 10 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>CPF na nota (opcional)</div>
          <input value={cpf} onChange={e => setCpf(e.target.value)} placeholder="somente numeros"
            style={{ width: "100%", padding: "7px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={emitir} disabled={emitindo} style={{ flex: 2, background: "linear-gradient(135deg,#065f46,#10b981)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 13, cursor: emitindo ? "not-allowed" : "pointer", opacity: emitindo ? 0.7 : 1 }}>
              {emitindo ? "Emitindo..." : "Confirmar emissao"}
            </button>
            <button onClick={() => { setPedindoCpf(false); setErro(null); }} style={{ flex: 1, background: "#f0f0f0", color: "#555", border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {erro && (
        <div style={{ marginTop: 8, padding: "8px 10px", background: "#fee2e2", border: "1px solid #ef4444", borderRadius: 8, fontSize: 11, color: "#991b1b", lineHeight: 1.5 }}>
          {erro}
        </div>
      )}
    </div>
  );
}

// ── CERTIFICADO DIGITAL A1 ────────────────────────────────────
function CertificadoConfig() {
  const [status, setStatus] = useState(null);
  const [arquivo, setArquivo] = useState(null);
  const [senha, setSenha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [msg, setMsg] = useState(null);

  function showMsg(texto, tipo = "ok") { setMsg({ texto, tipo }); setTimeout(() => setMsg(null), 6000); }

  async function carregar() {
    try {
      const r = await authFetch(BACKEND_URL + "/fiscal/certificado");
      if (r.ok) setStatus(await r.json());
    } catch {}
  }
  useEffect(() => { carregar(); }, []);

  async function enviar() {
    if (!arquivo) return showMsg("Selecione o arquivo .pfx ou .p12", "erro");
    if (!senha) return showMsg("Informe a senha do certificado", "erro");
    setEnviando(true);
    try {
      // Converte o arquivo para base64 sem estourar a pilha em arquivos maiores
      const buf = await arquivo.arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      const base64 = btoa(bin);

      const r = await authFetch(BACKEND_URL + "/fiscal/certificado", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certBase64: base64, senha }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showMsg(d.erro || "Falha ao enviar o certificado", "erro"); }
      else {
        showMsg(`Certificado de ${d.titular} instalado! Valido ate ${new Date(d.validoAte).toLocaleDateString("pt-BR")}.`);
        setArquivo(null); setSenha("");
        await carregar();
      }
    } catch (e) {
      showMsg("Erro ao processar o arquivo: " + e.message, "erro");
    }
    setEnviando(false);
  }

  async function testar() {
    try {
      const r = await authFetch(BACKEND_URL + "/fiscal/certificado/testar", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) showMsg(`OK — ${d.titular} (CNPJ ${d.cnpj || "n/d"})`);
      else showMsg(d.erro || "Falha no teste", "erro");
    } catch { showMsg("Erro de conexao", "erro"); }
  }

  async function remover() {
    if (!window.confirm("Remover o certificado? Sera necessario enviar o arquivo de novo para emitir notas.")) return;
    try {
      const r = await authFetch(BACKEND_URL + "/fiscal/certificado", { method: "DELETE" });
      if (r.ok) { showMsg("Certificado removido."); await carregar(); }
    } catch { showMsg("Erro ao remover", "erro"); }
  }

  const inp = { width: "100%", padding: "8px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🔐 Certificado Digital A1</div>

      {/* Alerta se a chave de cifra nao estiver no servidor */}
      {status && status.chaveCifraOk === false && (
        <div style={{ background: "#fee2e2", border: "1px solid #ef4444", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#991b1b", lineHeight: 1.6 }}>
          ⚠️ <strong>CERT_ENCRYPTION_KEY nao configurada no servidor.</strong><br />
          Sem ela o certificado nao pode ser guardado com seguranca. Adicione a variavel no .env do backend e reinicie.
        </div>
      )}

      {/* Status atual */}
      {status?.configurado ? (
        <div style={{
          padding: 12, borderRadius: 10,
          background: status.vencido ? "#fee2e2" : status.vencendo ? "#fef3c7" : "#d1fae5",
          border: "1.5px solid " + (status.vencido ? "#ef4444" : status.vencendo ? "#f59e0b" : "#10b981"),
        }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: status.vencido ? "#991b1b" : status.vencendo ? "#92400e" : "#065f46" }}>
            {status.vencido ? "❌ Certificado VENCIDO" : status.vencendo ? "⚠️ Vencendo em breve" : "✅ Certificado instalado"}
          </div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 6, lineHeight: 1.7 }}>
            <strong>{status.titular}</strong><br />
            {status.cnpj && <>CNPJ: {status.cnpj}<br /></>}
            Valido ate: <strong>{status.validoAte ? new Date(status.validoAte).toLocaleDateString("pt-BR") : "—"}</strong>
            {status.diasRestantes !== null && !status.vencido && ` (${status.diasRestantes} dias)`}
            {status.emissor && <><br />Emissor: {status.emissor}</>}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button onClick={testar} style={{ flex: 1, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 8, padding: "7px 0", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              Testar leitura
            </button>
            <button onClick={remover} style={{ background: "#fee2e2", color: "#ef4444", border: "1px solid #fca5a5", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              Remover
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: 12, borderRadius: 10, background: "#f5f5f5", border: "1.5px solid #e0e0e0", fontSize: 13, color: "#666" }}>
          Nenhum certificado instalado.
        </div>
      )}

      {/* Upload */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 8 }}>
          {status?.configurado ? "Substituir certificado" : "Enviar certificado"}
        </div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 3 }}>Arquivo .pfx ou .p12</div>
        <input type="file" accept=".pfx,.p12" onChange={e => setArquivo(e.target.files?.[0] || null)}
          style={{ ...inp, padding: "7px", fontSize: 12 }} />
        <div style={{ fontSize: 11, color: "#888", margin: "8px 0 3px" }}>Senha do certificado</div>
        <input type="password" value={senha} onChange={e => setSenha(e.target.value)} placeholder="senha do arquivo" style={inp} />
        <button onClick={enviar} disabled={enviando || !arquivo || !senha}
          style={{
            width: "100%", marginTop: 10, background: (enviando || !arquivo || !senha) ? "#ccc" : "linear-gradient(135deg,#7b1a0a,#c0392b)",
            color: "#fff", border: "none", borderRadius: 10, padding: "11px 0", fontWeight: 700, fontSize: 14,
            cursor: (enviando || !arquivo || !senha) ? "not-allowed" : "pointer",
          }}>
          {enviando ? "Validando e enviando..." : "🔐 Instalar certificado"}
        </button>
      </div>

      {msg && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: msg.tipo === "ok" ? "#d1fae5" : "#fee2e2", color: msg.tipo === "ok" ? "#065f46" : "#991b1b", fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>
          {msg.texto}
        </div>
      )}

      <div style={{ background: "#faf9f8", borderRadius: 10, padding: "10px 12px", fontSize: 11, color: "#888", lineHeight: 1.6 }}>
        🔒 O arquivo e a senha sao <strong>cifrados (AES-256-GCM)</strong> antes de ir para o banco. A chave de cifra
        fica so no servidor, numa variavel de ambiente — um backup do banco, sozinho, nao permite assinar nada.<br /><br />
        A senha e validada de verdade na hora do envio: se estiver errada, o arquivo nem abre e o envio e recusado.
      </div>
    </div>
  );
}

// ── CONFIGURAÇÃO FISCAL (NFC-e) ───────────────────────────────
function FiscalConfig() {
  const [cfg, setCfg] = useState(null);
  const [status, setStatus] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState(null);

  function showMsg(texto, tipo = "ok") { setMsg({ texto, tipo }); setTimeout(() => setMsg(null), 4000); }

  async function carregar() {
    setCarregando(true);
    try {
      const [rc, rs] = await Promise.all([
        authFetch(BACKEND_URL + "/config/fiscal"),
        authFetch(BACKEND_URL + "/config/fiscal/status"),
      ]);
      if (rc.ok) setCfg(await rc.json());
      if (rs.ok) setStatus(await rs.json());
    } catch { showMsg("Erro ao carregar configuracao fiscal.", "erro"); }
    setCarregando(false);
  }
  useEffect(() => { carregar(); }, []);

  async function salvar() {
    setSalvando(true);
    try {
      const r = await authFetch(BACKEND_URL + "/config/fiscal", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cfg),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); showMsg(e.erro || "Erro ao salvar.", "erro"); }
      else { setCfg(await r.json()); showMsg("Configuracao fiscal salva!"); await carregar(); }
    } catch { showMsg("Erro de conexao.", "erro"); }
    setSalvando(false);
  }

  const set = (campo, v) => setCfg(p => ({ ...p, [campo]: v }));
  const setEnd = (campo, v) => setCfg(p => ({ ...p, endereco: { ...p.endereco, [campo]: v } }));

  // Busca o codigo IBGE pelo nome do municipio (API oficial, via backend).
  // Evita tabela fixa no codigo, que e onde nascem os erros de digitacao.
  const [sugestoesMun, setSugestoesMun] = useState([]);
  const [erroMun, setErroMun] = useState("");
  const timerMun = useRef(null);
  useEffect(() => () => { if (timerMun.current) clearTimeout(timerMun.current); }, []);

  function buscarMunicipio(texto) {
    setErroMun("");
    if (timerMun.current) clearTimeout(timerMun.current);
    if (!texto || texto.trim().length < 2) { setSugestoesMun([]); return; }
    timerMun.current = setTimeout(async () => {
      try {
        const uf = (cfg.endereco?.uf || "PR").toUpperCase();
        const r = await authFetch(BACKEND_URL + "/fiscal/municipios?uf=" + uf + "&busca=" + encodeURIComponent(texto));
        if (!r.ok) { const e = await r.json().catch(() => ({})); setErroMun(e.erro || "Falha na busca"); setSugestoesMun([]); return; }
        setSugestoesMun(await r.json());
      } catch { setErroMun("Sem conexao para buscar o municipio"); setSugestoesMun([]); }
    }, 350);
  }
  const setPad = (campo, v) => setCfg(p => ({ ...p, padroes: { ...p.padroes, [campo]: v } }));

  const inp = { width: "100%", padding: "8px 10px", border: "1.5px solid #e0e0e0", borderRadius: 8, fontSize: 13, color: "#333", outline: "none", boxSizing: "border-box" };
  const lbl = { fontSize: 11, color: "#888", marginBottom: 3 };

  if (carregando) return <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center", color: "#888" }}>Carregando...</div>;
  if (!cfg) return <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center", color: "#ef4444" }}>Nao foi possivel carregar.</div>;

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🧾 Nota Fiscal (NFC-e)</div>

      <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e", lineHeight: 1.6 }}>
        ⚠️ <strong>Os valores fiscais (NCM, CFOP, CSOSN) devem vir do seu contador.</strong> Preencher errado gera multa.<br /><br />
        A emissao e <strong>sob demanda</strong>: nenhuma nota vai para a SEFAZ sem alguem clicar em "Emitir".
      </div>

      {/* Status */}
      {status && (
        <div style={{ padding: 12, borderRadius: 10, background: status.pronto ? "#d1fae5" : "#f5f5f5", border: "1.5px solid " + (status.pronto ? "#10b981" : "#e0e0e0") }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: status.pronto ? "#065f46" : "#555" }}>
            {status.pronto ? "✅ Pronto para emitir" : "⚙️ Configuracao incompleta"}
            {cfg.ambiente === "homologacao" && <span style={{ marginLeft: 8, background: "#fef3c7", color: "#92400e", borderRadius: 8, padding: "2px 8px", fontSize: 11 }}>HOMOLOGACAO (teste)</span>}
          </div>
          {status.faltando?.length > 0 && (
            <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>Falta: {status.faltando.join(", ")}</div>
          )}
        </div>
      )}

      <Toggle value={cfg.ativo} onChange={v => set("ativo", v)} label="Habilitar emissao de NFC-e" sub="Libera o botao de emitir nas vendas" />

      {/* Ambiente */}
      <div>
        <div style={lbl}>Ambiente</div>
        <select value={cfg.ambiente} onChange={e => set("ambiente", e.target.value)} style={inp}>
          <option value="homologacao">Homologacao (teste — notas sem valor fiscal)</option>
          <option value="producao">Producao (notas reais)</option>
        </select>
        <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>Teste tudo em homologacao antes de virar para producao.</div>
      </div>

      {/* Provedor */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 8 }}>API fiscal</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={lbl}>Provedor</div>
            <select value={cfg.provedor} onChange={e => set("provedor", e.target.value)} style={inp}>
              <option value="">— escolher —</option>
              <option value="focusnfe">Focus NFe</option>
              <option value="plugnotas">PlugNotas</option>
              <option value="webmania">WebmaniaBR</option>
              <option value="nfeio">NFe.io</option>
            </select>
          </div>
          <div style={{ flex: 2 }}>
            <div style={lbl}>Token da API {cfg.apiTokenPreenchido && <span style={{ color: "#10b981" }}>✓ salvo</span>}</div>
            <input type="password" value={cfg.apiToken || ""} onChange={e => set("apiToken", e.target.value)} placeholder="cole o token" style={inp} />
          </div>
        </div>
      </div>

      {/* CSC */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 8 }}>CSC (gerado no portal da SEFAZ)</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 2 }}>
            <div style={lbl}>CSC {cfg.cscPreenchido && <span style={{ color: "#10b981" }}>✓ salvo</span>}</div>
            <input type="password" value={cfg.csc || ""} onChange={e => set("csc", e.target.value)} placeholder="codigo de seguranca" style={inp} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={lbl}>ID do CSC</div>
            <input value={cfg.cscId || ""} onChange={e => set("cscId", e.target.value)} placeholder="000001" style={inp} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={lbl}>Serie</div>
            <input type="number" value={cfg.serie || 1} onChange={e => set("serie", e.target.value)} style={inp} />
          </div>
        </div>
      </div>

      {/* Emitente */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 8 }}>Dados da empresa</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><div style={lbl}>CNPJ</div><input value={cfg.cnpj || ""} onChange={e => set("cnpj", e.target.value)} placeholder="00.000.000/0001-00" style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>Inscricao Estadual</div><input value={cfg.ie || ""} onChange={e => set("ie", e.target.value)} style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>CRT</div>
            <select value={cfg.crt || "1"} onChange={e => set("crt", e.target.value)} style={inp}>
              <option value="1">1 - Simples Nacional</option>
              <option value="2">2 - Simples Nacional (excesso)</option>
              <option value="3">3 - Regime Normal</option>
            </select>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><div style={lbl}>Razao social</div><input value={cfg.razaoSocial || ""} onChange={e => set("razaoSocial", e.target.value)} style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>Nome fantasia</div><input value={cfg.nomeFantasia || ""} onChange={e => set("nomeFantasia", e.target.value)} style={inp} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 3 }}><div style={lbl}>Logradouro</div><input value={cfg.endereco?.logradouro || ""} onChange={e => setEnd("logradouro", e.target.value)} style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>Numero</div><input value={cfg.endereco?.numero || ""} onChange={e => setEnd("numero", e.target.value)} style={inp} /></div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <div style={{ flex: 1 }}><div style={lbl}>Bairro</div><input value={cfg.endereco?.bairro || ""} onChange={e => setEnd("bairro", e.target.value)} style={inp} /></div>
          <div style={{ flex: 2, position: "relative" }}>
            <div style={lbl}>Municipio</div>
            <input
              value={cfg.endereco?.municipio || ""}
              onChange={e => { setEnd("municipio", e.target.value); buscarMunicipio(e.target.value); }}
              onFocus={() => { if ((cfg.endereco?.municipio || "").length >= 2) buscarMunicipio(cfg.endereco.municipio); }}
              placeholder="digite para buscar"
              style={inp}
            />
            {sugestoesMun.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 30, background: "#fff", border: "1.5px solid #e0e0e0", borderRadius: 8, marginTop: 2, maxHeight: 190, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" }}>
                {sugestoesMun.map(m => (
                  <div key={m.codigo}
                    onClick={() => { setEnd("municipio", m.nome); setEnd("codigoMunicipio", m.codigo); setSugestoesMun([]); }}
                    style={{ padding: "8px 10px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f5f5f5", display: "flex", justifyContent: "space-between" }}
                    onMouseEnter={e => e.currentTarget.style.background = "#faf9f8"}
                    onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
                    <span>{m.nome}</span>
                    <span style={{ color: "#aaa", fontSize: 11 }}>{m.codigo}</span>
                  </div>
                ))}
              </div>
            )}
            {erroMun && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 3 }}>{erroMun}</div>}
          </div>
          <div style={{ flex: 1 }}>
            <div style={lbl}>Cod. IBGE {cfg.endereco?.codigoMunicipio && <span style={{ color: "#10b981" }}>✓</span>}</div>
            <input value={cfg.endereco?.codigoMunicipio || ""} onChange={e => setEnd("codigoMunicipio", e.target.value)} placeholder="auto" style={inp} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}><div style={lbl}>UF</div><input value={cfg.endereco?.uf || ""} onChange={e => setEnd("uf", e.target.value.toUpperCase().slice(0, 2))} maxLength={2} style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>CEP</div><input value={cfg.endereco?.cep || ""} onChange={e => setEnd("cep", e.target.value)} style={inp} /></div>
        </div>
      </div>

      {/* Padrões fiscais */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#666", marginBottom: 4 }}>Padroes fiscais</div>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>
          Usados nos itens do cardapio que nao tiverem configuracao propria. Peca ao contador.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1 }}><div style={lbl}>NCM</div><input value={cfg.padroes?.ncm || ""} onChange={e => setPad("ncm", e.target.value)} placeholder="00000000" style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>CFOP</div><input value={cfg.padroes?.cfop || ""} onChange={e => setPad("cfop", e.target.value)} placeholder="5102" style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>CSOSN</div><input value={cfg.padroes?.csosn || ""} onChange={e => setPad("csosn", e.target.value)} placeholder="102" style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>Origem</div><input value={cfg.padroes?.origem || "0"} onChange={e => setPad("origem", e.target.value)} style={inp} /></div>
          <div style={{ flex: 1 }}><div style={lbl}>Unidade</div><input value={cfg.padroes?.unidade || "UN"} onChange={e => setPad("unidade", e.target.value)} style={inp} /></div>
        </div>
      </div>

      {msg && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: msg.tipo === "ok" ? "#d1fae5" : "#fee2e2", color: msg.tipo === "ok" ? "#065f46" : "#991b1b", fontSize: 13, fontWeight: 600 }}>
          {msg.texto}
        </div>
      )}

      <button onClick={salvar} disabled={salvando} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: salvando ? "not-allowed" : "pointer", opacity: salvando ? 0.7 : 1 }}>
        {salvando ? "Salvando..." : "💾 Salvar configuracao fiscal"}
      </button>
    </div>
  );
}

// ── RESUMO FISCAL (faturamento total vs com nota) ─────────────
function ResumoFiscal() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);

  async function carregar() {
    setCarregando(true);
    try {
      const r = await authFetch(BACKEND_URL + "/notas/resumo");
      if (r.ok) setDados(await r.json());
    } catch {}
    setCarregando(false);
  }
  useEffect(() => { carregar(); }, []);

  if (!dados) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", textAlign: "center", color: "#888", fontSize: 13 }}>
        {carregando ? "Carregando..." : "Sem dados"}
      </div>
    );
  }

  const linha = (rotulo, valor, cor, negrito) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f5f5f5" }}>
      <span style={{ fontSize: 13, color: negrito ? "#1a1a1a" : "#666", fontWeight: negrito ? 700 : 400 }}>{rotulo}</span>
      <span style={{ fontSize: negrito ? 16 : 14, fontWeight: negrito ? 800 : 600, color: cor }}>R$ {Number(valor).toFixed(2)}</span>
    </div>
  );

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🧾 Faturamento x Notas (hoje)</div>
        <button onClick={carregar} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: "#555" }}>↻</button>
      </div>

      {linha("Faturamento total do dia", dados.faturamentoTotal, "#7b1a0a", true)}
      {linha("  Salao", dados.totalSalao, "#666")}
      {linha("  Delivery", dados.totalDelivery, "#666")}
      <div style={{ height: 8 }} />
      {linha("Com nota emitida", dados.comNotaEmitida, "#10b981")}
      {linha("Sem nota emitida", dados.semNotaEmitida, "#f59e0b")}

      <div style={{ fontSize: 11, color: "#888", marginTop: 8 }}>
        {dados.qtdComNota} de {dados.qtdVendas} vendas do salao com nota.
      </div>
      <div style={{ background: "#fef3c7", borderRadius: 8, padding: "8px 10px", fontSize: 11, color: "#92400e", marginTop: 6, lineHeight: 1.5 }}>
        ℹ️ {dados.observacao}
      </div>
    </div>
  );
}

// ── SUGESTÃO DE CLASSIFICAÇÃO FISCAL ──────────────────────────
// Pré-preenche NCM/CFOP/CSOSN/CEST do cardápio para o contador conferir.
// Nada aqui vai para a SEFAZ: é só o cadastro dos itens.
function SugestoesFiscais() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [msg, setMsg] = useState(null);
  const [filtro, setFiltro] = useState("todos");   // todos | revisar
  const [textoContador, setTextoContador] = useState(null);

  function showMsg(texto, tipo = "ok") { setMsg({ texto, tipo }); setTimeout(() => setMsg(null), 6000); }

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await authFetch(BACKEND_URL + "/fiscal/sugestoes");
      if (r.ok) setDados(await r.json());
      else showMsg("Nao foi possivel carregar as sugestoes.", "erro");
    } catch { showMsg("Erro de conexao.", "erro"); }
    setCarregando(false);
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  async function aplicar(sobrescrever) {
    const aviso = sobrescrever
      ? "Isso substitui a classificacao fiscal de TODOS os itens, inclusive os que ja estavam preenchidos. Confirma?"
      : "Preencher a classificacao fiscal dos itens que ainda estao vazios?";
    if (!window.confirm(aviso)) return;
    setAplicando(true);
    try {
      const r = await authFetch(BACKEND_URL + "/fiscal/sugestoes/aplicar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sobrescrever }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) showMsg(d.erro || "Falha ao aplicar", "erro");
      else {
        showMsg(`${d.aplicados} item(ns) classificados${d.ignorados ? `, ${d.ignorados} mantidos como estavam` : ""}.`);
        await carregar();
      }
    } catch { showMsg("Erro de conexao.", "erro"); }
    setAplicando(false);
  }

  // Texto puro para mandar no WhatsApp / e-mail do contador
  function montarTextoContador() {
    if (!dados) return "";
    const linhas = [
      "CLASSIFICACAO FISCAL PROPOSTA - IMPERIO DOS ESPETOS",
      "Regime: Simples Nacional (CRT 1) | UF: PR | NFC-e modelo 65",
      "",
      "Premissa 1: espetos, doces, acompanhamentos e sucos sao PRODUZIDOS na casa",
      "  -> CFOP 5101 (venda de producao do estabelecimento) + CSOSN 102, sem CEST.",
      "Premissa 2: cerveja, refrigerante, agua e energetico sao REVENDIDOS e ja vem",
      "  com ICMS retido por substituicao tributaria (bebidas frias, ST ativa no PR)",
      "  -> CFOP 5405 (contribuinte substituido) + CSOSN 500 + CEST obrigatorio.",
      "",
      "Por favor confirme ou corrija cada linha:",
      "",
    ];
    const pad = (s, n) => String(s || "").padEnd(n).slice(0, n);
    linhas.push(pad("ITEM", 26) + pad("NCM", 12) + pad("CFOP", 6) + pad("CSOSN", 7) + pad("CEST", 12) + "CONFIANCA");
    linhas.push("-".repeat(74));
    for (const i of dados.itens) {
      linhas.push(
        pad(i.nome, 26) + pad(i.sugeridoLegivel.ncm, 12) + pad(i.sugerido.cfop, 6) +
        pad(i.sugerido.csosn, 7) + pad(i.sugeridoLegivel.cest || "-", 12) + i.confianca
      );
    }
    const duvidas = dados.itens.filter(i => i.confianca !== "alta");
    if (duvidas.length) {
      linhas.push("", "PONTOS QUE PRECISAM DE CONFIRMACAO:", "");
      const vistos = new Set();
      for (const i of duvidas) {
        if (vistos.has(i.nota)) continue;
        vistos.add(i.nota);
        linhas.push("- " + i.nota);
      }
    }
    return linhas.join("\n");
  }

  async function copiarParaContador() {
    const txt = montarTextoContador();
    try {
      await navigator.clipboard.writeText(txt);
      showMsg("Tabela copiada! E so colar no WhatsApp do contador.");
    } catch {
      setTextoContador(txt);   // clipboard bloqueado: mostra para copiar na mao
    }
  }

  if (!dados) {
    return (
      <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", textAlign: "center", color: "#888", fontSize: 13 }}>
        {carregando ? "Carregando sugestoes..." : "Sem dados"}
      </div>
    );
  }

  const coresConf = {
    alta:  { bg: "#d1fae5", fg: "#065f46", rotulo: "OK" },
    media: { bg: "#fef3c7", fg: "#92400e", rotulo: "conferir" },
    baixa: { bg: "#fee2e2", fg: "#991b1b", rotulo: "confirmar" },
  };
  const visiveis = filtro === "revisar" ? dados.itens.filter(i => i.confianca !== "alta") : dados.itens;
  const btn = (ativo) => ({
    flex: 1, padding: "6px 0", borderRadius: 8, border: "none", fontSize: 12, cursor: "pointer",
    background: ativo ? "#7b1a0a" : "#f0f0f0", color: ativo ? "#fff" : "#666", fontWeight: ativo ? 700 : 500,
  });

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🏷️ Classificacao fiscal do cardapio</div>
        <button onClick={carregar} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: "#555" }}>↻</button>
      </div>

      <div style={{ background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 10, padding: "10px 12px", fontSize: 11.5, color: "#92400e", lineHeight: 1.6 }}>
        ⚠️ <strong>Isto e uma sugestao, nao um parecer.</strong> Os codigos vieram da legislacao geral
        (Simples Nacional + bebidas frias com ST no PR). <strong>O contador precisa validar</strong> antes
        de emitir nota em producao — classificacao errada gera rejeicao na SEFAZ ou imposto incorreto.
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {[["Itens", dados.resumo.total], ["Ja preenchidos", dados.resumo.preenchidos], ["A conferir", dados.resumo.revisar]].map(([r, v]) => (
          <div key={r} style={{ flex: 1, background: "#faf9f8", borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#7b1a0a" }}>{v}</div>
            <div style={{ fontSize: 10, color: "#888" }}>{r}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => setFiltro("todos")} style={btn(filtro === "todos")}>Todos</button>
        <button onClick={() => setFiltro("revisar")} style={btn(filtro === "revisar")}>Só a conferir</button>
      </div>

      <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid #f0f0f0", borderRadius: 10 }}>
        {visiveis.map(i => {
          const c = coresConf[i.confianca] || coresConf.baixa;
          return (
            <div key={i.id} style={{ padding: "8px 10px", borderBottom: "1px solid #f7f7f7", display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "#333" }}>
                  {i.nome}
                  {i.jaPreenchido && <span style={{ fontSize: 10, color: "#10b981", marginLeft: 6 }}>✓ cadastrado</span>}
                </span>
                <span style={{ fontSize: 9.5, fontWeight: 700, background: c.bg, color: c.fg, borderRadius: 20, padding: "2px 7px", whiteSpace: "nowrap" }}>{c.rotulo}</span>
              </div>
              <div style={{ fontSize: 11, color: "#666", fontFamily: "monospace" }}>
                NCM {i.sugeridoLegivel.ncm} · CFOP {i.sugerido.cfop} · CSOSN {i.sugerido.csosn}
                {i.sugeridoLegivel.cest && " · CEST " + i.sugeridoLegivel.cest}
              </div>
              {i.confianca !== "alta" && (
                <div style={{ fontSize: 10.5, color: "#92400e", lineHeight: 1.45 }}>→ {i.nota}</div>
              )}
            </div>
          );
        })}
        {!visiveis.length && <div style={{ padding: 16, textAlign: "center", color: "#aaa", fontSize: 12 }}>Nada aqui.</div>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button onClick={() => aplicar(false)} disabled={aplicando}
          style={{ background: aplicando ? "#ccc" : "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "11px 0", fontWeight: 700, fontSize: 14, cursor: aplicando ? "not-allowed" : "pointer" }}>
          {aplicando ? "Aplicando..." : "✅ Preencher os itens vazios"}
        </button>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={copiarParaContador}
            style={{ flex: 1, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 8, padding: "9px 0", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            📋 Copiar para o contador
          </button>
          <button onClick={() => aplicar(true)} disabled={aplicando}
            style={{ background: "#fff7ed", color: "#c2410c", border: "1px solid #fed7aa", borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            Refazer todos
          </button>
        </div>
      </div>

      {textoContador && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "#888" }}>Nao consegui copiar sozinho. Selecione e copie:</div>
          <textarea readOnly value={textoContador} onFocus={e => e.target.select()}
            style={{ width: "100%", height: 180, fontFamily: "monospace", fontSize: 10, padding: 8, border: "1.5px solid #e0e0e0", borderRadius: 8, boxSizing: "border-box" }} />
          <button onClick={() => setTextoContador(null)} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "7px 0", fontSize: 12, cursor: "pointer", color: "#555" }}>Fechar</button>
        </div>
      )}

      {msg && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: msg.tipo === "ok" ? "#d1fae5" : "#fee2e2", color: msg.tipo === "ok" ? "#065f46" : "#991b1b", fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>
          {msg.texto}
        </div>
      )}

      <div style={{ background: "#faf9f8", borderRadius: 10, padding: "10px 12px", fontSize: 11, color: "#888", lineHeight: 1.6 }}>
        Depois de aplicar, da para ajustar item por item em <strong>Cardapio → editar item → dados fiscais</strong>.
        O que ficar vazio no item usa o padrao definido aqui embaixo, na configuracao fiscal.
      </div>
    </div>
  );
}

// ── CONFIGURAÇÃO DE IMPRESSORA BLUETOOTH ──────────────────────
function ImpressoraConfig() {
  const [status, setStatus] = useState({ conectada: impressora.isConnected(), nome: null, reconectando: false });
  const [conectando, setConectando] = useState(false);
  const [imprimindo, setImprimindo] = useState(false);
  const [erro, setErro] = useState(null);
  const supported = impressora.isSupported();
  const temSalvo = impressora.temDispositivoSalvo();

  useEffect(() => {
    const unsub = impressora.onStatus(setStatus);
    return unsub;
  }, []);

  async function conectar() {
    setErro(null); setConectando(true);
    try {
      await impressora.conectar();
    } catch (e) {
      if (!String(e).includes("User cancelled")) setErro(e.message || "Erro ao conectar");
    }
    setConectando(false);
  }

  async function reconectar() {
    setErro(null); setConectando(true);
    const r = await impressora.reconectarAuto();
    if (r?.erro) setErro(r.erro);
    setConectando(false);
  }

  async function desconectar() {
    await impressora.desconectar();
  }

  async function esquecer() {
    if (!window.confirm("Esquecer essa impressora? Você precisará escolher novamente da próxima vez.")) return;
    await impressora.esquecer();
  }

  const [autoImprimir, setAutoImprimirState] = useState(() => localStorage.getItem("imperio_auto_imprimir_delivery") === "on");
  function setAutoImprimir(v) {
    setAutoImprimirState(v);
    localStorage.setItem("imperio_auto_imprimir_delivery", v ? "on" : "off");
  }

  // Estacao de impressao: este aparelho imprime o que os garcons mandarem
  const [estacao, setEstacaoState] = useState(() => estacaoLigada());
  function setEstacao(v) { setEstacaoState(v); setEstacaoLigada(v); }
  const [fila, setFila] = useState({ pendentes: 0, erros: 0 });
  useEffect(() => {
    let vivo = true;
    async function ler() {
      try {
        const r = await authFetch(BACKEND_URL + "/impressao/status");
        if (r.ok && vivo) setFila(await r.json());
      } catch {}
    }
    ler();
    const t = setInterval(ler, 8000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  async function limparErrosFila() {
    try {
      await authFetch(BACKEND_URL + "/impressao/erros", { method: "DELETE" });
      setFila(f => ({ ...f, erros: 0 }));
    } catch {}
  }

  async function testar() {
    setErro(null); setImprimindo(true);
    try {
      await impressora.imprimirTeste();
    } catch (e) {
      setErro("Erro ao imprimir: " + e.message);
    }
    setImprimindo(false);
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🖨️ Impressora Bluetooth</div>
      <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e" }}>
        ℹ️ Compatível com impressoras térmicas Bluetooth ESC/POS (Baihuo MY-7779 e similares). Use Chrome ou Edge.
      </div>

      {!supported && (
        <div style={{ padding: "12px", background: "#fee2e2", borderRadius: 10, border: "1px solid #ef4444", fontSize: 13, color: "#991b1b" }}>
          ❌ Seu navegador não suporta Bluetooth Web.<br />
          Use <strong>Chrome</strong> ou <strong>Edge</strong> no Android ou desktop. Safari/iOS não tem suporte.
        </div>
      )}

      {supported && (
        <>
          <div style={{ padding: "14px", borderRadius: 12, background: status.conectada ? "#d1fae5" : status.reconectando ? "#fef3c7" : "#f5f5f5", border: `1.5px solid ${status.conectada ? "#10b981" : status.reconectando ? "#fbbf24" : "#e0e0e0"}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 28 }}>{status.conectada ? "✅" : status.reconectando ? "⏳" : "🔌"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: status.conectada ? "#065f46" : status.reconectando ? "#92400e" : "#555" }}>
                  {status.conectada ? "Impressora conectada" : status.reconectando ? "Reconectando..." : "Impressora desconectada"}
                </div>
                {status.nome && <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>📱 {status.nome}</div>}
                {!status.conectada && !status.reconectando && temSalvo && (
                  <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>💾 Tentamos reconectar automaticamente quando você abre o painel</div>
                )}
              </div>
            </div>
          </div>

          {!status.conectada ? (
            <div style={{ display: "flex", gap: 8 }}>
              {temSalvo && (
                <button onClick={reconectar} disabled={conectando || status.reconectando} style={{ flex: 1, background: "linear-gradient(135deg,#3b82f6,#1d4ed8)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: (conectando || status.reconectando) ? 0.6 : 1 }}>
                  {status.reconectando ? "Reconectando..." : "🔄 Reconectar"}
                </button>
              )}
              <button onClick={conectar} disabled={conectando || status.reconectando} style={{ flex: 1, background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: (conectando || status.reconectando) ? 0.6 : 1 }}>
                {conectando && !status.reconectando ? "Procurando..." : temSalvo ? "🔍 Outra impressora" : "🔍 Conectar impressora"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={testar} disabled={imprimindo} style={{ flex: 1, minWidth: 140, background: "linear-gradient(135deg,#10b981,#059669)", color: "#fff", border: "none", borderRadius: 10, padding: "12px 0", fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: imprimindo ? 0.6 : 1 }}>
                {imprimindo ? "Imprimindo..." : "🖨️ Imprimir teste"}
              </button>
              <button onClick={desconectar} style={{ background: "#fee2e2", color: "#ef4444", border: "1px solid #fca5a5", borderRadius: 10, padding: "12px 16px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                Desconectar
              </button>
            </div>
          )}

          {temSalvo && !status.conectada && (
            <button onClick={esquecer} style={{ background: "transparent", color: "#888", border: "none", padding: "4px", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
              Esquecer essa impressora
            </button>
          )}

          {erro && (
            <div style={{ padding: "10px 12px", background: "#fee2e2", borderRadius: 10, border: "1px solid #ef4444", fontSize: 12, color: "#991b1b" }}>
              ❌ {erro}
            </div>
          )}

          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, fontSize: 12, color: "#888", lineHeight: 1.6 }}>
            <strong style={{ color: "#333" }}>📌 Como usar:</strong><br />
            1. Ligue a impressora Bluetooth<br />
            2. Mantenha próximo ao dispositivo (até 5m)<br />
            3. Clique em "Conectar impressora" e escolha o dispositivo na lista<br />
            4. Quando conectada, a comanda da cozinha vai direto pra impressora<br /><br />
            <strong style={{ color: "#333" }}>🔄 Reconexão automática:</strong> depois da primeira conexão, sempre que você abrir o painel o sistema tenta reconectar sozinho (se a impressora estiver ligada e por perto).
          </div>

          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
            <Toggle value={autoImprimir} onChange={setAutoImprimir} label="🛵 Imprimir pedidos delivery automaticamente" sub="Quando chegar pedido novo via WhatsApp, imprime imediatamente" />
          </div>

          {/* Estação de impressão */}
          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
            <Toggle value={estacao} onChange={setEstacao}
              label="🖨️ Este aparelho é a estação de impressão"
              sub="Imprime aqui os tickets que os garçons mandarem dos celulares deles" />

            {estacao && (
              <div style={{ marginTop: 10, background: fila.erros > 0 ? "#fee2e2" : "#eff6ff", border: `1px solid ${fila.erros > 0 ? "#fca5a5" : "#bfdbfe"}`, borderRadius: 10, padding: "10px 12px", fontSize: 12, color: fila.erros > 0 ? "#991b1b" : "#1d4ed8", lineHeight: 1.6 }}>
                {status.conectada
                  ? <><strong>Estação ativa.</strong> Puxando a fila a cada 4 segundos.</>
                  : <><strong>Impressora desconectada.</strong> A fila só sai quando ela reconectar.</>}
                <br />
                Na fila agora: <strong>{fila.pendentes}</strong>
                {fila.erros > 0 && (
                  <> · <strong>{fila.erros} com erro</strong>{" "}
                    <button onClick={limparErrosFila} style={{ background: "none", border: "none", color: "#991b1b", textDecoration: "underline", fontSize: 12, cursor: "pointer", padding: 0 }}>limpar</button>
                  </>
                )}
              </div>
            )}

            {!estacao && (
              <div style={{ marginTop: 10, background: "#faf9f8", borderRadius: 10, padding: "10px 12px", fontSize: 11.5, color: "#888", lineHeight: 1.6 }}>
                A impressora térmica aceita <strong>um aparelho por vez</strong>. Deixe isto ligado só no
                aparelho do caixa, que fica com a impressora. Os celulares dos garçons mandam o ticket
                pela rede e ele sai aqui.
              </div>
            )}
          </div>

          <div style={{ background: "#fef3c7", borderRadius: 10, padding: "12px", fontSize: 12, color: "#92400e", lineHeight: 1.6 }}>
            <strong>⚠️ Pra manter a conexão durante o expediente:</strong><br /><br />
            1. <strong>Instale como app</strong>: no Chrome → menu (⋮) → "Adicionar à tela inicial". Vira um ícone igual app nativo, conexão fica mais estável.<br /><br />
            2. <strong>Não feche</strong> o painel/Chrome durante o expediente.<br /><br />
            3. <strong>Mantenha o celular plugado</strong> no carregador (a tela acende sozinha quando você usa).<br /><br />
            4. Se a conexão cair, ao voltar pro painel <strong>reconecta sozinha em 1-2 segundos</strong>.
          </div>
        </>
      )}
    </div>
  );
}

// ── CONFIGURAÇÃO DE NOTIFICAÇÕES ──────────────────────────────
function NotificacoesConfig() {
  const [somAtivo, setSomAtivo] = useState(() => localStorage.getItem("imperio_som_pedido") !== "off");
  const [notifPush, setNotifPush] = useState(() => localStorage.getItem("imperio_notif_push") !== "off");
  const [permNotif, setPermNotif] = useState(typeof Notification !== "undefined" ? Notification.permission : "denied");

  function toggleSom(v) {
    setSomAtivo(v);
    localStorage.setItem("imperio_som_pedido", v ? "on" : "off");
  }

  function toggleNotif(v) {
    setNotifPush(v);
    localStorage.setItem("imperio_notif_push", v ? "on" : "off");
  }

  async function pedirPermissao() {
    if (!("Notification" in window)) {
      alert("Seu navegador não suporta notificações.");
      return;
    }
    const p = await Notification.requestPermission();
    setPermNotif(p);
    if (p === "granted") {
      new Notification("🔔 Notificações ativadas!", { body: "Você será avisado quando chegar pedido novo.", icon: "/icon-192.png" });
    }
  }

  function testarSom() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const tocarNota = (freq, start, dur, vol = 0.35) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(vol, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
      };
      for (let i = 0; i < 3; i++) {
        const offset = i * 0.6;
        tocarNota(880, offset, 0.25);
        tocarNota(660, offset + 0.25, 0.35);
      }
    } catch (e) {}
  }

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🔔 Notificações de pedido</div>
      <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e" }}>
        ℹ️ Configure como você quer ser avisado quando chegar pedido novo pelo WhatsApp.
      </div>

      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <Toggle value={somAtivo} onChange={toggleSom} label="🔊 Som de campainha" sub="Toca um som ao chegar pedido novo" />
        {somAtivo && (
          <button onClick={testarSom} style={{ marginTop: 8, background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            🔉 Testar som
          </button>
        )}
      </div>

      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
        <Toggle value={notifPush} onChange={toggleNotif} label="📲 Notificação push do navegador" sub="Mostra alerta mesmo se a aba estiver em segundo plano" />
        {permNotif === "default" && notifPush && (
          <div style={{ marginTop: 10, padding: "12px", background: "#fef3c7", borderRadius: 10, border: "1px solid #fbbf24" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 8 }}>⚠️ Permissão necessária</div>
            <button onClick={pedirPermissao} style={{ background: "#7b1a0a", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Permitir notificações
            </button>
          </div>
        )}
        {permNotif === "denied" && notifPush && (
          <div style={{ marginTop: 10, padding: "12px", background: "#fee2e2", borderRadius: 10, border: "1px solid #ef4444", fontSize: 12, color: "#991b1b" }}>
            ❌ Notificações bloqueadas. Vá nas configurações do navegador para permitir.
          </div>
        )}
        {permNotif === "granted" && notifPush && (
          <div style={{ marginTop: 10, padding: "10px 12px", background: "#d1fae5", borderRadius: 10, fontSize: 12, color: "#065f46", fontWeight: 600 }}>
            ✅ Notificações ativas
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 12, fontSize: 12, color: "#888", lineHeight: 1.5 }}>
        💡 <strong>Dica:</strong> Em celulares, "Adicione à tela inicial" pelo navegador para receber notificações mesmo com o app fechado.
      </div>
    </div>
  );
}

// ── COMPONENTE TROCA DE PIN ───────────────────────────────────
function PinManager() {
  const [editando, setEditando] = useState(null); // "dono" | "caixa"
  const [novo, setNovo] = useState("");
  const [confirma, setConfirma] = useState("");
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  const perfis = [
    { key: "dono",   icon: "👑", label: "Dono",   desc: "Acesso completo ao painel" },
    { key: "caixa",  icon: "💁‍♀️", label: "Caixa",  desc: "Acesso ao salão — fecha contas" },
  ];

  async function salvar() {
    if (novo.length !== 4 || !/^\d{4}$/.test(novo)) { setMsg({ tipo: "erro", texto: "PIN deve ter 4 números." }); return; }
    if (novo !== confirma) { setMsg({ tipo: "erro", texto: "PINs não conferem." }); return; }
    setSaving(true);
    try {
      const res = await authFetch(BACKEND_URL + "/auth/pins", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [editando]: novo }),
      });
      if (!res.ok) {
        const data = await res.json();
        setMsg({ tipo: "erro", texto: data.erro || "Erro ao salvar PIN." });
        setSaving(false);
        return;
      }
      setEditando(null); setNovo(""); setConfirma("");
      setMsg({ tipo: "ok", texto: `PIN do ${perfis.find(p=>p.key===editando)?.label} alterado!` });
      setTimeout(() => setMsg(null), 3000);
    } catch {
      setMsg({ tipo: "erro", texto: "Erro de conexão." });
    }
    setSaving(false);
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
              <button onClick={salvar} disabled={saving} style={{ background: "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Salvando..." : `Salvar PIN do ${p.label}`}
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
      const res = await authFetch(BACKEND_URL + "/garcons", {
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
      const res = await authFetch(BACKEND_URL + "/garcons/" + editando._id, {
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
      await authFetch(BACKEND_URL + "/garcons/" + g._id, {
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
      await authFetch(BACKEND_URL + "/garcons/" + g._id, { method: "DELETE" });
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
        <div style={{ textAlign: "center", padding: "24px 16px", color: "#888", fontSize: 14 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🧑‍🍳</div>
          <div style={{ fontWeight: 700, color: "#555" }}>Nenhum garçom cadastrado</div>
          <div style={{ fontSize: 12, color: "#999", marginTop: 8, lineHeight: 1.6, maxWidth: 300, margin: "8px auto 0" }}>
            Enquanto não houver garçom cadastrado aqui, <strong>o login de garçom não funciona</strong> —
            a tela de PIN só aceita os códigos do dono e do caixa. Cadastre cada garçom com um PIN
            próprio de 4 dígitos.
          </div>
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

// ── FORMADOR DE PREÇO ─────────────────────────────────────────
// Helpers de moeda — escopo global para uso em múltiplos componentes
function mascaraMoeda(val) {
  const nums = String(val).replace(/\D/g,"");
  if(!nums) return "";
  const n = parseInt(nums,10) / 100;
  return "R$ " + n.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function parseMoedaGlobal(str) {
  return parseFloat(String(str||0).replace(/R\$\s?/g,"").replace(/\./g,"").replace(",",".")) || 0;
}

function FormadorPreco({ custo, margem, precoVenda, consumoPorVenda, onChange, cardapioNomes = [], cardapio = [], backendUrl = "" }) {
  const [modoPreco, setModoPreco] = useState("sugerido"); // "sugerido" | "manual"
  const [precoManual, setPrecoManual] = useState("");
  const [aplicando, setAplicando] = useState(false);
  const [aplicadoMsg, setAplicadoMsg] = useState(null);

  function parseMoeda(str) { return parseMoedaGlobal(str); }
  function handleMascara(campo, val) {
    const nums = val.replace(/\D/g,"");
    onChange(campo, nums ? mascaraMoeda(nums) : "");
  }

  const c   = parseMoeda(custo);
  const m   = parseFloat(margem) || 0;
  const pv  = parseMoeda(precoVenda);
  const cpv = parseFloat(consumoPorVenda) || 1;

  const custoVenda    = c * cpv;
  const precoSugerido = custoVenda > 0 && m > 0 ? custoVenda / (1 - m / 100) : 0;
  const precoFinal    = modoPreco === "manual" ? parseMoeda(precoManual) : precoSugerido;
  const margemReal    = pv > 0 && custoVenda > 0 ? ((pv - custoVenda) / pv) * 100 : null;
  const margemFinal   = precoFinal > 0 && custoVenda > 0 ? ((precoFinal - custoVenda) / precoFinal) * 100 : null;
  const lucroPorVenda = pv > 0 ? pv - custoVenda : 0;

  let status = null;
  if (margemReal !== null && m > 0) {
    if (margemReal >= m)             status = "ok";
    else if (margemReal >= m * 0.8)  status = "atencao";
    else                             status = "alerta";
  }
  const corStatus = { ok:"#10b981", atencao:"#f59e0b", alerta:"#ef4444" };
  const bgStatus  = { ok:"#d1fae5", atencao:"#fef3c7", alerta:"#fee2e2" };
  const txtStatus = { ok:"#065f46", atencao:"#92400e", alerta:"#991b1b" };
  const icnStatus = { ok:"✅", atencao:"⚠️", alerta:"🚨" };
  const msgStatus = {
    ok:      `Margem real ${margemReal?.toFixed(1)}% — acima da meta!`,
    atencao: `Margem real ${margemReal?.toFixed(1)}% — próximo do limite.`,
    alerta:  `Margem real ${margemReal?.toFixed(1)}% — abaixo da meta de ${m}%!`,
  };

  // Aplica preço ao cardápio via API
  async function aplicarAoCardapio() {
    if (!precoFinal || precoFinal <= 0) return;
    const nomes = Array.isArray(cardapioNomes)
      ? cardapioNomes
      : (cardapioNomes||"").split(",").map(s=>s.trim()).filter(Boolean);
    if (!nomes.length || !backendUrl) return;
    setAplicando(true);
    try {
      let sucessos = 0;
      for (const nome of nomes) {
        const item = cardapio.find(i=>i.nome===nome);
        if (!item) continue;
        const r = await authFetch(`${backendUrl}/cardapio/${item.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...item, preco: parseFloat(precoFinal.toFixed(2)) }),
        });
        if (r.ok) { sucessos++; onChange("precoVendaAtual", String(precoFinal.toFixed(2))); }
      }
      setAplicadoMsg(sucessos > 0
        ? { tipo:"ok", txt:`✅ Preço R$ ${precoFinal.toFixed(2)} aplicado ao cardápio!` }
        : { tipo:"erro", txt:"❌ Nenhum item do cardápio atualizado." }
      );
    } catch { setAplicadoMsg({ tipo:"erro", txt:"❌ Erro ao atualizar cardápio." }); }
    setTimeout(()=>setAplicadoMsg(null), 4000);
    setAplicando(false);
  }

  const inpBase = { width:"100%", padding:"8px 10px", border:"1.5px solid #e0e0e0", borderRadius:8, fontSize:13, color:"#333", outline:"none", boxSizing:"border-box", background:"#fff" };

  return (
    <div style={{background:"#f8f7f5",borderRadius:12,padding:14,display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontSize:12,fontWeight:700,color:"#555"}}>💰 Formador de Preço</div>

      {/* Entradas */}
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <div style={{display:"flex",gap:8}}>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"#888",marginBottom:3}}>Custo (R$/un)</div>
            <input type="text" inputMode="numeric"
              value={custo}
              onChange={e=>handleMascara("custoPorUnidade", e.target.value)}
              placeholder="R$ 0,00" style={inpBase}/>
          </div>
          <div style={{width:80}}>
            <div style={{fontSize:11,color:"#888",marginBottom:3}}>Margem (%)</div>
            <input type="text" inputMode="numeric" value={margem}
              onChange={e=>onChange("margemDesejada",e.target.value.replace(/[^\d]/g,""))}
              placeholder="60" style={{...inpBase,textAlign:"center"}}/>
          </div>
        </div>
        <div>
          <div style={{fontSize:11,color:"#888",marginBottom:3}}>Preço atual (R$)</div>
          <input type="text" inputMode="numeric"
            value={precoVenda}
            onChange={e=>handleMascara("precoVendaAtual", e.target.value)}
            placeholder="Preenchido ao selecionar do cardápio" style={inpBase}/>
        </div>
      </div>

      {/* Resultados calculados */}
      {c > 0 && (
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <div style={{flex:1,background:"#fff",borderRadius:8,padding:"8px 10px",minWidth:90}}>
            <div style={{fontSize:10,color:"#888"}}>Custo por venda</div>
            <div style={{fontWeight:700,fontSize:13,color:"#1a1a1a",marginTop:2}}>R$ {custoVenda.toFixed(2)}</div>
          </div>
          {precoSugerido > 0 && (
            <div style={{flex:1,background:"#fff",borderRadius:8,padding:"8px 10px",minWidth:90}}>
              <div style={{fontSize:10,color:"#888"}}>Preço sugerido</div>
              <div style={{fontWeight:700,fontSize:13,color:"#7b1a0a",marginTop:2}}>R$ {precoSugerido.toFixed(2)}</div>
            </div>
          )}
          {pv > 0 && (
            <div style={{flex:1,background:"#fff",borderRadius:8,padding:"8px 10px",minWidth:90}}>
              <div style={{fontSize:10,color:"#888"}}>Lucro por venda</div>
              <div style={{fontWeight:700,fontSize:13,color:lucroPorVenda>=0?"#10b981":"#ef4444",marginTop:2}}>R$ {lucroPorVenda.toFixed(2)}</div>
            </div>
          )}
        </div>
      )}

      {/* Semáforo */}
      {status && (
        <div style={{background:bgStatus[status],border:`1.5px solid ${corStatus[status]}`,borderRadius:8,padding:"8px 12px",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:16}}>{icnStatus[status]}</span>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:12,color:txtStatus[status]}}>{msgStatus[status]}</div>
            {status==="alerta"&&precoSugerido>0&&(
              <div style={{fontSize:11,color:txtStatus[status],marginTop:2}}>
                Preço mínimo para atingir a meta: <strong>R$ {precoSugerido.toFixed(2)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Aplicar ao cardápio */}
      {c > 0 && backendUrl && (
        <div style={{background:"#fff",borderRadius:10,padding:12,border:"1.5px solid #e0e0e0"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#333",marginBottom:10}}>📤 Aplicar preço ao cardápio</div>

          {/* Modo de preço */}
          <div style={{display:"flex",gap:6,marginBottom:10}}>
            <button onClick={()=>setModoPreco("sugerido")} style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:modoPreco==="sugerido"?700:500,background:modoPreco==="sugerido"?"#7b1a0a":"#f0f0f0",color:modoPreco==="sugerido"?"#fff":"#666"}}>
              🧮 Usar sugerido {precoSugerido>0?`(R$ ${precoSugerido.toFixed(2)})`:""}
            </button>
            <button onClick={()=>setModoPreco("manual")} style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:modoPreco==="manual"?700:500,background:modoPreco==="manual"?"#7b1a0a":"#f0f0f0",color:modoPreco==="manual"?"#fff":"#666"}}>
              ✏️ Digitar manualmente
            </button>
          </div>

          {/* Campo manual */}
          {modoPreco==="manual"&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:"#888",marginBottom:3}}>Preço a aplicar (R$)</div>
              <input type="text" inputMode="decimal" value={precoManual}
                onChange={e=>setPrecoManual(e.target.value.replace(/[^\d,\.]/g,""))}
                placeholder="Ex: 10,00"
                style={{width:"100%",padding:"8px 10px",border:"1.5px solid #e0e0e0",borderRadius:8,fontSize:13,color:"#333",outline:"none",boxSizing:"border-box",background:"#fff"}}/>
              {margemFinal!==null&&precoManual&&(
                <div style={{fontSize:11,color:margemFinal>=m?"#10b981":margemFinal>=m*0.8?"#f59e0b":"#ef4444",marginTop:4,fontWeight:600}}>
                  → Margem resultante: {margemFinal.toFixed(1)}% {margemFinal>=m?"✅":"⚠️"}
                </div>
              )}
            </div>
          )}

          {/* Botão aplicar */}
          <button
            onClick={aplicarAoCardapio}
            disabled={aplicando||precoFinal<=0}
            style={{width:"100%",background:precoFinal>0?"linear-gradient(135deg,#7b1a0a,#c0392b)":"#ccc",color:"#fff",border:"none",borderRadius:9,padding:"10px 0",fontWeight:700,fontSize:13,cursor:precoFinal>0?"pointer":"not-allowed"}}
          >
            {aplicando?"⏳ Atualizando...":`📤 Aplicar R$ ${precoFinal>0?precoFinal.toFixed(2):"—"} ao cardápio`}
          </button>

          {aplicadoMsg&&(
            <div style={{marginTop:8,padding:"8px 10px",borderRadius:8,background:aplicadoMsg.tipo==="ok"?"#d1fae5":"#fee2e2",color:aplicadoMsg.tipo==="ok"?"#065f46":"#991b1b",fontSize:12,fontWeight:600}}>
              {aplicadoMsg.txt}
            </div>
          )}
        </div>
      )}

      {c===0&&<div style={{fontSize:11,color:"#bbb",textAlign:"center"}}>Preencha o custo de compra para calcular</div>}
    </div>
  );
}

// ── DROPDOWN CARDÁPIO ─────────────────────────────────────────
function CardapioDropdown({ valor, onChange, nomeManual, onNomeManual, cardapio = [] }) {
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState(false);
  const selecionados = Array.isArray(valor) ? valor : (valor||"").split(",").map(s=>s.trim()).filter(Boolean);
  const itensCardapio = cardapio.filter(i=>i.ativo!==false);
  const termoBusca = onNomeManual ? (nomeManual||"") : busca;
  const filtrados = termoBusca.trim()
    ? itensCardapio.filter(i=>i.nome.toLowerCase().includes(termoBusca.toLowerCase()))
    : itensCardapio;

  function toggle(nome) {
    const nova = selecionados.includes(nome)
      ? selecionados.filter(n=>n!==nome)
      : [...selecionados, nome];
    onChange(nova);
  }
  function remover(nome) { onChange(selecionados.filter(n=>n!==nome)); }

  return (
    <div style={{position:"relative"}}>
      {selecionados.length>0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>
          {selecionados.map(n=>(
            <span key={n} style={{display:"inline-flex",alignItems:"center",gap:4,background:"#7b1a0a",color:"#fff",borderRadius:20,padding:"3px 10px",fontSize:12,fontWeight:600}}>
              {n}
              <span onClick={()=>remover(n)} style={{cursor:"pointer",fontSize:14,lineHeight:1,opacity:0.8}}>×</span>
            </span>
          ))}
        </div>
      )}
      <div style={{position:"relative"}}>
        <input
          value={onNomeManual ? (nomeManual||"") : busca}
          onChange={e=>{
            if(onNomeManual) onNomeManual(e.target.value);
            else setBusca(e.target.value);
            setAberto(true);
          }}
          onFocus={()=>setAberto(true)}
          placeholder={selecionados.length===0?"Buscar ou digitar nome...":"Adicionar mais itens..."}
          style={{width:"100%",padding:"8px 10px",border:"1.5px solid #e0e0e0",borderRadius:aberto&&filtrados.length>0?"8px 8px 0 0":"8px",fontSize:13,color:"#333",outline:"none",boxSizing:"border-box"}}
        />
        {(onNomeManual ? nomeManual : busca)&&(
          <span onClick={()=>{if(onNomeManual)onNomeManual("");else setBusca("");setAberto(false);}} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",cursor:"pointer",color:"#aaa",fontSize:16}}>×</span>
        )}
      </div>
      {aberto&&filtrados.length>0&&(
        <div style={{position:"absolute",zIndex:99,width:"100%",maxHeight:200,overflowY:"auto",background:"#fff",border:"1.5px solid #e0e0e0",borderTop:"none",borderRadius:"0 0 8px 8px",boxShadow:"0 6px 20px rgba(0,0,0,0.12)"}}>
          {filtrados.map(item=>{
            const sel = selecionados.includes(item.nome);
            return(
              <div key={item.id} onClick={()=>{
                toggle(item.nome);
                if(onNomeManual) onNomeManual(item.nome);
                else setBusca("");
                setAberto(false);
              }}
                style={{padding:"9px 12px",cursor:"pointer",fontSize:13,display:"flex",justifyContent:"space-between",alignItems:"center",background:sel?"#fef0ed":"#fff",borderBottom:"1px solid #f5f5f5"}}
                onMouseEnter={e=>e.currentTarget.style.background=sel?"#fde8e4":"#f8f7f5"}
                onMouseLeave={e=>e.currentTarget.style.background=sel?"#fef0ed":"#fff"}>
                <span style={{fontWeight:sel?600:400,color:sel?"#7b1a0a":"#333"}}>{item.nome}</span>
                <span style={{fontSize:11,color:"#aaa"}}>R$ {item.preco?.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      )}
      {aberto&&<div style={{position:"fixed",inset:0,zIndex:98}} onClick={()=>setAberto(false)}/>}
    </div>
  );
}

// ── ABA ESTOQUE ───────────────────────────────────────────────
function Estoque({ backendUrl, cardapio = [] }) {
  const [itens, setItens] = useState([]);
  const [movs, setMovs] = useState([]);
  const [relConsumo, setRelConsumo] = useState([]);
  const [subAba, setSubAba] = useState("painel");
  const [selItem, setSelItem] = useState(null);
  const [novoForm, setNovoForm] = useState(false);
  const [entradaForm, setEntradaForm] = useState(null);
  const [ajusteForm, setAjusteForm] = useState(null);
  const [editando, setEditando] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [novo, setNovo] = useState({ nome:"", unidade:"un", quantidade:"", minimo:"", cardapioNomes:"", consumoPorVenda:"1", tipo:"normal", capacidadeBarril:"", alertaTelefone:"", custoPorUnidade:"", margemDesejada:"", precoVendaAtual:"" });
  const [entradaQtd, setEntradaQtd] = useState("");
  const [entradaMotivo, setEntradaMotivo] = useState("entrada mercadoria");
  const [ajusteQtd, setAjusteQtd] = useState("");
  const [ajusteMotivo, setAjusteMotivo] = useState("ajuste manual");
  const salvarPrecoTimer = useRef(null);
  // Limpa o timer de debounce ao desmontar
  useEffect(() => () => { if (salvarPrecoTimer.current) clearTimeout(salvarPrecoTimer.current); }, []);

  // Dropdown cascata para vínculo com cardápio
  function showMsg(texto, tipo="ok") { setMsg({texto,tipo}); setTimeout(()=>setMsg(null),3500); }

  async function carregar() {
    try {
      const r = await authFetch(backendUrl+"/estoque");
      if(r.ok) setItens(await r.json());
    } catch {}
  }

  async function carregarConsumo() {
    try {
      const r = await authFetch(backendUrl+"/estoque/relatorio/consumo");
      if(r.ok) setRelConsumo(await r.json());
    } catch {}
  }

  async function carregarMovs(id) {
    try {
      const r = await authFetch(backendUrl+`/estoque/${id}/movimentacoes`);
      if(r.ok) setMovs(await r.json());
    } catch {}
  }

  useEffect(() => { carregar(); }, []);
  useEffect(() => { if(subAba==="consumo") carregarConsumo(); }, [subAba]);
  useEffect(() => { if(selItem) carregarMovs(selItem._id); }, [selItem]);

  const inp = { width:"100%", padding:"8px 10px", border:"1.5px solid #e0e0e0", borderRadius:8, fontSize:13, color:"#333", outline:"none", boxSizing:"border-box" };

  async function criarItem() {
    if(!novo.nome.trim()) return showMsg("Nome é obrigatório.","erro");
    setSaving(true);
    try {
      const body = { ...novo, quantidade:parseFloat(novo.quantidade)||0, minimo:parseFloat(novo.minimo)||0, consumoPorVenda:parseFloat(novo.consumoPorVenda)||1, capacidadeBarril:parseFloat(novo.capacidadeBarril)||0, cardapioNomes:novo.cardapioNomes.split(",").map(s=>s.trim()).filter(Boolean), custoPorUnidade:parseMoedaGlobal(novo.custoPorUnidade), margemDesejada:parseFloat(novo.margemDesejada)||0, precoVendaAtual:parseMoedaGlobal(novo.precoVendaAtual) };
      const r = await authFetch(backendUrl+"/estoque",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!r.ok) return showMsg((await r.json()).erro||"Erro ao criar.","erro");
      showMsg(`✅ ${novo.nome} cadastrado!`);
      setNovo({nome:"",unidade:"un",quantidade:"",minimo:"",cardapioNomes:"",consumoPorVenda:"1",tipo:"normal",capacidadeBarril:"",alertaTelefone:"",custoPorUnidade:"",margemDesejada:"",precoVendaAtual:""});
      setNovoForm(false);
      carregar();
    } catch { showMsg("Erro de conexão.","erro"); }
    setSaving(false);
  }

  async function salvarEdicao() {
    setSaving(true);
    try {
      const body = {
        ...editando,
        cardapioNomes: typeof editando.cardapioNomes === "string" ? editando.cardapioNomes.split(",").map(s=>s.trim()).filter(Boolean) : editando.cardapioNomes,
        // Campos com mascara de moeda: converter antes de enviar (Number no schema)
        custoPorUnidade: parseMoedaGlobal(editando.custoPorUnidade),
        precoVendaAtual: parseMoedaGlobal(editando.precoVendaAtual),
        margemDesejada:  parseFloat(editando.margemDesejada) || 0,
        quantidade:      parseFloat(editando.quantidade) || 0,
        minimo:          parseFloat(editando.minimo) || 0,
        consumoPorVenda: parseFloat(editando.consumoPorVenda) || 1,
      };
      const r = await authFetch(backendUrl+`/estoque/${editando._id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!r.ok) return showMsg("Erro ao salvar.","erro");
      showMsg("✅ Alterações salvas!");
      setEditando(null);
      if(selItem) setSelItem(itens.find(i=>i._id===selItem._id));
      carregar();
    } catch { showMsg("Erro de conexão.","erro"); }
    setSaving(false);
  }

  async function darEntrada() {
    if(!entradaQtd||parseFloat(entradaQtd)<=0) return showMsg("Informe a quantidade.","erro");
    setSaving(true);
    try {
      await authFetch(backendUrl+`/estoque/${entradaForm._id}/entrada`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quantidade:parseFloat(entradaQtd),motivo:entradaMotivo})});
      showMsg(`✅ +${entradaQtd} ${entradaForm.unidade} adicionados!`);
      setEntradaForm(null); setEntradaQtd(""); carregar();
      if(selItem?._id===entradaForm._id) carregarMovs(entradaForm._id);
    } catch { showMsg("Erro de conexão.","erro"); }
    setSaving(false);
  }

  async function darAjuste() {
    if(ajusteQtd===""||isNaN(parseFloat(ajusteQtd))) return showMsg("Informe a quantidade.","erro");
    setSaving(true);
    try {
      await authFetch(backendUrl+`/estoque/${ajusteForm._id}/ajuste`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({quantidade:parseFloat(ajusteQtd),motivo:ajusteMotivo})});
      showMsg(`✅ Estoque ajustado para ${ajusteQtd} ${ajusteForm.unidade}.`);
      setAjusteForm(null); setAjusteQtd(""); carregar();
      if(selItem?._id===ajusteForm._id) carregarMovs(ajusteForm._id);
    } catch { showMsg("Erro de conexão.","erro"); }
    setSaving(false);
  }

  async function deletarItem(id) {
    if(!window.confirm("Remover este item do estoque?")) return;
    try { await authFetch(backendUrl+`/estoque/${id}`,{method:"DELETE"}); carregar(); }
    catch { showMsg("Erro ao remover.","erro"); }
  }

  // Cálculo do barril de chopp
  function pctBarril(item) {
    if(item.tipo!=="chopp"||!item.capacidadeBarril) return null;
    return Math.min(100, Math.max(0, (item.quantidade/item.capacidadeBarril)*100));
  }

  const criticos = itens.filter(i=>i.quantidade<=i.minimo);

  // ── DETALHE DO ITEM
  if(selItem) {
    const it = itens.find(i=>i._id===selItem._id)||selItem;
    const pct = pctBarril(it);
    return (
      <div style={{padding:"16px 14px",display:"flex",flexDirection:"column",gap:12}}>
        <button onClick={()=>setSelItem(null)} style={{background:"none",border:"none",color:"#7b1a0a",fontWeight:700,fontSize:14,cursor:"pointer",textAlign:"left",padding:0}}>← Voltar</button>

        {editando ? (
          <div style={{background:"#fff",borderRadius:14,padding:16,border:"1.5px solid #7b1a0a",boxShadow:"0 2px 12px rgba(0,0,0,0.1)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>✏️ Editando: {editando.nome}</div>
            {[["nome","Nome"],["unidade","Unidade"],["minimo","Estoque mínimo"],["consumoPorVenda","Consumo por venda"],["alertaTelefone","Telefone alerta WhatsApp"]].map(([k,l])=>(
              <div key={k} style={{marginBottom:8}}>
                <div style={{fontSize:11,color:"#888",marginBottom:3}}>{l}</div>
                <input value={editando[k]||""} onChange={e=>setEditando(p=>({...p,[k]:e.target.value}))} style={inp}/>
              </div>
            ))}
            <div style={{marginBottom:8}}>
              <div style={{fontSize:11,color:"#888",marginBottom:6}}>Itens do cardápio vinculados</div>
              <CardapioDropdown
                cardapio={cardapio}
                valor={editando.cardapioNomes}
                onChange={lista=>setEditando(p=>({...p,cardapioNomes:lista}))}
              />
            </div>
            {editando.tipo==="chopp"&&<div style={{marginBottom:8}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Capacidade do barril (litros)</div><input type="number" value={editando.capacidadeBarril||""} onChange={e=>setEditando(p=>({...p,capacidadeBarril:parseFloat(e.target.value)}))} style={inp}/></div>}
            <FormadorPreco
              custo={editando.custoPorUnidade||""}
              margem={editando.margemDesejada||""}
              precoVenda={editando.precoVendaAtual||""}
              consumoPorVenda={editando.consumoPorVenda||1}
              cardapioNomes={editando.cardapioNomes||[]}
              cardapio={cardapio}
              backendUrl={backendUrl}
              onChange={(campo,val)=>setEditando(p=>({...p,[campo]:val}))}
            />
            <div style={{display:"flex",gap:8}}>
              <button onClick={salvarEdicao} disabled={saving} style={{flex:1,background:"linear-gradient(135deg,#7b1a0a,#c0392b)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>{saving?"Salvando...":"💾 Salvar"}</button>
              <button onClick={()=>setEditando(null)} style={{background:"#f0f0f0",color:"#555",border:"none",borderRadius:10,padding:"10px 16px",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
        ) : (
          <div style={{background:"#fff",borderRadius:14,padding:16,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontWeight:800,fontSize:18,color:"#1a1a1a"}}>{it.nome}</div>
                <div style={{fontSize:12,color:"#888",marginTop:2}}>{it.tipo==="chopp"?"🍺 Chopp":"📦"} · {it.unidade} · Mín: {it.minimo}</div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>setEditando({...it,cardapioNomes:it.cardapioNomes?.join(", ")||""})} style={{background:"#dbeafe",border:"none",borderRadius:8,padding:"6px 8px",cursor:"pointer",fontSize:14}}>✏️</button>
                <button onClick={()=>deletarItem(it._id)} style={{background:"#fee2e2",border:"none",borderRadius:8,padding:"6px 8px",cursor:"pointer",fontSize:14}}>🗑️</button>
              </div>
            </div>

            {/* Barril de chopp */}
            {pct!==null&&(
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:6}}>
                  <span style={{fontWeight:600}}>🍺 Barril</span>
                  <span style={{fontWeight:800,color:pct<20?"#ef4444":pct<50?"#f59e0b":"#10b981"}}>{it.quantidade.toFixed(1)}L / {it.capacidadeBarril}L</span>
                </div>
                <div style={{height:20,background:"#f0f0f0",borderRadius:10,overflow:"hidden",position:"relative"}}>
                  <div style={{height:"100%",width:pct+"%",background:pct<20?"linear-gradient(90deg,#ef4444,#dc2626)":pct<50?"linear-gradient(90deg,#f59e0b,#d97706)":"linear-gradient(90deg,#10b981,#059669)",borderRadius:10,transition:"width 0.6s"}}/>
                  <div style={{position:"absolute",top:0,left:0,right:0,bottom:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:pct>30?"#fff":"#555"}}>{pct.toFixed(0)}%</div>
                </div>
                {pct<20&&<div style={{fontSize:11,color:"#ef4444",fontWeight:600,marginTop:4}}>⚠️ Barril quase vazio!</div>}
              </div>
            )}

            {/* Quantidade atual */}
            <div style={{display:"flex",gap:10,marginBottom:14}}>
              <Metrica icon="📦" label="Em estoque" valor={it.quantidade+(it.tipo==="chopp"?" L":" "+it.unidade)} cor={it.quantidade<=it.minimo?"#ef4444":"#10b981"}/>
              <Metrica icon="⚠️" label="Mínimo" valor={it.minimo+" "+it.unidade} cor="#f59e0b"/>
            </div>

            {it.cardapioNomes?.length>0&&(
              <div style={{background:"#f8f7f5",borderRadius:10,padding:"8px 12px",fontSize:12,color:"#555",marginBottom:10}}>
                🔗 Cardápio: <strong>{it.cardapioNomes.join(", ")}</strong>
              </div>
            )}

            {/* Formador de preço */}
            {(it.custoPorUnidade>0||it.margemDesejada>0)&&(
              <FormadorPreco
                custo={it.custoPorUnidade||0}
                margem={it.margemDesejada||0}
                precoVenda={it.precoVendaAtual||0}
                consumoPorVenda={it.consumoPorVenda||1}
                cardapioNomes={it.cardapioNomes||[]}
                cardapio={cardapio}
                backendUrl={backendUrl}
                onChange={(campo,val)=>{
                  // Debounce: antes disparava 1 PUT + 1 GET por tecla digitada.
                  // E parseFloat("R$ 12,50") era NaN -> gravava 0.
                  const valorNum = campo === "margemDesejada" ? (parseFloat(val)||0) : parseMoedaGlobal(val);
                  if (salvarPrecoTimer.current) clearTimeout(salvarPrecoTimer.current);
                  salvarPrecoTimer.current = setTimeout(async () => {
                    try {
                      const r = await authFetch(backendUrl+`/estoque/${it._id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({[campo]:valorNum})});
                      if (!r.ok) { showMsg("Erro ao salvar preco.","erro"); return; }
                      carregar();
                    } catch { showMsg("Erro de conexao ao salvar preco.","erro"); }
                  }, 700);
                }}
              />
            )}

            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setEntradaForm(it);setEntradaQtd("");}} style={{flex:1,background:"linear-gradient(135deg,#065f46,#10b981)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>📥 Entrada</button>
              <button onClick={()=>{setAjusteForm(it);setAjusteQtd(String(it.quantidade));}} style={{flex:1,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>🔧 Ajustar</button>
            </div>
          </div>
        )}

        {/* Modais de entrada e ajuste */}
        {entradaForm&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,border:"1.5px solid #10b981",boxShadow:"0 2px 12px rgba(0,0,0,0.1)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>📥 Entrada — {entradaForm.nome}</div>
            <div style={{marginBottom:8}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Quantidade ({entradaForm.unidade})</div><input type="number" step="0.1" value={entradaQtd} onChange={e=>setEntradaQtd(e.target.value)} placeholder="Ex: 30" style={inp}/></div>
            <div style={{marginBottom:12}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Motivo</div><input value={entradaMotivo} onChange={e=>setEntradaMotivo(e.target.value)} style={inp}/></div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={darEntrada} disabled={saving} style={{flex:1,background:"linear-gradient(135deg,#065f46,#10b981)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>{saving?"Salvando...":"✅ Confirmar entrada"}</button>
              <button onClick={()=>setEntradaForm(null)} style={{background:"#f0f0f0",color:"#555",border:"none",borderRadius:10,padding:"10px 16px",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
        )}
        {ajusteForm&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,border:"1.5px solid #3b82f6",boxShadow:"0 2px 12px rgba(0,0,0,0.1)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:8}}>🔧 Ajuste — {ajusteForm.nome}</div>
            <div style={{fontSize:12,color:"#888",marginBottom:10}}>Estoque atual: <strong>{ajusteForm.quantidade} {ajusteForm.unidade}</strong>. Informe a quantidade real contada no inventário.</div>
            <div style={{marginBottom:8}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Quantidade real ({ajusteForm.unidade})</div><input type="number" step="0.1" value={ajusteQtd} onChange={e=>setAjusteQtd(e.target.value)} style={inp}/></div>
            <div style={{marginBottom:12}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Motivo</div><input value={ajusteMotivo} onChange={e=>setAjusteMotivo(e.target.value)} style={inp}/></div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={darAjuste} disabled={saving} style={{flex:1,background:"linear-gradient(135deg,#1d4ed8,#3b82f6)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>{saving?"Salvando...":"✅ Confirmar ajuste"}</button>
              <button onClick={()=>setAjusteForm(null)} style={{background:"#f0f0f0",color:"#555",border:"none",borderRadius:10,padding:"10px 16px",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
        )}

        {/* Histórico de movimentações */}
        <div style={{background:"#fff",borderRadius:14,padding:16,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#333",marginBottom:12}}>📋 Histórico de movimentações</div>
          {movs.length===0?(
            <div style={{textAlign:"center",padding:"20px 0",color:"#ccc",fontSize:13}}>Nenhuma movimentação ainda</div>
          ):movs.map((m,i)=>{
            const cor = m.tipo==="entrada"?"#10b981":m.tipo==="ajuste"?"#3b82f6":"#ef4444";
            const icon = m.tipo==="entrada"?"📥":m.tipo==="ajuste"?"🔧":"📤";
            const sinal = m.tipo==="entrada"?"+":m.tipo==="ajuste"?(m.quantidade>=0?"+":""):"−";
            const podeExcluir = m.tipo !== "saida"; // não exclui baixas automáticas de venda
            return(
              <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px dashed #f0f0f0"}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:cor+"20",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}}>{icon}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#1a1a1a"}}>{m.motivo||m.tipo}</div>
                  <div style={{fontSize:11,color:"#aaa"}}>{new Date(m.horario).toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
                </div>
                <div style={{fontWeight:800,fontSize:14,color:cor,marginRight:4}}>{sinal}{Math.abs(m.quantidade).toFixed(m.quantidade%1===0?0:1)} {it.unidade}</div>
                {podeExcluir&&(
                  <button onClick={async()=>{
                    if(!window.confirm(`Excluir esta movimentação? A quantidade no estoque será revertida.`)) return;
                    try {
                      const r = await authFetch(backendUrl+`/estoque/movimentacoes/${m._id}`,{method:"DELETE"});
                      if(r.ok){ await carregar(); await carregarMovs(it._id); showMsg("✅ Movimentação excluída e estoque revertido."); }
                      else showMsg("❌ Erro ao excluir.","erro");
                    } catch { showMsg("❌ Erro de conexão.","erro"); }
                  }} style={{background:"#fee2e2",border:"none",borderRadius:7,padding:"4px 7px",cursor:"pointer",fontSize:13,flexShrink:0}}>🗑️</button>
                )}
              </div>
            );
          })}
        </div>
        {msg&&<div style={{padding:"10px 14px",borderRadius:10,background:msg.tipo==="ok"?"#d1fae5":"#fee2e2",color:msg.tipo==="ok"?"#065f46":"#991b1b",fontSize:13,fontWeight:600}}>{msg.texto}</div>}
      </div>
    );
  }

  // ── PAINEL PRINCIPAL
  return (
    <div style={{padding:"16px 14px",display:"flex",flexDirection:"column",gap:14}}>
      {/* Sub-abas */}
      <div style={{display:"flex",gap:6}}>
        {[["painel","📦 Estoque"],["consumo","📊 Consumo"]].map(([k,l])=>(
          <button key={k} onClick={()=>setSubAba(k)} style={{flex:1,padding:"9px 0",borderRadius:10,border:"none",background:subAba===k?"#7b1a0a":"#f0f0f0",color:subAba===k?"#fff":"#666",fontWeight:subAba===k?700:500,fontSize:13,cursor:"pointer"}}>{l}</button>
        ))}
      </div>

      {subAba==="painel"&&<>
        {/* Alertas críticos */}
        {criticos.length>0&&(
          <div style={{background:"#fee2e2",border:"1.5px solid #ef4444",borderRadius:14,padding:"12px 14px"}}>
            <div style={{fontWeight:700,fontSize:13,color:"#991b1b",marginBottom:6}}>🚨 Estoque crítico!</div>
            {criticos.map(i=>(
              <div key={i._id} onClick={()=>setSelItem(i)} style={{fontSize:12,color:"#991b1b",cursor:"pointer",padding:"3px 0",display:"flex",justifyContent:"space-between"}}>
                <span>⚠️ {i.nome}</span>
                <span style={{fontWeight:700}}>{i.quantidade} {i.unidade} (mín: {i.minimo})</span>
              </div>
            ))}
          </div>
        )}

        {/* Métricas */}
        <div style={{display:"flex",gap:10}}>
          <Metrica icon="📦" label="Itens cadastrados" valor={itens.length} cor="#7b1a0a"/>
          <Metrica icon="🚨" label="Estoque crítico" valor={criticos.length} cor={criticos.length>0?"#ef4444":"#10b981"}/>
          <Metrica icon="🍺" label="Barris de chopp" valor={itens.filter(i=>i.tipo==="chopp").length} cor="#f59e0b"/>
        </div>

        <button onClick={()=>setNovoForm(true)} style={{background:"linear-gradient(135deg,#7b1a0a,#c0392b)",color:"#fff",border:"none",borderRadius:12,padding:"12px 0",fontWeight:700,fontSize:14,cursor:"pointer"}}>+ Cadastrar item no estoque</button>

        {novoForm&&(
          <div style={{background:"#fff",borderRadius:14,padding:16,border:"1.5px solid #7b1a0a",boxShadow:"0 2px 12px rgba(0,0,0,0.1)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:12}}>📦 Novo item</div>
            <div style={{marginBottom:8}}>
              <div style={{fontSize:11,color:"#888",marginBottom:3}}>Nome * <span style={{color:"#bbb"}}>(selecione do cardápio ou digite)</span></div>
              <CardapioDropdown
                cardapio={cardapio}
                valor={novo.cardapioNomes}
                onChange={lista=>{
                  const nomeAuto = lista.length>=1 ? lista[0] : novo.nome;
                  const eChopp = lista.some(n=>n.toLowerCase().includes("chopp"));
                  const itemCard = cardapio.find(i=>i.nome===lista[0]);
                  setNovo(p=>({
                    ...p,
                    cardapioNomes: lista.join(", "),
                    nome: nomeAuto || p.nome,
                    tipo: eChopp ? "chopp" : "normal",
                    unidade: eChopp ? "litros" : p.unidade,
                    consumoPorVenda: eChopp ? "0.4" : p.consumoPorVenda,
                    precoVendaAtual: itemCard?.preco ? mascaraMoeda(String(Math.round(itemCard.preco*100))) : p.precoVendaAtual,
                  }));
                }}
                nomeManual={novo.nome}
                onNomeManual={v=>{
                  const eChopp = v.toLowerCase().includes("chopp");
                  setNovo(p=>({
                    ...p, nome:v,
                    tipo: eChopp ? "chopp" : "normal",
                    unidade: eChopp ? "litros" : (p.tipo==="chopp" ? "un" : p.unidade),
                    consumoPorVenda: eChopp ? "0.4" : (p.tipo==="chopp" ? "1" : p.consumoPorVenda),
                  }));
                }}
              />
              {novo.tipo==="chopp"&&(
                <div style={{marginTop:6,background:"#fef3c7",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#92400e",display:"flex",alignItems:"center",gap:6}}>
                  🍺 Modo chopp ativado — consumo por caneca (400ml = 0.4L)
                </div>
              )}
            </div>
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              {novo.tipo==="chopp" ? (<>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:"#888",marginBottom:3}}>Qtd. de barris</div>
                  <input type="number" min="0" step="1" value={novo.quantidade} onChange={e=>{
                    const barris = parseFloat(e.target.value)||0;
                    const cap = parseFloat(novo.capacidadeBarril)||0;
                    setNovo(p=>({...p, quantidade: cap>0 ? String(barris*cap) : e.target.value, _barris: e.target.value}));
                  }} placeholder="Ex: 2" style={inp}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:"#888",marginBottom:3}}>Capacidade do barril (litros)</div>
                  <select value={novo.capacidadeBarril} onChange={e=>{
                    const cap = parseFloat(e.target.value)||0;
                    const barris = parseFloat(novo._barris)||0;
                    setNovo(p=>({...p, capacidadeBarril: e.target.value, quantidade: barris>0 ? String(barris*cap) : p.quantidade}));
                  }} style={inp}>
                    <option value="">Selecione</option>
                    <option value="30">30 litros</option>
                    <option value="50">50 litros</option>
                  </select>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,color:"#888",marginBottom:3}}>Estoque mínimo (litros)</div>
                  <input type="number" step="0.1" value={novo.minimo} onChange={e=>setNovo(p=>({...p,minimo:e.target.value}))} placeholder="Ex: 5" style={inp}/>
                </div>
              </>) : (<>
                <div style={{flex:1}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Unidade</div><input value={novo.unidade} onChange={e=>setNovo(p=>({...p,unidade:e.target.value}))} placeholder="un / litros / kg" style={inp}/></div>
                <div style={{flex:1}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Qtd. inicial</div><input type="number" step="0.1" value={novo.quantidade} onChange={e=>setNovo(p=>({...p,quantidade:e.target.value}))} placeholder="0" style={inp}/></div>
                <div style={{flex:1}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Estoque mínimo</div><input type="number" step="0.1" value={novo.minimo} onChange={e=>setNovo(p=>({...p,minimo:e.target.value}))} placeholder="0" style={inp}/></div>
              </>)}
            </div>
            {novo.tipo==="chopp"&&novo.capacidadeBarril&&novo._barris&&(
              <div style={{background:"#d1fae5",borderRadius:8,padding:"6px 10px",fontSize:12,color:"#065f46",marginBottom:8,fontWeight:600}}>
                📊 Total em estoque: {parseFloat(novo._barris||0)*parseFloat(novo.capacidadeBarril||0)} litros
              </div>
            )}
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <div style={{flex:2}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Consumo por venda {novo.tipo==="chopp"&&<span style={{color:"#92400e"}}>(litros por caneca)</span>}</div><input type="number" step="0.1" value={novo.consumoPorVenda} onChange={e=>setNovo(p=>({...p,consumoPorVenda:e.target.value}))} placeholder={novo.tipo==="chopp"?"0.4":"1"} style={inp}/></div>
              <div style={{flex:1}}><div style={{fontSize:11,color:"#888",marginBottom:3}}>Tel. alerta</div><input value={novo.alertaTelefone} onChange={e=>setNovo(p=>({...p,alertaTelefone:e.target.value}))} placeholder="5511..." style={inp}/></div>
            </div>
            <FormadorPreco
              custo={novo.custoPorUnidade}
              margem={novo.margemDesejada}
              precoVenda={novo.precoVendaAtual}
              consumoPorVenda={novo.consumoPorVenda}
              cardapioNomes={novo.cardapioNomes}
              cardapio={cardapio}
              backendUrl={backendUrl}
              onChange={(campo, val)=>setNovo(p=>({...p,[campo]:val}))}
            />
            <div style={{display:"flex",gap:8}}>
              <button onClick={criarItem} disabled={saving} style={{flex:1,background:"linear-gradient(135deg,#7b1a0a,#c0392b)",color:"#fff",border:"none",borderRadius:10,padding:"10px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>{saving?"Salvando...":"✅ Cadastrar"}</button>
              <button onClick={()=>setNovoForm(false)} style={{background:"#f0f0f0",color:"#555",border:"none",borderRadius:10,padding:"10px 16px",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
        )}

        {/* Lista de itens */}
        {itens.length===0?(
          <div style={{textAlign:"center",padding:"40px 0",color:"#ccc"}}><div style={{fontSize:40,marginBottom:8}}>📦</div><div>Nenhum item cadastrado ainda</div></div>
        ):itens.map(it=>{
          const pct = pctBarril(it);
          const critico = it.quantidade<=it.minimo;
          return(
            <div key={it._id} onClick={()=>setSelItem(it)} style={{background:"#fff",borderRadius:14,padding:14,boxShadow:"0 2px 10px rgba(0,0,0,0.07)",cursor:"pointer",border:`1.5px solid ${critico?"#ef4444":"transparent"}`}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:42,height:42,borderRadius:10,background:critico?"#fee2e2":it.tipo==="chopp"?"#fef3c7":"#f0f0f0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>
                  {it.tipo==="chopp"?"🍺":"📦"}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14,color:"#1a1a1a"}}>{it.nome}</div>
                  <div style={{fontSize:11,color:"#888",marginTop:1}}>{it.cardapioNomes?.length>0?`🔗 ${it.cardapioNomes.join(", ")}`:"Sem vínculo com cardápio"}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontWeight:800,fontSize:15,color:critico?"#ef4444":it.tipo==="chopp"?"#d97706":"#10b981"}}>{it.quantidade}{it.tipo==="chopp"?`L`:` ${it.unidade}`}</div>
                  <div style={{fontSize:10,color:"#aaa"}}>mín: {it.minimo}</div>
                  {critico&&<div style={{fontSize:9,fontWeight:700,color:"#ef4444"}}>⚠️ CRÍTICO</div>}
                </div>
              </div>
              {pct!==null&&(
                <div style={{marginTop:8}}>
                  <div style={{height:6,background:"#f0f0f0",borderRadius:3}}>
                    <div style={{height:"100%",width:pct+"%",background:pct<20?"#ef4444":pct<50?"#f59e0b":"#10b981",borderRadius:3,transition:"width 0.6s"}}/>
                  </div>
                  <div style={{fontSize:9,color:"#aaa",marginTop:2,textAlign:"right"}}>{pct.toFixed(0)}% do barril</div>
                </div>
              )}
            </div>
          );
        })}
      </>}

      {/* RELATÓRIO DE CONSUMO */}
      {subAba==="consumo"&&(
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:13,fontWeight:700,color:"#333"}}>📊 Consumo por item</div>
            <button onClick={carregarConsumo} style={{background:"#f0f0f0",border:"none",borderRadius:8,padding:"6px 12px",fontSize:12,fontWeight:600,cursor:"pointer",color:"#555"}}>↻ Atualizar</button>
          </div>
          {relConsumo.length===0?(
            <div style={{textAlign:"center",padding:"40px 0",color:"#ccc"}}><div style={{fontSize:36,marginBottom:8}}>📊</div><div>Nenhum dado de consumo ainda</div></div>
          ):(
            <div style={{background:"#fff",borderRadius:14,padding:16,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
              {relConsumo.map((r,i)=>(
                <div key={r.nome} style={{marginBottom:14,paddingBottom:14,borderBottom:i<relConsumo.length-1?"1px dashed #f0f0f0":"none"}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:5}}>
                    <span style={{fontWeight:i<3?700:400}}>{["🥇","🥈","🥉"][i]||"  "} {r.nome}</span>
                    <span style={{fontWeight:700,color:"#7b1a0a"}}>{r.total.toFixed(r.total%1===0?0:1)} un.</span>
                  </div>
                  <div style={{height:6,background:"#f0f0f0",borderRadius:3}}>
                    <div style={{height:"100%",width:((r.total/relConsumo[0].total)*100)+"%",background:i===0?"linear-gradient(90deg,#f59e0b,#d97706)":"linear-gradient(90deg,#c0392b,#7b1a0a)",borderRadius:3}}/>
                  </div>
                  <div style={{fontSize:10,color:"#aaa",marginTop:2}}>{r.movs} movimentaç{r.movs===1?"ão":"ões"}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {msg&&<div style={{padding:"10px 14px",borderRadius:10,background:msg.tipo==="ok"?"#d1fae5":"#fee2e2",color:msg.tipo==="ok"?"#065f46":"#991b1b",fontSize:13,fontWeight:600}}>{msg.texto}</div>}
    </div>
  );
}

// ── RESET DE DADOS ────────────────────────────────────────────
function ResetDados({ backendUrl }) {
  const [etapa, setEtapa] = useState(0); // 0=botão, 1=aviso, 2=confirmação
  const [digitado, setDigitado] = useState("");
  const [loading, setLoading] = useState(false);
  const [resultado, setResultado] = useState(null);
  const SENHA = "LIMPAR TUDO";

  async function confirmarReset() {
    if (digitado !== SENHA) return;
    setLoading(true);
    try {
      const r = await authFetch(backendUrl +"/reset/dados-teste", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmar: "CONFIRMAR_RESET" }),
      });
      const data = await r.json();
      if (!r.ok) { setResultado({ erro: data.erro }); return; }
      setResultado(data);
      setEtapa(0); setDigitado("");
    } catch { setResultado({ erro: "Erro de conexão." }); }
    setLoading(false);
  }

  if (resultado) return (
    <div style={{ background: resultado.erro ? "#fee2e2" : "#d1fae5", borderRadius: 14, padding: 16, border: `1.5px solid ${resultado.erro ? "#ef4444" : "#10b981"}` }}>
      {resultado.erro
        ? <><div style={{ fontWeight: 700, fontSize: 14, color: "#991b1b", marginBottom: 4 }}>❌ {resultado.erro}</div></>
        : <>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#065f46", marginBottom: 8 }}>✅ Dados de teste removidos com sucesso!</div>
          <div style={{ fontSize: 12, color: "#065f46" }}>
            {Object.entries(resultado.apagados||{}).map(([k,v])=>(
              <div key={k}>• {v} {k} removidos</div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#065f46", marginTop: 6, fontStyle: "italic" }}>Mantidos: {resultado.mantidos}</div>
        </>
      }
      <button onClick={()=>setResultado(null)} style={{ marginTop: 10, background: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Fechar</button>
    </div>
  );

  return (
    <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)", border: "1.5px solid #fee2e2" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#991b1b", marginBottom: 6 }}>🗑️ Zerar dados de teste</div>
      <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>
        Remove todos os pedidos, vendas e histórico gerados durante os testes. Mantém cardápio, configurações, garçons, cupons e estoque.
      </div>

      {etapa === 0 && (
        <button onClick={() => setEtapa(1)} style={{ background: "#fee2e2", color: "#991b1b", border: "1.5px solid #ef4444", borderRadius: 10, padding: "9px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
          🗑️ Iniciar limpeza
        </button>
      )}

      {etapa === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e", fontWeight: 600 }}>
            ⚠️ Esta ação não pode ser desfeita. Todos os dados de teste serão permanentemente removidos.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setEtapa(2)} style={{ flex: 1, background: "#ef4444", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Entendi, continuar</button>
            <button onClick={() => setEtapa(0)} style={{ flex: 1, background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          </div>
        </div>
      )}

      {etapa === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "#888" }}>Digite <strong style={{ color: "#ef4444" }}>{SENHA}</strong> para confirmar:</div>
          <input value={digitado} onChange={e => setDigitado(e.target.value)} placeholder={SENHA} style={{ width: "100%", padding: "9px 12px", border: `1.5px solid ${digitado === SENHA ? "#10b981" : "#e0e0e0"}`, borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={confirmarReset} disabled={digitado !== SENHA || loading} style={{ flex: 2, background: digitado === SENHA ? "#ef4444" : "#ccc", color: "#fff", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: digitado === SENHA ? "pointer" : "not-allowed" }}>
              {loading ? "Removendo..." : "🗑️ Confirmar limpeza"}
            </button>
            <button onClick={() => { setEtapa(0); setDigitado(""); }} style={{ flex: 1, background: "#f0f0f0", color: "#555", border: "none", borderRadius: 10, padding: "10px 0", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancelar</button>
          </div>
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
  // Marca que o usuario mexeu em algo. Enquanto true, o polling (que reescreve
  // `config` a cada 8s com um objeto novo) NAO pode sobrescrever o formulario.
  const editandoRef = useRef(false);
  const marcarEditado = () => { editandoRef.current = true; };
  useEffect(() => {
    if (editandoRef.current) return; // usuario esta digitando: nao resetar
    setCfg(config);
  }, [config]);
  async function salvar() {
    setSaving(true);
    const ok = await onSave(cfg);
    setSaving(false);
    if (ok === false) { alert("Nao foi possivel salvar. Verifique a conexao e tente de novo."); return; }
    editandoRef.current = false; // libera a ressincronizacao com o servidor
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }
  function setHorario(dia, campo, v) { marcarEditado(); setCfg(p => ({ ...p, horarioFuncionamento: { ...p.horarioFuncionamento, [dia]: { ...p.horarioFuncionamento[dia], [campo]: v } } })); }
  function setMensagem(campo, v) { marcarEditado(); setCfg(p => ({ ...p, mensagensAutomaticas: { ...p.mensagensAutomaticas, [campo]: v } })); }
  function setCEP(campo, v) { marcarEditado(); setCfg(p => ({ ...p, entregaCEP: { ...p.entregaCEP, [campo]: v } })); }
  function setFidelidade(campo, v) { marcarEditado(); setCfg(p => ({ ...p, fidelidade: { ...p.fidelidade, [campo]: v } })); }
  function setAvaliacao(campo, v) { marcarEditado(); setCfg(p => ({ ...p, avaliacao: { ...p.avaliacao, [campo]: v } })); }
  function setEvento(campo, v) { marcarEditado(); setCfg(p => ({ ...p, modoEvento: { ...(p.modoEvento || {}), [campo]: v } })); }
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
        {[["horario","🕐"],["notif","🔔"],["impressora","🖨️"],["fiscal","🧾"],["mensagens","💬"],["entrega","📍"],["fidelidade","🏆"],["avaliacao","⭐"],["evento","🎉"],["garcons","🧑‍🍳"],["pins","🔑"],["geral","⚙️"]].map(([k, l]) => (
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

      {subAba === "notif" && (
        <NotificacoesConfig />
      )}

      {subAba === "impressora" && (
        <ImpressoraConfig />
      )}

      {subAba === "fiscal" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <CertificadoConfig />
          <SugestoesFiscais />
          <FiscalConfig />
          <ResumoFiscal />
        </div>
      )}

      {subAba === "evento" && (
        <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>🎉 Modo Evento (preços promocionais)</div>
          <div style={{ background: "#fef3c7", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "#92400e" }}>
            ℹ️ Defina preços promocionais por item no cardápio. Ative o modo manualmente ou agende horários (ex: durante jogos da Copa). O WhatsApp e o salão usam o preço promocional automaticamente quando o modo está ativo.
          </div>

          <Toggle value={cfg.modoEvento?.ativo || false} onChange={v => setEvento("ativo", v)} label="Ativar modo evento agora (manual)" sub="Liga imediatamente, independente do agendamento" />

          <div><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>Nome do evento</div><input value={cfg.modoEvento?.nome || ""} onChange={e => setEvento("nome", e.target.value)} placeholder="Ex: Copa do Mundo - Brasil x Argentina" style={inputStyle} /></div>

          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 10, marginTop: 4 }}>
            <Toggle value={cfg.modoEvento?.agendado || false} onChange={v => setEvento("agendado", v)} label="Agendar período" sub="Ativa automaticamente no horário definido" />
            {cfg.modoEvento?.agendado && (
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3 }}>Início</div>
                  <input type="datetime-local" value={cfg.modoEvento?.inicio ? new Date(cfg.modoEvento.inicio).toISOString().slice(0,16) : ""} onChange={e => setEvento("inicio", e.target.value ? new Date(e.target.value).toISOString() : null)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3 }}>Fim</div>
                  <input type="datetime-local" value={cfg.modoEvento?.fim ? new Date(cfg.modoEvento.fim).toISOString().slice(0,16) : ""} onChange={e => setEvento("fim", e.target.value ? new Date(e.target.value).toISOString() : null)} style={inputStyle} />
                </div>
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 10, marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>💡 Como configurar preços promocionais</div>
            <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5 }}>
              Vá na aba <strong>🍢 Cardápio</strong> e clique no item para definir o "Preço promocional". Itens sem preço promocional mantêm o preço normal mesmo durante o evento.
            </div>
          </div>
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
            <div key={campo}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>{lbl}</div><input value={cfg[campo]} onChange={e => { marcarEditado(); setCfg(p => ({ ...p, [campo]: e.target.value })); }} style={inputStyle} /></div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            {[["taxaEntrega","Taxa (R$)","number",0.5],["tempoEntregaMin","Mín. (min)","number",1],["tempoEntregaMax","Máx. (min)","number",1]].map(([campo, lbl, type, step]) => (
              <div key={campo} style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#666", marginBottom: 5 }}>{lbl}</div><input type={type} step={step} value={cfg[campo]} onChange={e => { marcarEditado(); const v = e.target.value; setCfg(p => ({ ...p, [campo]: v === "" ? "" : (parseFloat(v) ?? "") })); }} style={inputStyle} /></div>
            ))}
          </div>
        </div>
      )}

      {/* RESET DE DADOS */}
      {subAba === "geral" && <ResetDados backendUrl={BACKEND_URL} />}

      <button onClick={salvar} disabled={saving} style={{ background: saved ? "#10b981" : saving ? "#aaa" : "linear-gradient(135deg,#7b1a0a,#c0392b)", color: "#fff", border: "none", borderRadius: 12, padding: "13px 0", fontWeight: 800, fontSize: 15, cursor: saving ? "not-allowed" : "pointer", transition: "all 0.2s" }}>
        {saved ? "✅ Salvo!" : saving ? "Salvando..." : "💾 Salvar configurações"}
      </button>
    </div>
  );
}

// ── FECHAMENTO DO DIA ─────────────────────────────────────────
function FechamentoDia({ backendUrl, pedidos, historicoSalao, faturadoSalao, mesasSalao }) {
  const [historico, setHistorico] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [obs, setObs] = useState("");
  const [msg, setMsg] = useState(null);
  const [aberto, setAberto] = useState(null); // _id do fechamento expandido

  function showMsg(texto, tipo="ok") { setMsg({texto,tipo}); setTimeout(()=>setMsg(null),4000); }

  async function carregar() {
    try {
      const r = await authFetch(backendUrl+"/fechamento-dia");
      if(r.ok) setHistorico(await r.json());
    } catch {}
  }

  useEffect(()=>{ carregar(); },[]);

  // Resumo do dia atual (antes de fechar)
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const pedidosHoje = pedidos.filter(p=>p.status==="entregue"&&new Date(p.horario)>=hoje);
  const totalDelivery = pedidosHoje.reduce((s,p)=>s+(p.total||0),0);
  const totalSalaoHoje = faturadoSalao + mesasSalao.reduce((s,m)=>s+totMesaCompleta(migrarMesa(m)),0);
  const totalGeral = totalDelivery + totalSalaoHoje;
  const jaFezHoje = historico.some(f=>f.dataStr===hoje.toISOString().slice(0,10));

  // Por garçom do dia
  const gMap = {};
  historicoSalao.forEach(v=>{
    const g = v.garcom&&v.garcom!=="—"?v.garcom:"Sem garçom";
    if(!gMap[g]) gMap[g]={nome:g,vendas:0,total:0};
    gMap[g].vendas+=1; gMap[g].total+=(v.total||0);
  });
  const porGarcom = Object.values(gMap).sort((a,b)=>b.total-a.total);

  // Por forma de pagamento
  const porPag = {pix:0,cartao:0,dinheiro:0};
  historicoSalao.forEach(v=>{
    // Comanda dividida soma em cada forma o valor que coube a ela; sem isso o
    // "misto" viraria uma coluna fantasma e o dinheiro sumia do fechamento.
    const partes = Array.isArray(v.pagamentos) && v.pagamentos.length
      ? v.pagamentos
      : [{ tipo: v.pagamento || "dinheiro", valor: v.total || 0 }];
    partes.forEach(pt => {
      if (porPag[pt.tipo] === undefined) return;
      porPag[pt.tipo] += Number(pt.valor) || 0;
    });
  });

  async function fecharDia() {
    setLoading(true);
    try {
      const r = await authFetch(backendUrl+"/fechamento-dia",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({obs})});
      const data = await r.json();
      if(!r.ok) return showMsg(data.erro||"Erro ao fechar o dia.","erro");
      showMsg("✅ Fechamento do dia realizado com sucesso!");
      setConfirmando(false); setObs("");
      carregar();
    } catch { showMsg("Erro de conexão.","erro"); }
    setLoading(false);
  }

  function imprimirFechamento(f) {
    const win = abrirJanelaImpressao("width=480,height=700");
    if (!win) return;
    const dataFmt = new Date(f.data).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric"});
    const horaFmt = new Date(f.data).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
    win.document.write(`<!DOCTYPE html><html>
<head><title>Fechamento ${f.dataStr}</title>
<style>
  body{font-family:'Courier New',monospace;padding:20px;max-width:340px;margin:0 auto}
  h2{text-align:center;font-size:16px;margin:0 0 2px}
  .sub{text-align:center;font-size:12px;color:#555;margin-bottom:14px}
  hr{border:none;border-top:2px dashed #000;margin:10px 0}
  .linha{display:flex;justify-content:space-between;font-size:13px;padding:4px 0}
  .total{display:flex;justify-content:space-between;font-size:16px;font-weight:bold;padding:8px 0;border-top:2px solid #000;margin-top:4px}
  .sec{font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#888;margin:10px 0 4px}
  .rodape{text-align:center;font-size:11px;color:#999;margin-top:14px}
  @media print{button{display:none}}
</style></head><body>
  <h2>👑 Império dos Espetos</h2>
  <div class="sub">Fechamento do Dia — ${dataFmt}</div>
  <div style="text-align:center;font-size:11px;color:#888">Emitido às ${horaFmt}</div>
  <hr>
  <div class="sec">Resumo geral</div>
  <div class="linha"><span>🛵 Delivery (${f.pedidosDelivery} pedidos)</span><span>R$ ${f.totalDelivery.toFixed(2)}</span></div>
  <div class="linha"><span>🍽️ Salão (${f.vendasSalao} vendas)</span><span>R$ ${f.totalSalao.toFixed(2)}</span></div>
  <div class="total"><span>TOTAL DO DIA</span><span>R$ ${f.totalGeral.toFixed(2)}</span></div>
  <hr>
  <div class="sec">Formas de pagamento (salão)</div>
  ${f.porPagamento?.pix>0?`<div class="linha"><span>🟢 Pix</span><span>R$ ${f.porPagamento.pix.toFixed(2)}</span></div>`:""}
  ${f.porPagamento?.cartao>0?`<div class="linha"><span>💳 Cartão</span><span>R$ ${f.porPagamento.cartao.toFixed(2)}</span></div>`:""}
  ${f.porPagamento?.dinheiro>0?`<div class="linha"><span>💵 Dinheiro</span><span>R$ ${f.porPagamento.dinheiro.toFixed(2)}</span></div>`:""}
  ${f.porGarcom?.length>0?`
  <hr>
  <div class="sec">Por garçom</div>
  ${f.porGarcom.map(g=>`<div class="linha"><span>🧑‍🍳 ${g.nome} (${g.vendas}x)</span><span>R$ ${g.total.toFixed(2)}</span></div>`).join("")}
  `:""}
  ${f.obs?`<hr><div style="font-size:12px;color:#555">📝 ${f.obs}</div>`:""}
  <div class="rodape">— Fim do relatório —</div>
  <br><button onclick="window.print()" style="width:100%;padding:10px;font-size:14px;cursor:pointer">🖨️ Imprimir</button>
</body></html>`);
    win.document.close();
    setTimeout(()=>win.print(),400);
  }

  const inp = {width:"100%",padding:"8px 10px",border:"1.5px solid #e0e0e0",borderRadius:8,fontSize:13,color:"#333",outline:"none",boxSizing:"border-box"};

  return (
    <div style={{padding:"16px 14px",display:"flex",flexDirection:"column",gap:14}}>

      {/* Resumo do dia atual */}
      <div style={{background:"linear-gradient(135deg,#7b1a0a,#c0392b)",borderRadius:16,padding:16,color:"#fff"}}>
        <div style={{fontSize:11,opacity:0.8,textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>
          {new Date().toLocaleDateString("pt-BR",{weekday:"long",day:"2-digit",month:"long"})}
        </div>
        <div style={{fontWeight:800,fontSize:22,marginBottom:12}}>Resumo do dia</div>
        <div style={{display:"flex",gap:10,marginBottom:12}}>
          <div style={{flex:1,background:"rgba(255,255,255,0.15)",borderRadius:12,padding:"10px 12px"}}>
            <div style={{fontSize:11,opacity:0.8}}>🛵 Delivery</div>
            <div style={{fontWeight:800,fontSize:16,marginTop:2}}>R$ {totalDelivery.toFixed(2)}</div>
            <div style={{fontSize:10,opacity:0.7}}>{pedidosHoje.length} pedidos</div>
          </div>
          <div style={{flex:1,background:"rgba(255,255,255,0.15)",borderRadius:12,padding:"10px 12px"}}>
            <div style={{fontSize:11,opacity:0.8}}>🍽️ Salão</div>
            <div style={{fontWeight:800,fontSize:16,marginTop:2}}>R$ {totalSalaoHoje.toFixed(2)}</div>
            <div style={{fontSize:10,opacity:0.7}}>{historicoSalao.length} vendas</div>
          </div>
        </div>
        <div style={{background:"rgba(255,255,255,0.2)",borderRadius:12,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontWeight:700,fontSize:14}}>💰 Total geral</span>
          <span style={{fontWeight:900,fontSize:20}}>R$ {totalGeral.toFixed(2)}</span>
        </div>
      </div>

      {/* Formas de pagamento e garçons do dia */}
      {(porGarcom.length>0||Object.values(porPag).some(v=>v>0))&&(
        <div style={{display:"flex",gap:10}}>
          {Object.values(porPag).some(v=>v>0)&&(
            <div style={{flex:1,background:"#fff",borderRadius:14,padding:14,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:8,textTransform:"uppercase"}}>Pagamentos</div>
              {porPag.pix>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span>🟢 Pix</span><span style={{fontWeight:700}}>R$ {porPag.pix.toFixed(2)}</span></div>}
              {porPag.cartao>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span>💳 Cartão</span><span style={{fontWeight:700}}>R$ {porPag.cartao.toFixed(2)}</span></div>}
              {porPag.dinheiro>0&&<div style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}><span>💵 Dinheiro</span><span style={{fontWeight:700}}>R$ {porPag.dinheiro.toFixed(2)}</span></div>}
            </div>
          )}
          {porGarcom.length>0&&(
            <div style={{flex:1,background:"#fff",borderRadius:14,padding:14,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#888",marginBottom:8,textTransform:"uppercase"}}>Garçons</div>
              {porGarcom.map(g=>(
                <div key={g.nome} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0"}}>
                  <span>🧑‍🍳 {g.nome}</span><span style={{fontWeight:700}}>R$ {g.total.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Botão fechar o dia */}
      {jaFezHoje ? (
        <div style={{background:"#d1fae5",border:"1.5px solid #10b981",borderRadius:14,padding:"14px 16px",textAlign:"center"}}>
          <div style={{fontSize:22,marginBottom:4}}>✅</div>
          <div style={{fontWeight:700,fontSize:14,color:"#065f46"}}>Fechamento do dia já realizado!</div>
          <div style={{fontSize:12,color:"#065f46",opacity:0.8,marginTop:2}}>Consulte o histórico abaixo.</div>
        </div>
      ) : (
        !confirmando ? (
          <button onClick={()=>setConfirmando(true)} style={{background:"linear-gradient(135deg,#065f46,#10b981)",color:"#fff",border:"none",borderRadius:14,padding:"14px 0",fontWeight:800,fontSize:15,cursor:"pointer"}}>
            🔒 Fechar o dia
          </button>
        ) : (
          <div style={{background:"#fff",borderRadius:14,padding:16,border:"1.5px solid #10b981",boxShadow:"0 2px 12px rgba(0,0,0,0.1)"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:4}}>🔒 Confirmar fechamento do dia?</div>
            <div style={{fontSize:12,color:"#888",marginBottom:12}}>Os dados do dia serão arquivados. O painel zera automaticamente amanhã.</div>
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:"#888",marginBottom:3}}>Observação (opcional)</div>
              <input value={obs} onChange={e=>setObs(e.target.value)} placeholder="Ex: Movimento fraco, faltou chopp..." style={inp}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={fecharDia} disabled={loading} style={{flex:2,background:"linear-gradient(135deg,#065f46,#10b981)",color:"#fff",border:"none",borderRadius:10,padding:"11px 0",fontWeight:700,fontSize:13,cursor:"pointer"}}>
                {loading?"Fechando...":"✅ Confirmar fechamento"}
              </button>
              <button onClick={()=>setConfirmando(false)} style={{flex:1,background:"#f0f0f0",color:"#555",border:"none",borderRadius:10,padding:"11px 0",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancelar</button>
            </div>
          </div>
        )
      )}

      {msg&&<div style={{padding:"10px 14px",borderRadius:10,background:msg.tipo==="ok"?"#d1fae5":"#fee2e2",color:msg.tipo==="ok"?"#065f46":"#991b1b",fontSize:13,fontWeight:600}}>{msg.texto}</div>}

      {/* Histórico de fechamentos */}
      <div style={{background:"#fff",borderRadius:14,padding:16,boxShadow:"0 2px 10px rgba(0,0,0,0.07)"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#333",marginBottom:12}}>📅 Histórico de fechamentos</div>
        {historico.length===0?(
          <div style={{textAlign:"center",padding:"20px 0",color:"#ccc",fontSize:13}}>Nenhum fechamento registrado ainda</div>
        ):historico.map(f=>(
          <div key={f._id} style={{borderBottom:"1px dashed #f0f0f0",paddingBottom:10,marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setAberto(aberto===f._id?null:f._id)}>
              <div>
                <div style={{fontWeight:700,fontSize:13}}>{new Date(f.data).toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit",year:"2-digit"})}</div>
                <div style={{fontSize:11,color:"#888"}}>{f.pedidosDelivery} delivery · {f.vendasSalao} salão</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{fontWeight:800,fontSize:15,color:"#7b1a0a"}}>R$ {f.totalGeral.toFixed(2)}</div>
                <button onClick={e=>{e.stopPropagation();imprimirFechamento(f);}} style={{background:"#f0f0f0",border:"none",borderRadius:8,padding:"5px 8px",cursor:"pointer",fontSize:13}}>🖨️</button>
                <span style={{color:"#ddd",fontSize:14}}>{aberto===f._id?"▴":"▾"}</span>
              </div>
            </div>
            {aberto===f._id&&(
              <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid #f5f5f5"}}>
                <div style={{display:"flex",gap:10,marginBottom:8}}>
                  <div style={{flex:1,background:"#f8f7f5",borderRadius:8,padding:"8px 10px"}}>
                    <div style={{fontSize:10,color:"#888"}}>🛵 Delivery</div>
                    <div style={{fontWeight:700,fontSize:13}}>R$ {f.totalDelivery.toFixed(2)}</div>
                  </div>
                  <div style={{flex:1,background:"#f8f7f5",borderRadius:8,padding:"8px 10px"}}>
                    <div style={{fontSize:10,color:"#888"}}>🍽️ Salão</div>
                    <div style={{fontWeight:700,fontSize:13}}>R$ {f.totalSalao.toFixed(2)}</div>
                  </div>
                </div>
                {f.porGarcom?.length>0&&(
                  <div style={{marginBottom:6}}>
                    <div style={{fontSize:10,color:"#888",marginBottom:4}}>Por garçom</div>
                    {f.porGarcom.map(g=>(
                      <div key={g.nome} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"2px 0"}}>
                        <span>🧑‍🍳 {g.nome} ({g.vendas}x)</span><span style={{fontWeight:600}}>R$ {g.total.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {f.obs&&<div style={{fontSize:11,color:"#888",fontStyle:"italic"}}>📝 {f.obs}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ABA RELATÓRIOS ────────────────────────────────────────────

// ── DASHBOARD COM GRÁFICOS ────────────────────────────────────
function DashboardCharts({ pedidos = [], historicoSalao = [], periodo, taxaEntrega = TAXA_ENTREGA_PADRAO }) {
  const dias = periodo === "hoje" ? 1 : periodo === "semana" ? 7 : 30;
  const agora = new Date();
  const dataInicio = new Date(agora); dataInicio.setDate(dataInicio.getDate() - dias + 1); dataInicio.setHours(0,0,0,0);

  // Filtra pedidos delivery entregues no período
  const pedidosEntregues = pedidos.filter(p => p.status === "entregue" && new Date(p.horario) >= dataInicio);

  // Vendas do salão no período
  const vendasSalao = historicoSalao.filter(v => new Date(v.fechamento) >= dataInicio);

  // ── VENDAS POR HORA (todas as 24h) ──
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, valor: 0, qty: 0 }));
  pedidosEntregues.forEach(p => {
    const h = new Date(p.horario).getHours();
    const total = totalPedido(p, taxaEntrega);
    porHora[h].valor += total;
    porHora[h].qty += 1;
  });
  vendasSalao.forEach(v => {
    const h = new Date(v.fechamento).getHours();
    porHora[h].valor += v.total || 0;
    porHora[h].qty += 1;
  });
  const horaPico = porHora.reduce((m, c) => c.valor > m.valor ? c : m, porHora[0]);

  // ── VENDAS POR DIA DA SEMANA ──
  const diasSemana = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
  const porDiaSemana = diasSemana.map(d => ({ dia: d, valor: 0, qty: 0 }));
  pedidosEntregues.forEach(p => {
    const d = new Date(p.horario).getDay();
    const total = totalPedido(p, taxaEntrega);
    porDiaSemana[d].valor += total;
    porDiaSemana[d].qty += 1;
  });
  vendasSalao.forEach(v => {
    const d = new Date(v.fechamento).getDay();
    porDiaSemana[d].valor += v.total || 0;
    porDiaSemana[d].qty += 1;
  });

  // ── COMPARATIVO ATUAL vs ANTERIOR ──
  const dataInicioAnterior = new Date(dataInicio); dataInicioAnterior.setDate(dataInicioAnterior.getDate() - dias);
  const pedidosAnt = pedidos.filter(p => p.status === "entregue" && new Date(p.horario) >= dataInicioAnterior && new Date(p.horario) < dataInicio);
  const vendasAnt = historicoSalao.filter(v => new Date(v.fechamento) >= dataInicioAnterior && new Date(v.fechamento) < dataInicio);
  const totalAtual = pedidosEntregues.reduce((s,p)=>s+totalPedido(p, taxaEntrega),0) + vendasSalao.reduce((s,v)=>s+(v.total||0),0);
  const totalAnt = pedidosAnt.reduce((s,p)=>s+totalPedido(p, taxaEntrega),0) + vendasAnt.reduce((s,v)=>s+(v.total||0),0);
  const variacao = totalAnt > 0 ? ((totalAtual - totalAnt) / totalAnt) * 100 : 0;

  // ── TOP ITENS ──
  const itensMap = {};
  [...pedidosEntregues, ...vendasSalao].forEach(p => {
    (p.itens||[]).forEach(it => {
      if (!itensMap[it.nome]) itensMap[it.nome] = { nome: it.nome, qty: 0, valor: 0 };
      itensMap[it.nome].qty += it.qty || 1;
      itensMap[it.nome].valor += (it.qty || 1) * it.preco;
    });
  });
  const topItens = Object.values(itensMap).sort((a,b) => b.qty - a.qty).slice(0, 8);

  // Máximos para escala
  const maxHora = Math.max(...porHora.map(h => h.valor), 1);
  const maxDia = Math.max(...porDiaSemana.map(d => d.valor), 1);
  const maxItem = Math.max(...topItens.map(i => i.qty), 1);

  const totalPedidos = pedidosEntregues.length + vendasSalao.length;
  const ticketMedio = totalPedidos > 0 ? totalAtual / totalPedidos : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Card de comparativo destacado */}
      <div style={{ background: "linear-gradient(135deg, #7b1a0a 0%, #c0392b 100%)", borderRadius: 16, padding: "18px 20px", color: "#fff", boxShadow: "0 4px 20px rgba(123,26,10,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 10, opacity: 0.75, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: 600 }}>{periodo === "hoje" ? "Hoje" : periodo === "semana" ? "Últimos 7 dias" : "Últimos 30 dias"}</div>
            <div className="serif-title" style={{ fontSize: 28, fontWeight: 700, marginTop: 4, lineHeight: 1.1 }}>R$ {totalAtual.toFixed(2)}</div>
            <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>{totalPedidos} {totalPedidos === 1 ? "venda" : "vendas"} · ticket médio R$ {ticketMedio.toFixed(2)}</div>
          </div>
          <div style={{ textAlign: "right", background: "rgba(255,255,255,0.15)", borderRadius: 12, padding: "8px 12px", backdropFilter: "blur(8px)" }}>
            <div style={{ fontSize: 10, opacity: 0.8, marginBottom: 2 }}>vs {periodo === "hoje" ? "ontem" : "período anterior"}</div>
            <div style={{ fontWeight: 700, fontSize: 18, color: variacao >= 0 ? "#86efac" : "#fca5a5" }}>
              {variacao >= 0 ? "▲" : "▼"} {Math.abs(variacao).toFixed(1)}%
            </div>
            <div style={{ fontSize: 10, opacity: 0.7, marginTop: 1 }}>R$ {totalAnt.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* Vendas por hora */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="serif-title" style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a" }}>⏰ Horários mais movimentados</div>
          {horaPico.valor > 0 && <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 600, background: "#fef3c7", borderRadius: 8, padding: "3px 10px" }}>🔥 Pico: {String(horaPico.hora).padStart(2,"0")}h</div>}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, padding: "0 0 4px" }}>
          {porHora.map((h, i) => {
            const alt = (h.valor / maxHora) * 100;
            const ehPico = h.hora === horaPico.hora && h.valor > 0;
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, position: "relative" }} title={`${String(h.hora).padStart(2,"0")}h: R$ ${h.valor.toFixed(2)} (${h.qty} vendas)`}>
                <div style={{ width: "85%", height: `${Math.max(alt, h.valor > 0 ? 4 : 0)}%`, background: ehPico ? "linear-gradient(180deg,#f59e0b,#d97706)" : h.valor > 0 ? "linear-gradient(180deg,#c0392b,#7b1a0a)" : "transparent", borderRadius: "4px 4px 0 0", transition: "height 0.6s ease", minHeight: h.valor > 0 ? 4 : 0 }} />
                {[0,6,12,18,23].includes(h.hora) && <div style={{ fontSize: 9, color: "#888", marginTop: 2 }}>{h.hora}h</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Vendas por dia da semana */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div className="serif-title" style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 14 }}>📅 Vendas por dia da semana</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 140 }}>
          {porDiaSemana.map((d, i) => {
            const alt = (d.valor / maxDia) * 100;
            const isHoje = i === agora.getDay();
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 10, color: d.valor > 0 ? "#7b1a0a" : "#ccc", fontWeight: 700, minHeight: 14 }}>{d.valor > 0 ? `R$${d.valor.toFixed(0)}` : "—"}</div>
                <div style={{ width: "100%", flex: 1, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", height: `${Math.max(alt, d.valor > 0 ? 5 : 0)}%`, background: isHoje ? "linear-gradient(180deg,#f59e0b,#d97706)" : d.valor > 0 ? "linear-gradient(180deg,#c0392b,#7b1a0a)" : "#f0f0f0", borderRadius: "6px 6px 0 0", transition: "height 0.6s ease", minHeight: d.valor > 0 ? 6 : 6, boxShadow: isHoje ? "0 0 0 2px #f59e0b40" : "none" }} />
                </div>
                <div style={{ fontSize: 11, fontWeight: isHoje ? 700 : 500, color: isHoje ? "#f59e0b" : "#666" }}>{d.dia}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top itens */}
      <div style={{ background: "#fff", borderRadius: 14, padding: "16px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
        <div className="serif-title" style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 14 }}>🏆 Itens mais vendidos</div>
        {topItens.length === 0 ? (
          <div style={{ textAlign: "center", padding: 20, color: "#ccc", fontSize: 14 }}>Sem dados no período</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {topItens.map((it, i) => {
              const pct = (it.qty / maxItem) * 100;
              const medals = ["🥇","🥈","🥉"];
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 28, fontSize: 16, textAlign: "center", flexShrink: 0 }}>{medals[i] || `${i+1}.`}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.nome}</div>
                      <div style={{ fontSize: 12, color: "#888", marginLeft: 8, flexShrink: 0 }}>{it.qty}x · R$ {it.valor.toFixed(2)}</div>
                    </div>
                    <div style={{ height: 6, background: "#f5f5f5", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: i < 3 ? "linear-gradient(90deg,#f59e0b,#d97706)" : "linear-gradient(90deg,#c0392b,#7b1a0a)", borderRadius: 3, transition: "width 0.6s ease" }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Cards de métricas extras */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <Metrica icon="🛵" label="Delivery" valor={pedidosEntregues.length + " " + (pedidosEntregues.length === 1 ? "pedido" : "pedidos")} cor="#10b981" />
        <Metrica icon="🍽️" label="Salão" valor={vendasSalao.length + " " + (vendasSalao.length === 1 ? "venda" : "vendas")} cor="#3b82f6" />
        <Metrica icon="💵" label="Ticket médio" valor={"R$ " + ticketMedio.toFixed(2)} cor="#f59e0b" />
      </div>
    </div>
  );
}

function Relatorios({ pedidos, taxaEntrega = TAXA_ENTREGA_PADRAO, faturadoSalao = 0, mesasSalao = [], setMesasSalaoRel, historicoSalao = [], onZerarSalao, setHistoricoSalao, setFaturadoSalaoRel }) {
  const [periodo, setPeriodo] = useState("semana");
  const [subAba, setSubAba] = useState("geral");
  const [vendaAberta, setVendaAberta] = useState(null);
  const [zerarAberto, setZerarAberto] = useState(false);
  const [relGarcons, setRelGarcons] = useState([]);
  const [loadingGarcons, setLoadingGarcons] = useState(false);
  const [relLucro, setRelLucro] = useState(null);
  const [loadingLucro, setLoadingLucro] = useState(false);
  // Emissao de NFC-e em lote: escolher varias comandas e mandar de uma vez
  const [modoLote, setModoLote] = useState(false);
  const [selecionadas, setSelecionadas] = useState([]);
  const [emitindoLote, setEmitindoLote] = useState(false);
  const [resultadoLote, setResultadoLote] = useState(null);

  // So entra no lote comanda que ja foi salva no servidor e ainda nao tem nota
  const elegiveisLote = historicoSalao.filter(v => v._id && v.notaFiscalStatus !== "autorizada");
  const totalSelecionado = historicoSalao
    .filter(v => selecionadas.includes(v._id))
    .reduce((soma, v) => soma + (Number(v.total) || 0), 0);

  function alternarSelecao(id) {
    setSelecionadas(atual => atual.includes(id) ? atual.filter(x => x !== id) : [...atual, id]);
  }
  function sairDoLote() {
    setModoLote(false); setSelecionadas([]); setResultadoLote(null);
  }

  async function emitirLote() {
    if (!selecionadas.length) return;
    const msg = [
      `Emitir ${selecionadas.length} nota(s) fiscal(is), somando R$ ${totalSelecionado.toFixed(2)}?`,
      "",
      "As notas vao para a SEFAZ como consumidor nao identificado.",
      "Se algum cliente pediu nota com CPF, emita essa pelo botao individual.",
    ].join("\n");
    if (!window.confirm(msg)) return;
    setEmitindoLote(true); setResultadoLote(null);
    try {
      const r = await authFetch(BACKEND_URL + "/notas/emitir-lote", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendaIds: selecionadas }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setResultadoLote({ erroGeral: (d.erro || "Falha ao emitir") + (d.faltando?.length ? " Falta: " + d.faltando.join(", ") : "") });
      } else {
        setResultadoLote(d);
        const ok = new Set(d.resultados.filter(x => x.ok).map(x => x.vendaId));
        if (setHistoricoSalao) {
          setHistoricoSalao(h => h.map(v => ok.has(String(v._id)) ? { ...v, notaFiscalStatus: "autorizada" } : v));
        }
        setSelecionadas(atual => atual.filter(id => !ok.has(String(id))));
      }
    } catch { setResultadoLote({ erroGeral: "Erro de conexao ao emitir o lote." }); }
    setEmitindoLote(false);
  }

  async function carregarRelGarcons() {
    setLoadingGarcons(true);
    try {
      const res = await authFetch(BACKEND_URL + "/garcons/relatorio");
      if (res.ok) setRelGarcons(await res.json());
    } catch {}
    setLoadingGarcons(false);
  }

  async function carregarLucro() {
    setLoadingLucro(true);
    try {
      const hoje = new Date();
      const dias = { hoje: 0, semana: 6, mes: 29 }[periodo];
      const de = new Date(hoje); de.setDate(de.getDate() - dias); de.setHours(0,0,0,0);
      const res = await authFetch(`${BACKEND_URL}/relatorio/lucro?de=${de.toISOString()}&ate=${hoje.toISOString()}`);
      if (res.ok) setRelLucro(await res.json());
    } catch {}
    setLoadingLucro(false);
  }

  useEffect(() => {
    if (subAba === "garcons") carregarRelGarcons();
    if (subAba === "lucro") carregarLucro();
  }, [subAba, periodo]);

  const entregues = pedidos.filter(p => p.status === "entregue");
  const diasFiltro = { hoje: 0, semana: 6, mes: 29 }[periodo];
  const corte = new Date(); corte.setDate(corte.getDate() - diasFiltro); corte.setHours(0, 0, 0, 0);
  const pp = entregues.filter(p => new Date(p.horario) >= corte);
  const totalDelivery = pp.reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
  // Cupons no delivery + desconto dado no fechamento das comandas
  const descontoDelivery = pp.reduce((s, p) => s + (p.desconto || 0), 0);
  const descontoSalao = historicoSalao.reduce((s, v) => s + (Number(v.desconto) || 0), 0);
  const totalDescontos = descontoDelivery + descontoSalao;
  const ticket = pp.length > 0 ? totalDelivery / pp.length : 0;

  // Faturamento do salão — mesas abertas + já fechadas
  const totalSalaoAberto = mesasSalao.reduce((s, m) => s + totMesaCompleta(migrarMesa(m)), 0);
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
    const fatDelivery = pedidosDia.reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
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
      const vDel = pp.filter(p => { const hr = new Date(p.horario).getHours(); return hr >= h && hr < h + 2; }).reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
      const vSal = historicoSalao.filter(v => { const hr = new Date(v.fechamento).getHours(); return hr >= h && hr < h + 2; }).reduce((s, v) => s + v.total, 0);
      barras.push({ label: h + "h", valor: vDel + vSal, destaque: new Date().getHours() >= h && new Date().getHours() < h + 2 });
    }
  } else if (periodo === "semana") {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0, 0, 0, 0);
      const vDel = entregues.filter(p => isMesmosDias(p.horario, d)).reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
      const vSal = historicoSalao.filter(v => isMesmosDias(v.fechamento, d)).reduce((s, v) => s + v.total, 0);
      barras.push({ label: i === 0 ? "Hoje" : ds[d.getDay()], valor: vDel + vSal, destaque: i === 0 });
    }
  } else {
    for (let s = 3; s >= 0; s--) {
      const ini = new Date(); ini.setDate(ini.getDate() - s * 7 - 6); ini.setHours(0, 0, 0, 0);
      const fim = new Date(); fim.setDate(fim.getDate() - s * 7); fim.setHours(23, 59, 59, 999);
      const vDel = entregues.filter(p => new Date(p.horario) >= ini && new Date(p.horario) <= fim).reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
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
        {[["dash","📈 Dashboard"],["geral","📊 Geral"],["lucro","💰 Lucro"],["vendas","🧾 Vendas"],["diasemana","📅 Por dia"],["ranking","🏆 Ranking"],["garcons","🧑‍🍳 Garçons"]].map(([k,l]) => (
          <button key={k} onClick={() => setSubAba(k)} style={{ flex:1, padding:"8px 4px", borderRadius:10, border:"none", background:subAba===k?"#7b1a0a":"#f0f0f0", color:subAba===k?"#fff":"#666", fontWeight:subAba===k?700:500, fontSize:12, cursor:"pointer", whiteSpace:"nowrap" }}>{l}</button>
        ))}
      </div>

      {/* DASHBOARD */}
      {subAba === "dash" && (
        <DashboardCharts pedidos={pedidos} historicoSalao={historicoSalao} periodo={periodo} taxaEntrega={taxaEntrega} />
      )}

      {/* GERAL */}
      {subAba === "geral" && <>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Metrica icon="💰" label="Total geral" valor={"R$ " + totalGeral.toFixed(2)} cor="#7b1a0a" />
          <Metrica icon="🛵" label="Delivery" valor={"R$ " + totalDelivery.toFixed(2)} sub={pp.length + " pedido" + (pp.length !== 1 ? "s" : "")} cor="#10b981" />
          <Metrica icon="🍽️" label="Salão" valor={"R$ " + totalSalao.toFixed(2)} cor="#3b82f6" />
          <Metrica icon="🏆" label="Mais vendido" valor={mv ? mv[1] + "x" : "—"} sub={mv ? mv[0] : ""} cor="#f59e0b" />
          {totalDescontos > 0 && <Metrica icon="🎟️" label="Descontos" valor={"R$ " + totalDescontos.toFixed(2)} sub={descontoSalao > 0 && descontoDelivery > 0 ? "cupons + comandas" : descontoSalao > 0 ? "no fechamento" : "via cupons"} cor="#8b5cf6" />}
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
            <Metrica icon="💰" label="Total salão" valor={"R$ " + (faturadoSalao + mesasSalao.reduce((s,m)=>s+totMesaCompleta(migrarMesa(m)),0)).toFixed(2)} cor="#10b981" />
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



          {/* Emissão de NFC-e em lote */}
          {elegiveisLote.length > 0 && (
            <div style={{ background: "#fff", borderRadius: 14, padding: "12px 14px", boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
              {!modoLote ? (
                <button onClick={() => setModoLote(true)}
                  style={{ width: "100%", background: "#fff", color: "#7b1a0a", border: "1.5px solid #7b1a0a", borderRadius: 10, padding: "10px 0", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                  🧾 Emitir notas em lote ({elegiveisLote.length} sem nota)
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>
                      {selecionadas.length} selecionada{selecionadas.length !== 1 ? "s" : ""}
                      {selecionadas.length > 0 && <span style={{ color: "#7b1a0a" }}> · R$ {totalSelecionado.toFixed(2)}</span>}
                    </div>
                    <button onClick={sairDoLote} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer", color: "#555" }}>Sair</button>
                  </div>

                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => setSelecionadas(elegiveisLote.map(v => v._id))}
                      style={{ flex: 1, background: "#f5f5f5", border: "none", borderRadius: 8, padding: "7px 0", fontSize: 12, cursor: "pointer", color: "#555", fontWeight: 600 }}>
                      Marcar todas ({elegiveisLote.length})
                    </button>
                    <button onClick={() => setSelecionadas([])}
                      style={{ flex: 1, background: "#f5f5f5", border: "none", borderRadius: 8, padding: "7px 0", fontSize: 12, cursor: "pointer", color: "#555", fontWeight: 600 }}>
                      Limpar
                    </button>
                  </div>

                  <button onClick={emitirLote} disabled={emitindoLote || !selecionadas.length}
                    style={{
                      background: (emitindoLote || !selecionadas.length) ? "#ccc" : "linear-gradient(135deg,#7b1a0a,#c0392b)",
                      color: "#fff", border: "none", borderRadius: 10, padding: "11px 0", fontWeight: 700, fontSize: 14,
                      cursor: (emitindoLote || !selecionadas.length) ? "not-allowed" : "pointer",
                    }}>
                    {emitindoLote ? "Emitindo... nao feche a tela" : `🧾 Emitir ${selecionadas.length} nota${selecionadas.length !== 1 ? "s" : ""}`}
                  </button>

                  <div style={{ fontSize: 11, color: "#888", lineHeight: 1.5 }}>
                    Vao como <strong>consumidor nao identificado</strong>. Se algum cliente pediu nota com CPF,
                    emita essa pelo botao dentro da comanda.
                  </div>

                  {resultadoLote?.erroGeral && (
                    <div style={{ background: "#fee2e2", color: "#991b1b", borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 600, lineHeight: 1.5 }}>
                      {resultadoLote.erroGeral}
                    </div>
                  )}

                  {resultadoLote?.total !== undefined && (
                    <div style={{ background: "#faf9f8", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#333" }}>
                        {resultadoLote.autorizadas} autorizada{resultadoLote.autorizadas !== 1 ? "s" : ""}
                        {resultadoLote.falhas > 0 && <span style={{ color: "#991b1b" }}> · {resultadoLote.falhas} com erro</span>}
                      </div>
                      {resultadoLote.resultados.filter(x => !x.ok).map(x => {
                        const v = historicoSalao.find(h => String(h._id) === String(x.vendaId));
                        return (
                          <div key={x.vendaId} style={{ fontSize: 11, color: "#991b1b", lineHeight: 1.45 }}>
                            <strong>{v ? `Mesa ${v.mesa}` : x.vendaId}</strong>: {x.erro}
                            {x.detalhes?.length ? " — " + x.detalhes.slice(0, 3).join("; ") : ""}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
                    onClick={() => {
                      // No modo lote, tocar na comanda marca/desmarca em vez de abrir
                      if (modoLote && v._id && v.notaFiscalStatus !== "autorizada") return alternarSelecao(v._id);
                      setVendaAberta(vendaAberta === v.id ? null : v.id);
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {modoLote && (
                        <input type="checkbox" readOnly
                          checked={selecionadas.includes(v._id)}
                          disabled={!v._id || v.notaFiscalStatus === "autorizada"}
                          style={{ width: 20, height: 20, accentColor: "#7b1a0a", flexShrink: 0, cursor: "pointer" }} />
                      )}
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>Mesa {v.mesa} {v.cliente !== "—" ? `— ${v.cliente}` : ""}</div>
                      <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
                        👤 {v.garcom} · {new Date(v.fechamento).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
                        {v.abertura && ` · ⏱️ ${Math.round((new Date(v.fechamento)-new Date(v.abertura))/60000)}min`}
                      </div>
                    </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 800, fontSize: 16, color: "#7b1a0a" }}>R$ {v.total.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: "#888" }}>{v.pagamento === "pix" ? "🟢 Pix" : v.pagamento === "cartao" ? "💳 Cartão" : v.pagamento === "misto" ? "🔀 Misto" : "💵 Dinheiro"}</div>
                      <BadgeNota status={v.notaFiscalStatus} />
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
                      {v._id && <BotaoEmitirNota venda={v} onEmitido={() => { if (setHistoricoSalao) setHistoricoSalao(h => h.map(x => x._id === v._id ? { ...x, notaFiscalStatus: "autorizada" } : x)); }} />}
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.grayL}`, display:"flex", gap:8 }}>
                        <button onClick={(e)=>{
                          e.stopPropagation();
                          const win = abrirJanelaImpressao('width=400,height=600');
                          if (!win) return;
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
                            ${v.desconto > 0 ? `<div class="linha"><span>Subtotal</span><span>R$ ${(v.subtotal||v.total).toFixed(2)}</span></div>
                            <div class="linha"><span>Desconto${v.descontoInfo?' ('+v.descontoInfo+')':''}</span><span>− R$ ${v.desconto.toFixed(2)}</span></div>` : ''}
                            <div class="total"><span>TOTAL</span><span>R$ ${v.total.toFixed(2)}</span></div>
                            <div class="info" style="margin-top:10px">Pagamento: ${descrevePagamento(v.pagamentos, v.pagamento)}</div>
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
                              try { await authFetch(BACKEND_URL + "/vendas-salao/" + v._id, { method: "DELETE" }); } catch {}
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

      {subAba === "lucro" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>💰 Análise de Lucro</div>
            <button onClick={carregarLucro} disabled={loadingLucro} style={{ background: "#f0f0f0", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#555" }}>
              {loadingLucro ? "⏳" : "↻ Atualizar"}
            </button>
          </div>

          {!relLucro || loadingLucro ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "#ccc" }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>💰</div>
              <div>{loadingLucro ? "Calculando..." : "Clique em Atualizar para carregar."}</div>
            </div>
          ) : (
            <>
              {/* Cards principais */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Metrica icon="💰" label="Faturamento" valor={"R$ " + relLucro.faturamento.toFixed(2)} cor="#3b82f6" />
                <Metrica icon="📦" label="Custo total" valor={"R$ " + relLucro.custoTotal.toFixed(2)} cor="#f59e0b" />
                <Metrica icon="✅" label="Lucro líquido" valor={"R$ " + relLucro.lucroTotal.toFixed(2)} cor={relLucro.lucroTotal >= 0 ? "#10b981" : "#ef4444"} />
                <Metrica icon="📊" label="Margem" valor={relLucro.margem.toFixed(1) + "%"} cor={relLucro.margem >= 40 ? "#10b981" : relLucro.margem >= 20 ? "#f59e0b" : "#ef4444"} />
              </div>

              {/* Aviso de itens sem custo cadastrado */}
              {relLucro.semCusto?.length > 0 && (
                <div style={{ background: "#fef3c7", border: "1.5px solid #f59e0b", borderRadius: 12, padding: "10px 14px" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>⚠️ Itens sem custo cadastrado (não incluídos no cálculo)</div>
                  <div style={{ fontSize: 11, color: "#92400e" }}>{relLucro.semCusto.join(", ")}</div>
                  <div style={{ fontSize: 10, color: "#b45309", marginTop: 4 }}>Cadastre o custo desses itens no Estoque para um cálculo mais preciso.</div>
                </div>
              )}

              {/* Lucro por dia */}
              {relLucro.porDia?.length > 0 && (
                <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>📅 Lucro por dia</div>
                  {[...relLucro.porDia].reverse().map((d, i) => {
                    const margem = d.faturamento > 0 ? (d.lucro / d.faturamento) * 100 : 0;
                    const corLucro = d.lucro >= 0 ? "#10b981" : "#ef4444";
                    const dataFmt = new Date(d.dia+"T12:00:00").toLocaleDateString("pt-BR", { weekday:"short", day:"2-digit", month:"2-digit" });
                    return (
                      <div key={d.dia} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px dashed #f0f0f0" }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{dataFmt}</div>
                          <div style={{ fontSize: 11, color: "#888" }}>Fat: R$ {d.faturamento.toFixed(2)} · Custo: R$ {d.custo.toFixed(2)}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 800, fontSize: 14, color: corLucro }}>R$ {d.lucro.toFixed(2)}</div>
                          <div style={{ fontSize: 10, color: "#888" }}>{margem.toFixed(1)}% margem</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Ranking de lucro por item */}
              {relLucro.porItem?.length > 0 && (
                <div style={{ background: "#fff", borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(0,0,0,0.07)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#333", marginBottom: 12 }}>🏆 Lucro por item</div>
                  {relLucro.porItem.slice(0,10).map((it, i) => {
                    const margem = it.faturamento > 0 ? (it.lucro / it.faturamento) * 100 : 0;
                    const maxLucro = relLucro.porItem[0]?.lucro || 1;
                    return (
                      <div key={it.nome} style={{ marginBottom: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                          <span style={{ fontWeight: i < 3 ? 700 : 400, color: "#333" }}>
                            {["🥇","🥈","🥉"][i] || `${i+1}.`} {it.nome}
                            {!it.temCusto && <span style={{ fontSize: 10, color: "#f59e0b", marginLeft: 4 }}>⚠️ sem custo</span>}
                          </span>
                          <div style={{ textAlign: "right" }}>
                            <span style={{ fontWeight: 700, color: it.lucro >= 0 ? "#10b981" : "#ef4444" }}>R$ {it.lucro.toFixed(2)}</span>
                            <span style={{ fontSize: 10, color: "#aaa", marginLeft: 6 }}>{it.qty}x · {margem.toFixed(0)}%</span>
                          </div>
                        </div>
                        <div style={{ height: 6, background: "#f0f0f0", borderRadius: 3 }}>
                          <div style={{ height: "100%", width: Math.max(0, (it.lucro / maxLucro) * 100) + "%", background: i === 0 ? "linear-gradient(90deg,#10b981,#059669)" : "linear-gradient(90deg,#3b82f6,#1d4ed8)", borderRadius: 3 }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}
function Clientes({ pedidos, taxaEntrega = TAXA_ENTREGA_PADRAO }) {
  const [busca, setBusca] = useState(""); const [sel, setSel] = useState(null); const [ord, setOrd] = useState("gasto");
  const cm = {}; pedidos.forEach(p => { if (!cm[p.telefone]) cm[p.telefone] = { nome: p.cliente, telefone: p.telefone, pedidos: [] }; cm[p.telefone].pedidos.push(p); });
  const clientes = Object.values(cm).map(c => {
    const ent = c.pedidos.filter(p => p.status === "entregue");
    const tg = ent.reduce((s, p) => s + totalPedido(p, taxaEntrega), 0);
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
                  <span style={{ fontWeight: 800, fontSize: 14, color: "#7b1a0a" }}>R$ {totalPedido(p).toFixed(2)}</span>
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
function PedidoCard({ pedido, onStatus, expanded, onToggle, atualizando, onEdit, cardapio, taxaEntrega = TAXA_ENTREGA_PADRAO }) {
  const total = totalPedido(pedido, taxaEntrega);
  const sc = STATUS_CONFIG[pedido.status] || STATUS_CONFIG.novo;
  const nxt = { novo: "preparando", preparando: "entrega", entrega: "entregue" }[pedido.status];
  const isNovo = pedido.status === "novo";
  const podeEditar = pedido.status === "novo" || pedido.status === "preparando";

  const [editMode, setEditMode] = useState(false);
  const [editItens, setEditItens] = useState([]);
  const [editObs, setEditObs] = useState("");
  const [addAberto, setAddAberto] = useState(false);
  const [buscaItem, setBuscaItem] = useState("");

  function iniciarEdicao() {
    setEditItens((pedido.itens || []).map(i => ({ ...i, qty: i.qty || 1 })));
    setEditObs(pedido.obs || "");
    setEditMode(true);
    setAddAberto(false);
  }

  function editQty(idx, delta) {
    setEditItens(prev => prev.map((it, i) => i === idx ? { ...it, qty: it.qty + delta } : it).filter(it => it.qty > 0));
  }

  function removerItem(idx) {
    setEditItens(prev => prev.filter((_, i) => i !== idx));
  }

  function adicionarItem(item) {
    const existe = editItens.findIndex(i => i.nome.toLowerCase() === item.nome.toLowerCase());
    if (existe >= 0) {
      setEditItens(prev => prev.map((it, i) => i === existe ? { ...it, qty: it.qty + 1 } : it));
    } else {
      setEditItens(prev => [...prev, { nome: item.nome, preco: item.preco, qty: 1 }]);
    }
    setAddAberto(false);
    setBuscaItem("");
  }

  const editSubtotal = editItens.reduce((s, i) => s + i.qty * i.preco, 0);
  const editTotal = editSubtotal + (Number(taxaEntrega) || 0) - (pedido.desconto || 0);

  const cardapioFiltrado = (cardapio || []).filter(c => c.ativo !== false && c.nome.toLowerCase().includes(buscaItem.toLowerCase()));

  return (
    <div className="card-hover fade-in" style={{ background: T.white, borderRadius: T.radius, boxShadow: isNovo ? `0 0 0 1.5px ${T.amber}, 0 4px 16px rgba(212,132,42,0.12)` : T.shadow, overflow: "hidden", opacity: atualizando ? 0.6 : 1, transition: "all 0.25s ease", border: `1px solid ${editMode ? T.blue+"40" : isNovo ? "transparent" : T.grayL}` }}>
      <div onClick={onToggle} style={{ padding: "16px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14, borderLeft: `3px solid ${editMode ? T.blue : sc.color}`, userSelect: "none" }}>
        <div style={{ width: 44, height: 44, borderRadius: T.radiusS, background: editMode ? T.blueL : sc.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 }}>{atualizando ? "⏳" : editMode ? "✏️" : sc.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="serif-title" style={{ fontWeight: 700, fontSize: 15, color: T.dark }}>#{pedido.id} — {pedido.cliente}</span>
            {editMode ? <span style={{ background: T.blueL, color: T.blue, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 600 }}>Editando</span> : <Badge status={pedido.status} />}
            {pedido.cupom && <span style={{ background: T.purpleL, color: T.purple, borderRadius: 20, padding: "1px 8px", fontSize: 11, fontWeight: 600 }}>🎟️ {pedido.cupom}</span>}
          </div>
          <div style={{ fontSize: 12, color: T.gray, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📍 {pedido.endereco}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: editMode ? T.blue : T.wine }}>R$ {editMode ? editTotal.toFixed(2) : total.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: T.gray, marginTop: 1 }}>⏱️ {pedido.tempoPreparo || "—"}min</div>
        </div>
        <div style={{ color: T.grayL, fontSize: 16, flexShrink: 0 }}>{expanded ? "▴" : "▾"}</div>
      </div>
      {expanded && (
        <div style={{ borderTop: `1px solid ${T.grayL}`, padding: "14px 16px", background: editMode ? T.blueL+"30" : T.grayLL }}>
          <div style={{ background: T.white, borderRadius: T.radiusS, padding: "12px", marginBottom: 12, border: `1px solid ${editMode ? T.blue+"40" : T.grayL}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: T.gray, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{editMode ? "Editando itens" : "Itens do pedido"}</div>
            {editMode ? (
              <>
                {editItens.map((it, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${T.grayL}` }}>
                    <button onClick={() => removerItem(i)} style={{ width: 24, height: 24, borderRadius: "50%", border: "none", background: T.redL, color: T.red, fontWeight: 800, fontSize: 14, cursor: "pointer", flexShrink: 0 }}>×</button>
                    <div style={{ flex: 1, fontSize: 13 }}>{it.nome}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button onClick={() => editQty(i, -1)} style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: T.redL, color: T.red, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>−</button>
                      <span style={{ fontWeight: 800, minWidth: 18, textAlign: "center" }}>{it.qty}</span>
                      <button onClick={() => editQty(i, 1)} style={{ width: 26, height: 26, borderRadius: "50%", border: "none", background: T.greenL, color: T.green, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>+</button>
                    </div>
                    <span style={{ fontWeight: 600, fontSize: 13, minWidth: 60, textAlign: "right" }}>R$ {(it.qty * it.preco).toFixed(2)}</span>
                  </div>
                ))}
                {editItens.length === 0 && <div style={{ textAlign: "center", padding: 10, color: T.gray, fontSize: 13 }}>Nenhum item</div>}
                {/* Adicionar item */}
                {!addAberto ? (
                  <button onClick={() => setAddAberto(true)} style={{ width: "100%", marginTop: 8, padding: "8px", background: T.greenL, color: T.green, border: `1px dashed ${T.green}`, borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>+ Adicionar item</button>
                ) : (
                  <div style={{ marginTop: 8, border: `1px solid ${T.grayL}`, borderRadius: 8, overflow: "hidden" }}>
                    <input value={buscaItem} onChange={e => setBuscaItem(e.target.value)} placeholder="Buscar item..." autoFocus style={{ width: "100%", padding: "8px 10px", border: "none", borderBottom: `1px solid ${T.grayL}`, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                    <div style={{ maxHeight: 150, overflowY: "auto" }}>
                      {cardapioFiltrado.slice(0, 10).map(c => (
                        <div key={c.id} onClick={() => adicionarItem(c)} style={{ padding: "8px 10px", cursor: "pointer", display: "flex", justifyContent: "space-between", fontSize: 13, borderBottom: `1px solid ${T.grayL}` }}
                          onMouseEnter={e => e.currentTarget.style.background = T.grayLL} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <span>{c.nome}</span><span style={{ color: T.gray }}>R$ {c.preco.toFixed(2)}</span>
                        </div>
                      ))}
                      {cardapioFiltrado.length === 0 && <div style={{ padding: 10, textAlign: "center", color: T.gray, fontSize: 12 }}>Nenhum item encontrado</div>}
                    </div>
                    <button onClick={() => { setAddAberto(false); setBuscaItem(""); }} style={{ width: "100%", padding: 6, background: T.grayL, border: "none", fontSize: 12, cursor: "pointer", color: T.gray }}>Fechar</button>
                  </div>
                )}
                {/* Obs */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: T.gray, marginBottom: 4 }}>Observação</div>
                  <input value={editObs} onChange={e => setEditObs(e.target.value)} placeholder="Obs do pedido..." style={{ width: "100%", padding: "7px 10px", border: `1px solid ${T.grayL}`, borderRadius: 8, fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
              </>
            ) : (
              <>
                {(pedido.itens || []).map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${T.grayL}`, fontSize: 13, color: T.dark }}>
                    <span style={{ color: T.gray }}>{it.qty || 1}× <span style={{ color: T.dark }}>{it.nome}</span></span>
                    <span style={{ fontWeight: 600, color: T.dark }}>R$ {((it.qty || 1) * it.preco).toFixed(2)}</span>
                  </div>
                ))}
              </>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, color: T.gray }}><span>Taxa de entrega</span><span>R$ {(Number(taxaEntrega)||0).toFixed(2)}</span></div>
            {(editMode ? pedido.desconto : pedido.desconto) > 0 && <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 12, color: T.purple }}><span>🎟️ Desconto ({pedido.cupom})</span><span>-R$ {pedido.desconto.toFixed(2)}</span></div>}
            <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, marginTop: 4, borderTop: `1px solid ${T.grayL}`, fontSize: 15, fontWeight: 700, color: editMode ? T.blue : T.wine }}><span>Total</span><span>R$ {editMode ? editTotal.toFixed(2) : total.toFixed(2)}</span></div>
          </div>
          {!editMode && pedido.obs && <div style={{ background: T.amberL, border: `1px solid ${T.amber}40`, borderRadius: T.radiusS, padding: "8px 12px", marginBottom: 12, fontSize: 13, color: T.amber }}>⚠️ <strong>Obs:</strong> {pedido.obs}</div>}
          <div style={{ fontSize: 12, color: T.gray, marginBottom: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>📞 {pedido.telefone}</span>
            <span>🕐 {horaFmt(pedido.horario)}</span>
            {pedido.tempoPreparo && <span>⏱️ ~{pedido.tempoPreparo}min</span>}
          </div>
          {editMode ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { if (editItens.length === 0) return; onEdit(pedido.id, editItens, editObs); setEditMode(false); }} disabled={atualizando || editItens.length === 0}
                style={{ flex: 1, background: editItens.length > 0 ? `linear-gradient(135deg,${T.green},#1a6b3c)` : T.grayL, color: T.white, border: "none", borderRadius: T.radiusS, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: editItens.length > 0 ? "pointer" : "not-allowed", fontFamily:"'DM Sans',sans-serif" }}>
                Salvar alteracao
              </button>
              <button onClick={() => setEditMode(false)} style={{ background: T.white, color: T.gray, border: `1.5px solid ${T.grayL}`, borderRadius: T.radiusS, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily:"'DM Sans',sans-serif" }}>Cancelar</button>
            </div>
          ) : pedido.status !== "entregue" && pedido.status !== "cancelado" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={async () => {
                if (impressora.isDisponivel()) {
                  try {
                    await impressora.imprimirPedidoDelivery(pedido);
                    return;
                  } catch (e) { console.warn("Erro imprimir delivery:", e.message); }
                }
                alert("Impressora Bluetooth não conectada. Vá em Config → Impressora.");
              }} style={{ background: T.white, color: T.dark, border: `1.5px solid ${T.grayL}`, borderRadius: T.radiusS, padding: "10px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily:"'DM Sans',sans-serif" }}>🖨️ Imprimir</button>
              {podeEditar && <button onClick={iniciarEdicao} style={{ background: T.white, color: T.blue, border: `1.5px solid ${T.blue}`, borderRadius: T.radiusS, padding: "10px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily:"'DM Sans',sans-serif" }}>✏️ Editar</button>}
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

// Duas carnes diferentes do mesmo prato sao linhas SEPARADAS na comanda.
// Antes o agrupamento era so por id, entao "Lanche (picanha)" e
// "Lanche (kafta)" viravam a mesma linha e um dos precos se perdia.
function chaveItem(it) { return String(it?.id) + "|" + (it?.variacao || ""); }

const FORMAS_PAG = [["pix","🟢 Pix"],["cartao","💳 Cartão"],["dinheiro","💵 Dinheiro"]];
const NOME_PAG = { pix: "Pix", cartao: "Cartão", dinheiro: "Dinheiro", misto: "Misto" };

// Texto para recibo e mensagem: "Pix" ou "Pix R$ 30,00 + Dinheiro R$ 20,00"
function descrevePagamento(pagamentos, pagamentoSimples) {
  if (!Array.isArray(pagamentos) || pagamentos.length === 0) return NOME_PAG[pagamentoSimples] || pagamentoSimples || "";
  if (pagamentos.length === 1) return NOME_PAG[pagamentos[0].tipo] || pagamentos[0].tipo;
  return pagamentos.map(p => `${NOME_PAG[p.tipo] || p.tipo} ${fmtR(p.valor)}`).join(" + ");
}
function tempoAberto(abertura) {
  if(!abertura) return null;
  const m = Math.floor((Date.now()-new Date(abertura))/60000);
  if(m<60) return m+"min"; return Math.floor(m/60)+"h"+(m%60>0?(m%60)+"min":"");
}

// ── SALÃO INTEGRADO ───────────────────────────────────────────
// ── EDITOR DE RODADAS (ITENS JÁ ENVIADOS À COZINHA) ─────────
function RodadasEditor({ rodadas, isDono, onSave }) {
  // Detecta rodada recém-adicionada (últimos 5 segundos)
  const agora = Date.now();
  function isRecente(hora) { return agora - new Date(hora).getTime() < 5000; }
  const [editIdx, setEditIdx] = useState(null);
  const [editItens, setEditItens] = useState([]);

  function iniciarEdicao(ri) {
    setEditItens((rodadas[ri].itens || []).map(i => ({ ...i, qty: i.qty || 1 })));
    setEditIdx(ri);
  }

  function salvar() {
    const novasRodadas = rodadas.map((r, i) => i === editIdx ? { ...r, itens: editItens, editadoEm: new Date().toISOString() } : r);
    onSave(novasRodadas);
    setEditIdx(null);
  }

  function chgEditQty(idx, delta) {
    setEditItens(prev => prev.map((it, i) => i === idx ? { ...it, qty: it.qty + delta } : it).filter(it => it.qty > 0));
  }

  return (
    <div style={{background:"#fff",borderRadius:14,padding:"14px 16px",boxShadow:"0 2px 10px rgba(0,0,0,0.07)",marginBottom:8}}>
      <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:8,textTransform:"uppercase"}}>📋 Enviados à cozinha</div>
      {rodadas.map((r, ri) => {
        const recente = isRecente(r.hora);
        return (
        <div key={ri} style={{marginBottom:8,paddingBottom:8,borderBottom:"1px dashed #f0f0f0",borderRadius:recente?10:0,background:recente?"#d1fae5":"transparent",padding:recente?"8px 10px":"0",transition:"background 1s ease",border:recente?"1.5px solid #10b981":"none"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <div style={{fontSize:11,color:recente?"#065f46":"#aaa"}}>
              {recente && "✅ "} Rodada {ri+1} — {new Date(r.hora).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}
              {recente && <span style={{fontWeight:700,marginLeft:6}}>Enviado!</span>}
              {r.editadoEm && <span style={{color:"#f59e0b",marginLeft:6}}>(editado)</span>}
            </div>
            {isDono && editIdx !== ri && (
              <button onClick={() => iniciarEdicao(ri)} style={{background:"#eff6ff",color:"#1d4ed8",border:"none",borderRadius:6,padding:"3px 8px",fontSize:11,fontWeight:600,cursor:"pointer"}}>✏️ Editar</button>
            )}
          </div>
          {editIdx === ri ? (
            <div>
              {editItens.map((it, ii) => (
                <div key={ii} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 0",borderBottom:"1px solid #f8f8f8"}}>
                  <button onClick={() => setEditItens(prev => prev.filter((_, i) => i !== ii))} style={{width:22,height:22,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:12,cursor:"pointer",flexShrink:0}}>×</button>
                  <div style={{flex:1,fontSize:12}}>{it.nome}</div>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    <button onClick={() => chgEditQty(ii, -1)} style={{width:24,height:24,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:14,cursor:"pointer"}}>−</button>
                    <span style={{fontWeight:800,minWidth:16,textAlign:"center",fontSize:13}}>{it.qty}</span>
                    <button onClick={() => chgEditQty(ii, 1)} style={{width:24,height:24,borderRadius:"50%",border:"none",background:"#d1fae5",color:"#10b981",fontWeight:800,fontSize:14,cursor:"pointer"}}>+</button>
                  </div>
                </div>
              ))}
              {editItens.length === 0 && <div style={{textAlign:"center",padding:6,color:"#ccc",fontSize:12}}>Todos os itens removidos</div>}
              <div style={{display:"flex",gap:6,marginTop:6}}>
                <button onClick={salvar} style={{flex:1,background:"linear-gradient(135deg,#2D7A4F,#1a6b3c)",color:"#fff",border:"none",borderRadius:8,padding:"7px",fontWeight:600,fontSize:12,cursor:"pointer"}}>Salvar</button>
                <button onClick={() => setEditIdx(null)} style={{background:"#f0f0f0",color:"#666",border:"none",borderRadius:8,padding:"7px 12px",fontWeight:600,fontSize:12,cursor:"pointer"}}>Cancelar</button>
              </div>
            </div>
          ) : (
            r.itens.map((it, ii) => (
              <div key={ii} style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#555",padding:"2px 0"}}>
                <span>{it.qty||1}x {it.nome}</span>
              </div>
            ))
          )}
        </div>
      );
      })}
    </div>
  );
}

function SalaoIntegrado({ cardapio: cardapioExterno, config: configExterna, perfilSalao, setPerfilSalao, mesasSalao, setMesasSalao, faturadoSalao, setFaturadoSalao, selSalao, setSelSalao, telaSalaoGlobal, setTelaSalaoGlobal, isDono, historicoSalao = [], setHistoricoSalao, onSairApp, garcomLogado }) {
  // ── MODO EVENTO (preços promocionais) ──
  const modoEvento = configExterna?.modoEvento || {};
  const emModoEvento = (() => {
    if (modoEvento.ativo) return true;
    if (modoEvento.agendado && modoEvento.inicio && modoEvento.fim) {
      const agora = Date.now();
      return agora >= new Date(modoEvento.inicio).getTime() && agora <= new Date(modoEvento.fim).getTime();
    }
    return false;
  })();
  function precoItem(item) {
    if (emModoEvento && item.precoPromocional && item.precoPromocional > 0) return item.precoPromocional;
    return item.preco;
  }
  const perfil = perfilSalao;
  // Quem pode lancar pedido na comanda. Na espetaria o caixa tambem anota —
  // deixar isso so para garcom travava a operacao quando ninguem entrava
  // com login de garcom.
  const podeLancar = perfil === "garcom" || perfil === "caixa" || isDono;

  // Quando a termica nao entra, o app abria a janela do navegador em silencio
  // e parecia que "nao da para imprimir na termica". Agora diz o motivo.
  function avisarSemTermica(erro) {
    if (erro) msgSalao("Impressora Bluetooth falhou: " + erro, "#f59e0b");
    else if (!impressora.isSupported()) msgSalao("Este navegador nao tem Bluetooth. Use o Chrome no Android.", "#f59e0b");
    else msgSalao("Impressora nao pareada neste aparelho. Va em Config -> Impressora", "#f59e0b");
  }
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
  const [varAberta, setVarAberta] = useState(null);   // item com a escolha de carne aberta
  // Comanda paga em mais de uma forma (metade dinheiro, metade pix)
  const [pagDividido, setPagDividido] = useState(false);
  const [valoresPag, setValoresPag] = useState({ pix: "", cartao: "", dinheiro: "" });

  // Desconto no fechamento. Tres jeitos de dizer a mesma coisa:
  //   percentual -> "10% no pix"
  //   valor      -> "tira R$ 5"
  //   total      -> "deu 51, cobra 50" (o mais natural para arredondar)
  const [descModo, setDescModo] = useState("nenhum");
  const [descValor, setDescValor] = useState("");

  function calcDesconto(subtotal) {
    const vazio = { valor: 0, texto: "", erro: null };
    if (descModo === "nenhum" || !descValor) return vazio;

    if (descModo === "percentual") {
      const pct = parseFloat(String(descValor).replace(",", ".")) || 0;
      if (pct <= 0) return vazio;
      if (pct > 100) return { ...vazio, erro: "Percentual acima de 100%" };
      return { valor: parseFloat((subtotal * pct / 100).toFixed(2)), texto: `${pct}%`, erro: null };
    }

    if (descModo === "valor") {
      const v = parseMoedaGlobal(descValor);
      if (v <= 0) return vazio;
      if (v > subtotal) return { ...vazio, erro: "Desconto maior que a conta" };
      return { valor: v, texto: fmtR(v), erro: null };
    }

    // "total": o operador digita quanto vai cobrar e o desconto sai da conta
    const alvo = parseMoedaGlobal(descValor);
    if (alvo <= 0) return vazio;
    if (alvo > subtotal) return { ...vazio, erro: "Valor maior que a conta" };
    return { valor: parseFloat((subtotal - alvo).toFixed(2)), texto: `arredondado para ${fmtR(alvo)}`, erro: null };
  }

  // Campos de pagamento do registro. Aceita a lista nova e cai no modo antigo
  // (uma forma so) quando ninguem passa nada.
  function resumoPagamento(pagamentos, total) {
    const lista = Array.isArray(pagamentos) && pagamentos.length
      ? pagamentos
      : [{ tipo: pagSalao, valor: parseFloat((Number(total)||0).toFixed(2)) }];
    return {
      pagamento: lista.length === 1 ? lista[0].tipo : "misto",
      pagamentos: lista,
      pagamentoTexto: descrevePagamento(lista, pagSalao),   // so para o recibo
    };
  }

  function limparPagamento() {
    setPagDividido(false);
    setValoresPag({ pix: "", cartao: "", dinheiro: "" });
    setDescModo("nenhum");
    setDescValor("");
  }

  // Monta o que vai para o servidor e diz quanto ainda falta lancar
  function montarPagamentos(total) {
    if (!pagDividido) {
      return { pagamentos: [{ tipo: pagSalao, valor: parseFloat(total.toFixed(2)) }], falta: 0 };
    }
    const lista = FORMAS_PAG
      .map(([tipo]) => ({ tipo, valor: parseMoedaGlobal(valoresPag[tipo]) }))
      .filter(p => p.valor > 0);
    const soma = lista.reduce((acc, p) => acc + p.valor, 0);
    return { pagamentos: lista, falta: parseFloat((total - soma).toFixed(2)) };
  }
  const [divSalao, setDivSalao] = useState(1);
  const [selSC, setSelSC] = useState(0); // índice da sub-comanda ativa
  const fechandoRef = useRef(false); // trava contra duplo clique em fechar mesa/comanda
  const [toastSalao, setToastSalao] = useState(null);

  const cardapio = (cardapioExterno && cardapioExterno.length > 0)
    ? cardapioExterno.filter(i=>i.ativo!==false).map(i=>({...i,cat:i.categoria||i.cat}))
    : CARDAPIO_SALAO;

  function msgSalao(txt,cor="#10b981"){setToastSalao({txt,cor,ts:Date.now()});setTimeout(()=>setToastSalao(null),4000);}
  const mesaRaw = mesas.find(m=>m.id===sel);
  const mesa = mesaRaw ? migrarMesa(mesaRaw) : null;
  function upd(m){setMesas(p=>p.map(x=>x.id===m.id?m:x));}

  // Sub-comanda ativa (com segurança para índice fora do range)
  const scIdx = Math.min(selSC, (mesa?.subComandas?.length||1)-1);
  const sc = mesa?.subComandas?.[scIdx] || initSubComanda(1);

  // Atualiza apenas a sub-comanda ativa

  function addItem(item, variacao){
    // Variação tem preço próprio e vira nome próprio na comanda e na cozinha
    // nomeBase preserva o nome do cardápio: o backend liga estoque e dados
    // fiscais por ele, já que o nome exibido ganha o sufixo da variação
    const base = variacao
      ? { ...item, nome: `${item.nome} (${variacao.nome})`, nomeBase: item.nome, variacao: variacao.nome, precoPromocional: null }
      : item;
    const precoAgora = variacao ? Number(variacao.preco) || 0 : precoItem(item);
    const chave = chaveItem(base);
    const existe=sc.itens.find(i=>chaveItem(i)===chave);
    const itens=existe
      // Sempre atualiza o preço para o atual (caso modo evento tenha ligado/desligado)
      ? sc.itens.map(i=>chaveItem(i)===chave?{...i,qty:(i.qty||1)+1,preco:precoAgora}:i)
      : [...sc.itens,{...base,preco:precoAgora,qty:1}];
    const nomeGarcom = mesa.garcom || (garcomLogado?.nome) || "";
    const novaAbertura = mesa.abertura||new Date().toISOString();
    const novoStatus = mesa.status==="livre"?"ocupada":mesa.status;
    upd({...mesa, garcom:nomeGarcom, status:novoStatus, abertura:novaAbertura,
         subComandas: mesa.subComandas.map((s,i)=>i===scIdx?{...s,itens}:s)});
  }
  function chgQty(chave,d){
    const itens=sc.itens.map(i=>chaveItem(i)===chave?{...i,qty:(i.qty||1)+d}:i).filter(i=>i.qty>0);
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
  async function imprimirCozinha(rodada, mesaId, scLabel){
    const agora = new Date();
    const nomeGarcom = garcomLogado?.nome || mesa.garcom || "—";

    const ticket = {
      mesa: mesaId,
      label: scLabel,
      garcom: nomeGarcom,
      cliente: sc.cliente,
      itens: rodada.itens,
      hora: rodada.hora,
    };

    // 1) Impressora aqui neste aparelho: imprime direto
    if (impressora.isDisponivel()) {
      try {
        await impressora.imprimirComanda(ticket);
        return;
      } catch (e) {
        console.warn("Falha ao imprimir BT:", e.message);
        avisarSemTermica(e.message);
      }
    } else {
      // 2) Celular do garcom: manda para a estacao do caixa imprimir
      try {
        await enfileirarImpressao("cozinha", ticket);
        msgSalao("🖨️ Ticket enviado para a impressora do caixa");
        return;
      } catch (e) {
        avisarSemTermica(e.message);
      }
    }

    // 3) Fallback: janela do navegador
    const win = abrirJanelaImpressao('width=360,height=520');
    if (!win) return;
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

  async function fecharComanda(idxSC, pagamentos, descInfo){
    // Duplo clique no botao criava DUAS vendas no banco
    if (fechandoRef.current) return;
    fechandoRef.current = true;
    const scFechando = mesa.subComandas[idxSC];
    const todosItens = [...(scFechando.rodadas||[]).flatMap(r=>r.itens), ...scFechando.itens].reduce((acc,it)=>{
      const ex=acc.find(i=>chaveItem(i)===chaveItem(it)); if(ex) ex.qty+=(it.qty||1); else acc.push({...it,qty:it.qty||1}); return acc;
    }, []);
    const subtotalSC = totMesa(scFechando.itens) + (scFechando.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0);
    const descontoSC = Math.min(Math.max(0, Number(descInfo?.valor) || 0), subtotalSC);
    const totalSC = parseFloat((subtotalSC - descontoSC).toFixed(2));
    const registro = {
      id: Date.now(),
      mesa: mesa.id,
      cliente: scFechando.cliente || "—",
      garcom: garcomLogado?.nome || mesa.garcom || "—",
      garcomId: garcomLogado?.id || null,
      subComanda: scFechando.label,
      itens: todosItens,
      subtotal: subtotalSC,
      desconto: descontoSC,
      descontoTipo: descontoSC > 0 ? (descInfo?.tipo || "") : "",
      descontoInfo: descontoSC > 0 ? (descInfo?.texto || "") : "",
      total: totalSC,
      ...resumoPagamento(pagamentos, totalSC),
      abertura: scFechando.abertura||mesa.abertura,
      fechamento: new Date().toISOString(),
    };
    // Antes: erro no POST era só console.warn e a mesa era liberada mesmo assim.
    // A venda existia no painel e NAO no banco -> divergia do fechamento do dia.
    try {
      const res = await authFetch(BACKEND_URL+"/vendas-salao",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(registro)});
      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        msgSalao(`❌ Nao foi possivel registrar a venda: ${err.erro || res.status}`, "#ef4444");
        fechandoRef.current = false;
        return;
      }
      const salvo = await res.json();
      registro._id = salvo._id;
    } catch(e){
      console.error("Falha ao salvar venda:", e);
      msgSalao("❌ Sem conexao com o servidor. A mesa NAO foi fechada.", "#ef4444");
      fechandoRef.current = false;
      return;
    }
    if(setHistoricoSalao) setHistoricoSalao(h=>[...h,registro]);
    setFaturado(f=>f+totalSC);

    // Imprime recibo do cliente se a impressora Bluetooth estiver conectada
    if (impressora.isDisponivel()) {
      try { await impressora.imprimirRecibo(registro); }
      catch (e) { console.warn("Erro ao imprimir recibo:", e.message); msgSalao("⚠️ Falha ao imprimir recibo", "#f59e0b"); }
    }

    limparPagamento();

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
    fechandoRef.current = false;
    setDivSalao(1);
  }

  async function fecharMesa(pagamentos, descInfo){
    if (fechandoRef.current) return; // evita venda duplicada por duplo clique
    fechandoRef.current = true;
    // Fecha todas as comandas de uma vez
    const todosItens = (mesa.subComandas||[]).flatMap(sc=>[...(sc.rodadas||[]).flatMap(r=>r.itens),...sc.itens])
      .reduce((acc,it)=>{const ex=acc.find(i=>chaveItem(i)===chaveItem(it));if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
    const subtotalMesa = totMesaCompleta(mesa);
    const descontoMesa = Math.min(Math.max(0, Number(descInfo?.valor) || 0), subtotalMesa);
    const totalMesa = parseFloat((subtotalMesa - descontoMesa).toFixed(2));
    const registro = {
      id: Date.now(), mesa: mesa.id,
      cliente: (mesa.subComandas||[]).map(s=>s.cliente).filter(Boolean).join(", ")||"—",
      garcom: garcomLogado?.nome||mesa.garcom||"—", garcomId:garcomLogado?.id||null,
      itens:todosItens,
      subtotal: subtotalMesa,
      desconto: descontoMesa,
      descontoTipo: descontoMesa > 0 ? (descInfo?.tipo || "") : "",
      descontoInfo: descontoMesa > 0 ? (descInfo?.texto || "") : "",
      total: totalMesa,
      ...resumoPagamento(pagamentos, totalMesa),
      abertura:mesa.abertura, fechamento:new Date().toISOString(),
    };
    try {
      const res = await authFetch(BACKEND_URL+"/vendas-salao",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(registro)});
      if (!res.ok) {
        const err = await res.json().catch(()=>({}));
        msgSalao(`❌ Nao foi possivel registrar a venda: ${err.erro || res.status}`, "#ef4444");
        fechandoRef.current = false;
        return;
      }
      const salvo = await res.json();
      registro._id = salvo._id;
    } catch(e) {
      console.error("Falha ao salvar venda:", e);
      msgSalao("❌ Sem conexao com o servidor. A mesa NAO foi fechada.", "#ef4444");
      fechandoRef.current = false;
      return;
    }
    if(setHistoricoSalao) setHistoricoSalao(h=>[...h,registro]);
    setFaturado(f=>f+totalMesa);

    // Imprime recibo do cliente se a impressora Bluetooth estiver conectada
    if (impressora.isDisponivel()) {
      try { await impressora.imprimirRecibo(registro); }
      catch (e) { console.warn("Erro ao imprimir recibo:", e.message); msgSalao("⚠️ Falha ao imprimir recibo", "#f59e0b"); }
    }

    msgSalao(`✅ Mesa ${mesa.id} fechada! ${fmtR(totalMesa)} — ${descrevePagamento(pagamentos, pagSalao)}`);
    upd(initMesa(mesa.id-1));
    limparPagamento();
    setSel(null); setTelaSalao("mapa"); setDivSalao(1); setSelSC(0);
    fechandoRef.current = false;
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


  // TELA ADICIONAR
  if(telaSalao==="adicionar") {
    const espetoCats = ["Tradicionais","Especiais","Doces","Churrasco Grego"];
    const catsComEspetos = ["todos","Espetos",...new Set(cardapio.map(i=>i.cat||i.categoria).filter(c=>!espetoCats.includes(c)))];
    const catIconsExt = {...catIcons, "Espetos":"🍢"};
    const filtrarCardapio = (item) => {
      if(catFiltro==="todos") return true;
      if(catFiltro==="Espetos") return espetoCats.includes(item.cat||item.categoria);
      return (item.cat||item.categoria)===catFiltro;
    };
    return (
    <div style={{background:T.cream,minHeight:"100%"}}>
      {toastSalao&&<div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:16,padding:"14px 28px",fontWeight:700,fontSize:15,zIndex:9999,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",minWidth:200,textAlign:"center",animation:"slideDown 0.3s ease"}}>{toastSalao.txt}</div>}
      <div style={H2}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button style={BK2} onClick={()=>setTelaSalao("comanda")}>← Voltar</button>
          <div style={{fontWeight:800,fontSize:15,flex:1}}>{mesa.nome || `Mesa ${mesa.id}`} — {sc.label}</div>
          <div style={{fontWeight:800,color:"#f0c040"}}>{fmtR(totMesa(sc.itens))}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:5,flexWrap:"wrap",padding:"10px 14px",background:"#fff",borderBottom:"1px solid #eee",alignItems:"center"}}>
        {catsComEspetos.map(c=>(
          <button key={c} onClick={()=>setCatFiltro(c)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"6px 8px",borderRadius:10,border:`2px solid ${catFiltro===c?"#7b1a0a":"transparent"}`,background:catFiltro===c?"#fef0ed":"#f8f8f8",cursor:"pointer",minWidth:48}}>
            <span style={{fontSize:16}}>{catIconsExt[c]||"🍽️"}</span>
            <span style={{fontSize:9,fontWeight:catFiltro===c?700:500,color:catFiltro===c?"#7b1a0a":"#666"}}>{c==="todos"?"Todos":c.length>8?c.slice(0,7)+".":c}</span>
          </button>
        ))}
        <button onClick={()=>setTelaSalao("comanda")} style={{marginLeft:"auto",background:"linear-gradient(135deg,#7b1a0a,#c0392b)",color:"#fff",border:"none",borderRadius:10,padding:"8px 14px",fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
          ✅ Comanda {sc.itens.length>0?`(${sc.itens.reduce((s,i)=>s+(i.qty||1),0)})`:""}
        </button>
      </div>
      {emModoEvento && (
        <div style={{background:"linear-gradient(135deg,#f59e0b,#d97706)",color:"#fff",padding:"8px 14px",fontSize:12,fontWeight:700,textAlign:"center"}}>
          🎉 {modoEvento.nome || "Modo Evento"} ATIVO — preços promocionais aplicados
        </div>
      )}
      <div style={{padding:"10px 14px 80px",display:"flex",flexDirection:"column",gap:8}}>
        {cardapio.filter(filtrarCardapio).map(item=>{
          const variacoes = Array.isArray(item.variacoes) ? item.variacoes : [];
          const temVariacao = variacoes.length > 0;
          const precoExibido = precoItem(item);
          const temPromo = emModoEvento && item.precoPromocional && item.precoPromocional > 0 && item.precoPromocional < item.preco;

          // Item com variação: a linha soma todas as carnes lançadas
          const naSimples = sc.itens.find(i=>chaveItem(i)===chaveItem(item));
          const qtdTotal = temVariacao
            ? sc.itens.filter(i=>i.id===item.id).reduce((soma,i)=>soma+(i.qty||1),0)
            : (naSimples ? naSimples.qty||1 : 0);
          const aberto = varAberta === item.id;

          const precos = variacoes.map(v=>Number(v.preco)||0);
          const faixa = temVariacao
            ? (Math.min(...precos) === Math.max(...precos)
                ? fmtR(Math.min(...precos))
                : `${fmtR(Math.min(...precos))} a ${fmtR(Math.max(...precos))}`)
            : null;

          return(
            <div key={item.id} style={{...card2,marginBottom:0,border:`2px solid ${qtdTotal?"#7b1a0a":temPromo?"#f59e0b":"transparent"}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:14}}>{item.nome}</div>
                  <div style={{fontSize:12,color:"#888"}}>
                    {temVariacao ? faixa
                      : temPromo ? <><span style={{textDecoration:"line-through",marginRight:6}}>{fmtR(item.preco)}</span><span style={{color:"#f59e0b",fontWeight:700}}>🎉 {fmtR(precoExibido)}</span></>
                      : fmtR(precoExibido)}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  {temVariacao ? (
                    <>
                      <span style={{fontWeight:800,fontSize:16,minWidth:20,textAlign:"center"}}>{qtdTotal}</span>
                      <button onClick={()=>setVarAberta(aberto?null:item.id)}
                        style={{padding:"7px 12px",borderRadius:20,border:"none",background:aberto?"#f0f0f0":"#7b1a0a",color:aberto?"#555":"#fff",fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>
                        {aberto ? "Fechar" : "Escolher"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={()=>naSimples&&chgQty(chaveItem(item),-1)} style={{width:30,height:30,borderRadius:"50%",border:"none",background:naSimples?"#fee2e2":"#f0f0f0",color:naSimples?"#ef4444":"#ccc",fontWeight:800,fontSize:18,cursor:naSimples?"pointer":"default"}}>−</button>
                      <span style={{fontWeight:800,fontSize:16,minWidth:20,textAlign:"center"}}>{qtdTotal}</span>
                      <button onClick={()=>addItem(item)} style={{width:30,height:30,borderRadius:"50%",border:"none",background:"#7b1a0a",color:"#fff",fontWeight:800,fontSize:18,cursor:"pointer"}}>+</button>
                    </>
                  )}
                </div>
              </div>

              {/* Escolha da carne */}
              {temVariacao && aberto && (
                <div style={{marginTop:10,paddingTop:10,borderTop:"1px dashed #e8e8e8",display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{fontSize:11,color:"#888",fontWeight:700,textTransform:"uppercase"}}>
                    {item.variacaoRotulo || "Escolha"}
                  </div>
                  {variacoes.map(v=>{
                    const linha = sc.itens.find(i=>i.id===item.id && i.variacao===v.nome);
                    const qtd = linha ? linha.qty||1 : 0;
                    return (
                      <div key={v.nome} style={{display:"flex",alignItems:"center",gap:8,background:qtd?"#fef0ed":"#faf9f8",borderRadius:10,padding:"7px 10px"}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:qtd?700:500,color:"#333"}}>{v.nome}</div>
                          <div style={{fontSize:12,color:"#7b1a0a",fontWeight:700}}>{fmtR(Number(v.preco)||0)}</div>
                        </div>
                        <button onClick={()=>qtd&&chgQty(chaveItem({id:item.id,variacao:v.nome}),-1)}
                          style={{width:28,height:28,borderRadius:"50%",border:"none",background:qtd?"#fee2e2":"#f0f0f0",color:qtd?"#ef4444":"#ccc",fontWeight:800,fontSize:16,cursor:qtd?"pointer":"default"}}>−</button>
                        <span style={{fontWeight:800,fontSize:15,minWidth:18,textAlign:"center"}}>{qtd}</span>
                        <button onClick={()=>addItem(item,v)}
                          style={{width:28,height:28,borderRadius:"50%",border:"none",background:"#7b1a0a",color:"#fff",fontWeight:800,fontSize:16,cursor:"pointer"}}>+</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{position:"sticky",bottom:0,padding:"10px 14px",background:"#fff",borderTop:"1px solid #f0f0f0"}}>
        <button onClick={()=>setTelaSalao("comanda")} style={BP2("linear-gradient(135deg,#7b1a0a,#c0392b)")}>✅ Ver comanda{sc.itens.length>0?` — ${fmtR(totMesa(sc.itens))}`:""}</button>
      </div>
    </div>
  );
  }

  // TELA FECHAR
  if(telaSalao==="fechar") {
    const fecharUma = mesa.subComandas.length > 1; // se há múltiplas, fecha só a ativa
    const subtotalFechar = fecharUma ? totalSCAtual : totalAcumulado;
    const desc = calcDesconto(subtotalFechar);
    const totalFechar = parseFloat((subtotalFechar - desc.valor).toFixed(2));
    const descontoInfo = { valor: desc.valor, tipo: desc.valor > 0 ? descModo : "", texto: desc.texto };
    const pagInfo = montarPagamentos(totalFechar);
    const pagOk = !pagDividido || (pagInfo.pagamentos.length > 0 && Math.abs(pagInfo.falta) <= 0.02);
    const pagTexto = descrevePagamento(pagInfo.pagamentos, pagSalao);
    const podeConfirmar = pagOk && !desc.erro && totalFechar > 0;
    const todosItensFechar = fecharUma
      ? [...(sc.rodadas||[]).flatMap(r=>r.itens),...sc.itens].reduce((acc,it)=>{const ex=acc.find(i=>chaveItem(i)===chaveItem(it));if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[])
      : (mesa.subComandas||[]).flatMap(s=>[...(s.rodadas||[]).flatMap(r=>r.itens),...s.itens]).reduce((acc,it)=>{const ex=acc.find(i=>chaveItem(i)===chaveItem(it));if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
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
        {/* Desconto */}
        <div style={card2}>
          <div style={{fontWeight:700,fontSize:12,color:"#888",marginBottom:10,textTransform:"uppercase"}}>🏷️ Desconto</div>
          <div style={{display:"flex",gap:6,marginBottom:descModo==="nenhum"?0:10}}>
            {[["nenhum","Sem"],["percentual","%"],["valor","R$"],["total","Cobrar"]].map(([k,l])=>(
              <button key={k} onClick={()=>{ setDescModo(k); setDescValor(""); }}
                style={{flex:1,padding:"8px 2px",borderRadius:10,border:`2px solid ${descModo===k?"#7b1a0a":"#e0e0e0"}`,background:descModo===k?"#fef0ed":"#fff",fontWeight:descModo===k?700:500,fontSize:12,cursor:"pointer",color:descModo===k?"#7b1a0a":"#555"}}>{l}</button>
            ))}
          </div>

          {descModo !== "nenhum" && (
            <>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input inputMode="decimal" value={descValor}
                  placeholder={descModo==="percentual" ? "10" : descModo==="valor" ? "0,00" : fmtR(subtotalFechar).replace("R$ ","")}
                  onChange={e=>setDescValor(descModo==="percentual" ? e.target.value.replace(/[^\d,.]/g,"") : mascaraMoeda(e.target.value))}
                  style={{flex:1,minWidth:0,padding:"10px 12px",border:"1.5px solid #e0e0e0",borderRadius:9,fontSize:16,outline:"none",boxSizing:"border-box",color:"#333"}} />
                {descModo === "percentual" && (
                  <div style={{display:"flex",gap:5}}>
                    {["5","10"].map(p=>(
                      <button key={p} onClick={()=>setDescValor(p)}
                        style={{background:"#f0f0f0",border:"none",borderRadius:8,padding:"10px 11px",fontSize:12,cursor:"pointer",color:"#555",fontWeight:700}}>{p}%</button>
                    ))}
                  </div>
                )}
                {descModo === "total" && (
                  <button onClick={()=>{
                    // Arredonda para baixo no multiplo de 5 mais proximo: 51 -> 50, 63 -> 60
                    const alvo = Math.floor(subtotalFechar / 5) * 5;
                    setDescValor(alvo > 0 ? mascaraMoeda(String(Math.round(alvo*100))) : "");
                  }} style={{background:"#f0f0f0",border:"none",borderRadius:8,padding:"10px 11px",fontSize:12,cursor:"pointer",color:"#555",fontWeight:700,whiteSpace:"nowrap"}}>↓ 5</button>
                )}
              </div>
              <div style={{fontSize:11,color:"#999",marginTop:6}}>
                {descModo==="percentual" ? "Percentual sobre o total da comanda"
                  : descModo==="valor" ? "Quanto tirar da conta"
                  : "Quanto o cliente vai pagar — o desconto sai da diferença"}
              </div>
            </>
          )}

          {desc.erro && (
            <div style={{marginTop:8,background:"#fee2e2",color:"#991b1b",borderRadius:9,padding:"8px 11px",fontSize:12,fontWeight:600}}>
              {desc.erro}
            </div>
          )}

          {desc.valor > 0 && !desc.erro && (
            <div style={{marginTop:10,paddingTop:10,borderTop:"1px dashed #f0f0f0",fontSize:13}}>
              <div style={{display:"flex",justifyContent:"space-between",color:"#666",padding:"2px 0"}}>
                <span>Subtotal</span><span>{fmtR(subtotalFechar)}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",color:"#10b981",fontWeight:700,padding:"2px 0"}}>
                <span>Desconto {desc.texto ? `(${desc.texto})` : ""}</span><span>− {fmtR(desc.valor)}</span>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:16,fontWeight:800,color:"#7b1a0a",paddingTop:6}}>
                <span>A pagar</span><span>{fmtR(totalFechar)}</span>
              </div>
            </div>
          )}
        </div>
        <div style={card2}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:12,color:"#888",textTransform:"uppercase"}}>💳 Pagamento</div>
            <button onClick={()=>{ setPagDividido(d=>!d); setValoresPag({pix:"",cartao:"",dinheiro:""}); }}
              style={{background:pagDividido?"#7b1a0a":"#f0f0f0",color:pagDividido?"#fff":"#666",border:"none",borderRadius:8,padding:"6px 11px",fontSize:11,fontWeight:700,cursor:"pointer"}}>
              {pagDividido ? "↩ Uma forma só" : "✂️ Dividir formas"}
            </button>
          </div>

          {!pagDividido ? (
            <div style={{display:"flex",gap:8}}>
              {FORMAS_PAG.map(([k,l])=>(
                <button key={k} onClick={()=>setPagSalao(k)} style={{flex:1,padding:"10px 4px",borderRadius:12,border:`2px solid ${pagSalao===k?"#7b1a0a":"#e0e0e0"}`,background:pagSalao===k?"#fef0ed":"#fff",fontWeight:pagSalao===k?700:500,fontSize:12,cursor:"pointer",color:pagSalao===k?"#7b1a0a":"#555"}}>{l}</button>
              ))}
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {FORMAS_PAG.map(([k,l])=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:96,fontSize:12,fontWeight:600,color:"#555",flexShrink:0}}>{l}</div>
                  <input inputMode="decimal" value={valoresPag[k]} placeholder="0,00"
                    onChange={e=>setValoresPag(v=>({...v,[k]:mascaraMoeda(e.target.value)}))}
                    style={{flex:1,minWidth:0,padding:"9px 10px",border:"1.5px solid #e0e0e0",borderRadius:9,fontSize:15,outline:"none",boxSizing:"border-box",color:"#333"}} />
                  <button onClick={()=>{
                    const outros = FORMAS_PAG.filter(([o])=>o!==k).reduce((acc,[o])=>acc+parseMoedaGlobal(valoresPag[o]),0);
                    const resto = Math.max(0, parseFloat((totalFechar-outros).toFixed(2)));
                    // Passa pela mascara para ficar igual ao que o usuario digita
                    setValoresPag(v=>({...v,[k]: resto>0 ? mascaraMoeda(String(Math.round(resto*100))) : ""}));
                  }} style={{background:"#f0f0f0",border:"none",borderRadius:8,padding:"9px 10px",fontSize:11,cursor:"pointer",color:"#555",fontWeight:700,flexShrink:0}}>resto</button>
                </div>
              ))}
              <div style={{
                marginTop:2,borderRadius:10,padding:"9px 12px",fontSize:13,fontWeight:700,textAlign:"center",
                background: pagOk ? "#d1fae5" : "#fef3c7",
                color: pagOk ? "#065f46" : "#92400e",
              }}>
                {pagOk ? `✅ Fecha certo — ${fmtR(totalFechar)}`
                  : pagInfo.falta > 0 ? `Falta lançar ${fmtR(pagInfo.falta)}`
                  : `Passou ${fmtR(Math.abs(pagInfo.falta))} do total`}
              </div>
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={async()=>{
            const nomeGarcom = garcomLogado?.nome||mesa.garcom||"—";
            const nomeCliente = fecharUma?sc.cliente:"";
            const abertura = fecharUma?(sc.abertura||mesa.abertura):mesa.abertura;

            // Se a impressora Bluetooth estiver conectada, usa ela direto
            const recibo = {
              mesa: mesa.id,
              cliente: nomeCliente,
              garcom: nomeGarcom,
              itens: todosItensFechar,
              subtotal: subtotalFechar,
              desconto: desc.valor,
              descontoInfo: desc.texto,
              total: totalFechar,
              pagamento: pagInfo.pagamentos.length === 1 ? pagInfo.pagamentos[0].tipo : "misto",
              pagamentoTexto: pagTexto,
              abertura: abertura,
              fechamento: new Date().toISOString(),
            };
            if (impressora.isDisponivel()) {
              try {
                await impressora.imprimirRecibo(recibo);
                msgSalao("✅ Comanda impressa!");
                return;
              } catch (e) {
                console.warn("Falha BT:", e.message);
                avisarSemTermica(e.message);
              }
            } else {
              try {
                await enfileirarImpressao("recibo", recibo);
                msgSalao("🖨️ Recibo enviado para a impressora do caixa");
                return;
              } catch (e) {
                avisarSemTermica(e.message);
              }
            }

            const win = abrirJanelaImpressao('width=400,height=600');
            if (!win) return;
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
              ${desc.valor > 0 ? `<div class="linha"><span>Subtotal</span><span>R$ ${subtotalFechar.toFixed(2)}</span></div>
              <div class="linha"><span>Desconto${desc.texto?' ('+desc.texto+')':''}</span><span>− R$ ${desc.valor.toFixed(2)}</span></div>` : ''}
              <div class="total"><span>TOTAL</span><span>R$ ${totalFechar.toFixed(2)}</span></div>
              <div class="info" style="margin-top:12px">Pagamento: ${pagTexto}</div>
              <div class="rodape">Obrigado pela visita! 🍢</div>
              <br><button onclick="window.print()">🖨️ Imprimir</button>
            </body></html>`);
            win.document.close();
            setTimeout(()=>win.print(),500);
          }} style={{background:T.grayLL,color:T.gray,border:`1px solid ${T.grayL}`,borderRadius:T.radiusS,padding:"12px 0",fontWeight:600,fontSize:14,cursor:"pointer",flex:1}}>🖨️ Imprimir</button>
          <button disabled={!podeConfirmar}
            onClick={()=>fecharUma?fecharComanda(scIdx,pagInfo.pagamentos,descontoInfo):fecharMesa(pagInfo.pagamentos,descontoInfo)}
            style={{...BP2(podeConfirmar?"linear-gradient(135deg,#065f46,#10b981)":"#ccc"),flex:2,cursor:podeConfirmar?"pointer":"not-allowed"}}>
            ✅ Confirmar — {fmtR(totalFechar)}
          </button>
        </div>
      </div>
    </div>
    );
  }

  // TELA COMANDA
  if(telaSalao==="comanda"&&mesa) {
    return (
      <div style={{background:T.cream,minHeight:"100%"}}>
        {toastSalao&&<div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:16,padding:"14px 28px",fontWeight:700,fontSize:15,zIndex:9999,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",minWidth:200,textAlign:"center",animation:"slideDown 0.3s ease"}}>{toastSalao.txt}</div>}
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
                {mesa.subComandas.length>1&&podeLancar&&(
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
            {podeLancar&&(
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
                    <button onClick={()=>chgQty(chaveItem(it),-1)} style={{width:26,height:26,borderRadius:"50%",border:"none",background:"#fee2e2",color:"#ef4444",fontWeight:800,fontSize:15,cursor:"pointer"}}>−</button>
                    <span style={{fontWeight:800,minWidth:18,textAlign:"center"}}>{it.qty||1}</span>
                    <button onClick={()=>chgQty(chaveItem(it),1)} style={{width:26,height:26,borderRadius:"50%",border:"none",background:"#d1fae5",color:"#10b981",fontWeight:800,fontSize:15,cursor:"pointer"}}>+</button>
                  </div>
                  <div style={{fontWeight:800,fontSize:13,color:"#7b1a0a",minWidth:50,textAlign:"right"}}>{fmtR((it.qty||1)*it.preco)}</div>
                </div>
              ))}
              {(sc.rodadas||[]).length>0&&<div style={{fontSize:11,color:"#aaa",marginTop:6}}>+ {fmtR((sc.rodadas||[]).reduce((s,r)=>s+totMesa(r.itens),0))} em {(sc.rodadas||[]).length} rodada{(sc.rodadas||[]).length>1?"s":""} anteriores</div>}
              <div style={{display:"flex",justifyContent:"space-between",paddingTop:8,fontSize:15,fontWeight:800,color:"#7b1a0a"}}><span>Total {sc.label}</span><span>{fmtR(totalSCAtual)}</span></div>
            </div>
          )}
          {(sc.rodadas||[]).length>0&&(
            <RodadasEditor rodadas={sc.rodadas} isDono={isDono} onSave={(novasRodadas) => {
              upd({...mesa, subComandas:mesa.subComandas.map((s,i)=>i===scIdx?{...s,rodadas:novasRodadas}:s)});
            }} />
          )}
          <div style={{...card2}}>
            <textarea value={mesa.obs||""} onChange={e=>upd({...mesa,obs:e.target.value})} placeholder="⚠️ Observações da mesa..." rows={2} style={{width:"100%",border:"none",outline:"none",fontSize:13,color:"#555",resize:"none",fontFamily:"inherit",background:"transparent",boxSizing:"border-box"}}/>
          </div>
        </div>

        <div style={{padding:"0 14px 16px",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",gap:8}}>
            {podeLancar&&<button onClick={()=>setTelaSalao("adicionar")} style={{...BP2("linear-gradient(135deg,#7b1a0a,#c0392b)",true)}}>🍢 Adicionar</button>}
            {podeLancar&&sc.itens.length>0&&(
              <button onClick={()=>{
                const rodada={hora:new Date().toISOString(),itens:[...sc.itens]};
                const novasRodadas=[...(sc.rodadas||[]),rodada];
                upd({...mesa, subComandas:mesa.subComandas.map((s,i)=>i===scIdx?{...s,itens:[],rodadas:novasRodadas}:s)});
                msgSalao(`🔥 ${sc.label} enviada à cozinha!`);
                imprimirCozinha(rodada, mesa.id, sc.label);
              }} style={{...BP2("linear-gradient(135deg,#1d4ed8,#2563eb)",true)}}>🔥 Cozinha</button>
            )}
          </div>
          {/* Botão enviar TODAS as comandas de uma vez — só aparece com 2+ comandas com itens pendentes */}
          {podeLancar&&mesa.subComandas.length>1&&mesa.subComandas.filter(s=>s.itens.length>0).length>1&&(
            <button onClick={()=>{
              let novasSCs = [...mesa.subComandas];
              msgSalao(`🔥 Todas as comandas enviadas à cozinha!`);
              mesa.subComandas.forEach((s,i)=>{
                if(s.itens.length===0) return;
                const rodada={hora:new Date().toISOString(),itens:[...s.itens]};
                novasSCs[i]={...novasSCs[i],itens:[],rodadas:[...(novasSCs[i].rodadas||[]),rodada]};
                imprimirCozinha(rodada, mesa.id, s.label);
              });
              upd({...mesa, subComandas:novasSCs});
            }} style={{...BP2("linear-gradient(135deg,#0e4fa8,#1d4ed8)"),display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
              🔥 Enviar todas à cozinha
            </button>
          )}
          {(perfil==="caixa"||isDono)?(
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {/* Botão imprimir comanda para conferência */}
              {totalAcumulado>0&&(
                <button onClick={async()=>{
                  const nomeGarcom = garcomLogado?.nome||mesa.garcom||"—";
                  const todosItens = (mesa.subComandas||[]).flatMap(s=>[...(s.rodadas||[]).flatMap(r=>r.itens),...s.itens])
                    .reduce((acc,it)=>{const ex=acc.find(i=>chaveItem(i)===chaveItem(it));if(ex)ex.qty+=(it.qty||1);else acc.push({...it,qty:it.qty||1});return acc;},[]);
                  const clienteNome = (mesa.subComandas||[]).map(s=>s.cliente).filter(Boolean).join(", ") || "—";

                  // Se a impressora Bluetooth estiver conectada, usa ela direto
                  const conta = {
                    mesa: mesa.id,
                    cliente: clienteNome,
                    garcom: nomeGarcom,
                    itens: todosItens,
                    total: totalAcumulado,
                    pagamento: null,
                    abertura: mesa.abertura,
                    fechamento: new Date().toISOString(),
                  };
                  if (impressora.isDisponivel()) {
                    try {
                      await impressora.imprimirRecibo(conta);
                      msgSalao("✅ Comanda impressa!");
                      return;
                    } catch (e) {
                      console.warn("Falha BT:", e.message);
                      avisarSemTermica(e.message);
                    }
                  } else {
                    try {
                      await enfileirarImpressao("recibo", conta);
                      msgSalao("🖨️ Conta enviada para a impressora do caixa");
                      return;
                    } catch (e) {
                      avisarSemTermica(e.message);
                    }
                  }

                  const win = abrirJanelaImpressao('width=400,height=650');
                  if (!win) return;
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
                  🖨️ Imprimir conta (caixa)
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
      {toastSalao&&<div style={{position:"fixed",top:20,left:"50%",transform:"translateX(-50%)",background:toastSalao.cor,color:"#fff",borderRadius:16,padding:"14px 28px",fontWeight:700,fontSize:15,zIndex:9999,boxShadow:"0 8px 32px rgba(0,0,0,0.3)",minWidth:200,textAlign:"center",animation:"slideDown 0.3s ease"}}>{toastSalao.txt}</div>}
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

      {/* MESAS ESPECIAIS — compactas, em linha */}
      {(()=>{
        const CORES_ESPECIAL = {
          funcionarios: {bg:"rgba(237,233,254,0.9)",border:"#7c3aed",text:"#5b21b6"},
          caixa_direto: {bg:"rgba(254,243,199,0.9)",border:"#d97706",text:"#92400e"},
        };
        const especiais = mesas.filter(m=>m.tipo);
        if(!especiais.length) return null;
        return (
          <div style={{display:"flex",gap:8,padding:"8px 14px 0"}}>
            {especiais.map(m=>{
              const cor = CORES_ESPECIAL[m.tipo]||{bg:"rgba(240,240,240,0.9)",border:"#aaa",text:"#555"};
              const totM = totMesaCompleta(m);
              const s = STATUS_MESA[m.status];
              const ativo = m.status!=="livre";
              return(
                <button key={m.id} onClick={()=>{setSel(m.id);setSelSC(0);setTelaSalao("comanda");}} style={{
                  flex:1, display:"flex", alignItems:"center", gap:8,
                  padding:"8px 12px", borderRadius:12, cursor:"pointer",
                  border:`1.5px solid ${ativo?s.c:cor.border}`,
                  background:ativo?s.bg:cor.bg,
                  boxShadow:ativo?`0 0 0 2px ${s.c}30`:"none",
                  position:"relative"
                }}>
                  {(m.status==="chamando"||m.status==="conta")&&<div style={{position:"absolute",top:-5,right:-5,width:14,height:14,background:s.c,borderRadius:"50%",fontSize:8,color:"#fff",fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>!</div>}
                  <span style={{fontSize:16}}>{m.icon}</span>
                  <div style={{textAlign:"left",flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:12,color:ativo?s.c:cor.text,whiteSpace:"nowrap"}}>{m.nome}</div>
                    <div style={{fontSize:10,color:ativo?s.c:cor.text,opacity:0.75}}>
                      {ativo?`${fmtR(totM)}${m.abertura?" · ⏱️"+tempoAberto(m.abertura):""}` : "Livre"}
                    </div>
                  </div>
                </button>
              );
            })}
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
  const [msgQR, setMsgQR] = useState(null);

  async function carregarStatus() {
    try {
      const r = await authFetch(backendUrl +"/health");
      const d = await r.json();
      setStatus(d);
    } catch {}
  }

  // O backend so guarda o QR enquanto a conexao esta viva. Entre uma tentativa
  // e outra ele fica nulo — e a tela ficava vazia sem explicar nada.
  async function buscarQR() {
    try {
      const r = await authFetch(backendUrl + "/whatsapp/qr");
      if (!r.ok) return null;
      const d = await r.json();
      return d.qr || null;
    } catch { return null; }
  }

  async function carregarQR() {
    setLoading(true); setMsgQR(null);
    const qr = await buscarQR();
    setLoading(false);
    if (qr) setQrCode(qr);
    else await gerarNovoQR();   // nao tinha QR guardado: pede um novo
  }

  // Forca uma conexao nova. Depois de 10 tentativas sem ninguem escanear, o
  // Baileys desistia e o QR so voltava reiniciando o servidor.
  async function gerarNovoQR() {
    setLoading(true); setQrCode(null); setMsgQR("Gerando QR Code, aguarde...");
    try {
      const r = await authFetch(backendUrl + "/whatsapp/reconectar", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 404 = servidor ainda sem a rota, ou seja, backend nao atualizado
        setMsgQR(d.erro || (r.status === 404
          ? "O servidor ainda esta na versao antiga. Rode o deploy no backend."
          : "Nao foi possivel gerar o QR Code (erro " + r.status + ")."));
        setLoading(false); return;
      }
    } catch {
      setMsgQR("Erro de conexao com o servidor."); setLoading(false); return;
    }
    // O QR leva alguns segundos para nascer — consulta ate aparecer
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const qr = await buscarQR();
      if (qr) { setQrCode(qr); setMsgQR(null); setLoading(false); carregarStatus(); return; }
    }
    setMsgQR("O QR Code nao apareceu. Tente de novo em alguns segundos.");
    setLoading(false);
  }

  async function desconectar() {
    if (!window.confirm("Desconectar o WhatsApp atual? Você precisará escanear o QR Code de novo para reconectar.")) return;
    setDesconectando(true);
    try {
      const r = await authFetch(backendUrl +"/whatsapp/logout", { method: "POST" });
      if (!r.ok) {
        const erro = await r.json().catch(()=>({erro:"Erro desconhecido"}));
        alert("Erro ao desconectar: " + (erro.erro || "tente novamente"));
        setDesconectando(false);
        return;
      }
      setQrCode(null);
      setStatus(null);
      setTimeout(carregarStatus, 3000);
    } catch (e) {
      alert("Erro ao desconectar: " + (e.message || "verifique a conexão"));
    }
    setDesconectando(false);
  }

  // ⚠️ Era useState (bug) — trocado para useEffect com polling de status a cada 10s
  useEffect(() => {
    carregarStatus();
    const t = setInterval(carregarStatus, 10000);
    return () => clearInterval(t);
  }, []);

  // Conectado = status real do backend (status.whatsapp === "connected")
  // Não usa "conexao" (que se refere à conexão com o backend, não com o WhatsApp)
  const conectado = status?.whatsapp === "connected";
  const esperandoQR = status?.whatsapp === "qr";

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
              {conectado ? "WhatsApp Conectado" : esperandoQR ? "Aguardando pareamento" : "WhatsApp Desconectado"}
            </div>
            <div style={{ fontSize: 13, color: T.gray, marginTop: 3 }}>
              {conectado ? "Bot respondendo normalmente" : esperandoQR ? "QR Code disponível — escaneie no WhatsApp" : "Carregando status..."}
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
              <button onClick={gerarNovoQR} disabled={loading} style={{ marginTop: 12, background: T.grayLL, border: `1px solid ${T.grayL}`, color: T.gray, borderRadius: T.radiusS, padding: "8px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
                {loading ? "⏳ Gerando..." : "🔄 Gerar novo QR Code"}
              </button>
            </>
          ) : (
            <>
              <button onClick={carregarQR} disabled={loading} style={{ background: `linear-gradient(135deg,${T.wineD},${T.wine})`, color: T.white, border: "none", borderRadius: T.radius, padding: "14px 28px", fontWeight: 700, fontSize: 15, cursor: "pointer", opacity: loading ? 0.7 : 1 }}>
                {loading ? "⏳ Gerando QR Code..." : "📱 Mostrar QR Code"}
              </button>
              {msgQR && <div style={{ fontSize: 12, color: T.gray, marginTop: 12, lineHeight: 1.5 }}>{msgQR}</div>}
            </>
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
  const [maisAberto, setMaisAberto] = useState(false);
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
  // Pedidos sendo editados — polling não deve sobrescrevê-los
  const pedidosEditando = useRef(new Set());
  const actx = useRef(null);

  const tocarSom = useCallback(() => {
    try {
      const somAtivo = localStorage.getItem("imperio_som_pedido") !== "off";
      if (!somAtivo) return;
      if (!actx.current) actx.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = actx.current;
      // Som de "campainha" — toca 3 vezes uma sequência de 2 notas (mais perceptível)
      const tocarNota = (freq, start, dur, vol = 0.35) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(vol, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
      };
      // 3 ciclos de "ding-dong" (880Hz → 660Hz)
      for (let i = 0; i < 3; i++) {
        const offset = i * 0.6;
        tocarNota(880, offset, 0.25);
        tocarNota(660, offset + 0.25, 0.35);
      }
    } catch (e) { console.warn("Som falhou:", e); }
  }, []);

  // Notificação push do navegador
  const notificarPush = useCallback((pedido) => {
    try {
      const notifAtivo = localStorage.getItem("imperio_notif_push") !== "off";
      if (!notifAtivo) return;
      if (!("Notification" in window)) return;
      if (Notification.permission !== "granted") return;
      const total = totalPedido(pedido, Number(config?.taxaEntrega) || TAXA_ENTREGA_PADRAO);
      const corpo = `${pedido.cliente || "Cliente"} — R$ ${total.toFixed(2)}\n📍 ${pedido.endereco || ""}`;
      const n = new Notification(`🔔 Novo pedido #${pedido.id}`, {
        body: corpo,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: `pedido-${pedido.id}`,
        requireInteraction: false,
        silent: false,
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 12000);
    } catch (e) { console.warn("Notificação falhou:", e); }
  }, [config?.taxaEntrega]); // sem essa dep, capturava a taxa inicial (stale closure)

  // Solicita permissão de notificação ao carregar (silenciosamente falha se navegador não suporta)
  useEffect(() => {
    try {
      if (!("Notification" in window)) return;
      if (typeof Notification.requestPermission !== "function") return;
      if (Notification.permission !== "default") return;
      Notification.requestPermission().catch(() => {});
    } catch {}
  }, []);

  // Sincroniza o historico do salao com o servidor (fonte da verdade).
  // O localStorage passa a ser apenas cache offline/otimista.
  const sincronizarSalao = useCallback(async () => {
    try {
      const r = await authFetch(BACKEND_URL + "/vendas-salao");
      if (!r.ok) return;
      const vendasServidor = await r.json();
      if (!Array.isArray(vendasServidor)) return;
      setHistoricoSalao(prev => {
        // Mantem vendas locais que ainda nao chegaram no servidor (POST falhou/offline)
        const idsServidor = new Set(vendasServidor.map(v => String(v._id)));
        const pendentesLocais = prev.filter(v => !v._id || !idsServidor.has(String(v._id)));
        return [...vendasServidor, ...pendentesLocais];
      });
      const totalServidor = vendasServidor.reduce((s, v) => s + (Number(v.total) || 0), 0);
      setFaturadoSalao(totalServidor);
    } catch (e) { console.warn("Falha ao sincronizar vendas do salao:", e.message); }
  }, []);

  useEffect(() => {
    sincronizarSalao();
    const t = setInterval(sincronizarSalao, 60000); // 1min: vendas nao mudam tao rapido
    return () => clearInterval(t);
  }, [sincronizarSalao]);

  // Reconexão automática da impressora Bluetooth
  // - Tenta 1x ao carregar (após 1.5s)
  // - Tenta a cada 30s enquanto estiver desconectada (e tem dispositivo salvo)
  // - O bluetoothPrinter.js também reage a visibilitychange/focus internamente
  useEffect(() => {
    if (!impressora.isSupported() || !impressora.temDispositivoSalvo()) return;

    let cancelado = false;
    const tentar = () => {
      if (cancelado) return;
      if (impressora.isConnected()) return;
      impressora.reconectarAuto().then(r => {
        if (!cancelado && r?.conectada) console.log("🖨️ Impressora reconectada:", r.nome);
      }).catch(() => {});
    };

    // Primeira tentativa rápida (1.5s)
    const t1 = setTimeout(tentar, 1500);
    // Tentativas periódicas a cada 30s
    const interval = setInterval(tentar, 30000);

    return () => { cancelado = true; clearTimeout(t1); clearInterval(interval); };
  }, []);

  // ── ESTAÇÃO DE IMPRESSÃO ────────────────────────────────────
  // A térmica é Bluetooth e aceita um aparelho por vez — na prática fica no
  // caixa. O garçom não alcança ela, então enfileira no servidor e ESTE
  // aparelho (o que tem a impressora) puxa a fila e imprime.
  useEffect(() => {
    let parar = false;
    let rodando = false;   // impede dois ciclos sobrepostos numa impressão lenta

    async function ciclo() {
      if (parar || rodando) return;
      if (!estacaoLigada() || !impressora.isDisponivel()) return;
      rodando = true;
      try {
        const r = await authFetch(BACKEND_URL + "/impressao/reservar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limite: 5 }),
        });
        if (r.ok) {
          const { jobs = [] } = await r.json();
          for (const job of jobs) {
            if (parar) break;
            let ok = false, erro = null;
            try {
              if (job.tipo === "cozinha") await impressora.imprimirComanda(job.dados);
              else if (job.tipo === "recibo") await impressora.imprimirRecibo(job.dados);
              else if (job.tipo === "delivery") await impressora.imprimirPedidoDelivery(job.dados);
              else throw new Error("tipo desconhecido: " + job.tipo);
              ok = true;
            } catch (e) {
              erro = e.message || "falha ao imprimir";
              console.warn("Estacao: falha no job", job.id, erro);
            }
            // Marca o resultado mesmo em erro: o servidor devolve para a fila
            // enquanto houver tentativa sobrando.
            await authFetch(BACKEND_URL + "/impressao/" + job.id + "/concluir", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ok, erro }),
            }).catch(() => {});
          }
        }
      } catch { /* servidor fora: tenta no proximo ciclo */ }
      rodando = false;
    }

    const t = setInterval(ciclo, 4000);
    const t1 = setTimeout(ciclo, 2000);
    return () => { parar = true; clearInterval(t); clearTimeout(t1); };
  }, []);

  // Mantém a tela do celular acesa (Wake Lock API)
  // Impede o sistema de suspender a aba, o que mantém Bluetooth e WhatsApp polling vivos
  useEffect(() => {
    impressora.manterAtivo(true).catch(()=>{});
    // Reativa quando a aba volta a ficar visível (Wake Lock libera ao trocar de aba)
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        impressora.manterAtivo(true).catch(()=>{});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      impressora.manterAtivo(false).catch(()=>{});
    };
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [rp, rc, rcu, ra, rcfg, rs, rg] = await Promise.all([
        authFetch(BACKEND_URL + "/pedidos"),
        authFetch(BACKEND_URL + "/cardapio"),
        authFetch(BACKEND_URL + "/cupons"),
        authFetch(BACKEND_URL + "/avaliacoes"),
        authFetch(BACKEND_URL + "/config"),
        authFetch(BACKEND_URL + "/config/status-loja"),
        authFetch(BACKEND_URL + "/garcons"),
      ]);
      if (rp.ok) {
        const data = await rp.json();
        const ids = new Set(data.map(p => p.id));
        const novos = [...ids].filter(id => !ant.current.has(id));
        if (novos.length > 0 && ant.current.size > 0) {
          setExpanded(novos[0]);
          tocarSom();
          // Notificação push para cada pedido novo (limite de 3 simultâneos)
          novos.slice(0, 3).forEach(id => {
            const pedido = data.find(p => p.id === id);
            if (pedido && pedido.status === "novo") notificarPush(pedido);
          });
          // Impressão automática (configurável em Config → Impressora)
          const autoImprimir = localStorage.getItem("imperio_auto_imprimir_delivery") === "on";
          if (autoImprimir && impressora.isDisponivel()) {
            for (const id of novos) {
              const pedido = data.find(p => p.id === id);
              if (pedido && pedido.status === "novo") {
                impressora.imprimirPedidoDelivery(pedido).catch(e => console.warn("Erro auto-print:", e.message));
              }
            }
          }
        }
        ant.current = ids;
        // Não sobrescreve pedidos que estão sendo editados localmente
        setPedidos(prev => {
          if (pedidosEditando.current.size === 0) return data;
          return data.map(pNovo => {
            if (pedidosEditando.current.has(pNovo.id)) {
              const pLocal = prev.find(p => p.id === pNovo.id);
              return pLocal || pNovo;
            }
            return pNovo;
          });
        });
      }
      if (rc.ok) setCardapio(await rc.json());
      if (rcu.ok) setCupons(await rcu.json());
      if (ra.ok) setAvaliacoes(await ra.json());
      if (rcfg.ok) setConfig(await rcfg.json());
      if (rs.ok) setStatusLoja(await rs.json());
      if (rg.ok) setGarcons(await rg.json());
      setConexao("online"); setUltimaAtt(new Date());
    } catch { setConexao("offline"); }
  }, [tocarSom, notificarPush]);

  useEffect(() => { fetchAll(); const t = setInterval(fetchAll, POLLING_INTERVAL); return () => clearInterval(t); }, [fetchAll]);
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 30000); return () => clearInterval(t); }, []);

  // Persiste dados do salão no localStorage
  useEffect(() => { try { localStorage.setItem("imperio_faturado_salao", String(faturadoSalao)); } catch {} }, [faturadoSalao]);
  useEffect(() => { try { localStorage.setItem("imperio_historico_salao", JSON.stringify(historicoSalao)); localStorage.setItem("imperio_historico_dia", new Date().toDateString()); } catch {} }, [historicoSalao]);
  useEffect(() => { try { localStorage.setItem("imperio_mesas_salao", JSON.stringify(mesasSalao)); } catch {} }, [mesasSalao]);

  const updateStatus = async (id, novoStatus) => {
    setAtualizando(prev => ({ ...prev, [id]: true }));
    try {
      const r = await authFetch(BACKEND_URL + "/pedidos/" + id + "/status", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: novoStatus }) });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert("❌ Erro ao atualizar status: " + (err.erro || `código ${r.status}`));
        return;
      }
      const at = await r.json();
      setPedidos(prev => prev.map(p => p.id === id ? { ...p, status: at.status } : p));
    } catch {
      alert("❌ Erro de conexão ao atualizar status. Tente novamente.");
    } finally {
      setAtualizando(prev => ({ ...prev, [id]: false }));
    }
  };

  const editPedido = async (id, itens, obs) => {
    setAtualizando(prev => ({ ...prev, [id]: true }));
    pedidosEditando.current.add(id);
    try {
      const r = await authFetch(BACKEND_URL + "/pedidos/" + id, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itens, obs }),
      });
      if (!r.ok) { const err = await r.json().catch(() => ({})); alert("❌ " + (err.erro || "Erro ao editar pedido")); return; }
      const at = await r.json();
      setPedidos(prev => prev.map(p => p.id === id ? at : p));
    } catch { alert("❌ Erro de conexão ao editar pedido"); }
    finally {
      setAtualizando(prev => ({ ...prev, [id]: false }));
      pedidosEditando.current.delete(id);
    }
  };

  const saveConfig = async (novoCfg) => {
    try {
      const r = await authFetch(BACKEND_URL + "/config", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(novoCfg),
      });
      if (!r.ok) { console.error("Falha ao salvar config:", r.status); return false; }
      // Usa o que o servidor devolveu (ja validado/saneado), nao o otimista
      const salvo = await r.json().catch(() => novoCfg);
      setConfig(salvo);
      const rs = await authFetch(BACKEND_URL + "/config/status-loja");
      if (rs.ok) setStatusLoja(await rs.json());
      return true;
    } catch (e) {
      console.error("Erro de rede ao salvar config:", e.message);
      return false;
    }
  };

  // Taxa vigente vinda da config do servidor (nao mais o 5 hardcoded)
  const taxaEntrega = Number(config?.taxaEntrega);
  const taxaEntregaOk = Number.isFinite(taxaEntrega) ? taxaEntrega : TAXA_ENTREGA_PADRAO;

  const counts = Object.keys(STATUS_CONFIG).reduce((a, s) => { a[s] = pedidos.filter(p => p.status === s).length; return a; }, {});
  const totalDeliveryHoje = pedidos.filter(p => p.status === "entregue" && isMesmosDias(p.horario, new Date())).reduce((s, p) => s + totalPedido(p, taxaEntregaOk), 0);
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
    ["fechamento", "🔒", "Fechamento"],
    ["estoque",    "📦", "Estoque"],
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
      {!abrirSalao && <div className="header-desktop" style={{ background: "rgba(255,255,255,0.94)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: `1px solid ${T.grayL}`, color: T.dark, padding: "0 32px", position: "sticky", top: 0, zIndex: 20, height: 72 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1400, margin: "0 auto", width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 12, background: `linear-gradient(135deg,${T.wineD},${T.wine})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, boxShadow: `0 4px 12px ${T.wine}30` }}>👑</div>
              <div>
                <div style={{ fontSize: 10, color: T.gray, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>Painel do Dono</div>
                <div className="serif-title" style={{ fontWeight: 700, fontSize: 19, color: T.dark, lineHeight: 1.1 }}>Império dos Espetos</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                <div key={k} style={{ background: counts[k] > 0 ? c.bg : T.grayLL, borderRadius: 10, padding: "6px 12px", border: `1px solid ${counts[k] > 0 ? c.color+"30" : T.grayL}`, cursor: "pointer", transition: "all 0.15s" }} onClick={() => { setAba("pedidos"); setFiltro(k); }}>
                  <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1, textAlign: "center", color: counts[k] > 0 ? c.color : T.gray }}>{counts[k] || 0}</div>
                  <div style={{ fontSize: 10, color: counts[k] > 0 ? c.color : T.gray, marginTop: 2, fontWeight: 500 }}>{c.icon} {c.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: T.gray, textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600 }}>Faturamento hoje</div>
              <div className="serif-title" style={{ fontWeight: 700, fontSize: 24, color: T.wine, lineHeight: 1.1 }}>R$ {totalHoje.toFixed(2)}</div>
              <div style={{ fontSize: 10, color: T.gray, marginTop: 3 }}>🛵 R$ {totalDeliveryHoje.toFixed(2)} · 🍽️ R$ {totalSalaoHoje.toFixed(2)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <span style={{ background: statusLoja.aberto ? T.greenL : T.redL, color: statusLoja.aberto ? T.green : T.red, borderRadius: 20, padding: "3px 12px", fontWeight: 600, fontSize: 11, border: `1px solid ${statusLoja.aberto ? T.green+"30" : T.red+"30"}` }}>
                {statusLoja.aberto ? "● Aberto" : "● Fechado"}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: T.gray }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: cc.cor }} />
                  {cc.txt}
                </span>
                <button onClick={fetchAll} title="Atualizar" style={{ background: T.grayLL, border: `1px solid ${T.grayL}`, color: T.gray, cursor: "pointer", fontSize: 13, padding: "4px 8px", borderRadius: 8 }}>↻</button>
                {onSair && <button onClick={onSair} title="Sair" style={{ background: T.wineL, border: `1px solid ${T.wine}30`, color: T.wine, cursor: "pointer", fontSize: 12, padding: "4px 8px", borderRadius: 8, fontWeight: 600 }}>🔒</button>}
              </div>
            </div>
          </div>
        </div>
      </div>}

      {/* HEADER MOBILE — compacto, oculta para garçom/caixa */}
      {!abrirSalao && <div className="header-mobile" style={{ background: "rgba(255,255,255,0.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderBottom: `1px solid ${T.grayL}`, padding: "12px 18px", position: "sticky", top: 0, zIndex: 20, display: "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: `linear-gradient(135deg,${T.wineD},${T.wine})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, boxShadow: `0 2px 8px ${T.wine}30` }}>👑</div>
            <div>
              <div className="serif-title" style={{ fontWeight: 700, fontSize: 15, color: T.dark, lineHeight: 1.1 }}>Império dos Espetos</div>
              <div style={{ fontSize: 10, color: T.gray, marginTop: 2, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: cc.cor, display: "inline-block" }} />
                {statusLoja.aberto ? "Aberto agora" : "Fechado"}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: T.gray, textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600 }}>Hoje</div>
              <div className="serif-title" style={{ fontWeight: 700, fontSize: 18, color: T.wine, lineHeight: 1 }}>R$ {totalHoje.toFixed(2)}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={fetchAll} title="Atualizar" style={{ background: T.grayLL, border: `1px solid ${T.grayL}`, color: T.gray, cursor: "pointer", fontSize: 14, padding: "6px 10px", borderRadius: 10 }}>↻</button>
              {onSair && <button onClick={onSair} title="Sair" style={{ background: T.wineL, border: `1px solid ${T.wine}30`, color: T.wine, cursor: "pointer", fontSize: 13, padding: "6px 10px", borderRadius: 10, fontWeight: 600 }}>🔒</button>}
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
            <div className="pedidos-grid" style={{ padding: "20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
              {pf.length === 0
                ? <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "100px 20px", color: T.gray }}>
                    <div style={{ fontSize: 64, marginBottom: 16, opacity: 0.25 }}>🍢</div>
                    <div className="serif-title" style={{ fontSize: 22, color: T.dark, fontWeight: 700, marginBottom: 6 }}>Nenhum pedido por aqui</div>
                    <div style={{ fontSize: 14, color: T.gray }}>{filtro === "todos" ? "Os pedidos aparecerão aqui assim que chegarem pelo WhatsApp" : `Nenhum pedido com status "${STATUS_CONFIG[filtro]?.label || filtro}"`}</div>
                  </div>
                : pf.map(p => <PedidoCard key={p.id} pedido={p} expanded={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)} onStatus={updateStatus} onEdit={editPedido} cardapio={cardapio} taxaEntrega={taxaEntregaOk} atualizando={!!atualizando[p.id]} />)
              }
            </div>
          )}

          {aba === "relatorios"  && <Relatorios pedidos={pedidos} taxaEntrega={taxaEntregaOk} faturadoSalao={faturadoSalao} mesasSalao={mesasSalao} setMesasSalaoRel={setMesasSalao} historicoSalao={historicoSalao} setHistoricoSalao={setHistoricoSalao} setFaturadoSalaoRel={setFaturadoSalao} />}
          {aba === "fechamento"  && <FechamentoDia backendUrl={BACKEND_URL} pedidos={pedidos} historicoSalao={historicoSalao} faturadoSalao={faturadoSalao} mesasSalao={mesasSalao} />}
          {aba === "estoque"     && <Estoque backendUrl={BACKEND_URL} cardapio={cardapio} />}
          {aba === "clientes"    && <Clientes pedidos={pedidos} taxaEntrega={taxaEntregaOk} />}
          {aba === "cardapio"    && <Cardapio cardapio={cardapio} onReload={fetchAll} />}
          {aba === "cupons"      && <Cupons cupons={cupons} onReload={fetchAll} />}
          {aba === "fidelidade"  && <Fidelidade pedidos={pedidos} config={config} />}
          {aba === "avaliacoes"  && <Avaliacoes avaliacoes={avaliacoes} />}
          {aba === "salao"       && <SalaoIntegrado cardapio={cardapio} config={config} perfilSalao={abrirSalao ? perfilSalao : (perfilSalao || "caixa")} setPerfilSalao={setPerfilSalao} mesasSalao={mesasSalao} setMesasSalao={setMesasSalao} faturadoSalao={faturadoSalao} setFaturadoSalao={setFaturadoSalao} selSalao={selSalao} setSelSalao={setSelSalao} telaSalaoGlobal={telaSalao} setTelaSalaoGlobal={setTelaSalaoGlobal} isDono={!abrirSalao} historicoSalao={historicoSalao} setHistoricoSalao={setHistoricoSalao} onSairApp={onSair} garcomLogado={garcomLogado} />}
          {aba === "whatsapp"   && <WhatsAppConexao conexao={conexao} backendUrl={BACKEND_URL} />}
          {aba === "config"      && <Configuracoes config={config} onSave={saveConfig} statusLoja={statusLoja} garcons={garcons} onReloadGarcons={fetchAll} />}
        </div>
      </div>

      {/* BARRA INFERIOR MOBILE — oculta para garçom/caixa */}
      {!abrirSalao && <div className="mobile-nav" style={{ display: "none" }}>

        {/* Drawer "Mais" — abre por cima da barra */}
        {maisAberto && (
          <>
            <div onClick={()=>setMaisAberto(false)} style={{ position:"fixed", inset:0, zIndex:48, background:"rgba(0,0,0,0.3)" }}/>
            <div style={{ position:"fixed", bottom:56, left:0, right:0, zIndex:49, background:T.white, borderRadius:"20px 20px 0 0", boxShadow:"0 -4px 24px rgba(0,0,0,0.15)", padding:"8px 8px 4px" }}>
              <div style={{ width:36, height:4, background:T.grayL, borderRadius:2, margin:"0 auto 12px" }}/>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:4, padding:"0 4px 8px" }}>
                {[
                  ["fechamento", "🔒", "Fechamento"],
                  ["clientes",   "👥", "Clientes"],
                  ["cardapio",   "🍢", "Cardápio"],
                  ["cupons",     "🎟️", "Cupons"],
                  ["fidelidade", "🏆", "Fidelid."],
                  ["avaliacoes", "⭐", "Aval."],
                  ["whatsapp",   "📱", "WhatsApp"],
                  ["config",     "⚙️", "Config"],
                ].map(([k, icon, label]) => (
                  <button key={k} onClick={()=>{ setAba(k); setMaisAberto(false); }} style={{
                    padding:"10px 4px 8px", border:"none", cursor:"pointer",
                    borderRadius:12, display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                    background: aba===k ? T.wineL : T.grayLL,
                    color: aba===k ? T.wine : T.gray,
                  }}>
                    <span style={{ fontSize:22 }}>{icon}</span>
                    <span style={{ fontSize:10, fontWeight: aba===k ? 700 : 400 }}>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Barra fixa com 5 abas principais + Mais */}
        <div style={{ position:"fixed", bottom:0, left:0, right:0, background:T.white, borderTop:`1px solid ${T.grayL}`, display:"flex", zIndex:50, boxShadow:"0 -4px 20px rgba(28,25,23,0.08)", paddingBottom:"env(safe-area-inset-bottom)" }}>
          {[
            ["pedidos",    "📋", "Pedidos"],
            ["salao",      "🍽️", "Salão"],
            ["relatorios", "📊", "Rel."],
          ].map(([k, icon, label]) => (
            <button key={k} onClick={() => { setAba(k); setMaisAberto(false); }} style={{ flex:1, padding:"8px 2px 10px", border:"none", background:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, color: aba===k ? T.wine : T.gray, position:"relative", transition:"color 0.15s" }}>
              <span style={{ fontSize: aba===k ? 21 : 19 }}>{icon}</span>
              <span style={{ fontSize:9, fontWeight: aba===k ? 700 : 400, whiteSpace:"nowrap" }}>{label}</span>
              {aba===k && <div style={{ position:"absolute", top:0, left:"20%", right:"20%", height:2, background:T.wine, borderRadius:"0 0 4px 4px" }}/>}
              {k==="pedidos" && novos>0 && <span style={{ position:"absolute", top:5, right:"18%", background:T.amber, color:T.white, borderRadius:10, padding:"0 4px", fontSize:9, fontWeight:800, minWidth:14, textAlign:"center" }}>{novos}</span>}
              {k==="salao" && mesasPendentes>0 && <span style={{ position:"absolute", top:5, right:"18%", background:T.purple, color:T.white, borderRadius:10, padding:"0 4px", fontSize:9, fontWeight:800, minWidth:14, textAlign:"center" }}>{mesasPendentes}</span>}
            </button>
          ))}

          {/* Aba Estoque como 4ª fixa */}
          <button onClick={()=>{ setAba("estoque"); setMaisAberto(false); }} style={{ flex:1, padding:"8px 2px 10px", border:"none", background:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, color: aba==="estoque" ? T.wine : T.gray, position:"relative" }}>
            <span style={{ fontSize: aba==="estoque" ? 21 : 19 }}>📦</span>
            <span style={{ fontSize:9, fontWeight: aba==="estoque" ? 700 : 400 }}>Estoque</span>
            {aba==="estoque" && <div style={{ position:"absolute", top:0, left:"20%", right:"20%", height:2, background:T.wine, borderRadius:"0 0 4px 4px" }}/>}
          </button>

          {/* Botão Mais */}
          <button onClick={()=>setMaisAberto(p=>!p)} style={{ flex:1, padding:"8px 2px 10px", border:"none", background:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, color: maisAberto ? T.wine : T.gray, position:"relative" }}>
            <span style={{ fontSize:19 }}>⋯</span>
            <span style={{ fontSize:9, fontWeight: maisAberto ? 700 : 400 }}>Mais</span>
            {/* Badge se aba atual está no menu "mais" */}
            {["clientes","cardapio","cupons","fidelidade","avaliacoes","whatsapp","config"].includes(aba) && (
              <div style={{ position:"absolute", top:0, left:"20%", right:"20%", height:2, background:T.wine, borderRadius:"0 0 4px 4px" }}/>
            )}
          </button>
        </div>
      </div>}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap');

        /* ── TIPOGRAFIA GLOBAL ── */
        body, button, input, select, textarea {
          font-family: 'DM Sans', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          letter-spacing: -0.01em;
        }
        .serif-title {
          font-family: 'Playfair Display', Georgia, serif !important;
          letter-spacing: -0.02em;
          font-weight: 700;
        }

        /* ── ANIMAÇÕES GLOBAIS ── */
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
        @keyframes slideDown { from { opacity: 0; transform: translateX(-50%) translateY(-20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }

        .fade-in { animation: fadeIn 0.3s ease-out; }

        /* ── MICROINTERAÇÕES ── */
        button {
          transition: all 0.15s ease;
          -webkit-tap-highlight-color: transparent;
        }
        button:active:not(:disabled) {
          transform: scale(0.97);
          transition: transform 0.05s ease;
        }

        /* Cards com hover sutil em desktop */
        @media (hover: hover) {
          .card-hover:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(28,25,23,0.10);
          }
        }

        /* ── SCROLLBAR DELICADA ── */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(139,38,53,0.12); border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(139,38,53,0.25); }

        /* ── INPUTS REFINADOS ── */
        input, select, textarea {
          min-height: 40px;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: #8B2635 !important;
          box-shadow: 0 0 0 3px rgba(139,38,53,0.08);
        }
        textarea { min-height: 60px; }

        * { box-sizing: border-box; }

        /* ── MOBILE ── */
        @media (max-width: 768px) {
          .header-desktop { display: none !important; }
          .header-mobile { display: block !important; }
          .sidebar-desktop { display: none !important; }
          .mobile-nav { display: block !important; }
          .main-content { padding-bottom: 72px !important; }
          input, select, textarea { font-size: 16px !important; }
          .pedidos-grid { padding: 12px !important; grid-template-columns: 1fr !important; gap: 10px !important; }
          button { min-height: 38px; }
          body, #root { overflow-x: hidden; max-width: 100vw; }
        }
        @media (min-width: 769px) {
          .header-mobile { display: none !important; }
          .mobile-nav { display: none !important; }
        }

        /* ── MOBILE NAV: glassmorphism iOS-like ── */
        .mobile-nav > div:last-child {
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          background: rgba(255,255,255,0.85) !important;
        }
      `}</style>
    </div>
  );
}
