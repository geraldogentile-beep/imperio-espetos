// Contas da NFC-e sem rede nem banco: rateio do desconto e pagamentos.
//   node scripts/nfce-montagem.test.mjs
import { ratearDesconto, montarFormasPagamento, montarNfce, dataEmissaoBrasilia, refDaNota } from "../fiscal/focusnfe.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const cent = (v) => Math.round(Number(v) * 100);
const soma = (l) => l.reduce((s, v) => s + cent(v), 0);
const cfg = { cnpj: "12345678000195", cartaoCodigo: "03", pixCodigo: "20", pisCst: "49", cofinsCst: "49" };

console.log("\n=== rateio do desconto fecha no centavo ===");
{
  const itens = [{ valorTotal: 10 }, { valorTotal: 10 }, { valorTotal: 10 }];
  const d = ratearDesconto(itens, 1);   // 1/3 de 1 real nao e exato
  ok(soma(d) === 100, `R$ 1,00 dividido em 3: ${d.join(" + ")}`);
  const d2 = ratearDesconto([{ valorTotal: 0.01 }, { valorTotal: 99.99 }], 50);
  ok(soma(d2) === 5000 && d2[0] <= 0.01, `desconto nunca passa do item: ${d2.join(" + ")}`);
  ok(ratearDesconto(itens, 0).every(v => v === 0), "sem desconto, zero em todos");
  let lancou = false; try { ratearDesconto(itens, 31); } catch { lancou = true; }
  ok(lancou, "desconto maior que os itens e recusado");
}

console.log("\n=== pagamentos: gorjeta sai, soma bate com a nota ===");
{
  const f = montarFormasPagamento([{ tipo: "dinheiro", valor: 33.33 }, { tipo: "cartao", valor: 33.34 }], 60.3, cfg);
  ok(soma(f.map(x => x.valor_pagamento)) === 6030, `R$ 66,67 pagos, nota de R$ 60,30: ${JSON.stringify(f)}`);
  const exato = montarFormasPagamento([{ tipo: "pix", valor: 45 }], 45, cfg);
  ok(exato.length === 1 && exato[0].valor_pagamento === 45 && exato[0].forma_pagamento === "20", "pix exato fica igual");
  const deb = montarFormasPagamento([{ tipo: "cartao", valor: 10 }], 10, { ...cfg, cartaoCodigo: "04" });
  ok(deb[0].forma_pagamento === "04" && deb[0].tipo_integracao === "2", "cartao configurado como debito");
  const pixDin = montarFormasPagamento([{ tipo: "pix", valor: 10 }], 10, { ...cfg, pixCodigo: "17" });
  ok(pixDin[0].forma_pagamento === "17" && pixDin[0].tipo_integracao === "2", "pix dinamico leva grupo de integracao");
  let lancou = false; try { montarFormasPagamento([{ tipo: "pix", valor: 40 }], 45, cfg); } catch { lancou = true; }
  ok(lancou, "pagamento menor que a nota e recusado");
  lancou = false; try { montarFormasPagamento([], 45, cfg); } catch { lancou = true; }
  ok(lancou, "venda sem pagamento e recusada");
}

console.log("\n=== montagem completa ===");
{
  const itens = [
    { codigo: 7, nome: "Cerveja lata", quantidade: 2, valorUnitario: 8, valorTotal: 16, ncm: "2203.00.00", cfop: "5405", csosn: "500", cest: "03.021.00", origem: "0", unidade: "UN" },
    { codigo: 1, nome: "Alcatra", quantidade: 3, valorUnitario: 9, valorTotal: 27, ncm: "16025000", cfop: "5101", csosn: "102", origem: "0", unidade: "UN" },
  ];
  const n = montarNfce({ cfg, itens, valorNota: 40, pagamentos: [{ tipo: "pix", valor: 40 }], cpf: "", nome: "—" });
  ok(n.items[0].codigo_ncm === "22030000" && n.items[0].cest === "0302100", "NCM e CEST so com digitos");
  ok(soma(n.items.map(i => i.valor_desconto || 0)) === 300, "desconto de R$ 3 rateado");
  ok(n.presenca_comprador === "1" && !("cpf_destinatario" in n), "presencial e sem CPF");
  const e = montarNfce({ cfg, itens, valorNota: 43, pagamentos: [{ tipo: "dinheiro", valor: 43 }], entrega: true });
  ok(e.presenca_comprador === "4" && !e.items.some(i => i.valor_desconto), "delivery = entrega em domicilio, sem desconto");
  let lancou = false; try { montarNfce({ cfg, itens, valorNota: 50, pagamentos: [{ tipo: "pix", valor: 50 }] }); } catch { lancou = true; }
  ok(lancou, "venda maior que os itens e recusada");
}

console.log("\n=== data e referencia ===");
{
  const d = dataEmissaoBrasilia(new Date("2026-09-16T15:30:00Z"));
  ok(d === "2026-09-16T12:30:00-03:00", `horario de Brasilia com fuso: ${d}`);
  ok(refDaNota("6aaa25b3e578cd91451d85e8") === "imp6aaa25b3e578cd91451d85e8", "referencia so com letras e numeros");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
