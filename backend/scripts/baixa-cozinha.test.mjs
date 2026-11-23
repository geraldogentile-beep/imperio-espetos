// Estoque sai na hora da cozinha (pedido da dona, 17/10/2026): cada rodada
// nova da mesa baixa uma vez; no fechamento só sai o que nunca foi rodada.
//   MONGO_URI=<banco do servidor> TESTE_URL=http://localhost:3000 node scripts/baixa-cozinha.test.mjs   (dentro de backend/)
// Banco de teste LIMPO.

import "dotenv/config";
import mongoose from "mongoose";

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
const qtd = async (id) => (await api("GET", "/estoque")).corpo.find(e => e._id === id)?.quantidade;
const movsDe = async (id) => (await api("GET", `/estoque/${id}/movimentacoes`)).corpo;
const alcatra = (q) => ({ id: 1, nome: "Alcatra", qty: q, preco: 9, categoria: "Tradicionais" });
const cerveja = (q) => ({ id: 3001, nome: "Heineken Long Neck", qty: q, preco: 12, categoria: "Cervejas" });
const mesa = (id, scs, extra = {}) => ({ id, status: "ocupada", garcom: "", obs: "", abertura: new Date().toISOString(), subComandas: scs, ...extra });
const sc = (id, itens, rodadas = [], cliente = "") => ({ id, label: `Comanda ${id}`, cliente, itens, rodadas });
const rod = (id, itens, extra = {}) => ({ ...(id ? { id } : {}), hora: new Date().toISOString(), itens, ...extra });
const versoes = {};
const gravar = async (dados, tk = token) => {
  const r = await api("PUT", "/mesas/" + dados.id, { dados, versao: versoes[dados.id] }, tk);
  if (r.corpo.versao) versoes[dados.id] = r.corpo.versao;
  return r;
};
const venda = (mesaId, itens, liberarMesa) => api("POST", "/vendas-salao", {
  mesa: mesaId, itens, subtotal: itens.reduce((s, i) => s + i.qty * i.preco, 0), desconto: 0,
  total: itens.reduce((s, i) => s + i.qty * i.preco, 0), pagamento: "dinheiro", ...(liberarMesa ? { liberarMesa } : {}),
});

console.log(`\nServidor: ${BASE}\n`);
const estA = (await api("POST", "/estoque", { nome: "Alcatra cozinha", unidade: "un", quantidade: 20, cardapioNomes: ["Alcatra"] })).corpo;
const estH = (await api("POST", "/estoque", { nome: "Heineken cozinha", unidade: "un", quantidade: 20, cardapioNomes: ["Heineken Long Neck"] })).corpo;

console.log("=== 1) lançou na comanda, ainda não mandou: nada sai ===");
{
  const r = await gravar(mesa(5, [sc(1, [alcatra(1)])]), tokenGarcom);
  ok(r.status === 201 && (await qtd(estA._id)) === 20, "item pendente não baixa (20)");
}

console.log("\n=== 2) mandou para a cozinha: sai na hora ===");
{
  await gravar(mesa(5, [sc(1, [], [rod("r1", [alcatra(2)])])]), tokenGarcom);
  ok((await qtd(estA._id)) === 18, "rodada da cozinha baixou 2 (20 -> 18), gravada pelo garçom");
  const m = (await movsDe(estA._id)).find(x => x.vendaId === "rodada:r1");
  ok(m && m.tipo === "saida" && m.quantidade === 2 && m.motivo === "cozinha · mesa 5", `histórico: "${m?.motivo}"`);
  await gravar(mesa(5, [sc(1, [], [rod("r1", [alcatra(2)])], "Ana")]));
  ok((await qtd(estA._id)) === 18, "gravar a mesa de novo (nome na comanda) não baixa outra vez");
  await gravar(mesa(5, [sc(1, [], [rod("r1", [alcatra(2)]), rod("r2", [cerveja(1)], { semCozinha: true })], "Ana")]));
  ok((await qtd(estH._id)) === 19, "\"só lançar na conta\" (bebida) também baixa na hora (20 -> 19)");
  ok((await api("DELETE", "/estoque/movimentacoes/" + m._id)).status === 400, "movimento do pedido da mesa não se apaga sozinho");
}

console.log("\n=== 3) dono corrigiu a rodada ===");
{
  await gravar(mesa(5, [sc(1, [], [rod("r1", [alcatra(1)], { editadoEm: "e1" }), rod("r2", [cerveja(1)], { semCozinha: true })], "Ana")]));
  ok((await qtd(estA._id)) === 19, "tirou 1 alcatra da rodada: volta 1 (18 -> 19)");
  ok((await movsDe(estA._id)).some(x => x.tipo === "entrada" && x.quantidade === 1 && x.motivo.startsWith("devolvido")), "histórico: \"devolvido: tirado da comanda\"");
  await gravar(mesa(5, [sc(1, [], [rod("r1", [alcatra(3)], { editadoEm: "e2" }), rod("r2", [cerveja(1)], { semCozinha: true })], "Ana")]));
  ok((await qtd(estA._id)) === 17, "pôs mais 2: saem 2 (19 -> 17)");
}

console.log("\n=== 4) fechamento: sai só o que não foi para a cozinha ===");
let vendaMesa5;
{
  await gravar(mesa(5, [sc(1, [alcatra(1)], [rod("r1", [alcatra(3)], { editadoEm: "e2" }), rod("r2", [cerveja(1)], { semCozinha: true })], "Ana")]));
  ok((await qtd(estA._id)) === 17, "mais 1 alcatra pendente na comanda: ainda não sai");
  const v = await venda(5, [alcatra(4), cerveja(1)], { mesaId: 5, modo: "comanda", scIds: [1] });
  vendaMesa5 = v.corpo;
  ok(v.status === 201 && v.corpo.mesaAtualizada?.dados?.status === "livre", "venda gravada e mesa liberada");
  ok((await qtd(estA._id)) === 16 && (await qtd(estH._id)) === 19, "fechou 4 alcatras + 1 cerveja: saiu só a alcatra pendente (17 -> 16); cerveja fica 19");
  ok(!v.corpo.mesaAtualizada?.antes, "a resposta não leva a mesa de antes");
}

console.log("\n=== 5) painel antigo e rodada sem id: baixa no fechamento, como antes ===");
{
  await venda(30, [alcatra(1)]);
  ok((await qtd(estA._id)) === 15, "venda sem liberarMesa (painel antigo): baixa tudo (16 -> 15)");
  await gravar(mesa(6, [sc(1, [], [rod(null, [cerveja(2)])])]));
  ok((await qtd(estH._id)) === 19, "rodada sem id (painel antigo) não baixa na cozinha");
  await venda(6, [cerveja(2)], { mesaId: 6, modo: "mesa", scIds: [] });
  ok((await qtd(estH._id)) === 17, "...e baixa no fechamento (19 -> 17)");
}

console.log("\n=== 6) pagamento parcial e correção depois ===");
{
  await gravar(mesa(7, [sc(1, [], [rod("r3", [alcatra(2)])])]));
  ok((await qtd(estA._id)) === 13, "rodada de 2 alcatras saiu (15 -> 13)");
  const v = await venda(7, [alcatra(1)], { mesaId: 7, modo: "parcial", scIds: [1] });
  versoes[7] = v.corpo.mesaAtualizada?.versao;
  ok((await qtd(estA._id)) === 13, "pagou 1 das 2: nada sai de novo (13)");
  const restante = v.corpo.mesaAtualizada.dados;
  ok(restante.subComandas[0].rodadas[0].itens[0].qty === 1, "na mesa ficou 1 alcatra");
  restante.subComandas[0].rodadas[0] = { ...restante.subComandas[0].rodadas[0], itens: [alcatra(2)], editadoEm: "e3" };
  await gravar(restante);
  ok((await qtd(estA._id)) === 12, "dono pôs +1 na rodada depois do parcial: sai só 1 (13 -> 12), não devolve o que foi pago");
}

console.log("\n=== 7) mesa Funcionários ===");
{
  await gravar(mesa(901, [sc(1, [], [rod("r4", [alcatra(1)])], "Rafael")], { nome: "Funcionários", tipo: "funcionarios", icon: "👥" }));
  ok((await qtd(estA._id)) === 11, "pedido da equipe sai na cozinha (12 -> 11)");
  ok((await movsDe(estA._id)).some(x => x.vendaId === "rodada:r4" && x.motivo === "consumo da equipe · cozinha"), "histórico: \"consumo da equipe · cozinha\"");
  const c = await api("POST", "/consumo-interno", { mesa: 901, pessoa: "Rafael", subComanda: "Comanda 1", itens: [alcatra(1)], liberarMesa: { mesaId: 901, modo: "comanda", scIds: [1] } });
  ok(c.status === 201 && (await qtd(estA._id)) === 11, "registrar o consumo não baixa de novo (11)");
  await api("DELETE", "/consumo-interno/" + c.corpo._id);
}

console.log("\n=== 8) excluir a venda devolve só o que a venda baixou ===");
{
  const antes = await qtd(estA._id);
  await api("DELETE", "/vendas-salao/" + vendaMesa5._id);
  ok((await qtd(estA._id)) === antes + 1, `devolveu 1 (a alcatra pendente); as da cozinha já foram feitas (${antes} -> ${antes + 1})`);
}

console.log("\n=== 9) delivery: sai quando vai para a cozinha ===");
{
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/imperio");
  const idPedido = "TESTECOZ" + Date.now();
  await mongoose.connection.collection("pedidos").insertOne({ id: idPedido, cliente: "Teste", telefone: "5543999990000", endereco: "Rua X", itens: [cerveja(3)], subtotal: 36, total: 41, status: "novo", horario: new Date(), pagamento: "dinheiro" });
  const antes = await qtd(estH._id);
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "preparando" });
  ok((await qtd(estH._id)) === antes - 3, `"preparando" baixa (${antes} -> ${antes - 3})`);
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "entregue" });
  ok((await qtd(estH._id)) === antes - 3, "entregue depois não baixa de novo");
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "cancelado" });
  ok((await qtd(estH._id)) === antes, "cancelado devolve");
  await mongoose.connection.collection("pedidos").deleteOne({ id: idPedido });
  await mongoose.disconnect();
}

// Caixa Direto, 17/11/2026: a "Comanda 4" fechou às 20h28 e baixou de novo o
// que tinha saído na cozinha às 20h26. A mesa do servidor não batia com a do
// aparelho que fechou (número de comanda reaproveitado / aparelho atrasado).
console.log("\n=== 10) aparelho atrasado fecha a comanda: não baixa duas vezes ===");
{
  const comandaCaixa = [sc(4, [], [rod("rcd1", [alcatra(2), cerveja(1)])])];
  // No servidor a rodada está na comanda 5 (o outro aparelho reabriu a numeração)
  await gravar(mesa(902, [sc(5, [], [rod("rcd1", [alcatra(2), cerveja(1)])])], { nome: "Caixa Direto", tipo: "caixa_direto", icon: "🛒" }));
  const a0 = await qtd(estA._id), h0 = await qtd(estH._id);
  // O aparelho atrasado ainda vê a rodada na comanda 4 e fecha a comanda 4
  const v = await api("POST", "/vendas-salao", {
    mesa: 902, itens: [alcatra(2), cerveja(1)], subtotal: 30, desconto: 0, total: 30, pagamento: "pix",
    liberarMesa: { mesaId: 902, modo: "comanda", scIds: [4] }, rodadasPagas: comandaCaixa.flatMap(s => s.rodadas.map(r => r.id)),
  });
  ok(v.status === 201 && (await qtd(estA._id)) === a0 && (await qtd(estH._id)) === h0, `com os ids das rodadas: não baixou de novo (alcatra ${a0} -> ${await qtd(estA._id)}, cerveja ${h0} -> ${await qtd(estH._id)})`);
  ok(!("rodadasPagas" in v.corpo), "a lista de rodadas não é gravada na venda");

  // Mesmo caso com um item a mais, que nunca foi para a cozinha: esse baixa
  await gravar(mesa(903, [sc(5, [], [rod("rcd2", [alcatra(1)])])]));
  const a1 = await qtd(estA._id);
  await api("POST", "/vendas-salao", {
    mesa: 903, itens: [alcatra(3)], subtotal: 27, desconto: 0, total: 27, pagamento: "pix",
    liberarMesa: { mesaId: 903, modo: "comanda", scIds: [4] }, rodadasPagas: ["rcd2"],
  });
  ok((await qtd(estA._id)) === a1 - 2, `das 3 pagas, 1 já tinha saído: baixa só 2 (${a1} -> ${await qtd(estA._id)})`);

  // Painel antigo (sem a lista): comportamento de antes, baixa pelo que o servidor sabe
  await gravar(mesa(904, [sc(5, [], [rod("rcd3", [alcatra(1)])])]));
  const a2 = await qtd(estA._id);
  await api("POST", "/vendas-salao", {
    mesa: 904, itens: [alcatra(1)], subtotal: 9, desconto: 0, total: 9, pagamento: "pix",
    liberarMesa: { mesaId: 904, modo: "comanda", scIds: [4] },
  });
  ok((await qtd(estA._id)) === a2 - 1, `sem a lista (painel antigo), a comanda que não bate baixa de novo, como antes (${a2} -> ${await qtd(estA._id)})`);

  // Pagamento parcial ignora a lista (nem tudo das rodadas está sendo pago)
  await gravar(mesa(905, [sc(1, [alcatra(1)], [rod("rcd4", [alcatra(2)])])]));
  const a3 = await qtd(estA._id);
  await api("POST", "/vendas-salao", {
    mesa: 905, itens: [alcatra(3)], subtotal: 27, desconto: 0, total: 27, pagamento: "pix",
    liberarMesa: { mesaId: 905, modo: "parcial", scIds: [1] }, rodadasPagas: ["rcd4"],
  });
  ok((await qtd(estA._id)) === a3 - 1, `parcial: baixa só a que não foi para a cozinha (${a3} -> ${await qtd(estA._id)})`);
}

for (const id of [5, 6, 7, 901, 902, 903, 904, 905]) await api("POST", `/mesas/${id}/liberar`, { motivo: "fim do teste" });
await api("DELETE", "/estoque/" + estA._id);
await api("DELETE", "/estoque/" + estH._id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
