// Consumo da equipe (mesa "Funcionários"): sai do estoque, não entra no caixa,
// e cada um paga pela regra da casa: dono = custo; funcionário = cardápio com
// R$ 2 de desconto por espeto (valor corrigível à mão).
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
// Alcatra (Tradicionais, R$ 9) e Heineken (Cervejas, R$ 12) existem no cardápio padrão
const alcatra = (q) => ({ id: 1, nome: "Alcatra", qty: q, preco: 9, categoria: "Tradicionais" });
const cerveja = (q) => ({ id: 3001, nome: "Heineken Long Neck", qty: q, preco: 12, categoria: "Cervejas" });

console.log(`\nServidor: ${BASE}\n`);
const est = (await api("POST", "/estoque", { nome: "Alcatra equipe", unidade: "un", quantidade: 20, minimo: 2, cardapioNomes: ["Alcatra"], custoPorUnidade: 3.8 })).corpo;

console.log("=== 0) regras ===");
{
  const cfg = (await api("GET", "/config/equipe")).corpo;
  ok(cfg.donos?.join(",") === "Daiane,Rafael,Amanda,Leonardo" && cfg.descontoEspeto === 2, `padrão: donos ${cfg.donos?.join(", ")}, desconto R$ ${cfg.descontoEspeto}`);
  ok((await api("GET", "/config/equipe", null, tokenGarcom)).status === 403, "garçom não vê as regras");
  ok((await api("PUT", "/config/equipe", { donos: [] })).status === 400, "lista de donos vazia recusada");
}

console.log("\n=== 1) só o dono registra ===");
ok((await api("POST", "/consumo-interno", { mesa: 901, itens: [alcatra(1)] }, tokenGarcom)).status === 403, "garçom não registra");
ok((await api("GET", "/consumo-interno?mes=" + MES, null, tokenGarcom)).status === 403, "garçom não vê");

console.log("\n=== 2) dono paga o custo ===");
let regRafael;
{
  ok((await api("POST", "/consumo-interno", { mesa: 901, itens: [] })).status === 400, "sem itens: recusado");
  const mesa = { id: 901, nome: "Funcionários", tipo: "funcionarios", icon: "👥", status: "ocupada", garcom: "", obs: "", abertura: new Date().toISOString(),
    subComandas: [
      { id: 1, label: "Comanda 1", cliente: "Rafael", itens: [alcatra(3)], rodadas: [] },
      { id: 2, label: "Comanda 2", cliente: "João", itens: [alcatra(1)], rodadas: [] },
    ] };
  const put = await api("PUT", "/mesas/901", { dados: mesa });
  ok(put.status === 200 || put.status === 201, `mesa da equipe gravada (HTTP ${put.status})`);
  const r = await api("POST", "/consumo-interno", { mesa: 901, subComanda: "Comanda 1", pessoa: "Rafael", itens: [alcatra(3)],
    liberarMesa: { mesaId: 901, modo: "comanda", scIds: [1] } });
  ok(r.status === 201 && r.corpo.tipo === "dono" && r.corpo.custo === 11.4 && r.corpo.valorRegra === 11.4, `Rafael é dono: 3 x custo R$ 3,80 = R$ ${r.corpo.valorRegra}`);
  regRafael = r.corpo;
  ok((await qtdDe(est._id)) === 17, "estoque baixou 3 (20 -> 17)");
  const movs = (await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo;
  ok(movs.some(m => m.tipo === "saida" && m.motivo === "consumo da equipe" && m.quantidade === 3), "saída com motivo \"consumo da equipe\"");
  const m = r.corpo.mesaAtualizada?.dados;
  ok(m && m.subComandas.length === 1 && m.subComandas[0].cliente === "João" && m.tipo === "funcionarios", "a comanda do Rafael saiu; a do João continua; a mesa segue sendo da equipe");
}

console.log("\n=== 3) funcionário: cardápio com R$ 2 de desconto por espeto ===");
let regJoao;
{
  const r = await api("POST", "/consumo-interno", { mesa: 901, pessoa: "João", itens: [alcatra(2), cerveja(1)] });
  ok(r.status === 201 && r.corpo.tipo === "funcionario" && r.corpo.valorRegra === 26, `João: 2 x (R$ 9 - R$ 2) + cerveja R$ 12 = R$ ${r.corpo.valorRegra}`);
  regJoao = r.corpo;
  const amanda = await api("POST", "/consumo-interno", { mesa: 901, pessoa: "amanda", itens: [cerveja(1)] });
  ok(amanda.corpo.tipo === "dono" && amanda.corpo.semCusto === 1 && amanda.corpo.valorRegra === 0, "\"amanda\" (minúscula) é dona; cerveja sem custo cadastrado fica R$ 0 e avisa");
}

console.log("\n=== 4) NÃO entra no caixa nem no faturamento ===");
{
  ok((await api("GET", "/vendas-salao")).corpo.length === 0, "nenhuma venda criada");
  const conf = (await api("GET", "/caixa/conferencia")).corpo;
  ok(conf.dinheiroSalao === 0 && conf.esperadoComDelivery === 0, "gaveta não muda");
  ok((await api("POST", "/fechamento-dia", {})).status === 400, "fechar caixa: \"nenhum movimento\"");
  const mensal = (await api("GET", "/relatorio/mensal?mes=" + MES)).corpo;
  ok(mensal.entradas.total === 0 && mensal.resultado === 0, "relatório do mês: entradas 0");
  ok(mensal.consumoEquipe?.donos === 11.4 && mensal.consumoEquipe?.funcionarios === 26 && mensal.consumoEquipe?.lancamentos === 3, `mas mostra a equipe à parte: donos R$ ${mensal.consumoEquipe?.donos}, funcionários R$ ${mensal.consumoEquipe?.funcionarios}`);
}

console.log("\n=== 5) relatório por nome ===");
{
  const r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(r.lancamentos === 3 && r.donos.total === 11.4 && r.donos.pessoas === 2 && r.funcionarios.total === 26 && r.funcionarios.pessoas === 1, `donos R$ ${r.donos.total} (2 pessoas), funcionários R$ ${r.funcionarios.total} (1)`);
  ok(r.porPessoa.map(p => `${p.pessoa}:${p.tipo}:${p.total}`).join("|") === "Rafael:dono:11.4|amanda:dono:0|João:funcionario:26", `por nome, donos primeiro: ${r.porPessoa.map(p => p.pessoa + " " + p.total).join(", ")}`);
  ok(JSON.stringify(r.porPessoa.find(p => p.pessoa === "João").produtos) === JSON.stringify([{ nome: "Alcatra", qtd: 2 }, { nome: "Heineken Long Neck", qtd: 1 }]), "o que cada um consumiu");
  ok(r.semCusto === 1, "avisa 1 lançamento de dono com item sem custo");
  ok((await api("GET", "/consumo-interno?semana=" + new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10))).corpo.lancamentos === 3, "também por semana");
}

console.log("\n=== 6) correção à mão: só funcionário ===");
{
  const dono = await api("PATCH", "/consumo-interno/" + regRafael._id, { valor: 5 });
  ok(dono.status === 400, `valor do dono não se edita (HTTP ${dono.status})`);
  const pt = await api("PATCH", "/consumo-interno/" + regJoao._id, { valor: "20,00" });
  ok(pt.status === 200 && pt.corpo.valor === 20 && pt.corpo.valorEfetivo === 20, "João corrigido para R$ 20,00");
  let r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  const joao = r.porPessoa.find(p => p.pessoa === "João");
  ok(joao.total === 20 && joao.editados === 1 && r.funcionarios.total === 20, "total do João e dos funcionários seguem a correção");
  const linha = r.lista.find(c => c._id === regJoao._id);
  ok(linha.valorRegra === 26 && linha.valor === 20 && linha.valorEfetivo === 20, "a lista guarda o valor da regra e o corrigido");
  const volta = await api("PATCH", "/consumo-interno/" + regJoao._id, { valor: null });
  ok(volta.status === 200 && volta.corpo.valorEfetivo === 26, "\"voltar à regra\" devolve R$ 26,00");
}

console.log("\n=== 7) mudar a regra vale para os próximos ===");
{
  const cfg = await api("PUT", "/config/equipe", { donos: ["Daiane", "Rafael", "Amanda", "Leonardo", "João"], descontoEspeto: "3,00" });
  ok(cfg.status === 200 && cfg.corpo.donos.includes("João") && cfg.corpo.descontoEspeto === 3, "João entrou como dono; desconto R$ 3,00");
  const r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(r.porPessoa.find(p => p.pessoa === "João").tipo === "funcionario", "o lançamento antigo do João continua como funcionário");
  const novo = await api("POST", "/consumo-interno", { mesa: 901, pessoa: "João", itens: [alcatra(1)] });
  ok(novo.corpo.tipo === "dono" && novo.corpo.valorRegra === 3.8, "o novo já sai como dono (custo R$ 3,80)");
  await api("PUT", "/config/equipe", { donos: ["Daiane", "Rafael", "Amanda", "Leonardo"], descontoEspeto: 2 });
}

console.log("\n=== 8) desfazer devolve o estoque ===");
{
  const antes = await qtdDe(est._id);
  const del = await api("DELETE", "/consumo-interno/" + regRafael._id);
  ok(del.status === 200 && (await qtdDe(est._id)) === antes + 3, `devolveu os 3 do Rafael (${antes} -> ${antes + 3})`);
}

console.log("\n=== 8b) observações: da mesa e de cada item ===");
{
  const c = await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Leonardo", observacao: "consumo de sábado 17/10",
    itens: [{ ...alcatra(1), nota: "sem sal" }, { ...alcatra(1), nota: "bem passado" }] });
  const r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  const l = r.lista.find(x => x._id === c.corpo._id);
  ok(c.status === 201 && l.observacao === "consumo de sábado 17/10", "a observação geral fica guardada no lançamento");
  ok(l.itens.length === 2 && l.itens.map(i => i.nota).join("|") === "sem sal|bem passado", "cada item mantém a sua observação");
  ok(r.porPessoa.find(p => p.pessoa === "Leonardo").produtos.find(x => x.nome === "Alcatra").qtd === 2, "no resumo por pessoa os dois somam (2x Alcatra)");
  // Observação editável depois, inclusive em lançamento de dono (o valor dele não se edita, a observação sim)
  const ed = await api("PATCH", `/consumo-interno/${c.corpo._id}/observacao`, { observacao: "  foi no domingo 18/10  " });
  const l2 = (await api("GET", "/consumo-interno?mes=" + MES)).corpo.lista.find(x => x._id === c.corpo._id);
  ok(ed.status === 200 && l2.observacao === "foi no domingo 18/10" && l2.tipo === "dono", "dono: observação corrigida depois");
  ok((await api("PATCH", `/consumo-interno/${c.corpo._id}/observacao`, { observacao: "" })).corpo.observacao === "", "apagar a observação");
  ok((await api("PATCH", `/consumo-interno/${c.corpo._id}/observacao`, {}, tokenGarcom)).status === 403, "garçom não anota");
  await api("DELETE", "/consumo-interno/" + c.corpo._id);
}

console.log("\n=== 8c) baixa de pagamento (fica registrado, marcado como pago) ===");
{
  const c1 = (await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Carla", itens: [alcatra(1)] })).corpo;   // 9 - 2 = 7
  const c2 = (await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Carla", itens: [cerveja(1)] })).corpo;   // 12
  let r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  let carla = r.porPessoa.find(p => p.pessoa === "Carla");
  ok(carla.total === 19 && carla.emAberto === 19 && carla.pago === 0, `Carla: R$ 19 em aberto (${carla.emAberto})`);
  ok((await api("POST", "/consumo-interno/baixa", { ids: [c1._id] })).status === 400, "sem a forma de pagamento: recusa");
  ok((await api("POST", "/consumo-interno/baixa", { ids: [c1._id], forma: "pix" }, tokenGarcom)).status === 403, "garçom não dá baixa");
  const b = await api("POST", "/consumo-interno/baixa", { ids: [c1._id], forma: "pix" });
  r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  carla = r.porPessoa.find(p => p.pessoa === "Carla");
  const l1 = r.lista.find(x => x._id === c1._id);
  ok(b.corpo.alterados === 1 && l1.pagoEm && l1.formaPagamento === "pix", "baixa no 1º: pago no Pix, continua na lista");
  ok(carla.pago === 7 && carla.emAberto === 12 && carla.total === 19, "Carla: pago R$ 7, em aberto R$ 12, total segue R$ 19");
  ok((await api("POST", "/consumo-interno/baixa", { ids: [c1._id], forma: "dinheiro" })).corpo.alterados === 0, "dar baixa de novo não muda nada (continua Pix)");
  ok((await api("PATCH", "/consumo-interno/" + c1._id, { valor: 1 })).status === 409, "pago: o valor não muda sem desfazer a baixa");
  ok((await api("DELETE", "/consumo-interno/" + c1._id)).status === 409, "pago: não dá para desfazer o consumo sem desfazer a baixa");
  const tudo = await api("POST", "/consumo-interno/baixa", { ids: [c1._id, c2._id], forma: "desconto no salario" });
  ok(tudo.corpo.alterados === 1, "\"dar baixa em tudo\": só o que estava em aberto muda");
  const volta = await api("POST", "/consumo-interno/baixa", { ids: [c1._id], pago: false });
  r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(volta.corpo.alterados === 1 && !r.lista.find(x => x._id === c1._id).pagoEm && r.porPessoa.find(p => p.pessoa === "Carla").emAberto === 7, "desfazer a baixa: volta a ficar em aberto");
  // Pago em dinheiro: entra na conferência da gaveta; desfazer a baixa tira
  await api("POST", "/consumo-interno/baixa", { ids: [c2._id], pago: false });
  const g0 = (await api("GET", "/caixa/conferencia")).corpo;
  await api("POST", "/consumo-interno/baixa", { ids: [c1._id], forma: "dinheiro" });
  const g1 = (await api("GET", "/caixa/conferencia")).corpo;
  ok(g1.equipeDinheiro === 7 && g1.esperadoSemDelivery === g0.esperadoSemDelivery + 7 && g1.movimentos.some(m => m.tipo === "equipe" && m.valor === 7), `baixa em dinheiro entra na gaveta: esperado ${g0.esperadoSemDelivery} -> ${g1.esperadoSemDelivery}`);
  await api("POST", "/consumo-interno/baixa", { ids: [c2._id], forma: "pix" });
  ok((await api("GET", "/caixa/conferencia")).corpo.equipeDinheiro === 7, "baixa no Pix não entra na gaveta");
  await api("POST", "/consumo-interno/baixa", { ids: [c1._id, c2._id], pago: false });
  ok((await api("GET", "/caixa/conferencia")).corpo.equipeDinheiro === 0, "desfazer a baixa tira da gaveta");
  await api("DELETE", "/consumo-interno/" + c1._id);
  await api("DELETE", "/consumo-interno/" + c2._id);
}

console.log("\n=== 9) auditoria: custo errado no dia (5,68 gravado como 568) ===");
{
  let r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  ok(r.itensSemCusto?.includes("Heineken Long Neck"), `lista o que falta cadastrar: ${r.itensSemCusto?.join(", ")}`);
  const regAmanda = r.lista.find(c => c.pessoa === "amanda");
  const cerv = (await api("POST", "/estoque", { nome: "Heineken equipe", unidade: "un", quantidade: 10, cardapioNomes: ["Heineken Long Neck"], custoPorUnidade: 568 })).corpo;
  const daiane = (await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Daiane", itens: [cerveja(1)] })).corpo;
  ok(daiane.custo === 568 && daiane.custoSuspeito === 1, "com o custo errado no estoque, a Daiane nasce com R$ 568 e o custo é marcado como suspeito (acima do preço)");
  await api("PUT", "/estoque/" + cerv._id, { custoPorUnidade: 5.68 });
  r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  const linhaD = r.lista.find(c => c._id === daiane._id);
  ok(linhaD.custo === 568 && linhaD.custoHoje === 5.68, "o relatório mostra: gravado R$ 568, pelo custo de hoje R$ 5,68");
  ok(r.divergentes.length === 2 && r.divergentes.includes(daiane._id) && r.divergentes.includes(regAmanda._id), "aponta os 2 lançamentos de dono que mudam (Daiane e a cerveja sem custo da amanda)");
  const rec = await api("POST", "/consumo-interno/recalcular", { ids: [...r.divergentes, regJoao._id] });
  ok(rec.status === 200 && rec.corpo.alterados.length === 2, `atualizou só os 2 de dono (o do funcionário João fica) — ${rec.corpo.alterados?.map(a => `${a.pessoa} ${a.de} -> ${a.para}`).join("; ")}`);
  r = (await api("GET", "/consumo-interno?mes=" + MES)).corpo;
  const d2 = r.lista.find(c => c._id === daiane._id);
  ok(d2.custo === 5.68 && d2.valorEfetivo === 5.68 && d2.custoOriginal === 568 && d2.recalculadoEm, "Daiane agora R$ 5,68; o R$ 568 original fica guardado");
  ok(r.divergentes.length === 0 && r.itensSemCusto.length === 0, "nada mais diverge nem falta custo");
  ok(r.lista.find(c => c._id === regJoao._id).valorEfetivo === 26, "o do funcionário João não mudou (R$ 26)");
  ok((await api("POST", "/consumo-interno/recalcular", { ids: [daiane._id] }, tokenGarcom)).status === 403, "garçom não recalcula");
  ok((await api("POST", "/consumo-interno/recalcular", { ids: [] })).status === 400, "sem ids: 400");
  await api("DELETE", "/consumo-interno/" + daiane._id);
  await api("DELETE", "/estoque/" + cerv._id);
}

await api("DELETE", "/estoque/" + est._id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
