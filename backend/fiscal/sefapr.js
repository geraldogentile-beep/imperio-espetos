// ── EMISSÃO DIRETA NA SEFA-PR (NFC-e modelo 65, layout 4.00) ─────────────
// Sem intermediário pago: este módulo monta o XML da nota, assina com o
// certificado A1 da empresa, gera o QR Code com o CSC e conversa com os
// web services da SEFA-PR por SOAP 1.2 com certificado de cliente (mTLS).
//
// Referências: Manual de Orientação do Contribuinte (MOC) 7.0, layout 4.00;
// NT 2015.002 (QR Code 2.0); endereços dos serviços conforme ACBrNFeServicos.ini;
// cadeia TLS da SEFA-PR assinada pela raiz ICP-Brasil v10 (ca-icp-brasil-v10.pem,
// baixada do ITI), que o Node não traz por padrão.
//
// Quem chama: server.js (emitirNoProvedor/consultarNoProvedor/cancelarNoProvedor).
// Nada aqui grava no banco; só monta, assina, envia e interpreta.

import crypto from "crypto";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ErroFiscal, ratearDesconto, montarFormasPagamento, dataEmissaoBrasilia } from "./focusnfe.js";

export { ErroFiscal };

const NS = "http://www.portalfiscal.inf.br/nfe";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const C_UF_PR = "41";
const VERSAO = "4.00";
const VER_PROC = "ImperioEspetos 1.0";

// Endereços por ambiente. SEFAPR_URL_BASE aponta para o simulador nos testes.
const AMBIENTES = {
  homologacao: {
    base: "https://homologacao.nfce.sefa.pr.gov.br/nfce/",
    qrCode: "http://www.fazenda.pr.gov.br/nfce/qrcode",
    consulta: "http://www.fazenda.pr.gov.br/nfce/consulta",
    tpAmb: "2",
  },
  producao: {
    base: "https://nfce.sefa.pr.gov.br/nfce/",
    qrCode: "http://www.fazenda.pr.gov.br/nfce/qrcode",
    consulta: "http://www.fazenda.pr.gov.br/nfce/consulta",
    tpAmb: "1",
  },
};
const SERVICOS = {
  autorizacao:    { caminho: "NFeAutorizacao4",       metodo: "nfeAutorizacaoLote" },
  retAutorizacao: { caminho: "NFeRetAutorizacao4",    metodo: "nfeRetAutorizacaoLote" },
  consulta:       { caminho: "NFeConsultaProtocolo4", metodo: "nfeConsultaNF" },
  status:         { caminho: "NFeStatusServico4",     metodo: "nfeStatusServicoNF" },
  evento:         { caminho: "NFeRecepcaoEvento4",    metodo: "nfeRecepcaoEvento" },
};

// No Paraná a NFC-e pode ser cancelada em até 24 horas (NPF 100/2014)
export const PRAZO_CANCELAMENTO_MIN = 24 * 60;

const TIMEOUT_MS = Number(process.env.SEFAPR_TIMEOUT_MS) || 45000;

export function ambiente(nome) {
  const a = AMBIENTES[nome] || AMBIENTES.homologacao;
  return process.env.SEFAPR_URL_BASE ? { ...a, base: process.env.SEFAPR_URL_BASE.replace(/\/?$/, "/") } : a;
}

// ── Texto e números no formato do XML ────────────────────────
// O texto sai já na forma canônica (C14N): só &, < e > escapados. Aspas e
// apóstrofos ficam como estão — se escapássemos, o resumo (digest) da
// assinatura não bateria com o que a SEFAZ calcula depois de ler o XML.
export function esc(valor, max) {
  let s = String(valor ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (max) s = s.slice(0, max).trim();
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const v2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const q4 = (n) => (Number(n) || 0).toFixed(4);
const digitos = (s) => String(s || "").replace(/\D/g, "");
const el = (nome, conteudo) => (conteudo === undefined || conteudo === null || conteudo === "" ? "" : `<${nome}>${conteudo}</${nome}>`);

// ── Chave de acesso ──────────────────────────────────────────
export function calcularDV(c43) {
  let soma = 0, peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) {
    soma += Number(c43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

// cNF: 8 dígitos aleatórios, diferentes do número da nota (regra da SEFAZ)
export function gerarCNF(numero) {
  for (;;) {
    const c = String(crypto.randomInt(0, 100000000)).padStart(8, "0");
    if (c !== String(numero).padStart(8, "0") && c !== "00000000") return c;
  }
}

export function montarChave({ cnpj, serie, numero, cNF, dhEmi, tpEmis = "1" }) {
  const aamm = dhEmi.slice(2, 4) + dhEmi.slice(5, 7);
  const c43 = C_UF_PR + aamm + digitos(cnpj).padStart(14, "0") + "65"
    + String(serie).padStart(3, "0") + String(numero).padStart(9, "0") + tpEmis + cNF;
  if (c43.length !== 43) throw new ErroFiscal("Dados da chave de acesso incompletos", { definitivo: true });
  return c43 + calcularDV(c43);
}

// ── QR Code 2.0 (emissão online) ─────────────────────────────
// p = chave|2|tpAmb|idCSC|hash, hash = SHA-1(chave|2|tpAmb|idCSC + CSC).
// O idCSC vai sem zeros à esquerda ("000001" -> "1").
export function montarQrCode({ chave, tpAmb, cscId, csc, url }) {
  const id = String(parseInt(digitos(cscId) || "0", 10));
  const p = `${chave}|2|${tpAmb}|${id}`;
  const hash = crypto.createHash("sha1").update(p + String(csc), "utf8").digest("hex").toUpperCase();
  return `${url}?p=${p}|${hash}`;
}

// ── Assinatura XML (XMLDSig enveloped, RSA-SHA1 — padrão da NF-e) ────────
// O elemento é gerado já em forma canônica (sem espaços entre tags, sem
// elementos vazios auto-fechados). Como ele herda o xmlns do pai, a forma
// canônica o traz declarado no próprio elemento; é sobre isso que se calcula
// o resumo.
export function assinarElemento(xmlElemento, id, cert) {
  const c14n = xmlElemento.replace(/^<([A-Za-z]+)/, `<$1 xmlns="${NS}"`);
  const digest = crypto.createHash("sha1").update(c14n, "utf8").digest("base64");
  const signedInfo =
    `<SignedInfo><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${NS_DSIG}rsa-sha1"></SignatureMethod>` +
    `<Reference URI="#${id}"><Transforms>` +
    `<Transform Algorithm="${NS_DSIG}enveloped-signature"></Transform>` +
    `<Transform Algorithm="${C14N}"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${NS_DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
  const signedInfoC14n = signedInfo.replace(/^<SignedInfo/, `<SignedInfo xmlns="${NS_DSIG}"`);
  const assinatura = crypto.sign("RSA-SHA1", Buffer.from(signedInfoC14n, "utf8"), cert.pemChave).toString("base64");
  const certB64 = String(cert.pemCertificado).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return `<Signature xmlns="${NS_DSIG}">${signedInfo}<SignatureValue>${assinatura}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

// ── Montagem da NFC-e ────────────────────────────────────────
const TEXTO_HOMOLOG_ITEM = "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
const TEXTO_HOMOLOG_DEST = "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";
const PRECISA_CARD = new Set(["03", "04", "17"]);

// Simples Nacional: o grupo do XML não é "ICMSSN + CSOSN" para todos.
// 102, 103, 300 e 400 usam o mesmo grupo ICMSSN102; 500 (ICMS já retido por
// ST: cerveja, refrigerante, água) e 900 têm grupo próprio. 101 (crédito para
// o comprador) e 201/202/203 (a empresa cobrando ST adiante) pedem campos de
// crédito/ST que não cabem numa venda ao consumidor; ficam recusados aqui.
const GRUPO_CSOSN = { "102": "ICMSSN102", "103": "ICMSSN102", "300": "ICMSSN102", "400": "ICMSSN102", "500": "ICMSSN500", "900": "ICMSSN900" };
function grupoIcms(it) {
  const csosn = digitos(it.csosn);
  const orig = /^[0-8]$/.test(String(it.origem)) ? String(it.origem) : "0";
  const nome = GRUPO_CSOSN[csosn];
  return `<ICMS><${nome}><orig>${orig}</orig><CSOSN>${csosn}</CSOSN></${nome}></ICMS>`;
}
function grupoPisCofins(nome, cst) {
  const c = String(cst || "49").padStart(2, "0");
  if (["04", "05", "06", "07", "08", "09"].includes(c)) return `<${nome}><${nome}NT><CST>${c}</CST></${nome}NT></${nome}>`;
  const p = nome === "PIS" ? "pPIS" : "pCOFINS";
  const v = nome === "PIS" ? "vPIS" : "vCOFINS";
  return `<${nome}><${nome}Outr><CST>${c}</CST><vBC>0.00</vBC><${p}>0.00</${p}><${v}>0.00</${v}></${nome}Outr></${nome}>`;
}

// Monta e assina a NFC-e. Devolve { xml, chave, cNF, qrCode, dhEmi }.
//   itens: snapshot fiscal de montarItensFiscais (server.js)
//   valorNota: cobrado na venda, já com desconto e sem gorjeta
//   numero/serie: reservados pelo servidor; cert: { pemChave, pemCertificado }
export function montarNfce({ cfg, itens, valorNota, pagamentos, cpf, nome, entrega = false, agora = new Date(), numero, serie, cert, csc, cscId, cNF }) {
  const amb = ambiente(cfg.ambiente);
  const homolog = amb.tpAmb === "2";
  const cnpj = digitos(cfg.cnpj);
  if (cnpj.length !== 14) throw new ErroFiscal("CNPJ do emitente inválido", { definitivo: true });
  if (!itens?.length) throw new ErroFiscal("Nota sem itens", { definitivo: true });
  if (!(Number(numero) > 0)) throw new ErroFiscal("Número da nota não reservado", { definitivo: true });

  const dhEmi = dataEmissaoBrasilia(agora);
  cNF = cNF || gerarCNF(numero);
  const chave = montarChave({ cnpj, serie, numero, cNF, dhEmi });

  const cent = (v) => Math.round((Number(v) || 0) * 100);
  const somaItens = itens.reduce((s, it) => s + cent(it.valorTotal), 0);
  const desconto = somaItens - cent(valorNota);
  if (desconto < 0) {
    throw new ErroFiscal(`Valor da venda (R$ ${Number(valorNota).toFixed(2)}) maior que a soma dos itens (R$ ${(somaItens / 100).toFixed(2)})`, { definitivo: true });
  }
  const descontos = ratearDesconto(itens, desconto / 100);

  // ide
  let ide = `<ide><cUF>${C_UF_PR}</cUF><cNF>${cNF}</cNF><natOp>VENDA AO CONSUMIDOR</natOp><mod>65</mod>` +
    `<serie>${Number(serie)}</serie><nNF>${Number(numero)}</nNF><dhEmi>${dhEmi}</dhEmi><tpNF>1</tpNF><idDest>1</idDest>` +
    `<cMunFG>${digitos(cfg.endereco?.codigoMunicipio)}</cMunFG><tpImp>4</tpImp><tpEmis>1</tpEmis><cDV>${chave.slice(-1)}</cDV>` +
    `<tpAmb>${amb.tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>${entrega ? "4" : "1"}</indPres>` +
    (entrega ? `<indIntermed>0</indIntermed>` : "") +
    `<procEmi>0</procEmi><verProc>${esc(VER_PROC, 20)}</verProc></ide>`;

  // emit
  const e = cfg.endereco || {};
  const emit = `<emit><CNPJ>${cnpj}</CNPJ><xNome>${esc(cfg.razaoSocial, 60)}</xNome>` + el("xFant", esc(cfg.nomeFantasia, 60)) +
    `<enderEmit><xLgr>${esc(e.logradouro, 60)}</xLgr><nro>${esc(e.numero || "S/N", 60)}</nro>` + el("xCpl", esc(e.complemento, 60)) +
    `<xBairro>${esc(e.bairro, 60)}</xBairro><cMun>${digitos(e.codigoMunicipio)}</cMun><xMun>${esc(e.municipio, 60)}</xMun>` +
    `<UF>${esc(e.uf || "PR", 2).toUpperCase()}</UF><CEP>${digitos(e.cep).padStart(8, "0")}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais></enderEmit>` +
    `<IE>${digitos(cfg.ie)}</IE><CRT>${/^[123]$/.test(String(cfg.crt)) ? cfg.crt : "1"}</CRT></emit>`;

  // dest (só com CPF na nota)
  const cpfLimpo = digitos(cpf);
  let dest = "";
  if (cpfLimpo) {
    if (cpfLimpo.length !== 11) throw new ErroFiscal("CPF do cliente inválido", { definitivo: true });
    const xNome = homolog ? TEXTO_HOMOLOG_DEST : (nome && nome !== "—" ? esc(nome, 60) : "");
    dest = `<dest><CPF>${cpfLimpo}</CPF>` + el("xNome", xNome) + `<indIEDest>9</indIEDest></dest>`;
  }

  // det
  let vProdTotal = 0, vDescTotal = 0;
  const dets = itens.map((it, i) => {
    const qtd = Number(it.quantidade) || 1;
    const vUn = v2(it.valorUnitario);
    const vProd = v2(it.valorTotal);
    const vDesc = descontos[i] > 0 ? v2(descontos[i]) : "";
    vProdTotal += cent(vProd); vDescTotal += cent(vDesc || 0);
    const xProd = homolog && i === 0 ? TEXTO_HOMOLOG_ITEM : esc(it.nome || "Item", 120);
    const un = esc(it.unidade || "UN", 6) || "UN";
    const ncm = digitos(it.ncm), cfop = digitos(it.cfop), cest = digitos(it.cest);
    if (ncm.length !== 8) throw new ErroFiscal(`${it.nome}: NCM deve ter 8 dígitos (${it.ncm || "vazio"})`, { definitivo: true });
    if (cfop.length !== 4) throw new ErroFiscal(`${it.nome}: CFOP deve ter 4 dígitos (${it.cfop || "vazio"})`, { definitivo: true });
    if (/^(101|201|202|203)$/.test(digitos(it.csosn))) throw new ErroFiscal(`${it.nome}: CSOSN ${digitos(it.csosn)} não se usa em venda ao consumidor (é para crédito ao comprador ou para cobrar ST adiante). Confira com o contador: em geral é 102 ou, para bebida com ST já paga, 500.`, { definitivo: true });
    if (!GRUPO_CSOSN[digitos(it.csosn)]) throw new ErroFiscal(`${it.nome}: CSOSN inválido (${it.csosn || "vazio"})`, { definitivo: true });
    return `<det nItem="${i + 1}"><prod><cProd>${esc(it.codigo ?? i + 1, 60)}</cProd><cEAN>SEM GTIN</cEAN><xProd>${xProd}</xProd>` +
      `<NCM>${ncm}</NCM>` + el("CEST", cest) + `<CFOP>${cfop}</CFOP><uCom>${un}</uCom><qCom>${q4(qtd)}</qCom><vUnCom>${vUn}</vUnCom>` +
      `<vProd>${vProd}</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>${un}</uTrib><qTrib>${q4(qtd)}</qTrib><vUnTrib>${vUn}</vUnTrib>` +
      el("vDesc", vDesc) + `<indTot>1</indTot></prod>` +
      `<imposto>${grupoIcms(it)}${grupoPisCofins("PIS", cfg.pisCst)}${grupoPisCofins("COFINS", cfg.cofinsCst)}</imposto></det>`;
  }).join("");

  const vNF = vProdTotal - vDescTotal;
  if (vNF !== cent(valorNota)) throw new ErroFiscal("Total da nota não fecha com os itens e o desconto", { definitivo: true });
  const total = `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST>` +
    `<vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${v2(vProdTotal / 100)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg>` +
    `<vDesc>${v2(vDescTotal / 100)}</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS>` +
    `<vOutro>0.00</vOutro><vNF>${v2(vNF / 100)}</vNF></ICMSTot></total>`;

  // pag — reaproveita a regra da Focus (gorjeta fora, soma igual ao valor da nota)
  const formas = montarFormasPagamento(pagamentos, valorNota, cfg);
  const pag = `<pag>` + formas.map(f =>
    `<detPag><indPag>0</indPag><tPag>${f.forma_pagamento}</tPag><vPag>${v2(f.valor_pagamento)}</vPag>` +
    (PRECISA_CARD.has(f.forma_pagamento) ? `<card><tpIntegra>2</tpIntegra></card>` : "") + `</detPag>`).join("") + `</pag>`;

  // infRespTec: sistema de uso próprio — o responsável é a própria empresa
  // CSRT (NPF 063/2012 item 2.8): gerado no UPD para o fornecedor do sistema;
  // vai o id (2 dígitos) e o SHA-1 de CSRT + chave em base64 (NT 2018.005)
  const rt = cfg.respTec || {};
  const csrt = String(rt.csrt || "").trim(), idCSRT = digitos(rt.idCSRT);
  const grupoCsrt = csrt && idCSRT
    ? `<idCSRT>${String(parseInt(idCSRT, 10)).padStart(2, "0")}</idCSRT><hashCSRT>${crypto.createHash("sha1").update(csrt + chave, "utf8").digest("base64")}</hashCSRT>`
    : "";
  const respTec = rt.email && digitos(rt.fone).length >= 6
    ? `<infRespTec><CNPJ>${cnpj}</CNPJ><xContato>${esc(rt.contato || cfg.razaoSocial, 60)}</xContato><email>${esc(rt.email, 60)}</email><fone>${digitos(rt.fone).slice(0, 14)}</fone>${grupoCsrt}</infRespTec>`
    : "";

  const id = "NFe" + chave;
  const infNFe = `<infNFe Id="${id}" versao="${VERSAO}">${ide}${emit}${dest}${dets}${total}<transp><modFrete>9</modFrete></transp>${pag}${respTec}</infNFe>`;
  const qrCode = montarQrCode({ chave, tpAmb: amb.tpAmb, cscId, csc, url: amb.qrCode });
  const infNFeSupl = `<infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${amb.consulta}</urlChave></infNFeSupl>`;
  const assinatura = assinarElemento(infNFe, id, cert);
  const xml = `<NFe xmlns="${NS}">${infNFe}${infNFeSupl}${assinatura}</NFe>`;
  return { xml, chave, cNF, qrCode, dhEmi };
}

// XML final guardado: nota + protocolo de autorização
export function montarProcNFe(xmlNFe, protNFe) {
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="${VERSAO}">${xmlNFe}${protNFe}</nfeProc>`;
}

// ── Leitura das respostas ────────────────────────────────────
// As respostas da SEFAZ são pequenas e previsíveis; uma leitura por tag basta.
export function tag(xml, nome) {
  const m = String(xml || "").match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`));
  return m ? m[1].trim() : "";
}
export function bloco(xml, nome) {
  const m = String(xml || "").match(new RegExp(`<${nome}(?:\\s[^>]*)?>[\\s\\S]*?</${nome}>`));
  return m ? m[0] : "";
}
const desescapar = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// ── Transporte (SOAP 1.2 + mTLS) ─────────────────────────────
const AQUI = path.dirname(fileURLToPath(import.meta.url));
let CA_PEMS = null;
function cadeiaConfiavel() {
  if (CA_PEMS) return CA_PEMS;
  const pems = [];
  for (const arquivo of [path.join(AQUI, "ca-icp-brasil-v10.pem"), process.env.SEFAPR_CA_EXTRA].filter(Boolean)) {
    try { pems.push(fs.readFileSync(arquivo, "utf8")); } catch (e) { console.warn("SEFA-PR: não li a CA " + arquivo + ": " + e.message); }
  }
  CA_PEMS = pems;
  return pems;
}

function requisicao(url, corpo, headers, tls) {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const opcoes = {
    method: "POST", hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
    headers: { ...headers, "Content-Length": Buffer.byteLength(corpo) },
    timeout: TIMEOUT_MS,
  };
  if (u.protocol === "https:") {
    Object.assign(opcoes, { key: tls.key, cert: tls.cert, ca: cadeiaConfiavel(), servername: u.hostname });
    if (process.env.SEFAPR_TLS_SEM_VALIDACAO === "1") {
      console.warn("SEFA-PR: validação TLS DESLIGADA por SEFAPR_TLS_SEM_VALIDACAO — use só para diagnóstico");
      opcoes.rejectUnauthorized = false;
    }
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opcoes, (res) => {
      const partes = [];
      res.on("data", (c) => partes.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(partes).toString("utf8") }));
    });
    req.on("timeout", () => { req.destroy(new Error("tempo esgotado")); });
    req.on("error", reject);
    req.end(corpo);
  });
}

async function soap(ctx, servico, xmlDados) {
  const { caminho, metodo } = SERVICOS[servico];
  const ns = `${NS}/wsdl/${caminho}`;
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
    `<nfeDadosMsg xmlns="${ns}">${xmlDados}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
  const url = ambiente(ctx.ambiente).base + caminho;
  const r = await requisicao(url, envelope, {
    "Content-Type": `application/soap+xml; charset=utf-8; action="${ns}/${metodo}"`,
    "User-Agent": VER_PROC,
  }, { key: ctx.cert.pemChave, cert: ctx.cert.pemCertificado });
  if (r.status !== 200) {
    const motivo = tag(r.body, "soap12:Text") || tag(r.body, "soap:Text") || tag(r.body, "faultstring") || r.body.slice(0, 200);
    throw new ErroFiscal(`SEFA-PR respondeu HTTP ${r.status} em ${caminho}: ${desescapar(motivo) || "sem detalhe"}`, { http: r.status, codigo: "http" });
  }
  return r.body;
}

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const motivoRede = (e) => (e?.message === "tempo esgotado" ? "tempo esgotado" : (e?.code || e?.message || "falha de rede"));

// Dados que o servidor grava a partir de um protNFe autorizado
function dadosAutorizados(chave, protNFe, xmlNFe) {
  const infProt = bloco(protNFe, "infProt");
  return {
    numero: Number(chave.slice(25, 34)),
    serie: Number(chave.slice(22, 25)),
    chave,
    protocolo: tag(infProt, "nProt") || null,
    dataAutorizacao: tag(infProt, "dhRecbto") || null,
    statusSefaz: tag(infProt, "cStat") || "100",
    mensagemSefaz: desescapar(tag(infProt, "xMotivo")),
    xml: montarProcNFe(xmlNFe, protNFe),
    prazoCancelamentoMin: PRAZO_CANCELAMENTO_MIN,
  };
}

// cStat que dizem "a SEFAZ não está atendendo agora": vale tentar de novo
const PASSAGEIROS = new Set(["108", "109", "656", "999"]);
// cStat em que o número da nota ficou gasto (outra nota com o mesmo número existe)
const NUMERO_GASTO = new Set(["204", "206", "539", "613"]);

function erroDaSefaz(cStat, xMotivo, { numeroConsumido = false } = {}) {
  const msg = `SEFAZ ${cStat}: ${desescapar(xMotivo) || "sem motivo"}`;
  if (PASSAGEIROS.has(cStat)) return new ErroFiscal(msg + " (tente de novo em instantes)", { statusSefaz: cStat });
  const e = new ErroFiscal(msg, { definitivo: true, statusSefaz: cStat });
  e.numeroConsumido = numeroConsumido || NUMERO_GASTO.has(cStat);
  return e;
}

// ── Emissão (síncrona, indSinc=1) ────────────────────────────
// Devolve os dados autorizados ou lança ErroFiscal:
//   definitivo -> a SEFAZ recusou (numeroConsumido diz se o número pode voltar)
//   incerto    -> não se sabe se autorizou; consultar pela chave antes de repetir
export async function emitir(ctx, { xml, chave }) {
  const envi = `<enviNFe xmlns="${NS}" versao="${VERSAO}"><idLote>${Date.now()}</idLote><indSinc>1</indSinc>${xml}</enviNFe>`;
  let resposta;
  try {
    resposta = await soap(ctx, "autorizacao", envi);
  } catch (e) {
    if (e instanceof ErroFiscal && e.http) throw e;        // HTTP de erro: não processou
    return resolverDuvida(ctx, chave, xml, "sem resposta da SEFA-PR (" + motivoRede(e) + ")");
  }
  return interpretarRetEnvi(ctx, resposta, chave, xml);
}

async function interpretarRetEnvi(ctx, resposta, chave, xml) {
  const ret = bloco(resposta, "retEnviNFe") || bloco(resposta, "retConsReciNFe");
  if (!ret) throw new ErroFiscal("Resposta inesperada da SEFA-PR: " + resposta.slice(0, 200), { incerto: true });
  const protNFe = bloco(ret, "protNFe");
  const cStatLote = tag(ret.replace(protNFe, ""), "cStat");

  if (protNFe) return interpretarProt(ctx, protNFe, chave, xml);
  if (cStatLote === "103" || cStatLote === "105") {
    // Lote recebido, ainda em processamento: busca o resultado pelo recibo
    const nRec = tag(ret, "nRec");
    const tMed = Math.min(10, Math.max(1, Number(tag(ret, "tMed")) || 2));
    return consultarRecibo(ctx, nRec, tMed, chave, xml);
  }
  throw erroDaSefaz(cStatLote, tag(ret, "xMotivo"));
}

function interpretarProt(ctx, protNFe, chave, xml) {
  const infProt = bloco(protNFe, "infProt");
  const cStat = tag(infProt, "cStat");
  const chNFe = tag(infProt, "chNFe");
  if (chNFe && chNFe !== chave) throw new ErroFiscal(`Protocolo de outra chave (${chNFe})`, { incerto: true });
  if (cStat === "100" || cStat === "150") return dadosAutorizados(chave, protNFe, xml);
  if (cStat === "110" || cStat === "301" || cStat === "302" || cStat === "303") {
    // Denegada: o número ficou gasto e a nota existe na SEFAZ como denegada
    throw erroDaSefaz(cStat, tag(infProt, "xMotivo"), { numeroConsumido: true });
  }
  throw erroDaSefaz(cStat, tag(infProt, "xMotivo"));
}

async function consultarRecibo(ctx, nRec, tMed, chave, xml) {
  if (!nRec) throw new ErroFiscal("SEFA-PR não devolveu o recibo do lote", { incerto: true });
  const cons = `<consReciNFe xmlns="${NS}" versao="${VERSAO}"><tpAmb>${ambiente(ctx.ambiente).tpAmb}</tpAmb><nRec>${nRec}</nRec></consReciNFe>`;
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    await dormir(tMed * 1000);
    let resposta;
    try { resposta = await soap(ctx, "retAutorizacao", cons); }
    catch (e) { return resolverDuvida(ctx, chave, xml, "sem resposta ao consultar o recibo (" + motivoRede(e) + ")"); }
    const ret = bloco(resposta, "retConsReciNFe");
    const protNFe = bloco(ret, "protNFe");
    if (protNFe) return interpretarProt(ctx, protNFe, chave, xml);
    const cStat = tag(ret, "cStat");
    if (cStat !== "105") throw erroDaSefaz(cStat, tag(ret, "xMotivo"));
  }
  return resolverDuvida(ctx, chave, xml, "lote continua em processamento");
}

// Em dúvida (rede caiu, lote preso), pergunta pela chave antes de desistir.
async function resolverDuvida(ctx, chave, xml, porque) {
  let c;
  try { c = await consultar(ctx, chave, xml); }
  catch { throw new ErroFiscal(`Resultado incerto (${porque}). Use "Consultar" antes de emitir de novo.`, { incerto: true }); }
  if (c.situacao === "autorizada") return c.dados;
  if (c.situacao === "inexistente") {
    const e = new ErroFiscal(`A nota não chegou à SEFA-PR (${porque}). Pode emitir de novo.`, { definitivo: false });
    e.naoChegou = true;
    throw e;
  }
  if (c.situacao === "rejeitada") throw new ErroFiscal("SEFAZ: " + c.motivo, { definitivo: true, statusSefaz: c.statusSefaz });
  throw new ErroFiscal(`Resultado incerto (${porque}). Use "Consultar" antes de emitir de novo.`, { incerto: true });
}

// ── Consulta pela chave ──────────────────────────────────────
// { situacao: autorizada|cancelada|rejeitada|inexistente|processando, dados?, motivo?, statusSefaz }
export async function consultar(ctx, chave, xmlNFe = "") {
  if (!/^\d{44}$/.test(String(chave || ""))) return { situacao: "inexistente", motivo: "nota sem chave de acesso" };
  const cons = `<consSitNFe xmlns="${NS}" versao="${VERSAO}"><tpAmb>${ambiente(ctx.ambiente).tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;
  let resposta;
  try { resposta = await soap(ctx, "consulta", cons); }
  catch (e) { throw new ErroFiscal("Sem resposta da SEFA-PR ao consultar: " + motivoRede(e), { incerto: true }); }
  const ret = bloco(resposta, "retConsSitNFe");
  const protNFe = bloco(ret, "protNFe");
  const cStat = tag(ret.replace(protNFe, "").replace(bloco(ret, "procEventoNFe"), ""), "cStat");
  const xMotivo = desescapar(tag(ret, "xMotivo"));
  if (cStat === "100" || cStat === "150") return { situacao: "autorizada", dados: dadosAutorizados(chave, protNFe, xmlNFe), statusSefaz: cStat };
  if (cStat === "101" || cStat === "151" || cStat === "155") return { situacao: "cancelada", statusSefaz: cStat, motivo: xMotivo, protocolo: tag(protNFe, "nProt") || null };
  if (cStat === "217" || cStat === "562") return { situacao: "inexistente", statusSefaz: cStat, motivo: xMotivo };
  if (cStat === "110" || cStat === "301" || cStat === "302" || cStat === "303") return { situacao: "rejeitada", statusSefaz: cStat, motivo: `${cStat} - ${xMotivo}` };
  if (PASSAGEIROS.has(cStat)) throw new ErroFiscal(`SEFAZ ${cStat}: ${xMotivo} (tente de novo em instantes)`, { statusSefaz: cStat });
  return { situacao: "desconhecida", statusSefaz: cStat, motivo: `${cStat} - ${xMotivo}` };
}

// ── Cancelamento (evento 110111) ─────────────────────────────
export async function cancelar(ctx, { chave, protocolo, cnpj, justificativa, agora = new Date(), cert }) {
  const just = esc(justificativa, 255);
  if (just.length < 15) throw new ErroFiscal("A justificativa precisa ter ao menos 15 caracteres", { definitivo: true });
  if (!protocolo) throw new ErroFiscal("Nota sem protocolo de autorização; consulte antes de cancelar", { definitivo: true });
  const tpAmb = ambiente(ctx.ambiente).tpAmb;
  const id = `ID110111${chave}01`;
  const infEvento = `<infEvento Id="${id}"><cOrgao>${C_UF_PR}</cOrgao><tpAmb>${tpAmb}</tpAmb><CNPJ>${digitos(cnpj)}</CNPJ><chNFe>${chave}</chNFe>` +
    `<dhEvento>${dataEmissaoBrasilia(agora)}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>` +
    `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${digitos(protocolo)}</nProt><xJust>${just}</xJust></detEvento></infEvento>`;
  const evento = `<evento xmlns="${NS}" versao="1.00">${infEvento}${assinarElemento(infEvento, id, cert || ctx.cert)}</evento>`;
  const env = `<envEvento xmlns="${NS}" versao="1.00"><idLote>${Date.now()}</idLote>${evento}</envEvento>`;

  let resposta;
  try { resposta = await soap(ctx, "evento", env); }
  catch (e) {
    if (e instanceof ErroFiscal && e.http) throw e;
    throw new ErroFiscal("Sem resposta da SEFA-PR ao cancelar (" + motivoRede(e) + "). Consulte a nota antes de tentar de novo.", { incerto: true });
  }
  const retEvento = bloco(resposta, "retEvento");
  const inf = bloco(retEvento, "infEvento");
  const cStat = tag(inf, "cStat") || tag(bloco(resposta, "retEnvEvento"), "cStat");
  const xMotivo = desescapar(tag(inf, "xMotivo") || tag(bloco(resposta, "retEnvEvento"), "xMotivo"));
  if (cStat === "135" || cStat === "136" || cStat === "155") {
    return {
      protocolo: tag(inf, "nProt") || null,
      statusSefaz: cStat,
      xml: `<?xml version="1.0" encoding="UTF-8"?><procEventoNFe xmlns="${NS}" versao="1.00">${evento}${retEvento}</procEventoNFe>`,
    };
  }
  if (PASSAGEIROS.has(cStat)) throw new ErroFiscal(`SEFAZ ${cStat}: ${xMotivo} (tente de novo em instantes)`, { statusSefaz: cStat });
  throw new ErroFiscal(`Cancelamento recusado — SEFAZ ${cStat}: ${xMotivo}`, { definitivo: true, statusSefaz: cStat });
}

// ── Status do serviço (botão "Testar conexão") ───────────────
export async function statusServico(ctx) {
  const cons = `<consStatServ xmlns="${NS}" versao="${VERSAO}"><tpAmb>${ambiente(ctx.ambiente).tpAmb}</tpAmb><cUF>${C_UF_PR}</cUF><xServ>STATUS</xServ></consStatServ>`;
  let resposta;
  try { resposta = await soap(ctx, "status", cons); }
  catch (e) {
    const m = motivoRede(e);
    const dica = /CERT|certificate|handshake|alert/i.test(m) ? " — a SEFA-PR não aceitou o certificado (confira validade e se é da empresa)" : "";
    return { ok: false, mensagem: "Sem resposta da SEFA-PR: " + m + dica };
  }
  const ret = bloco(resposta, "retConsStatServ");
  const cStat = tag(ret, "cStat"), xMotivo = desescapar(tag(ret, "xMotivo"));
  return { ok: cStat === "107", cStat, mensagem: `SEFA-PR ${cStat}: ${xMotivo}` + (tag(ret, "verAplic") ? ` (${tag(ret, "verAplic")})` : "") };
}
