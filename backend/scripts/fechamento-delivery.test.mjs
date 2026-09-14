// Testa que o delivery entra no fechamento pela forma de pagamento marcada
// no cartao, e que "entregue" grava o momento da entrega.
//
// Precisa de MongoDB. Roda assim, dentro de backend/ (mesmo MONGO_URI do servidor):
//   MONGO_URI=... TESTE_URL=http://localhost:3997 node scripts/fechamento-delivery.test.mjs
//
// Motivo: a dona viu "Delivery R$ 42,00" pago no Pix e o Pix do fechamento
// sem esses 42. O pedido nao guardava forma de pagamento em lugar nenhum.

import "dotenv/config";
import mongoose from "mongoose";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const PIN = process.env.TESTE_PIN || "9999";
if (!process.env.MONGO_URI) { console.error("MONGO_URI obrigatorio"); process.exit(1); }

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: PIN }) });
  if (!r.ok) throw new Error(`login falhou: ${r.status}`);
  return (await r.json()).token;
})();
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};

await mongoose.connect(process.env.MONGO_URI);
// Driver puro: um schema do Mongoose trataria "id" como o virtual de _id e
// nao gravaria o campo (o servidor nao acharia o pedido).
const col = mongoose.connection.collection("pedidos");
const Pedido = { create: (doc) => col.insertOne(doc), deleteMany: (f) => col.deleteMany(f) };
const agora = Date.now();
const min = (n) => new Date(agora - n * 60000);
const base = { cliente: "Teste", telefone: "5500000000000", endereco: "Rua X", itens: [{ nome: "Alcatra", preco: 10, qty: 1 }], subtotal: 10, desconto: 0, cupom: "", obs: "", tempoPreparo: 30 };

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) marcar 'entregue' grava o momento da entrega ===");
{
  await Pedido.create({ ...base, id: "T0001", total: 42, status: "entrega", horario: min(40) });
  const r = await api("PATCH", "/pedidos/T0001/status", { status: "entregue" });
  ok(r.status === 200, `HTTP ${r.status}`);
  ok(!!r.corpo.entregueEm, `entregueEm gravado (${r.corpo.entregueEm ? new Date(r.corpo.entregueEm).toLocaleTimeString("pt-BR") : "vazio"})`);
}

console.log("\n=== 2) o caixa marca a forma de pagamento no pedido ===");
{
  const r = await api("PATCH", "/pedidos/T0001/pagamento", { pagamento: "pix" });
  ok(r.status === 200 && r.corpo.pagamento === "pix", `marcou pix (HTTP ${r.status}, veio "${r.corpo.pagamento}")`);
  const inv = await api("PATCH", "/pedidos/T0001/pagamento", { pagamento: "cheque" });
  ok(inv.status === 400, `forma invalida recusada (HTTP ${inv.status})`);
  const ne = await api("PATCH", "/pedidos/NAOEXISTE/pagamento", { pagamento: "pix" });
  ok(ne.status === 404, `pedido inexistente da 404 (HTTP ${ne.status})`);
}

console.log("\n=== 3) fechamento: delivery entra na forma marcada; sem marcacao vai para 'sem forma' ===");
{
  // T0002: entregue, sem forma marcada
  await Pedido.create({ ...base, id: "T0002", total: 15, status: "entregue", horario: min(30), entregueEm: min(5) });
  // T0003: pedido antigo (sem entregueEm), conta pelo horario
  await Pedido.create({ ...base, id: "T0003", total: 20, status: "entregue", pagamento: "dinheiro", horario: min(20) });
  const f = await api("POST", "/fechamento-dia", { obs: "teste delivery" });
  ok(f.status === 201, `fechou (HTTP ${f.status}) ${f.corpo.erro || ""}`);
  const pp = f.corpo.porPagamento || {};
  ok(pp.pix >= 42, `Pix do fechamento inclui os R$ 42 do delivery (pix = ${pp.pix})`);
  ok(pp.dinheiro >= 20, `dinheiro inclui o pedido antigo sem entregueEm (dinheiro = ${pp.dinheiro})`);
  ok(f.corpo.deliverySemForma === 15, `R$ 15 sem forma marcada ficam separados (veio ${f.corpo.deliverySemForma})`);
  ok(f.corpo.totalDelivery >= 77, `totalDelivery soma os tres (${f.corpo.totalDelivery})`);
  const soma = (pp.pix || 0) + (pp.cartao || 0) + (pp.dinheiro || 0) + (f.corpo.deliverySemForma || 0);
  ok(Math.abs(soma - (f.corpo.totalGeral + (f.corpo.totalGorjetas || 0))) < 0.01, `formas + sem forma = total geral (${soma} vs ${f.corpo.totalGeral})`);
}

console.log("\n=== 4) pedido entregue DEPOIS do fechamento vai para o proximo caixa ===");
{
  await Pedido.create({ ...base, id: "T0004", total: 30, status: "entrega", horario: min(60) });   // feito antes do corte
  const r = await api("PATCH", "/pedidos/T0004/status", { status: "entregue" });                  // entregue depois
  await api("PATCH", "/pedidos/T0004/pagamento", { pagamento: "cartao" });
  const f = await api("POST", "/fechamento-dia", { obs: "" });
  ok(f.status === 201, `segundo fechamento (HTTP ${f.status}) ${f.corpo.erro || ""}`);
  ok(f.corpo.totalDelivery === 30 && f.corpo.porPagamento?.cartao === 30, `so o T0004 entra, no cartao (delivery ${f.corpo.totalDelivery}, cartao ${f.corpo.porPagamento?.cartao})`);
}

await Pedido.deleteMany({ id: /^T000/ });
await mongoose.disconnect();
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
