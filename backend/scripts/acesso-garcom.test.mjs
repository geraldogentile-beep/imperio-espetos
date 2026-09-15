// Testa o que o login do salao (5678) pode e nao pode ver.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   TESTE_URL=http://localhost:3995 node scripts/acesso-garcom.test.mjs
//
// Motivo: a dona pegou garcom vendo o faturamento no celular. O servidor
// entregava a lista de vendas (e os pedidos de delivery) para qualquer login.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const PIN_DONO = process.env.TESTE_PIN || "9999";
const PIN_GARCOM = process.env.TESTE_PIN_GARCOM || "5678";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const login = async (pin) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  if (!r.ok) throw new Error(`login ${pin} falhou: ${r.status}`);
  return (await r.json()).token;
};
const tDono = await login(PIN_DONO);
const tGarcom = await login(PIN_GARCOM);
const api = (token) => async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const dono = api(tDono), garcom = api(tGarcom);

console.log(`\nServidor: ${BASE}\n`);

console.log("=== o garcom NAO ve dinheiro nem delivery ===");
for (const [metodo, rota, corpo] of [
  ["GET", "/vendas-salao"],
  ["POST", "/vendas-salao", { mesa: 1, itens: [{ nome: "Alcatra", qty: 1, preco: 10 }], subtotal: 10, total: 10, pagamento: "pix" }],
  ["GET", "/caixa/periodo"],
  ["GET", "/fechamento-dia"],
  ["GET", "/pedidos"],
  ["PATCH", "/pedidos/00001/status", { status: "entregue" }],
  ["PATCH", "/pedidos/00001/pagamento", { pagamento: "pix" }],
]) {
  const r = await garcom(metodo, rota, corpo);
  ok(r.status === 403, `${metodo} ${rota} -> ${r.status}`);
}

console.log("\n=== o garcom continua trabalhando ===");
for (const [metodo, rota] of [["GET", "/mesas"], ["GET", "/cardapio"], ["GET", "/config"], ["GET", "/modo-evento"], ["GET", "/impressao/status"]]) {
  const r = await garcom(metodo, rota);
  ok(r.status === 200, `${metodo} ${rota} -> ${r.status}`);
}
{
  const r = await garcom("PUT", "/mesas/15", { dados: { id: 15, status: "ocupada", abertura: new Date().toISOString(), subComandas: [{ id: 1, label: "Comanda 1", itens: [{ nome: "Alcatra", qty: 1, preco: 10 }], rodadas: [] }] } });
  ok(r.status === 200 || r.status === 201, `PUT /mesas/15 (abrir mesa) -> ${r.status}`);
  const t = await garcom("POST", "/impressao", { tipo: "cozinha", dados: { mesa: 15, itens: [{ nome: "Alcatra", qty: 1 }], hora: new Date().toISOString() } });
  ok(t.status === 201, `POST /impressao (ticket para o caixa) -> ${t.status}`);
}

console.log("\n=== o dono continua vendo tudo ===");
for (const [metodo, rota] of [["GET", "/vendas-salao"], ["GET", "/caixa/periodo"], ["GET", "/pedidos"], ["GET", "/fechamento-dia"]]) {
  const r = await dono(metodo, rota);
  ok(r.status === 200, `${metodo} ${rota} -> ${r.status}`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
