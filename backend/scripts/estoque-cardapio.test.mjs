// Cadastro de itens, estoque e a ligação entre os dois, contra um servidor real.
//   MONGO_URI=mongodb://127.0.0.1:27017/<banco do servidor> TESTE_URL=http://localhost:3000 node scripts/estoque-cardapio.test.mjs
// Precisa do MESMO banco do servidor (o teste insere um pedido de delivery direto no Mongo).
//
// O que importa: item com preço inválido não entra; renomear item do cardápio
// não desliga a baixa de estoque; venda baixa e excluir a venda devolve;
// delivery entregue baixa uma vez só; entrada/ajuste recusam lixo.

import "dotenv/config";
import mongoose from "mongoose";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const MONGO = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/imperio";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const login = async (pin) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  if (!r.ok) throw new Error(`login ${pin} falhou: ${r.status}`);
  return (await r.json()).token;
};
const token = await login(process.env.TESTE_PIN || "9999");
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const estoqueDe = async (nome) => (await api("GET", "/estoque")).corpo.find(e => e.nome === nome);
const sufixo = Date.now().toString().slice(-5);
const NOME = "Picanha teste " + sufixo, NOME2 = "Picanha premium " + sufixo, EST = "Carne picanha " + sufixo;

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) cadastro do cardápio recusa lixo ===");
let item;
{
  const semPreco = await api("POST", "/cardapio", { categoria: "Teste", nome: NOME, preco: "abc" });
  ok(semPreco.status === 400, `preço "abc" recusado (HTTP ${semPreco.status})`);
  const r = await api("POST", "/cardapio", { categoria: "  Teste  ", nome: "  " + NOME + "  ", preco: "14,50", tempoPreparo: "x" });
  ok(r.status === 201 && r.corpo.nome === NOME && r.corpo.categoria === "Teste" && r.corpo.preco === 14.5 && r.corpo.tempoPreparo === 10, `criado com nome/categoria sem espaços, preço "14,50" = 14.5, preparo inválido vira 10 (HTTP ${r.status})`);
  item = r.corpo;
  const dup = await api("POST", "/cardapio", { categoria: "Teste", nome: NOME.toUpperCase(), preco: 10 });
  ok(dup.status === 409, `nome repetido (mesmo em maiúsculas) recusado (HTTP ${dup.status})`);
  const nan = await api("PUT", "/cardapio/" + item.id, { preco: NaN });
  ok(nan.status === 400, `editar com preço NaN recusado (HTTP ${nan.status})`);
  const vazio = await api("PUT", "/cardapio/" + item.id, { nome: "   " });
  ok(vazio.status === 400, "nome em branco recusado");
  const off = await api("PATCH", "/cardapio/" + item.id + "/ativo", { ativo: "false" });
  ok(off.status === 200 && off.corpo.ativo === false, `ativo "false" (texto) vira false de verdade (${off.corpo.ativo})`);
  await api("PATCH", "/cardapio/" + item.id + "/ativo", { ativo: true });
}

console.log("\n=== 2) estoque ligado ao item e baixa na venda ===");
let est;
{
  const r = await api("POST", "/estoque", { nome: EST, unidade: "kg", quantidade: 10, minimo: 2, consumoPorVenda: 0.25, cardapioNomes: [NOME] });
  ok(r.status === 201 && r.corpo.consumoPorVenda === 0.25, "estoque criado com consumo 0,25 kg por venda");
  est = r.corpo;
  const venda = await api("POST", "/vendas-salao", { mesa: 53, itens: [{ id: item.id, nome: NOME, qty: 4, preco: 14.5 }], subtotal: 58, desconto: 0, total: 58, pagamento: "pix", fechamento: new Date().toISOString() });
  ok(venda.status === 201, `venda gravada (HTTP ${venda.status})`);
  const e = await estoqueDe(EST);
  ok(Math.abs(e.quantidade - 9) < 1e-9, `4 vendidos x 0,25 = 1 kg baixado (ficou ${e.quantidade})`);
  const movs = (await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo;
  ok(movs.length === 1 && movs[0].tipo === "saida" && Math.abs(movs[0].quantidade - 1) < 1e-9 && movs[0].vendaId === venda.corpo._id, "movimentação de saída ligada à venda");

  // Excluir a venda devolve o estoque
  const del = await api("DELETE", "/vendas-salao/" + venda.corpo._id);
  ok(del.status === 200 && del.corpo.estoqueDevolvido === 1, `venda excluída devolve o estoque (HTTP ${del.status})`);
  ok(Math.abs((await estoqueDe(EST)).quantidade - 10) < 1e-9, "quantidade voltou para 10");
  ok((await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo.length === 0, "a movimentação da venda sumiu junto");
}

console.log("\n=== 3) renomear o item do cardápio não desliga a baixa ===");
{
  const r = await api("PUT", "/cardapio/" + item.id, { nome: NOME2 });
  ok(r.status === 200 && r.corpo.nome === NOME2, "item renomeado");
  const e = await estoqueDe(EST);
  ok(e.cardapioNomes.includes(NOME2) && !e.cardapioNomes.includes(NOME), `vínculo do estoque seguiu o nome novo (${JSON.stringify(e.cardapioNomes)})`);
  const venda = await api("POST", "/vendas-salao", { mesa: 53, itens: [{ id: item.id, nome: NOME2, qty: 2, preco: 14.5 }], subtotal: 29, desconto: 0, total: 29, pagamento: "pix", fechamento: new Date().toISOString() });
  ok(venda.status === 201 && Math.abs((await estoqueDe(EST)).quantidade - 9.5) < 1e-9, "venda com o nome novo baixou 0,5 kg");
}

console.log("\n=== 4) estoque zerado: baixa registra só o que saiu ===");
{
  await api("POST", `/estoque/${est._id}/ajuste`, { quantidade: 0.3, motivo: "inventário" });
  const venda = await api("POST", "/vendas-salao", { mesa: 53, itens: [{ id: item.id, nome: NOME2, qty: 4, preco: 14.5 }], subtotal: 58, desconto: 0, total: 58, pagamento: "pix", fechamento: new Date().toISOString() });
  const e = await estoqueDe(EST);
  ok(e.quantidade === 0, "não fica negativo");
  const movs = (await api("GET", `/estoque/${est._id}/movimentacoes`)).corpo;
  const saida = movs.find(m => m.vendaId === venda.corpo._id);
  ok(saida && Math.abs(saida.quantidade - 0.3) < 1e-9, `saída registrada com 0,3 (o que havia), não 1,0 (${saida?.quantidade})`);
  await api("DELETE", "/vendas-salao/" + venda.corpo._id);
  ok(Math.abs((await estoqueDe(EST)).quantidade - 0.3) < 1e-9, "excluir a venda devolve 0,3, não 1,0");
}

console.log("\n=== 5) entrada e ajuste com lixo ===");
{
  for (const [rota, corpo, motivo] of [["entrada", { quantidade: -5 }, "entrada negativa"], ["entrada", { quantidade: "abc" }, "entrada texto"], ["ajuste", { quantidade: -1 }, "ajuste negativo"], ["ajuste", { quantidade: "Infinity" }, "ajuste Infinity"]]) {
    const r = await api("POST", `/estoque/${est._id}/${rota}`, corpo);
    ok(r.status === 400, `${motivo} recusado (HTTP ${r.status})`);
  }
  const r = await api("POST", `/estoque/${est._id}/entrada`, { quantidade: "4,7", motivo: "compra" });
  ok(r.status === 400 || Math.abs(r.corpo.quantidade - 5) < 1e-9, `entrada "4,7" (vírgula) não vira 4 em silêncio (HTTP ${r.status}, qtd ${r.corpo.quantidade})`);
}

console.log("\n=== 6) delivery entregue baixa o estoque uma vez só ===");
{
  await api("POST", `/estoque/${est._id}/ajuste`, { quantidade: 5, motivo: "inventário" });
  await mongoose.connect(MONGO);
  const idPedido = "TST" + sufixo;
  await mongoose.connection.collection("pedidos").insertOne({ id: idPedido, cliente: "Teste", telefone: "5543999990000", endereco: "Rua X", itens: [{ nome: NOME2, qty: 2, preco: 14.5 }], subtotal: 29, total: 34, status: "preparando", horario: new Date(), pagamento: "dinheiro" });
  const r1 = await api("PATCH", `/pedidos/${idPedido}/status`, { status: "entregue" });
  ok(r1.status === 200, `entregue (HTTP ${r1.status}) ${r1.corpo.erro || ""}`);
  ok(Math.abs((await estoqueDe(EST)).quantidade - 4.5) < 1e-9, "baixou 0,5 kg no delivery");
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "entrega" });
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "entregue" });
  ok(Math.abs((await estoqueDe(EST)).quantidade - 4.5) < 1e-9, "marcar entregue de novo NÃO baixa duas vezes");
  await api("PATCH", `/pedidos/${idPedido}/status`, { status: "cancelado" });
  ok(Math.abs((await estoqueDe(EST)).quantidade - 5) < 1e-9, "cancelado depois de entregue devolve");
  await mongoose.connection.collection("pedidos").deleteOne({ id: idPedido });
  await mongoose.disconnect();
}

console.log("\n=== 7) excluir o item do cardápio tira o vínculo ===");
{
  await api("DELETE", "/cardapio/" + item.id);
  const e = await estoqueDe(EST);
  ok(!e.cardapioNomes.includes(NOME2), `estoque sem vínculo com item apagado (${JSON.stringify(e.cardapioNomes)})`);
  await api("DELETE", "/estoque/" + est._id);
  ok(!(await estoqueDe(EST)), "estoque de teste removido");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
