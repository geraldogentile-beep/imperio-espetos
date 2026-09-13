// Testa a fila de impressao de ponta a ponta contra um servidor de verdade:
// o garcom enfileira, a estacao do caixa reserva, imprime e conclui.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   TESTE_URL=http://localhost:3000 node scripts/fila-impressao.test.mjs
//
// Por que importa: a termica aceita um aparelho por vez e fica no caixa. Se a
// reserva falhar, ou dois ticket saem duplicados, ou o pedido do garcom some.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const PIN = process.env.TESTE_PIN || "9999";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: PIN }),
  });
  if (!r.ok) throw new Error(`login falhou: ${r.status}`);
  return (await r.json()).token;
})();

const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};

const ticket = (mesa) => ({
  tipo: "cozinha",
  dados: { mesa, label: "Comanda 1", garcom: "Maria", cliente: "",
           itens: [{ nome: "Picanha meia lua", qty: 2 }], hora: new Date().toISOString() },
});

console.log(`\nServidor: ${BASE}\n`);

// Comeca do zero
await api("DELETE", "/impressao/erros");
let sobra = await api("POST", "/impressao/reservar", { limite: 50 });
for (const j of sobra.corpo.jobs || []) await api("POST", `/impressao/${j.id}/concluir`, { ok: true });

console.log("=== 1) garcom enfileira, estacao recebe ===");
{
  const env = await api("POST", "/impressao", ticket(7));
  ok(env.status === 201, `enfileirou (HTTP ${env.status})`);

  const st = await api("GET", "/impressao/status");
  ok(st.corpo.pendentes === 1, `1 na fila (tem ${st.corpo.pendentes})`);

  const res = await api("POST", "/impressao/reservar", { limite: 5 });
  ok(res.corpo.jobs?.length === 1, "estacao reservou o ticket");
  ok(res.corpo.jobs?.[0]?.dados?.mesa === 7, "com os dados da mesa 7");
  ok(res.corpo.jobs?.[0]?.dados?.itens?.[0]?.nome === "Picanha meia lua", "e o item certo");

  const fim = await api("POST", `/impressao/${res.corpo.jobs[0].id}/concluir`, { ok: true });
  ok(fim.status === 200, "concluiu");

  const st2 = await api("GET", "/impressao/status");
  ok(st2.corpo.pendentes === 0, "fila vazia depois de imprimir");
}

console.log("\n=== 2) duas estacoes nao imprimem o mesmo ticket ===");
{
  await api("POST", "/impressao", ticket(8));
  const [a, b] = await Promise.all([
    api("POST", "/impressao/reservar", { limite: 5 }),
    api("POST", "/impressao/reservar", { limite: 5 }),
  ]);
  const total = (a.corpo.jobs?.length || 0) + (b.corpo.jobs?.length || 0);
  ok(total === 1, `o ticket foi para UMA estacao so (foram ${total})`);

  const dono = (a.corpo.jobs?.length ? a : b).corpo.jobs[0];
  await api("POST", `/impressao/${dono.id}/concluir`, { ok: true });
}

console.log("\n=== 3) falha na impressao devolve o ticket para a fila ===");
{
  await api("POST", "/impressao", ticket(9));
  const r1 = await api("POST", "/impressao/reservar", { limite: 5 });
  const job = r1.corpo.jobs[0];
  ok(job.tentativas === 1, `primeira tentativa (tentativas=${job.tentativas})`);

  await api("POST", `/impressao/${job.id}/concluir`, { ok: false, erro: "impressora sem papel" });
  const st = await api("GET", "/impressao/status");
  ok(st.corpo.pendentes === 1, "voltou para a fila, nao se perdeu");

  const r2 = await api("POST", "/impressao/reservar", { limite: 5 });
  ok(r2.corpo.jobs?.[0]?.id === job.id, "a estacao pega o mesmo ticket de novo");
  ok(r2.corpo.jobs?.[0]?.tentativas === 2, "contando a segunda tentativa");
  await api("POST", `/impressao/${job.id}/concluir`, { ok: true });
}

console.log("\n=== 4) depois de 3 falhas, desiste e marca erro ===");
{
  await api("POST", "/impressao", ticket(10));
  let job = null;
  for (let i = 0; i < 3; i++) {
    const r = await api("POST", "/impressao/reservar", { limite: 5 });
    job = r.corpo.jobs?.[0];
    if (!job) break;
    await api("POST", `/impressao/${job.id}/concluir`, { ok: false, erro: "impressora desligada" });
  }
  const st = await api("GET", "/impressao/status");
  ok(st.corpo.pendentes === 0, "parou de tentar");
  ok(st.corpo.erros === 1, `ficou 1 marcado com erro (tem ${st.corpo.erros})`);

  const limpou = await api("DELETE", "/impressao/erros");
  ok(limpou.corpo.removidos === 1, "e da para limpar pelo painel");
}

console.log("\n=== 5) tipo invalido nao entra na fila ===");
{
  const r = await api("POST", "/impressao", { tipo: "xpto", dados: {} });
  ok(r.status === 400, `recusou (HTTP ${r.status})`);
  const r2 = await api("POST", "/impressao", { tipo: "cozinha" });
  ok(r2.status === 400, `sem dados recusou (HTTP ${r2.status})`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
