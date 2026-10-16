// ── PRODUÇÃO: matéria-prima vira produto pronto ─────────────
// Pedido da dona (15/10/2026): 5 kg de frango viram espetos de frango,
// medalhões etc.; carne + queijo viram espeto de carne com queijo.
// Cada produção é UM produto feito com um ou mais ingredientes do estoque.
// Os ingredientes saem, o produto entra, e o custo do produto passa a ser o
// desta produção (soma do custo dos ingredientes ÷ quantidade feita).
// Aqui ficam só as contas; o servidor lê e grava.

export const MAX_INSUMOS = 10;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000;
export const unidadeDe = (est) => (est?.tipo === "chopp" ? "L" : (est?.unidade || "un"));

// Confere o pedido antes de mexer no estoque. `lerQtd` aceita "0,5";
// `idValido` diz se o texto é um id do banco.
// Devolve { erro } ou { produtoId, quantidade, insumos: [{ estoqueId, quantidade }], observacao }.
export function validarProducao(body, lerQtd, idValido) {
  const produtoId = String(body?.produtoId || "");
  if (!idValido(produtoId)) return { erro: "Escolha o que foi produzido" };
  const quantidade = lerQtd(body?.quantidade);
  if (!Number.isFinite(quantidade) || quantidade <= 0 || quantidade > 1e6) return { erro: "Informe quanto foi produzido" };
  const brutos = Array.isArray(body?.insumos) ? body.insumos : [];
  if (brutos.length === 0) return { erro: "Informe o que foi usado (ex.: frango)" };
  if (brutos.length > MAX_INSUMOS) return { erro: `No máximo ${MAX_INSUMOS} ingredientes por produção` };
  const vistos = new Set();
  const insumos = [];
  for (const b of brutos) {
    const estoqueId = String(b?.estoqueId || "");
    if (!idValido(estoqueId)) return { erro: "Escolha cada ingrediente usado" };
    if (estoqueId === produtoId) return { erro: "O produto não pode ser ingrediente dele mesmo" };
    if (vistos.has(estoqueId)) return { erro: "Ingrediente repetido: junte as quantidades numa linha só" };
    vistos.add(estoqueId);
    const q = lerQtd(b?.quantidade);
    if (!Number.isFinite(q) || q <= 0 || q > 1e6) return { erro: "Informe quanto foi usado de cada ingrediente" };
    insumos.push({ estoqueId, quantidade: q });
  }
  return { produtoId, quantidade, insumos, observacao: String(body?.observacao || "").trim().slice(0, 200) };
}

// Custo pelo custo cadastrado de cada ingrediente. Se algum não tem custo,
// o custo do produto NÃO é calculado (sairia menor do que é): custoUnitario
// fica null e `semCusto` diz qual cadastrar.
export function custoDaProducao(insumos, estoquePorId, quantidadeProduzida) {
  let total = 0;
  const semCusto = [];
  const linhas = insumos.map((i) => {
    const est = estoquePorId[i.estoqueId];
    const cu = Number(est?.custoPorUnidade) || 0;
    if (!(cu > 0)) semCusto.push(est?.nome || "?");
    total += i.quantidade * cu;
    return { ...i, custoUnitario: cu };
  });
  return {
    linhas,
    custoTotal: r2(total),
    semCusto,
    custoUnitario: semCusto.length === 0 && quantidadeProduzida > 0 ? r4(total / quantidadeProduzida) : null,
  };
}

// Resumo de um período: por produto, quanto se fez, o custo médio e o
// rendimento de cada ingrediente (ex.: 13,3 espetos por kg de frango).
export function resumoProducoes(lista) {
  const porProduto = {};
  let custoTotal = 0;
  for (const p of lista) {
    custoTotal += Number(p.custoTotal) || 0;
    const k = String(p.produto.estoqueId);
    const pp = (porProduto[k] ||= { estoqueId: k, nome: p.produto.nome, unidade: p.produto.unidade, quantidade: 0, vezes: 0, custo: 0, qtdComCusto: 0, insumos: {} });
    pp.quantidade += p.produto.quantidade;
    pp.vezes++;
    if (p.produto.custoUnitario != null) { pp.custo += Number(p.custoTotal) || 0; pp.qtdComCusto += p.produto.quantidade; }
    for (const i of p.insumos || []) {
      const ki = String(i.estoqueId);
      const ii = (pp.insumos[ki] ||= { estoqueId: ki, nome: i.nome, unidade: i.unidade, usado: 0, produzido: 0 });
      ii.usado += i.quantidade;
      ii.produzido += p.produto.quantidade;
    }
  }
  return {
    lancamentos: lista.length,
    custoTotal: r2(custoTotal),
    porProduto: Object.values(porProduto)
      .map((pp) => ({
        estoqueId: pp.estoqueId, nome: pp.nome, unidade: pp.unidade,
        quantidade: r4(pp.quantidade), vezes: pp.vezes,
        custoMedio: pp.qtdComCusto > 0 ? r4(pp.custo / pp.qtdComCusto) : null,
        insumos: Object.values(pp.insumos).map((ii) => ({
          estoqueId: ii.estoqueId, nome: ii.nome, unidade: ii.unidade, usado: r4(ii.usado),
          // produto por unidade do ingrediente (13,3 espetos por kg) e o inverso (0,075 kg por espeto)
          rendimento: ii.usado > 0 ? Math.round((ii.produzido / ii.usado) * 10) / 10 : null,
          porUnidade: ii.produzido > 0 ? r4(ii.usado / ii.produzido) : null,
        })),
      }))
      .sort((a, b) => b.vezes - a.vezes || a.nome.localeCompare(b.nome, "pt-BR")),
  };
}
