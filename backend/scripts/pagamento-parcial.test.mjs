// Pagamento de parte da comanda: o que sai da mesa e o que fica.
//   node scripts/pagamento-parcial.test.mjs
import fs from "fs";

const src = fs.readFileSync(new URL("../../painel/src/PainelPedidos.jsx", import.meta.url), "utf8");
const ini = src.indexOf("function chaveItem(it)");
const fim = src.indexOf("// Itens em ordem alfabetica dentro de cada categoria");
const { chaveItem, juntarItens, removerItensPagos } = new Function(
  src.slice(ini, fim) + "\nreturn { chaveItem, juntarItens, removerItensPagos };"
)();

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const qtd = (mesa, id, variacao = "") => mesa.subComandas.flatMap(sc => [...sc.rodadas.flatMap(r => r.itens), ...sc.itens])
  .filter(i => i.id === id && (i.variacao || "") === variacao).reduce((s, i) => s + i.qty, 0);

const picanha = { id: 1, nome: "Picanha", preco: 14 };
const frango = { id: 2, nome: "Frango", preco: 9 };
const lancheCarne = { id: 5, nome: "Lanche (Picanha)", variacao: "Picanha", preco: 25 };
const lancheFrango = { id: 5, nome: "Lanche (Frango)", variacao: "Frango", preco: 20 };

const mesa = () => ({
  id: 3, status: "ocupada",
  subComandas: [
    { id: 1, label: "Comanda 1", itens: [{ ...picanha, qty: 1 }], rodadas: [
      { hora: "t1", itens: [{ ...picanha, qty: 2 }, { ...frango, qty: 1 }] },
      { hora: "t2", itens: [{ ...frango, qty: 2 }, { ...lancheCarne, qty: 1 }, { ...lancheFrango, qty: 1 }] },
    ] },
    { id: 2, label: "Comanda 2", itens: [], rodadas: [{ hora: "t3", itens: [{ ...picanha, qty: 4 }] }] },
  ],
});

console.log("\n=== juntar linhas iguais ===");
{
  const j = juntarItens(mesa().subComandas[0].rodadas.flatMap(r => r.itens).concat(mesa().subComandas[0].itens));
  ok(j.find(i => i.id === 1).qty === 3 && j.find(i => i.id === 2).qty === 3, "picanha 3, frango 3");
  ok(j.filter(i => i.id === 5).length === 2, "lanche com carnes diferentes fica em duas linhas");
}

console.log("\n=== paga parte da comanda 1 ===");
{
  const antes = mesa();
  const depois = removerItensPagos(antes, [0], [{ ...picanha, qty: 2 }, { ...frango, qty: 1 }, { ...lancheFrango, qty: 1 }]);
  ok(qtd(depois, 1) === 1 + 4, `sobra 1 picanha na comanda 1 (+4 da comanda 2): ${qtd(depois, 1)}`);
  ok(qtd(depois, 2) === 2, `sobram 2 frangos: ${qtd(depois, 2)}`);
  ok(qtd(depois, 5, "Frango") === 0 && qtd(depois, 5, "Picanha") === 1, "sai o lanche de frango, fica o de picanha");
  ok(depois.subComandas[0].rodadas[0].hora === "t2", "a rodada que ficou vazia some; as outras mantem a hora");
  ok(depois.subComandas[0].itens.length === 1, "o item ainda nao enviado fica (as rodadas pagam primeiro)");
  ok(JSON.stringify(depois.subComandas[1]) === JSON.stringify(antes.subComandas[1]), "comanda 2 nao muda");
  ok(qtd(antes, 1) === 7, "a mesa original nao foi alterada");
}

console.log("\n=== mesa inteira: pega das duas comandas ===");
{
  const depois = removerItensPagos(mesa(), [0, 1], [{ ...picanha, qty: 5 }]);
  ok(qtd(depois, 1) === 2, `de 7 picanhas sobram 2: ${qtd(depois, 1)}`);
  ok(depois.subComandas[0].rodadas.every(r => !r.itens.some(i => i.id === 1)), "comanda 1 perde as 2 das rodadas primeiro");
  ok(depois.subComandas[0].itens.length === 0, "e a pendente tambem");
  ok(qtd({ subComandas: [depois.subComandas[1]] }, 1) === 2, "comanda 2 fica com 2");
}

console.log("\n=== pedir mais do que existe nao inventa nada ===");
{
  const depois = removerItensPagos(mesa(), [1], [{ ...picanha, qty: 10 }, { ...frango, qty: 3 }]);
  ok(depois.subComandas[1].rodadas.length === 0, "comanda 2 zera");
  ok(qtd(depois, 2) === 3, "frango da comanda 1 nao e tocado (fora do escopo)");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
