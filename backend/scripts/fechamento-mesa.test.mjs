// Fechamento de mesa feito pelo servidor, junto com a venda.
//
// Parte 1 roda sem nada: node scripts/fechamento-mesa.test.mjs
// Parte 2 precisa do servidor (MongoDB): TESTE_URL=http://localhost:3000 node scripts/fechamento-mesa.test.mjs
//
// Motivo: a dona fechava a mesa 4 no caixa e ela continuava ocupada para os
// garcons e para o proprio caixa. Um garcom tinha mexido na mesa segundos
// antes (pedido de fechamento), a versao nao batia e o caixa perdia a
// disputa — com a venda ja gravada. Fechar de novo gravava em dobro.

import { aplicarPagamentoNaMesa } from "../salao/fechamento.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const qtd = (dados, id) => (dados.subComandas || []).flatMap(s => [...(s.rodadas || []).flatMap(r => r.itens), ...(s.itens || [])])
  .filter(i => i.id === id).reduce((s, i) => s + i.qty, 0);

const picanha = { id: 1, nome: "Picanha", preco: 14 };
const frango = { id: 2, nome: "Frango", preco: 9 };
const cerveja = { id: 7, nome: "Cerveja", preco: 8 };
const rodada = (itens, hora = "t") => ({ hora, itens });
const mesa = (subComandas, extra = {}) => ({ id: 4, status: "conta", garcom: "Maria", obs: "sem cebola", abertura: "a", solicitadoPor: "Maria", solicitadoEm: "s", subComandas, ...extra });

console.log("\n=== parte 1: regras do fechamento ===");
{
  const m = mesa([{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 2 }, { ...frango, qty: 1 }])] }]);
  const r = aplicarPagamentoNaMesa(m, { modo: "mesa" }, [{ ...picanha, qty: 2 }, { ...frango, qty: 1 }]);
  ok(r.status === "livre" && r.abertura === null && !r.garcom && !r.solicitadoPor && r.obs === "", "mesa paga inteira fica livre e limpa");
  ok(r.subComandas.length === 1 && !r.subComandas[0].rodadas.length, "com uma comanda vazia, como uma mesa nova");

  // garcom lancou 1 cerveja e mais 1 picanha depois que o caixa abriu a conta
  const m2 = mesa([{ id: 1, label: "Comanda 1", cliente: "", itens: [{ ...cerveja, qty: 1 }], rodadas: [rodada([{ ...picanha, qty: 3 }, { ...frango, qty: 1 }])] }]);
  const r2 = aplicarPagamentoNaMesa(m2, { modo: "mesa" }, [{ ...picanha, qty: 2 }, { ...frango, qty: 1 }]);
  ok(r2.status === "ocupada" && qtd(r2, 1) === 1 && qtd(r2, 7) === 1 && qtd(r2, 2) === 0, "o que foi lancado depois continua aberto (1 picanha + 1 cerveja)");
  ok(r2.solicitadoPor === null, "e o pedido de conta ja pago sai");

  const m3 = mesa([
    { id: 1, label: "Comanda 1", cliente: "Ana", itens: [], rodadas: [rodada([{ ...picanha, qty: 1 }])] },
    { id: 2, label: "Comanda 2", cliente: "Bia", itens: [], rodadas: [rodada([{ ...frango, qty: 2 }])] },
  ]);
  const r3 = aplicarPagamentoNaMesa(m3, { modo: "comanda", scIds: [1] }, [{ ...picanha, qty: 1 }]);
  ok(r3.subComandas.length === 1 && r3.subComandas[0].id === 2 && qtd(r3, 2) === 2, "fechar a comanda 1 deixa so a comanda 2");
  ok(r3.status === "ocupada", "mesa segue ocupada");

  const r4 = aplicarPagamentoNaMesa(m3, { modo: "comanda", scIds: [2] }, [{ ...frango, qty: 2 }]);
  ok(r4.subComandas.map(s => s.id).join() === "1", "fechar a comanda 2 deixa a 1");

  const m5 = mesa([
    { id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 1 }])] },
    { id: 2, label: "Comanda 2", cliente: "", itens: [], rodadas: [] },
  ]);
  const r5 = aplicarPagamentoNaMesa(m5, { modo: "comanda", scIds: [1] }, [{ ...picanha, qty: 1 }]);
  ok(r5.status === "livre" && r5.subComandas.length === 1 && r5.abertura === null, "sobrou so comanda vazia: mesa livre");

  const r6 = aplicarPagamentoNaMesa(m3, { modo: "parcial", scIds: [1, 2] }, [{ ...frango, qty: 1 }]);
  ok(r6.subComandas.length === 2 && qtd(r6, 2) === 1 && r6.status === "conta", "parcial mantem as comandas e o status");

  const esp = { id: 901, nome: "Funcionários", tipo: "funcionarios", icon: "👥", status: "ocupada", subComandas: [{ id: 1, label: "Comanda 1", itens: [], rodadas: [rodada([{ ...picanha, qty: 1 }])] }] };
  const r7 = aplicarPagamentoNaMesa(esp, { modo: "mesa" }, [{ ...picanha, qty: 1 }]);
  ok(r7.tipo === "funcionarios" && r7.nome === "Funcionários" && r7.status === "livre", "mesa especial continua especial");
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
  const MESA = 14;
  const naMesa = async () => ((await caixa("GET", "/mesas")).corpo.mesas || []).find(m => m.mesaId === MESA);
  const gravar = async (quem, dados) => quem("PUT", `/mesas/${MESA}`, { dados, versao: (await naMesa())?.versao });
  const venda = (itens, extra) => ({ mesa: MESA, itens, subtotal: itens.reduce((s, i) => s + i.qty * i.preco, 0), total: itens.reduce((s, i) => s + i.qty * i.preco, 0), desconto: 0, pagamento: "pix", fechamento: new Date().toISOString(), ...extra });

  console.log("\n=== parte 2a: garcom mexe na mesa logo antes do caixa fechar (o caso da mesa 4) ===");
  {
    const aberta = mesa([{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 2 }, { ...frango, qty: 1 }])] }], { id: MESA, status: "ocupada", solicitadoPor: null, solicitadoEm: null });
    await gravar(garcom, aberta);
    const vistaDoCaixa = await naMesa();
    await garcom("PUT", `/mesas/${MESA}`, { dados: { ...aberta, status: "conta", solicitadoPor: "Maria" }, versao: vistaDoCaixa.versao });
    const r = await caixa("POST", "/vendas-salao", venda([{ ...picanha, qty: 2 }, { ...frango, qty: 1 }], { liberarMesa: { mesaId: MESA, modo: "mesa" } }));
    ok(r.status === 201 && r.corpo.total === 37, `venda gravada (HTTP ${r.status})`);
    ok(r.corpo.mesaAtualizada?.dados?.status === "livre", `servidor devolve a mesa livre (versao ${r.corpo.mesaAtualizada?.versao})`);
    const depois = await naMesa();
    ok(depois.dados.status === "livre" && qtd(depois.dados, 1) === 0, "e todo aparelho passa a ver a mesa livre");
    ok(!("liberarMesa" in r.corpo), "o pedido de liberacao nao fica gravado na venda");
  }

  console.log("\n=== parte 2b: item lancado durante o pagamento fica aberto ===");
  {
    const aberta = mesa([{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 1 }])] }], { id: MESA, status: "ocupada" });
    await gravar(garcom, aberta);
    await gravar(garcom, { ...aberta, subComandas: [{ ...aberta.subComandas[0], itens: [{ ...cerveja, qty: 1 }] }] });
    const r = await caixa("POST", "/vendas-salao", venda([{ ...picanha, qty: 1 }], { liberarMesa: { mesaId: MESA, modo: "mesa" } }));
    const depois = await naMesa();
    ok(r.status === 201 && depois.dados.status === "ocupada" && qtd(depois.dados, 7) === 1 && qtd(depois.dados, 1) === 0, "cerveja continua aberta, picanha paga saiu");
    await caixa("POST", "/vendas-salao", venda([{ ...cerveja, qty: 1 }], { liberarMesa: { mesaId: MESA, modo: "mesa" } }));
    ok((await naMesa()).dados.status === "livre", "fechando a cerveja, a mesa libera");
  }

  console.log("\n=== parte 2c: comanda e parcial ===");
  {
    const aberta = mesa([
      { id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 2 }])] },
      { id: 2, label: "Comanda 2", cliente: "", itens: [], rodadas: [rodada([{ ...frango, qty: 3 }])] },
    ], { id: MESA, status: "ocupada" });
    await gravar(garcom, aberta);
    await caixa("POST", "/vendas-salao", venda([{ ...frango, qty: 1 }], { subComanda: "Comanda 2 (parcial)", parcial: true, liberarMesa: { mesaId: MESA, modo: "parcial", scIds: [2] } }));
    let d = (await naMesa()).dados;
    ok(qtd(d, 2) === 2 && qtd(d, 1) === 2 && d.subComandas.length === 2, "parcial tirou 1 frango e manteve as duas comandas");
    await caixa("POST", "/vendas-salao", venda([{ ...picanha, qty: 2 }], { subComanda: "Comanda 1", liberarMesa: { mesaId: MESA, modo: "comanda", scIds: [1] } }));
    d = (await naMesa()).dados;
    ok(d.subComandas.length === 1 && d.subComandas[0].id === 2 && d.status === "ocupada", "fechar a comanda 1 deixa a comanda 2 aberta");
    const vendas = (await caixa("GET", "/vendas-salao")).corpo.filter(v => v.mesa === MESA && v.parcial);
    ok(vendas.length === 1 && vendas[0].subComanda === "Comanda 2 (parcial)", "venda parcial guardada com a comanda de origem");
  }

  console.log("\n=== parte 2d: validacao e compatibilidade ===");
  {
    const errada = await caixa("POST", "/vendas-salao", venda([{ ...frango, qty: 1 }], { liberarMesa: { mesaId: 99, modo: "mesa" } }));
    ok(errada.status === 400, `mesa diferente da venda e recusada (HTTP ${errada.status})`);
    const semComanda = await caixa("POST", "/vendas-salao", venda([{ ...frango, qty: 1 }], { liberarMesa: { mesaId: MESA, modo: "comanda" } }));
    ok(semComanda.status === 400, `fechar comanda sem dizer qual e recusado (HTTP ${semComanda.status})`);
    const antiga = await caixa("POST", "/vendas-salao", venda([{ ...frango, qty: 1 }]));
    ok(antiga.status === 201 && !antiga.corpo.mesaAtualizada, "venda sem liberarMesa funciona como antes");
    const semVersao = await garcom("PUT", `/mesas/${MESA}`, { dados: mesa([], { id: MESA }) });
    ok(semVersao.status === 409, `gravar mesa existente sem versao e recusado (HTTP ${semVersao.status})`);
  }

  console.log("\n=== parte 2e: liberar mesa presa sem cobrar ===");
  {
    const presa = mesa([{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [rodada([{ ...picanha, qty: 2 }])] }], { id: MESA, status: "ocupada" });
    await gravar(garcom, presa);
    const vendasAntes = (await caixa("GET", "/vendas-salao")).corpo.length;
    const doGarcom = await garcom("POST", `/mesas/${MESA}/liberar`, { motivo: "conta ja paga" });
    ok(doGarcom.status === 403, `garcom nao pode (HTTP ${doGarcom.status})`);
    const semMotivo = await caixa("POST", `/mesas/${MESA}/liberar`, { motivo: "" });
    ok(semMotivo.status === 400, `sem motivo e recusado (HTTP ${semMotivo.status})`);
    const r = await caixa("POST", `/mesas/${MESA}/liberar`, { motivo: "conta ja paga no caixa" });
    ok(r.status === 200 && r.corpo.dados?.status === "livre", `adm liberou (HTTP ${r.status})`);
    ok((await naMesa()).dados.status === "livre", "todos veem a mesa livre");
    ok((await caixa("GET", "/vendas-salao")).corpo.length === vendasAntes, "nenhuma venda nova foi gravada");
  }
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
