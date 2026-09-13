// Testa que o periodo do caixa so vira quando alguem fecha -- nunca sozinho.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   TESTE_URL=http://localhost:3000 node scripts/periodo-caixa.test.mjs
//
// Motivo: a casa pediu que o fechamento so aconteca no botao, para dar tempo
// de conferir e corrigir. Antes o periodo virava no relogio e os numeros da
// tela sumiam antes de alguem olhar.

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
    method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};

const venda = (total) => ({
  mesa: 99, itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: total }],
  subtotal: total, desconto: 0, total, pagamento: "dinheiro",
  fechamento: new Date().toISOString(),
});

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) venda entra no periodo aberto ===");
{
  const antes = (await api("GET", "/vendas-salao")).corpo.length;
  await api("POST", "/vendas-salao", venda(40));
  const depois = (await api("GET", "/vendas-salao")).corpo;
  ok(depois.length === antes + 1, `a venda aparece (${antes} -> ${depois.length})`);

  const p = (await api("GET", "/caixa/periodo")).corpo;
  ok(!!p.inicio, `periodo aberto desde ${new Date(p.inicio).toLocaleString("pt-BR")}`);
}

console.log("\n=== 2) fechar o caixa corta o periodo ===");
{
  const f = await api("POST", "/fechamento-dia", { obs: "teste automatizado" });
  ok(f.status === 201, `fechou (HTTP ${f.status})`);
  ok(!!f.corpo.periodoInicio && !!f.corpo.periodoFim, "gravou a janela que cobriu");
  ok(f.corpo.totalSalao >= 40, `somou a venda do periodo (R$ ${f.corpo.totalSalao})`);

  const depois = (await api("GET", "/vendas-salao")).corpo;
  ok(depois.length === 0, `a tela zera depois de fechar (${depois.length} vendas)`);

  const p = (await api("GET", "/caixa/periodo")).corpo;
  ok(new Date(p.inicio).getTime() === new Date(f.corpo.periodoFim).getTime(),
     "o novo periodo comeca exatamente onde o anterior terminou");
}

console.log("\n=== 3) fechar duas vezes seguidas nao cria periodo vazio ===");
{
  const f = await api("POST", "/fechamento-dia", { obs: "" });
  ok(f.status === 400, `recusou (HTTP ${f.status}): ${f.corpo.erro || ""}`);
}

console.log("\n=== 4) venda nova entra no periodo NOVO ===");
{
  await api("POST", "/vendas-salao", venda(25));
  const lista = (await api("GET", "/vendas-salao")).corpo;
  ok(lista.length === 1, `so a venda nova aparece (${lista.length})`);
  ok(lista[0]?.total === 25, `e e a de R$ 25 (veio ${lista[0]?.total})`);

  const f = await api("POST", "/fechamento-dia", { obs: "" });
  ok(f.status === 201 && f.corpo.totalSalao === 25,
     `o segundo fechamento soma so os R$ 25 (veio R$ ${f.corpo.totalSalao})`);
}

console.log("\n=== 5) dois fechamentos no mesmo dia sao permitidos ===");
{
  const h = (await api("GET", "/fechamento-dia")).corpo;
  const hoje = h.filter(f => f.obs === "teste automatizado" || f.periodoFim);
  ok(h.length >= 2, `o historico guarda os dois (${h.length} fechamentos)`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
