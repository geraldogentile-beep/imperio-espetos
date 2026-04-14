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
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

const app = express();

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
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limiting geral
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { erro: "Muitas requisições. Tente novamente em alguns minutos." } });
app.use(limiter);

// Rate limiting específico para login (anti brute-force)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { erro: "Muitas tentativas de login. Aguarde 15 minutos." } });

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
  JWT_SECRET:    process.env.JWT_SECRET || "imperio-dev-secret-trocar-em-prod",
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
  tempoPreparo: { type: Number, default: 10, min: 0 },
  ativo: { type: Boolean, default: true },
  obs: String,
});

const VendaSalaoSchema = new mongoose.Schema({
  mesa: { type: Number, required: true, min: 0 },
  cliente: String,
  garcom: String,
  garcomId: String,
  itens: { type: Array, required: true },
  total: { type: Number, required: true, min: 0 },
  pagamento: { type: String, required: true, enum: ["pix", "cartao", "dinheiro"] },
  abertura: Date,
  fechamento: { type: Date, default: Date.now },
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

function buildSystemPrompt(tel) {
  const aberto = estaAberto();
  const cuponsAtivos = cupons.filter(c => c.ativo).map(c => `${c.codigo} — ${c.descricao}`).join(", ");
  const telLimpo = tel ? tel.replace("@s.whatsapp.net","").replace("@lid","").replace(/\D/g,"") : "";
  return `Você é o assistente virtual do *${CONFIG.nomeEstabelecimento}* 👑🔥
Seu nome é *${CONFIG.nomeAgente}*.

STATUS: ${aberto ? "✅ LOJA ABERTA" : `🔴 LOJA FECHADA — próxima abertura: ${proximaAbertura()}. NÃO aceite pedidos.`}

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
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ENV.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, system: buildSystemPrompt(tel), messages: historico }),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error("Claude API: rate limit atingido. Tente novamente em instantes.");
    if (res.status === 401) throw new Error("Claude API: chave inválida. Verifique ANTHROPIC_KEY.");
    throw new Error(`Claude API erro ${res.status}`);
  }
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
      whatsappStatus = "disconnected";
      qrCodeBase64 = null;
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 300000); // max 5min
        console.log(`🔌 Conexão fechada. Reconectando em ${delay/1000}s (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(conectarWhatsApp, delay);
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
          if (dadosPedido.cupom) {
            const subtotal = dadosPedido.itens.reduce((s, i) => s + (i.qty || 1) * i.preco, 0);
            const { desconto, cupom: cupomObj } = aplicarCupom(subtotal, dadosPedido.cupom);
            dadosPedido.desconto = desconto;
            dadosPedido.total = subtotal + CONFIG.taxaEntrega - desconto;
            if (cupomObj) {
              cupomObj.usoAtual += 1;
              // Atualização atômica no DB para evitar race condition
              try { await CupomDB.updateOne({ codigo: cupomObj.codigo }, { $inc: { usoAtual: 1 } }); } catch (e) { console.error("Erro ao incrementar uso do cupom:", e.message); }
            }
          }
          const tempoPreparo = calcularTempoPreparo(dadosPedido.itens);
          const pedidoId = String(counter++).padStart(5, "0");
          const pedido = { id: pedidoId, ...dadosPedido, telefone: tel, tempoPreparo, status: "novo", horario: new Date().toISOString() };
          pedidos.push(pedido);
          try { await PedidoDB.create(pedido); } catch (e) { console.error("Erro ao salvar pedido no DB:", e.message); }
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

// ── AUTH API ─────────────────────────────────────────────────
app.post("/auth/login", loginLimiter, async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ erro: "PIN deve ter 4 dígitos" });

  // Verifica PINs de dono/caixa primeiro (funciona mesmo sem MongoDB)
  let pins = { dono: process.env.PIN_DONO || "9999", caixa: process.env.PIN_CAIXA || "5678" };
  try {
    const cfg = await ConfigDB.findOne({ chave: "pins" });
    if (cfg?.valor) pins = { ...pins, ...cfg.valor };
  } catch (e) { console.error("Erro ao buscar pins do DB (usando env vars):", e.message); }

  if (pin === pins.dono) {
    const token = gerarToken({ role: "dono" });
    return res.json({ token, role: "dono" });
  }
  if (pin === pins.caixa) {
    const token = gerarToken({ role: "caixa" });
    return res.json({ token, role: "caixa" });
  }

  // Verifica garçom no banco
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
  await enviarMsgStatus(pedido, status);
  if (status === "entregue") { await checarFidelidade(pedido); agendarAvaliacao(pedido); }
  if (status === "cancelado" && timersAvaliacao.has(id)) { clearTimeout(timersAvaliacao.get(id)); timersAvaliacao.delete(id); }
  res.json(pedido);
});

// ── WHATSAPP STATUS API ───────────────────────────────────────
app.get("/whatsapp/status", (req, res) => res.json({ status: whatsappStatus }));

app.post("/whatsapp/logout", authMiddleware(["dono"]), async (req, res) => {
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
app.get("/cupons", async (req, res) => { try { const lista = await CupomDB.find().lean(); res.json(lista); } catch { res.json(cupons); } });
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
app.post("/cupons/validar", (req, res) => {
  const resultado = aplicarCupom(req.body.subtotal || 0, req.body.codigo);
  res.json(resultado);
});

// ── AVALIAÇÕES API ────────────────────────────────────────────
app.get("/avaliacoes", async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const lista = await AvaliacaoDB.find().sort({ horario: -1 }).skip(skip).limit(parseInt(limit)).lean();
    res.json(lista);
  } catch (e) { console.error("Erro ao buscar avaliações:", e.message); res.json(avaliacoes); }
});
app.get("/avaliacoes/resumo", async (req, res) => {
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
app.get("/fidelidade", async (req, res) => {
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
app.get("/cardapio", (req, res) => res.json(CARDAPIO));
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
  const allowed = ["categoria", "nome", "preco", "tempoPreparo", "ativo", "obs"];
  const update = {};
  for (const key of allowed) { if (req.body[key] !== undefined) update[key] = req.body[key]; }
  if (update.preco !== undefined) update.preco = parseFloat(update.preco);
  if (update.tempoPreparo !== undefined) update.tempoPreparo = parseInt(update.tempoPreparo);
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
app.get("/config", (req, res) => res.json(CONFIG));
async function salvarConfig() { try { await ConfigDB.updateOne({ chave: "config" }, { valor: CONFIG }, { upsert: true }); } catch (e) { console.error("Erro ao salvar config:", e.message); } }
app.put("/config", authMiddleware(["dono"]), async (req, res) => {
  const allowed = ["nomeEstabelecimento", "nomeAgente", "taxaEntrega", "tempoEntregaMin", "tempoEntregaMax", "entregaCEP"];
  const update = {};
  for (const key of allowed) { if (req.body[key] !== undefined) update[key] = req.body[key]; }
  CONFIG = { ...CONFIG, ...update };
  await salvarConfig();
  res.json(CONFIG);
});
app.put("/config/horario", authMiddleware(["dono"]), async (req, res) => { CONFIG.horarioFuncionamento = { ...CONFIG.horarioFuncionamento, ...req.body }; await salvarConfig(); res.json(CONFIG.horarioFuncionamento); });
app.put("/config/mensagens", authMiddleware(["dono"]), async (req, res) => { CONFIG.mensagensAutomaticas = { ...CONFIG.mensagensAutomaticas, ...req.body }; await salvarConfig(); res.json(CONFIG.mensagensAutomaticas); });
app.put("/config/fidelidade", authMiddleware(["dono"]), async (req, res) => { CONFIG.fidelidade = { ...CONFIG.fidelidade, ...req.body }; await salvarConfig(); res.json(CONFIG.fidelidade); });
app.put("/config/avaliacao", authMiddleware(["dono"]), async (req, res) => { CONFIG.avaliacao = { ...CONFIG.avaliacao, ...req.body }; await salvarConfig(); res.json(CONFIG.avaliacao); });
app.get("/config/status-loja", (req, res) => res.json({ aberto: estaAberto(), proximaAbertura: proximaAbertura() }));

// ── VENDAS SALÃO API ─────────────────────────────────────────
app.get("/vendas-salao", async (req, res) => {
  try {
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const lista = await VendaSalaoDB.find({ fechamento: { $gte: hoje } }).sort({ fechamento: -1 }).lean();
    res.json(lista);
  } catch { res.json([]); }
});
app.post("/vendas-salao", authMiddleware(["dono", "caixa", "garcom"]), async (req, res) => {
  const { mesa, itens, total, pagamento } = req.body;
  if (!itens?.length) return res.status(400).json({ erro: "Itens são obrigatórios" });
  if (!total || total <= 0) return res.status(400).json({ erro: "Total inválido" });
  if (!pagamento) return res.status(400).json({ erro: "Forma de pagamento obrigatória" });
  try {
    const venda = await VendaSalaoDB.create(req.body);
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
app.get("/vendas-salao/historico", async (req, res) => {
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
app.get("/estoque", async (req, res) => {
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
app.get("/estoque/relatorio/consumo", async (req, res) => {
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
app.get("/estoque/:id/movimentacoes", async (req, res) => {
  try {
    const lista = await MovEstoqueDB.find({ estoqueId: req.params.id })
      .sort({ horario: -1 }).limit(100).lean();
    res.json(lista);
  } catch { res.json([]); }
});

// ── LUCRO API ─────────────────────────────────────────────────
// Calcula lucro cruzando vendas com custo cadastrado no estoque
app.get("/relatorio/lucro", async (req, res) => {
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
app.get("/garcons", async (req, res) => {
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
  if (ativo !== undefined) update.ativo = ativo;
  if (pin) {
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ erro: "PIN inválido" });
    const existe = await GarcomDB.findOne({ pin, _id: { $ne: req.params.id } });
    if (existe) return res.status(400).json({ erro: "PIN já em uso" });
    update.pin = pin;
  }
  try {
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

// Verifica PIN do garçom no login (não expõe lista de PINs)
app.post("/garcons/verificar-pin", async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ erro: "pin obrigatório" });
  try {
    const g = await GarcomDB.findOne({ pin, ativo: true }).lean();
    if (!g) return res.status(404).json({ erro: "PIN não encontrado ou garçom inativo" });
    res.json({ nome: g.nome, id: g._id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Relatório de desempenho por garçom
app.get("/garcons/relatorio", async (req, res) => {
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
    const porPagamento = { pix: 0, cartao: 0, dinheiro: 0 };
    vendasHoje.forEach(v => {
      const pag = v.pagamento || "dinheiro";
      porPagamento[pag] = (porPagamento[pag] || 0) + (v.total || 0);
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

app.get("/fechamento-dia", async (req, res) => {
  try {
    const lista = await FechamentoDB.find().sort({ data: -1 }).limit(90).lean();
    res.json(lista);
  } catch { res.json([]); }
});

app.get("/fechamento-dia/:dataStr", async (req, res) => {
  try {
    const f = await FechamentoDB.findOne({ dataStr: req.params.dataStr }).lean();
    if (!f) return res.status(404).json({ erro: "Fechamento não encontrado" });
    res.json(f);
  } catch (e) { res.status(500).json({ erro: e.message }); }
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
  await conectarMongo();
  await conectarWhatsApp();
});
