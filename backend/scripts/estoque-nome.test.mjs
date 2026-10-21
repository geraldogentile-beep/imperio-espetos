// Item do estoque sem vínculo e com o MESMO nome de um produto do cardápio
// fica ligado sozinho (pedido do usuário, 21/10/2026). Vínculo escolhido
// nunca é trocado, e um produto do cardápio não ganha dois estoques.
//   TESTE_URL=http://localhost:3000 node scripts/estoque-nome.test.mjs   (dentro de backend/)

import "dotenv/config";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.TESTE_PIN || "9999" }) });
  return (await r.json()).token;
})();
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const cardapio = (await api("GET", "/cardapio")).corpo;
const alvo = cardapio.find(i => i.nome === "Água sem gás") || cardapio[0];
const criados = [];
const criar = async (dados) => { const r = (await api("POST", "/estoque", dados)).corpo; criados.push(r._id); return r; };

console.log(`\nServidor: ${BASE} (produto: ${alvo.nome})\n`);
const a = await criar({ nome: alvo.nome, unidade: "un", quantidade: 10 });
ok(JSON.stringify(a.cardapioNomes) === JSON.stringify([alvo.nome]), `estoque "${alvo.nome}" sem vínculo: ligou sozinho ao produto do cardápio`);
const b = await criar({ nome: "  " + alvo.nome.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "") + " ", unidade: "un", quantidade: 1 });
ok(!b.cardapioNomes?.length, "um segundo estoque com o mesmo nome não é ligado (o produto já tem estoque)");
const c = await criar({ nome: "Coisa que não está no cardápio", unidade: "un", quantidade: 1 });
ok(!c.cardapioNomes?.length, "nome que não existe no cardápio: fica sem vínculo");
const outro = cardapio.find(i => i.nome !== alvo.nome);
const d = await criar({ nome: "Nome qualquer", unidade: "un", cardapioNomes: [outro.nome] });
ok(JSON.stringify(d.cardapioNomes) === JSON.stringify([outro.nome]), "vínculo escolhido no cadastro é respeitado");

console.log("\n=== produto novo no cardápio liga o estoque que esperava por ele ===");
const e = await criar({ nome: "Suco Teste Ligação 300ml", unidade: "un", quantidade: 5 });
ok(!e.cardapioNomes?.length, "antes: sem produto com esse nome");
const novo = await api("POST", "/cardapio", { categoria: "Suco", nome: "Suco Teste Ligação 300ml", preco: 5 });
const eDepois = (await api("GET", "/estoque")).corpo.find(x => x._id === e._id);
ok(novo.status === 201 && JSON.stringify(eDepois.cardapioNomes) === JSON.stringify(["Suco Teste Ligação 300ml"]), "depois de criar o produto, o estoque ficou ligado");

console.log("\n=== a venda baixa o estoque ligado sozinho ===");
await api("POST", "/vendas-salao", { mesa: 40, itens: [{ id: novo.corpo.id, nome: "Suco Teste Ligação 300ml", qty: 2, preco: 5 }], subtotal: 10, desconto: 0, total: 10, pagamento: "pix" });
ok((await api("GET", "/estoque")).corpo.find(x => x._id === e._id).quantidade === 3, "vendeu 2: estoque 5 -> 3");

for (const id of criados) await api("DELETE", "/estoque/" + id);
await api("DELETE", "/cardapio/" + novo.corpo.id);
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
