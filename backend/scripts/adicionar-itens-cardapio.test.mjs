// Teste da logica de planejamento do script de cardapio. Roda sem banco:
// planejar() e uma funcao pura, entao da para conferir o que ele FARIA antes
// de deixar ele escrever em producao.
//
//   node scripts/adicionar-itens-cardapio.test.mjs

import { planejar, NOVOS_ITENS } from "./adicionar-itens-cardapio.js";

let falhas = 0;
function ok(cond, msg) {
  console.log((cond ? "  OK   " : "  FALHA") + "  " + msg);
  if (!cond) falhas++;
}

console.log("\n=== 1) banco sem nenhum dos novos itens ===");
{
  const existentes = [
    { id: 1, nome: "Alcatra", categoria: "Tradicionais" },
    { id: 47, nome: "Monster", categoria: "Energético" },
  ];
  const r = planejar(existentes, NOVOS_ITENS);
  ok(r.inserir.length === NOVOS_ITENS.length, `insere todos os ${NOVOS_ITENS.length}`);
  ok(r.recategorizar.length === 0, "nada para mover");
  ok(r.inserir[0].id === 48, "primeiro id continua depois do maior existente (48)");
  const ids = r.inserir.map(i => i.id);
  ok(new Set(ids).size === ids.length, "ids gerados sem repetir");
  const guloseimas = r.inserir.filter(i => i.categoria === "Guloseimas").map(i => i.nome);
  ok(guloseimas.length === 5, "5 guloseimas: " + guloseimas.join(", "));
  const doces = r.inserir.filter(i => i.categoria === "Doces").map(i => i.nome);
  ok(doces.length === 1 && doces[0] === "Queijo com doce de leite", "só o espeto doce fica em Doces");
}

console.log("\n=== 2) rodada anterior deixou as guloseimas em Doces ===");
{
  const existentes = [
    { id: 47, nome: "Monster", categoria: "Energético" },
    { id: 65, nome: "Pão de mel", categoria: "Doces" },
    { id: 66, nome: "Trufa",     categoria: "Doces" },
    { id: 67, nome: "Trident",   categoria: "Doces" },
    { id: 68, nome: "Halls",     categoria: "Doces" },
    { id: 69, nome: "Mentos",    categoria: "Doces" },
    { id: 54, nome: "Queijo com doce de leite", categoria: "Doces" },
  ];
  const r = planejar(existentes, NOVOS_ITENS);
  ok(r.recategorizar.length === 5, "move exatamente os 5 que estão errados");
  ok(r.recategorizar.every(x => x.de === "Doces" && x.para === "Guloseimas"), "todos de Doces para Guloseimas");
  ok(!r.recategorizar.some(x => x.nome === "Queijo com doce de leite"), "não mexe no espeto doce");
  ok(r.pulados.includes("Queijo com doce de leite"), "espeto doce entra como já correto");
  ok(r.inserir.length === NOVOS_ITENS.length - 6, "insere só o que falta");
  ok(r.inserir[0].id === 70, "novos ids partem de 70, sem colidir");
}

console.log("\n=== 3) rodar de novo depois de tudo aplicado ===");
{
  const existentes = NOVOS_ITENS.map((it, i) => ({ id: 48 + i, nome: it.nome, categoria: it.categoria }));
  const r = planejar(existentes, NOVOS_ITENS);
  ok(r.inserir.length === 0, "não insere nada");
  ok(r.recategorizar.length === 0, "não move nada");
  ok(r.pulados.length === NOVOS_ITENS.length, "pula tudo — idempotente");
}

console.log("\n=== 4) nome com acento/caixa diferente não duplica ===");
{
  const existentes = [
    { id: 10, nome: "PAO DE MEL", categoria: "Guloseimas" },
    { id: 11, nome: "porção de arroz", categoria: "Acompanhamentos" },
  ];
  const r = planejar(existentes, NOVOS_ITENS);
  const nomesInseridos = r.inserir.map(i => i.nome);
  ok(!nomesInseridos.includes("Pão de mel"), "'PAO DE MEL' já conta como Pão de mel");
  ok(!nomesInseridos.includes("Porção de arroz"), "'porção de arroz' já conta");
}

console.log("\n=== 5) item existente com preço editado à mão ===");
{
  const existentes = [{ id: 80, nome: "Mandioca", categoria: "Acompanhamentos", preco: 7.5 }];
  const r = planejar(existentes, NOVOS_ITENS);
  ok(!r.inserir.some(i => i.nome === "Mandioca"), "não recria Mandioca");
  ok(!r.recategorizar.some(x => x.nome === "Mandioca"), "não mexe: categoria já está certa");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
