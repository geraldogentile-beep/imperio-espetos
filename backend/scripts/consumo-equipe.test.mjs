// Consumo da equipe (mesa "Funcionários"): sai do estoque, não entra no caixa.
//   TESTE_URL=http://localhost:3000 node scripts/consumo-equipe.test.mjs   (dentro de backend/)
// Banco de teste LIMPO (o caixa e o relatório do mês somam tudo do período).

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
const MES = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
const qtdDe = async (id) => (await api("GET", "/estoque")).corpo.find(e => e._id === id)?.quantidade;

console.log(`\nServidor: ${BASE}\n`);
const est = (await api("POST", "/estoque", { nome: "Alcatra equipe", unidade: "un", quantidade: 20, minimo: 2, cardapioNomes: ["Alcatra"] })).corpo;

console.log("=== 1) só o dono registra ===");
ok((await api("POST", "/consumo-interno", { mesa: 901, itens: [{ nome: "Alcatra", qty: 1, preco: 9 }] }, tokenGarcom)).status === 403, "garçom não registra");
ok((await api("GET", "/consumo-interno?mes=" + MES, null, tokenGarcom)).status === 403, "garçom não vê");

console.log("\n=== 2) registrar consumo ===");
let reg;
{
  ok((await api("POST", "/consumo-interno", { mesa: 901, itens: [] })).status === 400, "sem itens: recusado");
  ok((await api("POST", "/consumo-interno", { mesa: 901, itens: [{ nome: "Alcatra", qty: 0 }] })).status === 400, "quantidade zero: recusado");
  // Mesa da equipe no servidor, com a comanda do Rafael
  const mesa = { id: 901, nome: "Funcionários", tipo: "funcionarios", icon: "👥", status: "ocupada", garcom: "", obs: "", abertura: new Date().toISOString(),
    subComandas: [
      { id: 1, label: "Comanda 1", cliente: "Rafael", itens: [{ id: 1, nome: "Alcatra", qty: 3, preco: 9 }], rodadas: [] },
      { id: 2, label: "Comanda 2", cliente: "Ana", itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: 9 }], rodadas: [] },
    ] };
  const atual = await api("GET", "/mesas");
  const versao = (atual.corpo?.mesas || atual.corpo || []).find?.(m => (m.dados?.id ?? m.id) === 901)?.versao;
  const put = await api("PUT", "/mesas/901", { dados: mesa, ...(versao ? { versao } : {}) });
  ok(put.status === 200 || put.status === 201, `mesa da equipe gravada (HTTP ${put.status})`);
  const r = await api("POST", "/consumo-interno", { mesa: 901, subComanda: "Comanda 1", pessoa: "Rafael", itens: [{ id: 1, nome: "Alcatra", qty: 3, preco: 9 }],
    liberarMesa: { mesaId: 901, modo: "comanda", scIds: [1] } });
  ok(r.status === 201 && r.corpo.valor === null && r.corpo.pessoa === "Rafael", `registrado: Rafael, sem valor a cobrar (o preço da equipe não é o do cardápio) — valor=${r.corpo.valor}`);
  reg = r.corpo;
  ok((await qtdDe(est._id)) === 17, "estoque baixou 3 (20 -> 17)");
  const movs = (await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo;
  ok(movs.some(m => m.tipo === "saida" && m.motivo === "consumo da equipe" && m.quantidade === 3), "movimentação de saída com motivo \"consumo da equipe\"");
  const m = r.corpo.mesaAtualizada?.dados;
  ok(m && m.subComandas.length === 1 && m.subComandas[0].cliente === "Ana" && m.tipo === "funcionarios", "a comanda do Rafael saiu da mesa; a da Ana continua; a mesa segue sendo da equipe");
}

console.log("\n=== 3) NÃO entra no caixa nem no faturamento ===");
{
  ok((await api("GET", "/vendas-salao")).corpo.length === 0, "nenhuma venda criada");
  const conf = (await api("GET", "/caixa/conferencia")).corpo;
  ok(conf.dinheiroSalao === 0 && conf.esperadoComDelivery === 0, "gaveta não muda");
  const fecha = await api("POST", "/fechamento-dia", {});
  ok(fecha.status === 400, `fechar caixa: "nenhum movimento" (o consumo não é venda) (HTTP ${fecha.status})`);
  const mensal = (await api("GET", "/relatorio/mensal?mes=" + MES)).corpo;
  ok(mensal.entradas.total === 0 && mensal.resultado === 0, "relatório do mês: entradas 0");
  ok(mensal.consumoEquipe?.itens === 3 && mensal.consumoEquipe?.lancamentos === 1 && mensal.consumoEquipe?.aCobrar === 0, "mas mostra o consumo da equipe à parte (3 itens, 1 lançamento, nada a cobrar ainda)");
}

console.log("\n=== 4) relatório por pessoa e desfazer ===");
{
  await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Ana", itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: 9 }, { id: 99, nome: "Coca lata", qty: 2, preco: 6 }] });
  let r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(r.lancamentos === 2 && r.itensTotal === 6 && r.aCobrarTotal === 0 && r.semValor === 2, `2 lançamentos, 6 itens, nada a cobrar ainda`);
  const ana = r.porPessoa.find(p => p.pessoa === "Ana"), rafa = r.porPessoa.find(p => p.pessoa === "Rafael");
  ok(rafa?.itens === 3 && ana?.itens === 3 && JSON.stringify(ana.produtos) === JSON.stringify([{ nome: "Coca lata", qtd: 2 }, { nome: "Alcatra", qtd: 1 }]), `por pessoa, com o que cada um consumiu: ${JSON.stringify(r.porPessoa.map(p => [p.pessoa, p.itens, p.produtos]))}`);
  ok(r.porItem[0].nome === "Alcatra" && r.porItem[0].qtd === 4, "por item: 4 Alcatra");
  ok(r.lista.every(c => !("preco" in c.itens[0])), "o preço do cardápio não aparece na lista");

  // A dona define depois quanto cobrar de cada lançamento
  const idAna = r.lista.find(c => c.pessoa === "Ana")._id;
  ok((await api("PATCH", "/consumo-interno/" + idAna, { valor: -1 })).status === 400, "valor negativo recusado");
  const pt = await api("PATCH", "/consumo-interno/" + idAna, { valor: "12,50" });
  ok(pt.status === 200 && pt.corpo.valor === 12.5, `valor a cobrar da Ana: R$ ${pt.corpo.valor} (digitado "12,50")`);
  r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(r.aCobrarTotal === 12.5 && r.semValor === 1 && r.porPessoa.find(p => p.pessoa === "Ana").aCobrar === 12.5 && r.porPessoa.find(p => p.pessoa === "Rafael").aCobrar === 0, "total a cobrar soma só o que foi definido");
  ok((await api("GET", "/relatorio/mensal?mes=" + MES)).corpo.consumoEquipe.aCobrar === 12.5, "relatório do mês mostra o total a cobrar");
  const limpa = await api("PATCH", "/consumo-interno/" + idAna, { valor: "" });
  ok(limpa.status === 200 && limpa.corpo.valor === null, "apagar o valor volta a \"sem valor\"");
  ok((await api("GET", "/consumo-interno?ano=" + MES.slice(0, 4))).corpo.lancamentos === 2, "também por ano");
  const del = await api("DELETE", "/consumo-interno/" + reg._id);
  ok(del.status === 200 && (await qtdDe(est._id)) === 19, "desfazer devolve os 3 ao estoque (16 -> 19)");
  ok((await api("GET", "/consumo-interno?mes=" + MES)).corpo.lancamentos === 1, "sobrou 1 lançamento");
}

await api("DELETE", "/estoque/" + est._id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
