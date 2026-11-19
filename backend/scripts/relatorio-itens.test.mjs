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
// hoje: dia civil de Brasília (relatório do mês, consumo da equipe).
// hojeOp: dia do expediente, das 06h às 06h — é o dia do relatório de itens
// desde 19/11/2026. Diferem só entre meia-noite e 6h.
const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const hojeOp = new Date(Date.now() - 9 * 3600e3).toISOString().slice(0, 10);
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
  const r = (await api("GET", "/relatorio/itens?dia=" + hojeOp)).corpo;
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
  const s = (await api("GET", "/relatorio/itens?semana=" + hojeOp)).corpo;
  const m = (await api("GET", "/relatorio/itens?mes=" + hojeOp.slice(0, 7))).corpo;
  const a = (await api("GET", "/relatorio/itens?ano=" + hojeOp.slice(0, 4))).corpo;
  ok(s.totais.vendido === 5 && s.agrupar === "dia" && s.porPeriodo[0].periodo === hojeOp, "semana: os mesmos 5, dia a dia");
  ok(m.totais.vendido === 5 && a.totais.vendido === 5 && a.agrupar === "mes" && a.porPeriodo[0].periodo === hojeOp.slice(0, 7), "mês e ano: os mesmos 5; o ano agrupa por mês");
  const ontem = new Date(Date.parse(hojeOp + "T12:00:00Z") - 86400e3).toISOString().slice(0, 10);
  ok((await api("GET", "/relatorio/itens?dia=" + ontem)).corpo.itens.length === 0, "ontem: nada");
}

console.log("\n=== 3) entre datas (dias inteiros de Brasília, os dois inclusos) ===");
{
  const dias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
  const it = (await api("GET", `/relatorio/itens?de=${hojeOp}&ate=${hojeOp}`)).corpo;
  ok(it.totais?.vendido === 5 && it.agrupar === "dia", `itens de hoje a hoje: ${it.totais?.vendido} vendidos, dia a dia`);
  const sem = (await api("GET", `/relatorio/itens?de=${dias(hojeOp, -10)}&ate=${dias(hojeOp, -1)}`)).corpo;
  ok(sem.itens?.length === 0, "até ontem: nada (o fim é o dia inteiro, não passa para hoje)");
  const m = (await api("GET", `/relatorio/mensal?de=${dias(hoje, -6)}&ate=${hoje}`)).corpo;
  ok(m.entradas?.qtdVendas === 2 && m.entradas.qtdDelivery === 1 && m.entradas.salao === 39 && m.entradas.total === 55 && m.de === dias(hoje, -6) && Array.isArray(m.porDia) && m.porDia.length === 1, `período, 7 dias: ${m.entradas?.qtdVendas} comandas + ${m.entradas?.qtdDelivery} pedido, salão R$ ${m.entradas?.salao}, dia a dia`);
  const longo = (await api("GET", `/relatorio/mensal?de=${dias(hoje, -200)}&ate=${hoje}`)).corpo;
  ok(Array.isArray(longo.porMes) && !longo.porDia && longo.entradas.qtdVendas === 2, "mais de 3 meses: mês a mês");
  ok((await api("GET", `/relatorio/mensal?de=${hoje}&ate=${dias(hoje, -1)}`)).status === 400, "até antes do de: 400");
  ok((await api("GET", `/relatorio/mensal?de=2026-02-31&ate=2026-03-02`)).status === 400, "31/02 não existe: 400");
  ok((await api("GET", `/relatorio/mensal?de=${hoje}`)).status === 400, "sem o até: 400");
  ok((await api("GET", `/consumo-interno?de=${hoje}&ate=${hoje}`)).corpo.lancamentos === 1, "consumo da equipe aceita as mesmas datas");
}

// Daiane, 18/11/2026: "a kafta no relatório fala 9 e na movimentação são 13".
// O estoque baixa o espeto que vai no lanche e baixa na hora da cozinha; o
// relatório agora mostra as duas coisas, e o dia vai das 06h às 06h.
console.log("\n=== 4) bate com a movimentação do estoque ===");
{
  const kafta = (q) => ({ id: 12, nome: "Kafta com queijo", qty: q, preco: 12, categoria: "Especiais" });
  const lanche = { id: 71, nome: "Lanche Imperial (Kafta com queijo)", nomeBase: "Lanche Imperial", variacao: "Kafta com queijo", espetos: ["Kafta com queijo"], qty: 1, preco: 18, categoria: "Refeições" };
  await venda([kafta(1), lanche]);
  // Mesa aberta: 2 kaftas e 1 lanche já foram para a cozinha; o frango ainda não
  const mesaAberta = { id: 12, status: "ocupada", garcom: "Ana", obs: "", abertura: new Date().toISOString(), solicitadoPor: null, solicitadoEm: null,
    subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [{ id: 3, nome: "Frango", qty: 1, preco: 9, categoria: "Tradicionais" }],
      rodadas: [{ id: "rtesteitens1", hora: new Date().toISOString(), itens: [kafta(2), { ...lanche }] }] }] };
  const pm = await api("PUT", "/mesas/12", { dados: mesaAberta, versao: 0 });
  // Venda à 01h da madrugada (ainda é a noite de hojeOp) e outra às 06h30 (já é o dia seguinte)
  const dia0 = Date.parse(hojeOp + "T00:00:00Z") + 3 * 3600e3;   // 00h de hojeOp em Brasília
  const coracao = (q) => ({ id: 7, nome: "Coraçãozinho de frango", qty: q, preco: 9, categoria: "Tradicionais" });
  await mongoose.connection.collection("vendasalaos").insertMany([
    { mesa: 4, itens: [coracao(4)], subtotal: 36, desconto: 0, total: 36, pagamento: "pix", fechamento: new Date(dia0 + 25 * 3600e3), gorjeta: 0 },
    { mesa: 4, itens: [coracao(1)], subtotal: 9, desconto: 0, total: 9, pagamento: "pix", fechamento: new Date(dia0 + 30.5 * 3600e3), gorjeta: 0 },
    // Às 21h e às 07h: a 21h tem de vir antes da 01h no hora a hora
    { mesa: 5, itens: [{ id: 9, nome: "Linguiça", qty: 1, preco: 9, categoria: "Tradicionais" }], subtotal: 9, desconto: 0, total: 9, pagamento: "pix", fechamento: new Date(dia0 + 21 * 3600e3), gorjeta: 0 },
    { mesa: 5, itens: [{ id: 9, nome: "Linguiça", qty: 1, preco: 9, categoria: "Tradicionais" }], subtotal: 9, desconto: 0, total: 9, pagamento: "pix", fechamento: new Date(dia0 + 7 * 3600e3), gorjeta: 0 },
  ]);

  const r = (await api("GET", "/relatorio/itens?dia=" + hojeOp)).corpo;
  const l = (nome) => r.itens.find(i => i.nome === nome) || {};
  const k = l("Kafta com queijo");
  ok(pm.status === 201 && k.salao === 1 && k.emLanche === 2 && k.aberto === 2, `Kafta: vendida sozinha ${k.salao}, no lanche ${k.emLanche} (1 vendido + 1 na mesa aberta), mesa aberta ${k.aberto}`);
  ok(k.total === 5 && k.vendido === 1 && k.vendidoValor === 12, `total que saiu = ${k.total} (o mesmo que o estoque baixou); vendido continua 1 (R$ 12)`);
  const lc = l("Lanche Imperial");
  ok(lc.salao === 1 && lc.aberto === 1 && lc.salaoValor === 18 && lc.total === 2, "o lanche continua na linha dele: 1 vendido + 1 na mesa aberta");
  ok(!r.itens.some(i => i.nome === "Frango" && i.aberto > 0), "item que não foi para a cozinha não conta");
  ok(r.totais.emLanche === 2 && r.totais.aberto === 3, `totais: no lanche ${r.totais.emLanche}, mesa aberta ${r.totais.aberto} (sem contar o lanche duas vezes)`);
  const c = l("Coraçãozinho de frango");
  ok(c.salao === 4, `venda da 01h conta na noite de ${hojeOp} (${c.salao}); a das 06h30 fica para o dia seguinte`);
  const ordem = r.porPeriodo.map(p => p.periodo);
  const pos = (h) => ordem.indexOf(h);
  ok(pos("07h") > -1 && pos("07h") < pos("21h") && pos("21h") < pos("01h") && ordem.filter(p => parseInt(p) >= 6).every(p => pos(p) < pos("01h")), `hora a hora na ordem do expediente: ${ordem.join(", ")}`);
  const amanha = new Date(Date.parse(hojeOp + "T12:00:00Z") + 86400e3).toISOString().slice(0, 10);
  const ra = (await api("GET", "/relatorio/itens?dia=" + amanha)).corpo;
  ok(ra.itens.find(i => i.nome === "Coraçãozinho de frango")?.salao === 1 && !ra.itens.some(i => i.aberto > 0), "dia seguinte: só a das 06h30, sem a mesa aberta de hoje");
  const rs = (await api("GET", "/relatorio/itens?dia=" + ontemDe(hojeOp))).corpo;
  ok(!rs.itens.some(i => i.aberto > 0 || i.emLanche > 0), "dia anterior: nada de mesa aberta nem de lanche");
  await mongoose.connection.collection("mesasalaos").deleteMany({ mesaId: 12 });
}
function ontemDe(iso) { return new Date(Date.parse(iso + "T12:00:00Z") - 86400e3).toISOString().slice(0, 10); }

await mongoose.connection.collection("pedidos").deleteOne({ id: "TESTEITENS1" });
await mongoose.disconnect();
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
