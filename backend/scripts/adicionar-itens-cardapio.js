// Adiciona ao cardápio os itens que a casa pediu em 05/09/2026.
//
// Por que um script e não editar o array do server.js: aquele array só é usado
// para semear um banco VAZIO. O cardápio de produção já existe no Mongo, então
// mexer nele exige escrever no banco.
//
// Rodar na VPS, dentro de backend/:
//   node scripts/adicionar-itens-cardapio.js --dry-run   (só mostra o que faria)
//   node scripts/adicionar-itens-cardapio.js             (aplica)
//   pm2 restart imperio-backend                          (recarrega o cardápio)
//
// É seguro rodar duas vezes: item cujo nome já existe é pulado.

import "dotenv/config";
import mongoose from "mongoose";

const DRY_RUN = process.argv.includes("--dry-run");

const NOVOS_ITENS = [
  // ── Acompanhamentos ──
  { categoria: "Acompanhamentos", nome: "Porção de arroz",                 preco: 8.00,  tempoPreparo: 5,  obs: null },
  { categoria: "Acompanhamentos", nome: "Porção de feijão",                preco: 8.00,  tempoPreparo: 5,  obs: "com bacon e calabresa" },
  { categoria: "Acompanhamentos", nome: "Mandioca",                        preco: 5.00,  tempoPreparo: 8,  obs: null },

  // ── Espetos ──
  { categoria: "Tradicionais",    nome: "Sambiquira",                      preco: 6.00,  tempoPreparo: 12, obs: null },
  { categoria: "Especiais",       nome: "Alcatra com queijo",              preco: 12.00, tempoPreparo: 15, obs: null },
  { categoria: "Especiais",       nome: "Mignon com calabresa",            preco: 15.00, tempoPreparo: 18, obs: null },
  { categoria: "Doces",           nome: "Queijo com doce de leite",        preco: 12.00, tempoPreparo: 8,  obs: null },

  // ── Refrigerantes PET 600ml ──
  { categoria: "Refrigerantes",   nome: "Coca-Cola 600ml",                 preco: 8.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Refrigerantes",   nome: "Coca-Cola Zero 600ml",            preco: 8.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Refrigerantes",   nome: "Guaraná Antarctica 600ml",        preco: 8.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Refrigerantes",   nome: "Guaraná Antarctica Zero 600ml",   preco: 8.00,  tempoPreparo: 1,  obs: null },

  // ── Sucos com sabor ──
  { categoria: "Suco",            nome: "Suco de Uva 200ml",               preco: 6.00,  tempoPreparo: 5,  obs: null },
  { categoria: "Suco",            nome: "Suco de Laranja 200ml",           preco: 6.00,  tempoPreparo: 5,  obs: null },
  { categoria: "Suco",            nome: "Suco de Uva 900ml",               preco: 12.00, tempoPreparo: 5,  obs: null },
  { categoria: "Suco",            nome: "Suco de Laranja 900ml",           preco: 12.00, tempoPreparo: 5,  obs: null },

  // ── Bebidas alcoólicas ──
  { categoria: "Cervejas",        nome: "Michelob Ultra",                  preco: 10.00, tempoPreparo: 1,  obs: null },
  { categoria: "Cervejas",        nome: "Ice Smirnoff",                    preco: 12.00, tempoPreparo: 1,  obs: null },

  // ── Refeições completas (do cardápio impresso) ──
  { categoria: "Refeições",       nome: "Jantinha Imperial",               preco: 18.00, tempoPreparo: 15, obs: "arroz, feijão com bacon e calabresa, mandioca cozida, vinagrete, farofa, molho da casa" },
  { categoria: "Refeições",       nome: "Lanche Imperial",                 preco: 18.00, tempoPreparo: 15, obs: "pão com gergelim, kafta com queijo, molho da casa, barbecue, vinagrete, alface — outro sabor de espeto altera o valor" },

  // ── Doces de balcão ──
  { categoria: "Doces",           nome: "Pão de mel",                      preco: 11.00, tempoPreparo: 1,  obs: null },
  { categoria: "Doces",           nome: "Trufa",                           preco: 7.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Doces",           nome: "Trident",                         preco: 3.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Doces",           nome: "Halls",                           preco: 3.00,  tempoPreparo: 1,  obs: null },
  { categoria: "Doces",           nome: "Mentos",                          preco: 3.00,  tempoPreparo: 1,  obs: null },
];

const normalizar = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI não encontrada. Rode dentro de backend/, onde está o .env.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const col = mongoose.connection.collection("cardapios");

  const existentes = await col.find({}, { projection: { id: 1, nome: 1 } }).toArray();
  const nomes = new Set(existentes.map((i) => normalizar(i.nome)));

  // O id é um número sequencial próprio, separado do _id do Mongo
  let proximoId = existentes.reduce((max, i) => Math.max(max, Number(i.id) || 0), 0) + 1;

  const inserir = [];
  const pulados = [];
  for (const item of NOVOS_ITENS) {
    if (nomes.has(normalizar(item.nome))) { pulados.push(item.nome); continue; }
    inserir.push({
      id: proximoId++,
      categoria: item.categoria,
      nome: item.nome,
      preco: item.preco,
      precoPromocional: null,
      tempoPreparo: item.tempoPreparo,
      ativo: true,
      obs: item.obs,
      // Vazio de propósito: preencher em Config → Fiscal → "Preencher os itens vazios"
      fiscal: { ncm: "", cfop: "", csosn: "", cest: "", origem: "0", unidade: "UN" },
    });
    nomes.add(normalizar(item.nome));
  }

  console.log(`\nCardápio atual: ${existentes.length} itens (maior id: ${proximoId - inserir.length - 1})`);
  if (pulados.length) console.log(`Já existiam, pulados: ${pulados.join(", ")}`);

  if (!inserir.length) {
    console.log("\nNada novo para adicionar.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${DRY_RUN ? "SERIAM ADICIONADOS" : "ADICIONANDO"} ${inserir.length} itens:\n`);
  for (const i of inserir) {
    console.log(`  #${String(i.id).padEnd(4)} ${i.categoria.padEnd(16)} ${i.nome.padEnd(32)} R$ ${i.preco.toFixed(2)}`);
  }

  if (DRY_RUN) {
    console.log("\n--dry-run: nada foi gravado. Rode sem a flag para aplicar.");
  } else {
    await col.insertMany(inserir);
    console.log(`\n✅ ${inserir.length} itens adicionados.`);
    console.log("Agora rode: pm2 restart imperio-backend");
    console.log("Depois, em Config → Fiscal, clique em \"Preencher os itens vazios\".");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("Falhou:", e.message);
  process.exit(1);
});
