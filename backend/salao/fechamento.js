// ── FECHAMENTO DE MESA NO SERVIDOR ───────────────────────────
// Antes, o caixa gravava a venda e depois mandava a mesa zerada como uma
// edicao comum. Se um garcom tivesse mexido na mesa segundos antes (ex.:
// tocou de novo em "Fechamento ja solicitado"), a versao nao batia, o caixa
// perdia a disputa e a mesa voltava a aparecer ocupada para todo mundo — com
// a venda ja gravada. Um segundo fechamento gravava a venda em dobro.
//
// Agora a venda leva junto o que fazer com a mesa, e o servidor aplica isso
// sobre a versao MAIS NOVA da mesa: tira so o que foi pago. O que um garcom
// lancou depois continua aberto.

// Mesma chave do painel: item + variacao
export const chaveItem = (it) => String(it?.id) + "|" + (it?.variacao || "");

const vazia = (sc) => !(sc.itens || []).length && !(sc.rodadas || []).length;

export function mesaZeradaServidor(dados) {
  const base = {
    id: dados.id, status: "livre", garcom: "", obs: "", abertura: null,
    solicitadoPor: null, solicitadoEm: null,
    subComandas: [{ id: 1, label: "Comanda 1", cliente: "", itens: [], rodadas: [] }],
  };
  // Mesas especiais (901/902) mantem nome, tipo e icone
  if (dados.tipo) Object.assign(base, { nome: dados.nome, tipo: dados.tipo, icon: dados.icon });
  return base;
}

const LIBERADA = { status: "livre", abertura: null, garcom: "", solicitadoPor: null, solicitadoEm: null };

// modo: "mesa"    -> pagou tudo o que estava na mesa
//       "comanda" -> pagou uma comanda (scIds = [id dela]); ela sai da mesa
//       "parcial" -> pagou alguns itens das comandas em scIds; a estrutura fica
export function aplicarPagamentoNaMesa(dados, { modo, scIds }, pagos) {
  const falta = {};
  for (const p of pagos || []) {
    const k = chaveItem(p);
    falta[k] = (falta[k] || 0) + (Number(p.qty) || 1);
  }
  const tirar = (lista) => (lista || [])
    .map(it => {
      const k = chaveItem(it), q = Number(it.qty) || 1;
      const t = Math.min(q, falta[k] || 0);
      if (t > 0) falta[k] -= t;
      return { ...it, qty: q - t };
    })
    .filter(it => it.qty > 0);

  const escopo = (sc) => modo === "mesa" || (scIds || []).map(Number).includes(Number(sc.id));
  let subComandas = (dados.subComandas || []).map(sc => {
    if (!escopo(sc)) return sc;
    const rodadas = (sc.rodadas || []).map(r => ({ ...r, itens: tirar(r.itens) })).filter(r => r.itens.length);
    return { ...sc, rodadas, itens: tirar(sc.itens) };
  });

  if (modo === "parcial") return { ...dados, subComandas };

  // Mesa ou comanda paga: a comanda que ficou vazia sai. Se sobrou item nela,
  // foi lancado depois do pagamento e continua em aberto.
  subComandas = subComandas.filter(sc => !(escopo(sc) && vazia(sc)));
  if (!subComandas.length) return mesaZeradaServidor(dados);
  if (subComandas.every(vazia)) return { ...dados, ...LIBERADA, subComandas };
  return {
    ...dados, subComandas,
    // A conta pedida ja foi paga; se ficou algo, a mesa segue ocupada
    status: dados.status === "conta" || dados.status === "chamando" ? "ocupada" : dados.status,
    solicitadoPor: null, solicitadoEm: null,
  };
}
