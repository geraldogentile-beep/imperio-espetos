// Abrir caixa, saídas/reforços e conferência da gaveta no fechamento.
//   TESTE_URL=http://localhost:3000 node scripts/caixa.test.mjs   (dentro de backend/)
// Precisa de MongoDB com banco de teste LIMPO (o período de caixa é global).

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const cent = (v) => Math.round(Number(v) * 100);

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
const venda = async (total, extra = {}) => {
  const r = await api("POST", "/vendas-salao", { mesa: 52, itens: [{ id: 1, nome: "Alcatra", qty: 1, preco: total }], subtotal: total, desconto: 0, total, pagamento: "dinheiro", fechamento: new Date().toISOString(), ...extra });
  if (r.status !== 201) throw new Error("venda nao gravou: " + JSON.stringify(r.corpo));
  return r.corpo;
};

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) só o dono mexe na gaveta ===");
{
  for (const [m, rota, corpo] of [["GET", "/caixa/conferencia"], ["POST", "/caixa/abrir", { valor: 10 }], ["POST", "/caixa/movimento", { tipo: "reforco", valor: 10 }]]) {
    const r = await api(m, rota, corpo, tokenGarcom);
    ok(r.status === 403, `${m} ${rota} -> ${r.status}`);
  }
}

console.log("\n=== 2) abrir caixa ===");
{
  const antes = (await api("GET", "/caixa/conferencia")).corpo;
  ok(antes.abertura === null && antes.esperadoComDelivery === 0, "antes de abrir: sem fundo, esperado 0");
  const inv = await api("POST", "/caixa/abrir", { valor: "abc" });
  ok(inv.status === 400, `valor inválido recusado (HTTP ${inv.status})`);
  const r = await api("POST", "/caixa/abrir", { valor: "150,00" });
  ok(r.status === 201 && cent(r.corpo.abertura.valor) === 15000, "abriu com R$ 150,00 (valor em formato brasileiro)");
  const r2 = await api("POST", "/caixa/abrir", { valor: 180 });
  ok(r2.status === 200 && r2.corpo.corrigido === true && cent(r2.corpo.abertura.valor) === 18000, "abrir de novo no mesmo período CORRIGE o fundo, não duplica");
  const c = (await api("GET", "/caixa/conferencia")).corpo;
  ok(cent(c.abertura) === 18000 && cent(c.esperadoComDelivery) === 18000, `esperado agora = fundo (R$ ${c.esperadoComDelivery})`);
  const zero = await api("POST", "/caixa/abrir", { valor: 0 });
  ok(zero.status === 200, "abrir com 0 é permitido (gaveta vazia)");
  await api("POST", "/caixa/abrir", { valor: 180 });
}

console.log("\n=== 3) vendas em dinheiro entram líquidas do troco ===");
{
  // Conta de R$ 42 em dinheiro, cliente deu R$ 50: ficam R$ 42 na gaveta
  await venda(42, { recebidoDinheiro: 50, troco: 8 });
  // Comanda mista: 30 em dinheiro + 36,33 no cartão (com gorjeta paga junto)
  await venda(60.3, { pagamento: "misto", pagamentos: [{ tipo: "dinheiro", valor: 30 }, { tipo: "cartao", valor: 36.33 }], gorjeta: 6.03, subtotal: 67, desconto: 6.7 });
  await venda(25, { pagamento: "pix" });
  const c = (await api("GET", "/caixa/conferencia")).corpo;
  ok(cent(c.dinheiroSalao) === 4200 + 3000, `dinheiro do salão R$ ${c.dinheiroSalao} (42 + 30; pix e cartão fora; troco já descontado)`);
  ok(cent(c.esperadoComDelivery) === 18000 + 7200, `esperado R$ ${c.esperadoComDelivery}`);
}

console.log("\n=== 4) saídas, reforço e gasto pago da gaveta ===");
let idRetirada, idGastoMotoboy;
{
  const inv = await api("POST", "/caixa/movimento", { tipo: "sangria", valor: 10 });
  ok(inv.status === 400, "tipo desconhecido recusado");
  const banco = await api("POST", "/caixa/movimento", { tipo: "retirada", valor: "100,00", motivo: "Levado ao banco" });
  ok(banco.status === 201 && banco.corpo.movimento?.tipo === "retirada", "retirada para o banco (só movimento, não é gasto)");
  idRetirada = banco.corpo.movimento._id;
  const moto = await api("POST", "/caixa/movimento", { tipo: "retirada", valor: 45, motivo: "3 entregas do João", gasto: { tipo: "Entregador / motoboy" } });
  ok(moto.status === 201 && moto.corpo.gasto?.doCaixa === true && moto.corpo.gasto?.tipo === "Entregador / motoboy" && moto.corpo.gasto?.descricao === "3 entregas do João", "pagar motoboy vira GASTO pago da gaveta");
  idGastoMotoboy = moto.corpo.gasto._id;
  const ref = await api("POST", "/caixa/movimento", { tipo: "reforco", valor: 20, motivo: "moedas" });
  ok(ref.status === 201, "reforço de troco");
  // Gasto lançado pela tela de Gastos marcado como pago da gaveta, com a hora de agora
  const gelo = await api("POST", "/despesas", { data: new Date().toISOString(), tipo: "Outro", valor: 12.5, descricao: "gelo", doCaixa: true });
  ok(gelo.status === 201 && gelo.corpo.doCaixa === true, "gasto 'pago com dinheiro da gaveta' pela tela de Gastos");
  // Gasto normal (não é da gaveta) não entra na conferência
  await api("POST", "/despesas", { data: new Date().toISOString(), tipo: "Energia", valor: 400 });

  const c = (await api("GET", "/caixa/conferencia")).corpo;
  ok(cent(c.retiradas) === 10000 && cent(c.reforcos) === 2000 && cent(c.gastosDoCaixa) === 4500 + 1250, `saídas ${c.retiradas}, reforços ${c.reforcos}, gastos da gaveta ${c.gastosDoCaixa} (energia ficou fora)`);
  ok(cent(c.esperadoComDelivery) === 18000 + 7200 + 2000 - 10000 - 5750, `esperado R$ ${c.esperadoComDelivery} = 180 + 72 + 20 − 100 − 57,50`);
  ok(c.movimentos.length === 4 && c.movimentos.some(m => m.tipo === "gasto" && /motoboy/i.test(m.motivo)), `lista com ${c.movimentos.length} movimentos, gasto do motoboy identificado`);
  const mes = new Date().toISOString().slice(0, 7);
  const gastosMes = (await api("GET", "/despesas?mes=" + mes)).corpo;
  ok(gastosMes.some(g => g._id === idGastoMotoboy), "o pagamento do motoboy aparece em Gastos do mês");
}

console.log("\n=== 5) fechar o caixa com a gaveta contada ===");
let fechamento;
{
  const errado = await api("POST", "/fechamento-dia", { contado: "abc" });
  ok(errado.status === 400, "contado inválido recusado");
  // Esperado 114,50; contou 110,00 -> faltou 4,50
  const r = await api("POST", "/fechamento-dia", { obs: "teste", contado: "110,00", deliveryNaGaveta: true });
  ok(r.status === 201, `fechou (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  fechamento = r.corpo;
  const cx = fechamento.caixa || {};
  ok(cent(cx.abertura) === 18000 && cent(cx.dinheiroSalao) === 7200 && cent(cx.retiradas) === 10000 && cent(cx.reforcos) === 2000 && cent(cx.gastosDoCaixa) === 5750, "fechamento guarda cada parcela da conferência");
  ok(cent(cx.esperado) === 11450 && cent(cx.contado) === 11000 && cent(cx.diferenca) === -450, `esperado ${cx.esperado}, contado ${cx.contado}, faltou ${-cx.diferenca}`);
  ok(Array.isArray(cx.movimentos) && cx.movimentos.length === 4, "movimentos ficam gravados no fechamento");
  ok(cent(fechamento.porPagamento.dinheiro) === 7200 && cent(fechamento.porPagamento.cartao) === 3633 && cent(fechamento.porPagamento.pix) === 2500, "resumo por forma de pagamento continua igual ao de antes");
}

console.log("\n=== 6) período novo começa limpo; o antigo não se mexe ===");
{
  const c = (await api("GET", "/caixa/conferencia")).corpo;
  ok(c.abertura === null && c.movimentos.length === 0 && c.esperadoComDelivery === 0, "nova gaveta: sem fundo, sem movimentos");
  const del = await api("DELETE", "/caixa/movimento/" + idRetirada);
  ok(del.status === 404, "retirada do caixa já fechado não pode ser excluída");
  await api("POST", "/caixa/abrir", { valor: 50 });
  const ref = await api("POST", "/caixa/movimento", { tipo: "reforco", valor: 5 });
  const del2 = await api("DELETE", "/caixa/movimento/" + ref.corpo.movimento._id);
  ok(del2.status === 200 && (await api("GET", "/caixa/conferencia")).corpo.movimentos.length === 0, "movimento do período aberto pode ser excluído");
  // Fechar sem contar a gaveta: permitido, fica sem diferença
  await venda(10);
  const r = await api("POST", "/fechamento-dia", {});
  ok(r.status === 201 && r.corpo.caixa.contado === null && r.corpo.caixa.diferenca === null && cent(r.corpo.caixa.esperado) === 6000, `fechar sem contar: esperado ${r.corpo.caixa.esperado}, sem diferença`);
  const semDelivery = await api("GET", "/caixa/conferencia");
  ok(semDelivery.corpo.esperadoSemDelivery === semDelivery.corpo.esperadoComDelivery, "sem delivery em dinheiro, os dois esperados são iguais");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
