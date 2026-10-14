// Perdas de mercadoria (caiu, queimou, estragou), contra um servidor real.
//   TESTE_URL=http://localhost:3000 node scripts/perdas.test.mjs   (dentro de backend/)
// Banco de teste limpo é melhor (o relatório do mês soma tudo do mês).

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
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
const qtdDe = async (id) => (await api("GET", "/estoque")).corpo.find(e => e._id === id)?.quantidade;
const MES = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);   // mês de Brasília

console.log(`\nServidor: ${BASE}\n`);
const est = (await api("POST", "/estoque", { nome: "Coraçãozinho perda", unidade: "un", quantidade: 20, minimo: 15, custoPorUnidade: 3.88 })).corpo;
const semCusto = (await api("POST", "/estoque", { nome: "Pão perda", unidade: "un", quantidade: 2, minimo: 0 })).corpo;

console.log("=== 1) só o dono lança e vê ===");
{
  ok((await api("POST", `/estoque/${est._id}/perda`, { quantidade: 1, motivo: "x" }, tokenGarcom)).status === 403, "garçom não lança perda");
  ok((await api("GET", "/estoque/perdas?mes=" + MES, null, tokenGarcom)).status === 403, "garçom não vê o relatório");
}

console.log("\n=== 2) lançar perda ===");
let mov1;
{
  for (const [corpo, motivo] of [[{ quantidade: 0 }, "zero"], [{ quantidade: -2 }, "negativa"], [{ quantidade: "abc" }, "texto"]]) {
    ok((await api("POST", `/estoque/${est._id}/perda`, corpo)).status === 400, `quantidade ${motivo} recusada`);
  }
  ok((await api("POST", `/estoque/000000000000000000000000/perda`, { quantidade: 1 })).status === 404, "item inexistente: 404");
  const r = await api("POST", `/estoque/${est._id}/perda`, { quantidade: 3, motivo: "Caiu no chão" });
  ok(r.status === 201 && r.corpo.quantidade === 17, `3 caíram no chão: estoque 20 -> ${r.corpo.quantidade}`);
  mov1 = r.corpo.movimento;
  ok(mov1.tipo === "perda" && mov1.motivo === "Caiu no chão" && mov1.custoUnitario === 3.88 && mov1.baixado === 3, "movimento com motivo, custo do dia e quanto saiu");
  const r2 = await api("POST", `/estoque/${est._id}/perda`, { quantidade: "2,0", motivo: "Queimou" });
  ok(r2.status === 201 && r2.corpo.quantidade === 15, `"2,0" com vírgula aceito: ficou ${r2.corpo.quantidade} (chegou no mínimo)`);
  const movs = (await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo;
  ok(movs.filter(m => m.tipo === "perda").length === 2, "as duas perdas aparecem no histórico do item");
  // Mais do que tem: o saldo não fica negativo, a perda é registrada inteira
  const r3 = await api("POST", `/estoque/${semCusto._id}/perda`, { quantidade: 5, motivo: "Estragou / venceu" });
  ok(r3.status === 201 && r3.corpo.quantidade === 0 && r3.corpo.movimento.quantidade === 5 && r3.corpo.movimento.baixado === 2, "perder 5 com 2 no saldo: saldo 0, perda registrada como 5");
}

console.log("\n=== 3) relatório do mês ===");
{
  const r = (await api("GET", "/estoque/perdas?mes=" + MES)).corpo;
  ok(r.lancamentos === 3, `3 lançamentos (${r.lancamentos})`);
  ok(Math.round(r.custoTotal * 100) === Math.round(5 * 3.88 * 100), `custo perdido R$ ${r.custoTotal} = 5 x 3,88 (o pão não tem custo)`);
  ok(r.semCusto === 1, "avisa que 1 lançamento não tem custo cadastrado");
  const cor = r.porItem.find(i => i.nome === "Coraçãozinho perda");
  ok(cor && cor.quantidade === 5 && cor.vezes === 2 && Math.round(cor.custo * 100) === 1940, "por item: Coraçãozinho 5 un em 2 vezes, R$ 19,40");
  ok(r.porMotivo.map(m => m.motivo).sort().join("|") === "Caiu no chão|Estragou / venceu|Queimou", "por motivo");
  ok((await api("GET", "/estoque/perdas?mes=2026-13")).status === 400, "mês inválido recusado");
  const mensal = (await api("GET", "/relatorio/mensal?mes=" + MES)).corpo;
  ok(mensal.perdas?.lancamentos === 3 && Math.round(mensal.perdas.custo * 100) === 1940, "relatório do mês mostra as perdas (informativo)");
}

console.log("\n=== 4) desfazer uma perda devolve ao estoque ===");
{
  const del = await api("DELETE", `/estoque/movimentacoes/${mov1._id}`);
  ok(del.status === 200 && (await qtdDe(est._id)) === 18, "desfez a de 3: estoque 15 -> 18");
  const movPao = (await api("GET", `/estoque/${semCusto._id}/movimentacoes`)).corpo.find(m => m.tipo === "perda");
  await api("DELETE", `/estoque/movimentacoes/${movPao._id}`);
  ok((await qtdDe(semCusto._id)) === 2, "desfazer a perda de 5 com 2 no saldo devolve só 2 (o que tinha saído)");
  const r = (await api("GET", "/estoque/perdas?mes=" + MES)).corpo;
  ok(r.lancamentos === 1, "sobrou 1 lançamento no relatório");
}

await api("DELETE", "/estoque/" + est._id);
await api("DELETE", "/estoque/" + semCusto._id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
