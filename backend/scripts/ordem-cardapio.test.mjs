// Testa a ordem alfabetica do cardapio por categoria, sem navegador nem banco.
//   node scripts/ordem-cardapio.test.mjs
import fs from "fs";
const src = fs.readFileSync(new URL("../../painel/src/PainelPedidos.jsx", import.meta.url), "utf8");
const ini = src.indexOf("const compNome");
const fim = src.indexOf("function BotaoOlho");
const { ordenarCardapio } = new Function(src.slice(ini, fim) + "\nreturn { ordenarCardapio };")();

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const lista = [
  { id: 5, nome: "Picanha", categoria: "Especiais" },
  { id: 1, nome: "Frango", categoria: "Tradicionais" },
  { id: 9, nome: "água com gás", categoria: "Água" },
  { id: 2, nome: "Alcatra", categoria: "Tradicionais" },
  { id: 3, nome: "Coração", categoria: "Tradicionais" },
  { id: 8, nome: "Água sem gás", categoria: "Água" },
  { id: 4, nome: "Bala Fini", categoria: "Guloseimas" },
  { id: 7, nome: "Água tônica", categoria: "Água" },
];
const abas = ["todos", "Tradicionais", "Especiais", "Água", "Guloseimas"];

console.log("\n=== dentro da categoria, por nome ===");
{
  const r = ordenarCardapio(lista.filter(i => i.categoria === "Tradicionais"), abas).map(i => i.nome);
  ok(r.join(",") === "Alcatra,Coração,Frango", `Tradicionais: ${r.join(", ")}`);
}
console.log("\n=== acento e maiuscula nao atrapalham ===");
{
  const r = ordenarCardapio(lista.filter(i => i.categoria === "Água"), abas).map(i => i.nome);
  ok(r.join(",") === "água com gás,Água sem gás,Água tônica", `Água: ${r.join(", ")}`);
}
console.log("\n=== em 'Todos', categorias na ordem das abas e nomes dentro ===");
{
  const r = ordenarCardapio(lista, abas).map(i => i.categoria[0] + ":" + i.nome);
  ok(r.join(",") === "T:Alcatra,T:Coração,T:Frango,E:Picanha,Á:água com gás,Á:Água sem gás,Á:Água tônica,G:Bala Fini", r.join(", "));
}
console.log("\n=== nao mexe na lista original ===");
{
  const antes = lista.map(i => i.id).join(",");
  ordenarCardapio(lista, abas);
  ok(lista.map(i => i.id).join(",") === antes, "a lista de entrada continua igual");
}
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
