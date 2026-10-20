// Emissão direta na SEFA-PR de ponta a ponta: painel -> servidor -> simulador.
//
// Precisa de MongoDB e de dois processos:
//   node scripts/sefapr-simulador.mjs                                              (porta 3990)
//   CERT_ENCRYPTION_KEY=<64 hex> SEFAPR_URL_BASE=http://localhost:3990/ SEFAPR_TIMEOUT_MS=4000 node server.js
// e então, dentro de backend/:
//   TESTE_URL=http://localhost:3000 node scripts/nfce-sefapr.test.mjs
//
// O que importa: certificado e CSC guardados aqui, numeração sequencial que
// volta quando a SEFAZ recusa sem gastar o número, XML guardado para o
// contador, cancelamento em até 24h, e queda de rede sem nota em dobro.

import "dotenv/config";
import forge from "node-forge";

const BASE = process.env.TESTE_URL || "http://localhost:3000";
let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.TESTE_PIN || "9999" }) });
  if (!r.ok) throw new Error(`login falhou: ${r.status}`);
  return (await r.json()).token;
})();
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let json = {}; try { json = JSON.parse(texto); } catch {}
  return { status: r.status, corpo: json, texto, tipo: r.headers.get("content-type") || "", disposicao: r.headers.get("content-disposition") || "" };
};
const venda = async (itens, extra) => {
  const subtotal = itens.reduce((s, i) => s + i.qty * i.preco, 0);
  const r = await api("POST", "/vendas-salao", { mesa: 50, itens, subtotal, desconto: 0, total: subtotal, pagamento: "pix", fechamento: new Date().toISOString(), ...extra });
  if (r.status !== 201) throw new Error("venda nao gravou: " + JSON.stringify(r.corpo));
  return r.corpo;
};
// Em homologação o 1º item vira o texto fixo; a palavra que o simulador lê vai no 2º
const dois = (nome, preco = 5) => [{ id: 701, nome: "Espeto comum", qty: 1, preco }, { id: 702, nome, qty: 1, preco }];

// Certificado A1 de mentira em .pfx, com CNPJ no CN como os de verdade
function pfxTeste(cnpj, senha) {
  const chaves = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = chaves.publicKey; cert.serialNumber = "02";
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: "commonName", value: "IMPERIO DOS ESPETOS GRILL LTDA:" + cnpj }, { name: "countryName", value: "BR" }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(chaves.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(chaves.privateKey, [cert], senha, { algorithm: "3des" });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

console.log(`\nServidor: ${BASE}\n`);

console.log("=== 1) configuração: sem certificado não está pronto ===");
{
  await api("DELETE", "/fiscal/certificado");
  const r = await api("PUT", "/config/fiscal", {
    ativo: true, ambiente: "homologacao", provedor: "sefapr", csc: "CSC-DE-TESTE-ABCDEF123456", cscId: "000002", serie: 1,
    cnpj: "46.672.345/0001-92", ie: "9124970463", razaoSocial: "IMPERIO DOS ESPETOS GRILL LTDA",
    endereco: { logradouro: "Rua Governador Paulo Cruz Pimentel", numero: "279", bairro: "Cidade Alta", municipio: "Ibaiti", codigoMunicipio: "4109708", uf: "PR", cep: "84900-000" },
    padroes: { ncm: "16025000", cfop: "5101", csosn: "102", origem: "0", unidade: "UN" },
    cartaoCodigo: "03", pixCodigo: "20", pisCst: "49", cofinsCst: "49", proximoNumero: 1,
    // A SEFA-PR exige o responsável técnico (SEFAZ 972 no 1º teste real)
    respTec: { contato: "Teste", email: "teste@exemplo.com", fone: "43999990000" },
  });
  ok(r.status === 200 && r.corpo.csc?.startsWith("****") && r.corpo.proximoNumero === 1, `salvou; CSC mascarado; próximo número 1 (HTTP ${r.status})`);
  const st = (await api("GET", "/config/fiscal/status")).corpo;
  ok(st.pronto === false && st.faltando.some(f => /certificado/i.test(f)) && !st.faltando.some(f => /token/i.test(f)), `falta só o certificado, não pede token (${JSON.stringify(st.faltando)})`);
  const t = (await api("POST", "/config/fiscal/testar")).corpo;
  ok(t.ok === false && /Certificado/i.test(t.mensagem), `testar sem certificado explica: ${t.mensagem}`);
}

console.log("\n=== 2) certificado entra pelo painel e a SEFA-PR responde ===");
{
  const errado = await api("POST", "/fiscal/certificado", { certBase64: pfxTeste("46672345000192", "senha-certa"), senha: "senha-errada" });
  ok(errado.status >= 400, `senha errada é recusada na hora (HTTP ${errado.status})`);
  const outro = await api("POST", "/fiscal/certificado", { certBase64: pfxTeste("11111111000191", "s"), senha: "s" });
  ok(outro.status === 200 || outro.status === 201, "certificado de outro CNPJ até salva...");
  const t0 = (await api("POST", "/config/fiscal/testar")).corpo;
  ok(t0.ok === false && /CNPJ/.test(t0.mensagem), `...mas o teste avisa que é de outro CNPJ: ${t0.mensagem}`);
  const certo = await api("POST", "/fiscal/certificado", { certBase64: pfxTeste("46672345000192", "senha-certa"), senha: "senha-certa" });
  ok(certo.status === 200 || certo.status === 201, `certificado da empresa salvo (HTTP ${certo.status})`);
  const st = (await api("GET", "/config/fiscal/status")).corpo;
  ok(st.pronto === true, `pronto para emitir (faltando: ${JSON.stringify(st.faltando)})`);
  const t = (await api("POST", "/config/fiscal/testar")).corpo;
  ok(t.ok === true && /107/.test(t.mensagem) && /homologação/.test(t.mensagem), `teste de conexão: ${t.mensagem}`);
}

console.log("\n=== 3) primeira nota: número 1, XML guardado ===");
let nota1, venda1;
{
  venda1 = await venda([{ id: 1, nome: "Alcatra", qty: 5, preco: 9 }]);
  const r = await api("POST", "/notas/emitir", { vendaId: venda1._id });
  ok(r.status === 200, `autorizada (HTTP ${r.status}) ${r.corpo.erro || ""}`);
  ok(r.corpo.numero === 1 && r.corpo.serie === 1 && /^41\d{42}$/.test(r.corpo.chave || ""), `número 1, série 1, chave ${r.corpo.chave}`);
  ok(r.corpo.xmlUrl === `/notas/${r.corpo.notaId}/xml` && r.corpo.danfeUrl === null, "XML é servido por nós; não há DANFE de provedor");
  ok(/^http:\/\/www\.fazenda\.pr\.gov\.br\/nfce\/qrcode\?p=/.test(r.corpo.qrCode || "") && r.corpo.urlConsulta === "http://www.fazenda.pr.gov.br/nfce/consulta", "QR Code e consulta do Paraná");
  nota1 = r.corpo;
  const n = (await api("GET", `/notas/${nota1.notaId}`)).corpo;
  ok(n.status === "autorizada" && n.protocolo && n.prazoCancelamentoMin === 1440 && n.xml === undefined, "nota gravada com protocolo e prazo de 24h; XML não vai na listagem");
  const x = await api("GET", `/notas/${nota1.notaId}/xml`);
  ok(x.status === 200 && /xml/.test(x.tipo) && x.texto.includes("<nfeProc") && x.texto.includes(nota1.chave) && x.texto.includes("<protNFe") && /NFCe-\d{44}\.xml/.test(x.disposicao), "download do XML autorizado (nfeProc) com nome pela chave");
  const vendas = (await api("GET", "/vendas-salao")).corpo;
  ok(vendas.find(v => v._id === venda1._id)?.notaFiscalStatus === "autorizada", "venda marcada com nota");
  const dup = await api("POST", "/notas/emitir", { vendaId: venda1._id });
  ok(dup.status === 409, `não emite duas vezes a mesma venda (HTTP ${dup.status})`);
}

console.log("\n=== 4) rejeição devolve o número; duplicidade gasta ===");
{
  const rej = await api("POST", "/notas/emitir", { vendaId: (await venda(dois("Espeto REJEITAR"))) ._id });
  ok(rej.status === 502 && rej.corpo.status === "rejeitada" && /778/.test(rej.corpo.erro), `rejeitada com o código da SEFAZ (${rej.corpo.erro})`);
  const prox = (await api("GET", "/config/fiscal")).corpo.proximoNumero;
  ok(prox === 2, `número 2 voltou para a fila (próximo: ${prox})`);
  const okv = await api("POST", "/notas/emitir", { vendaId: (await venda([{ id: 2, nome: "Frango", qty: 2, preco: 9 }]))._id });
  ok(okv.status === 200 && okv.corpo.numero === 2, `nota seguinte usa o número 2 (${okv.corpo.numero})`);
  const dupl = await api("POST", "/notas/emitir", { vendaId: (await venda(dois("Espeto DUPLICADA")))._id });
  ok(dupl.status === 502 && /539/.test(dupl.corpo.erro), `539: ${dupl.corpo.erro}`);
  const depois = await api("POST", "/notas/emitir", { vendaId: (await venda([{ id: 3, nome: "Picanha", qty: 1, preco: 14 }]))._id });
  ok(depois.status === 200 && depois.corpo.numero === 4, `número 3 ficou gasto; a próxima é a 4 (${depois.corpo.numero})`);
}

console.log("\n=== 5) rede cai depois de autorizar / lote em processamento ===");
{
  const q = await api("POST", "/notas/emitir", { vendaId: (await venda(dois("Espeto QUEDA")))._id });
  ok(q.status === 200 && q.corpo.protocolo, `queda: recuperou pela consulta (HTTP ${q.status}) ${q.corpo.erro || ""}`);
  const l = await api("POST", "/notas/emitir", { vendaId: (await venda(dois("Espeto LOTE")))._id });
  ok(l.status === 200 && l.corpo.numero === 6, `lote 103 resolvido pelo recibo, número ${l.corpo.numero}`);
  const s = await api("POST", "/notas/emitir", { vendaId: (await venda(dois("Espeto SUMIU")))._id });
  ok(s.status === 502 && s.corpo.status === "erro" && /emitir de novo/i.test(s.corpo.erro), `não chegou: fica como erro e libera nova tentativa (${s.corpo.erro})`);
  ok((await api("GET", "/config/fiscal")).corpo.proximoNumero === 7, "o número da que não chegou voltou");
}

console.log("\n=== 6) desconto + gorjeta + CPF + cartão ===");
{
  const itens = [{ id: 2, nome: "Picanha", qty: 3, preco: 14 }, { id: 3, nome: "Frango", qty: 2, preco: 9 }, { id: 4, nome: "Refri lata", qty: 1, preco: 7 }];
  const v = await venda(itens, { subtotal: 67, desconto: 6.7, total: 60.3, gorjeta: 6.03, pagamento: "misto", pagamentos: [{ tipo: "dinheiro", valor: 30 }, { tipo: "cartao", valor: 36.33 }] });
  const r = await api("POST", "/notas/emitir", { vendaId: v._id, cpfCliente: "123.456.789-09" });
  ok(r.status === 200, `autorizada (HTTP ${r.status}) ${r.corpo.erro || ""} ${JSON.stringify(r.corpo.detalhes || "")}`);
  const x = (await api("GET", `/notas/${r.corpo.notaId}/xml`)).texto;
  ok(x.includes("<vNF>60.30</vNF>") && x.includes("<vDesc>6.70</vDesc>") && x.includes("<CPF>12345678909</CPF>") && x.includes("<tPag>03</tPag>") && x.includes("<tPag>01</tPag>"), "XML com total 60,30, desconto, CPF, dinheiro e cartão crédito");
}

console.log("\n=== 7) cancelamento dentro de 24h ===");
{
  const curto = await api("POST", `/notas/${nota1.notaId}/cancelar`, { motivo: "errado" });
  ok(curto.status === 400, `motivo curto recusado (HTTP ${curto.status})`);
  const c = await api("POST", `/notas/${nota1.notaId}/cancelar`, { motivo: "Cliente desistiu da compra no balcão" });
  ok(c.status === 200, `cancelada (HTTP ${c.status}) ${c.corpo.erro || ""}`);
  const n = (await api("GET", `/notas/${nota1.notaId}`)).corpo;
  ok(n.status === "cancelada" && /^\d+$/.test(n.protocoloCancelamento || ""), `protocolo do cancelamento ${n.protocoloCancelamento}`);
  const x = await api("GET", `/notas/${nota1.notaId}/xml?tipo=cancelamento`);
  ok(x.status === 200 && x.texto.includes("<procEventoNFe") && x.texto.includes("<xJust>Cliente desistiu da compra no balcão</xJust>"), "XML do cancelamento disponível");
  const vendas = (await api("GET", "/vendas-salao")).corpo;
  ok(vendas.find(v => v._id === venda1._id)?.notaFiscalStatus === "cancelada", "venda marcada como cancelada");
  const denovo = await api("POST", `/notas/${nota1.notaId}/cancelar`, { motivo: "Tentando cancelar de novo a mesma nota" });
  ok(denovo.status === 400, `cancelar duas vezes é recusado (HTTP ${denovo.status})`);
}

console.log("\n=== 8) continuar a numeração de outro sistema ===");
{
  const r = await api("PUT", "/config/fiscal", { proximoNumero: 500 });
  ok(r.status === 200 && r.corpo.proximoNumero === 500, `próximo número definido para 500 (${r.corpo.proximoNumero})`);
  const e = await api("POST", "/notas/emitir", { vendaId: (await venda([{ id: 1, nome: "Alcatra", qty: 1, preco: 9 }]))._id });
  ok(e.status === 200 && e.corpo.numero === 500, `emitiu a nº ${e.corpo.numero}`);
  const semMudar = await api("PUT", "/config/fiscal", { serie: 1, proximoNumero: 501 });
  ok(semMudar.corpo.proximoNumero === 501, "salvar o formulário sem alterar o número não mexe na sequência");
  const invalido = await api("PUT", "/config/fiscal", { proximoNumero: 0 });
  ok(invalido.status === 400, `número inválido recusado (HTTP ${invalido.status})`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
