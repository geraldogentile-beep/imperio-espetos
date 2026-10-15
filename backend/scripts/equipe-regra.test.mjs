// Regras de preço do consumo da equipe, sem servidor nem banco.
//   node scripts/equipe-regra.test.mjs   (dentro de backend/)

import { ehDono, espetosNoItem, precoFuncionario, custoDaLinha, calcularConsumo, valorEfetivo, EQUIPE_PADRAO } from "../salao/equipe.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const cardapio = [
  { id: 1, nome: "Alcatra", categoria: "Tradicionais", preco: 9 },
  { id: 2, nome: "Picanha meia lua", categoria: "Especiais", preco: 15 },
  { id: 3, nome: "Heineken Long Neck", categoria: "Cervejas", preco: 12 },
  { id: 4, nome: "Lanche Imperial", categoria: "Refeições", preco: 6 },
];
const estoques = [
  { nome: "Alcatra", cardapioNomes: ["Alcatra"], custoPorUnidade: 3.8, consumoPorVenda: 1 },
  { nome: "Picanha", cardapioNomes: ["Picanha meia lua"], custoPorUnidade: 6.5, consumoPorVenda: 1 },
  { nome: "Pão", cardapioNomes: ["Lanche Imperial"], custoPorUnidade: 1.2, consumoPorVenda: 1 },
  { nome: "Cerveja", cardapioNomes: ["Heineken Long Neck"], custoPorUnidade: 0, consumoPorVenda: 1 },   // sem custo
];

console.log("\n=== 1) quem é dono ===");
ok(EQUIPE_PADRAO.donos.join(",") === "Daiane,Rafael,Amanda,Leonardo", "donos padrão: Daiane, Rafael, Amanda, Leonardo");
for (const n of ["Rafael", "rafael", "RAFAEL", "  Rafael ", "Rafael Silva", "Amanda", "Leonardo", "Daiane"]) ok(ehDono(n), `"${n}" é dono`);
for (const n of ["Rafaela", "João", "", "Sem nome", "Leo"]) ok(!ehDono(n), `"${n}" não é dono`);

console.log("\n=== 2) funcionário: R$ 2,00 a menos por espeto ===");
ok(espetosNoItem(cardapio[0], cardapio) === 1 && espetosNoItem({ id: 3, nome: "Heineken Long Neck", preco: 12 }, cardapio) === 0, "espeto conta 1, cerveja conta 0 (categoria vem do cardápio)");
ok(precoFuncionario({ id: 1, nome: "Alcatra", preco: 9 }, cardapio) === 7, "Alcatra R$ 9,00 -> R$ 7,00");
ok(precoFuncionario({ id: 2, nome: "Picanha meia lua", preco: 15 }, cardapio) === 13, "Picanha R$ 15,00 -> R$ 13,00");
ok(precoFuncionario({ id: 3, nome: "Heineken Long Neck", preco: 12 }, cardapio) === 12, "Cerveja: preço cheio");
const lanche2 = { id: 4, nome: "Lanche Imperial (Alcatra + Picanha meia lua)", nomeBase: "Lanche Imperial", preco: 30, espetos: ["Alcatra", "Picanha meia lua"] };
ok(espetosNoItem(lanche2, cardapio) === 2 && precoFuncionario(lanche2, cardapio) === 26, "Lanche com 2 espetos R$ 30,00 -> R$ 26,00 (2 x R$ 2)");
ok(precoFuncionario({ id: 1, nome: "Alcatra", preco: 1 }, cardapio) === 0, "nunca fica negativo");
ok(precoFuncionario({ id: 1, nome: "Alcatra", preco: 9 }, cardapio, 3) === 6, "desconto configurável (R$ 3 -> R$ 6,00)");

console.log("\n=== 3) dono: preço de custo ===");
ok(custoDaLinha({ id: 1, nome: "Alcatra", qty: 2, preco: 9 }, estoques).custo === 7.6, "2 Alcatra a R$ 3,80 = R$ 7,60");
const cl = custoDaLinha({ ...lanche2, qty: 1 }, estoques);
ok(cl.custo === 11.5 && cl.semCusto === 0, `Lanche = pão 1,20 + alcatra 3,80 + picanha 6,50 = R$ ${cl.custo}`);
const cc = custoDaLinha({ id: 3, nome: "Heineken Long Neck", qty: 1, preco: 12 }, estoques);
ok(cc.custo === 0 && cc.semCusto === 1, "cerveja sem custo cadastrado: avisa (semCusto)");

console.log("\n=== 4) registro completo ===");
const itens = [{ id: 1, nome: "Alcatra", qty: 2, preco: 9, categoria: "Tradicionais" }, { id: 3, nome: "Heineken Long Neck", qty: 1, preco: 12, categoria: "Cervejas" }];
const dono = calcularConsumo({ pessoa: "Amanda", itens, cardapio, estoques });
ok(dono.tipo === "dono" && dono.custo === 7.6 && dono.valorRegra === 7.6 && dono.semCusto === 1, `Amanda (dona): paga o custo R$ ${dono.valorRegra}, 1 item sem custo`);
const func = calcularConsumo({ pessoa: "João", itens, cardapio, estoques });
ok(func.tipo === "funcionario" && func.valorRegra === 26, `João (funcionário): 2 x R$ 7 + R$ 12 = R$ ${func.valorRegra}`);
ok(valorEfetivo({ ...func, valor: null }) === 26 && valorEfetivo({ ...func, valor: 20 }) === 20, "funcionário: valor editado à mão vale; sem edição, vale a regra");
ok(valorEfetivo({ ...dono, valor: 99 }) === 7.6, "dono: sempre o custo (edição não se aplica)");
const outraConfig = calcularConsumo({ pessoa: "João", itens, cardapio, estoques, config: { donos: ["João"], descontoEspeto: 2 } });
ok(outraConfig.tipo === "dono", "a lista de donos vem da config");

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
