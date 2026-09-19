// Troca de mesa.
//
// Parte 1 roda sem nada: node scripts/troca-mesa.test.mjs
// Parte 2 precisa do servidor (MongoDB): TESTE_URL=http://localhost:3000 node scripts/troca-mesa.test.mjs
//
// Motivo: o cliente pedia, sentava, e depois queria mudar de mesa. O sistema
// nao tinha como: era lancar tudo de novo na mesa nova.

import { transferirMesa } from "../salao/transferencia.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const itensDe = (dados) => (dados.subComandas || []).flatMap(s => [...(s.rodadas || []).flatMap(r => r.itens), ...(s.itens || [])]);
const total = (dados) => itensDe(dados).reduce((s, i) => s + i.qty * i.preco, 0);

const picanha = { id: 1, nome: "Picanha", preco: 14 };
const frango = { id: 2, nome: "Frango", preco: 9 };
const cerveja = { id: 7, nome: "Cerveja", preco: 8 };
const rodada = (itens, hora = "2026-09-18T20:00:00.000Z") => ({ hora, itens });
const comanda = (id, cliente, rodadas = [], itens = []) => ({ id, label: `Comanda ${id}`, cliente, itens, rodadas });
const livre = (id) => ({ id, status: "livre", garcom: "", obs: "", abertura: null, solicitadoPor: null, solicitadoEm: null, subComandas: [comanda(1, "")] });
const mesa3 = () => ({
  id: 3, status: "ocupada", garcom: "Maria", obs: "sem cebola", abertura: "2026-09-18T19:30:00.000Z", solicitadoPor: null, solicitadoEm: null,
  subComandas: [
    comanda(1, "João", [rodada([{ ...picanha, qty: 2 }])], [{ ...cerveja, qty: 1 }]),
    comanda(2, "Ana", [rodada([{ ...frango, qty: 1 }])]),
  ],
});

console.log("\n=== parte 1: regras da troca ===");
{
  const r = transferirMesa(mesa3(), livre(7), { destinoId: 7 });
  ok(r.destino.id === 7 && r.destino.subComandas.length === 2, "mesa inteira vai para a 7 com as duas comandas");
  ok(total(r.destino) === 2 * 14 + 8 + 9, `com todos os itens (R$ ${total(r.destino)})`);
  ok(r.destino.garcom === "Maria" && r.destino.obs === "sem cebola" && r.destino.abertura === "2026-09-18T19:30:00.000Z", "garcom, observacao e horario de abertura vao junto");
  ok(r.destino.subComandas[0].rodadas[0].hora === "2026-09-18T20:00:00.000Z", "pedido ja enviado a cozinha vai com o horario original");
  ok(r.destino.subComandas[0].itens.length === 1, "e o que ainda nao foi para a cozinha tambem");
  ok(r.origem.status === "livre" && !itensDe(r.origem).length && !r.origem.garcom && !r.origem.obs && r.origem.abertura === null, "a mesa 3 fica livre e limpa");
  ok(r.juntou === false, "nao e juntar");
  ok(r.destino.id === 7 && r.origem.id === 3, "cada uma com o seu numero");

  const r2 = transferirMesa(mesa3(), null, { destinoId: 12 });
  ok(r2.destino.id === 12 && total(r2.destino) === total(mesa3()), "mesa nunca usada hoje (sem registro) tambem recebe");

  const r3 = transferirMesa(mesa3(), livre(7), { destinoId: 7, scIds: [2] });
  ok(r3.destino.subComandas.length === 1 && r3.destino.subComandas[0].cliente === "Ana", "so a comanda da Ana vai para a 7");
  ok(r3.destino.subComandas[0].label === "Comanda 1" && r3.destino.subComandas[0].id === 1, "e vira a Comanda 1 da mesa 7");
  ok(r3.origem.subComandas.length === 1 && r3.origem.subComandas[0].cliente === "João" && r3.origem.status === "ocupada", "o João continua na mesa 3");
  ok(total(r3.origem) + total(r3.destino) === total(mesa3()), "nada se perde nem duplica");
  ok(r3.destino.obs === "sem cebola" && r3.origem.obs === "sem cebola", "observacao fica nas duas (pode ser alergia)");

  const mesa7 = { id: 7, status: "ocupada", garcom: "Pedro", obs: "sem sal", abertura: "2026-09-18T19:00:00.000Z", solicitadoPor: null, solicitadoEm: null,
    subComandas: [comanda(1, "Carla", [rodada([{ ...frango, qty: 3 }])])] };
  const r4 = transferirMesa(mesa3(), mesa7, { destinoId: 7 });
  ok(r4.juntou === true, "mesa 7 ocupada: junta");
  ok(r4.destino.subComandas.map(s => s.label).join() === "Comanda 1,Comanda 2,Comanda 3", "as comandas da 3 entram como Comanda 2 e 3");
  ok(r4.destino.subComandas.map(s => s.cliente).join() === "Carla,João,Ana", "com os nomes");
  ok(total(r4.destino) === 3 * 9 + total(mesa3()), "somando tudo");
  ok(r4.destino.garcom === "Pedro" && r4.destino.obs === "sem sal / sem cebola", "garcom da mesa 7 fica; observacoes se juntam");
  ok(r4.destino.abertura === "2026-09-18T19:00:00.000Z", "vale o horario de quem chegou primeiro");
  ok(r4.movidas.map(m => `${m.de}>${m.para}`).join() === "Comanda 1>Comanda 2,Comanda 2>Comanda 3", "diz quem virou o que");

  const vazia7 = { ...livre(7), status: "ocupada", garcom: "Pedro" };   // abriu a mesa mas nao pediu nada
  const r5 = transferirMesa(mesa3(), vazia7, { destinoId: 7 });
  ok(r5.destino.subComandas.map(s => s.label).join() === "Comanda 1,Comanda 2" && r5.destino.subComandas[0].cliente === "João", "comanda vazia do destino nao fica sobrando");

  const conta = { ...mesa3(), status: "conta", solicitadoPor: "Maria", solicitadoEm: "x" };
  const r6 = transferirMesa(conta, livre(7), { destinoId: 7 });
  ok(r6.destino.status === "conta" && r6.destino.solicitadoPor === "Maria", "pedido de conta vai junto");

  const esp = { id: 902, nome: "Caixa Direto", tipo: "caixa_direto", icon: "🛒", status: "ocupada", garcom: "", obs: "", abertura: "a", subComandas: [comanda(1, "", [rodada([{ ...picanha, qty: 1 }])])] };
  const r7 = transferirMesa(esp, livre(5), { destinoId: 5 });
  ok(!r7.destino.tipo && !r7.destino.nome && r7.destino.id === 5, "do Caixa Direto para a mesa 5: a 5 continua mesa comum");
  ok(r7.origem.tipo === "caixa_direto" && r7.origem.nome === "Caixa Direto" && r7.origem.status === "livre", "e o Caixa Direto continua especial, livre");

  const erroDe = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  ok(erroDe(() => transferirMesa(mesa3(), livre(3), { destinoId: 3 }))?.message === "Escolha outra mesa", "nao troca para ela mesma");
  ok(!!erroDe(() => transferirMesa(mesa3(), { ...esp, id: 901, tipo: "funcionarios" }, { destinoId: 901 })), "nao troca para mesa especial");
  ok(erroDe(() => transferirMesa(mesa3(), livre(7), { destinoId: 7, scIds: [9] }))?.status === 409, "comanda que nao existe mais: recusa");
}

const BASE = process.env.TESTE_URL;
if (!BASE) {
  console.log("\n(parte 2 pulada: defina TESTE_URL para testar no servidor)");
} else {
  const login = async (pin) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) })).json()).token;
  const api = (tk) => async (metodo, rota, corpo) => {
    const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };
  const caixa = api(await login(process.env.TESTE_PIN || "9999"));
  const garcom = api(await login(process.env.TESTE_PIN_GARCOM || "5678"));
  const A = 13, B = 15;
  const naMesa = async (id) => ((await caixa("GET", "/mesas")).corpo.mesas || []).find(m => m.mesaId === id);
  const gravar = async (dados) => caixa("PUT", `/mesas/${dados.id}`, { dados, versao: (await naMesa(dados.id))?.versao });
  const trocar = async (quem, de, para, extra = {}) => quem("POST", `/mesas/${de}/transferir`, {
    destino: para, versao: (await naMesa(de))?.versao, versaoDestino: (await naMesa(para))?.versao ?? null, ...extra,
  });

  console.log("\n=== parte 2a: garcom troca a mesa inteira ===");
  {
    await gravar({ ...mesa3(), id: A });
    await gravar(livre(B));
    const r = await trocar(garcom, A, B);
    ok(r.status === 200, `trocou (HTTP ${r.status} ${r.corpo.erro || ""})`);
    const a = await naMesa(A), b = await naMesa(B);
    ok(a.dados.status === "livre" && !itensDe(a.dados).length, `mesa ${A} livre para todos`);
    ok(total(b.dados) === total(mesa3()) && b.dados.subComandas.length === 2, `mesa ${B} com tudo`);
    ok(r.corpo.origem.versao === a.versao && r.corpo.destino.versao === b.versao, "resposta traz as versoes novas (o aparelho nao briga depois)");
  }

  console.log("\n=== parte 2b: alguem mexeu na mesa enquanto a pessoa escolhia ===");
  {
    const viu = (await naMesa(B)).versao;
    const viuA = (await naMesa(A)).versao;
    const b = await naMesa(B);
    await caixa("PUT", `/mesas/${B}`, { dados: { ...b.dados, obs: "mudou agora" }, versao: b.versao });
    const r = await garcom("POST", `/mesas/${B}/transferir`, { destino: A, versao: viu, versaoDestino: viuA });
    ok(r.status === 409 && r.corpo.origem?.dados?.obs === "mudou agora", `recusa e devolve o estado atual (HTTP ${r.status})`);
    ok(total((await naMesa(B)).dados) === total(mesa3()) && !itensDe((await naMesa(A)).dados).length, "e nao mexeu em nada");
  }

  console.log("\n=== parte 2c: so uma comanda, depois juntar ===");
  {
    const r = await trocar(garcom, B, A, { scIds: [2] });
    ok(r.status === 200 && r.corpo.juntou === false, `Ana foi para a mesa ${A} (HTTP ${r.status})`);
    const r2 = await trocar(caixa, A, B);
    ok(r2.status === 200 && r2.corpo.juntou === true, `e voltou juntando com a mesa ${B}`);
    const b = await naMesa(B);
    ok(b.dados.subComandas.length === 2 && total(b.dados) === total(mesa3()), "tudo de volta, sem duplicar");
    ok((await naMesa(A)).dados.status === "livre", `mesa ${A} livre`);
  }

  console.log("\n=== parte 2d: destino invalido ===");
  {
    const r = await trocar(garcom, B, 901);
    ok(r.status === 400, `mesa especial recusada (HTTP ${r.status})`);
    const r2 = await trocar(garcom, B, B);
    ok(r2.status === 400, `mesma mesa recusada (HTTP ${r2.status})`);
    ok(total((await naMesa(B)).dados) === total(mesa3()), "nada mudou");
  }

  // limpa
  await gravar(livre(A));
  await gravar(livre(B));
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
