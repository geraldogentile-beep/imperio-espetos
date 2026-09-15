// Testa mesa extra (a 17, a 18...) aparecendo e sumindo entre aparelhos.
//
// Precisa de MongoDB. Roda assim, dentro de backend/:
//   TESTE_URL=http://localhost:3994 node scripts/mesas-extra.test.mjs
//
// Motivo: "+ Mesa" criava a mesa so no aparelho de quem apertou. O garcom
// abria a 17 no celular e o caixa nunca via.

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
const login = async (pin) => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
  if (!r.ok) throw new Error(`login ${pin} falhou: ${r.status}`);
  return (await r.json()).token;
};
const api = (token) => async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const garcom = api(await login(process.env.TESTE_PIN_GARCOM || "5678"));
const dono = api(await login(process.env.TESTE_PIN || "9999"));

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const mesaLivre = (id) => ({ id, status: "livre", garcom: "", obs: "", abertura: null, solicitadoPor: null, solicitadoEm: null, subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [] }] });
const ids = async (quem) => ((await quem("GET", "/mesas")).corpo.mesas || []).map(m => m.mesaId);

console.log(`\nServidor: ${BASE}\n`);
await dono("DELETE", "/mesas");   // comeca do zero

console.log("=== 1) garcom adiciona a mesa 17: o caixa passa a ver ===");
{
  const r = await garcom("PUT", "/mesas/17", { dados: mesaLivre(17) });
  ok(r.status === 201, `garcom criou a 17 (HTTP ${r.status})`);
  ok((await ids(dono)).includes(17), "o dono recebe a 17 no /mesas");
}

console.log("\n=== 2) caixa adiciona a 18: o garcom passa a ver ===");
{
  const r = await dono("PUT", "/mesas/18", { dados: mesaLivre(18) });
  ok(r.status === 201, `dono criou a 18 (HTTP ${r.status})`);
  ok((await ids(garcom)).includes(18), "o garcom recebe a 18 no /mesas");
}

console.log("\n=== 3) remover mesa extra livre ===");
{
  const r = await dono("DELETE", "/mesas/18");
  ok(r.status === 200 && r.corpo.removida === 1, `removeu a 18 (HTTP ${r.status})`);
  ok(!(await ids(garcom)).includes(18), "a 18 sumiu para o garcom tambem");
}

console.log("\n=== 4) mesa extra com pedido NAO pode ser removida ===");
{
  await garcom("PUT", "/mesas/17", { dados: { ...mesaLivre(17), status: "ocupada", subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [{ nome: "Alcatra", qty: 2, preco: 10 }], rodadas: [] }] }, versao: 1 });
  const r = await dono("DELETE", "/mesas/17");
  ok(r.status === 409, `recusou (HTTP ${r.status}): ${r.corpo.erro || ""}`);
  ok((await ids(dono)).includes(17), "a 17 continua la, com o pedido");
}

console.log("\n=== 5) remover mesa que nao existe nao da erro ===");
{
  const r = await garcom("DELETE", "/mesas/40");
  ok(r.status === 200 && r.corpo.removida === 0, `HTTP ${r.status}, removida=${r.corpo.removida}`);
}

await dono("DELETE", "/mesas");
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
