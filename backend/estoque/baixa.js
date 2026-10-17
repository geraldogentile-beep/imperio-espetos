// ── BAIXA DE ESTOQUE: o que sai e quando ────────────────────
// Regra da casa (17/10/2026): o item sai do estoque quando vai para a
// cozinha (ou é lançado na conta), e não no fechamento da comanda. Cada
// rodada nova da mesa tem um id; o servidor baixa uma vez por rodada.
// No fechamento só baixa o que nunca virou rodada (ou rodada sem id, vinda
// de um painel antigo). Aqui ficam as contas; o servidor lê e grava.

import { chaveItem } from "../salao/fechamento.js";

const low = (s) => String(s || "").toLowerCase();

// O que cada item consome: ele mesmo (pelo nome base) e, no lanche, cada espeto
export function alvosDaBaixa(itens) {
  return (itens || []).flatMap((item) => {
    const espetos = Array.isArray(item?.espetos) && item.espetos.length ? item.espetos : (item?.espeto ? [item.espeto] : []);
    return [item?.nomeBase || item?.nome, ...espetos].filter(Boolean).map((nome) => ({ nome, qty: Number(item.qty) || 1 }));
  });
}

// { estoqueId: quantidade } que os itens tiram do estoque. O vínculo é pelo
// nome do cardápio (cardapioNomes), sem diferença de maiúscula.
export function mapaDaBaixa(itens, estoques) {
  const mapa = {};
  for (const a of alvosDaBaixa(itens)) {
    const est = (estoques || []).find((e) => (e.cardapioNomes || []).some((n) => low(n) === low(a.nome)));
    if (!est) continue;
    const k = String(est._id);
    mapa[k] = Math.round(((mapa[k] || 0) + a.qty * (Number(est.consumoPorVenda) || 1)) * 10000) / 10000;
  }
  return mapa;
}

// Rodadas da mesa que têm id (as de painel antigo não têm e baixam no fechamento)
export function rodadasComId(dados) {
  return (dados?.subComandas || []).flatMap((sc) => (sc.rodadas || []).filter((r) => r && r.id).map((r) => ({ id: String(r.id), itens: r.itens || [], editadoEm: r.editadoEm || null })));
}

// Diferença entre o que a rodada pede agora e o que pedia: positivo sai,
// negativo volta
export function diferencaMapas(novo, velho) {
  const dif = {};
  for (const k of new Set([...Object.keys(novo || {}), ...Object.keys(velho || {})])) {
    const d = Math.round(((novo?.[k] || 0) - (velho?.[k] || 0)) * 10000) / 10000;
    if (d !== 0) dif[k] = d;
  }
  return dif;
}

// No fechamento: dos itens pagos, quais ainda não saíram do estoque.
// Percorre a mesa na MESMA ordem em que o pagamento tira os itens
// (aplicarPagamentoNaMesa: comanda a comanda, rodadas e depois pendentes).
// Unidade que veio de rodada já baixada fica de fora; de item pendente, de
// rodada sem id ou que nem estava na mesa do servidor, baixa agora.
export function itensSemBaixa(dados, { modo, scIds } = {}, pagos, jaBaixada = () => false) {
  const falta = {}, modelo = {}, semBaixa = {};
  for (const p of pagos || []) {
    const k = chaveItem(p);
    falta[k] = (falta[k] || 0) + (Number(p.qty) || 1);
    if (!modelo[k]) modelo[k] = p;
  }
  const consumir = (lista, baixada) => {
    for (const it of lista || []) {
      const k = chaveItem(it);
      const t = Math.min(Number(it.qty) || 1, falta[k] || 0);
      if (t > 0) { falta[k] -= t; if (!baixada) semBaixa[k] = (semBaixa[k] || 0) + t; }
    }
  };
  const escopo = (sc) => modo === "mesa" || (scIds || []).map(Number).includes(Number(sc.id));
  for (const sc of dados?.subComandas || []) {
    if (!escopo(sc)) continue;
    for (const r of sc.rodadas || []) consumir(r.itens, !!(r.id && jaBaixada(String(r.id))));
    consumir(sc.itens, false);
  }
  for (const [k, q] of Object.entries(falta)) if (q > 0) semBaixa[k] = (semBaixa[k] || 0) + q;
  return Object.entries(semBaixa).map(([k, q]) => ({ ...modelo[k], qty: q }));
}
