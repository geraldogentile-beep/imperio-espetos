// Produção: matéria-prima vira produto pronto (3 kg de frango -> 40 espetos;
// carne + queijo -> espeto de carne com queijo). Ingredientes saem, produto
// entra, custo do produto = custo dos ingredientes ÷ quantidade. Só o adm.
//   TESTE_URL=http://localhost:3000 node scripts/producao.test.mjs   (dentro de backend/)

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
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
const MES = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
const item = async (id) => (await api("GET", "/estoque")).corpo.find(e => e._id === id);
const criar = async (dados) => (await api("POST", "/estoque", dados)).corpo;
const perto = (a, b) => Math.abs(a - b) < 1e-9;

console.log(`\nServidor: ${BASE}\n`);
const frango = await criar({ nome: "Frango peito (teste)", unidade: "kg", quantidade: 5, minimo: 1, custoPorUnidade: 18 });
const carne  = await criar({ nome: "Carne (teste)", unidade: "kg", quantidade: 4, custoPorUnidade: 40 });
const queijo = await criar({ nome: "Queijo coalho (teste)", unidade: "kg", quantidade: 2 });
const espeto = await criar({ nome: "Espeto de frango (teste)", unidade: "un", quantidade: 10, custoPorUnidade: 2 });
const medalhao = await criar({ nome: "Medalhão de frango (teste)", unidade: "un", quantidade: 0 });
const carneQueijo = await criar({ nome: "Espeto carne c/ queijo (teste)", unidade: "un", quantidade: 0 });

console.log("=== 1) só o adm e pedido válido ===");
{
  ok((await api("POST", "/estoque/producao", { produtoId: espeto._id, quantidade: 1, insumos: [{ estoqueId: frango._id, quantidade: 0.1 }] }, tokenGarcom)).status === 403, "garçom não lança produção");
  ok((await api("GET", "/estoque/producao?mes=" + MES, null, tokenGarcom)).status === 403, "garçom não vê produção");
  const casos = [
    [{ quantidade: 40, insumos: [{ estoqueId: frango._id, quantidade: 3 }] }, "sem produto"],
    [{ produtoId: espeto._id, quantidade: 0, insumos: [{ estoqueId: frango._id, quantidade: 3 }] }, "quantidade 0"],
    [{ produtoId: espeto._id, quantidade: 40, insumos: [] }, "sem ingrediente"],
    [{ produtoId: espeto._id, quantidade: 40, insumos: [{ estoqueId: espeto._id, quantidade: 1 }] }, "produto como ingrediente dele mesmo"],
    [{ produtoId: espeto._id, quantidade: 40, insumos: [{ estoqueId: frango._id, quantidade: 1 }, { estoqueId: frango._id, quantidade: 2 }] }, "ingrediente repetido"],
    [{ produtoId: espeto._id, quantidade: 40, insumos: [{ estoqueId: frango._id, quantidade: "abc" }] }, "quantidade de ingrediente inválida"],
    [{ produtoId: espeto._id, quantidade: 40, insumos: [{ estoqueId: "xyz", quantidade: 1 }] }, "id inválido"],
  ];
  for (const [corpo, nome] of casos) ok((await api("POST", "/estoque/producao", corpo)).status === 400, `recusa: ${nome}`);
  ok((await api("POST", "/estoque/producao", { produtoId: espeto._id, quantidade: 40, insumos: [{ estoqueId: "0123456789abcdef01234567", quantidade: 1 }] })).status === 404, "ingrediente que não existe: 404");
  ok((await item(frango._id)).quantidade === 5, "nada mudou no estoque com os pedidos recusados");
}

console.log("\n=== 2) 3 kg de frango -> 40 espetos ===");
let prodEspeto;
{
  const r = await api("POST", "/estoque/producao", { produtoId: espeto._id, quantidade: "40", insumos: [{ estoqueId: frango._id, quantidade: "3,0" }] });
  prodEspeto = r.corpo;
  ok(r.status === 201, `lançada (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  ok(perto((await item(frango._id)).quantidade, 2), "frango: 5 -> 2 kg");
  const esp = await item(espeto._id);
  ok(esp.quantidade === 50, "espeto: 10 -> 50 un");
  ok(perto(esp.custoPorUnidade, 1.35), `custo do espeto: 3 kg x R$ 18 / 40 = R$ ${esp.custoPorUnidade}`);
  ok(r.corpo.custoTotal === 54 && r.corpo.produto.custoAnterior === 2 && r.corpo.faltou.length === 0, "custo total R$ 54, custo anterior guardado (R$ 2)");
  const movsF = (await api("GET", `/estoque/${frango._id}/movimentacoes`)).corpo;
  const movsE = (await api("GET", `/estoque/${espeto._id}/movimentacoes`)).corpo;
  ok(movsF.some(m => m.tipo === "saida" && perto(m.quantidade, 3) && m.motivo === "produção: Espeto de frango (teste)" && m.producaoId === prodEspeto._id), "histórico do frango: saída \"produção: Espeto de frango\"");
  ok(movsE.some(m => m.tipo === "entrada" && m.quantidade === 40 && m.producaoId === prodEspeto._id), "histórico do espeto: entrada de 40");
  const mov = movsE.find(m => m.producaoId === prodEspeto._id);
  ok((await api("DELETE", "/estoque/movimentacoes/" + mov._id)).status === 400, "movimentação de produção não se apaga sozinha");
}

console.log("\n=== 3) o resto do frango vira medalhão; frango a menos no estoque ===");
{
  const r = await api("POST", "/estoque/producao", { produtoId: medalhao._id, quantidade: 25, insumos: [{ estoqueId: frango._id, quantidade: 2.5 }] });
  ok(r.status === 201 && r.corpo.faltou.length === 1 && perto(r.corpo.faltou[0].tinha, 2), "usou 2,5 kg com 2 kg no estoque: lança e avisa que faltou");
  ok((await item(frango._id)).quantidade === 0 && (await item(medalhao._id)).quantidade === 25, "frango fica em 0 (não negativo); medalhão +25");
  ok(perto((await item(medalhao._id)).custoPorUnidade, 1.8), "custo do medalhão pelo que foi usado: 2,5 kg x R$ 18 / 25 = R$ 1,80");
}

console.log("\n=== 4) carne + queijo -> espeto de carne com queijo ===");
let prodSemCusto;
{
  const r = await api("POST", "/estoque/producao", { produtoId: carneQueijo._id, quantidade: 10, insumos: [{ estoqueId: carne._id, quantidade: 1 }, { estoqueId: queijo._id, quantidade: 0.5 }] });
  prodSemCusto = r.corpo;
  ok(r.status === 201 && perto((await item(carne._id)).quantidade, 3) && perto((await item(queijo._id)).quantidade, 1.5), "carne 4 -> 3 kg, queijo 2 -> 1,5 kg");
  ok(r.corpo.produto.custoUnitario === null && r.corpo.semCusto.join() === "Queijo coalho (teste)" && (await item(carneQueijo._id)).custoPorUnidade === 0, "queijo sem custo: o custo do espeto NÃO é calculado e o queijo é apontado");
  await api("PUT", "/estoque/" + queijo._id, { custoPorUnidade: 50 });
  const r2 = await api("POST", "/estoque/producao", { produtoId: carneQueijo._id, quantidade: 10, insumos: [{ estoqueId: carne._id, quantidade: 1 }, { estoqueId: queijo._id, quantidade: 0.5 }] });
  ok(r2.status === 201 && perto((await item(carneQueijo._id)).custoPorUnidade, 6.5), "com o custo do queijo: (R$ 40 + R$ 25) / 10 = R$ 6,50 cada");
}

console.log("\n=== 5) relatório e última produção ===");
{
  const rel = (await api("GET", "/estoque/producao?mes=" + MES)).corpo;
  ok(rel.lancamentos === 4 && rel.custoTotal === 54 + 45 + 40 + 65, `4 produções, custo R$ ${rel.custoTotal}`);
  const cq = rel.porProduto.find(p => p.nome === "Espeto carne c/ queijo (teste)");
  ok(cq.quantidade === 20 && cq.vezes === 2 && perto(cq.custoMedio, 6.5), "carne c/ queijo: 20 un em 2 vezes; custo médio só das que têm custo (R$ 6,50)");
  const rq = cq.insumos.find(i => i.nome === "Queijo coalho (teste)");
  ok(rq.rendimento === 20 && perto(rq.porUnidade, 0.05), "rendimento do queijo: 20 espetos por kg (0,05 kg por espeto)");
  const rf = rel.porProduto.find(p => p.nome === "Espeto de frango (teste)").insumos[0];
  ok(rf.rendimento === 13.3 && perto(rf.porUnidade, 0.075), "rendimento do frango: 13,3 espetos por kg (75 g por espeto)");
  ok((await api("GET", "/estoque/producao?semana=" + new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10))).corpo.lancamentos === 4, "também por semana");
  ok((await api("GET", "/estoque/producao")).status === 400, "sem período: 400");
  const ult = (await api("GET", "/estoque/producao/ultima/" + carneQueijo._id)).corpo.ultima;
  ok(ult && ult.produto.custoUnitario === 6.5 && ult.insumos.length === 2, "última produção do carne c/ queijo (para repetir os ingredientes)");
  ok((await api("GET", "/estoque/producao/ultima/" + frango._id)).corpo.ultima === null, "frango nunca foi produzido: null");
}

console.log("\n=== 6) desfazer ===");
{
  // vendeu 45 dos 50 espetos: ao desfazer, o produto não fica negativo
  await api("POST", `/estoque/${espeto._id}/ajuste`, { quantidade: 5, motivo: "teste: vendidos" });
  await api("POST", `/estoque/${frango._id}/entrada`, { quantidade: 1 });
  const d = await api("DELETE", "/estoque/producao/" + prodEspeto._id);
  ok(d.status === 200 && d.corpo.semSaldo === 35, `desfeita; 35 espetos já tinham saído (semSaldo ${d.corpo.semSaldo})`);
  const esp = await item(espeto._id);
  ok(esp.quantidade === 0 && esp.custoPorUnidade === 2, "espeto: 5 -> 0 e o custo volta a R$ 2,00 (era a produção mais recente)");
  ok(perto((await item(frango._id)).quantidade, 4), "frango: 1 + 3 devolvidos = 4 kg");
  ok(!(await api("GET", `/estoque/${frango._id}/movimentacoes`)).corpo.some(m => m.producaoId === prodEspeto._id), "as movimentações da produção saíram do histórico");
  // a do queijo sem custo não é a mais recente: o custo atual (R$ 6,50) fica
  const d2 = await api("DELETE", "/estoque/producao/" + prodSemCusto._id);
  ok(d2.status === 200 && (await item(carneQueijo._id)).quantidade === 10 && (await item(carneQueijo._id)).custoPorUnidade === 6.5, "desfazer uma antiga não mexe no custo atual");
  ok((await api("DELETE", "/estoque/producao/" + prodEspeto._id)).status === 404, "desfazer de novo: 404");
}

for (const e of [frango, carne, queijo, espeto, medalhao, carneQueijo]) await api("DELETE", "/estoque/" + e._id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
