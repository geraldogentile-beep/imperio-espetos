// Lanche montado: preço = base + espetinho escolhido.
//
// Parte 1 roda sem nada: node scripts/lanche-montado.test.mjs
// Parte 2 precisa do servidor: TESTE_URL=http://localhost:3000 node scripts/lanche-montado.test.mjs
//
// Motivo: o Lanche Imperial só existia com kafta e preço fixo. Outro espeto
// mudava o valor e alguém tinha de lembrar de corrigir à mão.

import { ehMontado, opcoesMontado, lerItemMontado, textoMontado } from "../cardapio/montado.js";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const CARDAPIO = [
  { id: 1, categoria: "Tradicionais", nome: "Frango", preco: 9, ativo: true },
  { id: 2, categoria: "Tradicionais", nome: "Linguiça", preco: 9, ativo: true },
  { id: 3, categoria: "Especiais", nome: "Picanha meia lua", preco: 15, ativo: true },
  { id: 4, categoria: "Especiais", nome: "Kafta com queijo", preco: 11, ativo: true },
  { id: 5, categoria: "Especiais", nome: "Cordeiro", preco: 13, ativo: false },   // fora do cardapio hoje
  { id: 6, categoria: "Cervejas", nome: "Chopp", preco: 10, ativo: true },
  { id: 7, categoria: "Refeições", nome: "Lanche Imperial", preco: 6, ativo: true,
    montarCom: ["Tradicionais", "Especiais"], montarRotulo: "Escolha o espetinho" },
  { id: 8, categoria: "Refeições", nome: "Jantinha Imperial", preco: 18, ativo: true },
];
const lanche = CARDAPIO[6];
const preco = (i) => Number(i.preco) || 0;

console.log("\n=== parte 1: regras do lanche montado ===");
{
  ok(ehMontado(lanche) && !ehMontado(CARDAPIO[7]), "so e montado o item com categorias marcadas");

  const ops = opcoesMontado(lanche, CARDAPIO, preco);
  ok(ops.map(o => o.nome).join() === "Frango,Kafta com queijo,Linguiça,Picanha meia lua", `opcoes em ordem alfabetica (${ops.map(o => o.nome).join(", ")})`);
  ok(!ops.some(o => o.nome === "Chopp"), "cerveja nao entra (categoria nao marcada)");
  ok(!ops.some(o => o.nome === "Cordeiro"), "espeto desativado nao aparece");
  ok(!ops.some(o => o.nome === "Lanche Imperial"), "o proprio lanche nao entra na lista");

  const picanha = ops.find(o => o.nome === "Picanha meia lua");
  ok(picanha.preco === 21, `base 6 + picanha 15 = R$ ${picanha.preco.toFixed(2)}`);
  ok(picanha.precoBase === 6 && picanha.precoEspeto === 15, "guarda as duas partes do preco");
  ok(ops.find(o => o.nome === "Kafta com queijo").preco === 17, "com kafta = R$ 17,00");

  // Preco do espeto muda: o lanche acompanha sozinho
  const maisCaro = CARDAPIO.map(i => i.nome === "Picanha meia lua" ? { ...i, preco: 17 } : i);
  ok(opcoesMontado(lanche, maisCaro, preco).find(o => o.nome === "Picanha meia lua").preco === 23, "picanha a 17 vira lanche de 23 sem mexer no cadastro");

  // Modo evento: o preco promocional entra pelos dois lados
  const promo = (i) => (i.precoPromocional > 0 ? i.precoPromocional : Number(i.preco) || 0);
  const comPromo = CARDAPIO.map(i => i.nome === "Picanha meia lua" ? { ...i, precoPromocional: 12 } : i);
  ok(opcoesMontado(lanche, comPromo, promo).find(o => o.nome === "Picanha meia lua").preco === 18, "preco promocional do espeto vale no lanche");
}

console.log("\n=== parte 1b: pedido do WhatsApp ===");
{
  const r = lerItemMontado("Lanche Imperial (Picanha meia lua)", CARDAPIO, preco);
  ok(r?.preco === 21 && r.nome === "Lanche Imperial (Picanha meia lua)", `le o nome composto e calcula (R$ ${r?.preco})`);
  ok(r?.base.nome === "Lanche Imperial" && r?.espeto === "Picanha meia lua", "separa base e espeto (estoque e cozinha)");
  ok(lerItemMontado("lanche imperial (picanha meia lua)", CARDAPIO, preco)?.preco === 21, "sem ligar para maiusculas");
  ok(lerItemMontado("Lanche Imperial (Linguica)", CARDAPIO, preco)?.preco === 15, "sem ligar para acento");
  ok(lerItemMontado("Lanche Imperial (Chopp)", CARDAPIO, preco) === null, "recusa espeto de categoria nao permitida");
  ok(lerItemMontado("Lanche Imperial (Alcatra)", CARDAPIO, preco) === null, "recusa item que nao existe");
  ok(lerItemMontado("Jantinha Imperial (Frango)", CARDAPIO, preco) === null, "recusa item que nao e montado");
  ok(lerItemMontado("Frango", CARDAPIO, preco) === null, "item comum segue o caminho normal");

  const txt = textoMontado(lanche, CARDAPIO, preco);
  ok(txt.includes("R$6.00") && txt.includes("espetinho") && txt.includes("15.00"), `linha do cardapio do bot: "${txt}"`);
}

const BASE = process.env.TESTE_URL;
if (!BASE) {
  console.log("\n(parte 2 pulada: defina TESTE_URL para testar no servidor)");
} else {
  const token = await (async () => {
    const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.TESTE_PIN || "9999" }) });
    return (await r.json()).token;
  })();
  const api = async (metodo, rota, corpo) => {
    const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };

  console.log("\n=== parte 2: cadastro no servidor ===");
  {
    const cardapio = (await api("GET", "/cardapio")).corpo;
    const item = cardapio.find(i => /lanche/i.test(i.nome)) || cardapio.find(i => i.categoria === "Refeições") || cardapio[0];
    const r = await api("PUT", `/cardapio/${item.id}`, { montarCom: ["Tradicionais", "Especiais", "Tradicionais", " "], montarRotulo: "  Escolha o espetinho  " });
    ok(r.status === 200, `gravou a configuracao (HTTP ${r.status})`);
    const depois = (await api("GET", "/cardapio")).corpo.find(i => i.id === item.id);
    ok(depois.montarCom?.join() === "Tradicionais,Especiais", `guarda as categorias sem repetir nem vazio (${depois.montarCom?.join(", ")})`);
    ok(depois.montarRotulo === "Escolha o espetinho", "e o titulo sem espacos sobrando");

    const ruim = await api("PUT", `/cardapio/${item.id}`, { montarCom: "Especiais" });
    ok(ruim.status === 400, `recusa formato errado (HTTP ${ruim.status})`);

    const ops = opcoesMontado(depois, (await api("GET", "/cardapio")).corpo, (i) => Number(i.preco) || 0);
    ok(ops.length > 0, `o cardapio de verdade gera ${ops.length} opcoes de espeto`);

    // devolve como estava
    await api("PUT", `/cardapio/${item.id}`, { montarCom: [], montarRotulo: "" });
    ok((await api("GET", "/cardapio")).corpo.find(i => i.id === item.id).montarCom.length === 0, "da para desligar");
  }

  console.log("\n=== parte 3: o espeto do lanche sai do estoque ===");
  {
    const cardapio = (await api("GET", "/cardapio")).corpo;
    const lanche = cardapio.find(i => /lanche/i.test(i.nome)) || cardapio[0];
    const espeto = cardapio.find(i => i.categoria === "Especiais") || cardapio[1];
    const criar = async (nome, vinculo) => (await api("POST", "/estoque", { nome, quantidade: 10, minimo: 0, cardapioNomes: [vinculo], consumoPorVenda: 1 })).corpo;
    const estPao = await criar(`TESTE pao ${Date.now()}`, lanche.nome);
    const estEsp = await criar(`TESTE espeto ${Date.now()}`, espeto.nome);

    const item = { id: lanche.id, nome: `${lanche.nome} (${espeto.nome})`, nomeBase: lanche.nome, espeto: espeto.nome, preco: 21, qty: 2 };
    const venda = await api("POST", "/vendas-salao", {
      mesa: 12, itens: [item], subtotal: 42, total: 42, desconto: 0, pagamento: "pix", fechamento: new Date().toISOString(),
    });
    ok(venda.status === 201, `venda gravada (HTTP ${venda.status})`);
    await new Promise(r => setTimeout(r, 600));   // a baixa roda depois de responder

    const estoque = (await api("GET", "/estoque")).corpo;
    const pao = estoque.find(e => e._id === estPao._id), esp = estoque.find(e => e._id === estEsp._id);
    ok(pao?.quantidade === 8, `baixou 2 do pao (ficou ${pao?.quantidade})`);
    ok(esp?.quantidade === 8, `baixou 2 do espeto escolhido (ficou ${esp?.quantidade})`);

    await api("DELETE", `/estoque/${estPao._id}`);
    await api("DELETE", `/estoque/${estEsp._id}`);
    if (venda.corpo?._id) await api("DELETE", `/vendas-salao/${venda.corpo._id}`);
  }
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
