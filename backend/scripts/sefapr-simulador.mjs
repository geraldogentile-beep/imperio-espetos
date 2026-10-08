// Simulador dos web services da SEFA-PR (NFC-e 4.00) para testes locais.
// Fala SOAP 1.2 como a SEFAZ e decide a resposta pelo nome do primeiro item
// (ou do segundo, em homologação, porque o primeiro vira o texto fixo):
//   REJEITAR  -> protNFe cStat 778 (NCM inexistente)
//   DUPLICADA -> cStat 539 (duplicidade com outra chave: número gasto)
//   LOTE      -> 103 (lote recebido) e o recibo responde 105 e depois 100
//   QUEDA     -> autoriza, mas derruba a conexão sem responder
//   SUMIU     -> derruba a conexão e a nota não existe na consulta (217)
//   o resto   -> 104 + protNFe cStat 100
// Cancelamento: justificativa com RECUSA -> 573; senão 135.
//
//   node scripts/sefapr-simulador.mjs            (porta 3990)
// ou  import { criarSimulador } from "./sefapr-simulador.mjs"

import http from "http";
import { pathToFileURL } from "url";

const NS = "http://www.portalfiscal.inf.br/nfe";
// Hora de Brasília com o fuso, como a SEFAZ devolve
const agora = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19) + "-03:00";
const tag = (xml, nome) => { const m = String(xml).match(new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`)); return m ? m[1].trim() : ""; };
const bloco = (xml, nome) => { const m = String(xml).match(new RegExp(`<${nome}(?:\\s[^>]*)?>[\\s\\S]*?</${nome}>`)); return m ? m[0] : ""; };
const envelope = (servico, corpo) =>
  `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>` +
  `<nfeResultMsg xmlns="${NS}/wsdl/${servico}">${corpo}</nfeResultMsg></soap:Body></soap:Envelope>`;

export function criarSimulador({ porta = 3990 } = {}) {
  const notas = new Map();      // chave -> { xml, nProt, cStat, cancelada, recebidoEm }
  const recibos = new Map();    // nRec -> { chave, consultas }
  const log = [];
  let seqProt = 141260000000001;

  const protNFe = (chave, cStat, xMotivo, nProt) =>
    `<protNFe versao="4.00"><infProt Id="Id${nProt}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><chNFe>${chave}</chNFe><dhRecbto>${agora()}</dhRecbto>` +
    `<nProt>${nProt}</nProt><digVal>c2ltdWxhZG9y</digVal><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo></infProt></protNFe>`;

  const servidor = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", c => { corpo += c; });
    req.on("end", () => {
      const servico = (req.url || "").split("/").pop();
      log.push({ servico, corpo });
      const responder = (xml) => { res.writeHead(200, { "Content-Type": "application/soap+xml; charset=utf-8" }); res.end(envelope(servico, xml)); };

      if (servico === "NFeStatusServico4") {
        return responder(`<retConsStatServ versao="4.00" xmlns="${NS}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto><tMed>1</tMed></retConsStatServ>`);
      }

      if (servico === "NFeAutorizacao4") {
        const nfe = bloco(corpo, "NFe");
        const chave = (tag(nfe, "infNFe") && (nfe.match(/Id="NFe(\d{44})"/) || [])[1]) || "";
        const nomes = [...nfe.matchAll(/<xProd>([^<]*)<\/xProd>/g)].map(m => m[1]).join(" ");
        const indSinc = tag(corpo, "indSinc");
        if (!nfe.includes("<Signature") || !nfe.includes("<infNFeSupl>") || indSinc !== "1") {
          return responder(`<retEnviNFe versao="4.00" xmlns="${NS}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><cStat>225</cStat><xMotivo>Rejeicao: Falha no Schema XML (sem assinatura, QR Code ou indSinc)</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto></retEnviNFe>`);
        }
        const cabecalho = `<tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic>`;
        if (/REJEITAR/.test(nomes)) {
          return responder(`<retEnviNFe versao="4.00" xmlns="${NS}">${cabecalho}<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto>${protNFe(chave, "778", "Rejeicao: Informado NCM inexistente", String(seqProt++))}</retEnviNFe>`);
        }
        if (/DUPLICADA/.test(nomes)) {
          return responder(`<retEnviNFe versao="4.00" xmlns="${NS}">${cabecalho}<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto>${protNFe(chave, "539", "Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso", String(seqProt++))}</retEnviNFe>`);
        }
        const nProt = String(seqProt++);
        if (/SUMIU/.test(nomes)) { req.socket.destroy(); return; }
        notas.set(chave, { xml: nfe, nProt, cStat: "100", cancelada: false, recebidoEm: agora() });
        if (/QUEDA/.test(nomes)) { req.socket.destroy(); return; }
        if (/LOTE/.test(nomes)) {
          const nRec = "41" + String(Date.now()).slice(-13);
          recibos.set(nRec, { chave, consultas: 0 });
          return responder(`<retEnviNFe versao="4.00" xmlns="${NS}">${cabecalho}<cStat>103</cStat><xMotivo>Lote recebido com sucesso</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto><infRec><nRec>${nRec}</nRec><tMed>1</tMed></infRec></retEnviNFe>`);
        }
        return responder(`<retEnviNFe versao="4.00" xmlns="${NS}">${cabecalho}<cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto>${protNFe(chave, "100", "Autorizado o uso da NF-e", nProt)}</retEnviNFe>`);
      }

      if (servico === "NFeRetAutorizacao4") {
        const nRec = tag(corpo, "nRec");
        const r = recibos.get(nRec);
        if (!r) return responder(`<retConsReciNFe versao="4.00" xmlns="${NS}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><nRec>${nRec}</nRec><cStat>225</cStat><xMotivo>Rejeicao: Recibo inexistente</xMotivo><cUF>41</cUF></retConsReciNFe>`);
        r.consultas++;
        if (r.consultas === 1) return responder(`<retConsReciNFe versao="4.00" xmlns="${NS}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><nRec>${nRec}</nRec><cStat>105</cStat><xMotivo>Lote em processamento</xMotivo><cUF>41</cUF></retConsReciNFe>`);
        const n = notas.get(r.chave);
        return responder(`<retConsReciNFe versao="4.00" xmlns="${NS}"><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><nRec>${nRec}</nRec><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>41</cUF>${protNFe(r.chave, "100", "Autorizado o uso da NF-e", n.nProt)}</retConsReciNFe>`);
      }

      if (servico === "NFeConsultaProtocolo4") {
        const chave = tag(corpo, "chNFe");
        const n = notas.get(chave);
        const cab = `<tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic>`;
        if (!n) return responder(`<retConsSitNFe versao="4.00" xmlns="${NS}">${cab}<cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto><chNFe>${chave}</chNFe></retConsSitNFe>`);
        if (n.cancelada) return responder(`<retConsSitNFe versao="4.00" xmlns="${NS}">${cab}<cStat>101</cStat><xMotivo>Cancelamento de NF-e homologado</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto><chNFe>${chave}</chNFe>${protNFe(chave, "100", "Autorizado o uso da NF-e", n.nProt)}</retConsSitNFe>`);
        return responder(`<retConsSitNFe versao="4.00" xmlns="${NS}">${cab}<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><cUF>41</cUF><dhRecbto>${agora()}</dhRecbto><chNFe>${chave}</chNFe>${protNFe(chave, "100", "Autorizado o uso da NF-e", n.nProt)}</retConsSitNFe>`);
      }

      if (servico === "NFeRecepcaoEvento4") {
        const inf = bloco(corpo, "infEvento");
        const chave = tag(inf, "chNFe"), just = tag(inf, "xJust"), nProtNota = tag(inf, "nProt");
        const n = notas.get(chave);
        const ret = (cStat, xMotivo, nProt = "") =>
          `<retEnvEvento versao="1.00" xmlns="${NS}"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><cOrgao>41</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>` +
          `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>SIM_1.0</verAplic><cOrgao>41</cOrgao><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo><chNFe>${chave}</chNFe><tpEvento>110111</tpEvento><xEvento>Cancelamento</xEvento><nSeqEvento>1</nSeqEvento><dhRegEvento>${agora()}</dhRegEvento>${nProt ? `<nProt>${nProt}</nProt>` : ""}</infEvento></retEvento></retEnvEvento>`;
        if (!corpo.includes("<Signature")) return responder(ret("225", "Rejeicao: Falha no Schema XML (evento sem assinatura)"));
        if (!n) return responder(ret("217", "Rejeicao: NF-e nao consta na base de dados da SEFAZ"));
        if (n.nProt !== nProtNota) return responder(ret("573", "Rejeicao: Protocolo de autorizacao informado nao confere"));
        if (/RECUSA/.test(just)) return responder(ret("573", "Rejeicao: Duplicidade de evento"));
        if (n.cancelada) return responder(ret("573", "Rejeicao: Duplicidade de evento"));
        n.cancelada = true;
        return responder(ret("135", "Evento registrado e vinculado a NF-e", String(seqProt++)));
      }

      res.writeHead(404); res.end("servico desconhecido: " + servico);
    });
  });

  return {
    iniciar: () => new Promise(r => servidor.listen(porta, () => r(`http://localhost:${porta}/`))),
    parar: () => new Promise(r => servidor.close(() => r())),
    notas, recibos, log,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sim = criarSimulador({ porta: Number(process.env.PORTA) || 3990 });
  sim.iniciar().then(url => console.log("Simulador SEFA-PR em " + url));
}
