// ── CONSUMO DA EQUIPE: quem paga quanto ─────────────────────
// Regra da casa (15/10/2026):
//   • Donos (Daiane, Rafael, Amanda, Leonardo) pagam o PREÇO DE CUSTO.
//   • Os demais funcionários pagam o preço do cardápio com R$ 2,00 de
//     desconto POR ESPETO (bebida e o resto, preço cheio). Esse valor pode
//     ser corrigido à mão no relatório.
// A lista de donos e o desconto ficam na config (Rel. → Equipe), para não
// precisar mexer no código quando entrar ou sair alguém.

import { CATEGORIAS_ESPETO } from "../cardapio/montado.js";

export const EQUIPE_PADRAO = {
  donos: ["Daiane", "Rafael", "Amanda", "Leonardo"],
  descontoEspeto: 2,
};

const arred = (v) => Math.round((Number(v) || 0) * 100) / 100;
// Sem acento, sem caixa, sem espaço sobrando
export const normalizarNome = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

// "Rafael", "rafael", "Rafael Silva" e "RAFAEL" são o dono Rafael.
export function ehDono(pessoa, donos = EQUIPE_PADRAO.donos) {
  const p = normalizarNome(pessoa);
  if (!p) return false;
  const primeiro = p.split(" ")[0];
  return (donos || []).some(d => {
    const n = normalizarNome(d);
    return n && (n === p || n === primeiro || n.split(" ")[0] === primeiro && n.split(" ").length === 1);
  });
}

const catsEspeto = new Set(CATEGORIAS_ESPETO.map(normalizarNome));
const doCardapio = (it, cardapio) =>
  (cardapio || []).find(c => it.id !== undefined && c.id === it.id)
  || (cardapio || []).find(c => normalizarNome(c.nome) === normalizarNome(it.nomeBase || it.nome));

// Quantos espetos há em UMA unidade do item: o lanche traz os espetos dele;
// item de categoria de espeto é 1; o resto (bebida, porção) é 0.
export function espetosNoItem(it, cardapio) {
  if (Array.isArray(it?.espetos) && it.espetos.length) return it.espetos.length;
  if (it?.espeto) return 1;
  const cat = it?.categoria ?? it?.cat ?? doCardapio(it, cardapio)?.categoria;
  return catsEspeto.has(normalizarNome(cat)) ? 1 : 0;
}

// Preço de funcionário de UMA unidade: cardápio menos o desconto por espeto
export function precoFuncionario(it, cardapio, desconto = EQUIPE_PADRAO.descontoEspeto) {
  const preco = Number(it?.preco) || 0;
  return arred(Math.max(0, preco - espetosNoItem(it, cardapio) * (Number(desconto) || 0)));
}

// Custo de UMA linha (qty unidades), pelo estoque ligado a ela. O lanche custa
// o pão (estoque do lanche) mais cada espeto escolhido. Sem custo cadastrado,
// conta em semCusto para o relatório avisar.
export function custoDaLinha(it, estoques) {
  const qty = Number(it?.qty) || 1;
  const espetos = Array.isArray(it?.espetos) && it.espetos.length ? it.espetos : (it?.espeto ? [it.espeto] : []);
  const partes = [it?.nomeBase || it?.nome, ...espetos].filter(Boolean);
  let custo = 0, semCusto = 0;
  for (const nome of partes) {
    const est = (estoques || []).find(e => (e.cardapioNomes || []).some(n => normalizarNome(n) === normalizarNome(nome)));
    const unit = est ? (Number(est.custoPorUnidade) || 0) * (Number(est.consumoPorVenda) || 1) : 0;
    if (unit > 0) custo += unit * qty; else semCusto++;
  }
  return { custo: arred(custo), semCusto };
}

// Tudo o que o registro precisa guardar no momento do consumo
export function calcularConsumo({ pessoa, itens, cardapio, estoques, config = EQUIPE_PADRAO }) {
  const donos = config?.donos || EQUIPE_PADRAO.donos;
  const desconto = config?.descontoEspeto ?? EQUIPE_PADRAO.descontoEspeto;
  const tipo = ehDono(pessoa, donos) ? "dono" : "funcionario";
  let custo = 0, semCusto = 0, precoFunc = 0;
  for (const it of itens || []) {
    const c = custoDaLinha(it, estoques);
    custo += c.custo; semCusto += c.semCusto;
    precoFunc += precoFuncionario(it, cardapio, desconto) * (Number(it.qty) || 1);
  }
  custo = arred(custo);
  return { tipo, custo, semCusto, valorRegra: tipo === "dono" ? custo : arred(precoFunc) };
}

// Valor que vale para o registro: dono = custo; funcionário = o que a dona
// corrigiu à mão, senão o da regra.
export function valorEfetivo(reg) {
  if (reg.tipo === "dono") return arred(reg.custo);
  return arred(reg.valor !== null && reg.valor !== undefined ? reg.valor : reg.valorRegra);
}
