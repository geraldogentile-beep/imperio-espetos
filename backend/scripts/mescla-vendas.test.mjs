// Testa a mesclagem da lista de vendas (servidor x aparelho) sem banco nem React.
//
//   node scripts/mescla-vendas.test.mjs
//
// Motivo: a tela de fechamento mostrava "Salao R$ 115" e "Pagamentos R$ 892".
// O total vinha do servidor (periodo aberto); os pagamentos vinham da lista
// local, que nunca descartava venda de ontem. Ver mesclarVendasServidor.

import fs from "fs";

const src = fs.readFileSync(new URL("../../painel/src/PainelPedidos.jsx", import.meta.url), "utf8");
const ini = src.indexOf("const JANELA_VENDA_RECENTE_MS");
const fim = src.indexOf("function chaveItem");
const { mesclarVendasServidor } = new Function(src.slice(ini, fim) + "\nreturn { mesclarVendasServidor };")();

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const AGORA = new Date(2026, 8, 13, 14, 0, 0).getTime();          // dom 13/09 14:00
const venda = (id, total, quandoMs) => ({ _id: id, total, pagamento: "pix", fechamento: new Date(quandoMs).toISOString() });
const H = 60 * 60 * 1000;
const soma = (l) => l.reduce((s, v) => s + v.total, 0);

console.log("\n=== o que o servidor nao devolve mais some da tela ===");
{
  const ontem = [venda("a", 300, AGORA - 20 * H), venda("b", 477, AGORA - 18 * H)]; // sabado a noite
  const hoje  = [venda("c", 65, AGORA - 2 * H), venda("d", 50, AGORA - 1 * H)];
  const local = [...ontem, ...hoje];
  const r = mesclarVendasServidor(local, hoje, AGORA);
  ok(r.length === 2, `ficam so as vendas do periodo aberto (${r.length})`);
  ok(soma(r) === 115, `e a soma bate com o servidor: R$ ${soma(r)}`);
  ok(!r.some(v => v._id === "a" || v._id === "b"), "as de sabado foram embora");
}

console.log("\n=== fechar o caixa zera a lista ===");
{
  const local = [venda("c", 65, AGORA - 2 * H), venda("d", 50, AGORA - 1 * H)];
  const r = mesclarVendasServidor(local, [], AGORA);
  ok(r.length === 0, `servidor vazio depois do fechamento -> tela vazia (${r.length})`);
}

console.log("\n=== venda fechada agora ha pouco nao pisca fora da tela ===");
{
  // A consulta saiu antes do POST terminar: o servidor ainda nao lista a venda "e"
  const local = [venda("c", 65, AGORA - 2 * H), venda("e", 40, AGORA - 30 * 1000)];
  const r = mesclarVendasServidor(local, [venda("c", 65, AGORA - 2 * H)], AGORA);
  ok(r.some(v => v._id === "e"), "a venda de 30s atras continua na tela");
  ok(r.length === 2, `sem duplicar as que o servidor ja tem (${r.length})`);
}

console.log("\n=== a mesma venda nos dois lados entra uma vez so ===");
{
  const c = venda("c", 65, AGORA - 2 * H);
  const r = mesclarVendasServidor([c, venda("e", 40, AGORA - 10 * 1000)], [c, venda("e", 40, AGORA - 10 * 1000)], AGORA);
  ok(r.length === 2, `sem duplicata (${r.length})`);
}

console.log("\n=== ordem: da mais antiga para a mais nova (o relatorio inverte) ===");
{
  const servidor = [venda("d", 50, AGORA - 1 * H), venda("c", 65, AGORA - 2 * H)]; // servidor manda desc
  const r = mesclarVendasServidor([], servidor, AGORA);
  ok(r[0]._id === "c" && r[1]._id === "d", `ficou c, d (veio ${r.map(v => v._id).join(", ")})`);
}

console.log("\n=== lista local ausente nao quebra ===");
{
  const r = mesclarVendasServidor(undefined, [venda("c", 65, AGORA - 2 * H)], AGORA);
  ok(r.length === 1, "aceita local undefined");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
