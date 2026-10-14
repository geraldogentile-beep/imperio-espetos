// Gastos da loja e relatório do mês, contra um servidor de verdade.
//   TESTE_URL=http://localhost:3000 node scripts/despesas.test.mjs   (dentro de backend/)
// Precisa de MongoDB (banco de teste limpo é melhor).

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const cent = (v) => Math.round(Number(v) * 100);

const login = async (pin) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  if (!r.ok) throw new Error(`login ${pin} falhou: ${r.status}`);
  return (await r.json()).token;
};
const token = await login(process.env.TESTE_PIN || "9999");
const tokenGarcom = await login(process.env.TESTE_PIN_GARCOM || "5678");
const api = async (metodo, rota, corpo, tk = token) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};

// Mês de teste bem longe do movimento real: janeiro de 2031
const MES = "2031-01";
const venda = async (total, extra = {}) => {
  const r = await api("POST", "/vendas-salao", { mesa: 51, itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: total }], subtotal: total, desconto: 0, total, pagamento: "pix", fechamento: "2031-01-10T21:00:00-03:00", ...extra });
  if (r.status !== 201) throw new Error("venda nao gravou: " + JSON.stringify(r.corpo));
  return r.corpo;
};

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) o garçom não vê nada disso ===");
{
  for (const [m, rota] of [["GET", "/despesas?mes=" + MES], ["POST", "/despesas"], ["GET", "/relatorio/mensal?mes=" + MES]]) {
    const r = await api(m, rota, m === "POST" ? { data: "2031-01-05", tipo: "x", valor: 1 } : undefined, tokenGarcom);
    ok(r.status === 403, `${m} ${rota.split("?")[0]} -> ${r.status}`);
  }
}

console.log("\n=== 2) lançar gastos ===");
let g1, g2;
{
  const r = await api("POST", "/despesas", { data: "2031-01-05T12:00:00-03:00", tipo: "Mercadoria / carnes", valor: "1.250,50", descricao: "20 kg de alcatra" });
  ok(r.status === 201 && cent(r.corpo.valor) === 125050, `gasto com valor em formato brasileiro (R$ ${r.corpo.valor})`);
  g1 = r.corpo;
  const r2 = await api("POST", "/despesas", { data: "2031-01-20T12:00:00-03:00", tipo: "Carvão / gás", valor: 180 });
  ok(r2.status === 201, "segundo gasto");
  g2 = r2.corpo;
  const r3 = await api("POST", "/despesas", { data: "2031-01-20T12:00:00-03:00", tipo: "Mercadoria / carnes", valor: 300.4 });
  ok(r3.status === 201, "terceiro gasto, mesmo tipo do primeiro");
  for (const [corpo, motivo] of [[{ data: "2031-01-05", tipo: "", valor: 10 }, "sem tipo"], [{ data: "2031-01-05", tipo: "x", valor: 0 }, "valor zero"], [{ data: "2031-01-05", tipo: "x", valor: "abc" }, "valor inválido"], [{ data: "ontem", tipo: "x", valor: 10 }, "data inválida"]]) {
    const r = await api("POST", "/despesas", corpo);
    ok(r.status === 400, `recusa ${motivo} (HTTP ${r.status}: ${r.corpo.erro})`);
  }
  // Fora do mês: 31/12/2030 às 23h de Brasília NÃO é janeiro
  const fora = await api("POST", "/despesas", { data: "2030-12-31T23:30:00-03:00", tipo: "Energia", valor: 99 });
  ok(fora.status === 201, "gasto de 31/12 à noite gravado");
  const lista = (await api("GET", "/despesas?mes=" + MES)).corpo;
  ok(Array.isArray(lista) && lista.length === 3 && !lista.some(d => d.tipo === "Energia"), `lista de janeiro tem 3 gastos; o de 31/12 23h30 ficou em dezembro (${lista.length})`);
  ok(lista[0]._id === g2._id || lista[0].tipo === "Mercadoria / carnes", "ordenada do mais recente para o mais antigo");
  ok((await api("GET", "/despesas?mes=2031-1")).status === 400, "mês mal formado é recusado");
}

console.log("\n=== 3) alterar e excluir ===");
{
  const r = await api("PUT", "/despesas/" + g2._id, { valor: "200,00", descricao: "2 botijões" });
  ok(r.status === 200 && cent(r.corpo.valor) === 20000 && r.corpo.descricao === "2 botijões" && r.corpo.tipo === "Carvão / gás", "alterou valor e descrição sem perder o tipo");
  const inv = await api("PUT", "/despesas/" + g2._id, { valor: -5 });
  ok(inv.status === 400, "alteração inválida recusada");
  const extra = await api("POST", "/despesas", { data: "2031-01-25T12:00:00-03:00", tipo: "Outro", valor: 10 });
  const del = await api("DELETE", "/despesas/" + extra.corpo._id);
  ok(del.status === 200 && (await api("DELETE", "/despesas/" + extra.corpo._id)).status === 404, "excluiu; excluir de novo dá 404");
}

console.log("\n=== 4) relatório do mês ===");
{
  await venda(100);                                                       // pix
  await venda(60.3, { pagamento: "misto", pagamentos: [{ tipo: "dinheiro", valor: 30 }, { tipo: "cartao", valor: 36.33 }], gorjeta: 6.03, subtotal: 67, desconto: 6.7 });
  await venda(50, { pagamento: "cartao", fechamento: "2031-01-31T23:40:00-03:00" });   // último dia do mês, à noite: é janeiro
  await venda(70, { pagamento: "pix", fechamento: "2031-02-01T00:10:00-03:00" });      // já é fevereiro
  const r = await api("GET", "/relatorio/mensal?mes=" + MES);
  ok(r.status === 200, `HTTP ${r.status}`);
  const e = r.corpo.entradas, g = r.corpo.gastos;
  ok(cent(e.salao) === 21030 && e.qtdVendas === 3 && cent(e.total) === 21030, `entradas do salão R$ ${e.salao} em 3 comandas (fevereiro ficou fora, 31/12 23h40 ficou dentro)`);
  ok(cent(e.gorjetas) === 603 && cent(e.descontos) === 670, `gorjeta R$ ${e.gorjetas} fora das entradas; descontos R$ ${e.descontos}`);
  const f = e.porForma;
  // 30 dinheiro + 36,33 cartao pagaram 60,30 + 6,03 de gorjeta: cada forma entra na proporcao (27,27 e 33,03)
  ok(cent(f.pix) === 10000 && cent(f.cartao) === 5000 + 3303 && cent(f.dinheiro) === 2727 && cent(f.pix + f.cartao + f.dinheiro + f.outros) === 21030,
    `por forma: pix ${f.pix}, cartão ${f.cartao}, dinheiro ${f.dinheiro} — somam as entradas (gorjeta rateada fora)`);
  ok(cent(g.total) === 125050 + 20000 + 30040 && g.qtd === 3, `gastos R$ ${g.total} em ${g.qtd} lançamentos`);
  ok(g.porTipo[0].tipo === "Mercadoria / carnes" && cent(g.porTipo[0].total) === 155090 && g.porTipo[0].qtd === 2 && g.porTipo[1].tipo === "Carvão / gás", `por tipo, maior primeiro: ${g.porTipo.map(t => t.tipo + " " + t.total).join(" | ")}`);
  ok(cent(r.corpo.resultado) === 21030 - 175090, `resultado R$ ${r.corpo.resultado} (entradas - gastos)`);
  const dias = r.corpo.porDia;
  const d10 = dias.find(d => d.dia === "2031-01-10"), d20 = dias.find(d => d.dia === "2031-01-20"), d31 = dias.find(d => d.dia === "2031-01-31");
  ok(d10 && cent(d10.entradas) === 16030 && d10.gastos === 0 && d20 && cent(d20.gastos) === 50040 && d20.entradas === 0 && d31 && cent(d31.entradas) === 5000,
    `dia a dia em Brasília: 10/01 entradas ${d10?.entradas}, 20/01 gastos ${d20?.gastos}, 31/01 entradas ${d31?.entradas}`);
  ok(dias.every((d, i) => i === 0 || d.dia > dias[i - 1].dia), "dias em ordem");
  ok(g.lista.length === 3 && g.lista[0].tipo === "Mercadoria / carnes", "lista completa dos gastos no relatório");
  const vazio = (await api("GET", "/relatorio/mensal?mes=2031-06")).corpo;
  ok(vazio.entradas.total === 0 && vazio.gastos.total === 0 && vazio.resultado === 0 && vazio.porDia.length === 0, "mês sem movimento vem zerado, sem erro");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
