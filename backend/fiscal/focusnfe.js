// ── ADAPTADOR FOCUS NFe (NFC-e modelo 65) ─────────────────────
// Documentacao oficial: https://doc.focusnfe.com.br/reference/nfce
//   POST   /v2/nfce?ref=REF      emite (sincrono: autoriza ou rejeita na hora)
//   GET    /v2/nfce/REF          consulta
//   DELETE /v2/nfce/REF          cancela (ate 30 min, justificativa 15+ caracteres)
// Autenticacao: HTTP Basic, usuario = token da empresa, senha vazia.
//
// Certificado A1, CSC e ID do CSC ficam CADASTRADOS NA FOCUS (painel da
// empresa), nao vao em cada requisicao. Por isso aqui so entra o token.

const BASES = {
  homologacao: "https://homologacao.focusnfe.com.br",
  producao: "https://api.focusnfe.com.br",
};

// FOCUS_BASE_URL aponta para o simulador nos testes automatizados.
export function urlBase(ambiente) {
  return process.env.FOCUS_BASE_URL || BASES[ambiente] || BASES.homologacao;
}

// A referencia so aceita letras e numeros. O _id do Mongo ja e hexadecimal.
export function refDaNota(id) {
  return "imp" + String(id).replace(/[^A-Za-z0-9]/g, "");
}

// A SEFAZ aceita no maximo 5 minutos de diferenca e exige o fuso. O Parana
// esta em UTC-3 o ano todo (sem horario de verao desde 2019).
export function dataEmissaoBrasilia(d = new Date()) {
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19) + "-03:00";
}

const centavos = (v) => Math.round((Number(v) || 0) * 100);
const reais = (c) => Math.round(c) / 100;

// Divide o desconto da comanda entre os itens, na proporcao do valor de cada
// um. A soma tem de bater no centavo: o que sobra do arredondamento vai para
// o item mais caro. Sem isso a SEFAZ rejeita por divergencia de totais.
export function ratearDesconto(itens, desconto) {
  const totalC = itens.reduce((s, it) => s + centavos(it.valorTotal), 0);
  let descC = centavos(desconto);
  if (descC <= 0 || totalC <= 0) return itens.map(() => 0);
  if (descC > totalC) throw new ErroFiscal("Desconto maior que o valor dos itens", { definitivo: true });

  const partes = itens.map(it => Math.floor((centavos(it.valorTotal) * descC) / totalC));
  let resto = descC - partes.reduce((s, p) => s + p, 0);
  // Distribui o resto do maior para o menor, sem passar do valor do item
  const ordem = itens.map((it, i) => i).sort((a, b) => centavos(itens[b].valorTotal) - centavos(itens[a].valorTotal));
  for (let k = 0; resto > 0 && k < ordem.length * 2; k++) {
    const i = ordem[k % ordem.length];
    if (partes[i] < centavos(itens[i].valorTotal)) { partes[i]++; resto--; }
  }
  return partes.map(reais);
}

// Codigos de forma de pagamento (tPag) da NF-e 4.00
export const TPAG = {
  dinheiro: "01", credito: "03", debito: "04",
  pixDinamico: "17", pixEstatico: "20", outros: "99",
};
// Cartao e pix precisam do grupo de cartao; maquininha avulsa = nao integrado (2)
const PRECISA_INTEGRACAO = new Set(["03", "04", "17"]);

// Converte os pagamentos da venda para o formato da nota.
// A nota vale o valor da VENDA; a gorjeta nao e mercadoria e fica de fora.
// Quando os pagamentos passam do valor da nota (por causa da gorjeta), tira a
// diferenca proporcionalmente, para que a soma bata exatamente com a nota.
export function montarFormasPagamento(pagamentos, valorNota, cfg) {
  const codigoDe = (tipo) => ({
    dinheiro: TPAG.dinheiro,
    cartao: cfg.cartaoCodigo === "04" ? TPAG.debito : TPAG.credito,
    pix: cfg.pixCodigo === "17" ? TPAG.pixDinamico : TPAG.pixEstatico,
  })[tipo] || TPAG.outros;

  const lista = (pagamentos || [])
    .map(p => ({ codigo: codigoDe(p.tipo), c: centavos(p.valor) }))
    .filter(p => p.c > 0);
  const alvo = centavos(valorNota);
  if (!lista.length) throw new ErroFiscal("A venda nao tem forma de pagamento registrada", { definitivo: true });

  const soma = lista.reduce((s, p) => s + p.c, 0);
  if (soma < alvo - 1) {
    throw new ErroFiscal(`Pagamentos (R$ ${reais(soma).toFixed(2)}) menores que o valor da nota (R$ ${reais(alvo).toFixed(2)})`, { definitivo: true });
  }
  if (soma !== alvo) {
    // Reduz proporcionalmente e acerta o centavo no maior pagamento
    const novos = lista.map(p => Math.floor((p.c * alvo) / soma));
    const maior = novos.indexOf(Math.max(...novos));
    novos[maior] += alvo - novos.reduce((s, v) => s + v, 0);
    novos.forEach((v, i) => { lista[i].c = v; });
  }

  return lista.filter(p => p.c > 0).map(p => {
    const f = { forma_pagamento: p.codigo, valor_pagamento: reais(p.c) };
    if (PRECISA_INTEGRACAO.has(p.codigo)) f.tipo_integracao = "2";
    return f;
  });
}

// Monta o corpo da NFC-e.
//   itens: snapshot fiscal de montarItensFiscais (valores ja em reais)
//   valorNota: o que foi cobrado pela venda, ja com desconto e sem gorjeta
export function montarNfce({ cfg, itens, valorNota, pagamentos, cpf, nome, entrega = false, agora = new Date() }) {
  const somaItens = reais(itens.reduce((s, it) => s + centavos(it.valorTotal), 0));
  const desconto = reais(centavos(somaItens) - centavos(valorNota));
  if (desconto < 0) {
    throw new ErroFiscal(`Valor da venda (R$ ${Number(valorNota).toFixed(2)}) maior que a soma dos itens (R$ ${somaItens.toFixed(2)})`, { definitivo: true });
  }
  const descontos = ratearDesconto(itens, desconto);

  const nfce = {
    cnpj_emitente: String(cfg.cnpj || "").replace(/\D/g, ""),
    data_emissao: dataEmissaoBrasilia(agora),
    natureza_operacao: "VENDA AO CONSUMIDOR",
    tipo_documento: "1",
    finalidade_emissao: "1",
    consumidor_final: "1",
    presenca_comprador: entrega ? "4" : "1",
    modalidade_frete: "9",
    local_destino: "1",
    indicador_inscricao_estadual_destinatario: "9",
    items: itens.map((it, i) => {
      const item = {
        numero_item: String(i + 1),
        codigo_produto: String(it.codigo ?? i + 1),
        descricao: String(it.nome || "Item").slice(0, 120),
        codigo_ncm: String(it.ncm || "").replace(/\D/g, ""),
        cfop: String(it.cfop || "").replace(/\D/g, ""),
        unidade_comercial: String(it.unidade || "UN").slice(0, 6),
        unidade_tributavel: String(it.unidade || "UN").slice(0, 6),
        quantidade_comercial: Number(it.quantidade) || 1,
        quantidade_tributavel: Number(it.quantidade) || 1,
        valor_unitario_comercial: Number(it.valorUnitario) || 0,
        valor_unitario_tributavel: Number(it.valorUnitario) || 0,
        valor_bruto: Number(it.valorTotal) || 0,
        icms_origem: String(it.origem ?? "0"),
        icms_situacao_tributaria: String(it.csosn || ""),
        pis_situacao_tributaria: String(cfg.pisCst || "49"),
        cofins_situacao_tributaria: String(cfg.cofinsCst || "49"),
      };
      if (descontos[i] > 0) item.valor_desconto = descontos[i];
      const cest = String(it.cest || "").replace(/\D/g, "");
      if (cest) item.cest = cest;
      return item;
    }),
    formas_pagamento: montarFormasPagamento(pagamentos, valorNota, cfg),
  };

  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  if (cpfLimpo) nfce.cpf_destinatario = cpfLimpo;
  if (cpfLimpo && nome && nome !== "—") nfce.nome_destinatario = String(nome).slice(0, 60);
  return nfce;
}

// ── HTTP ─────────────────────────────────────────────────────
export class ErroFiscal extends Error {
  // definitivo: a SEFAZ ou a Focus recusaram o conteudo; tentar de novo igual nao adianta
  // incerto: nao sabemos se a nota foi autorizada (rede caiu no meio)
  constructor(mensagem, { definitivo = false, incerto = false, codigo = "", http = 0, statusSefaz = "" } = {}) {
    super(mensagem);
    this.definitivo = definitivo; this.incerto = incerto;
    this.codigo = codigo; this.http = http; this.statusSefaz = statusSefaz;
  }
}

// A SEFAZ pode demorar; a Focus responde so depois dela. FOCUS_TIMEOUT_MS e para testes.
const TIMEOUT_MS = Number(process.env.FOCUS_TIMEOUT_MS) || 60000;

async function chamar(cfg, metodo, caminho, corpo) {
  const token = String(cfg.apiToken || "");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(urlBase(cfg.ambiente) + caminho, {
      method: metodo,
      headers: {
        Authorization: "Basic " + Buffer.from(token + ":").toString("base64"),
        ...(corpo ? { "Content-Type": "application/json" } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: ctrl.signal,
    });
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { /* 401 vem em texto */ }
    return { http: r.status, json, texto };
  } finally {
    clearTimeout(t);
  }
}

function erroDaResposta({ http, json, texto }) {
  if (http === 401) return new ErroFiscal("Token da Focus NFe recusado. Confira o token e o ambiente (homologacao/producao).", { definitivo: true, http, codigo: "nao_autorizado" });
  const detalhes = Array.isArray(json?.erros) ? json.erros.map(e => (e.campo ? e.campo + ": " : "") + e.mensagem).join("; ") : "";
  const msg = (json?.mensagem || texto || ("HTTP " + http)) + (detalhes ? " — " + detalhes : "");
  // 5xx e limite de requisicoes sao passageiros; o resto e problema do conteudo
  const passageiro = http >= 500 || http === 429;
  return new ErroFiscal("Focus NFe: " + msg, { definitivo: !passageiro, http, codigo: json?.codigo || "" });
}

// Traduz o retorno de sucesso para o formato gravado na NotaFiscal
export function normalizarAutorizada(cfg, j) {
  const base = urlBase(cfg.ambiente);
  const abs = (c) => (!c ? null : /^https?:\/\//.test(c) ? c : base + c);
  return {
    numero: j.numero != null ? Number(j.numero) : null,
    serie: j.serie != null ? Number(j.serie) : null,
    chave: j.chave_nfe ? String(j.chave_nfe).replace(/^NFe/, "") : null,
    protocolo: j.protocolo || j.numero_protocolo || null,
    xmlUrl: abs(j.caminho_xml_nota_fiscal),
    danfeUrl: abs(j.caminho_danfe),
    qrCode: j.qrcode_url || null,
    urlConsulta: j.url_consulta_nf || null,
    statusSefaz: j.status_sefaz || "",
    mensagemSefaz: j.mensagem_sefaz || "",
  };
}

function interpretar(cfg, j) {
  if (j?.status === "autorizado") return { situacao: "autorizada", dados: normalizarAutorizada(cfg, j) };
  if (j?.status === "cancelado") return { situacao: "cancelada", dados: normalizarAutorizada(cfg, j) };
  if (j?.status === "processando_autorizacao") return { situacao: "processando" };
  if (j?.status === "erro_autorizacao" || j?.status === "denegado") {
    const motivo = [j.status_sefaz, j.mensagem_sefaz].filter(Boolean).join(" - ") || "rejeitada pela SEFAZ";
    return { situacao: "rejeitada", motivo, statusSefaz: j.status_sefaz || "" };
  }
  return { situacao: "desconhecida", motivo: "Resposta inesperada da Focus NFe: " + JSON.stringify(j).slice(0, 200) };
}

export async function consultar(cfg, ref) {
  let r;
  try { r = await chamar(cfg, "GET", "/v2/nfce/" + encodeURIComponent(ref) + "?completa=1"); }
  catch (e) { throw new ErroFiscal("Sem resposta da Focus NFe ao consultar: " + (e.name === "AbortError" ? "tempo esgotado" : e.message), { incerto: true }); }
  if (r.http === 404) return { situacao: "inexistente" };
  if (r.http !== 200) throw erroDaResposta(r);
  return interpretar(cfg, r.json);
}

// Emite e devolve os dados da nota autorizada. Qualquer outra coisa lanca
// ErroFiscal dizendo se foi recusa (definitivo) ou se ficou em duvida (incerto).
export async function emitir(cfg, ref, nfce) {
  let r;
  try {
    r = await chamar(cfg, "POST", "/v2/nfce?ref=" + encodeURIComponent(ref) + "&completa=1", nfce);
  } catch (e) {
    // A requisicao pode ter chegado e a nota ter sido autorizada. Pergunta antes
    // de dar como falha: emitir de novo geraria nota em duplicidade.
    return resolverDuvida(cfg, ref, "sem resposta da Focus NFe (" + (e.name === "AbortError" ? "tempo esgotado" : e.message) + ")");
  }

  // Referencia ja usada: a nota existe la; busca o resultado
  if (r.http === 422 && ["already_processed", "pending_operation"].includes(r.json?.codigo)) {
    return resolverDuvida(cfg, ref, r.json.mensagem);
  }
  if (r.http === 201 || r.http === 200) {
    const res = interpretar(cfg, r.json);
    if (res.situacao === "autorizada") return res.dados;
    if (res.situacao === "rejeitada") throw new ErroFiscal("SEFAZ: " + res.motivo, { definitivo: true, statusSefaz: res.statusSefaz });
    if (res.situacao === "processando") return resolverDuvida(cfg, ref, "ainda em processamento");
    throw new ErroFiscal(res.motivo, { incerto: true });
  }
  throw erroDaResposta(r);
}

async function resolverDuvida(cfg, ref, porque) {
  let c;
  try { c = await consultar(cfg, ref); }
  catch (e) { throw new ErroFiscal(`Resultado incerto (${porque}). Use "Consultar" antes de emitir de novo.`, { incerto: true }); }
  if (c.situacao === "autorizada") return c.dados;
  if (c.situacao === "rejeitada") throw new ErroFiscal("SEFAZ: " + c.motivo, { definitivo: true, statusSefaz: c.statusSefaz });
  if (c.situacao === "inexistente") throw new ErroFiscal(`A nota nao chegou a Focus NFe (${porque}). Pode emitir de novo.`, { definitivo: false });
  throw new ErroFiscal(`Resultado incerto (${porque}). Use "Consultar" antes de emitir de novo.`, { incerto: true });
}

export async function cancelar(cfg, ref, justificativa) {
  let r;
  try { r = await chamar(cfg, "DELETE", "/v2/nfce/" + encodeURIComponent(ref), { justificativa }); }
  catch (e) { throw new ErroFiscal("Sem resposta da Focus NFe ao cancelar. Consulte a nota antes de tentar de novo.", { incerto: true }); }
  if (r.http !== 200) throw erroDaResposta(r);
  if (r.json?.status === "cancelado") {
    return { protocolo: r.json.numero_protocolo || null, xmlCancelamentoUrl: r.json.caminho_xml_cancelamento ? urlBase(cfg.ambiente) + r.json.caminho_xml_cancelamento : null };
  }
  const motivo = [r.json?.status_sefaz, r.json?.mensagem_sefaz].filter(Boolean).join(" - ") || JSON.stringify(r.json);
  throw new ErroFiscal("Cancelamento recusado: " + motivo, { definitivo: true });
}

// Confere o token sem emitir nada: uma consulta de referencia que nao existe
// responde 404 com token valido e 401 com token errado.
export async function testarToken(cfg) {
  let r;
  try { r = await chamar(cfg, "GET", "/v2/nfce/imperioteste" + Date.now()); }
  catch (e) { return { ok: false, mensagem: "Sem resposta da Focus NFe: " + (e.name === "AbortError" ? "tempo esgotado" : e.message) }; }
  if (r.http === 401) return { ok: false, mensagem: "Token recusado pela Focus NFe neste ambiente." };
  if (r.http === 404 || r.http === 200) return { ok: true, mensagem: "Token aceito pela Focus NFe (" + (cfg.ambiente === "producao" ? "producao" : "homologacao") + ")." };
  const e = erroDaResposta(r);
  return { ok: false, mensagem: e.message };
}
