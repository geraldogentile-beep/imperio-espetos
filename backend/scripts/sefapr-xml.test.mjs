// Montagem, assinatura e transporte da NFC-e direta na SEFA-PR, sem servidor
// nem banco: certificado de teste gerado na hora e simulador em memória.
//   node scripts/sefapr-xml.test.mjs   (dentro de backend/)

import crypto from "crypto";
import forge from "node-forge";
import { criarSimulador } from "./sefapr-simulador.mjs";

process.env.SEFAPR_TIMEOUT_MS = "4000";
const sim = criarSimulador({ porta: 3991 });
process.env.SEFAPR_URL_BASE = await sim.iniciar();

const sefapr = await import("../fiscal/sefapr.js");
const { montarNfce, calcularDV, montarQrCode, esc, tag, bloco, emitir, consultar, cancelar, statusServico, ErroFiscal } = sefapr;

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Certificado A1 de mentira, com o CNPJ no CN como os de verdade
function certificadoTeste(cnpj = "46672345000192") {
  const chaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = chaves.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: "commonName", value: "IMPERIO DOS ESPETOS GRILL LTDA:" + cnpj }, { name: "countryName", value: "BR" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(chaves.privateKey, forge.md.sha256.create());
  return { pemChave: forge.pki.privateKeyToPem(chaves.privateKey), pemCertificado: forge.pki.certificateToPem(cert), cnpj };
}
const cert = certificadoTeste();

const cfg = {
  ambiente: "homologacao", cnpj: "46.672.345/0001-92", ie: "9124970463", razaoSocial: "IMPERIO DOS ESPETOS GRILL LTDA", nomeFantasia: "IMPERIO DOS ESPETOS GRILL", crt: "1",
  endereco: { logradouro: "Rua Governador Paulo Cruz Pimentel", numero: "279", complemento: "Sala A", bairro: "Cidade Alta", municipio: "Ibaiti", codigoMunicipio: "4109708", uf: "PR", cep: "84900-000" },
  cartaoCodigo: "03", pixCodigo: "20", pisCst: "49", cofinsCst: "49",
};
const CSC = "ABCDEF-1234-5678-9012-ABCDEF123456", CSC_ID = "000002";
const item = (nome, qty, preco, extra = {}) => ({ codigo: 7, nome, quantidade: qty, valorUnitario: preco, valorTotal: +(qty * preco).toFixed(2), ncm: "16025000", cfop: "5101", csosn: "102", origem: "0", unidade: "UN", ...extra });
const ctx = { ambiente: "homologacao", cert };
let numero = 100;
// Em homologação o 1º item vira o texto fixo: a palavra que o simulador lê vai no 2º
const dois = (nome) => [item("Espeto comum", 1, 5), item(nome, 1, 5)];
const montar = (itens, valorNota, pagamentos, extra = {}) => montarNfce({ cfg, itens, valorNota, pagamentos, numero: ++numero, serie: 1, cert, csc: CSC, cscId: CSC_ID, ...extra });

console.log("\n=== 1) chave de acesso ===");
{
  // Segunda implementação do módulo 11, escrita de outro jeito, para conferir
  const dvIndependente = (s) => { const pesos = [2, 3, 4, 5, 6, 7, 8, 9]; let soma = 0; [...s].reverse().forEach((d, i) => { soma += Number(d) * pesos[i % 8]; }); const r = 11 - (soma % 11); return r >= 10 ? 0 : r; };
  let iguais = 0;
  for (let i = 0; i < 200; i++) { const c43 = String(crypto.randomInt(1e8)).padStart(9, "0").repeat(5).slice(0, 43); if (calcularDV(c43) === dvIndependente(c43)) iguais++; }
  ok(iguais === 200, `dígito verificador confere com implementação independente (${iguais}/200)`);
  const n = montar([item("Alcatra", 5, 9)], 45, [{ tipo: "pix", valor: 45 }]);
  ok(/^\d{44}$/.test(n.chave), `chave com 44 dígitos (${n.chave})`);
  ok(n.chave.startsWith("41") && n.chave.slice(6, 20) === "46672345000192" && n.chave.slice(20, 22) === "65", "UF 41, CNPJ e modelo 65 na chave");
  ok(Number(n.chave.slice(22, 25)) === 1 && Number(n.chave.slice(25, 34)) === numero && n.chave[34] === "1", `série 1, número ${numero}, emissão normal`);
  ok(n.chave.slice(35, 43) === n.cNF && n.cNF !== String(numero).padStart(8, "0"), "cNF aleatório e diferente do número");
  ok(calcularDV(n.chave.slice(0, 43)) === Number(n.chave[43]), "DV bate");
}

console.log("\n=== 2) XML da nota ===");
let notaPix;
{
  notaPix = montar([item("Alcatra", 5, 9)], 45, [{ tipo: "pix", valor: 45 }]);
  const x = notaPix.xml;
  const inf = bloco(x, "infNFe");
  ok(x.startsWith('<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe' + notaPix.chave + '" versao="4.00">'), "raiz NFe com infNFe identificado pela chave");
  ok(/<\/infNFe><infNFeSupl><qrCode><!\[CDATA\[http:\/\/www\.fazenda\.pr\.gov\.br\/nfce\/qrcode\?p=/.test(x) && /<urlChave>http:\/\/www\.fazenda\.pr\.gov\.br\/nfce\/consulta<\/urlChave><\/infNFeSupl><Signature /.test(x), "ordem: infNFe, infNFeSupl (QR do PR), Signature");
  const ide = bloco(inf, "ide");
  ok(tag(ide, "cUF") === "41" && tag(ide, "mod") === "65" && tag(ide, "tpAmb") === "2" && tag(ide, "tpImp") === "4" && tag(ide, "indPres") === "1" && !ide.includes("indIntermed"), "ide: PR, modelo 65, homologação, presencial, sem intermediador");
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/.test(tag(ide, "dhEmi")), `dhEmi no fuso de Brasília (${tag(ide, "dhEmi")})`);
  ok(tag(ide, "cDV") === notaPix.chave[43] && tag(ide, "cNF") === notaPix.cNF, "cDV e cNF iguais aos da chave");
  const emit = bloco(inf, "emit");
  ok(tag(emit, "CNPJ") === "46672345000192" && tag(emit, "IE") === "9124970463" && tag(emit, "CRT") === "1" && tag(emit, "cMun") === "4109708" && tag(emit, "CEP") === "84900000" && tag(emit, "xCpl") === "Sala A", "emitente só com dígitos onde a SEFAZ exige, complemento presente");
  ok(!inf.includes("<dest>"), "sem CPF: sem destinatário");
  const det = bloco(inf, "det");
  ok(tag(det, "xProd") === "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL", "homologação: primeiro item com o texto obrigatório");
  ok(tag(det, "qCom") === "5.0000" && tag(det, "vUnCom") === "9.00" && tag(det, "vProd") === "45.00" && tag(det, "cEAN") === "SEM GTIN" && tag(det, "indTot") === "1" && !det.includes("<vDesc>"), "produto: quantidade, unitário, total, sem GTIN, sem desconto");
  ok(det.includes("<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>") && det.includes("<PISOutr><CST>49</CST>") && det.includes("<COFINSOutr><CST>49</CST>"), "impostos: CSOSN 102, PIS/COFINS 49");
  const tot = bloco(inf, "ICMSTot");
  ok(tag(tot, "vProd") === "45.00" && tag(tot, "vDesc") === "0.00" && tag(tot, "vNF") === "45.00" && tag(tot, "vICMS") === "0.00", "totais fecham");
  ok(bloco(inf, "pag") === "<pag><detPag><indPag>0</indPag><tPag>20</tPag><vPag>45.00</vPag></detPag></pag>", "pix estático 20, sem grupo de cartão");
  ok(inf.includes("<transp><modFrete>9</modFrete></transp>") && !inf.includes("infRespTec"), "sem frete; responsável técnico só quando houver e-mail e telefone");
}

console.log("\n=== 2a) responsável técnico (exigido pela SEFA-PR) com CSRT ===");
{
  const comRt = (respTec) => montarNfce({ cfg: { ...cfg, respTec }, itens: [item("Alcatra", 1, 9)], valorNota: 9, pagamentos: [{ tipo: "pix", valor: 9 }], numero: ++numero, serie: 1, cert, csc: CSC, cscId: CSC_ID });
  const sem = comRt({ contato: "Amanda", email: "contato@exemplo.com", fone: "(43) 99999-0000" });
  const rt1 = bloco(sem.xml, "infRespTec");
  ok(tag(rt1, "CNPJ") === "46672345000192" && tag(rt1, "xContato") === "Amanda" && tag(rt1, "email") === "contato@exemplo.com" && tag(rt1, "fone") === "43999990000" && !rt1.includes("idCSRT"), "uso próprio: CNPJ da empresa, contato, e-mail e telefone; sem CSRT ainda");
  const CSRT = "CSRT-DE-TESTE-ABCDEF1234567890";
  const com = comRt({ contato: "Amanda", email: "contato@exemplo.com", fone: "43999990000", idCSRT: "1", csrt: CSRT });
  const rt2 = bloco(com.xml, "infRespTec");
  const esperado = crypto.createHash("sha1").update(CSRT + com.chave).digest("base64");
  ok(tag(rt2, "idCSRT") === "01" && tag(rt2, "hashCSRT") === esperado && rt2.indexOf("<fone>") < rt2.indexOf("<idCSRT>"), `com CSRT: idCSRT 01 e hashCSRT = base64(SHA-1(CSRT + chave)) (${tag(rt2, "hashCSRT")})`);
  ok(!com.xml.includes(CSRT), "o CSRT em si não vai na nota");
}

console.log("\n=== 2a2) grupo do ICMS por CSOSN ===");
{
  const grupoDe = (csosn) => { const n = montar([item("Item", 1, 5, { csosn })], 5, [{ tipo: "pix", valor: 5 }]); return bloco(bloco(n.xml, "det"), "ICMS"); };
  ok(["102", "103", "300", "400"].every(c => grupoDe(c) === `<ICMS><ICMSSN102><orig>0</orig><CSOSN>${c}</CSOSN></ICMSSN102></ICMS>`), "102, 103, 300 e 400 vão no grupo ICMSSN102 (não existe ICMSSN300)");
  ok(grupoDe("500").includes("<ICMSSN500>") && grupoDe("900").includes("<ICMSSN900>"), "500 e 900 têm grupo próprio");
  for (const c of ["101", "201", "202", "203"]) {
    let msg = "";
    try { grupoDe(c); } catch (e) { msg = e.message; }
    ok(/não se usa em venda ao consumidor/.test(msg), `CSOSN ${c} recusado com explicação`);
  }
}

console.log("\n=== 2b) desconto, gorjeta, CPF, cartão, bebida com ST, delivery ===");
{
  const itens = [item("Picanha", 3, 14), item("Frango", 2, 9), item("Refri lata", 1, 7, { cfop: "5405", csosn: "500", cest: "0300700", ncm: "22021000" })];
  // 67 - 10% = 60,30; gorjeta 6,03 paga junto; dinheiro 30 + cartão 36,33
  const n = montar(itens, 60.3, [{ tipo: "dinheiro", valor: 30 }, { tipo: "cartao", valor: 36.33 }], { cpf: "123.456.789-09", nome: "Ana", entrega: true });
  const inf = bloco(n.xml, "infNFe");
  const dets = [...inf.matchAll(/<det nItem="\d+">[\s\S]*?<\/det>/g)].map(m => m[0]);
  const cent = (v) => Math.round(Number(v) * 100);
  const vDesc = dets.reduce((s, d) => s + cent(tag(d, "vDesc") || 0), 0);
  ok(dets.length === 3 && vDesc === 670, `desconto rateado nos itens soma R$ ${vDesc / 100}`);
  const tot = bloco(inf, "ICMSTot");
  ok(tag(tot, "vProd") === "67.00" && tag(tot, "vDesc") === "6.70" && tag(tot, "vNF") === "60.30", "totais: 67,00 - 6,70 = 60,30");
  const pags = [...inf.matchAll(/<detPag>[\s\S]*?<\/detPag>/g)].map(m => m[0]);
  const soma = pags.reduce((s, p) => s + cent(tag(p, "vPag")), 0);
  ok(soma === 6030, `pagamentos somam o valor da nota (R$ ${soma / 100}), gorjeta fora`);
  const cartao = pags.find(p => tag(p, "tPag") === "03");
  ok(!!cartao && cartao.includes("<card><tpIntegra>2</tpIntegra></card>"), "cartão crédito 03 com maquininha não integrada");
  ok(tag(bloco(inf, "dest"), "CPF") === "12345678909" && tag(bloco(inf, "dest"), "xNome") === "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" && tag(bloco(inf, "dest"), "indIEDest") === "9", "CPF na nota com o nome fixo de homologação");
  ok(tag(bloco(inf, "ide"), "indPres") === "4" && bloco(inf, "ide").includes("<indIntermed>0</indIntermed>"), "delivery: indPres 4 com indIntermed 0");
  ok(dets[2].includes("<CEST>0300700</CEST>") && dets[2].includes("<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500>") && dets[2].includes("<CFOP>5405</CFOP>"), "bebida: CEST, CSOSN 500 e CFOP 5405");
  ok(dets[1].includes("<xProd>Frango</xProd>") && dets[2].includes("<xProd>Refri lata</xProd>"), "do segundo item em diante o nome é o real");

  let erro = null;
  try { montar([item("X", 1, 10)], 12, [{ tipo: "pix", valor: 12 }]); } catch (e) { erro = e; }
  ok(erro instanceof ErroFiscal && erro.definitivo, `venda maior que os itens é recusada antes de ir à SEFAZ (${erro?.message})`);
  erro = null;
  try { montar([item("X", 1, 10, { ncm: "1602" })], 10, [{ tipo: "pix", valor: 10 }]); } catch (e) { erro = e; }
  ok(erro instanceof ErroFiscal && /NCM/.test(erro.message), `NCM com menos de 8 dígitos é recusado (${erro?.message})`);
}

console.log("\n=== 3) QR Code 2.0 ===");
{
  const esperado = (() => {
    const p = `${notaPix.chave}|2|2|2`;   // idCSC "000002" vira "2"
    return `http://www.fazenda.pr.gov.br/nfce/qrcode?p=${p}|` + crypto.createHash("sha1").update(p + CSC).digest("hex").toUpperCase();
  })();
  ok(notaPix.qrCode === esperado, "URL do QR: chave|2|tpAmb|idCSC sem zeros|SHA-1(…+CSC) em maiúsculas");
  ok(notaPix.xml.includes(`<qrCode><![CDATA[${esperado}]]></qrCode>`), "mesmo QR dentro do XML");
  ok(montarQrCode({ chave: notaPix.chave, tpAmb: "1", cscId: "1", csc: "x", url: "u" }).startsWith(`u?p=${notaPix.chave}|2|1|1|`), "produção usa tpAmb 1");
}

console.log("\n=== 4) assinatura digital ===");
{
  const x = notaPix.xml;
  const inf = bloco(x, "infNFe");
  const sig = bloco(x, "Signature");
  const c14nInf = inf.replace(/^<infNFe/, '<infNFe xmlns="http://www.portalfiscal.inf.br/nfe"');
  const digest = crypto.createHash("sha1").update(c14nInf, "utf8").digest("base64");
  ok(tag(sig, "DigestValue") === digest, "DigestValue = SHA-1 da infNFe canônica (com o xmlns herdado)");
  ok(sig.includes(`<Reference URI="#NFe${notaPix.chave}">`) && sig.includes("enveloped-signature") && sig.includes("rsa-sha1"), "referência à infNFe, enveloped, RSA-SHA1");
  const signedInfo = bloco(sig, "SignedInfo").replace(/^<SignedInfo/, '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"');
  const pub = crypto.createPublicKey(cert.pemCertificado);
  const valida = crypto.verify("RSA-SHA1", Buffer.from(signedInfo, "utf8"), pub, Buffer.from(tag(sig, "SignatureValue"), "base64"));
  ok(valida, "SignatureValue confere com a chave pública do certificado");
  const certDer = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(cert.pemCertificado))).getBytes());
  ok(tag(sig, "X509Certificate") === certDer, "X509Certificate é o certificado em DER/base64, sem quebras");
  ok(!/>\s+</.test(x) && !/<\w+\/>/.test(inf), "sem espaços entre tags e sem elementos auto-fechados (forma canônica)");
  ok(esc("Pão & Cia <sal> \"ok\" 'x'") === "Pão &amp; Cia &lt;sal&gt; \"ok\" 'x'", "texto: só &, < e > escapados (aspas ficam, como no C14N)");
}

console.log("\n=== 5) envio: autorizada ===");
let autorizada;
{
  const n = montar([item("Alcatra", 2, 9)], 18, [{ tipo: "pix", valor: 18 }]);
  autorizada = await emitir(ctx, n);
  ok(autorizada.protocolo && /^\d+$/.test(autorizada.protocolo) && autorizada.statusSefaz === "100", `protocolo ${autorizada.protocolo}`);
  ok(autorizada.chave === n.chave && autorizada.numero === numero && autorizada.serie === 1, "número e série lidos da chave");
  ok(autorizada.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe ') && autorizada.xml.includes("<protNFe") && autorizada.xml.endsWith("</nfeProc>"), "XML guardado = nfeProc com a nota e o protocolo");
  ok(autorizada.prazoCancelamentoMin === 1440, "prazo de cancelamento do PR: 24h");
  const req = sim.log.find(l => l.servico === "NFeAutorizacao4");
  ok(req.corpo.startsWith('<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope') && req.corpo.includes('<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><idLote>') && req.corpo.includes("<indSinc>1</indSinc>"), "SOAP 1.2 com enviNFe síncrono");
}

console.log("\n=== 6) envio: rejeitada e número gasto ===");
{
  let e = null;
  try { await emitir(ctx, montar(dois("Espeto REJEITAR"), 10, [{ tipo: "pix", valor: 10 }])); } catch (x) { e = x; }
  ok(e instanceof ErroFiscal && e.definitivo && e.statusSefaz === "778" && /NCM inexistente/.test(e.message) && !e.numeroConsumido, `rejeição chega com código e motivo, número pode voltar (${e?.message})`);
  e = null;
  try { await emitir(ctx, montar(dois("Espeto DUPLICADA"), 10, [{ tipo: "pix", valor: 10 }])); } catch (x) { e = x; }
  ok(e instanceof ErroFiscal && e.definitivo && e.statusSefaz === "539" && e.numeroConsumido, "539 duplicidade: número NÃO pode voltar");
}

console.log("\n=== 7) lote recebido (103) resolve pelo recibo ===");
{
  const n = montar(dois("Espeto LOTE"), 10, [{ tipo: "pix", valor: 10 }]);
  const r = await emitir(ctx, n);
  ok(r.statusSefaz === "100" && r.chave === n.chave, "autorizada depois de 105 e 104 no recibo");
  ok(sim.log.filter(l => l.servico === "NFeRetAutorizacao4").length === 2, "consultou o recibo duas vezes");
}

console.log("\n=== 8) conexão cai depois de autorizar: a consulta resolve ===");
{
  const n = montar(dois("Espeto QUEDA"), 10, [{ tipo: "pix", valor: 10 }]);
  const r = await emitir(ctx, n);
  ok(r.statusSefaz === "100" && r.protocolo && r.xml.includes("<protNFe"), "recuperou pela consulta, com protocolo e XML completo");
  let e = null;
  try { await emitir(ctx, montar(dois("Espeto SUMIU"), 10, [{ tipo: "pix", valor: 10 }])); } catch (x) { e = x; }
  ok(e instanceof ErroFiscal && !e.incerto && !e.definitivo && e.naoChegou, `caiu antes de chegar: diz que pode emitir de novo (${e?.message})`);
}

console.log("\n=== 9) consulta e cancelamento ===");
{
  const c = await consultar(ctx, autorizada.chave, bloco(autorizada.xml, "NFe"));
  ok(c.situacao === "autorizada" && c.dados.protocolo === autorizada.protocolo, "consulta: autorizada com o mesmo protocolo");
  const nada = await consultar(ctx, "41" + "0".repeat(42));
  ok(nada.situacao === "inexistente" && nada.statusSefaz === "217", "chave desconhecida: inexistente (217)");
  let e = null;
  try { await cancelar(ctx, { chave: autorizada.chave, protocolo: autorizada.protocolo, cnpj: cfg.cnpj, justificativa: "curta" }); } catch (x) { e = x; }
  ok(e instanceof ErroFiscal && /15 caracteres/.test(e.message), "justificativa curta nem sai daqui");
  e = null;
  try { await cancelar(ctx, { chave: autorizada.chave, protocolo: autorizada.protocolo, cnpj: cfg.cnpj, justificativa: "RECUSA de teste pela SEFAZ simulada" }); } catch (x) { e = x; }
  ok(e instanceof ErroFiscal && e.definitivo && e.statusSefaz === "573", "recusa da SEFAZ vira erro definitivo com código");
  const r = await cancelar(ctx, { chave: autorizada.chave, protocolo: autorizada.protocolo, cnpj: cfg.cnpj, justificativa: "Cliente desistiu da compra no balcão" });
  ok(r.statusSefaz === "135" && /^\d+$/.test(r.protocolo) && r.xml.includes("<procEventoNFe") && r.xml.includes("<retEvento"), "cancelada: protocolo do evento e XML do processo");
  const ev = sim.log.filter(l => l.servico === "NFeRecepcaoEvento4").pop().corpo;
  const infEv = bloco(ev, "infEvento");
  ok(infEv.startsWith(`<infEvento Id="ID110111${autorizada.chave}01">`) && tag(infEv, "tpEvento") === "110111" && tag(infEv, "xJust") === "Cliente desistiu da compra no balcão", "evento 110111 com Id, protocolo e justificativa");
  const sig = bloco(ev, "Signature");
  const digest = crypto.createHash("sha1").update(infEv.replace(/^<infEvento/, '<infEvento xmlns="http://www.portalfiscal.inf.br/nfe"'), "utf8").digest("base64");
  ok(tag(sig, "DigestValue") === digest, "evento assinado sobre a infEvento canônica");
  const depois = await consultar(ctx, autorizada.chave);
  ok(depois.situacao === "cancelada", "consulta depois: cancelada (101)");
}

console.log("\n=== 10) status do serviço ===");
{
  const s = await statusServico(ctx);
  ok(s.ok && s.cStat === "107", s.mensagem);
}

await sim.parar();
console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
