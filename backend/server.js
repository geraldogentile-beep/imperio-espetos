// ============================================================
// IMPÉRIO DOS ESPETOS — Backend v5
// WhatsApp via Baileys direto (sem Evolution API)
// ============================================================
import 'dotenv/config';

import express from "express";
import fetch from "node-fetch";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode";
import fs from "fs";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import forge from "node-forge";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const app = express();

// O Node fica atras do Nginx, entao todo request chega de 127.0.0.1. Sem isso
// o express-rate-limit conta o predio inteiro como um usuario so e derruba o
// caixa com "muitas tentativas". O valor 1 = confia em UM salto de proxy
// (o Nginx); "true" confiaria na cadeia inteira e deixaria qualquer um forjar
// o X-Forwarded-For para escapar do limite.
app.set("trust proxy", 1);

// ── SEGURANÇA ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));

// CORS restrito a domínios conhecidos
app.use((req, res, next) => {
  const allowedOrigins = [
    ENV.FRONTEND_URL,
    "http://localhost:5173",
    "http://localhost:3000",
  ].filter(Boolean);
  const origin = req.headers.origin;
  // Em dev, aceita qualquer localhost (5173, 5174, 5175...)
  const isLocalhostDev = process.env.NODE_ENV !== "production" && origin && /^http:\/\/localhost:\d+$/.test(origin);
  if (origin && (allowedOrigins.includes(origin) || isLocalhostDev)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limiting geral
// IMPORTANTE: o painel faz polling a cada 8s com 7 requests simultâneas
// = ~50 req/min por usuário. Múltiplos usuários (dono + caixa + garçons)
// podem facilmente passar de 200 req/min. Por isso o limite precisa ser alto.
// 5000/15min ≈ 333/min = suporta confortavelmente 6+ usuários simultâneos.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { erro: "Muitas requisições. Aguarde alguns minutos." },
  standardHeaders: true,
  legacyHeaders: false,
  // /health não conta (usado por monitoring externo)
  skip: (req) => req.path === "/health",
});
app.use(limiter);

// Rate limiting específico para login (anti brute-force)
// 100 tentativas/15min e SÓ falhas contam. O frontend já tem lockout de 5 tentativas.
// O objetivo aqui é só barrar bots agressivos, não atrapalhar o uso normal.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: "Muitas tentativas. Aguarde 1 minuto." },
  skipSuccessfulRequests: true, // logins certos não contam
  standardHeaders: true,
  legacyHeaders: false,
});

// ── JWT AUTH ─────────────────────────────────────────────────
function gerarToken(payload) {
  return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: "8h" });
}

function authMiddleware(rolesPermitidas = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return res.status(401).json({ erro: "Token não fornecido" });
    try {
      const decoded = jwt.verify(header.slice(7), ENV.JWT_SECRET);
      req.user = decoded;
      if (rolesPermitidas.length > 0 && !rolesPermitidas.includes(decoded.role)) {
        return res.status(403).json({ erro: "Sem permissão para esta operação" });
      }
      next();
    } catch {
      return res.status(401).json({ erro: "Token inválido ou expirado" });
    }
  };
}

// Middleware que aceita autenticado OU não (para rotas que funcionam com/sem auth)
function authOpcional(req, res, next) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try { req.user = jwt.verify(header.slice(7), ENV.JWT_SECRET); } catch {}
  }
  next();
}

// ── ENV ───────────────────────────────────────────────────────
// ── VALIDAÇÃO DE ENV VARS (obrigatórias em produção) ─────────
function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Variável de ambiente ${name} não definida!`);
    process.exit(1);
  }
  return val;
}

const ENV = {
  ANTHROPIC_KEY: process.env.NODE_ENV === "production" ? requiredEnv("ANTHROPIC_KEY") : (process.env.ANTHROPIC_KEY || ""),
  MONGO_URI:     process.env.NODE_ENV === "production" ? requiredEnv("MONGO_URI")     : (process.env.MONGO_URI || ""),
  PORT:          process.env.PORT || 3000,
  JWT_SECRET:    process.env.NODE_ENV === "production" ? requiredEnv("JWT_SECRET")   : (process.env.JWT_SECRET || "imperio-dev-secret-trocar-em-prod"),
  FRONTEND_URL:  process.env.FRONTEND_URL || "http://localhost:5173",
};

// ── MONGODB — SCHEMAS & CONEXÃO ──────────────────────────────
const PedidoSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  cliente: { type: String, required: true },
  telefone: { type: String, required: true },
  endereco: { type: String, required: true },
  itens: { type: Array, required: true },
  subtotal: { type: Number, required: true, min: 0 },
  desconto: { type: Number, default: 0, min: 0 },
  cupom: String,
  total: { type: Number, required: true, min: 0 },
  obs: String,
  tempoPreparo: { type: Number, min: 0 },
  status: { type: String, default: "novo", enum: ["novo", "preparando", "entrega", "entregue", "cancelado"] },
  horario: { type: Date, default: Date.now },
}, { timestamps: true });

const CupomSchema = new mongoose.Schema({
  codigo: { type: String, required: true, unique: true, uppercase: true },
  tipo: { type: String, required: true, enum: ["percentual", "fixo", "frete"] },
  valor: { type: Number, required: true, min: 0 },
  ativo: { type: Boolean, default: true },
  usoMax: Number,
  usoAtual: { type: Number, default: 0, min: 0 },
  validade: Date,
  descricao: String,
});

const AvaliacaoSchema = new mongoose.Schema({
  pedidoId: { type: String, required: true },
  telefone: { type: String, required: true },
  cliente: String,
  nota: { type: Number, required: true, min: 1, max: 5 },
  horario: { type: Date, default: Date.now },
});

const FidelidadeSchema = new mongoose.Schema({
  telefone: { type: String, unique: true },
  pedidosEntregues: { type: Number, default: 0 },
  brindesGanhos: { type: Number, default: 0 },
});

const ConfigSchema = new mongoose.Schema({
  chave: { type: String, unique: true },
  valor: mongoose.Schema.Types.Mixed,
});

const CardapioSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  categoria: { type: String, required: true },
  nome: { type: String, required: true },
  preco: { type: Number, required: true, min: 0 },
  precoPromocional: { type: Number, default: null, min: 0 },
  tempoPreparo: { type: Number, default: 10, min: 0 },
  ativo: { type: Boolean, default: true },
  obs: String,
  // ── Dados fiscais (NFC-e) ──
  // Quem define esses valores e o CONTADOR. Vazio = usa o padrao da config fiscal.
  fiscal: {
    ncm:     { type: String, default: "" },  // Nomenclatura Comum do Mercosul
    cfop:    { type: String, default: "" },  // Natureza da operacao (producao propria != revenda)
    csosn:   { type: String, default: "" },  // Simples Nacional usa CSOSN (nao CST)
    cest:    { type: String, default: "" },  // So quando ha ICMS-ST
    origem:  { type: String, default: "0" }, // 0 = nacional
    unidade: { type: String, default: "UN" },
  },
});

const VendaSalaoSchema = new mongoose.Schema({
  mesa: { type: Number, required: true, min: 0 },
  cliente: String,
  garcom: String,
  garcomId: String,
  itens: { type: Array, required: true },
  total: { type: Number, required: true, min: 0 },
  // ── Desconto ──
  // subtotal = soma dos itens; total = o que o cliente pagou de fato.
  // Venda antiga nao tem subtotal: nesse caso ele e igual ao total.
  subtotal:      { type: Number, default: 0, min: 0 },
  desconto:      { type: Number, default: 0, min: 0 },   // em reais
  descontoTipo:  { type: String, default: "", enum: ["", "percentual", "valor", "total"] },
  descontoInfo:  { type: String, default: "" },          // "10%", "arredondado para R$ 50,00"
  // Resumo (compatibilidade com o historico antigo): a forma unica, ou "misto"
  pagamento: { type: String, required: true, enum: ["pix", "cartao", "dinheiro", "misto"] },
  // Detalhe: a comanda pode ser dividida (metade dinheiro, metade pix)
  pagamentos: {
    type: [{
      tipo:  { type: String, enum: ["pix", "cartao", "dinheiro"], required: true },
      valor: { type: Number, required: true, min: 0 },
      _id: false,
    }],
    default: [],
  },
  abertura: Date,
  fechamento: { type: Date, default: Date.now },
  // ── NFC-e ──
  // Cache denormalizado para a listagem nao precisar de lookup por venda.
  // A fonte da verdade e a colecao NotaFiscal.
  notaFiscalId:     { type: mongoose.Schema.Types.ObjectId, ref: "NotaFiscal", default: null },
  notaFiscalStatus: { type: String, default: "sem_nota", enum: ["sem_nota", "processando", "autorizada", "rejeitada", "cancelada", "erro"] },
}, { timestamps: true });

// ── NOTA FISCAL (NFC-e modelo 65) ────────────────────────────
const NotaFiscalSchema = new mongoose.Schema({
  // Origem: venda de salao ou pedido de delivery
  vendaId:   { type: mongoose.Schema.Types.ObjectId, ref: "VendaSalao", default: null },
  pedidoId:  { type: String, default: null },

  ambiente:  { type: String, required: true, enum: ["homologacao", "producao"] },
  status:    { type: String, required: true, default: "processando",
               enum: ["processando", "autorizada", "rejeitada", "cancelada", "erro"] },

  // Identificacao (preenchida apos autorizacao)
  numero:    { type: Number, default: null },
  serie:     { type: Number, default: null },
  chave:     { type: String, default: null },   // 44 digitos
  protocolo: { type: String, default: null },

  valorTotal:   { type: Number, required: true, min: 0 },
  cpfCliente:   { type: String, default: "" },  // opcional: "CPF na nota"
  nomeCliente:  { type: String, default: "" },
  itens:        { type: Array, default: [] },   // snapshot fiscal do que foi enviado

  // Retorno do provedor
  refExterna:   { type: String, default: null },  // id usado na API fiscal (idempotencia)
  xmlUrl:       { type: String, default: null },
  danfeUrl:     { type: String, default: null },
  qrCode:       { type: String, default: null },
  mensagemErro: { type: String, default: "" },

  dataEmissao:     { type: Date, default: Date.now },
  dataAutorizacao: { type: Date, default: null },
  dataCancelamento:{ type: Date, default: null },
  motivoCancelamento: { type: String, default: "" },

  emitidoPor: { type: String, default: "" },  // role/nome de quem clicou
}, { timestamps: true });

const GarcomSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  pin:  { type: String, required: true, unique: true },
  ativo: { type: Boolean, default: true },
  criadoEm: { type: Date, default: Date.now },
});

// ── FECHAMENTO DO DIA ──────────────────────────────────────────
const FechamentoDiaSchema = new mongoose.Schema({
  data:            { type: Date, default: Date.now },
  dataStr:         String,           // "2026-04-06" para busca fácil
  totalDelivery:   { type: Number, default: 0 },
  totalSalao:      { type: Number, default: 0 },
  totalGeral:      { type: Number, default: 0 },
  pedidosDelivery: { type: Number, default: 0 },
  vendasSalao:     { type: Number, default: 0 },
  porPagamento: {  // salão por forma de pagamento
    pix:      { type: Number, default: 0 },
    cartao:   { type: Number, default: 0 },
    dinheiro: { type: Number, default: 0 },
  },
  porGarcom: Array,   // [{ nome, vendas, total }]
  obs: String,
  criadoPor: String,
});

// ── ESTOQUE ────────────────────────────────────────────────────
const EstoqueSchema = new mongoose.Schema({
  nome:          { type: String, required: true },
  unidade:       { type: String, default: "un" },
  quantidade:    { type: Number, default: 0, min: 0 },
  minimo:        { type: Number, default: 0, min: 0 },
  alertaEnviado: { type: Boolean, default: false },
  cardapioNomes: { type: [String], default: [] },
  consumoPorVenda: { type: Number, default: 1 },
  tipo:          { type: String, default: "normal" },
  capacidadeBarril: { type: Number, default: 0 },
  alertaTelefone: { type: String, default: "" },
  ativo:         { type: Boolean, default: true },
  criadoEm:      { type: Date, default: Date.now },
  // ── Formador de preço ──
  custoPorUnidade:  { type: Number, default: 0 },   // custo de compra por unidade
  margemDesejada:   { type: Number, default: 0 },   // margem em % desejada
  precoVendaAtual:  { type: Number, default: 0 },   // preço atual no cardápio (preenchido automaticamente)
});

const MovEstoqueSchema = new mongoose.Schema({
  estoqueId:   { type: mongoose.Schema.Types.ObjectId, ref: "Estoque" },
  estoqueNome: String,
  tipo:        { type: String, enum: ["entrada", "saida", "ajuste"] },
  quantidade:  Number,
  motivo:      String,   // "venda", "entrada mercadoria", "ajuste manual", "desperdício"
  vendaId:     String,   // referência à venda quando for saída automática
  horario:     { type: Date, default: Date.now },
});

const PedidoDB    = mongoose.model("Pedido",    PedidoSchema);
const CupomDB     = mongoose.model("Cupom",     CupomSchema);
const AvaliacaoDB = mongoose.model("Avaliacao", AvaliacaoSchema);
const FidelidadeDB = mongoose.model("Fidelidade", FidelidadeSchema);
const ConfigDB    = mongoose.model("Config",    ConfigSchema);
const CardapioDB  = mongoose.model("Cardapio",  CardapioSchema);
const VendaSalaoDB = mongoose.model("VendaSalao", VendaSalaoSchema);
const GarcomDB     = mongoose.model("Garcom",    GarcomSchema);
const EstoqueDB    = mongoose.model("Estoque",        EstoqueSchema);
const MovEstoqueDB = mongoose.model("MovEstoque",     MovEstoqueSchema);
const FechamentoDB = mongoose.model("FechamentoDia",  FechamentoDiaSchema);
const NotaFiscalDB = mongoose.model("NotaFiscal",     NotaFiscalSchema);

// ── FILA DE IMPRESSÃO ─────────────────────────────────────────
// A termica e Bluetooth e fica pareada num aparelho so (o do caixa).
// O celular do garcom nao alcanca ela, entao enfileira aqui.
const ImpressaoSchema = new mongoose.Schema({
  tipo:         { type: String, required: true, enum: ["cozinha", "recibo", "delivery"] },
  dados:        { type: Object, required: true },
  status:       { type: String, default: "pendente", enum: ["pendente", "processando", "impresso", "erro"] },
  origem:       { type: String, default: "" },   // quem mandou
  tentativas:   { type: Number, default: 0 },
  erro:         String,
  reservadoPor: String,
  reservadoEm:  Date,
  impressoEm:   Date,
}, { timestamps: true });
const ImpressaoDB = mongoose.model("Impressao", ImpressaoSchema);

async function conectarMongo() {
  try {
    await mongoose.connect(ENV.MONGO_URI);
    console.log("✅ MongoDB conectado!");
    await criarIndices();
    await inicializarDados();
  } catch (e) {
    console.error("⚠️  MongoDB falhou — usando memória:", e.message);
  }
}

async function criarIndices() {
  try {
    await PedidoDB.collection.createIndex({ horario: -1 });
    await PedidoDB.collection.createIndex({ status: 1 });
    await PedidoDB.collection.createIndex({ telefone: 1 });
    await PedidoDB.collection.createIndex({ id: 1 }, { unique: true });
    await VendaSalaoDB.collection.createIndex({ fechamento: -1 });
    await VendaSalaoDB.collection.createIndex({ garcom: 1 });
    await MovEstoqueDB.collection.createIndex({ estoqueId: 1, horario: -1 });
    await MovEstoqueDB.collection.createIndex({ tipo: 1, horario: -1 });
    await AvaliacaoDB.collection.createIndex({ horario: -1 });
    await FechamentoDB.collection.createIndex({ dataStr: 1 }, { unique: true });
    await EstoqueDB.collection.createIndex({ ativo: 1, nome: 1 });
    await NotaFiscalDB.collection.createIndex({ dataEmissao: -1 });
    await NotaFiscalDB.collection.createIndex({ status: 1, dataEmissao: -1 });
    await NotaFiscalDB.collection.createIndex({ vendaId: 1 });
    await VendaSalaoDB.collection.createIndex({ notaFiscalStatus: 1, fechamento: -1 });
    await ImpressaoDB.collection.createIndex({ status: 1, createdAt: 1 });
    // Ticket de ontem nao serve para nada: some sozinho depois de 24h
    await ImpressaoDB.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    console.log("📊 Índices criados/verificados!");
  } catch (e) { console.error("Erro ao criar índices:", e.message); }
}

async function inicializarDados() {
  // Inicializa cardápio se vazio
  const totalCardapio = await CardapioDB.countDocuments();
  if (totalCardapio === 0) {
    await CardapioDB.insertMany(CARDAPIO);
    console.log("📦 Cardápio inicializado no banco!");
  } else {
    CARDAPIO = await CardapioDB.find().lean();
  }

  // Inicializa cupons se vazio
  const totalCupons = await CupomDB.countDocuments();
  if (totalCupons === 0) {
    await CupomDB.insertMany(cupons);
    console.log("🎟️  Cupons inicializados no banco!");
  } else {
    cupons = await CupomDB.find().lean();
  }

  // Carrega config salva
  const cfgSalva = await ConfigDB.findOne({ chave: "config" });
  if (cfgSalva) CONFIG = { ...CONFIG, ...cfgSalva.valor };

  // Carrega counter de pedidos
  const ultimoPedido = await PedidoDB.findOne().sort({ horario: -1 }).lean();
  if (ultimoPedido?.id) counter = parseInt(ultimoPedido.id) + 1;

  console.log("✅ Dados carregados do banco!");
}

// ── ESTADO DO WHATSAPP ────────────────────────────────────────
let sock = null;
let qrCodeBase64 = null;
let whatsappStatus = "disconnected"; // disconnected | qr | connected
let authDir = "./auth_info";
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

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
  modoEvento: { ativo: false, nome: "", agendado: false, inicio: null, fim: null, mensagemWhats: "🏆 *PROMOÇÃO ESPECIAL!* Confira nossos preços diferenciados durante o evento!" },
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
// Cache em memoria; a fonte da verdade e o FidelidadeDB (sobrevive a restart)
function getFidelidade(tel) {
  if (!fidelidadeClientes.has(tel)) fidelidadeClientes.set(tel, { pedidosEntregues: 0, brindesGanhos: 0 });
  return fidelidadeClientes.get(tel);
}
// Le do banco e popula o cache. Usar antes de qualquer leitura que precise ser correta.
async function carregarFidelidade(tel) {
  try {
    const doc = await FidelidadeDB.findOne({ telefone: tel }).lean();
    if (doc) {
      const dados = { pedidosEntregues: doc.pedidosEntregues || 0, brindesGanhos: doc.brindesGanhos || 0 };
      fidelidadeClientes.set(tel, dados);
      return dados;
    }
  } catch (e) { console.error("Erro ao carregar fidelidade:", e.message); }
  return getFidelidade(tel);
}
async function salvarFidelidade(tel, dados) {
  try { await FidelidadeDB.updateOne({ telefone: tel }, { $set: dados }, { upsert: true }); } catch (e) { console.error("Erro ao salvar fidelidade:", e.message); }
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
function estaEmModoEvento() {
  const me = CONFIG.modoEvento || {};
  if (me.ativo) return true; // Manual ativo
  if (me.agendado && me.inicio && me.fim) {
    const agora = new Date();
    return agora >= new Date(me.inicio) && agora <= new Date(me.fim);
  }
  return false;
}

function precoAtual(item) {
  // Usa preço promocional se modo evento estiver ativo E o item tiver preço promocional
  if (estaEmModoEvento() && item.precoPromocional && item.precoPromocional > 0) {
    return item.precoPromocional;
  }
  return item.preco;
}

function estaAberto() {
  const agora = new Date();
  const h = CONFIG.horarioFuncionamento[agora.getDay()];
  if (!h?.aberto) return false;
  const [hAb, mAb] = h.abertura.split(":").map(Number);
  const [hFe, mFe] = h.fechamento.split(":").map(Number);
  const now = agora.getHours() * 60 + agora.getMinutes();
  const ab = hAb * 60 + mAb;
  let fe = hFe * 60 + mFe;
  // Fechamento apos meia-noite (ex.: 17:00 -> 01:00): a janela cruza o dia
  if (fe <= ab) fe += 1440;
  const nowAjustado = now < ab ? now + 1440 : now; // madrugada ainda pertence a janela do dia anterior
  return nowAjustado >= ab && nowAjustado < fe;
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
  const emEvento = estaEmModoEvento();
  return Object.entries(
    ativos.reduce((acc, item) => {
      if (!acc[item.categoria]) acc[item.categoria] = [];
      const preco = precoAtual(item);
      const temPromo = emEvento && item.precoPromocional && item.precoPromocional > 0 && item.precoPromocional < item.preco;
      const precoTxt = temPromo
        ? `~R$${item.preco.toFixed(2)}~ *R$${preco.toFixed(2)}* 🏆`
        : `R$${preco.toFixed(2)}`;
      acc[item.categoria].push(`  • ${item.nome}${item.obs ? ` (${item.obs})` : ""}: ${precoTxt}`);
      return acc;
    }, {})
  ).map(([cat, items]) => `${cat}:\n${items.join("\n")}`).join("\n\n");
}

function buildSystemPrompt(tel) {
  const aberto = estaAberto();
  const emEvento = estaEmModoEvento();
  const nomeEvento = CONFIG.modoEvento?.nome || "Evento Especial";
  const cuponsAtivos = cupons.filter(c => c.ativo).map(c => `${c.codigo} — ${c.descricao}`).join(", ");
  const telLimpo = tel ? tel.replace("@s.whatsapp.net","").replace("@lid","").replace(/\D/g,"") : "";
  return `Você é o assistente virtual do *${CONFIG.nomeEstabelecimento}* 👑🔥
Seu nome é *${CONFIG.nomeAgente}*.

STATUS: ${aberto ? "✅ LOJA ABERTA" : `🔴 LOJA FECHADA — próxima abertura: ${proximaAbertura()}. NÃO aceite pedidos.`}

${emEvento ? `🏆 *PROMOÇÃO ATIVA — ${nomeEvento}*: Os preços marcados com 🏆 no cardápio estão com valor promocional especial! Use sempre o preço promocional ao calcular o pedido. Pode mencionar a promoção ao cliente de forma calorosa.\n` : ""}
TELEFONE DO CLIENTE: ${telLimpo} (já capturado automaticamente — NUNCA peça o número de telefone ao cliente)

FIDELIDADE: A cada ${CONFIG.fidelidade.pedidosParaGanhar} pedidos o cliente ganha ${CONFIG.fidelidade.brinde}.

CUPONS: Só aplique desconto se o cliente mencionar um cupom espontaneamente. NUNCA ofereça, sugira ou mencione cupons por iniciativa própria.

Seu trabalho (apenas quando ABERTO):
1. Recepcionar o cliente de forma calorosa
2. Apresentar cardápio quando pedido
3. Anotar pedido, calcular total
4. Coletar apenas nome e endereço (telefone já capturado automaticamente)
5. Confirmar pedido com resumo

CARDÁPIO:
${cardapioTexto()}

Taxa de entrega: R$ ${CONFIG.taxaEntrega.toFixed(2)}
Tempo estimado: ${CONFIG.tempoEntregaMin} a ${CONFIG.tempoEntregaMax} minutos

Ao finalizar inclua exatamente:
<PEDIDO_FINALIZADO>
{"cliente":"nome","telefone":"${telLimpo}","endereco":"endereço","itens":[{"nome":"item","qty":1,"preco":9.00}],"subtotal":0.00,"desconto":0.00,"cupom":"","total":0.00,"obs":"","tempoPreparo":0}
</PEDIDO_FINALIZADO>

Responda SEMPRE em português brasileiro.`;
}

// ── CLAUDE API ────────────────────────────────────────────────
async function chamarClaude(historico, tel) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000); // 45s: evita request pendurada
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ENV.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: buildSystemPrompt(tel), messages: historico }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error("Claude API: rate limit atingido. Tente novamente em instantes.");
    if (res.status === 401) throw new Error("Claude API: chave inválida. Verifique ANTHROPIC_KEY.");
    throw new Error(`Claude API erro ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "Desculpe, tive um probleminha. Pode repetir?";
}

// Valida o JSON que a IA emitiu antes de virar pedido no banco.
// Sem isso, campo faltando ou valor absurdo gerava ValidationError e o
// pedido era perdido em silencio DEPOIS do cliente ja ter sido confirmado.
function validarPedidoIA(d) {
  const erros = [];
  if (!d || typeof d !== "object") return ["payload nao e objeto"];
  if (!Array.isArray(d.itens) || d.itens.length === 0) erros.push("sem itens");
  if (Array.isArray(d.itens) && d.itens.length > 50) erros.push("itens demais");
  if (!d.cliente || typeof d.cliente !== "string" || !d.cliente.trim()) erros.push("sem cliente");
  if (!d.endereco || typeof d.endereco !== "string" || !d.endereco.trim()) erros.push("sem endereco");
  for (const it of (Array.isArray(d.itens) ? d.itens : [])) {
    if (!it || typeof it.nome !== "string" || !it.nome.trim()) { erros.push("item sem nome"); break; }
    const q = Number(it.qty);
    if (it.qty !== undefined && (!Number.isFinite(q) || q <= 0)) { erros.push("qty invalida em " + it.nome); break; }
  }
  return erros;
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
  const meta = Math.max(1, Number(CONFIG.fidelidade.pedidosParaGanhar) || 1); // evita divisao por zero
  // Incremento atomico no banco — evita perder contagem em concorrencia e sobrevive a restart
  let f;
  try {
    const doc = await FidelidadeDB.findOneAndUpdate(
      { telefone: pedido.telefone },
      { $inc: { pedidosEntregues: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    f = { pedidosEntregues: doc.pedidosEntregues || 1, brindesGanhos: doc.brindesGanhos || 0 };
  } catch (e) {
    console.error("Erro ao incrementar fidelidade no DB, usando memoria:", e.message);
    f = getFidelidade(pedido.telefone);
    f.pedidosEntregues += 1;
  }
  fidelidadeClientes.set(pedido.telefone, f);

  if (f.pedidosEntregues % meta === 0) {
    f.brindesGanhos += 1;
    try { await FidelidadeDB.updateOne({ telefone: pedido.telefone }, { $inc: { brindesGanhos: 1 } }); }
    catch (e) { console.error("Erro ao registrar brinde:", e.message); }
    const msg = CONFIG.fidelidade.mensagemGanhou
      .replace(/{cliente}/g, pedido.cliente)
      .replace(/{total}/g, f.pedidosEntregues)
      .replace(/{brinde}/g, CONFIG.fidelidade.brinde);
    await enviarMsg(pedido.telefone, msg);
  }
}

// ── BAILEYS — CONECTAR WHATSAPP ───────────────────────────────
let conectandoWhatsApp = false;

async function conectarWhatsApp() {
  // Guarda contra sockets duplicados: reconexao concorrente (close emitido 2x,
  // ou logout + auto-reconnect) criava dois sockets vivos. Os dois handlers
  // processavam a MESMA mensagem do cliente -> duas chamadas a IA -> dois pedidos.
  if (conectandoWhatsApp) {
    console.warn("Conexao WhatsApp ja em andamento, ignorando chamada duplicada");
    return;
  }
  conectandoWhatsApp = true;
  try {
    // Encerra o socket anterior antes de abrir outro
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.end(undefined); } catch {}
      sock = null;
    }

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
      whatsappStatus = "disconnected";
      qrCodeBase64 = null;
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        // Teto de 60s: com 5min de espera o QR ficava indisponivel por minutos
        // seguidos e quem estava tentando parear via a tela vazia.
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000);
        console.log(`🔌 Conexão fechada. Reconectando em ${delay/1000}s (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => { conectarWhatsApp().catch(e => console.error("Falha na reconexao:", e.message)); }, delay);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error("❌ Máximo de tentativas de reconexão atingido. Reinicie o servidor.");
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      whatsappStatus = "connected";
      qrCodeBase64 = null;
      reconnectAttempts = 0; // reset no sucesso
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
          const novaAv = { pedidoId, telefone: tel, cliente: pedido?.cliente || tel, nota, horario: new Date().toISOString() };
            avaliacoes.push(novaAv);
            try { await AvaliacaoDB.create(novaAv); } catch (e) { console.error("Erro ao salvar avaliação:", e.message); }
          aguardandoAvaliacao.delete(tel);
          const agradecimento = CONFIG.avaliacao.mensagemObrigado.replace(/{cliente}/g, pedido?.cliente || "");
          await enviarMsg(tel, agradecimento);
          continue;
        }
        aguardandoAvaliacao.delete(tel);
      }

      try {
        addMsg(tel, "user", texto);
        const resposta = await chamarClaude(getHist(tel), tel);
        addMsg(tel, "assistant", resposta);

        const dadosPedido = extrairPedido(resposta);
        if (dadosPedido) {
          // ── Validação do JSON gerado pela IA ──
          // Antes: qualquer coisa que o modelo emitisse ia direto pro banco.
          const erros = validarPedidoIA(dadosPedido);
          if (erros.length) {
            console.error(`Pedido invalido de ${tel}:`, erros.join(" | "));
            await enviarMsg(tel, "😅 Tive um probleminha para registrar seu pedido. Pode confirmar os itens novamente, por favor?");
            continue;
          }

          // Reforça preços do cardápio (promocional se em modo evento).
          // Item fora do cardápio é rejeitado: antes mantinha o preço inventado pela IA.
          const itensValidados = [];
          for (const it of dadosPedido.itens) {
            const cardapioItem = CARDAPIO.find(c => c.nome.toLowerCase() === String(it.nome).toLowerCase());
            if (!cardapioItem) {
              console.error(`Item fora do cardapio recusado: "${it.nome}" (tel ${tel})`);
              await enviarMsg(tel, `😕 Não encontrei *${it.nome}* no cardápio. Pode conferir o pedido?`);
              itensValidados.length = 0;
              break;
            }
            itensValidados.push({
              nome: cardapioItem.nome,
              qty: Math.min(99, Math.max(1, Math.floor(Number(it.qty) || 1))),
              preco: precoAtual(cardapioItem),
              obs: typeof it.obs === "string" ? it.obs.slice(0, 120) : undefined,
            });
          }
          if (!itensValidados.length) continue;

          const subtotal = itensValidados.reduce((s, i) => s + i.qty * i.preco, 0);

          // Desconto só existe via cupom validado. Antes, o valor vinha direto da IA.
          let desconto = 0;
          let cupomAplicado = "";
          if (dadosPedido.cupom) {
            const r = aplicarCupom(subtotal, String(dadosPedido.cupom));
            if (r.erro) {
              await enviarMsg(tel, `😕 O cupom *${dadosPedido.cupom}* não pôde ser aplicado: ${r.erro}`);
            } else if (r.cupom) {
              desconto = Math.min(r.desconto || 0, subtotal); // nunca maior que o subtotal
              cupomAplicado = r.cupom.codigo;
            }
          }

          const taxa = Number(CONFIG.taxaEntrega) || 0;
          const total = Math.max(0, subtotal + taxa - desconto);
          const tempoPreparo = calcularTempoPreparo(itensValidados);

          // `id` DEPOIS do spread: antes, o JSON da IA podia sobrescrever o id
          // gerado pelo counter (colisão de chave única = pedido perdido).
          const pedido = {
            cliente:  String(dadosPedido.cliente).slice(0, 120),
            endereco: String(dadosPedido.endereco).slice(0, 250),
            obs:      typeof dadosPedido.obs === "string" ? dadosPedido.obs.slice(0, 250) : "",
            itens:    itensValidados,
            subtotal: parseFloat(subtotal.toFixed(2)),
            desconto: parseFloat(desconto.toFixed(2)),
            cupom:    cupomAplicado,
            total:    parseFloat(total.toFixed(2)),
            id:       String(counter++).padStart(5, "0"),
            telefone: tel,
            tempoPreparo,
            status:   "novo",
            horario:  new Date().toISOString(),
          };

          // Só confirma ao cliente DEPOIS de persistir. Antes, o cliente recebia
          // "pedido confirmado" e a cozinha nunca via o pedido se o create falhasse.
          const mongoOk = mongoose.connection.readyState === 1;
          if (mongoOk) {
            try {
              await PedidoDB.create(pedido);
            } catch (e) {
              console.error("FALHA AO SALVAR PEDIDO:", e.message, JSON.stringify(pedido));
              await enviarMsg(tel, "😔 Não consegui registrar seu pedido agora. Pode tentar de novo em instantes?");
              counter--; // devolve o numero para nao criar buraco na sequencia
              continue;
            }
          } else {
            console.warn("MongoDB offline — pedido salvo apenas em memoria:", pedido.id);
          }
          pedidos.push(pedido);

          // Incrementa o uso do cupom só depois do pedido existir de fato
          if (cupomAplicado) {
            const cupomMem = cupons.find(c => c.codigo === cupomAplicado);
            if (cupomMem) cupomMem.usoAtual = (cupomMem.usoAtual || 0) + 1;
            try { await CupomDB.updateOne({ codigo: cupomAplicado }, { $inc: { usoAtual: 1 } }); }
            catch (e) { console.error("Erro ao incrementar uso do cupom:", e.message); }
          }

          console.log(`📦 Pedido #${pedido.id} — ${pedido.cliente}`);
          await enviarMsg(tel, resposta);
          await enviarMsg(tel, `⏱️ Tempo estimado: *${tempoPreparo} minutos*`);
          if (CONFIG.fidelidade.ativo) {
            const f = await carregarFidelidade(tel);
            const meta = Math.max(1, Number(CONFIG.fidelidade.pedidosParaGanhar) || 1);
            const faltam = meta - (f.pedidosEntregues % meta);
            await enviarMsg(tel, `🏆 Fidelidade: ${f.pedidosEntregues} pedido${f.pedidosEntregues !== 1 ? "s" : ""} entregue${f.pedidosEntregues !== 1 ? "s" : ""}. Faltam *${faltam}* para ganhar ${CONFIG.fidelidade.brinde}!`);
          }
          continue;
        }
        await enviarMsg(tel, resposta);
      } catch (err) {
        console.error("Erro ao processar mensagem:", err.message);
        // Antes o cliente ficava sem NENHUMA resposta (mensagem entregue e silencio).
        // Se a ANTHROPIC_KEY expirasse, o bot ficava mudo sem ninguem perceber.
        try {
          await enviarMsg(tel, "😅 Tive uma instabilidade aqui. Pode mandar sua mensagem de novo, por favor?");
        } catch (e2) { console.error("Falha ao avisar cliente sobre o erro:", e2.message); }
        // Remove a ultima mensagem do historico para nao envenenar o contexto
        try { const h = getHist(tel); if (h.length && h[h.length - 1].role === "user") h.pop(); } catch {}
      }
    }
    });
  } finally {
    conectandoWhatsApp = false;
  }
}

// ── PÁGINA DO QR CODE ─────────────────────────────────────────
app.get("/qrcode", authMiddleware(["dono"]), (req, res) => {
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

// ── AUTH API ─────────────────────────────────────────────────
// Le os PINs de dono/caixa (env vars como base, ConfigDB sobrescreve)
// Mongoose enfileira comandos quando o banco esta fora e so desiste depois de
// 10s. Numa tela de login isso vira "erro de conexao" para quem esta no caixa.
// Perguntar o estado da conexao antes evita a espera.
function mongoPronto() {
  return mongoose.connection.readyState === 1;
}

async function getPinsAdmin() {
  let pins = { dono: process.env.PIN_DONO || "9999", caixa: process.env.PIN_CAIXA || "5678" };
  if (!mongoPronto()) return pins;   // banco fora: usa os PINs do .env na hora
  try {
    const cfg = await ConfigDB.findOne({ chave: "pins" });
    if (cfg?.valor) pins = { ...pins, ...cfg.valor };
  } catch (e) { console.error("Erro ao buscar pins do DB (usando env vars):", e.message); }
  return pins;
}

app.post("/auth/login", loginLimiter, async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ erro: "PIN deve ter 4 dígitos" });

  // Verifica PINs de dono/caixa primeiro (funciona mesmo sem MongoDB)
  const pins = await getPinsAdmin();

  if (pin === pins.dono) {
    const token = gerarToken({ role: "dono" });
    return res.json({ token, role: "dono" });
  }
  if (pin === pins.caixa) {
    const token = gerarToken({ role: "caixa" });
    return res.json({ token, role: "caixa" });
  }

  // Verifica garçom no banco
  if (!mongoPronto()) return res.status(503).json({ erro: "Banco de dados indisponível. Entre com o PIN do dono ou do caixa." });
  try {
    const garcom = await GarcomDB.findOne({ pin, ativo: true }).lean();
    if (garcom) {
      const token = gerarToken({ role: "garcom", nome: garcom.nome, id: garcom._id });
      return res.json({ token, role: "garcom", nome: garcom.nome, id: garcom._id });
    }
  } catch (e) { console.error("Erro ao buscar garçom:", e.message); }

  return res.status(401).json({ erro: "PIN incorreto" });
});

app.put("/auth/pins", authMiddleware(["dono"]), async (req, res) => {
  const { dono, caixa } = req.body;
  if (dono && !/^\d{4}$/.test(dono)) return res.status(400).json({ erro: "PIN do dono deve ter 4 dígitos" });
  if (caixa && !/^\d{4}$/.test(caixa)) return res.status(400).json({ erro: "PIN do caixa deve ter 4 dígitos" });
  try {
    const atual = await ConfigDB.findOne({ chave: "pins" });
    const pins = atual?.valor || {};
    if (dono) pins.dono = dono;
    if (caixa) pins.caixa = caixa;
    await ConfigDB.updateOne({ chave: "pins" }, { valor: pins }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PEDIDOS API ───────────────────────────────────────────────
app.get("/pedidos", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const lista = await PedidoDB.find().sort({ horario: -1 }).skip(skip).limit(parseInt(limit)).lean();
    res.json(lista);
  } catch (e) {
    console.error("Erro ao buscar pedidos:", e.message);
    res.json(pedidos);
  }
});

app.patch("/pedidos/:id/status", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!["novo","preparando","entrega","entregue","cancelado"].includes(status)) return res.status(400).json({ erro: "Status inválido" });
  let pedido = pedidos.find(p => p.id === id);
  try {
    const atualizado = await PedidoDB.findOneAndUpdate({ id }, { status }, { new: true }).lean();
    if (atualizado) pedido = atualizado;
  } catch (e) { console.error("Erro ao atualizar pedido:", e.message); }
  if (!pedido) return res.status(404).json({ erro: "Pedido não encontrado" });
  pedido.status = status;
  // Efeitos colaterais isolados: uma falha de WhatsApp nao pode derrubar o
  // processo nem impedir a resposta HTTP (o status ja foi gravado no banco).
  try { await enviarMsgStatus(pedido, status); }
  catch (e) { console.error("Falha ao enviar msg de status:", e.message); }
  if (status === "entregue") {
    try { await checarFidelidade(pedido); } catch (e) { console.error("Falha na fidelidade:", e.message); }
    try { agendarAvaliacao(pedido); } catch (e) { console.error("Falha ao agendar avaliacao:", e.message); }
  }
  if (status === "cancelado" && timersAvaliacao.has(id)) { clearTimeout(timersAvaliacao.get(id)); timersAvaliacao.delete(id); }
  res.json(pedido);
});

// ── EDITAR PEDIDO (itens) ─────────────────────────────────────
app.put("/pedidos/:id", authMiddleware(["dono", "caixa"]), async (req, res) => {
  const { id } = req.params;
  const { itens, obs } = req.body;
  if (!itens?.length) return res.status(400).json({ erro: "Itens são obrigatórios" });
  // Valida cada item
  for (const item of itens) {
    if (!item.nome || !item.preco || item.preco <= 0) return res.status(400).json({ erro: "Item inválido: nome e preço obrigatórios" });
    if (!item.qty || item.qty < 1) return res.status(400).json({ erro: `Quantidade inválida para ${item.nome}` });
  }
  try {
    // Atualização atômica — só permite se status for "novo" ou "preparando"
    const pedidoAtual = await PedidoDB.findOne({ id, status: { $in: ["novo", "preparando"] } }).lean();
    if (!pedidoAtual) return res.status(409).json({ erro: "Pedido não encontrado ou já avançou de status" });
    // Recalcula valores
    const subtotal = itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0);
    let desconto = 0;
    if (pedidoAtual.cupom) {
      const resultado = aplicarCupom(subtotal, pedidoAtual.cupom);
      desconto = resultado.desconto || 0;
    }
    const total = subtotal + CONFIG.taxaEntrega - desconto;
    const tempoPreparo = calcularTempoPreparo(itens);
    const update = {
      itens, subtotal: parseFloat(subtotal.toFixed(2)),
      desconto: parseFloat(desconto.toFixed(2)),
      total: parseFloat(total.toFixed(2)),
      tempoPreparo,
      obs: obs !== undefined ? obs : pedidoAtual.obs,
    };
    const atualizado = await PedidoDB.findOneAndUpdate(
      { id, status: { $in: ["novo", "preparando"] } },
      { $set: update },
      { new: true }
    ).lean();
    if (!atualizado) return res.status(409).json({ erro: "Pedido já avançou de status durante a edição" });
    // Atualiza memória
    const idx = pedidos.findIndex(p => p.id === id);
    if (idx !== -1) pedidos[idx] = { ...pedidos[idx], ...update };
    res.json(atualizado);
  } catch (e) {
    console.error("Erro ao editar pedido:", e.message);
    res.status(500).json({ erro: "Erro ao editar pedido" });
  }
});

// ── WHATSAPP STATUS API ───────────────────────────────────────
app.get("/whatsapp/status", authMiddleware(["dono", "caixa", "garcom"]), (req, res) => res.json({ status: whatsappStatus }));

// GET /whatsapp/qr — o QR em JSON, para o painel poder ficar consultando
app.get("/whatsapp/qr", authMiddleware(["dono"]), (req, res) => {
  res.json({ status: whatsappStatus, qr: whatsappStatus === "qr" ? qrCodeBase64 : null });
});

// POST /whatsapp/reconectar — zera o contador e abre uma conexao nova.
// Depois de 10 tentativas sem ninguem escanear, o Baileys desistia e so
// voltava com restart do servidor. Isso deixa o dono resolver pelo painel.
app.post("/whatsapp/reconectar", authMiddleware(["dono"]), async (req, res) => {
  if (whatsappStatus === "connected") {
    return res.status(409).json({ erro: "WhatsApp ja esta conectado. Desconecte antes de parear outro numero." });
  }
  reconnectAttempts = 0;
  qrCodeBase64 = null;
  whatsappStatus = "disconnected";
  conectarWhatsApp().catch(e => console.error("Falha ao reconectar sob demanda:", e.message));
  res.json({ ok: true, mensagem: "Gerando QR Code novo. Aguarde alguns segundos." });
});

app.post("/whatsapp/logout", authMiddleware(["dono"]), async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true });
    whatsappStatus = "disconnected";
    qrCodeBase64 = null;
    setTimeout(() => { conectarWhatsApp().catch(e => console.error("Falha ao reconectar apos logout:", e.message)); }, 2000);
    res.json({ ok: true, message: "Desconectado. Novo QR Code será gerado." });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── CUPONS API ────────────────────────────────────────────────
app.get("/cupons", authMiddleware(["dono"]), async (req, res) => { try { const lista = await CupomDB.find().lean(); res.json(lista); } catch (e) { console.error("Erro ao buscar cupons:", e.message); res.json(cupons); } });
app.post("/cupons", authMiddleware(["dono"]), async (req, res) => {
  const { codigo, tipo, valor, usoMax, validade, descricao } = req.body;
  if (!codigo || !tipo || valor === undefined) return res.status(400).json({ erro: "codigo, tipo e valor obrigatórios" });
  const novo = { codigo: codigo.toUpperCase(), tipo, valor: parseFloat(valor), ativo: true, usoMax: usoMax || null, usoAtual: 0, validade: validade || null, descricao: descricao || "" };
  try {
    const existe = await CupomDB.findOne({ codigo: novo.codigo });
    if (existe) return res.status(400).json({ erro: "Código já existe" });
    const criado = await CupomDB.create(novo);
    cupons.push(novo);
    res.status(201).json(criado);
  } catch { cupons.push(novo); res.status(201).json(novo); }
});
app.patch("/cupons/:codigo/ativo", authMiddleware(["dono"]), async (req, res) => {
  const codigo = req.params.codigo.toUpperCase();
  try { await CupomDB.updateOne({ codigo }, { ativo: req.body.ativo }); } catch (e) { console.error("Erro ao atualizar cupom:", e.message); }
  const cupom = cupons.find(c => c.codigo === codigo);
  if (cupom) cupom.ativo = req.body.ativo;
  res.json(cupom || { codigo, ativo: req.body.ativo });
});
app.delete("/cupons/:codigo", authMiddleware(["dono"]), async (req, res) => {
  const codigo = req.params.codigo.toUpperCase();
  try { await CupomDB.deleteOne({ codigo }); } catch (e) { console.error("Erro ao deletar cupom:", e.message); }
  const idx = cupons.findIndex(c => c.codigo === codigo);
  const removido = idx !== -1 ? cupons.splice(idx, 1)[0] : { codigo };
  res.json({ ok: true, removido });
});
app.post("/cupons/validar", authMiddleware(["dono"]), (req, res) => {
  const { codigo, subtotal } = req.body;
  if (typeof codigo !== "string" || !codigo.trim()) return res.status(400).json({ erro: "codigo invalido" });
  const sub = Number(subtotal);
  if (!Number.isFinite(sub) || sub < 0) return res.status(400).json({ erro: "subtotal invalido" });
  res.json(aplicarCupom(sub, codigo));
});

// ── AVALIAÇÕES API ────────────────────────────────────────────
app.get("/avaliacoes", authMiddleware(["dono"]), async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const lista = await AvaliacaoDB.find().sort({ horario: -1 }).skip(skip).limit(parseInt(limit)).lean();
    res.json(lista);
  } catch (e) { console.error("Erro ao buscar avaliações:", e.message); res.json(avaliacoes); }
});
app.get("/avaliacoes/resumo", authMiddleware(["dono"]), async (req, res) => {
  try {
    const lista = await AvaliacaoDB.find().lean();
    if (!lista.length) return res.json({ media: 0, total: 0, distribuicao: {} });
    const media = lista.reduce((s, a) => s + a.nota, 0) / lista.length;
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    lista.forEach(a => dist[a.nota]++);
    res.json({ media: parseFloat(media.toFixed(1)), total: lista.length, distribuicao: dist });
  } catch {
    if (!avaliacoes.length) return res.json({ media: 0, total: 0, distribuicao: {} });
    const media = avaliacoes.reduce((s, a) => s + a.nota, 0) / avaliacoes.length;
    res.json({ media: parseFloat(media.toFixed(1)), total: avaliacoes.length, distribuicao: {} });
  }
});

// ── FIDELIDADE API ────────────────────────────────────────────
app.get("/fidelidade", authMiddleware(["dono"]), async (req, res) => {
  try {
    const lista = await FidelidadeDB.find().lean();
    const result = await Promise.all(lista.map(async f => {
      const pedido = await PedidoDB.findOne({ telefone: f.telefone }).sort({ horario: -1 }).lean();
      return { ...f, cliente: pedido?.cliente || f.telefone };
    }));
    res.json(result);
  } catch {
    const lista = [...fidelidadeClientes.entries()].map(([tel, f]) => ({ telefone: tel, ...f }));
    res.json(lista);
  }
});

// ── CARDÁPIO API ──────────────────────────────────────────────
app.get("/cardapio", authMiddleware(["dono", "caixa", "garcom"]), (req, res) => res.json(CARDAPIO));
app.post("/cardapio", authMiddleware(["dono"]), async (req, res) => {
  const { categoria, nome, preco, tempoPreparo, obs } = req.body;
  if (!categoria || !nome || !preco) return res.status(400).json({ erro: "categoria, nome e preco obrigatórios" });
  const item = { id: nextItemId++, categoria, nome, preco: parseFloat(preco), tempoPreparo: parseInt(tempoPreparo) || 10, ativo: true, obs: obs || null };
  try { await CardapioDB.create(item); } catch (e) { console.error("Erro ao criar item no cardápio:", e.message); }
  CARDAPIO.push(item);
  res.status(201).json(item);
});
app.put("/cardapio/:id", authMiddleware(["dono"]), async (req, res) => {
  const id = parseInt(req.params.id);
  const idx = CARDAPIO.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ erro: "Item não encontrado" });
  // Apenas campos permitidos
  const allowed = ["categoria", "nome", "preco", "precoPromocional", "tempoPreparo", "ativo", "obs", "fiscal"];
  const update = {};
  for (const key of allowed) { if (req.body[key] !== undefined) update[key] = req.body[key]; }
  if (update.preco !== undefined) update.preco = parseFloat(update.preco);
  if (update.precoPromocional !== undefined && update.precoPromocional !== null) update.precoPromocional = parseFloat(update.precoPromocional);
  if (update.tempoPreparo !== undefined) update.tempoPreparo = parseInt(update.tempoPreparo);
  if (update.fiscal !== undefined) {
    const f = update.fiscal && typeof update.fiscal === "object" ? update.fiscal : {};
    update.fiscal = {
      ncm:     typeof f.ncm     === "string" ? f.ncm.trim()     : "",
      cfop:    typeof f.cfop    === "string" ? f.cfop.trim()    : "",
      csosn:   typeof f.csosn   === "string" ? f.csosn.trim()   : "",
      cest:    typeof f.cest    === "string" ? f.cest.trim()    : "",
      origem:  typeof f.origem  === "string" ? f.origem.trim()  : "0",
      unidade: typeof f.unidade === "string" ? f.unidade.trim() : "UN",
    };
  }
  CARDAPIO[idx] = { ...CARDAPIO[idx], ...update, id };
  try { await CardapioDB.updateOne({ id }, { $set: update }); } catch (e) { console.error("Erro ao atualizar cardápio:", e.message); }
  res.json(CARDAPIO[idx]);
});
app.patch("/cardapio/:id/ativo", authMiddleware(["dono"]), async (req, res) => {
  const id = parseInt(req.params.id);
  const item = CARDAPIO.find(i => i.id === id);
  if (!item) return res.status(404).json({ erro: "Item não encontrado" });
  item.ativo = req.body.ativo;
  try { await CardapioDB.updateOne({ id }, { ativo: req.body.ativo }); } catch (e) { console.error("Erro ao toggle cardápio:", e.message); }
  res.json(item);
});
app.delete("/cardapio/:id", authMiddleware(["dono"]), async (req, res) => {
  const id = parseInt(req.params.id);
  const idx = CARDAPIO.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ erro: "Item não encontrado" });
  const [removido] = CARDAPIO.splice(idx, 1);
  try { await CardapioDB.deleteOne({ id }); } catch (e) { console.error("Erro ao deletar item cardápio:", e.message); }
  res.json({ ok: true, removido });
});

// ── CONFIG API ────────────────────────────────────────────────
app.get("/config", authMiddleware(["dono", "caixa", "garcom"]), (req, res) => res.json(CONFIG));
async function salvarConfig() { try { await ConfigDB.updateOne({ chave: "config" }, { valor: CONFIG }, { upsert: true }); } catch (e) { console.error("Erro ao salvar config:", e.message); } }
// ── Validadores de config ────────────────────────────────────
function numOr(valor, atual, { min = 0, max = Infinity } = {}) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) return atual; // mantem o valor antigo se invalido
  return n;
}

const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function sanearHorario(entrada, atual) {
  const out = { ...atual };
  for (const [dia, h] of Object.entries(entrada || {})) {
    if (!/^[0-6]$/.test(String(dia)) || !h || typeof h !== "object") continue;
    const base = atual?.[dia] || { aberto: false, abertura: "18:00", fechamento: "23:00" };
    out[dia] = {
      aberto: h.aberto === true || h.aberto === "true",
      abertura:   HORA_RE.test(h.abertura)   ? h.abertura   : base.abertura,
      fechamento: HORA_RE.test(h.fechamento) ? h.fechamento : base.fechamento,
    };
  }
  return out;
}

app.put("/config", authMiddleware(["dono"]), async (req, res) => {
  const b = req.body || {};
  const novo = { ...CONFIG };

  // Campos simples
  if (typeof b.nomeEstabelecimento === "string") novo.nomeEstabelecimento = b.nomeEstabelecimento.slice(0, 120);
  if (typeof b.nomeAgente === "string")          novo.nomeAgente          = b.nomeAgente.slice(0, 60);

  // Numericos — invalido mantem o valor anterior (evita NaN quebrando o bot)
  if (b.taxaEntrega      !== undefined) novo.taxaEntrega      = numOr(b.taxaEntrega,      CONFIG.taxaEntrega,      { max: 999 });
  if (b.tempoEntregaMin  !== undefined) novo.tempoEntregaMin  = numOr(b.tempoEntregaMin,  CONFIG.tempoEntregaMin,  { min: 1, max: 600 });
  if (b.tempoEntregaMax  !== undefined) novo.tempoEntregaMax  = numOr(b.tempoEntregaMax,  CONFIG.tempoEntregaMax,  { min: 1, max: 600 });

  if (b.entregaCEP && typeof b.entregaCEP === "object") {
    novo.entregaCEP = { ...CONFIG.entregaCEP, ...b.entregaCEP };
  }

  // Blocos que antes eram DESCARTADOS silenciosamente
  if (b.horarioFuncionamento && typeof b.horarioFuncionamento === "object") {
    novo.horarioFuncionamento = sanearHorario(b.horarioFuncionamento, CONFIG.horarioFuncionamento);
  }

  if (b.mensagensAutomaticas && typeof b.mensagensAutomaticas === "object") {
    novo.mensagensAutomaticas = { ...CONFIG.mensagensAutomaticas, ...b.mensagensAutomaticas };
    novo.mensagensAutomaticas.ativo = b.mensagensAutomaticas.ativo !== false;
  }

  if (b.fidelidade && typeof b.fidelidade === "object") {
    novo.fidelidade = { ...CONFIG.fidelidade, ...b.fidelidade };
    novo.fidelidade.ativo = b.fidelidade.ativo !== false;
    // min 1: zero causava divisao por zero -> "Faltam NaN para ganhar"
    novo.fidelidade.pedidosParaGanhar = numOr(b.fidelidade.pedidosParaGanhar, CONFIG.fidelidade.pedidosParaGanhar, { min: 1, max: 999 });
  }

  if (b.avaliacao && typeof b.avaliacao === "object") {
    novo.avaliacao = { ...CONFIG.avaliacao, ...b.avaliacao };
    novo.avaliacao.ativo = b.avaliacao.ativo !== false;
    // max 1440 (24h): acima de ~24.8 dias estoura o int32 do setTimeout e dispara na hora
    novo.avaliacao.delayMinutos = numOr(b.avaliacao.delayMinutos, CONFIG.avaliacao.delayMinutos, { min: 1, max: 1440 });
  }

  if (b.modoEvento && typeof b.modoEvento === "object") {
    novo.modoEvento = { ...CONFIG.modoEvento, ...b.modoEvento };
    novo.modoEvento.ativo    = b.modoEvento.ativo === true    || b.modoEvento.ativo === "true";
    novo.modoEvento.agendado = b.modoEvento.agendado === true || b.modoEvento.agendado === "true";
  }

  CONFIG = novo;
  await salvarConfig();
  res.json(CONFIG);
});
app.put("/config/horario", authMiddleware(["dono"]), async (req, res) => { CONFIG.horarioFuncionamento = { ...CONFIG.horarioFuncionamento, ...req.body }; await salvarConfig(); res.json(CONFIG.horarioFuncionamento); });
app.put("/config/mensagens", authMiddleware(["dono"]), async (req, res) => { CONFIG.mensagensAutomaticas = { ...CONFIG.mensagensAutomaticas, ...req.body }; await salvarConfig(); res.json(CONFIG.mensagensAutomaticas); });
app.put("/config/fidelidade", authMiddleware(["dono"]), async (req, res) => { CONFIG.fidelidade = { ...CONFIG.fidelidade, ...req.body }; await salvarConfig(); res.json(CONFIG.fidelidade); });
app.put("/config/avaliacao", authMiddleware(["dono"]), async (req, res) => { CONFIG.avaliacao = { ...CONFIG.avaliacao, ...req.body }; await salvarConfig(); res.json(CONFIG.avaliacao); });
app.get("/config/status-loja", (req, res) => res.json({ aberto: estaAberto(), proximaAbertura: proximaAbertura() }));

// ── MODO EVENTO (preços promocionais durante eventos) ────────
app.get("/modo-evento", authMiddleware(["dono", "caixa", "garcom"]), (req, res) => {
  res.json({ ...CONFIG.modoEvento, ativoAgora: estaEmModoEvento() });
});
app.put("/modo-evento", authMiddleware(["dono"]), async (req, res) => {
  const { ativo, nome, agendado, inicio, fim, mensagemWhats } = req.body;
  CONFIG.modoEvento = {
    ativo: ativo !== undefined ? !!ativo : CONFIG.modoEvento?.ativo,
    nome: nome !== undefined ? nome : CONFIG.modoEvento?.nome,
    agendado: agendado !== undefined ? !!agendado : CONFIG.modoEvento?.agendado,
    inicio: inicio !== undefined ? inicio : CONFIG.modoEvento?.inicio,
    fim: fim !== undefined ? fim : CONFIG.modoEvento?.fim,
    mensagemWhats: mensagemWhats !== undefined ? mensagemWhats : CONFIG.modoEvento?.mensagemWhats,
  };
  await salvarConfig();
  res.json({ ...CONFIG.modoEvento, ativoAgora: estaEmModoEvento() });
});

// Atualizar preço promocional de um item
app.patch("/cardapio/:id/preco-promocional", authMiddleware(["dono"]), async (req, res) => {
  const id = parseInt(req.params.id);
  const { precoPromocional } = req.body;
  const item = CARDAPIO.find(i => i.id === id);
  if (!item) return res.status(404).json({ erro: "Item não encontrado" });
  const valor = precoPromocional === null || precoPromocional === "" ? null : parseFloat(precoPromocional);
  if (valor !== null && (isNaN(valor) || valor < 0)) return res.status(400).json({ erro: "Preço promocional inválido" });
  item.precoPromocional = valor;
  try { await CardapioDB.updateOne({ id }, { $set: { precoPromocional: valor } }); }
  catch (e) { console.error("Erro ao atualizar preço promocional:", e.message); }
  res.json(item);
});

// ── VENDAS SALÃO API ─────────────────────────────────────────
app.get("/vendas-salao", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  try {
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const lista = await VendaSalaoDB.find({ fechamento: { $gte: hoje } }).sort({ fechamento: -1 }).lean();
    res.json(lista);
  } catch { res.json([]); }
});
// Confere que subtotal - desconto = total. Sem isso da para mandar um total
// menor que os itens e o faturamento do dia nao fecha com a comanda.
function normalizarDesconto(body) {
  const total = Number(body.total) || 0;
  const subtotal = Number(body.subtotal) > 0 ? Number(body.subtotal) : total;
  const desconto = Number(body.desconto) || 0;

  if (desconto < 0) return { erro: "Desconto negativo" };
  if (desconto > subtotal) return { erro: "Desconto maior que o valor da comanda" };
  if (Math.abs((subtotal - desconto) - total) > 0.02) {
    return { erro: "Subtotal (R$ " + subtotal.toFixed(2) + ") menos desconto (R$ " + desconto.toFixed(2) +
                   ") nao bate com o total (R$ " + total.toFixed(2) + ")" };
  }
  const tipos = ["percentual", "valor", "total"];
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    desconto: parseFloat(desconto.toFixed(2)),
    descontoTipo: desconto > 0 && tipos.includes(body.descontoTipo) ? body.descontoTipo : "",
    descontoInfo: desconto > 0 ? String(body.descontoInfo || "").slice(0, 60) : "",
  };
}

const FORMAS_PAGAMENTO = ["pix", "cartao", "dinheiro"];

// Aceita o formato antigo (pagamento: "pix") e o novo (pagamentos: [{tipo, valor}]).
// Devolve { pagamento, pagamentos } ou { erro }.
function normalizarPagamento(body) {
  const total = Number(body.total) || 0;
  const lista = Array.isArray(body.pagamentos) ? body.pagamentos : null;

  if (!lista || !lista.length) {
    if (!FORMAS_PAGAMENTO.includes(body.pagamento)) return { erro: "Forma de pagamento invalida" };
    return { pagamento: body.pagamento, pagamentos: [{ tipo: body.pagamento, valor: parseFloat(total.toFixed(2)) }] };
  }

  const limpa = [];
  for (const p of lista) {
    if (!FORMAS_PAGAMENTO.includes(p?.tipo)) return { erro: "Forma de pagamento invalida: " + p?.tipo };
    const v = Number(p.valor);
    if (!Number.isFinite(v) || v <= 0) return { erro: "Valor invalido no pagamento em " + p.tipo };
    limpa.push({ tipo: p.tipo, valor: parseFloat(v.toFixed(2)) });
  }

  // Tolerancia de 2 centavos: divisao por 3 nao fecha exato
  const soma = limpa.reduce((acc, p) => acc + p.valor, 0);
  if (Math.abs(soma - total) > 0.02) {
    return { erro: "A soma dos pagamentos (R$ " + soma.toFixed(2) + ") nao bate com o total (R$ " + total.toFixed(2) + ")" };
  }

  // Dois lancamentos na mesma forma viram um
  const agrupado = [];
  for (const p of limpa) {
    const ex = agrupado.find(x => x.tipo === p.tipo);
    if (ex) ex.valor = parseFloat((ex.valor + p.valor).toFixed(2));
    else agrupado.push({ ...p });
  }
  return { pagamento: agrupado.length === 1 ? agrupado[0].tipo : "misto", pagamentos: agrupado };
}

app.post("/vendas-salao", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  const { itens, total } = req.body;
  if (!itens?.length) return res.status(400).json({ erro: "Itens são obrigatórios" });
  if (!total || total <= 0) return res.status(400).json({ erro: "Total inválido" });

  const desc = normalizarDesconto(req.body);
  if (desc.erro) return res.status(400).json({ erro: desc.erro });

  const pag = normalizarPagamento(req.body);
  if (pag.erro) return res.status(400).json({ erro: pag.erro });

  try {
    const venda = await VendaSalaoDB.create({
      ...req.body, ...desc,
      pagamento: pag.pagamento, pagamentos: pag.pagamentos,
    });
    // Baixa automática no estoque
    await baixarEstoqueVenda(req.body.itens, String(venda._id));
    res.status(201).json(venda);
  }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.delete("/vendas-salao/:id", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try { await VendaSalaoDB.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get("/vendas-salao/historico", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const { de, ate } = req.query;
    const filtro = {};
    if (de) filtro.fechamento = { $gte: new Date(de) };
    if (ate) filtro.fechamento = { ...filtro.fechamento, $lte: new Date(ate) };
    const lista = await VendaSalaoDB.find(filtro).sort({ fechamento: -1 }).lean();
    res.json(lista);
  } catch { res.json([]); }
});

// ── ESTOQUE — BAIXA AUTOMÁTICA ────────────────────────────────
async function baixarEstoqueVenda(itens, vendaId) {
  if (!itens?.length) return;
  try {
    const estoques = await EstoqueDB.find({ ativo: true }).lean();
    for (const item of itens) {
      const qty = item.qty || 1;
      // Encontra estoque vinculado a este item do cardápio
      const est = estoques.find(e =>
        e.cardapioNomes.some(n => n.toLowerCase() === item.nome?.toLowerCase())
      );
      if (!est) continue;
      const desconto = qty * (est.consumoPorVenda || 1);
      const novaQtd = Math.max(0, est.quantidade - desconto);
      await EstoqueDB.findByIdAndUpdate(est._id, { quantidade: novaQtd });
      await MovEstoqueDB.create({
        estoqueId: est._id, estoqueNome: est.nome,
        tipo: "saida", quantidade: desconto,
        motivo: "venda", vendaId,
      });
      // Alerta de estoque mínimo
      if (novaQtd <= est.minimo && !est.alertaEnviado) {
        await EstoqueDB.findByIdAndUpdate(est._id, { alertaEnviado: true });
        const unid = est.tipo === "chopp" ? "litros" : est.unidade;
        const msg = `⚠️ *Estoque Baixo — Império dos Espetos*\n\n` +
          `📦 *${est.nome}*\n` +
          `Quantidade atual: *${novaQtd.toFixed(est.tipo === "chopp" ? 1 : 0)} ${unid}*\n` +
          `Estoque mínimo: *${est.minimo} ${unid}*\n\n` +
          `Por favor, verifique o estoque! 🚨`;
        if (est.alertaTelefone) await enviarMsg(est.alertaTelefone, msg);
      }
      // Reseta flag de alerta quando estoque é reposto acima do mínimo
      if (novaQtd > est.minimo && est.alertaEnviado) {
        await EstoqueDB.findByIdAndUpdate(est._id, { alertaEnviado: false });
      }
    }
  } catch (e) { console.error("Erro na baixa de estoque:", e.message); }
}

// ── ESTOQUE API ───────────────────────────────────────────────
app.get("/estoque", authMiddleware(["dono"]), async (req, res) => {
  try {
    const lista = await EstoqueDB.find({ ativo: true }).sort({ nome: 1 }).lean();
    res.json(lista);
  } catch { res.json([]); }
});

app.post("/estoque", authMiddleware(["dono"]), async (req, res) => {
  const { nome, unidade, quantidade, minimo, cardapioNomes, consumoPorVenda, tipo, capacidadeBarril, alertaTelefone } = req.body;
  if (!nome) return res.status(400).json({ erro: "nome é obrigatório" });
  try {
    const item = await EstoqueDB.create({
      nome, unidade: unidade || "un",
      quantidade: parseFloat(quantidade) || 0,
      minimo: parseFloat(minimo) || 0,
      cardapioNomes: cardapioNomes || [],
      consumoPorVenda: parseFloat(consumoPorVenda) || 1,
      tipo: tipo || "normal",
      capacidadeBarril: parseFloat(capacidadeBarril) || 0,
      alertaTelefone: alertaTelefone || "",
      ativo: true,
    });
    res.status(201).json(item);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir movimentação (deve vir ANTES das rotas com :id para não conflitar)
app.delete("/estoque/movimentacoes/:movId", authMiddleware(["dono"]), async (req, res) => {
  try {
    const mov = await MovEstoqueDB.findById(req.params.movId).lean();
    if (!mov) return res.status(404).json({ erro: "Movimentação não encontrada" });
    const estorno = mov.tipo === "entrada" ? -mov.quantidade
                  : mov.tipo === "saida"   ?  Math.abs(mov.quantidade)
                  : -mov.quantidade;
    const est = await EstoqueDB.findById(mov.estoqueId);
    if (est) {
      await EstoqueDB.findByIdAndUpdate(est._id, {
        quantidade: Math.max(0, est.quantidade + estorno),
        alertaEnviado: false,
      });
    }
    await MovEstoqueDB.findByIdAndDelete(req.params.movId);
    res.json({ ok: true, estorno });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Relatório geral de consumo (deve vir ANTES de :id para não conflitar)
app.get("/estoque/relatorio/consumo", authMiddleware(["dono"]), async (req, res) => {
  try {
    const { de, ate } = req.query;
    const filtro = { tipo: "saida" };
    if (de || ate) {
      filtro.horario = {};
      if (de) filtro.horario.$gte = new Date(de);
      if (ate) filtro.horario.$lte = new Date(ate);
    }
    const movs = await MovEstoqueDB.find(filtro).sort({ horario: -1 }).lean();
    const porItem = {};
    movs.forEach(m => {
      if (!porItem[m.estoqueNome]) porItem[m.estoqueNome] = { nome: m.estoqueNome, total: 0, movs: 0 };
      porItem[m.estoqueNome].total += Math.abs(m.quantidade);
      porItem[m.estoqueNome].movs += 1;
    });
    res.json(Object.values(porItem).sort((a, b) => b.total - a.total));
  } catch { res.json([]); }
});

app.put("/estoque/:id", authMiddleware(["dono"]), async (req, res) => {
  try {
    const item = await EstoqueDB.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!item) return res.status(404).json({ erro: "Item não encontrado" });
    res.json(item);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete("/estoque/:id", authMiddleware(["dono"]), async (req, res) => {
  try {
    await EstoqueDB.findByIdAndUpdate(req.params.id, { ativo: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Entrada de mercadoria
app.post("/estoque/:id/entrada", authMiddleware(["dono"]), async (req, res) => {
  const { quantidade, motivo } = req.body;
  if (!quantidade || quantidade <= 0) return res.status(400).json({ erro: "quantidade inválida" });
  try {
    const est = await EstoqueDB.findById(req.params.id);
    if (!est) return res.status(404).json({ erro: "Item não encontrado" });
    const novaQtd = est.quantidade + parseFloat(quantidade);
    await EstoqueDB.findByIdAndUpdate(est._id, {
      quantidade: novaQtd,
      alertaEnviado: novaQtd > est.minimo ? false : est.alertaEnviado,
    });
    await MovEstoqueDB.create({
      estoqueId: est._id, estoqueNome: est.nome,
      tipo: "entrada", quantidade: parseFloat(quantidade),
      motivo: motivo || "entrada mercadoria",
    });
    res.json({ quantidade: novaQtd });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Ajuste manual (inventário)
app.post("/estoque/:id/ajuste", authMiddleware(["dono"]), async (req, res) => {
  const { quantidade, motivo } = req.body;
  if (quantidade === undefined) return res.status(400).json({ erro: "quantidade obrigatória" });
  try {
    const est = await EstoqueDB.findById(req.params.id);
    if (!est) return res.status(404).json({ erro: "Item não encontrado" });
    const diff = parseFloat(quantidade) - est.quantidade;
    await EstoqueDB.findByIdAndUpdate(est._id, {
      quantidade: parseFloat(quantidade),
      alertaEnviado: parseFloat(quantidade) > est.minimo ? false : est.alertaEnviado,
    });
    await MovEstoqueDB.create({
      estoqueId: est._id, estoqueNome: est.nome,
      tipo: "ajuste", quantidade: diff,
      motivo: motivo || "ajuste manual",
    });
    res.json({ quantidade: parseFloat(quantidade) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Movimentações / histórico
app.get("/estoque/:id/movimentacoes", authMiddleware(["dono"]), async (req, res) => {
  try {
    const lista = await MovEstoqueDB.find({ estoqueId: req.params.id })
      .sort({ horario: -1 }).limit(100).lean();
    res.json(lista);
  } catch { res.json([]); }
});

// ── LUCRO API ─────────────────────────────────────────────────
// Calcula lucro cruzando vendas com custo cadastrado no estoque
app.get("/relatorio/lucro", authMiddleware(["dono"]), async (req, res) => {
  try {
    const { de, ate } = req.query;
    const filtro = {};
    if (de) filtro.fechamento = { $gte: new Date(de) };
    if (ate) filtro.fechamento = { ...(filtro.fechamento||{}), $lte: new Date(ate) };

    const [vendas, estoques] = await Promise.all([
      VendaSalaoDB.find(filtro).lean(),
      EstoqueDB.find({ ativo: true }).lean(),
    ]);

    // Mapeia nome do item → custo por unidade vendida
    const custoMap = {};
    estoques.forEach(e => {
      (e.cardapioNomes||[]).forEach(nome => {
        custoMap[nome.toLowerCase()] = {
          custo: (e.custoPorUnidade||0) * (e.consumoPorVenda||1),
          estoqueNome: e.nome,
        };
      });
    });

    let faturamento = 0, custoTotal = 0, semCusto = [];
    const porDia = {}; // "YYYY-MM-DD" → { faturamento, custo, lucro }
    const porItem = {}; // nome → { qty, faturamento, custo, lucro }

    vendas.forEach(v => {
      const dia = new Date(v.fechamento).toISOString().slice(0,10);
      if (!porDia[dia]) porDia[dia] = { faturamento:0, custo:0, lucro:0 };

      (v.itens||[]).forEach(it => {
        const qty = it.qty || 1;
        const receita = it.preco * qty;
        const custoInfo = custoMap[it.nome?.toLowerCase()];
        const custo = custoInfo ? custoInfo.custo * qty : 0;
        const lucro = receita - custo;

        faturamento += receita;
        custoTotal += custo;
        porDia[dia].faturamento += receita;
        porDia[dia].custo += custo;
        porDia[dia].lucro += lucro;

        if (!custoInfo && !semCusto.includes(it.nome)) semCusto.push(it.nome);

        if (!porItem[it.nome]) porItem[it.nome] = { nome:it.nome, qty:0, faturamento:0, custo:0, lucro:0, temCusto:!!custoInfo };
        porItem[it.nome].qty += qty;
        porItem[it.nome].faturamento += receita;
        porItem[it.nome].custo += custo;
        porItem[it.nome].lucro += lucro;
      });
    });

    const lucroTotal = faturamento - custoTotal;
    const margem = faturamento > 0 ? (lucroTotal / faturamento) * 100 : 0;

    res.json({
      faturamento: parseFloat(faturamento.toFixed(2)),
      custoTotal:  parseFloat(custoTotal.toFixed(2)),
      lucroTotal:  parseFloat(lucroTotal.toFixed(2)),
      margem:      parseFloat(margem.toFixed(1)),
      porDia: Object.entries(porDia)
        .map(([dia, d]) => ({ dia, ...d, lucro: parseFloat(d.lucro.toFixed(2)), faturamento: parseFloat(d.faturamento.toFixed(2)), custo: parseFloat(d.custo.toFixed(2)) }))
        .sort((a,b) => a.dia.localeCompare(b.dia)),
      porItem: Object.values(porItem)
        .map(i => ({ ...i, faturamento:parseFloat(i.faturamento.toFixed(2)), custo:parseFloat(i.custo.toFixed(2)), lucro:parseFloat(i.lucro.toFixed(2)) }))
        .sort((a,b) => b.lucro - a.lucro),
      semCusto,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── GARÇONS API ───────────────────────────────────────────────
app.get("/garcons", authMiddleware(["dono"]), async (req, res) => {
  try {
    const lista = await GarcomDB.find().lean();
    res.json(lista.map(g => ({ ...g, pin: undefined }))); // nunca expõe o PIN
  } catch { res.json([]); }
});

app.post("/garcons", authMiddleware(["dono"]), async (req, res) => {
  const { nome, pin } = req.body;
  if (!nome || !pin) return res.status(400).json({ erro: "nome e pin são obrigatórios" });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ erro: "PIN deve ter exatamente 4 dígitos" });
  try {
    // Impede escalacao de privilegio: garcom com PIN de dono/caixa logaria como admin
    const pinsAdmin = await getPinsAdmin();
    if (pin === pinsAdmin.dono || pin === pinsAdmin.caixa) {
      return res.status(400).json({ erro: "Esse PIN esta reservado para dono/caixa. Escolha outro." });
    }
    const existe = await GarcomDB.findOne({ pin });
    if (existe) return res.status(400).json({ erro: "Esse PIN já está em uso por outro garçom" });
    const garcom = await GarcomDB.create({ nome: nome.trim(), pin, ativo: true });
    const obj = garcom.toObject(); delete obj.pin;
    res.status(201).json(obj);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put("/garcons/:id", authMiddleware(["dono"]), async (req, res) => {
  const { nome, pin, ativo } = req.body;
  const update = {};
  if (nome) update.nome = nome.trim();
  // Coerce explicito: a string "false" vinda do JSON gravava true no boolean
  if (ativo !== undefined) update.ativo = (ativo === true || ativo === "true");
  try {
    if (pin) {
      if (!/^\d{4}$/.test(pin)) return res.status(400).json({ erro: "PIN inválido" });
      // Impede escalacao de privilegio via troca de PIN
      const pinsAdmin = await getPinsAdmin();
      if (pin === pinsAdmin.dono || pin === pinsAdmin.caixa) {
        return res.status(400).json({ erro: "Esse PIN esta reservado para dono/caixa. Escolha outro." });
      }
      const existe = await GarcomDB.findOne({ pin, _id: { $ne: req.params.id } });
      if (existe) return res.status(400).json({ erro: "PIN já em uso" });
      update.pin = pin;
    }
    const g = await GarcomDB.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!g) return res.status(404).json({ erro: "Garçom não encontrado" });
    const obj = { ...g }; delete obj.pin;
    res.json(obj);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete("/garcons/:id", authMiddleware(["dono"]), async (req, res) => {
  try { await GarcomDB.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Relatório de desempenho por garçom
app.get("/garcons/relatorio", authMiddleware(["dono"]), async (req, res) => {
  try {
    const { de, ate } = req.query;
    const filtro = {};
    if (de) filtro.fechamento = { $gte: new Date(de) };
    if (ate) filtro.fechamento = { ...(filtro.fechamento || {}), $lte: new Date(ate) };

    const vendas = await VendaSalaoDB.find(filtro).lean();
    const porGarcom = {};

    vendas.forEach(v => {
      const nome = v.garcom && v.garcom !== "—" ? v.garcom : null;
      if (!nome) return;
      if (!porGarcom[nome]) porGarcom[nome] = { nome, vendas: 0, total: 0, mesas: new Set(), itens: {} };
      porGarcom[nome].vendas += 1;
      porGarcom[nome].total += v.total || 0;
      porGarcom[nome].mesas.add(v.mesa);
      (v.itens || []).forEach(it => {
        porGarcom[nome].itens[it.nome] = (porGarcom[nome].itens[it.nome] || 0) + (it.qty || 1);
      });
    });

    const resultado = Object.values(porGarcom).map(g => ({
      nome: g.nome,
      vendas: g.vendas,
      total: parseFloat(g.total.toFixed(2)),
      mesas: g.mesas.size,
      ticketMedio: g.vendas > 0 ? parseFloat((g.total / g.vendas).toFixed(2)) : 0,
      itemMaisVendido: Object.entries(g.itens).sort((a,b)=>b[1]-a[1])[0]?.[0] || "—",
    })).sort((a,b) => b.total - a.total);

    res.json(resultado);
  } catch (e) { res.json([]); }
});

// ── FECHAMENTO DO DIA API ─────────────────────────────────────
app.post("/fechamento-dia", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const { obs, criadoPor } = req.body;
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
    const dataStr = hoje.toISOString().slice(0, 10);

    // Verifica se já foi feito fechamento hoje
    const jaFez = await FechamentoDB.findOne({ dataStr });
    if (jaFez) return res.status(400).json({ erro: "Fechamento do dia já realizado hoje.", fechamento: jaFez });

    // Pedidos delivery entregues hoje
    const pedidosHoje = await PedidoDB.find({ status: "entregue", horario: { $gte: hoje, $lt: amanha } }).lean();
    const totalDelivery = pedidosHoje.reduce((s, p) => s + (p.total || 0), 0);

    // Vendas salão hoje
    const vendasHoje = await VendaSalaoDB.find({ fechamento: { $gte: hoje, $lt: amanha } }).lean();
    const totalSalao = vendasHoje.reduce((s, v) => s + (v.total || 0), 0);

    // Por forma de pagamento
    // Comanda dividida entra em cada forma pelo valor que coube a ela
    const porPagamento = { pix: 0, cartao: 0, dinheiro: 0 };
    vendasHoje.forEach(v => {
      const partes = Array.isArray(v.pagamentos) && v.pagamentos.length
        ? v.pagamentos
        : [{ tipo: v.pagamento || "dinheiro", valor: v.total || 0 }];
      partes.forEach(p => {
        if (!FORMAS_PAGAMENTO.includes(p.tipo)) return;
        porPagamento[p.tipo] += Number(p.valor) || 0;
      });
    });

    // Por garçom
    const gMap = {};
    vendasHoje.forEach(v => {
      const g = v.garcom && v.garcom !== "—" ? v.garcom : "Sem garçom";
      if (!gMap[g]) gMap[g] = { nome: g, vendas: 0, total: 0 };
      gMap[g].vendas += 1;
      gMap[g].total += v.total || 0;
    });
    const porGarcom = Object.values(gMap).sort((a, b) => b.total - a.total);

    const fechamento = await FechamentoDB.create({
      data: new Date(), dataStr,
      totalDelivery: parseFloat(totalDelivery.toFixed(2)),
      totalSalao: parseFloat(totalSalao.toFixed(2)),
      totalGeral: parseFloat((totalDelivery + totalSalao).toFixed(2)),
      pedidosDelivery: pedidosHoje.length,
      vendasSalao: vendasHoje.length,
      porPagamento: {
        pix: parseFloat(porPagamento.pix.toFixed(2)),
        cartao: parseFloat(porPagamento.cartao.toFixed(2)),
        dinheiro: parseFloat(porPagamento.dinheiro.toFixed(2)),
      },
      porGarcom,
      obs: obs || "",
      criadoPor: criadoPor || "admin",
    });

    res.status(201).json(fechamento);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get("/fechamento-dia", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const lista = await FechamentoDB.find().sort({ data: -1 }).limit(90).lean();
    res.json(lista);
  } catch { res.json([]); }
});

app.get("/fechamento-dia/:dataStr", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const f = await FechamentoDB.findOne({ dataStr: req.params.dataStr }).lean();
    if (!f) return res.status(404).json({ erro: "Fechamento não encontrado" });
    res.json(f);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});




// ── CÓDIGO IBGE DOS MUNICÍPIOS ────────────────────────────────
// Busca na API pública do IBGE em vez de manter tabela fixa no código.
// Tabela digitada à mão erra: num projeto anterior, "IBAITI" estava
// mapeado para 4109609, que é Guaratuba — a SEFAZ rejeitaria a nota.

const cacheMunicipios = new Map();   // uf -> { lista, buscadoEm }
const CACHE_MUNICIPIOS_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

// Remove acentos e normaliza para comparar "sao jose" com "São José"
function normalizarTexto(t) {
  return String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

async function listarMunicipiosUF(uf) {
  const chave = String(uf || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(chave)) throw new Error("UF invalida");

  const cached = cacheMunicipios.get(chave);
  if (cached && Date.now() - cached.buscadoEm < CACHE_MUNICIPIOS_MS) return cached.lista;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let resp;
  try {
    resp = await fetch(
      `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${chave}/municipios`,
      { signal: ctrl.signal }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status}`);

  const dados = await resp.json();
  if (!Array.isArray(dados)) throw new Error("Resposta inesperada do IBGE");

  const lista = dados.map(m => ({ codigo: String(m.id), nome: m.nome }))
                     .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  cacheMunicipios.set(chave, { lista, buscadoEm: Date.now() });
  return lista;
}

// GET /fiscal/municipios?uf=PR&busca=ibaiti
app.get("/fiscal/municipios", authMiddleware(["dono"]), async (req, res) => {
  const { uf = "PR", busca = "" } = req.query;
  try {
    const lista = await listarMunicipiosUF(uf);
    const termo = normalizarTexto(busca);
    if (!termo) return res.json(lista.slice(0, 50));

    // Prefixo primeiro, depois contém — quem digita "ibai" quer Ibaiti no topo
    const comecam = [];
    const contem = [];
    for (const m of lista) {
      const n = normalizarTexto(m.nome);
      if (n.startsWith(termo)) comecam.push(m);
      else if (n.includes(termo)) contem.push(m);
    }
    res.json([...comecam, ...contem].slice(0, 20));
  } catch (e) {
    console.error("Erro ao consultar municipios IBGE:", e.message);
    res.status(502).json({ erro: "Nao foi possivel consultar o IBGE agora. Digite o codigo manualmente." });
  }
});

// ══════════════════════════════════════════════════════════════
// CERTIFICADO DIGITAL A1 — armazenamento cifrado
// ══════════════════════════════════════════════════════════════
// O .pfx e a senha ficam cifrados no MongoDB com AES-256-GCM.
// A chave de cifra vive SÓ na env var CERT_ENCRYPTION_KEY, nunca no banco.
// Assim um dump do Mongo, sozinho, não permite assinar nada em nome da empresa.

function getChaveCifra() {
  const hex = process.env.CERT_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "CERT_ENCRYPTION_KEY ausente ou invalida. " +
      "Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "e coloque no .env do backend."
    );
  }
  return Buffer.from(hex, "hex");
}

// AES-256-GCM: além de cifrar, autentica — se o dado for adulterado no banco,
// o decifrar falha em vez de devolver lixo.
function cifrar(textoOuBuffer) {
  const chave = getChaveCifra();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", chave, iv);
  const dados = Buffer.isBuffer(textoOuBuffer) ? textoOuBuffer : Buffer.from(String(textoOuBuffer), "utf8");
  const cifrado = Buffer.concat([cipher.update(dados), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), dados: cifrado.toString("base64") };
}

function decifrar(pacote, comoBuffer = false) {
  const chave = getChaveCifra();
  const decipher = crypto.createDecipheriv("aes-256-gcm", chave, Buffer.from(pacote.iv, "base64"));
  decipher.setAuthTag(Buffer.from(pacote.tag, "base64"));
  const aberto = Buffer.concat([decipher.update(Buffer.from(pacote.dados, "base64")), decipher.final()]);
  return comoBuffer ? aberto : aberto.toString("utf8");
}

// ── Leitura do PKCS#12 ────────────────────────────────────────
// Abre o .pfx de verdade. Se a senha estiver errada, o forge lança —
// é assim que validamos de fato (em vez de só aceitar e quebrar depois).
function lerCertificadoA1(pfxBuffer, senha) {
  const p12Der = forge.util.createBuffer(pfxBuffer.toString("binary"));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
  } catch (e) {
    throw new Error("Senha do certificado incorreta ou arquivo invalido.");
  }

  // Certificado X.509
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!certBags.length) throw new Error("Nenhum certificado encontrado no arquivo.");
  const cert = certBags[0].cert;

  // Chave privada
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]
              || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]
              || [];
  if (!keyBags.length) throw new Error("Chave privada nao encontrada no certificado.");
  const chavePrivada = keyBags[0].key;

  // O CNPJ costuma vir no CN no formato "RAZAO SOCIAL:00000000000000"
  const cn = cert.subject.getField("CN")?.value || "";
  const cnpjMatch = cn.match(/:(\d{14})$/);

  return {
    cert,
    chavePrivada,
    pemCertificado: forge.pki.certificateToPem(cert),
    pemChave: forge.pki.privateKeyToPem(chavePrivada),
    titular: cn.split(":")[0] || cn,
    cnpj: cnpjMatch ? cnpjMatch[1] : "",
    validoDe: cert.validity.notBefore,
    validoAte: cert.validity.notAfter,
    emissor: cert.issuer.getField("CN")?.value || "",
  };
}

// Carrega o certificado do banco já decifrado e pronto para assinar.
// Usado na hora de emitir a nota.
async function carregarCertificado() {
  const doc = await ConfigDB.findOne({ chave: "certificado" }).lean();
  if (!doc?.valor?.pfx) throw new Error("Certificado A1 nao configurado.");
  const pfxBuffer = decifrar(doc.valor.pfx, true);
  const senha = decifrar(doc.valor.senha);
  return lerCertificadoA1(pfxBuffer, senha);
}

// ── ROTAS ─────────────────────────────────────────────────────

// POST /fiscal/certificado — upload do .pfx em base64 + senha
app.post("/fiscal/certificado", authMiddleware(["dono"]), async (req, res) => {
  const { certBase64, senha } = req.body || {};
  if (!certBase64 || typeof certBase64 !== "string") return res.status(400).json({ erro: "Envie o arquivo do certificado (base64)" });
  if (!senha || typeof senha !== "string") return res.status(400).json({ erro: "Informe a senha do certificado" });

  let pfxBuffer;
  try {
    pfxBuffer = Buffer.from(certBase64, "base64");
  } catch {
    return res.status(400).json({ erro: "Arquivo invalido" });
  }
  if (!pfxBuffer.length) return res.status(400).json({ erro: "Arquivo vazio" });
  if (pfxBuffer.length > 512 * 1024) return res.status(400).json({ erro: "Arquivo muito grande para um certificado A1" });

  // Valida de verdade: abre o PKCS#12 com a senha informada
  let info;
  try {
    info = lerCertificadoA1(pfxBuffer, senha);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const agora = new Date();
  if (info.validoAte < agora) {
    return res.status(400).json({ erro: `Certificado vencido em ${info.validoAte.toLocaleDateString("pt-BR")}` });
  }

  try {
    await ConfigDB.updateOne(
      { chave: "certificado" },
      {
        valor: {
          pfx: cifrar(pfxBuffer),
          senha: cifrar(senha),
          // Metadados em claro: não são segredo e evitam decifrar só para exibir
          titular: info.titular,
          cnpj: info.cnpj,
          emissor: info.emissor,
          validoDe: info.validoDe,
          validoAte: info.validoAte,
          atualizadoEm: agora,
        },
      },
      { upsert: true }
    );
  } catch (e) {
    // Falha típica aqui é CERT_ENCRYPTION_KEY ausente
    console.error("Erro ao salvar certificado:", e.message);
    return res.status(500).json({ erro: e.message });
  }

  const diasRestantes = Math.floor((info.validoAte - agora) / 86400000);
  res.json({
    ok: true,
    titular: info.titular,
    cnpj: info.cnpj,
    emissor: info.emissor,
    validoAte: info.validoAte,
    diasRestantes,
  });
});

// GET /fiscal/certificado — status (nunca devolve o .pfx nem a senha)
app.get("/fiscal/certificado", authMiddleware(["dono"]), async (req, res) => {
  try {
    const doc = await ConfigDB.findOne({ chave: "certificado" }).lean();
    if (!doc?.valor?.pfx) return res.json({ configurado: false });

    const v = doc.valor;
    const validoAte = v.validoAte ? new Date(v.validoAte) : null;
    const diasRestantes = validoAte ? Math.floor((validoAte - new Date()) / 86400000) : null;

    res.json({
      configurado: true,
      titular: v.titular || "",
      cnpj: v.cnpj || "",
      emissor: v.emissor || "",
      validoDe: v.validoDe || null,
      validoAte: v.validoAte || null,
      diasRestantes,
      vencido: diasRestantes !== null && diasRestantes < 0,
      vencendo: diasRestantes !== null && diasRestantes >= 0 && diasRestantes <= 30,
      atualizadoEm: v.atualizadoEm || null,
      chaveCifraOk: /^[0-9a-fA-F]{64}$/.test(process.env.CERT_ENCRYPTION_KEY || ""),
    });
  } catch (e) {
    console.error("Erro ao ler status do certificado:", e.message);
    res.status(500).json({ erro: "Erro ao consultar certificado" });
  }
});

// POST /fiscal/certificado/testar — confirma que dá para decifrar e abrir
app.post("/fiscal/certificado/testar", authMiddleware(["dono"]), async (req, res) => {
  try {
    const info = await carregarCertificado();
    res.json({
      ok: true,
      titular: info.titular,
      cnpj: info.cnpj,
      validoAte: info.validoAte,
      mensagem: "Certificado decifrado e aberto com sucesso.",
    });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

// DELETE /fiscal/certificado
app.delete("/fiscal/certificado", authMiddleware(["dono"]), async (req, res) => {
  try {
    await ConfigDB.deleteOne({ chave: "certificado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao remover certificado:", e.message);
    res.status(500).json({ erro: "Erro ao remover certificado" });
  }
});

// ══════════════════════════════════════════════════════════════
// NFC-e — CONFIGURAÇÃO E EMISSÃO
// ══════════════════════════════════════════════════════════════
// A emissão é SOB DEMANDA: nada é enviado à SEFAZ sem alguém clicar.
// Os valores fiscais (NCM/CFOP/CSOSN) são definidos pelo contador.

const CONFIG_FISCAL_PADRAO = {
  ativo: false,
  ambiente: "homologacao",        // homologacao | producao
  provedor: "",                   // focusnfe | plugnotas | webmania | nfeio
  apiToken: "",                   // SEGREDO — nunca sai completo da API
  csc: "",                        // SEGREDO — Código de Segurança do Contribuinte
  cscId: "",                      // ID do CSC (ex.: "000001")
  serie: 1,
  cnpj: "", ie: "", razaoSocial: "", nomeFantasia: "",
  crt: "1",                       // 1 = Simples Nacional
  endereco: {
    logradouro: "", numero: "", complemento: "", bairro: "",
    municipio: "", codigoMunicipio: "", uf: "PR", cep: "",
  },
  // Aplicados a itens do cardápio sem configuração fiscal própria
  padroes: { ncm: "", cfop: "", csosn: "", origem: "0", unidade: "UN" },
};

async function getConfigFiscal() {
  try {
    const doc = await ConfigDB.findOne({ chave: "fiscal" }).lean();
    if (doc?.valor) return { ...CONFIG_FISCAL_PADRAO, ...doc.valor };
  } catch (e) { console.error("Erro ao ler config fiscal:", e.message); }
  return { ...CONFIG_FISCAL_PADRAO };
}

// Remove segredos antes de mandar para o painel. Mostra só os últimos 4
// caracteres para o usuário conferir que está preenchido.
function mascararSegredo(v) {
  if (!v) return "";
  return v.length <= 4 ? "****" : "****" + String(v).slice(-4);
}
function configFiscalSegura(cfg) {
  return {
    ...cfg,
    apiToken: mascararSegredo(cfg.apiToken),
    csc: mascararSegredo(cfg.csc),
    apiTokenPreenchido: !!cfg.apiToken,
    cscPreenchido: !!cfg.csc,
  };
}

app.get("/config/fiscal", authMiddleware(["dono"]), async (req, res) => {
  res.json(configFiscalSegura(await getConfigFiscal()));
});

app.put("/config/fiscal", authMiddleware(["dono"]), async (req, res) => {
  const atual = await getConfigFiscal();
  const b = req.body || {};
  const novo = { ...atual };

  const strFields = ["ambiente", "provedor", "cscId", "cnpj", "ie", "razaoSocial", "nomeFantasia", "crt"];
  for (const k of strFields) if (typeof b[k] === "string") novo[k] = b[k].trim();

  if (b.ativo !== undefined) novo.ativo = b.ativo === true || b.ativo === "true";
  if (b.serie !== undefined) { const n = parseInt(b.serie); if (Number.isFinite(n) && n > 0) novo.serie = n; }
  if (!["homologacao", "producao"].includes(novo.ambiente)) novo.ambiente = "homologacao";

  // Segredos: só sobrescreve se veio valor novo de verdade (o painel reenvia
  // o formulário com o valor mascarado — isso evita apagar sem querer)
  if (typeof b.apiToken === "string" && b.apiToken && !b.apiToken.startsWith("****")) novo.apiToken = b.apiToken.trim();
  if (typeof b.csc === "string" && b.csc && !b.csc.startsWith("****")) novo.csc = b.csc.trim();

  if (b.endereco && typeof b.endereco === "object") {
    novo.endereco = { ...atual.endereco };
    for (const k of Object.keys(CONFIG_FISCAL_PADRAO.endereco)) {
      if (typeof b.endereco[k] === "string") novo.endereco[k] = b.endereco[k].trim();
    }
  }
  if (b.padroes && typeof b.padroes === "object") {
    novo.padroes = { ...atual.padroes };
    for (const k of Object.keys(CONFIG_FISCAL_PADRAO.padroes)) {
      if (typeof b.padroes[k] === "string") novo.padroes[k] = b.padroes[k].trim();
    }
  }

  try {
    await ConfigDB.updateOne({ chave: "fiscal" }, { valor: novo }, { upsert: true });
    res.json(configFiscalSegura(novo));
  } catch (e) {
    console.error("Erro ao salvar config fiscal:", e.message);
    res.status(500).json({ erro: "Erro ao salvar configuracao fiscal" });
  }
});

// Diz o que ainda falta configurar antes de conseguir emitir
function pendenciasFiscais(cfg) {
  const faltando = [];
  if (!cfg.provedor) faltando.push("provedor da API fiscal");
  if (!cfg.apiToken) faltando.push("token da API");
  if (!cfg.csc) faltando.push("CSC");
  if (!cfg.cscId) faltando.push("ID do CSC");
  if (!cfg.cnpj) faltando.push("CNPJ");
  if (!cfg.ie) faltando.push("Inscricao Estadual");
  if (!cfg.razaoSocial) faltando.push("razao social");
  if (!cfg.endereco?.codigoMunicipio) faltando.push("codigo IBGE do municipio");
  if (!cfg.padroes?.ncm) faltando.push("NCM padrao");
  if (!cfg.padroes?.cfop) faltando.push("CFOP padrao");
  if (!cfg.padroes?.csosn) faltando.push("CSOSN padrao");
  return faltando;
}

app.get("/config/fiscal/status", authMiddleware(["dono", "caixa"]), async (req, res) => {
  const cfg = await getConfigFiscal();
  const faltando = pendenciasFiscais(cfg);
  res.json({
    ativo: cfg.ativo,
    ambiente: cfg.ambiente,
    provedor: cfg.provedor,
    pronto: cfg.ativo && faltando.length === 0,
    faltando,
  });
});

// Monta os itens com os dados fiscais.
// Item sem configuração própria herda o padrão da config fiscal.
function montarItensFiscais(itens, cfg) {
  return (itens || []).map((it, idx) => {
    const doCardapio = CARDAPIO.find(c => c.nome?.toLowerCase() === String(it.nome).toLowerCase());
    const f = doCardapio?.fiscal || {};
    const qtd = Number(it.qty) || 1;
    const preco = Number(it.preco) || 0;
    return {
      numero: idx + 1,
      nome: it.nome,
      quantidade: qtd,
      valorUnitario: parseFloat(preco.toFixed(2)),
      valorTotal: parseFloat((qtd * preco).toFixed(2)),
      ncm:     f.ncm     || cfg.padroes.ncm,
      cfop:    f.cfop    || cfg.padroes.cfop,
      csosn:   f.csosn   || cfg.padroes.csosn,
      cest:    f.cest    || "",
      origem:  f.origem  || cfg.padroes.origem,
      unidade: f.unidade || cfg.padroes.unidade,
    };
  });
}

// Confere se todo item tem o mínimo fiscal antes de tentar emitir
function validarItensFiscais(itensFiscais) {
  const erros = [];
  for (const it of itensFiscais) {
    if (!it.ncm)   erros.push(it.nome + ": sem NCM");
    if (!it.cfop)  erros.push(it.nome + ": sem CFOP");
    if (!it.csosn) erros.push(it.nome + ": sem CSOSN");
    // CSOSN 500/60x = ICMS ja retido por ST. A SEFAZ rejeita esses itens sem CEST.
    if (/^(500|60\d)$/.test(it.csosn) && !it.cest) erros.push(it.nome + ": CSOSN " + it.csosn + " (substituicao tributaria) exige CEST");
  }
  return erros;
}

// ── SUGESTÃO DE CLASSIFICAÇÃO FISCAL ─────────────────────────
// Pré-preenche NCM/CFOP/CSOSN/CEST do cardápio para o contador REVISAR.
// A regra de fundo é simples e vale para bar/espetaria no Simples:
//
//   • O que a casa PRODUZ (espetos, doces, acompanhamentos, suco batido)
//     → CFOP 5101 (venda de produção do estabelecimento) + CSOSN 102, sem CEST.
//   • O que a casa REVENDE e já veio com ICMS retido por substituição
//     tributária (cerveja, refrigerante, água, energético — "bebidas frias",
//     ST ativa no PR) → CFOP 5405 + CSOSN 500, e aí o CEST é obrigatório.
//
// Fontes: Protocolo ICMS 11/91 (bebidas frias), tabela CEST segmento 03 com a
// redação vigente desde 01/06/2021, TIPI/NCM capítulos 16, 19, 22.
// Isso é uma SUGESTÃO. Quem assina a responsabilidade é o contador.

const CONFIANCA = { ALTA: "alta", MEDIA: "media", BAIXA: "baixa" };

// Produção própria: nada de ST, nada de CEST.
const PROPRIA = { cfop: "5101", csosn: "102", cest: "", origem: "0", unidade: "UN" };
// Revenda de bebida fria com ICMS já retido lá atrás.
const REVENDA_ST = { cfop: "5405", csosn: "500", origem: "0", unidade: "UN" };

// A primeira regra que casar vence — ordem importa.
// "Heineken Zero" precisa vir antes de "Heineken", "lata" antes do genérico.
const REGRAS_FISCAIS = [
  // ── CERVEJAS E CHOPP (revenda com ST) ──
  {
    quando: (n, c) => c === "cervejas" && /(zero|sem alcool)/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22029100", cest: "0302201" },
    confianca: CONFIANCA.ALTA,
    nota: "Cerveja SEM ÁLCOOL tem NCM próprio (2202.91.00), diferente da cerveja comum. CEST de garrafa de vidro descartável.",
  },
  {
    quando: (n, c) => c === "cervejas" && /(chopp?|chope).*vinho|vinho.*(chopp?|chope)/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22030000", cest: "0302300" },
    confianca: CONFIANCA.BAIXA,
    nota: "A casa informou que esse item saiu do cardápio (a confirmar). Se saiu mesmo, desative em Cardápio em vez de classificar. Se voltar e levar vinho de verdade na mistura, sai da classificação de chope.",
  },
  {
    quando: (n, c) => c === "cervejas" && /chopp?|chope/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22030000", cest: "0302300" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.023.00 = chope.",
  },
  {
    quando: (n, c) => c === "cervejas" && /lata/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22030000", cest: "0302103" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.021.03 = cerveja em lata (redação vigente desde 01/06/2021).",
  },
  {
    quando: (n, c) => c === "cervejas",
    fiscal: { ...REVENDA_ST, ncm: "22030000", cest: "0302101" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.021.01 = cerveja em garrafa de vidro descartável (long neck).",
  },

  // ── REFRIGERANTES (revenda com ST) ──
  // Zero/diet nao levam acucar adicionado, entao mudam de NCM (2202.99.00).
  // O CEST e o mesmo: a tabela do segmento 03 aceita os dois NCMs.
  {
    quando: (n, c) => c === "refrigerantes" && /zero|diet|light|sem acucar/.test(n) && /lata/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22029900", cest: "0301002" },
    confianca: CONFIANCA.ALTA,
    nota: "Refrigerante zero em lata: NCM 2202.99.00 (sem acucar adicionado), CEST 03.010.02.",
  },
  {
    quando: (n, c) => c === "refrigerantes" && /lata/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22021000", cest: "0301002" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.010.02 = refrigerante em lata.",
  },
  {
    quando: (n, c) => c === "refrigerantes" && /zero|diet|light|sem acucar/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22029900", cest: "0301001" },
    confianca: CONFIANCA.ALTA,
    nota: "Refrigerante zero em PET: NCM 2202.99.00 (sem acucar adicionado), CEST 03.010.01.",
  },
  {
    quando: (n, c) => c === "refrigerantes",
    fiscal: { ...REVENDA_ST, ncm: "22021000", cest: "0301001" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.010.01 = refrigerante em embalagem PET (garrafa de 1L e 2L).",
  },

  // ── ENERGÉTICO (revenda com ST) ──
  {
    quando: (n, c) => c === "energetico" || /monster|red bull|energetic/.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22029900", cest: "0301300" },
    confianca: CONFIANCA.ALTA,
    nota: "CEST 03.013.00 = bebida energética em lata.",
  },

  // ── ÁGUA (revenda com ST) ──
  {
    quando: (n, c) => c === "agua" || /^agua /.test(n),
    fiscal: { ...REVENDA_ST, ncm: "22011000", cest: "0300500" },
    confianca: CONFIANCA.MEDIA,
    nota: "Embalagem plástica confirmada pela casa. 03.005.00 vale até 500ml — se a garrafa for maior, o CEST passa a 03.005.04.",
  },

  // ── SUCO (preparado na casa) ──
  {
    quando: (n, c) => c === "suco" || /suco/.test(n),
    fiscal: { ...PROPRIA, ncm: "22029900" },
    confianca: CONFIANCA.ALTA,
    nota: "Batido na hora (confirmado pela casa): produção própria, sem ST. 2202.99.00 = bebida não alcoólica preparada.",
  },

  // ── ESPETOS: o NCM segue a carne ──
  {
    quando: (n) => /alcatra|picanha|mignon|maminha|contra ?file|fraldinha/.test(n),
    fiscal: { ...PROPRIA, ncm: "16025000" },
    confianca: CONFIANCA.ALTA,
    nota: "1602.50.00 = preparações de carne bovina.",
  },
  {
    quando: (n) => /frango|tulipa|coracao|coracaozinho|galinha/.test(n),
    fiscal: { ...PROPRIA, ncm: "16023290" },
    confianca: CONFIANCA.ALTA,
    nota: "1602.32.90 = preparações de galos/galinhas, cozidas. (1602.32.10 é só para carne crua.)",
  },
  {
    quando: (n) => /linguica|calabresa|salsicha/.test(n),
    fiscal: { ...PROPRIA, ncm: "16010000" },
    confianca: CONFIANCA.ALTA,
    nota: "1601.00.00 = enchidos (linguiças).",
  },
  {
    quando: (n) => /panceta|suin|porco|bacon|pernil|lombo/.test(n),
    fiscal: { ...PROPRIA, ncm: "16024900" },
    confianca: CONFIANCA.ALTA,
    nota: "1602.49.00 = preparações de carne suína.",
  },
  {
    quando: (n) => /cordeiro|carneiro|ovino/.test(n),
    fiscal: { ...PROPRIA, ncm: "16029000" },
    confianca: CONFIANCA.MEDIA,
    nota: "1602.90.00 = outras preparações de carne (ovinos entram aqui).",
  },
  {
    quando: (n) => /kafta|kibe|churrasco grego/.test(n),
    fiscal: { ...PROPRIA, ncm: "16025000" },
    confianca: CONFIANCA.BAIXA,
    nota: "Assumi base bovina. Se for mistura de carnes (bovina + suína, por exemplo), o contador pode preferir 1602.90.00.",
  },
  {
    quando: (n) => /queijo/.test(n) && !/romeu/.test(n),
    fiscal: { ...PROPRIA, ncm: "04061010" },
    confianca: CONFIANCA.MEDIA,
    nota: "0406.10.10 = queijo fresco (coalho).",
  },
  {
    quando: (n) => /pao de alho|pao/.test(n),
    fiscal: { ...PROPRIA, ncm: "19059090" },
    confianca: CONFIANCA.ALTA,
    nota: "1905.90.90 = outros produtos de padaria.",
  },
  {
    quando: (n) => /chocolate/.test(n),
    fiscal: { ...PROPRIA, ncm: "18069000" },
    confianca: CONFIANCA.MEDIA,
    nota: "1806.90.00 = preparações com chocolate.",
  },

  // ── COBERTURA POR CATEGORIA (doces, acompanhamentos, o que sobrar) ──
  {
    quando: (n, c) => ["doces", "acompanhamentos", "tradicionais", "especiais", "churrasco grego"].includes(c),
    fiscal: { ...PROPRIA, ncm: "21069090" },
    confianca: CONFIANCA.BAIXA,
    nota: "2106.90.90 = preparações alimentícias não especificadas. É o 'guarda-chuva' de item preparado na casa que não se encaixa em código específico.",
  },
];

// Fallback: qualquer coisa nova cai como produção própria genérica.
const SUGESTAO_PADRAO = {
  fiscal: { ...PROPRIA, ncm: "21069090" },
  confianca: CONFIANCA.BAIXA,
  nota: "Sem regra específica — tratei como item preparado na casa.",
};

// Padrões da config: valem para item de cardápio sem fiscal próprio.
const SUGESTAO_PADROES_CONFIG = { ncm: "21069090", cfop: "5101", csosn: "102", origem: "0", unidade: "UN" };

function sugerirFiscal(item) {
  const nome = normalizarTexto(item?.nome);
  const categoria = normalizarTexto(item?.categoria);
  for (const r of REGRAS_FISCAIS) {
    if (r.quando(nome, categoria)) return { fiscal: { ...r.fiscal }, confianca: r.confianca, nota: r.nota };
  }
  return { fiscal: { ...SUGESTAO_PADRAO.fiscal }, confianca: SUGESTAO_PADRAO.confianca, nota: SUGESTAO_PADRAO.nota };
}

// Formata só para leitura humana (o XML da NFC-e vai sem pontos)
function pontuarNCM(v) { return /^\d{8}$/.test(v) ? v.slice(0, 4) + "." + v.slice(4, 6) + "." + v.slice(6) : v || ""; }
function pontuarCEST(v) { return /^\d{7}$/.test(v) ? v.slice(0, 2) + "." + v.slice(2, 5) + "." + v.slice(5) : v || ""; }

function temFiscalPreenchido(f) {
  return !!(f && f.ncm && f.cfop && f.csosn);
}

// GET /fiscal/sugestoes — tabela para conferir antes de aplicar
app.get("/fiscal/sugestoes", authMiddleware(["dono"]), async (req, res) => {
  const itens = CARDAPIO.map(item => {
    const s = sugerirFiscal(item);
    const atual = item.fiscal || {};
    return {
      id: item.id,
      nome: item.nome,
      categoria: item.categoria,
      ativo: item.ativo !== false,
      jaPreenchido: temFiscalPreenchido(atual),
      atual: {
        ncm: atual.ncm || "", cfop: atual.cfop || "", csosn: atual.csosn || "",
        cest: atual.cest || "", origem: atual.origem || "0", unidade: atual.unidade || "UN",
      },
      sugerido: s.fiscal,
      sugeridoLegivel: { ncm: pontuarNCM(s.fiscal.ncm), cest: pontuarCEST(s.fiscal.cest) },
      confianca: s.confianca,
      nota: s.nota,
    };
  });

  res.json({
    itens,
    padroesSugeridos: SUGESTAO_PADROES_CONFIG,
    resumo: {
      total: itens.length,
      preenchidos: itens.filter(i => i.jaPreenchido).length,
      revisar: itens.filter(i => i.confianca !== CONFIANCA.ALTA).length,
    },
    aviso: "Sugestao automatica baseada na legislacao geral (Simples Nacional, bebidas frias com ST no PR). O contador precisa validar antes de emitir em producao.",
  });
});

// POST /fiscal/sugestoes/aplicar { sobrescrever?, ids?, aplicarPadroes? }
app.post("/fiscal/sugestoes/aplicar", authMiddleware(["dono"]), async (req, res) => {
  const { sobrescrever = false, ids = null, aplicarPadroes = true } = req.body || {};
  const filtroIds = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;

  const aplicados = [];
  const ignorados = [];
  const operacoes = [];

  for (const item of CARDAPIO) {
    if (filtroIds && !filtroIds.has(item.id)) continue;
    if (!sobrescrever && temFiscalPreenchido(item.fiscal)) { ignorados.push(item.nome); continue; }

    const { fiscal } = sugerirFiscal(item);
    item.fiscal = { ...fiscal };
    operacoes.push({ updateOne: { filter: { id: item.id }, update: { $set: { fiscal } } } });
    aplicados.push(item.nome);
  }

  // Uma ida so ao banco: 47 updateOne em sequencia travam por minutos se o Mongo cai
  if (operacoes.length) {
    try {
      await CardapioDB.bulkWrite(operacoes, { ordered: false });
    } catch (e) {
      console.error("Erro ao gravar sugestoes fiscais no banco:", e.message);
      return res.status(500).json({ erro: "Classificacao aplicada em memoria, mas nao foi salva no banco: " + e.message });
    }
  }

  // Preenche tambem os padroes da config, se ainda estiverem vazios
  let padroesAplicados = false;
  if (aplicarPadroes) {
    try {
      const cfg = await getConfigFiscal();
      if (sobrescrever || !cfg.padroes?.ncm || !cfg.padroes?.cfop || !cfg.padroes?.csosn) {
        const novo = { ...cfg, padroes: { ...SUGESTAO_PADROES_CONFIG } };
        await ConfigDB.updateOne({ chave: "fiscal" }, { valor: novo }, { upsert: true });
        padroesAplicados = true;
      }
    } catch (e) { console.error("Erro ao aplicar padroes fiscais:", e.message); }
  }

  res.json({ ok: true, aplicados: aplicados.length, ignorados: ignorados.length, nomes: aplicados, padroesAplicados });
});

// ── EMISSÃO ──────────────────────────────────────────────────
// A comunicação com a SEFAZ é feita por um provedor (API fiscal), que cuida
// de XML, assinatura, transmissão e contingência.
// O adaptador concreto é implementado quando o provedor for escolhido —
// endpoint, headers e formato do payload saem da documentação de cada um.
async function emitirNoProvedor(cfg, payload) {
  switch (cfg.provedor) {
    case "focusnfe":
    case "plugnotas":
    case "webmania":
    case "nfeio":
      throw new Error(
        "Provedor \"" + cfg.provedor + "\" ainda nao implementado. " +
        "Falta plugar a chamada HTTP da API (endpoint, headers e formato do payload)."
      );
    default:
      throw new Error("Nenhum provedor de NFC-e configurado.");
  }
}

async function cancelarNoProvedor(cfg, nota, motivo) {
  throw new Error("Cancelamento ainda nao implementado — depende do provedor escolhido.");
}

// Emite UMA nota. Devolve { http, corpo } em vez de escrever na resposta,
// porque a rota de lote precisa chamar isso N vezes e juntar os resultados.
async function emitirUmaNota({ vendaId, pedidoId, cpfCliente, cfg, usuario }) {
  let origem, itens, valorTotal, nomeCliente = "";
  try {
    if (vendaId) {
      origem = await VendaSalaoDB.findById(vendaId).lean();
      if (!origem) return { http: 404, corpo: { erro: "Venda nao encontrada" } };
      if (origem.notaFiscalStatus === "autorizada") return { http: 409, corpo: { erro: "Essa venda ja tem nota autorizada" } };
      itens = origem.itens; valorTotal = origem.total; nomeCliente = origem.cliente || "";
    } else {
      origem = await PedidoDB.findOne({ id: String(pedidoId) }).lean();
      if (!origem) return { http: 404, corpo: { erro: "Pedido nao encontrado" } };
      itens = origem.itens; valorTotal = origem.total; nomeCliente = origem.cliente || "";
    }
  } catch (e) {
    console.error("Erro ao carregar origem da nota:", e.message);
    return { http: 500, corpo: { erro: "Erro ao carregar a venda" } };
  }

  const itensFiscais = montarItensFiscais(itens, cfg);
  // ATENCAO ao plugar o provedor: quando a comanda teve desconto, a soma dos
  // itens (subtotal) e MAIOR que valorTotal. O XML da NFC-e precisa levar isso
  // em vDesc (rateado por item ou no total), senao a SEFAZ rejeita por
  // divergencia entre o somatorio dos itens e o valor da nota.
  const errosItens = validarItensFiscais(itensFiscais);
  if (errosItens.length) {
    return { http: 400, corpo: { erro: "Itens sem dados fiscais. Preencha no cardapio ou defina um padrao.", detalhes: errosItens } };
  }

  const cpfLimpo = String(cpfCliente || "").replace(/\D/g, "");
  if (cpfLimpo && cpfLimpo.length !== 11) return { http: 400, corpo: { erro: "CPF invalido" } };

  // Registra a nota como "processando" ANTES de chamar o provedor.
  // Se a chamada cair no meio, fica o rastro em vez de sumir.
  let nota;
  try {
    nota = await NotaFiscalDB.create({
      vendaId: vendaId || null,
      pedidoId: pedidoId ? String(pedidoId) : null,
      ambiente: cfg.ambiente,
      status: "processando",
      valorTotal,
      cpfCliente: cpfLimpo,
      nomeCliente,
      itens: itensFiscais,
      refExterna: (vendaId || pedidoId) + "-" + Date.now(),
      emitidoPor: usuario || "",
    });
    if (vendaId) {
      await VendaSalaoDB.findByIdAndUpdate(vendaId, { notaFiscalId: nota._id, notaFiscalStatus: "processando" });
    }
  } catch (e) {
    console.error("Erro ao registrar nota:", e.message);
    return { http: 500, corpo: { erro: "Erro ao registrar a nota" } };
  }

  try {
    const r = await emitirNoProvedor(cfg, { nota, itens: itensFiscais, cfg });
    await NotaFiscalDB.findByIdAndUpdate(nota._id, {
      status: "autorizada",
      numero: r.numero, serie: r.serie, chave: r.chave, protocolo: r.protocolo,
      xmlUrl: r.xmlUrl, danfeUrl: r.danfeUrl, qrCode: r.qrCode,
      dataAutorizacao: new Date(),
    });
    if (vendaId) await VendaSalaoDB.findByIdAndUpdate(vendaId, { notaFiscalStatus: "autorizada" });
    return { http: 200, corpo: { ok: true, notaId: nota._id, ...r } };
  } catch (e) {
    console.error("Falha na emissao da NFC-e:", e.message);
    await NotaFiscalDB.findByIdAndUpdate(nota._id, { status: "erro", mensagemErro: e.message });
    if (vendaId) await VendaSalaoDB.findByIdAndUpdate(vendaId, { notaFiscalStatus: "erro" });
    return { http: 502, corpo: { erro: e.message, notaId: nota._id } };
  }
}

// POST /notas/emitir  { vendaId } ou { pedidoId }, cpfCliente opcional
app.post("/notas/emitir", authMiddleware(["dono", "caixa"]), async (req, res) => {
  const { vendaId, pedidoId, cpfCliente } = req.body || {};
  if (!vendaId && !pedidoId) return res.status(400).json({ erro: "Informe vendaId ou pedidoId" });

  const cfg = await getConfigFiscal();
  if (!cfg.ativo) return res.status(400).json({ erro: "Emissao de NFC-e desativada nas configuracoes" });
  const faltando = pendenciasFiscais(cfg);
  if (faltando.length) return res.status(400).json({ erro: "Configuracao fiscal incompleta", faltando });

  const r = await emitirUmaNota({
    vendaId, pedidoId, cpfCliente, cfg,
    usuario: req.user?.nome || req.user?.role || "",
  });
  res.status(r.http).json(r.corpo);
});

// POST /notas/emitir-lote  { vendaIds: [...] }
// Emite varias comandas de uma vez. Sem CPF: uma nota com CPF do cliente e
// pedido na hora, entao vai pelo botao individual. Aqui e "consumidor nao
// identificado", que e o caso de quem so quer regularizar o movimento do dia.
const LOTE_MAX = 100;

app.post("/notas/emitir-lote", authMiddleware(["dono", "caixa"]), async (req, res) => {
  const { vendaIds } = req.body || {};
  if (!Array.isArray(vendaIds) || !vendaIds.length) {
    return res.status(400).json({ erro: "Informe vendaIds (lista de comandas)" });
  }
  if (vendaIds.length > LOTE_MAX) {
    return res.status(400).json({ erro: "Maximo de " + LOTE_MAX + " comandas por lote. Divida em partes." });
  }

  // Configuracao se confere UMA vez, nao a cada comanda
  const cfg = await getConfigFiscal();
  if (!cfg.ativo) return res.status(400).json({ erro: "Emissao de NFC-e desativada nas configuracoes" });
  const faltando = pendenciasFiscais(cfg);
  if (faltando.length) return res.status(400).json({ erro: "Configuracao fiscal incompleta", faltando });

  const usuario = req.user?.nome || req.user?.role || "";
  const unicos = [...new Set(vendaIds.map(String))];
  const resultados = [];

  // Em sequencia, de proposito: a numeracao da NFC-e e sequencial e o
  // provedor tem limite de requisicoes. Disparar tudo junto embaralha as duas coisas.
  for (const vendaId of unicos) {
    try {
      const r = await emitirUmaNota({ vendaId, cpfCliente: "", cfg, usuario });
      resultados.push({
        vendaId,
        ok: r.http === 200,
        erro: r.http === 200 ? null : (r.corpo.erro || "falha"),
        detalhes: r.corpo.detalhes || null,
        notaId: r.corpo.notaId || null,
        numero: r.corpo.numero || null,
      });
    } catch (e) {
      console.error("Erro inesperado no lote, venda " + vendaId + ":", e.message);
      resultados.push({ vendaId, ok: false, erro: e.message, detalhes: null, notaId: null, numero: null });
    }
  }

  const autorizadas = resultados.filter(r => r.ok).length;
  res.json({
    total: resultados.length,
    autorizadas,
    falhas: resultados.length - autorizadas,
    resultados,
  });
});

// GET /notas — listagem com filtros
app.get("/notas", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const { status, de, ate, page = 1, limit = 100 } = req.query;
    const filtro = {};
    if (status) filtro.status = status;
    if (de || ate) {
      filtro.dataEmissao = {};
      if (de)  { const d = new Date(de);  if (!isNaN(d)) filtro.dataEmissao.$gte = d; }
      if (ate) { const d = new Date(ate); if (!isNaN(d)) filtro.dataEmissao.$lte = d; }
      if (!Object.keys(filtro.dataEmissao).length) delete filtro.dataEmissao;
    }
    const lim = Math.min(500, Math.max(1, parseInt(limit) || 100));
    const skip = (Math.max(1, parseInt(page) || 1) - 1) * lim;
    const lista = await NotaFiscalDB.find(filtro).sort({ dataEmissao: -1 }).skip(skip).limit(lim).lean();
    res.json(lista);
  } catch (e) {
    console.error("Erro ao listar notas:", e.message);
    res.status(500).json({ erro: "Erro ao listar notas" });
  }
});

// GET /notas/resumo — faturamento total vs total com nota emitida.
// Os dois números ficam lado a lado de propósito: no Simples Nacional o
// imposto incide sobre a receita bruta total, não sobre a soma das notas.
app.get("/notas/resumo", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const { de, ate } = req.query;
    const ini = de ? new Date(de) : new Date(new Date().setHours(0, 0, 0, 0));
    const fim = ate ? new Date(ate) : new Date();

    const vendas = await VendaSalaoDB.find({ fechamento: { $gte: ini, $lte: fim } }).lean();
    const pedidos = await PedidoDB.find({ status: "entregue", horario: { $gte: ini, $lte: fim } }).lean();

    const totalSalao = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const totalDelivery = pedidos.reduce((s, p) => s + (p.total || 0), 0);

    const comNota = vendas.filter(v => v.notaFiscalStatus === "autorizada");
    const totalComNota = comNota.reduce((s, v) => s + (v.total || 0), 0);

    res.json({
      periodo: { de: ini, ate: fim },
      faturamentoTotal: parseFloat((totalSalao + totalDelivery).toFixed(2)),
      totalSalao: parseFloat(totalSalao.toFixed(2)),
      totalDelivery: parseFloat(totalDelivery.toFixed(2)),
      comNotaEmitida: parseFloat(totalComNota.toFixed(2)),
      semNotaEmitida: parseFloat((totalSalao - totalComNota).toFixed(2)),
      qtdVendas: vendas.length,
      qtdComNota: comNota.length,
      observacao: "No Simples Nacional o imposto incide sobre a receita bruta total, independente de nota emitida. Confirme a apuracao com o contador.",
    });
  } catch (e) {
    console.error("Erro no resumo fiscal:", e.message);
    res.status(500).json({ erro: "Erro ao gerar resumo" });
  }
});

// POST /notas/:id/cancelar — prazo legal da NFC-e é de 30 minutos
app.post("/notas/:id/cancelar", authMiddleware(["dono"]), async (req, res) => {
  const { motivo } = req.body || {};
  if (!motivo || String(motivo).trim().length < 15) {
    return res.status(400).json({ erro: "Motivo do cancelamento deve ter ao menos 15 caracteres (exigencia da SEFAZ)" });
  }
  try {
    const nota = await NotaFiscalDB.findById(req.params.id);
    if (!nota) return res.status(404).json({ erro: "Nota nao encontrada" });
    if (nota.status !== "autorizada") return res.status(400).json({ erro: "So e possivel cancelar nota autorizada" });

    const minutos = (Date.now() - new Date(nota.dataAutorizacao).getTime()) / 60000;
    if (minutos > 30) {
      return res.status(400).json({ erro: "Prazo de cancelamento da NFC-e (30 min) expirado. Fale com o contador." });
    }

    const cfg = await getConfigFiscal();
    await cancelarNoProvedor(cfg, nota, String(motivo).trim());

    await NotaFiscalDB.findByIdAndUpdate(nota._id, {
      status: "cancelada", dataCancelamento: new Date(), motivoCancelamento: String(motivo).trim(),
    });
    if (nota.vendaId) await VendaSalaoDB.findByIdAndUpdate(nota.vendaId, { notaFiscalStatus: "cancelada" });
    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao cancelar nota:", e.message);
    res.status(502).json({ erro: e.message });
  }
});

// ── RESET (apagar dados de teste) ────────────────────────────
app.post("/reset/dados-teste", authMiddleware(["dono"]), async (req, res) => {
  const { confirmar } = req.body;
  if (confirmar !== "CONFIRMAR_RESET") return res.status(400).json({ erro: "Confirmação incorreta" });
  try {
    const [pedidos, vendas, avaliacoes, fidelidade, fechamentos, movEstoque] = await Promise.all([
      PedidoDB.deleteMany({}),
      VendaSalaoDB.deleteMany({}),
      AvaliacaoDB.deleteMany({}),
      FidelidadeDB.deleteMany({}),
      FechamentoDB.deleteMany({}),
      MovEstoqueDB.deleteMany({}),
    ]);
    // Zera quantidades do estoque mas mantém o cadastro
    await EstoqueDB.updateMany({}, { quantidade: 0, alertaEnviado: false });
    res.json({
      ok: true,
      apagados: {
        pedidos: pedidos.deletedCount,
        vendasSalao: vendas.deletedCount,
        avaliacoes: avaliacoes.deletedCount,
        fidelidade: fidelidade.deletedCount,
        fechamentos: fechamentos.deletedCount,
        movimentacoesEstoque: movEstoque.deletedCount,
      },
      mantidos: "cardápio, configurações, garçons, cupons e cadastro do estoque",
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// FILA DE IMPRESSÃO
// ══════════════════════════════════════════════════════════════
// A impressora térmica é Bluetooth e aceita UMA conexão por vez — ela fica
// pareada no aparelho do caixa. O celular do garçom não tem como falar com
// ela. Então o garçom não imprime: ele enfileira, e o aparelho do caixa
// (a "estação de impressão") consome a fila e imprime.
//
// Quem já tem a impressora na mão imprime direto e nem passa por aqui.

const CLAIM_TIMEOUT_MS = 60 * 1000;   // job travado em "processando" volta para a fila
const FILA_MAX_TENTATIVAS = 3;

// POST /impressao — garçom (ou qualquer um sem impressora) põe na fila
app.post("/impressao", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  const { tipo, dados } = req.body || {};
  if (!["cozinha", "recibo", "delivery"].includes(tipo)) {
    return res.status(400).json({ erro: "tipo deve ser cozinha, recibo ou delivery" });
  }
  if (!dados || typeof dados !== "object") return res.status(400).json({ erro: "dados obrigatorios" });
  if (!mongoPronto()) return res.status(503).json({ erro: "Banco indisponivel — imprima direto no caixa" });

  try {
    const job = await ImpressaoDB.create({
      tipo,
      dados,
      origem: req.user?.nome || req.user?.role || "",
    });
    res.status(201).json({ ok: true, id: job._id });
  } catch (e) {
    console.error("Erro ao enfileirar impressao:", e.message);
    res.status(500).json({ erro: "Erro ao enfileirar" });
  }
});

// POST /impressao/reservar — a estação pega os próximos jobs para imprimir.
// Reserva de forma atômica para dois aparelhos-estação não imprimirem o mesmo.
app.post("/impressao/reservar", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  if (!mongoPronto()) return res.json({ jobs: [] });
  const limite = Math.min(parseInt(req.body?.limite) || 5, 20);
  const estacao = req.user?.nome || req.user?.role || "estacao";

  try {
    // Devolve para a fila o que alguma estação pegou e não concluiu
    await ImpressaoDB.updateMany(
      { status: "processando", reservadoEm: { $lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
      { $set: { status: "pendente" }, $unset: { reservadoPor: "", reservadoEm: "" } }
    );

    const jobs = [];
    for (let i = 0; i < limite; i++) {
      const job = await ImpressaoDB.findOneAndUpdate(
        { status: "pendente", tentativas: { $lt: FILA_MAX_TENTATIVAS } },
        { $set: { status: "processando", reservadoPor: estacao, reservadoEm: new Date() }, $inc: { tentativas: 1 } },
        { sort: { createdAt: 1 }, new: true }
      ).lean();
      if (!job) break;
      jobs.push({ id: job._id, tipo: job.tipo, dados: job.dados, origem: job.origem, tentativas: job.tentativas });
    }
    res.json({ jobs });
  } catch (e) {
    console.error("Erro ao reservar jobs de impressao:", e.message);
    res.status(500).json({ erro: "Erro ao reservar" });
  }
});

// POST /impressao/:id/concluir  { ok, erro }
app.post("/impressao/:id/concluir", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  const { ok, erro } = req.body || {};
  if (!mongoPronto()) return res.status(503).json({ erro: "Banco indisponivel" });
  try {
    const job = await ImpressaoDB.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ erro: "Job nao encontrado" });

    if (ok) {
      await ImpressaoDB.findByIdAndUpdate(req.params.id, {
        $set: { status: "impresso", impressoEm: new Date() }, $unset: { erro: "" },
      });
    } else {
      // Ainda tem tentativa sobrando? Volta para a fila. Senão desiste.
      const desistir = (job.tentativas || 0) >= FILA_MAX_TENTATIVAS;
      await ImpressaoDB.findByIdAndUpdate(req.params.id, {
        $set: { status: desistir ? "erro" : "pendente", erro: String(erro || "falha na impressao").slice(0, 300) },
        $unset: { reservadoPor: "", reservadoEm: "" },
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao concluir job de impressao:", e.message);
    res.status(500).json({ erro: "Erro ao concluir" });
  }
});

// GET /impressao/status — quanto tem esperando (badge no painel)
app.get("/impressao/status", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  if (!mongoPronto()) return res.json({ pendentes: 0, erros: 0 });
  try {
    const [pendentes, erros] = await Promise.all([
      ImpressaoDB.countDocuments({ status: { $in: ["pendente", "processando"] } }),
      ImpressaoDB.countDocuments({ status: "erro" }),
    ]);
    res.json({ pendentes, erros });
  } catch { res.json({ pendentes: 0, erros: 0 }); }
});

// DELETE /impressao/erros — limpa o que falhou de vez
app.delete("/impressao/erros", authMiddleware(["dono", "caixa"]), async (req, res) => {
  try {
    const r = await ImpressaoDB.deleteMany({ status: "erro" });
    res.json({ ok: true, removidos: r.deletedCount });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  status: "ok", versao: "5.1",
  whatsapp: whatsappStatus,
  mongodb: mongoose.connection.readyState === 1 ? "conectado" : "memória",
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
  await conectarMongo().catch(e => console.error("Falha ao conectar Mongo:", e.message));
  // Nao derruba o servidor se o WhatsApp nao subir: a API precisa responder
  await conectarWhatsApp().catch(e => console.error("Falha ao iniciar WhatsApp:", e.message));
});

// ── REDE DE SEGURANCA ────────────────────────────────────────
// Handler de erro do Express: sem ele, erro sincrono devolvia stack trace HTML
app.use((err, req, res, next) => {
  console.error("Erro nao tratado na rota", req.method, req.path, "-", err?.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: "Erro interno do servidor" });
});

// Sem isso, qualquer promise rejeitada fora de try/catch encerra o processo no Node 18+
process.on("unhandledRejection", (motivo) => {
  console.error("[unhandledRejection]", motivo?.message || motivo);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.message || err);
  // Nao chama process.exit: PM2 reinicia se o processo realmente morrer,
  // mas erros isolados nao devem derrubar o atendimento inteiro.
});
