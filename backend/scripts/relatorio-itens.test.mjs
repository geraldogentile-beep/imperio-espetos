// Relatório item por item (Rel. → Itens): vendido no salão e no delivery,
// equipe, perdas e total, por dia, semana, mês ou ano.
//   MONGO_URI=<banco do servidor> TESTE_URL=http://localhost:3000 node scripts/relatorio-itens.test.mjs   (dentro de backend/)
// Banco de teste LIMPO.

import "dotenv/config";
import mongoose from "mongoose";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const login = async (pin) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) })).json()).token;
const token = await login(process.env.TESTE_PIN || "9999");
const tokenGarcom = await login(process.env.TESTE_PIN_GARCOM || "5678");
const api = async (metodo, rota, corpo, tk = token) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const alcatra = (q) => ({ id: 1, nome: "Alcatra", qty: q, preco: 9, categoria: "Tradicionais" });
const cerveja = (q) => ({ id: 3001, nome: "Heineken Long Neck", qty: q, preco: 12, categoria: "Cervejas" });
const venda = (itens) => api("POST", "/vendas-salao", { mesa: 3, itens, subtotal: itens.reduce((s, i) => s + i.qty * i.preco, 0), desconto: 0, total: itens.reduce((s, i) => s + i.qty * i.preco, 0), pagamento: "pix", fechamento: new Date().toISOString() });

console.log(`\nServidor: ${BASE}\n`);
await venda([alcatra(2), cerveja(1)]);
await venda([alcatra(1)]);
await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/imperio");
await mongoose.connection.collection("pedidos").insertOne({ id: "TESTEITENS1", cliente: "T", telefone: "5543999990000", endereco: "R", itens: [alcatra(1)], subtotal: 9, total: 16, status: "entregue", horario: new Date(), entregueEm: new Date(), pagamento: "pix" });
await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Rafael", itens: [alcatra(1)] });
const estA = (await api("POST", "/estoque", { nome: "Alcatra itens", unidade: "un", quantidade: 20, cardapioNomes: ["Alcatra"] })).corpo;
const estF = (await api("POST", "/estoque", { nome: "Frango cru (teste)", unidade: "kg", quantidade: 5, categoria: "Carnes" })).corpo;
await api("POST", `/estoque/${estA._id}/perda`, { quantidade: 2, motivo: "Caiu no chão" });
await api("POST", `/estoque/${estF._id}/perda`, { quantidade: "0,5", motivo: "Estragou / venceu" });

console.log("=== 1) o dia, item por item ===");
{
  ok((await api("GET", "/relatorio/itens?dia=" + hoje, null, tokenGarcom)).status === 403, "garçom não vê");
  ok((await api("GET", "/relatorio/itens")).status === 400, "sem período: 400");
  const r = (await api("GET", "/relatorio/itens?dia=" + hoje)).corpo;
  const a = r.itens.find(i => i.nome === "Alcatra" && i.unidade === "un");
  ok(a && a.salao === 3 && a.salaoValor === 27 && a.delivery === 1 && a.deliveryValor === 9, `Alcatra vendida: salão 3 (R$ ${a?.salaoValor}), delivery 1 (R$ ${a?.deliveryValor})`);
  ok(a.equipe === 1 && a.perdas === 2 && a.total === 7 && a.vendido === 4 && a.vendidoValor === 36, `equipe 1, perdas 2 (estoque ligado), total que saiu 7`);
  const h = r.itens.find(i => i.nome === "Heineken Long Neck");
  ok(h.salao === 1 && h.salaoValor === 12 && h.categoria === "Cervejas", "Heineken: 1 no salão, R$ 12");
  const f = r.itens.find(i => i.nome === "Frango cru (teste)");
  ok(f && f.unidade === "kg" && f.perdas === 0.5 && f.categoria === "Carnes", "perda em kg fica numa linha própria, na unidade dela");
  ok(r.totais.vendido === 5 && r.totais.vendidoValor === 48 && r.totais.equipe === 1 && r.totais.perdas === 2, `totais: ${r.totais.vendido} vendidos (R$ ${r.totais.vendidoValor}), equipe ${r.totais.equipe}, perdas ${r.totais.perdas} un`);
  ok(r.agrupar === "hora" && r.porPeriodo.length >= 1 && /^\d{2}h$/.test(r.porPeriodo[0].periodo) && a.porPeriodo.reduce((t, p) => t + p.quantidade, 0) === 7, `dia: agrupado por hora (${r.porPeriodo.map(p => p.periodo).join(", ")})`);
}

console.log("\n=== 2) semana, mês e ano ===");
{
  const s = (await api("GET", "/relatorio/itens?semana=" + hoje)).corpo;
  const m = (await api("GET", "/relatorio/itens?mes=" + hoje.slice(0, 7))).corpo;
  const a = (await api("GET", "/relatorio/itens?ano=" + hoje.slice(0, 4))).corpo;
  ok(s.totais.vendido === 5 && s.agrupar === "dia" && s.porPeriodo[0].periodo === hoje, "semana: os mesmos 5, dia a dia");
  ok(m.totais.vendido === 5 && a.totais.vendido === 5 && a.agrupar === "mes" && a.porPeriodo[0].periodo === hoje.slice(0, 7), "mês e ano: os mesmos 5; o ano agrupa por mês");
  const ontem = new Date(Date.parse(hoje + "T12:00:00Z") - 86400e3).toISOString().slice(0, 10);
  ok((await api("GET", "/relatorio/itens?dia=" + ontem)).corpo.itens.length === 0, "ontem: nada");
}

await mongoose.connection.collection("pedidos").deleteOne({ id: "TESTEITENS1" });
await mongoose.disconnect();
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
