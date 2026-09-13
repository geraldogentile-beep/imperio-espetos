// Reproduz a fila/debounce do bot com a MESMA logica do server.js e prova
// que mensagens picadas viram uma rodada so, em serie.
import fs from "fs";

const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ini = src.indexOf("const ESPERA_MENSAGEM_MS");
const fim = src.indexOf("// Processa UMA rodada de conversa");
const bloco = src.slice(ini, fim);

// Encurta a espera para o teste nao demorar
const codigo = bloco.replace(/const ESPERA_MENSAGEM_MS = \d+;/, "const ESPERA_MENSAGEM_MS = 120;");

const chamadas = [];
let emVoo = 0, maxEmVoo = 0;

async function processarMensagemCliente(tel, texto) {
  emVoo++; maxEmVoo = Math.max(maxEmVoo, emVoo);
  chamadas.push({ tel, texto });
  await new Promise(r => setTimeout(r, 80));   // simula a chamada a IA
  emVoo--;
}

const { agendarMensagem } = new Function(
  "processarMensagemCliente", "console",
  codigo + "\nreturn { agendarMensagem };"
)(processarMensagemCliente, console);

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

console.log("\n=== 1) cliente digitando picado vira UMA rodada ===");
agendarMensagem("4199", "quero 2 espetos");
await new Promise(r => setTimeout(r, 40));
agendarMensagem("4199", "de picanha");
await new Promise(r => setTimeout(r, 40));
agendarMensagem("4199", "rua das flores 100");
await new Promise(r => setTimeout(r, 400));

ok(chamadas.length === 1, `1 chamada a IA (foram ${chamadas.length})`);
ok(chamadas[0]?.texto === "quero 2 espetos\nde picanha\nrua das flores 100",
   "as tres frases chegaram juntas");

console.log("\n=== 2) duas rodadas do mesmo cliente nao se cruzam ===");
chamadas.length = 0; maxEmVoo = 0;
agendarMensagem("4199", "primeira");
await new Promise(r => setTimeout(r, 200));
agendarMensagem("4199", "segunda");
await new Promise(r => setTimeout(r, 500));
ok(chamadas.length === 2, `2 rodadas (foram ${chamadas.length})`);
ok(maxEmVoo === 1, `nunca duas ao mesmo tempo (pico foi ${maxEmVoo})`);

console.log("\n=== 3) clientes diferentes correm em paralelo ===");
chamadas.length = 0; maxEmVoo = 0;
agendarMensagem("4111", "oi");
agendarMensagem("4222", "oi");
agendarMensagem("4333", "oi");
await new Promise(r => setTimeout(r, 500));
ok(chamadas.length === 3, `3 chamadas (foram ${chamadas.length})`);
ok(maxEmVoo === 3, `os 3 clientes em paralelo (pico foi ${maxEmVoo})`);

console.log("\n=== 4) erro numa rodada nao trava a fila do cliente ===");
chamadas.length = 0;
const original = processarMensagemCliente;
let primeira = true;
const comErro = async (tel, texto) => {
  if (primeira) { primeira = false; chamadas.push({ tel, texto }); throw new Error("boom"); }
  return original(tel, texto);
};
const fila2 = new Function("processarMensagemCliente","console", codigo + "\nreturn { agendarMensagem };")(comErro, console);
fila2.agendarMensagem("4555", "quebra");
await new Promise(r => setTimeout(r, 300));
fila2.agendarMensagem("4555", "depois do erro");
await new Promise(r => setTimeout(r, 500));
ok(chamadas.some(c => c.texto === "depois do erro"), "a mensagem seguinte foi processada mesmo assim");

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
