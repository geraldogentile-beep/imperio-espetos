// Simulador da API NFC-e da Focus NFe, para testar sem token nem SEFAZ.
// Segue o contrato de https://doc.focusnfe.com.br/reference/nfce e confere
// as regras que a SEFAZ usa para rejeitar por valor.
//
//   node scripts/focus-simulador.mjs            (porta 3989, token "tok-teste")
//   FOCUS_SIM_PORTA=4000 FOCUS_SIM_TOKEN=abc node scripts/focus-simulador.mjs
//
// Gatilhos no nome do item, para exercitar os caminhos de erro:
//   "REJEITAR" -> SEFAZ rejeita (status erro_autorizacao)
//   "QUEDA"    -> autoriza, mas derruba a conexao antes de responder
//   "LENTO"    -> autoriza, mas demora 3s para responder
//
// GET /__notas devolve tudo o que foi recebido (para o teste conferir).

import http from "http";

const PORTA = Number(process.env.FOCUS_SIM_PORTA) || 3989;
const TOKEN = process.env.FOCUS_SIM_TOKEN || "tok-teste";
const notas = new Map();      // ref -> { corpo, status, numero, ... }
let numero = 0;

const CSOSN = new Set(["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"]);
const TPAG = new Set(["01", "02", "03", "04", "05", "10", "11", "12", "13", "15", "16", "17", "18", "19", "20", "21", "90", "99"]);
const cent = (v) => Math.round(Number(v) * 100);

function validar(n) {
  const erros = [];
  const req = ["cnpj_emitente", "data_emissao", "presenca_comprador", "modalidade_frete", "local_destino", "natureza_operacao", "items", "formas_pagamento"];
  for (const k of req) if (n[k] === undefined || n[k] === "") erros.push({ campo: k, mensagem: k + " nao pode ser vazio" });
  if (erros.length) return erros;

  if (!/^\d{14}$/.test(n.cnpj_emitente)) erros.push({ campo: "cnpj_emitente", mensagem: "CNPJ invalido" });
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2})$/.exec(n.data_emissao);
  if (!m) erros.push({ campo: "data_emissao", mensagem: "formato invalido (esperado ISO com fuso)" });
  else if (Math.abs(new Date(n.data_emissao) - Date.now()) > 5 * 60 * 1000) erros.push({ campo: "data_emissao", mensagem: "diferenca maior que 5 minutos" });
  if (n.cpf_destinatario && !/^\d{11}$/.test(n.cpf_destinatario)) erros.push({ campo: "cpf_destinatario", mensagem: "CPF invalido" });

  const reqItem = ["numero_item", "codigo_ncm", "codigo_produto", "descricao", "quantidade_comercial", "quantidade_tributavel", "cfop",
    "valor_unitario_comercial", "valor_unitario_tributavel", "valor_bruto", "unidade_comercial", "unidade_tributavel",
    "icms_origem", "icms_situacao_tributaria", "pis_situacao_tributaria", "cofins_situacao_tributaria"];
  let bruto = 0, desc = 0;
  (n.items || []).forEach((it, i) => {
    for (const k of reqItem) if (it[k] === undefined || it[k] === "") erros.push({ campo: `items[${i}].${k}`, mensagem: "obrigatorio" });
    if (!/^\d{8}$/.test(it.codigo_ncm || "")) erros.push({ campo: `items[${i}].codigo_ncm`, mensagem: "NCM deve ter 8 digitos" });
    if (!/^\d{4}$/.test(it.cfop || "")) erros.push({ campo: `items[${i}].cfop`, mensagem: "CFOP deve ter 4 digitos" });
    if (!CSOSN.has(it.icms_situacao_tributaria)) erros.push({ campo: `items[${i}].icms_situacao_tributaria`, mensagem: "CSOSN invalido" });
    if (it.icms_situacao_tributaria === "500" && !/^\d{7}$/.test(it.cest || "")) erros.push({ campo: `items[${i}].cest`, mensagem: "CEST obrigatorio para CSOSN 500" });
    // vProd = qtd x valor unitario (tolerancia de 1 centavo)
    if (Math.abs(cent(it.quantidade_comercial * it.valor_unitario_comercial) - cent(it.valor_bruto)) > 1) {
      erros.push({ campo: `items[${i}].valor_bruto`, mensagem: "valor_bruto diferente de quantidade x valor unitario" });
    }
    if (it.valor_desconto !== undefined && cent(it.valor_desconto) > cent(it.valor_bruto)) {
      erros.push({ campo: `items[${i}].valor_desconto`, mensagem: "desconto maior que o valor do item" });
    }
    bruto += cent(it.valor_bruto); desc += cent(it.valor_desconto || 0);
  });

  let pagos = 0;
  (n.formas_pagamento || []).forEach((f, i) => {
    if (!TPAG.has(f.forma_pagamento)) erros.push({ campo: `formas_pagamento[${i}].forma_pagamento`, mensagem: "codigo invalido" });
    if (["03", "04", "17"].includes(f.forma_pagamento) && !f.tipo_integracao) erros.push({ campo: `formas_pagamento[${i}].tipo_integracao`, mensagem: "obrigatorio para cartao/pix dinamico" });
    pagos += cent(f.valor_pagamento);
  });
  const vNF = bruto - desc;
  const troco = cent(n.valor_troco || 0);
  if (pagos - troco !== vNF) {
    erros.push({ campo: "formas_pagamento", mensagem: `soma dos pagamentos (${pagos / 100}) menos troco (${troco / 100}) diferente do total da nota (${vNF / 100})` });
  }
  return erros;
}

function resposta(ref, nota) {
  const chave = "41" + "2609" + nota.corpo.cnpj_emitente + "65" + "001" + String(nota.numero).padStart(9, "0") + "1" + "12345678" + "9";
  const base = {
    cnpj_emitente: nota.corpo.cnpj_emitente, ref, status: nota.status,
    status_sefaz: nota.status_sefaz, mensagem_sefaz: nota.mensagem_sefaz,
  };
  if (nota.status === "erro_autorizacao") return base;
  return {
    ...base,
    chave_nfe: "NFe" + chave, numero: String(nota.numero), serie: "1",
    protocolo: "1412600000" + String(nota.numero).padStart(5, "0"),
    caminho_xml_nota_fiscal: `/arquivos_development/${nota.corpo.cnpj_emitente}/202609/XMLs/${chave}-nfe.xml`,
    caminho_danfe: `/notas_fiscais_consumidor/NFe${chave}.html`,
    qrcode_url: `http://www.fazenda.pr.gov.br/nfce/qrcode/?p=${chave}|2|2|1|ABC`,
    url_consulta_nf: "http://www.fazenda.pr.gov.br/nfce/consulta",
    ...(nota.status === "cancelado" ? { caminho_xml_cancelamento: `/arquivos_development/${chave}-can.xml` } : {}),
  };
}

function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__notas") return json(res, 200, [...notas.entries()].map(([ref, n]) => ({ ref, ...n })));

  const auth = req.headers.authorization || "";
  const [user, senha] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":");
  if (!auth.startsWith("Basic ") || user !== TOKEN || senha !== "") {
    res.writeHead(401, { "Content-Type": "text/html" }); return res.end("HTTP Basic: Access denied");
  }

  let dados = "";
  req.on("data", c => { dados += c; });
  req.on("end", () => {
    let corpo = null;
    if (dados) { try { corpo = JSON.parse(dados); } catch { return json(res, 415, { codigo: "formato_invalido", mensagem: "JSON invalido" }); } }

    // Emitir
    if (req.method === "POST" && url.pathname === "/v2/nfce") {
      const ref = url.searchParams.get("ref");
      if (!ref) return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Parâmetro \"ref\" não informado" });
      if (!/^[A-Za-z0-9]+$/.test(ref)) return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Referência com caracteres inválidos" });
      const existente = notas.get(ref);
      if (existente && ["autorizado", "cancelado"].includes(existente.status)) {
        return json(res, 422, { codigo: "already_processed", mensagem: "A nota fiscal já foi autorizada" });
      }
      const erros = validar(corpo || {});
      if (erros.length) return json(res, 422, { codigo: "erro_validacao_schema", mensagem: "Erro de validação", erros });

      const nomes = (corpo.items || []).map(i => i.descricao).join(" ");
      const nota = { corpo, numero: ++numero, criadoEm: Date.now() };
      if (/REJEITAR/.test(nomes)) {
        Object.assign(nota, { status: "erro_autorizacao", status_sefaz: "778", mensagem_sefaz: "Rejeição: Informado NCM inexistente" });
      } else {
        Object.assign(nota, { status: "autorizado", status_sefaz: "100", mensagem_sefaz: "Autorizado o uso da NF-e" });
      }
      notas.set(ref, nota);

      if (/QUEDA/.test(nomes)) { req.socket.destroy(); return; }
      if (/LENTO/.test(nomes)) { setTimeout(() => json(res, 201, resposta(ref, nota)), 3000); return; }
      return json(res, 201, resposta(ref, nota));
    }

    const m = /^\/v2\/nfce\/([^/?]+)$/.exec(url.pathname);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      const nota = notas.get(ref);
      if (req.method === "GET") {
        if (!nota) return json(res, 404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" });
        // Nota "LENTO": nos primeiros 3s a consulta tambem demora (SEFAZ lenta)
        const lenta = nota.corpo.items.some(i => /LENTO/.test(i.descricao)) && Date.now() - nota.criadoEm < 3000;
        if (lenta) { setTimeout(() => json(res, 200, resposta(ref, nota)), 3000); return; }
        return json(res, 200, resposta(ref, nota));
      }
      if (req.method === "DELETE") {
        if (!nota) return json(res, 404, { codigo: "nao_encontrado", mensagem: "Nota fiscal não encontrada" });
        const j = String(corpo?.justificativa || "");
        if (!j) return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Justificativa não informada" });
        if (j.length < 15 || j.length > 255) return json(res, 400, { codigo: "requisicao_invalida", mensagem: "Justificativa deve conter de 15 a 255 caracteres" });
        if (nota.status === "cancelado") return json(res, 422, { codigo: "already_processed", mensagem: "Nota fiscal já cancelada" });
        if (nota.status !== "autorizado") return json(res, 422, { codigo: "nfe_nao_autorizada", mensagem: "Nota fiscal não autorizada" });
        Object.assign(nota, { status: "cancelado", status_sefaz: "135", mensagem_sefaz: "Evento registrado e vinculado a NF-e", justificativa: j });
        return json(res, 200, { status: "cancelado", status_sefaz: "135", mensagem_sefaz: nota.mensagem_sefaz, caminho_xml_cancelamento: "/arquivos_development/can.xml", numero_protocolo: "1412600099999" });
      }
    }
    json(res, 404, { codigo: "nao_encontrado", mensagem: "Rota nao encontrada no simulador" });
  });
});

srv.listen(PORTA, () => console.log(`Simulador Focus NFe na porta ${PORTA} (token "${TOKEN}")`));
