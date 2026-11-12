// ── MESA QUE FICOU ABERTA NA VIRADA DO DIA ───────────────────
// O salao guarda um registro por mesa por dia operacional (06:00 a 06:00).
// Mesa esquecida aberta sumia do mapa na virada: quem abria o app no dia
// seguinte so via as mesas do dia novo, e o que estava lancado nela deixava
// de aparecer — sem aviso e sem cobranca.
//
// Agora a primeira consulta do dia traz para hoje a mesa que ficou com itens.
// Aqui fica so a decisao, sem banco, para dar para testar.

// Tem o que cobrar: item ainda na tela ou em rodada ja lancada.
export const temItensNaMesa = (dados) => (dados?.subComandas || []).some(sc =>
  (sc.itens || []).length > 0 || (sc.rodadas || []).some(r => (r.itens || []).length > 0));

// antigas:   registros de dias anteriores ainda nao tratados
//            [{ _id, mesaId, dataStr, dados }]
// idsDeHoje: mesas que ja tem registro hoje
//
// Devolve:
//   trazer   -> a mais recente de cada mesa com itens, se a mesa ainda nao
//               existe hoje. Mesa que ja existe hoje nao e sobrescrita: quem
//               ficou com o app aberto na virada ja regravou a mesma mesa.
//   encerrar -> ids dos registros com itens (trazidos ou nao), para nao
//               voltarem a ser trazidos amanha, depois de a conta ser paga.
// Mesa "ocupada" mas vazia fica como esta: nao ha o que cobrar.
export function decidirVirada(antigas = [], idsDeHoje = []) {
  const hoje = new Set(idsDeHoje.map(Number));
  const comItens = antigas.filter(a => temItensNaMesa(a.dados));
  const ultima = new Map();
  for (const a of comItens) {
    const u = ultima.get(Number(a.mesaId));
    if (!u || String(a.dataStr) > String(u.dataStr)) ultima.set(Number(a.mesaId), a);
  }
  const trazer = [...ultima.values()]
    .filter(a => !hoje.has(Number(a.mesaId)))
    // veioDe guarda o dia em que a mesa foi aberta de verdade, mesmo que ela
    // atravesse mais de uma virada
    .map(a => ({ mesaId: Number(a.mesaId), dataStr: a.dataStr, dados: { ...a.dados, veioDe: a.dados?.veioDe || a.dataStr } }));
  return { trazer, encerrar: comItens.map(a => a._id) };
}
