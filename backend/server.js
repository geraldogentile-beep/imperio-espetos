// ============================================================
// IMPÉRIO DOS ESPETOS — Backend v4
// Rodada 3: cupom de desconto, programa de fidelidade,
//           avaliação pós-entrega
// ============================================================

import express from "express";
import fetch from "node-fetch";

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
  EVOLUTION_URL:      process.env.EVOLUTION_URL      || "http://localhost:8080",
  EVOLUTION_KEY:      process.env.EVOLUTION_KEY      || "sua-api-key-aqui",
  EVOLUTION_INSTANCE: process.env.EVOLUTION_INSTANCE || "imperio-espetos",
  ANTHROPIC_KEY:      process.env.ANTHROPIC_KEY      || "sua-chave-anthropic-aqui",
  PORT:               process.env.PORT               || 3000,
};

// ── CONFIG ────────────────────────────────────────────────────
let CONFIG = {
  nomeEstabelecimento: "Império dos Espetos e Grill",
  nomeAgente: "Imperador",
  taxaEntrega: 5.00,
  tempoEntregaMin: 30,
  tempoEntregaMax: 45,

  entregaCEP: {
    ativo: true,
    cepBase: "01310100",
    raioKm: 5,
    mensagemForaRaio: "😕 Infelizmente não entregamos nessa região. Nosso raio é de {raio}km.",
  },

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

  // ── RODADA 3: Fidelidade ──────────────────────────────────
  fidelidade: {
    ativo: true,
    pedidosParaGanhar: 5,         // a cada X pedidos entregues ganha 1 brinde
    brinde: "1 espetinho grátis", // o que o cliente ganha
    mensagemGanhou: "🎉 Parabéns {cliente}! Você completou {total} pedidos e ganhou *{brinde}*! No seu próximo pedido é só mencionar 😄",
  },

  // ── RODADA 3: Avaliação pós-entrega ───────────────────────
  avaliacao: {
    ativo: true,
    delayMinutos: 10, // envia X minutos após marcar como entregue
    mensagem: "Olá {cliente}! 😊 Seu pedido do *Império dos Espetos* foi entregue! Como foi sua experiência?\n\nResponda com uma nota de *1 a 5* ⭐",
    mensagemObrigado: "Obrigado pela avaliação, {cliente}! Sua opinião é muito importante pra gente 💛🔥",
  },
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

// ── CUPONS (Rodada 3) ─────────────────────────────────────────
let cupons = [
  { codigo: "BEMVINDO10", tipo: "percentual", valor: 10, ativo: true, usoMax: 100, usoAtual: 0, validade: null, descricao: "10% de desconto boas-vindas" },
  { codigo: "FRETE0",     tipo: "frete",      valor: 0,  ativo: true, usoMax: 50,  usoAtual: 0, validade: null, descricao: "Frete grátis" },
];

// ── FIDELIDADE — contadores por telefone (Rodada 3) ───────────
const fidelidadeClientes = new Map(); // telefone → { pedidosEntregues, brindesGanhos }

function getFidelidade(telefone) {
  if (!fidelidadeClientes.has(telefone)) {
    fidelidadeClientes.set(telefone, { pedidosEntregues: 0, brindesGanhos: 0 });
  }
  return fidelidadeClientes.get(telefone);
}

// ── AVALIAÇÕES (Rodada 3) ─────────────────────────────────────
const avaliacoes = [];                        // lista de avaliações recebidas
const aguardandoAvaliacao = new Map();        // telefone → pedidoId (esperando nota)
const timersAvaliacao = new Map();            // pedidoId → timeout handle

// ── PEDIDOS ───────────────────────────────────────────────────
const pedidos = [];
let counter = 1;

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

function calcularTempoPreparo(itensPedido) {
  if (!itensPedido?.length) return CONFIG.tempoEntregaMin;
  const maxItem = Math.max(...itensPedido.map(i => {
    const item = CARDAPIO.find(c => c.nome.toLowerCase() === i.nome.toLowerCase());
    return item ? item.tempoPreparo : 10;
  }));
  return maxItem + CONFIG.tempoEntregaMin;
}

function aplicarCupom(subtotal, codigoCupom) {
  if (!codigoCupom) return { desconto: 0, tipoDesconto: null };
  const cupom = cupons.find(c => c.codigo.toUpperCase() === codigoCupom.toUpperCase() && c.ativo);
  if (!cupom) return { desconto: 0, tipoDesconto: null, erro: "Cupom inválido ou expirado." };
  if (cupom.usoMax && cupom.usoAtual >= cupom.usoMax) return { desconto: 0, tipoDesconto: null, erro: "Cupom esgotado." };
  if (cupom.validade && new Date() > new Date(cupom.validade)) return { desconto: 0, tipoDesconto: null, erro: "Cupom expirado." };
  let desconto = 0;
  if (cupom.tipo === "percentual") desconto = subtotal * (cupom.valor / 100);
  else if (cupom.tipo === "fixo") desconto = Math.min(cupom.valor, subtotal);
  else if (cupom.tipo === "frete") desconto = CONFIG.taxaEntrega;
  return { desconto: parseFloat(desconto.toFixed(2)), tipoDesconto: cupom.tipo, cupom };
}

async function validarCEP(cepCliente) {
  if (!CONFIG.entregaCEP.ativo) return { valido: true };
  const cepLimpo = cepCliente.replace(/\D/g, "");
  if (cepLimpo.length !== 8) return { valido: false, motivo: "CEP inválido." };
  try {
    const [rb, rc] = await Promise.all([
      fetch(`https://viacep.com.br/ws/${CONFIG.entregaCEP.cepBase}/json/`),
      fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`),
    ]);
    const [base, cliente] = await Promise.all([rb.json(), rc.json()]);
    if (cliente.erro) return { valido: false, motivo: "CEP não encontrado." };
    if (base.uf !== cliente.uf) return { valido: false, motivo: CONFIG.entregaCEP.mensagemForaRaio.replace("{raio}", CONFIG.entregaCEP.raioKm) };
    return { valido: true, endereco: `${cliente.logradouro}, ${cliente.bairro} - ${cliente.localidade}/${cliente.uf}`, cep: cepLimpo };
  } catch {
    return { valido: true };
  }
}

function formatMsg(template, pedido) {
  return template
    .replace(/{id}/g, pedido.id)
    .replace(/{cliente}/g, pedido.cliente)
    .replace(/{total}/g, pedido.total?.toFixed(2))
    .replace(/{brinde}/g, CONFIG.fidelidade.brinde);
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

Seu trabalho (apenas quando ABERTO):
1. Recepcionar o cliente de forma calorosa
2. Apresentar o cardápio quando pedido
3. Verificar se o cliente tem cupom de desconto (pergunte antes de fechar)
4. Anotar pedido, calcular total com desconto se houver
5. Coletar nome, CEP e endereço
6. Confirmar pedido com resumo final e tempo estimado

CUPONS VÁLIDOS: ${cuponsAtivos || "nenhum no momento"}
Se o cliente informar um cupom, aplique o desconto no total.

PROGRAMA DE FIDELIDADE: A cada ${CONFIG.fidelidade.pedidosParaGanhar} pedidos entregues, o cliente ganha ${CONFIG.fidelidade.brinde}.

CARDÁPIO:
${cardapioTexto()}

Regras:
- Taxa de entrega: R$ ${CONFIG.taxaEntrega.toFixed(2)}
- Seja simpático e natural em português brasileiro
- Não invente itens fora do cardápio
- Ao finalizar inclua exatamente:
<PEDIDO_FINALIZADO>
{"cliente":"nome","telefone":"numero","cep":"00000000","endereco":"endereço","itens":[{"nome":"item","qty":1,"preco":9.00}],"subtotal":0.00,"desconto":0.00,"cupom":"","total":0.00,"obs":"","tempoPreparo":0}
</PEDIDO_FINALIZADO>
- Responda SEMPRE em português brasileiro`;
}

// ── MEMÓRIA ───────────────────────────────────────────────────
const conversas = new Map();
function getHist(tel) { if (!conversas.has(tel)) conversas.set(tel, []); return conversas.get(tel); }
function addMsg(tel, role, content) {
  const h = getHist(tel);
  h.push({ role, content });
  if (h.length > 40) h.splice(0, h.length - 40);
}

// ── EVOLUTION ─────────────────────────────────────────────────
async function enviarMsg(tel, texto) {
  const limpo = texto.replace(/<PEDIDO_FINALIZADO>[\s\S]*?<\/PEDIDO_FINALIZADO>/g, "").trim();
  try {
    await fetch(`${ENV.EVOLUTION_URL}/message/sendText/${ENV.EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": ENV.EVOLUTION_KEY },
      body: JSON.stringify({ number: tel, text: limpo }),
    });
  } catch (e) { console.error("Erro envio:", e.message); }
}

async function enviarMsgStatus(pedido, status) {
  if (!CONFIG.mensagensAutomaticas.ativo) return;
  const tpl = CONFIG.mensagensAutomaticas[status];
  if (!tpl || !pedido.telefone) return;
  await enviarMsg(pedido.telefone, formatMsg(tpl, pedido));
}

// ── AVALIAÇÃO PÓS-ENTREGA (Rodada 3) ─────────────────────────
function agendarAvaliacao(pedido) {
  if (!CONFIG.avaliacao.ativo) return;
  const delay = CONFIG.avaliacao.delayMinutos * 60 * 1000;
  const timer = setTimeout(async () => {
    const msg = CONFIG.avaliacao.mensagem
      .replace(/{cliente}/g, pedido.cliente);
    await enviarMsg(pedido.telefone, msg);
    aguardandoAvaliacao.set(pedido.telefone, pedido.id);
    timersAvaliacao.delete(pedido.id);
    console.log(`⭐ Avaliação enviada para ${pedido.cliente}`);
  }, delay);
  timersAvaliacao.set(pedido.id, timer);
}

// ── FIDELIDADE — checa se ganhou brinde (Rodada 3) ────────────
async function checarFidelidade(pedido) {
  if (!CONFIG.fidelidade.ativo) return;
  const f = getFidelidade(pedido.telefone);
  f.pedidosEntregues += 1;
  const meta = CONFIG.fidelidade.pedidosParaGanhar;
  if (f.pedidosEntregues > 0 && f.pedidosEntregues % meta === 0) {
    f.brindesGanhos += 1;
    const msg = CONFIG.fidelidade.mensagemGanhou
      .replace(/{cliente}/g, pedido.cliente)
      .replace(/{total}/g, f.pedidosEntregues)
      .replace(/{brinde}/g, CONFIG.fidelidade.brinde);
    await enviarMsg(pedido.telefone, msg);
    console.log(`🎁 Brinde enviado para ${pedido.cliente} (${f.pedidosEntregues} pedidos)`);
  }
}

// ── CLAUDE ────────────────────────────────────────────────────
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

// ── WEBHOOK ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.event !== "messages.upsert") return;
    const msg = body.data?.messages?.[0];
    if (!msg || msg.key?.fromMe) return;
    const tel = msg.key?.remoteJid?.replace("@s.whatsapp.net", "");
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
    if (!tel || !texto) return;
    console.log(`📩 ${tel}: ${texto}`);

    // ── Verifica se é uma avaliação pendente ──────────────────
    if (aguardandoAvaliacao.has(tel)) {
      const nota = parseInt(texto.trim());
      if (nota >= 1 && nota <= 5) {
        const pedidoId = aguardandoAvaliacao.get(tel);
        const pedido = pedidos.find(p => p.id === pedidoId);
        avaliacoes.push({
          pedidoId,
          telefone: tel,
          cliente: pedido?.cliente || "Cliente",
          nota,
          comentario: "",
          horario: new Date().toISOString(),
        });
        aguardandoAvaliacao.delete(tel);
        const agradecimento = CONFIG.avaliacao.mensagemObrigado.replace(/{cliente}/g, pedido?.cliente || "");
        await enviarMsg(tel, agradecimento);
        console.log(`⭐ Avaliação ${nota}/5 de ${pedido?.cliente}`);
        return;
      }
      // Se não for número, continua o fluxo normal
      aguardandoAvaliacao.delete(tel);
    }

    addMsg(tel, "user", texto);
    const resposta = await chamarClaude(getHist(tel));
    addMsg(tel, "assistant", resposta);

    const dadosPedido = extrairPedido(resposta);
    if (dadosPedido) {
      // Aplica cupom se informado
      if (dadosPedido.cupom) {
        const subtotal = dadosPedido.itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0);
        const { desconto, cupom: cupomObj } = aplicarCupom(subtotal, dadosPedido.cupom);
        dadosPedido.desconto = desconto;
        dadosPedido.total = subtotal + CONFIG.taxaEntrega - desconto;
        if (cupomObj) cupomObj.usoAtual += 1;
      }

      const tempoPreparo = calcularTempoPreparo(dadosPedido.itens);
      const pedido = {
        id: String(counter++).padStart(3, "0"),
        ...dadosPedido,
        telefone: tel,
        tempoPreparo,
        status: "novo",
        horario: new Date().toISOString(),
      };
      pedidos.push(pedido);
      console.log(`📦 Pedido #${pedido.id} — ${pedido.cliente}`);
      await enviarMsg(tel, resposta);
      await enviarMsg(tel, `⏱️ Tempo estimado: *${tempoPreparo} minutos*`);

      // Informa saldo de fidelidade
      if (CONFIG.fidelidade.ativo) {
        const f = getFidelidade(tel);
        const faltam = CONFIG.fidelidade.pedidosParaGanhar - (f.pedidosEntregues % CONFIG.fidelidade.pedidosParaGanhar);
        await enviarMsg(tel, `🏆 Fidelidade: você tem *${f.pedidosEntregues}* pedido${f.pedidosEntregues !== 1 ? "s" : ""} entregue${f.pedidosEntregues !== 1 ? "s" : ""}. Faltam *${faltam}* para ganhar ${CONFIG.fidelidade.brinde}!`);
      }
      return;
    }

    await enviarMsg(tel, resposta);
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ── PEDIDOS API ───────────────────────────────────────────────
app.get("/pedidos", (req, res) => res.json(pedidos));

app.patch("/pedidos/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!["novo","preparando","entrega","entregue","cancelado"].includes(status)) {
    return res.status(400).json({ erro: "Status inválido" });
  }
  const pedido = pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ erro: "Pedido não encontrado" });
  pedido.status = status;
  await enviarMsgStatus(pedido, status);

  // Ao entregar: fidelidade + agendar avaliação
  if (status === "entregue") {
    await checarFidelidade(pedido);
    agendarAvaliacao(pedido);
  }

  // Cancelar timer de avaliação se cancelado
  if (status === "cancelado" && timersAvaliacao.has(id)) {
    clearTimeout(timersAvaliacao.get(id));
    timersAvaliacao.delete(id);
  }

  res.json(pedido);
});

// ── CUPONS API (Rodada 3) ─────────────────────────────────────
app.get("/cupons", (req, res) => res.json(cupons));

app.post("/cupons", (req, res) => {
  const { codigo, tipo, valor, usoMax, validade, descricao } = req.body;
  if (!codigo || !tipo || valor === undefined) return res.status(400).json({ erro: "codigo, tipo e valor são obrigatórios" });
  if (!["percentual","fixo","frete"].includes(tipo)) return res.status(400).json({ erro: "Tipo deve ser: percentual, fixo ou frete" });
  if (cupons.find(c => c.codigo.toUpperCase() === codigo.toUpperCase())) return res.status(400).json({ erro: "Código já existe" });
  const novo = { codigo: codigo.toUpperCase(), tipo, valor: parseFloat(valor), ativo: true, usoMax: usoMax || null, usoAtual: 0, validade: validade || null, descricao: descricao || "" };
  cupons.push(novo);
  console.log(`🎟️ Cupom criado: ${novo.codigo}`);
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
  const { codigo, subtotal } = req.body;
  const resultado = aplicarCupom(subtotal || 0, codigo);
  res.json(resultado);
});

// ── AVALIAÇÕES API (Rodada 3) ─────────────────────────────────
app.get("/avaliacoes", (req, res) => res.json(avaliacoes));

app.get("/avaliacoes/resumo", (req, res) => {
  if (avaliacoes.length === 0) return res.json({ media: 0, total: 0, distribuicao: {} });
  const media = avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length;
  const distribuicao = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  avaliacoes.forEach(a => distribuicao[a.nota]++);
  res.json({ media: parseFloat(media.toFixed(1)), total: avaliacoes.length, distribuicao });
});

// ── FIDELIDADE API (Rodada 3) ─────────────────────────────────
app.get("/fidelidade", (req, res) => {
  const lista = [...fidelidadeClientes.entries()].map(([tel, f]) => {
    const pedido = pedidos.filter(p => p.telefone === tel).slice(-1)[0];
    return { telefone: tel, cliente: pedido?.cliente || tel, ...f };
  });
  res.json(lista);
});

app.get("/fidelidade/:telefone", (req, res) => {
  const f = getFidelidade(req.params.telefone);
  res.json(f);
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

// ── CEP API ───────────────────────────────────────────────────
app.post("/validar-cep", async (req, res) => {
  const resultado = await validarCEP(req.body.cep || "");
  res.json(resultado);
});

// ── CONFIG API ────────────────────────────────────────────────
app.get("/config", (req, res) => res.json(CONFIG));
app.put("/config", (req, res) => { CONFIG = { ...CONFIG, ...req.body }; res.json(CONFIG); });
app.put("/config/horario", (req, res) => { CONFIG.horarioFuncionamento = { ...CONFIG.horarioFuncionamento, ...req.body }; res.json(CONFIG.horarioFuncionamento); });
app.put("/config/mensagens", (req, res) => { CONFIG.mensagensAutomaticas = { ...CONFIG.mensagensAutomaticas, ...req.body }; res.json(CONFIG.mensagensAutomaticas); });
app.put("/config/entrega-cep", (req, res) => { CONFIG.entregaCEP = { ...CONFIG.entregaCEP, ...req.body }; res.json(CONFIG.entregaCEP); });
app.put("/config/fidelidade", (req, res) => { CONFIG.fidelidade = { ...CONFIG.fidelidade, ...req.body }; res.json(CONFIG.fidelidade); });
app.put("/config/avaliacao", (req, res) => { CONFIG.avaliacao = { ...CONFIG.avaliacao, ...req.body }; res.json(CONFIG.avaliacao); });
app.get("/config/status-loja", (req, res) => res.json({ aberto: estaAberto(), proximaAbertura: proximaAbertura() }));

// ── HEALTH ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", versao: "4.0", aberto: estaAberto(),
  pedidos: pedidos.length, avaliacoes: avaliacoes.length,
  cupons: cupons.filter(c => c.ativo).length,
  clientesFidelidade: fidelidadeClientes.size,
  uptime: Math.floor(process.uptime()) + "s",
}));

app.listen(ENV.PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   👑 Império dos Espetos — Backend v4  🎉        ║
  ║   Porta: ${ENV.PORT}  — SISTEMA COMPLETO              ║
  ║                                                  ║
  ║   CUPONS       GET/POST /cupons                  ║
  ║                PATCH /cupons/:cod/ativo          ║
  ║                DELETE /cupons/:cod               ║
  ║                POST /cupons/validar              ║
  ║                                                  ║
  ║   AVALIAÇÕES   GET /avaliacoes                   ║
  ║                GET /avaliacoes/resumo            ║
  ║                                                  ║
  ║   FIDELIDADE   GET /fidelidade                   ║
  ║                GET /fidelidade/:telefone         ║
  ╚══════════════════════════════════════════════════╝
  `);
});
