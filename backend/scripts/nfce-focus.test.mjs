// Emissao de NFC-e pela Focus NFe, de ponta a ponta, contra o simulador.
//
// Precisa de MongoDB e de dois processos:
//   node scripts/focus-simulador.mjs                                  (porta 3989)
//   FOCUS_BASE_URL=http://localhost:3989 FOCUS_TIMEOUT_MS=1500 node server.js
// e entao, dentro de backend/:
//   TESTE_URL=http://localhost:3000 FOCUS_SIM_URL=http://localhost:3989 node scripts/nfce-focus.test.mjs
//
// O que importa aqui e o que a SEFAZ confere: soma dos itens menos descontos
// igual a soma dos pagamentos, gorjeta fora da nota, codigos de pagamento, e
// que uma queda de rede no meio da emissao nao vire nota em dobro.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const SIM = process.env.FOCUS_SIM_URL || "http://localhost:3989";
const TOKEN_SIM = process.env.FOCUS_SIM_TOKEN || "tok-teste";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const cent = (v) => Math.round(Number(v) * 100);

const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.TESTE_PIN || "9999" }) });
  if (!r.ok) throw new Error(`login falhou: ${r.status}`);
  return (await r.json()).token;
})();
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const noSimulador = async (ref) => (await (await fetch(SIM + "/__notas")).json()).find(n => n.ref === ref);

const venda = async (itens, extra) => {
  const subtotal = itens.reduce((s, i) => s + i.qty * i.preco, 0);
  const r = await api("POST", "/vendas-salao", {
    mesa: 50, itens, subtotal, desconto: 0, total: subtotal, pagamento: "pix",
    fechamento: new Date().toISOString(), ...extra,
  });
  if (r.status !== 201) throw new Error("venda nao gravou: " + JSON.stringify(r.corpo));
  return r.corpo;
};

console.log(`\nServidor: ${BASE}   Simulador: ${SIM}\n`);

console.log("=== 1) configuracao ===");
{
  const r = await api("PUT", "/config/fiscal", {
    ativo: true, ambiente: "homologacao", provedor: "focusnfe", apiToken: TOKEN_SIM,
    cnpj: "12.345.678/0001-95", padroes: { ncm: "16025000", cfop: "5101", csosn: "102", origem: "0", unidade: "UN" },
    cartaoCodigo: "03", pixCodigo: "20", pisCst: "49", cofinsCst: "49",
  });
  ok(r.status === 200, `salvou (HTTP ${r.status})`);
  ok(r.corpo.apiToken?.startsWith("****"), "o token volta mascarado para o painel");
  const st = (await api("GET", "/config/fiscal/status")).corpo;
  ok(st.pronto === true, `pronto para emitir com Focus sem CSC/IE aqui (faltando: ${JSON.stringify(st.faltando)})`);
  const t = (await api("POST", "/config/fiscal/testar")).corpo;
  ok(t.ok === true, `token testado: ${t.mensagem}`);
}

console.log("\n=== 2) token errado e detectado sem emitir nada ===");
{
  await api("PUT", "/config/fiscal", { apiToken: "token-errado" });
  const t = (await api("POST", "/config/fiscal/testar")).corpo;
  ok(t.ok === false && /recusado/i.test(t.mensagem), `recusado: ${t.mensagem}`);
  await api("PUT", "/config/fiscal", { apiToken: TOKEN_SIM });
}

console.log("\n=== 3) venda simples no pix ===");
let notaSimples;
{
  const v = await venda([{ id: 1, nome: "Alcatra", qty: 5, preco: 9 }], { pagamento: "pix" });
  const r = await api("POST", "/notas/emitir", { vendaId: v._id });
  ok(r.status === 200, `autorizada (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  ok(/^\d{44}$/.test(r.corpo.chave || ""), `chave com 44 digitos (${r.corpo.chave})`);
  ok(/^https?:\/\/.+\.html$/.test(r.corpo.danfeUrl || ""), "link da DANFE absoluto");
  ok(r.corpo.numero > 0 && r.corpo.serie === 1, `numero ${r.corpo.numero}, serie ${r.corpo.serie}`);
  notaSimples = r.corpo;

  const lista = (await api("GET", "/notas")).corpo;
  const nota = (lista.notas || lista).find(n => String(n._id) === String(r.corpo.notaId));
  ok(/^imp[a-f0-9]{24}$/.test(nota?.refExterna || ""), `referencia so com letras e numeros (${nota?.refExterna})`);
  const sim = await noSimulador(nota.refExterna);
  const fp = sim.corpo.formas_pagamento;
  ok(fp.length === 1 && fp[0].forma_pagamento === "20" && fp[0].valor_pagamento === 45 && !fp[0].tipo_integracao, `pix estatico 20, R$ 45, sem grupo de cartao (${JSON.stringify(fp)})`);
  ok(sim.corpo.presenca_comprador === "1" && !sim.corpo.cpf_destinatario, "presencial e sem CPF");
  ok(sim.corpo.items[0].codigo_produto === "1" && sim.corpo.items[0].pis_situacao_tributaria === "49", "codigo do produto e PIS 49");

  const dup = await api("POST", "/notas/emitir", { vendaId: v._id });
  ok(dup.status === 409, `segunda emissao da mesma venda recusada (HTTP ${dup.status})`);
}

console.log("\n=== 4) desconto + gorjeta + dinheiro e cartao ===");
{
  // 3x14 + 2x9 + 1x7 = 67; desconto 10% = 6,70 -> total 60,30; gorjeta 6,03
  const itens = [{ id: 2, nome: "Picanha", qty: 3, preco: 14 }, { id: 3, nome: "Frango", qty: 2, preco: 9 }, { id: 4, nome: "Refri lata", qty: 1, preco: 7 }];
  const v = await venda(itens, {
    subtotal: 67, desconto: 6.7, descontoTipo: "percentual", descontoInfo: "10%", total: 60.3,
    gorjeta: 6.03, gorjetaTipo: "percentual", gorjetaInfo: "10%",
    pagamento: "misto", pagamentos: [{ tipo: "dinheiro", valor: 30 }, { tipo: "cartao", valor: 36.33 }],
  });
  const r = await api("POST", "/notas/emitir", { vendaId: v._id, cpfCliente: "123.456.789-09" });
  ok(r.status === 200, `autorizada (HTTP ${r.status}) ${r.corpo.erro || ""} ${JSON.stringify(r.corpo.detalhes || "")}`);

  const lista = (await api("GET", "/notas")).corpo;
  const nota = (lista.notas || lista).find(n => String(n._id) === String(r.corpo.notaId));
  const sim = await noSimulador(nota.refExterna);
  const bruto = sim.corpo.items.reduce((s, i) => s + cent(i.valor_bruto), 0);
  const desc = sim.corpo.items.reduce((s, i) => s + cent(i.valor_desconto || 0), 0);
  const pagos = sim.corpo.formas_pagamento.reduce((s, f) => s + cent(f.valor_pagamento), 0);
  ok(bruto === 6700 && desc === 670, `itens R$ ${bruto / 100}, desconto rateado R$ ${desc / 100}`);
  ok(pagos === 6030, `pagamentos na nota R$ ${pagos / 100} = valor da venda, gorjeta fora`);
  const cartao = sim.corpo.formas_pagamento.find(f => f.forma_pagamento === "03");
  ok(cartao?.tipo_integracao === "2", `cartao como credito 03 com maquininha nao integrada (${JSON.stringify(cartao)})`);
  ok(sim.corpo.cpf_destinatario === "12345678909", "CPF na nota");
  ok(nota.valorTotal === 60.3, `nota registrada com R$ ${nota.valorTotal}`);
}

console.log("\n=== 5) SEFAZ rejeita ===");
{
  const v = await venda([{ id: 90, nome: "Item REJEITAR", qty: 1, preco: 10 }]);
  const r = await api("POST", "/notas/emitir", { vendaId: v._id });
  ok(r.status === 502 && r.corpo.status === "rejeitada", `rejeitada (HTTP ${r.status}, ${r.corpo.status})`);
  ok(/778/.test(r.corpo.erro || "") && /NCM/.test(r.corpo.erro || ""), `motivo da SEFAZ chega ao painel: ${r.corpo.erro}`);
  const vendas = (await api("GET", "/vendas-salao")).corpo;
  ok(vendas.find(x => x._id === v._id)?.notaFiscalStatus === "rejeitada", "venda marcada como rejeitada");
}

console.log("\n=== 6) a conexao cai depois de autorizar: nao duplica ===");
{
  const v = await venda([{ id: 91, nome: "Espeto QUEDA", qty: 2, preco: 10 }]);
  const r = await api("POST", "/notas/emitir", { vendaId: v._id });
  ok(r.status === 200, `recuperou pela consulta e marcou autorizada (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  const todas = await (await fetch(SIM + "/__notas")).json();
  const destaVenda = todas.filter(n => n.corpo.items.some(i => /QUEDA/.test(i.descricao)));
  ok(destaVenda.length === 1, `uma nota so no provedor (${destaVenda.length})`);
}

console.log("\n=== 7) resposta demorada: fica em processamento e a consulta resolve ===");
{
  const v = await venda([{ id: 92, nome: "Espeto LENTO", qty: 1, preco: 12 }]);
  const r = await api("POST", "/notas/emitir", { vendaId: v._id });
  // com FOCUS_TIMEOUT_MS=1500 a chamada estoura, e a consulta tambem estoura
  // enquanto o simulador segura a resposta: resultado incerto
  ok(r.corpo.status === "processando" || r.status === 200, `ficou ${r.corpo.status || "autorizada"} (HTTP ${r.status})`);
  if (r.corpo.status === "processando") {
    const outra = await api("POST", "/notas/emitir", { vendaId: v._id });
    ok(outra.status === 409, `nova emissao bloqueada enquanto processa (HTTP ${outra.status})`);
    await new Promise(res => setTimeout(res, 3500));
    const c = await api("POST", `/notas/${r.corpo.notaId}/consultar`);
    ok(c.corpo.status === "autorizada", `consulta resolveu: ${c.corpo.status} ${c.corpo.erro || ""}`);
  }
}

console.log("\n=== 8) cancelamento ===");
{
  const curto = await api("POST", `/notas/${notaSimples.notaId}/cancelar`, { motivo: "errado" });
  ok(curto.status === 400, `motivo curto recusado (HTTP ${curto.status})`);
  const c = await api("POST", `/notas/${notaSimples.notaId}/cancelar`, { motivo: "Cliente desistiu da compra no balcao" });
  ok(c.status === 200, `cancelada (HTTP ${c.status}) ${c.corpo.erro || ""}`);
  const lista = (await api("GET", "/notas")).corpo;
  const nota = (lista.notas || lista).find(n => String(n._id) === String(notaSimples.notaId));
  ok(nota?.status === "cancelada", `nota cancelada no sistema (${nota?.status})`);
  const sim = await noSimulador(nota.refExterna);
  ok(sim.status === "cancelado", "e cancelada no provedor");
}

console.log("\n=== 9) pedido de delivery sem forma de pagamento marcada ===");
{
  const r = await api("POST", "/notas/emitir", { pedidoId: "NAOEXISTE" });
  ok(r.status === 404, `pedido inexistente (HTTP ${r.status})`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
