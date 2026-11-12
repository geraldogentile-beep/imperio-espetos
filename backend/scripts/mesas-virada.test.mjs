// Mesa que ficou aberta na virada do dia (06:00) nao pode sumir do mapa.
//
// Parte 1 roda sem nada: node scripts/mesas-virada.test.mjs
// Parte 2 precisa do servidor e do MESMO banco dele (o teste grava mesas de
// "ontem" direto no Mongo), com a conferencia sem intervalo:
//   VIRADA_INTERVALO_MS=0 MONGO_URI=... node server.js
//   MONGO_URI=... TESTE_URL=http://localhost:3000 node scripts/mesas-virada.test.mjs
//
// Motivo: em 07/11/2026 a mesa 6 ficou "ocupada" no registro e nunca mais
// apareceu. Estava vazia, mas com itens o que estava lancado deixaria de ser
// cobrado sem ninguem perceber.

import "dotenv/config";
import { decidirVirada, temItensNaMesa } from "../salao/virada.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const item = (nome, qty = 1, preco = 9) => ({ id: 1, nome, qty, preco, categoria: "Tradicionais" });
const mesa = (id, { itens = [], rodadas = [], status = "ocupada", extra = {} } = {}) => ({
  id, status, garcom: "Ana", obs: "", abertura: "2026-11-07T23:00:00.000Z", solicitadoPor: null, solicitadoEm: null,
  subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens, rodadas }], ...extra,
});
const reg = (_id, mesaId, dataStr, dados) => ({ _id, mesaId, dataStr, dados });

console.log("\n=== parte 1: o que vem para hoje ===");
{
  ok(temItensNaMesa(mesa(1, { itens: [item("Alcatra")] })) && temItensNaMesa(mesa(1, { rodadas: [{ id: "r1", itens: [item("Frango")] }] })), "item na tela ou em rodada lancada conta como algo a cobrar");
  ok(!temItensNaMesa(mesa(1)) && !temItensNaMesa(mesa(1, { rodadas: [{ id: "r1", itens: [] }] })) && !temItensNaMesa(null), "mesa ocupada mas vazia nao tem o que cobrar");

  const antigas = [
    reg("a", 6, "2026-11-07", mesa(6, { rodadas: [{ id: "r1", itens: [item("Alcatra", 2)] }] })),
    reg("b", 7, "2026-11-07", mesa(7)),                                            // ocupada e vazia
    reg("c", 8, "2026-11-06", mesa(8, { itens: [item("Frango")] })),
    reg("d", 8, "2026-11-07", mesa(8, { itens: [item("Cordeiro")] })),             // a mesma mesa, mais recente
    reg("e", 9, "2026-11-07", mesa(9, { itens: [item("Kafta")] })),                // ja existe hoje
    reg("f", 10, "2026-11-07", mesa(10, { status: "livre" })),
  ];
  const { trazer, encerrar } = decidirVirada(antigas, [9, 1]);
  ok(trazer.map(t => t.mesaId).sort().join(",") === "6,8", `traz as mesas com itens que nao existem hoje (${trazer.map(t => t.mesaId).join(", ")})`);
  ok(trazer.find(t => t.mesaId === 8).dados.subComandas[0].itens[0].nome === "Cordeiro", "da mesma mesa, vale o registro mais recente");
  ok(trazer.find(t => t.mesaId === 6).dados.veioDe === "2026-11-07", "a mesa leva o dia em que foi aberta");
  ok(!trazer.some(t => t.mesaId === 9), "mesa que ja existe hoje nao e sobrescrita");
  ok(encerrar.sort().join(",") === "a,c,d,e", `todo registro com itens fica marcado como tratado (${encerrar.join(",")})`);
  ok(!encerrar.includes("b") && !encerrar.includes("f"), "os vazios ficam como estao");

  const dois = decidirVirada([reg("x", 6, "2026-11-08", mesa(6, { itens: [item("Alcatra")], extra: { veioDe: "2026-11-07" } }))], []);
  ok(dois.trazer[0].dados.veioDe === "2026-11-07", "atravessando duas viradas, continua valendo o dia original");
  ok(decidirVirada([], [1]).trazer.length === 0 && decidirVirada().encerrar.length === 0, "sem registro antigo, nada a fazer");
}

const BASE = process.env.TESTE_URL;
if (!BASE) {
  console.log("\n(parte 2 pulada: defina TESTE_URL e MONGO_URI para testar contra o servidor)");
  console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

const { default: mongoose } = await import("mongoose");
const login = async (pin) => (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) })).json()).token;
const token = await login(process.env.TESTE_PIN || "9999");
const tokenGarcom = await login(process.env.TESTE_PIN_GARCOM || "5678");
const api = async (metodo, rota, corpo, tk = token) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
// Mesmo calculo do servidor: antes das 06:00 ainda e o expediente de ontem
const diaOp = (d = new Date()) => { const x = new Date(d); if (x.getHours() < 6) x.setDate(x.getDate() - 1); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
const hoje = diaOp(), ontem = diaOp(new Date(Date.now() - 86400e3)), anteontem = diaOp(new Date(Date.now() - 2 * 86400e3));

await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/imperio");
const col = mongoose.connection.collection("mesasalaos");

console.log(`\n=== parte 2: no servidor (hoje ${hoje}, ontem ${ontem}) ===`);
{
  // Hoje ja existe a mesa 9, aberta por outro cliente
  await api("PUT", "/mesas/9", { dados: mesa(9, { itens: [item("Linguiça")] }), versao: 0 });
  await col.insertMany([
    { mesaId: 6, dataStr: ontem, dados: mesa(6, { rodadas: [{ id: "rvirada1", hora: new Date().toISOString(), itens: [item("Alcatra", 2)] }] }), versao: 26, porQuem: "dono" },
    { mesaId: 7, dataStr: ontem, dados: mesa(7), versao: 3, porQuem: "dono" },
    { mesaId: 8, dataStr: anteontem, dados: mesa(8, { itens: [item("Frango")] }), versao: 2, porQuem: "garcom" },
    { mesaId: 9, dataStr: ontem, dados: mesa(9, { itens: [item("Kafta")] }), versao: 5, porQuem: "garcom" },
  ]);

  const r = await api("GET", "/mesas", null, tokenGarcom);   // o garcom abre o app de manha
  const m = (id) => r.corpo.mesas.find(x => x.mesaId === id);
  ok(r.status === 200 && m(6) && m(6).dados.subComandas[0].rodadas[0].itens[0].qty === 2, "a mesa 6 de ontem aparece hoje, com o que estava lancado");
  ok(m(6)?.dados.veioDe === ontem && m(6).dados.status === "ocupada" && m(6).versao === 1, `marcada como aberta desde ${m(6)?.dados.veioDe}`);
  ok(m(8)?.dados.veioDe === anteontem, "a de anteontem tambem vem");
  ok(!m(7), "a ocupada e vazia nao vem");
  ok(m(9)?.dados.subComandas[0].itens[0].nome === "Linguiça", "a mesa 9 de hoje nao foi trocada pela de ontem");

  const marcadas = await col.find({ dataStr: { $lt: hoje }, levadaPara: hoje }).toArray();
  ok(marcadas.map(x => x.mesaId).sort().join(",") === "6,8,9", `registros antigos marcados como tratados (${marcadas.map(x => x.mesaId).sort().join(",")})`);
  ok((await col.findOne({ dataStr: ontem, mesaId: 6 })).dados.subComandas[0].rodadas[0].itens[0].qty === 2, "o registro de ontem continua guardado como estava");

  const r2 = await api("GET", "/mesas");
  ok(r2.corpo.mesas.filter(x => x.mesaId === 6).length === 1 && (await col.countDocuments({ dataStr: hoje, mesaId: 6 })) === 1, "consultar de novo nao duplica");

  // A mesa trazida funciona como qualquer outra: lancar mais um item
  const dados = m(6).dados;
  const p = await api("PUT", "/mesas/6", { dados: { ...dados, subComandas: [{ ...dados.subComandas[0], itens: [item("Frango")] }] }, versao: 1 });
  ok(p.status === 200 && p.corpo.versao === 2, "da para continuar lancando nela");

  // Paga hoje: amanha ela nao pode voltar. Simula a conta paga zerando a mesa
  // e conferindo que o registro de ontem nao e trazido outra vez.
  const z = await api("POST", "/mesas/6/liberar", { motivo: "conta paga no teste" });
  const r3 = await api("GET", "/mesas");
  ok(z.status === 200 && r3.corpo.mesas.find(x => x.mesaId === 6).dados.status === "livre", "depois de liberada, a mesa fica livre e o registro antigo nao a traz de volta");
}

await col.deleteMany({ mesaId: { $in: [6, 7, 8, 9] }, dataStr: { $in: [hoje, ontem, anteontem] } });
await mongoose.disconnect();
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
