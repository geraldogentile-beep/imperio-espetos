// ── TROCA DE MESA ────────────────────────────────────────────
// O cliente pediu, sentou, e depois quis mudar de mesa. Antes nao existia
// isso: o garcom tinha que lancar tudo de novo na mesa nova e zerar a velha.
//
// Funcao pura: recebe as duas mesas (como estao no servidor) e devolve as duas
// ja trocadas. Quem grava e o servidor, nas duas de uma vez.
//
// - Mesa inteira para mesa livre: tudo vai junto (comandas, garcom, obs,
//   horario de abertura, pedido de conta) e a de origem fica livre.
// - Mesa ocupada no destino: as comandas entram nela (juntar mesas).
// - So algumas comandas: essas vao, o resto fica na mesa de origem.
// Os pedidos ja enviados a cozinha vao junto, com o horario original.

import { mesaZeradaServidor } from "./fechamento.js";

const temPedido = (sc) => (sc.itens || []).length > 0 || (sc.rodadas || []).length > 0;
const temAlgo = (sc) => temPedido(sc) || !!String(sc.cliente || "").trim();
export const mesaOcupada = (m) => !!m && (m.status && m.status !== "livre" || (m.subComandas || []).some(temPedido));

// Observacao nunca se perde (pode ser alergia): junta as duas
function juntarObs(a, b) {
  a = String(a || "").trim(); b = String(b || "").trim();
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  return `${a} / ${b}`;
}

function maisCedo(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) <= new Date(b) ? a : b;
}

function erro(mensagem, status = 400) {
  const e = new Error(mensagem);
  e.status = status;
  return e;
}

// origem, destino: dados das mesas (destino pode ser null = nunca usada hoje)
// scIds: comandas a mover; vazio/ausente = a mesa inteira
export function transferirMesa(origem, destino, { destinoId, scIds } = {}) {
  if (!origem) throw erro("Mesa de origem nao encontrada", 404);
  destinoId = Number(destinoId);
  if (!Number.isInteger(destinoId) || destinoId < 1) throw erro("Mesa de destino invalida");
  if (destinoId === Number(origem.id)) throw erro("Escolha outra mesa");
  if (destino?.tipo) throw erro("Nao da para trocar para essa mesa");

  const todas = origem.subComandas || [];
  const ids = (scIds || []).map(Number);
  const escolhidas = ids.length ? todas.filter(sc => ids.includes(Number(sc.id))) : todas;
  if (ids.length && escolhidas.length !== ids.length) throw erro("Uma das comandas nao esta mais nessa mesa. Confira e tente de novo.", 409);
  const tudo = escolhidas.length === todas.length;
  const ficam = todas.filter(sc => !escolhidas.includes(sc));

  const ocupado = mesaOcupada(destino);
  const movidas = [];
  let novoDestino;

  if (!ocupado && tudo) {
    // Mudou a mesa inteira para uma livre: tudo igual, so muda o numero
    novoDestino = {
      ...(destino || {}), id: destinoId,
      status: origem.status && origem.status !== "livre" ? origem.status : "ocupada",
      garcom: origem.garcom || "", obs: origem.obs || "",
      abertura: origem.abertura || new Date().toISOString(),
      solicitadoPor: origem.solicitadoPor || null, solicitadoEm: origem.solicitadoEm || null,
      subComandas: todas.map(sc => ({ ...sc })),
    };
    todas.forEach(sc => movidas.push({ de: sc.label, para: sc.label, cliente: sc.cliente || "" }));
  } else {
    // Juntar com quem ja esta la, ou levar so algumas comandas
    const base = ocupado ? (destino.subComandas || []).filter(temAlgo) : [];
    // Comanda vazia e sem nome nao precisa ir para uma mesa ocupada
    const vao = ocupado ? escolhidas.filter(temAlgo) : escolhidas;
    let proximo = base.reduce((mx, sc) => Math.max(mx, Number(sc.id) || 0), 0) + 1;
    const renumeradas = vao.map(sc => {
      const id = proximo++;
      const label = /^Comanda \d+$/.test(sc.label || "") ? `Comanda ${id}` : (sc.label || `Comanda ${id}`);
      movidas.push({ de: sc.label, para: label, cliente: sc.cliente || "" });
      return { ...sc, id, label };
    });
    const subComandas = [...base, ...renumeradas];
    const d = destino || { id: destinoId };
    novoDestino = {
      ...d, id: destinoId,
      status: ocupado && d.status && d.status !== "livre" ? d.status : "ocupada",
      garcom: (ocupado && d.garcom) || origem.garcom || "",
      obs: juntarObs(ocupado ? d.obs : "", origem.obs),
      abertura: ocupado ? maisCedo(d.abertura, origem.abertura) || new Date().toISOString() : (origem.abertura || new Date().toISOString()),
      solicitadoPor: ocupado ? d.solicitadoPor || null : null,
      solicitadoEm: ocupado ? d.solicitadoEm || null : null,
      subComandas: subComandas.length ? subComandas : [{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [] }],
    };
  }

  const novaOrigem = tudo ? mesaZeradaServidor(origem) : { ...origem, subComandas: ficam };
  return { origem: novaOrigem, destino: novoDestino, movidas, juntou: ocupado };
}
