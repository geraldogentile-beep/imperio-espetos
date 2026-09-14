// Testa o troco na venda do salao: o servidor refaz a conta e recusa dedo errado.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   TESTE_URL=http://localhost:3997 node scripts/troco.test.mjs
//
// Motivo: "conta de 45, pagou com 50" -> o sistema tem que dizer troco R$ 5,
// guardar isso na venda e imprimir no recibo.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const PIN = process.env.TESTE_PIN || "9999";

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
const venda = (extra) => ({
  mesa: 98, itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: 45 }], subtotal: 45, desconto: 0, total: 45,
  fechamento: new Date().toISOString(), ...extra,
});

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) conta de 45, pagou com 50 em dinheiro ===");
{
  const r = await api("POST", "/vendas-salao", venda({ pagamento: "dinheiro", recebidoDinheiro: 50 }));
  ok(r.status === 201, `gravou (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  ok(r.corpo.recebidoDinheiro === 50 && r.corpo.troco === 5, `recebido 50, troco 5 (veio ${r.corpo.recebidoDinheiro} / ${r.corpo.troco})`);
}

console.log("\n=== 2) valor exato: sem troco ===");
{
  const r = await api("POST", "/vendas-salao", venda({ pagamento: "dinheiro", recebidoDinheiro: 45 }));
  ok(r.status === 201 && r.corpo.troco === 0, `troco 0 (veio ${r.corpo.troco})`);
}

console.log("\n=== 3) entregou menos que a conta: recusa ===");
{
  const r = await api("POST", "/vendas-salao", venda({ pagamento: "dinheiro", recebidoDinheiro: 40 }));
  ok(r.status === 400, `recusou (HTTP ${r.status}): ${r.corpo.erro || ""}`);
}

console.log("\n=== 4) dividido: 20 em dinheiro + 25 no pix, entregou 50 em dinheiro ===");
{
  const r = await api("POST", "/vendas-salao", venda({
    pagamento: "misto", pagamentos: [{ tipo: "dinheiro", valor: 20 }, { tipo: "pix", valor: 25 }], recebidoDinheiro: 50,
  }));
  ok(r.status === 201, `gravou (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  ok(r.corpo.troco === 30, `troco e sobre a parte em dinheiro: 50 - 20 = 30 (veio ${r.corpo.troco})`);
}

console.log("\n=== 5) pix com 'recebido' preenchido por engano: ignora ===");
{
  const r = await api("POST", "/vendas-salao", venda({ pagamento: "pix", recebidoDinheiro: 50 }));
  ok(r.status === 201 && r.corpo.troco === 0 && r.corpo.recebidoDinheiro === 0, `sem dinheiro na comanda, sem troco (veio ${r.corpo.troco})`);
}

console.log("\n=== 6) sem informar: zero, como antes ===");
{
  const r = await api("POST", "/vendas-salao", venda({ pagamento: "dinheiro" }));
  ok(r.status === 201 && r.corpo.troco === 0 && r.corpo.recebidoDinheiro === 0, "venda igual a de antes");
}

console.log("\n=== 7) o troco nao muda o faturamento ===");
{
  const lista = (await api("GET", "/vendas-salao")).corpo;
  const desta = lista.filter(v => v.mesa === 98);
  const total = desta.reduce((s, v) => s + v.total, 0);
  ok(desta.length === 5 && total === 225, `5 vendas de 45 = R$ ${total} (o troco nao entra)`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
