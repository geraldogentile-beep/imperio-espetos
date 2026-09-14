// Testa que as mesas especiais (901 Funcionarios, 902 Caixa Direto) nao
// perdem a identidade ao serem zeradas nem ao voltarem do servidor/cache.
//
//   node scripts/mesas-especiais.test.mjs
//
// Motivo: fechar a ultima comanda de "Funcionarios" gravava initMesa(900),
// a 901 virava mesa comum no servidor e o mapa mostrava 901,902,901,902...

import fs from "fs";

const src = fs.readFileSync(new URL("../../painel/src/PainelPedidos.jsx", import.meta.url), "utf8");
const ini = Math.min(...["function initSubComanda", "function initMesa(", "function initMesaEspecial"].map(t => src.indexOf(t)).filter(i => i >= 0));
const fim = src.indexOf("function fmtR(");
const { mesaZerada, migrarMesa, restaurarIdentidade, MESAS_ESPECIAIS_BASE } = new Function(
  src.slice(ini, fim) + "\nreturn { mesaZerada, migrarMesa, restaurarIdentidade, MESAS_ESPECIAIS_BASE };"
)();

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

console.log("\n=== zerar a mesa preserva o que ela e ===");
{
  const func = { ...MESAS_ESPECIAIS_BASE[0], status: "ocupada", abertura: "2026-09-13T22:00:00Z",
                 subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [{ nome: "Alcatra", qty: 2, preco: 10 }], rodadas: [] }] };
  const z = mesaZerada(func);
  ok(z.id === 901 && z.tipo === "funcionarios" && z.nome === "Funcionários" && z.icon === "👥", "901 zerada continua Funcionarios");
  ok(z.status === "livre" && z.abertura === null && z.subComandas[0].itens.length === 0, "e volta limpa: livre, sem abertura, sem itens");

  const comum = { id: 5, status: "ocupada", abertura: "x", subComandas: [] };
  const zc = mesaZerada(comum);
  ok(zc.id === 5 && !zc.tipo && zc.status === "livre", "mesa 5 zerada continua a mesa 5 comum");
}

console.log("\n=== o que vem do servidor sem tipo recupera a identidade ===");
{
  const doServidor = { id: 902, status: "livre", garcom: "", obs: "", abertura: null, solicitadoPor: null, solicitadoEm: null,
                       subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [] }] };
  const m = migrarMesa(doServidor);
  ok(m.tipo === "caixa_direto" && m.nome === "Caixa Direto" && m.icon === "🛒", "902 sem tipo vira Caixa Direto de novo");
  ok(m.subComandas === doServidor.subComandas, "sem mexer nas comandas que vieram");

  const comum = migrarMesa({ id: 7, status: "livre", subComandas: [] });
  ok(!comum.tipo, "mesa 7 nao ganha tipo nenhum");

  const jaTem = { ...MESAS_ESPECIAIS_BASE[0], nome: "Equipe" };
  ok(restaurarIdentidade(jaTem).nome === "Equipe", "quem ja tem tipo fica como esta");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
