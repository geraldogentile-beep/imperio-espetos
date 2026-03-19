// ============================================================
// IMPÉRIO DOS ESPETOS — Backend v5
// WhatsApp via Baileys direto (sem Evolution API)
// ============================================================

import express from "express";
import fetch from "node-fetch";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── ENV ───────────────────────────────────────────────────────
const ENV = {
  ANTHROPIC_KEY: process.env.ANTHROPIC_KEY || "sua-chave-anthropic-aqui",
  PORT:          process.env.PORT          || 3000,
};

// ── ESTADO DO WHATSAPP ────────────────────────────────────────
let sock = null;
let qrCodeBase64 = null;
let whatsappStatus = "disconnected"; // disconnected | qr | connected
let authDir = "./auth_info";

// ── CONFIG ────────────────────────────────────────────────────
let CONFIG = {
  nomeEstabelecimento: "Império dos Espetos e Grill",
  nomeAgente: "Imperador",
  taxaEntrega: 5.00,
  tempoEntregaMin: 30,
  tempoEntregaMax: 45,
  entregaCEP: { ativo: false, cepBase: "01310100", raioKm: 5, mensagemForaRaio: "😕 Fora do nosso raio de {raio}km." },
  horarioFuncionamento: {
    0: { aberto: false, abertura: "18:00", fechamento: "23:00" },
    1: { aberto: false, abertura: "18:00", fechamento: "23:00" },
    2: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    3: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    4: { aberto: true,  abertura: "18:00", fechamento: "23:00" },
    5: { aberto: true,  abertura: "17:00", fechamento: "00:00" },
    6: { aberto: true,  abertura: "17:00", fechamento: "00:00" },
  },
  mensagensAutomaticas: {
    ativo: true,
    preparando: "👨‍🍳 Seu pedido *#{id}* está sendo preparado! Em breve sai quentinho 🔥",
    entrega:    "🛵 Seu pedido *#{id}* saiu para entrega! Chegará em instantes 😄",
    entregue:   "✅ Pedido *#{id}* entregue! Obrigado, {cliente}! Bom apetite! 🍢",
    cancelado:  "❌ Seu pedido *#{id}* foi cancelado. Entre em contato conosco.",
  },
  fidelidade: { ativo: true, pedidosParaGanhar: 5, brinde: "1 espetinho grátis", mensagemGanhou: "🎉 Parabéns {cliente}! Você ganhou *{brinde}*! Mencione no próximo pedido 😄" },
  avaliacao:  { ativo: true, delayMinutos: 10, mensagem: "Olá {cliente}! Como foi seu pedido? Responda com uma nota de *1 a 5* ⭐", mensagemObrigado: "Obrigado pela avaliação, {cliente}! 💛" },
};

// ── CARDÁPIO ──────────────────────────────────────────────────
let CARDAPIO = [
  { id: 1,  categoria: "Tradicionais",    nome: "Alcatra",                 preco: 9.00,  tempoPreparo: 15, ativo: true, obs: null },
  { id: 2,  categoria: "Tradicionais",    nome: "Alcatra com legumes",     preco: 9.00,  tempoPreparo: 15, ativo: true, obs: null },
  { id: 3,  categoria: "Tradicionais",    nome: "Frango",                  preco: 9.00,  tempoPreparo: 12, ativo: true, obs: null },
  { id: 4,  categoria: "Tradicionais",    nome: "Frango com legumes",      preco: 9.00,  tempoPreparo: 12, ativo: true, obs: null },
  { id: 5,  categoria: "Tradicionais",    nome: "Tulipa na mostarda",      preco: 9.00,  tempoPreparo: 12, ativo: true, obs: null },
  { id: 6,  categoria: "Tradicionais",    nome: "Linguiça",                preco: 9.00,  tempoPreparo: 10, ativo: true, obs: null },
  { id: 7,  categoria: "Tradicionais",    nome: "Coraçãozinho de frango",  preco: 9.00,  tempoPreparo: 10, ativo: true, obs: null },
  { id: 8,  categoria: "Tradicionais",    nome: "Panceta suína",           preco: 9.00,  tempoPreparo: 15, ativo: true, obs: null },
  { id: 9,  categoria: "Tradicionais",    nome: "Pão de alho",             preco: 8.00,  tempoPreparo: 5,  ativo: true, obs: null },
  { id: 10, categoria: "Especiais",       nome: "Picanha meia lua",        preco: 15.00, tempoPreparo: 20, ativo: true, obs: "no sal grosso" },
  { id: 11, categoria: "Especiais",       nome: "Cordeiro",                preco: 13.00, tempoPreparo: 25, ativo: true, obs: null },
  { id: 12, categoria: "Especiais",       nome: "Kafta com queijo",        preco: 11.00, tempoPreparo: 15, ativo: true, obs: null },
  { id: 13, categoria: "Especiais",       nome: "Medalhão frango",         preco: 11.00, tempoPreparo: 15, ativo: true, obs: null },
  { id: 14, categoria: "Especiais",       nome: "Medalhão mignon",         preco: 11.00, tempoPreparo: 18, ativo: true, obs: null },
  { id: 15, categoria: "Especiais",       nome: "Medalhão suíno",          preco: 11.00, tempoPreparo: 18, ativo: true, obs: null },
  { id: 16, categoria: "Especiais",       nome: "Queijo coalho",           preco: 10.00, tempoPreparo: 8,  ativo: true, obs: null },
  { id: 17, categoria: "Doces",           nome: "Romeu e Julieta",         preco: 11.00, tempoPreparo: 8,  ativo: true, obs: null },
  { id: 18, categoria: "Doces",           nome: "Morango com chocolate",   preco: 10.00, tempoPreparo: 8,  ativo: true, obs: null },
  { id: 19, categoria: "Doces",           nome: "Uva com chocolate",       preco: 10.00, tempoPreparo: 8,  ativo: true, obs: null },
  { id: 20, categoria: "Churrasco Grego", nome: "Churrasco Grego",         preco: 18.00, tempoPreparo: 25, ativo: true, obs: null },
  { id: 21, categoria: "Acompanhamentos", nome: "Vinagrete",               preco: 2.00,  tempoPreparo: 2,  ativo: true, obs: null },
  { id: 22, categoria: "Acompanhamentos", nome: "Farofa",                  preco: 1.00,  tempoPreparo: 2,  ativo: true, obs: null },
  { id: 23, categoria: "Acompanhamentos", nome: "Molho alho",              preco: 2.00,  tempoPreparo: 2,  ativo: true, obs: null },
  { id: 24, categoria: "Água",            nome: "Água com gás",            preco: 4.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 25, categoria: "Água",            nome: "Água sem gás",            preco: 4.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 26, categoria: "Suco",            nome: "Suco 200ml",              preco: 6.00,  tempoPreparo: 5,  ativo: true, obs: "Super Suco" },
  { id: 27, categoria: "Suco",            nome: "Suco 900ml",              preco: 12.00, tempoPreparo: 5,  ativo: true, obs: "Super Suco" },
  { id: 28, categoria: "Suco",            nome: "Suco 1.700ml",            preco: 20.00, tempoPreparo: 5,  ativo: true, obs: "Super Suco" },
  { id: 29, categoria: "Refrigerantes",   nome: "Coca-Cola 2L",            preco: 14.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 30, categoria: "Refrigerantes",   nome: "Coca-Cola Zero 2L",       preco: 14.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 31, categoria: "Refrigerantes",   nome: "Guaraná 2L",              preco: 14.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 32, categoria: "Refrigerantes",   nome: "Coca-Cola 1L",            preco: 10.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 33, categoria: "Refrigerantes",   nome: "Coca-Cola Lata",          preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 34, categoria: "Refrigerantes",   nome: "Coca-Cola Zero Lata",     preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 35, categoria: "Refrigerantes",   nome: "Sprite Lata",             preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 36, categoria: "Refrigerantes",   nome: "Guaraná Lata",            preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 37, categoria: "Refrigerantes",   nome: "Fanta Laranja Lata",      preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 38, categoria: "Refrigerantes",   nome: "Fanta Uva Lata",          preco: 6.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 39, categoria: "Cervejas",        nome: "Sol Long Neck",           preco: 8.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 40, categoria: "Cervejas",        nome: "Heineken Long Neck",      preco: 10.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 41, categoria: "Cervejas",        nome: "Heineken Zero Long Neck", preco: 10.00, tempoPreparo: 1,  ativo: true, obs: null },
  { id: 42, categoria: "Cervejas",        nome: "Brahma Lata",             preco: 7.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 43, categoria: "Cervejas",        nome: "Skol Lata",               preco: 7.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 44, categoria: "Cervejas",        nome: "Amstel Lata",             preco: 7.00,  tempoPreparo: 1,  ativo: true, obs: null },
  { id: 45, categoria: "Cervejas",        nome: "Chopp",                   preco: 10.00, tempoPreparo: 3,  ativo: true, obs: "caneca" },
  { id: 46, categoria: "Cervejas",        nome: "Chopp Vinho",             preco: 12.00, tempoPreparo: 3,  ativo: true, obs: "caneca" },
  { id: 47, categoria: "Energético",      nome: "Monster",                 preco: 12.00, tempoPreparo: 1,  ativo: true, obs: null },
];
let nextItemId = 48;

// ── CUPONS ────────────────────────────────────────────────────
let cupons = [
  { codigo: "BEMVINDO10", tipo: "percentual", valor: 10, ativo: true, usoMax: 100, usoAtual: 0, validade: null, descricao: "10% de desconto boas-vindas" },
  { codigo: "FRETE0",     tipo: "frete",      valor: 0,  ativo: true, usoMax: 50,  usoAtual: 0, validade: null, descricao: "Frete grátis" },
];

// ── FIDELIDADE ────────────────────────────────────────────────
const fidelidadeClientes = new Map();
function getFidelidade(tel) {
  if (!fidelidadeClientes.has(tel)) fidelidadeClientes.set(tel, { pedidosEntregues: 0, brindesGanhos: 0 });
  return fidelidadeClientes.get(tel);
}

// ── AVALIAÇÕES ────────────────────────────────────────────────
const avaliacoes = [];
const aguardandoAvaliacao = new Map();
const timersAvaliacao = new Map();

// ── PEDIDOS ───────────────────────────────────────────────────
const pedidos = [];
let counter = 1;

// ── MEMÓRIA CONVERSAS ─────────────────────────────────────────
const conversas = new Map();
function getHist(tel) { if (!conversas.has(tel)) conversas.set(tel, []); return conversas.get(tel); }
function addMsg(tel, role, content) {
  const h = getHist(tel);
  h.push({ role, content });
  if (h.length > 40) h.splice(0, h.length - 40);
}

// ── HELPERS ───────────────────────────────────────────────────
function estaAberto() {
  const agora = new Date();
  const h = CONFIG.horarioFuncionamento[agora.getDay()];
  if (!h?.aberto) return false;
  const [hAb, mAb] = h.abertura.split(":").map(Number);
  const [hFe, mFe] = h.fechamento.split(":").map(Number);
  const now = agora.getHours() * 60 + agora.getMinutes();
  const ab = hAb * 60 + mAb;
  const fe = hFe === 0 && mFe === 0 ? 1440 : hFe * 60 + mFe;
  return now >= ab && now < fe;
}

function proximaAbertura() {
  const dias = ["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"];
  for (let i = 1; i <= 7; i++) {
    const dia = (new Date().getDay() + i) % 7;
    const h = CONFIG.horarioFuncionamento[dia];
    if (h?.aberto) return `${dias[dia]} a partir das ${h.abertura}`;
  }
  return "em breve";
}

function calcularTempoPreparo(itens) {
  if (!itens?.length) return CONFIG.tempoEntregaMin;
  const max = Math.max(...itens.map(i => {
    const item = CARDAPIO.find(c => c.nome.toLowerCase() === i.nome?.toLowerCase());
    return item ? item.tempoPreparo : 10;
  }));
  return max + CONFIG.tempoEntregaMin;
}

function aplicarCupom(subtotal, codigo) {
  if (!codigo) return { desconto: 0 };
  const cupom = cupons.find(c => c.codigo.toUpperCase() === codigo.toUpperCase() && c.ativo);
  if (!cupom) return { desconto: 0, erro: "Cupom inválido." };
  if (cupom.usoMax && cupom.usoAtual >= cupom.usoMax) return { desconto: 0, erro: "Cupom esgotado." };
  let desconto = 0;
  if (cupom.tipo === "percentual") desconto = subtotal * (cupom.valor / 100);
  else if (cupom.tipo === "fixo") desconto = Math.min(cupom.valor, subtotal);
  else if (cupom.tipo === "frete") desconto = CONFIG.taxaEntrega;
  return { desconto: parseFloat(desconto.toFixed(2)), cupom };
}

function formatMsg(tpl, pedido) {
  return tpl
    .replace(/{id}/g, pedido.id)
    .replace(/{cliente}/g, pedido.cliente)
    .replace(/{brinde}/g, CONFIG.fidelidade.brinde)
    .replace(/{total}/g, pedido.total?.toFixed(2));
}

function cardapioTexto() {
  const ativos = CARDAPIO.filter(i => i.ativo);
  return Object.entries(
    ativos.reduce((acc, item) => {
      if (!acc[item.categoria]) acc[item.categoria] = [];
      acc[item.categoria].push(`  • ${item.nome}${item.obs ? ` (${item.obs})` : ""}: R$${item.preco.toFixed(2)}`);
      return acc;
    }, {})
  ).map(([cat, items]) => `${cat}:\n${items.join("\n")}`).join("\n\n");
}

function buildSystemPrompt() {
  const aberto = estaAberto();
  const cuponsAtivos = cupons.filter(c => c.ativo).map(c => `${c.codigo} — ${c.descricao}`).join(", ");
  return `Você é o assistente virtual do *${CONFIG.nomeEstabelecimento}* 👑🔥
Seu nome é *${CONFIG.nomeAgente}*.

STATUS: ${aberto ? "✅ LOJA ABERTA" : `🔴 LOJA FECHADA — próxima abertura: ${proximaAbertura()}. NÃO aceite pedidos.`}

CUPONS VÁLIDOS: ${cuponsAtivos || "nenhum no momento"}
FIDELIDADE: A cada ${CONFIG.fidelidade.pedidosParaGanhar} pedidos o cliente ganha ${CONFIG.fidelidade.brinde}.

Seu trabalho (apenas quando ABERTO):
1. Recepcionar o cliente de forma calorosa
2. Apresentar cardápio quando pedido
3. Verificar se tem cupom
4. Anotar pedido, calcular total
5. Coletar nome e endereço
6. Confirmar pedido com resumo

CARDÁPIO:
${cardapioTexto()}

Taxa de entrega: R$ ${CONFIG.taxaEntrega.toFixed(2)}
Tempo estimado: ${CONFIG.tempoEntregaMin} a ${CONFIG.tempoEntregaMax} minutos

Ao finalizar inclua exatamente:
<PEDIDO_FINALIZADO>
{"cliente":"nome","telefone":"numero","endereco":"endereço","itens":[{"nome":"item","qty":1,"preco":9.00}],"subtotal":0.00,"desconto":0.00,"cupom":"","total":0.00,"obs":"","tempoPreparo":0}
</PEDIDO_FINALIZADO>

Responda SEMPRE em português brasileiro.`;
}

// ── CLAUDE API ────────────────────────────────────────────────
async function chamarClaude(historico) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ENV.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: buildSystemPrompt(), messages: historico }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || "Desculpe, tive um probleminha. Pode repetir?";
}

function extrairPedido(texto) {
  const match = texto.match(/<PEDIDO_FINALIZADO>([\s\S]*?)<\/PEDIDO_FINALIZADO>/);
  if (!match) return null;
  try { return JSON.parse(match[1].trim()); } catch { return null; }
}

// ── ENVIAR MENSAGEM WHATSAPP ──────────────────────────────────
async function enviarMsg(tel, texto) {
  if (!sock || whatsappStatus !== "connected") {
    console.log("⚠️ WhatsApp não conectado, mensagem não enviada para", tel);
    return;
  }
  const limpo = texto.replace(/<PEDIDO_FINALIZADO>[\s\S]*?<\/PEDIDO_FINALIZADO>/g, "").trim();
  const jid = tel.includes("@") ? tel : `${tel}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: limpo });
}

async function enviarMsgStatus(pedido, status) {
  if (!CONFIG.mensagensAutomaticas.ativo) return;
  const tpl = CONFIG.mensagensAutomaticas[status];
  if (!tpl || !pedido.telefone) return;
  await enviarMsg(pedido.telefone, formatMsg(tpl, pedido));
}

function agendarAvaliacao(pedido) {
  if (!CONFIG.avaliacao.ativo) return;
  const timer = setTimeout(async () => {
    const msg = CONFIG.avaliacao.mensagem.replace(/{cliente}/g, pedido.cliente);
    await enviarMsg(pedido.telefone, msg);
    aguardandoAvaliacao.set(pedido.telefone, pedido.id);
  }, CONFIG.avaliacao.delayMinutos * 60 * 1000);
  timersAvaliacao.set(pedido.id, timer);
}

async function checarFidelidade(pedido) {
  if (!CONFIG.fidelidade.ativo) return;
  const f = getFidelidade(pedido.telefone);
  f.pedidosEntregues += 1;
  const meta = CONFIG.fidelidade.pedidosParaGanhar;
  if (f.pedidosEntregues % meta === 0) {
    f.brindesGanhos += 1;
    const msg = CONFIG.fidelidade.mensagemGanhou
      .replace(/{cliente}/g, pedido.cliente)
      .replace(/{total}/g, f.pedidosEntregues)
      .replace(/{brinde}/g, CONFIG.fidelidade.brinde);
    await enviarMsg(pedido.telefone, msg);
  }
}

// ── BAILEYS — CONECTAR WHATSAPP ───────────────────────────────
async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Imperio Espetos", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("📱 QR Code gerado — acesse /qrcode para escanear");
      qrCodeBase64 = await qrcode.toDataURL(qr);
      whatsappStatus = "qr";
    }

    if (connection === "close") {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log("🔌 Conexão fechada. Reconectando:", shouldReconnect);
      whatsappStatus = "disconnected";
      qrCodeBase64 = null;
      if (shouldReconnect) setTimeout(conectarWhatsApp, 5000);
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      whatsappStatus = "connected";
      qrCodeBase64 = null;
    }
  });

  // Recebe mensagens
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const tel = msg.key.remoteJid?.replace("@s.whatsapp.net", "").replace("@g.us", "");
      if (!tel || msg.key.remoteJid?.endsWith("@g.us")) continue;
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption;
      if (!texto) continue;

      console.log(`📩 ${tel}: ${texto}`);

      // Verifica avaliação pendente
      if (aguardandoAvaliacao.has(tel)) {
        const nota = parseInt(texto.trim());
        if (nota >= 1 && nota <= 5) {
          const pedidoId = aguardandoAvaliacao.get(tel);
          const pedido = pedidos.find(p => p.id === pedidoId);
          avaliacoes.push({ pedidoId, telefone: tel, cliente: pedido?.cliente || tel, nota, horario: new Date().toISOString() });
          aguardandoAvaliacao.delete(tel);
          const agradecimento = CONFIG.avaliacao.mensagemObrigado.replace(/{cliente}/g, pedido?.cliente || "");
          await enviarMsg(tel, agradecimento);
          continue;
        }
        aguardandoAvaliacao.delete(tel);
      }

      try {
        addMsg(tel, "user", texto);
        const resposta = await chamarClaude(getHist(tel));
        addMsg(tel, "assistant", resposta);

        const dadosPedido = extrairPedido(resposta);
        if (dadosPedido) {
          if (dadosPedido.cupom) {
            const subtotal = dadosPedido.itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0);
            const { desconto, cupom: cupomObj } = aplicarCupom(subtotal, dadosPedido.cupom);
            dadosPedido.desconto = desconto;
            dadosPedido.total = subtotal + CONFIG.taxaEntrega - desconto;
            if (cupomObj) cupomObj.usoAtual += 1;
          }
          const tempoPreparo = calcularTempoPreparo(dadosPedido.itens);
          const pedido = { id: String(counter++).padStart(3, "0"), ...dadosPedido, telefone: tel, tempoPreparo, status: "novo", horario: new Date().toISOString() };
          pedidos.push(pedido);
          console.log(`📦 Pedido #${pedido.id} — ${pedido.cliente}`);
          await enviarMsg(tel, resposta);
          await enviarMsg(tel, `⏱️ Tempo estimado: *${tempoPreparo} minutos*`);
          if (CONFIG.fidelidade.ativo) {
            const f = getFidelidade(tel);
            const faltam = CONFIG.fidelidade.pedidosParaGanhar - (f.pedidosEntregues % CONFIG.fidelidade.pedidosParaGanhar);
            await enviarMsg(tel, `🏆 Fidelidade: ${f.pedidosEntregues} pedido${f.pedidosEntregues !== 1 ? "s" : ""} entregue${f.pedidosEntregues !== 1 ? "s" : ""}. Faltam *${faltam}* para ganhar ${CONFIG.fidelidade.brinde}!`);
          }
          continue;
        }
        await enviarMsg(tel, resposta);
      } catch (err) {
        console.error("Erro ao processar mensagem:", err.message);
      }
    }
  });
}

// ── PÁGINA DO QR CODE ─────────────────────────────────────────
app.get("/qrcode", (req, res) => {
  if (whatsappStatus === "connected") {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f5f5f5">
      <h1 style="color:#075e54">✅ WhatsApp Conectado!</h1>
      <p>O bot está funcionando e pronto para receber pedidos.</p>
      <p style="color:#888">Número conectado com sucesso.</p>
    </body></html>`);
  }
  if (whatsappStatus === "qr" && qrCodeBase64) {
    return res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="30"></head>
      <body style="font-family:sans-serif;text-align:center;padding:30px;background:#f5f5f5">
      <h1 style="color:#075e54">👑 Império dos Espetos</h1>
      <h2>Escaneie o QR Code com o WhatsApp</h2>
      <p style="color:#555">Abra o WhatsApp → <b>Configurações</b> → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b></p>
      <img src="${qrCodeBase64}" style="width:300px;height:300px;border:4px solid #075e54;border-radius:12px;margin:20px auto;display:block"/>
      <p style="color:#888;font-size:13px">Esta página atualiza automaticamente a cada 30 segundos</p>
      <p style="color:#888;font-size:12px">Status: <b>${whatsappStatus}</b></p>
    </body></html>`);
  }
  return res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:sans-serif;text-align:center;padding:50px;background:#f5f5f5">
    <h1 style="color:#075e54">👑 Império dos Espetos</h1>
    <h2>⏳ Aguardando QR Code...</h2>
    <p>O servidor está iniciando. Esta página atualiza automaticamente.</p>
    <p style="color:#888;font-size:12px">Status: <b>${whatsappStatus}</b></p>
  </body></html>`);
});

// ── PEDIDOS API ───────────────────────────────────────────────
app.get("/pedidos", (req, res) => res.json(pedidos));

app.patch("/pedidos/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!["novo","preparando","entrega","entregue","cancelado"].includes(status)) return res.status(400).json({ erro: "Status inválido" });
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ erro: "Pedido não encontrado" });
  pedido.status = status;
  await enviarMsgStatus(pedido, status);
  if (status === "entregue") { await checarFidelidade(pedido); agendarAvaliacao(pedido); }
  if (status === "cancelado" && timersAvaliacao.has(id)) { clearTimeout(timersAvaliacao.get(id)); timersAvaliacao.delete(id); }
  res.json(pedido);
});

// ── WHATSAPP STATUS API ───────────────────────────────────────
app.get("/whatsapp/status", (req, res) => res.json({ status: whatsappStatus }));

app.post("/whatsapp/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
    whatsappStatus = "disconnected";
    qrCodeBase64 = null;
    setTimeout(conectarWhatsApp, 2000);
    res.json({ ok: true, message: "Desconectado. Novo QR Code será gerado." });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── CUPONS API ────────────────────────────────────────────────
app.get("/cupons", (req, res) => res.json(cupons));
app.post("/cupons", (req, res) => {
  const { codigo, tipo, valor, usoMax, validade, descricao } = req.body;
  if (!codigo || !tipo || valor === undefined) return res.status(400).json({ erro: "codigo, tipo e valor obrigatórios" });
  if (cupons.find(c => c.codigo.toUpperCase() === codigo.toUpperCase())) return res.status(400).json({ erro: "Código já existe" });
  const novo = { codigo: codigo.toUpperCase(), tipo, valor: parseFloat(valor), ativo: true, usoMax: usoMax || null, usoAtual: 0, validade: validade || null, descricao: descricao || "" };
  cupons.push(novo);
  res.status(201).json(novo);
});
app.patch("/cupons/:codigo/ativo", (req, res) => {
  const cupom = cupons.find(c => c.codigo === req.params.codigo.toUpperCase());
  if (!cupom) return res.status(404).json({ erro: "Cupom não encontrado" });
  cupom.ativo = req.body.ativo;
  res.json(cupom);
});
app.delete("/cupons/:codigo", (req, res) => {
  const idx = cupons.findIndex(c => c.codigo === req.params.codigo.toUpperCase());
  if (idx === -1) return res.status(404).json({ erro: "Cupom não encontrado" });
  const [removido] = cupons.splice(idx, 1);
  res.json({ ok: true, removido });
});
app.post("/cupons/validar", (req, res) => {
  const resultado = aplicarCupom(req.body.subtotal || 0, req.body.codigo);
  res.json(resultado);
});

// ── AVALIAÇÕES API ────────────────────────────────────────────
app.get("/avaliacoes", (req, res) => res.json(avaliacoes));
app.get("/avaliacoes/resumo", (req, res) => {
  if (!avaliacoes.length) return res.json({ media: 0, total: 0, distribuicao: {} });
  const media = avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length;
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  avaliacoes.forEach(a => dist[a.nota]++);
  res.json({ media: parseFloat(media.toFixed(1)), total: avaliacoes.length, distribuicao: dist });
});

// ── FIDELIDADE API ────────────────────────────────────────────
app.get("/fidelidade", (req, res) => {
  const lista = [...fidelidadeClientes.entries()].map(([tel, f]) => {
    const pedido = pedidos.filter(p => p.telefone === tel).slice(-1)[0];
    return { telefone: tel, cliente: pedido?.cliente || tel, ...f };
  });
  res.json(lista);
});

// ── CARDÁPIO API ──────────────────────────────────────────────
app.get("/cardapio", (req, res) => res.json(CARDAPIO));
app.post("/cardapio", (req, res) => {
  const { categoria, nome, preco, tempoPreparo, obs } = req.body;
  if (!categoria || !nome || !preco) return res.status(400).json({ erro: "categoria, nome e preco obrigatórios" });
  const item = { id: nextItemId++, categoria, nome, preco: parseFloat(preco), tempoPreparo: parseInt(tempoPreparo) || 10, ativo: true, obs: obs || null };
  CARDAPIO.push(item);
  res.status(201).json(item);
});
app.put("/cardapio/:id", (req, res) => {
  const idx = CARDAPIO.findIndex(i => i.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ erro: "Item não encontrado" });
  CARDAPIO[idx] = { ...CARDAPIO[idx], ...req.body, id: parseInt(req.params.id) };
  res.json(CARDAPIO[idx]);
});
app.patch("/cardapio/:id/ativo", (req, res) => {
  const item = CARDAPIO.find(i => i.id === parseInt(req.params.id));
  if (!item) return res.status(404).json({ erro: "Item não encontrado" });
  item.ativo = req.body.ativo;
  res.json(item);
});
app.delete("/cardapio/:id", (req, res) => {
  const idx = CARDAPIO.findIndex(i => i.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ erro: "Item não encontrado" });
  const [removido] = CARDAPIO.splice(idx, 1);
  res.json({ ok: true, removido });
});

// ── CONFIG API ────────────────────────────────────────────────
app.get("/config", (req, res) => res.json(CONFIG));
app.put("/config", (req, res) => { CONFIG = { ...CONFIG, ...req.body }; res.json(CONFIG); });
app.put("/config/horario", (req, res) => { CONFIG.horarioFuncionamento = { ...CONFIG.horarioFuncionamento, ...req.body }; res.json(CONFIG.horarioFuncionamento); });
app.put("/config/mensagens", (req, res) => { CONFIG.mensagensAutomaticas = { ...CONFIG.mensagensAutomaticas, ...req.body }; res.json(CONFIG.mensagensAutomaticas); });
app.put("/config/fidelidade", (req, res) => { CONFIG.fidelidade = { ...CONFIG.fidelidade, ...req.body }; res.json(CONFIG.fidelidade); });
app.put("/config/avaliacao", (req, res) => { CONFIG.avaliacao = { ...CONFIG.avaliacao, ...req.body }; res.json(CONFIG.avaliacao); });
app.get("/config/status-loja", (req, res) => res.json({ aberto: estaAberto(), proximaAbertura: proximaAbertura() }));

// ── HEALTH ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", versao: "5.0",
  whatsapp: whatsappStatus,
  aberto: estaAberto(),
  pedidos: pedidos.length,
  avaliacoes: avaliacoes.length,
  cupons: cupons.filter(c => c.ativo).length,
  uptime: Math.floor(process.uptime()) + "s",
}));

// ── START ─────────────────────────────────────────────────────
app.listen(ENV.PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   👑 Império dos Espetos — Backend v5            ║
  ║   Porta: ${ENV.PORT}  — WhatsApp via Baileys          ║
  ║                                                  ║
  ║   GET /qrcode    → escanear QR Code              ║
  ║   GET /health    → status geral                  ║
  ╚══════════════════════════════════════════════════╝
  `);
  await conectarWhatsApp();
});
