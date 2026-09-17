// Testa a concorrencia da sincronizacao de mesas contra um servidor de
// verdade, com dois "aparelhos" disputando a mesma mesa.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   node scripts/mesas-sync.test.mjs
//
// Usa mesas de id 9xx (fora da faixa real) e limpa o que criou no fim.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const PIN = process.env.TESTE_PIN || "9999";
const MESA = 987;   // fora da faixa usada pela casa

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN }),
  });
  if (!r.ok) throw new Error(`login falhou: ${r.status}`);
  return (await r.json()).token;
}

const api = (tk) => async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, {
    method: metodo,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};

const mesaCom = (itens) => ({
  id: MESA, status: itens.length ? "ocupada" : "livre", garcom: "Teste", obs: "",
  abertura: new Date().toISOString(), subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens, rodadas: [] }],
});

const token = await login();
const celular = api(token);   // o garcom
const pc = api(token);        // o caixa

console.log(`\nServidor: ${BASE} · mesa de teste: ${MESA}\n`);

// Estado limpo para esta mesa (o servidor exige a versao se a mesa ja existe)
const versaoAtual = async () => ((await pc("GET", "/mesas")).corpo.mesas || []).find(m => m.mesaId === MESA)?.versao;
await celular("PUT", `/mesas/${MESA}`, { dados: mesaCom([]), versao: await versaoAtual() });

console.log("=== 1) o que o garcom lanca aparece para o caixa ===");
{
  const escrita = await celular("PUT", `/mesas/${MESA}`, {
    dados: mesaCom([{ id: 1, nome: "Alcatra", qty: 2, preco: 9 }]), versao: await versaoAtual(),
  });
  ok(escrita.status === 200 || escrita.status === 201, `gravou (HTTP ${escrita.status})`);

  const leitura = await pc("GET", "/mesas");
  const vista = leitura.corpo.mesas?.find(m => m.mesaId === MESA);
  ok(!!vista, "o caixa enxerga a mesa");
  ok(vista?.dados?.subComandas?.[0]?.itens?.[0]?.nome === "Alcatra", "com o item que o garcom lancou");
  ok(vista?.dados?.subComandas?.[0]?.itens?.[0]?.qty === 2, "e a quantidade certa");
}

console.log("\n=== 2) versao velha nao apaga o lancamento do outro ===");
{
  const antes = (await pc("GET", "/mesas")).corpo.mesas.find(m => m.mesaId === MESA);
  const versaoVelha = antes.versao;

  // O caixa grava primeiro
  const doCaixa = await pc("PUT", `/mesas/${MESA}`, {
    dados: mesaCom([{ id: 1, nome: "Alcatra", qty: 2, preco: 9 }, { id: 2, nome: "Coca-Cola Lata", qty: 1, preco: 6 }]),
    versao: versaoVelha,
  });
  ok(doCaixa.status === 200, "caixa gravou primeiro");

  // O celular tenta gravar com a versao que tinha ANTES
  const doCelular = await celular("PUT", `/mesas/${MESA}`, {
    dados: mesaCom([{ id: 1, nome: "Alcatra", qty: 5, preco: 9 }]),
    versao: versaoVelha,
  });
  ok(doCelular.status === 409, `recusou com 409 (veio ${doCelular.status})`);
  ok(doCelular.corpo.dados?.subComandas?.[0]?.itens?.length === 2, "devolveu o estado bom, com os 2 itens");

  const agora = (await pc("GET", "/mesas")).corpo.mesas.find(m => m.mesaId === MESA);
  ok(agora.dados.subComandas[0].itens.length === 2, "a Coca-Cola do caixa NAO foi apagada");
}

console.log("\n=== 3) gravar com a versao certa passa ===");
{
  const atual = (await pc("GET", "/mesas")).corpo.mesas.find(m => m.mesaId === MESA);
  const r = await celular("PUT", `/mesas/${MESA}`, {
    dados: mesaCom([{ id: 1, nome: "Frango", qty: 3, preco: 9 }]),
    versao: atual.versao,
  });
  ok(r.status === 200, `gravou (HTTP ${r.status})`);
  ok(r.corpo.versao === atual.versao + 1, `versao subiu para ${r.corpo.versao}`);
}

console.log("\n=== 4) duas gravacoes simultaneas: uma vence, a outra sabe ===");
{
  const atual = (await pc("GET", "/mesas")).corpo.mesas.find(m => m.mesaId === MESA);
  const [a, b] = await Promise.all([
    celular("PUT", `/mesas/${MESA}`, { dados: mesaCom([{ id: 1, nome: "Linguiça", qty: 1, preco: 9 }]), versao: atual.versao }),
    pc("PUT", `/mesas/${MESA}`, { dados: mesaCom([{ id: 2, nome: "Picanha meia lua", qty: 1, preco: 15 }]), versao: atual.versao }),
  ]);
  const oks = [a, b].filter(x => x.status === 200).length;
  const conflitos = [a, b].filter(x => x.status === 409).length;
  ok(oks === 1 && conflitos === 1, `exatamente uma passou (${oks} ok, ${conflitos} conflito)`);
}

console.log("\n=== 5) mesa invalida ===");
{
  const r = await celular("PUT", "/mesas/abc", { dados: mesaCom([]) });
  ok(r.status === 400, `recusou (HTTP ${r.status})`);
  const r2 = await celular("PUT", `/mesas/${MESA}`, {});
  ok(r2.status === 400, `sem dados recusou (HTTP ${r2.status})`);
}

console.log("\n=== 6) gravar sem versao nao passa por cima ===");
{
  const r = await celular("PUT", `/mesas/${MESA}`, { dados: mesaCom([{ id: 9, nome: "Cache velho", qty: 5, preco: 1 }]) });
  ok(r.status === 409 && !!r.corpo.dados, `recusou e devolveu o estado atual (HTTP ${r.status})`);
}

// Limpeza: devolve a mesa de teste ao estado vazio
await celular("PUT", `/mesas/${MESA}`, { dados: mesaCom([]), versao: await versaoAtual() });

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
