// ── LANCHE MONTADO (base + espetinho) ────────────────────────
// O lanche é vendido como base (pão com gergelim, molho da casa, barbecue,
// vinagrete, alface) MAIS o espeto que o cliente escolhe. Em vez de cadastrar
// um item por sabor — e ter de corrigir todos sempre que o preço de um espeto
// muda —, o item guarda de quais categorias pode vir a escolha e o preço final
// é sempre base + espeto.
//
// item.montarCom  = ["Tradicionais", "Especiais", ...]  (vazio = item comum)
// item.montarRotulo = "Escolha o espetinho"

// Categorias que valem como espeto na casa
export const CATEGORIAS_ESPETO = ["Tradicionais", "Especiais", "Doces", "Churrasco Grego"];

// Lanche é base + espeto por natureza: quem se chama "Lanche..." já entra
// assim, sem ninguém precisar configurar nada. montarCom continua valendo
// para quem quiser escolher categorias diferentes.
export const ehMontado = (item) =>
  (Array.isArray(item?.montarCom) && item.montarCom.length > 0) || /^\s*lanche/i.test(item?.nome || "");

// De quais categorias vem a escolha deste item
const categoriasDo = (item) => (Array.isArray(item?.montarCom) && item.montarCom.length
  ? item.montarCom
  : CATEGORIAS_ESPETO.filter(c => c !== (item?.categoria ?? item?.cat)));

// Nomes vêm do cardápio, do painel e da IA: comparar sem acento e sem caixa
const chave = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const precoSimples = (i) => Number(i?.preco) || 0;
const categoriaDe = (i) => i?.categoria ?? i?.cat;

// Espetos que podem entrar neste lanche, já com o preço somado
export function opcoesMontado(item, cardapio, preco = precoSimples) {
  if (!ehMontado(item)) return [];
  const cats = categoriasDo(item).map(chave);
  return (cardapio || [])
    .filter(e => e.ativo !== false && e.id !== item.id && cats.includes(chave(categoriaDe(e))))
    .map(e => ({
      nome: e.nome,
      preco: Math.round((preco(item) + preco(e)) * 100) / 100,
      precoBase: preco(item),
      precoEspeto: preco(e),
      espetoId: e.id,
    }))
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome), "pt-BR", { sensitivity: "base" }));
}

// "Lanche Imperial (Picanha meia lua)" -> { base, espeto, nome, preco }
// null quando não é um lanche montado válido (o pedido é recusado nesse caso).
export function lerItemMontado(nome, cardapio, preco = precoSimples) {
  const m = String(nome || "").match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (!m) return null;
  const base = (cardapio || []).find(c => c.ativo !== false && ehMontado(c) && chave(c.nome) === chave(m[1]));
  if (!base) return null;
  const opcao = opcoesMontado(base, cardapio, preco).find(o => chave(o.nome) === chave(m[2]));
  if (!opcao) return null;
  return { base, espeto: opcao.nome, nome: `${base.nome} (${opcao.nome})`, preco: opcao.preco, opcao };
}

// Linha do cardápio do WhatsApp para um lanche montado
export function textoMontado(item, cardapio, preco = precoSimples) {
  const ops = opcoesMontado(item, cardapio, preco);
  if (!ops.length) return `R$${preco(item).toFixed(2)}`;
  const barato = ops.reduce((mn, o) => (o.preco < mn.preco ? o : mn), ops[0]);
  return `R$${preco(item).toFixed(2)} + o espetinho escolhido (ex.: com ${barato.nome} = R$${barato.preco.toFixed(2)})`;
}
