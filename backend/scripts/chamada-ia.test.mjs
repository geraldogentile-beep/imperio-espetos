// Testa o tratamento de erro da chamada a IA sem gastar credito: troca o
// fetch global por respostas simuladas e confere a mensagem que chega ao dono.
//
//   node scripts/chamada-ia.test.mjs
//
// Motivo: a casa relatou o bot repetindo "tive uma instabilidade". Isso e
// sempre erro nesta chamada, e o motivo real (modelo inexistente, credito
// acabado, chave revogada) estava sendo descartado antes de chegar ao log.

import fs from "fs";

const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

// Recorta so o trecho da chamada a IA, sem subir o servidor inteiro
const ini = src.indexOf("let ultimaFalhaIA = null;");
const fim = src.indexOf("// Valida o JSON que a IA emitiu");
if (ini < 0 || fim < 0) { console.error("Nao achei o bloco da IA no server.js"); process.exit(1); }

const codigo = src.slice(ini, fim).replace(/await new Promise\(r => setTimeout\(r, \d+\)\)/g, "await Promise.resolve()");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

function montar(respostas) {
  let n = 0;
  const chamadas = [];
  const fakeFetch = async () => {
    chamadas.push(++n);
    const r = respostas[Math.min(n - 1, respostas.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const mod = new Function(
    "fetch", "console", "ENV", "MODELO_IA", "buildSystemPrompt", "setTimeout", "clearTimeout", "AbortController",
    codigo + "\nreturn { chamarClaude, get ultimaFalhaIA() { return ultimaFalhaIA; } };"
  )(fakeFetch, { error() {} }, { ANTHROPIC_KEY: "x" }, "claude-opus-5", () => "sys", setTimeout, clearTimeout, AbortController);
  return { mod, chamadas };
}

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

console.log("\n=== modelo descontinuado (404) ===");
{
  const { mod, chamadas } = montar([resp(404, { error: { message: "model: claude-sonnet-4-20250514 not found" } })]);
  let erro = null;
  try { await mod.chamarClaude([], "4199"); } catch (e) { erro = e; }
  ok(/nao existe ou foi descontinuado/.test(erro?.message || ""), `mensagem: "${erro?.message}"`);
  ok(/not found/.test(mod.ultimaFalhaIA?.mensagem || ""), "guardou o detalhe da API para o painel");
  ok(chamadas.length === 1, "nao reenvia: erro permanente");
}

console.log("\n=== chave revogada (401) ===");
{
  const { mod } = montar([resp(401, { error: { message: "invalid x-api-key" } })]);
  let erro = null;
  try { await mod.chamarClaude([], "4199"); } catch (e) { erro = e; }
  ok(/chave da IA invalida/.test(erro?.message || ""), `mensagem: "${erro?.message}"`);
}

console.log("\n=== credito esgotado (400) ===");
{
  const { mod } = montar([resp(400, { error: { message: "Your credit balance is too low" } })]);
  let erro = null;
  try { await mod.chamarClaude([], "4199"); } catch (e) { erro = e; }
  ok(/credito da conta Anthropic esgotado/.test(erro?.message || ""), `mensagem: "${erro?.message}"`);
}

console.log("\n=== 529 passageiro: tenta de novo e passa ===");
{
  const boa = resp(200, { stop_reason: "end_turn", content: [{ type: "text", text: "Oi! Bora pedir?" }] });
  const { mod, chamadas } = montar([resp(529, { error: { message: "overloaded" } }), boa]);
  const r = await mod.chamarClaude([], "4199");
  ok(chamadas.length === 2, `reenviou uma vez (foram ${chamadas.length} chamadas)`);
  ok(r === "Oi! Bora pedir?", "cliente recebeu a resposta boa, sem ver o erro");
  ok(mod.ultimaFalhaIA === null, "falha limpa depois que voltou");
}

console.log("\n=== 529 insistente: desiste na segunda ===");
{
  const { mod, chamadas } = montar([resp(529, { error: { message: "overloaded" } })]);
  let erro = null;
  try { await mod.chamarClaude([], "4199"); } catch (e) { erro = e; }
  ok(chamadas.length === 2, `tentou 2x e parou (foram ${chamadas.length})`);
  ok(!!erro, "propagou o erro");
}

console.log("\n=== resposta truncada nao vai para o cliente ===");
{
  const { mod } = montar([resp(200, { stop_reason: "max_tokens", content: [{ type: "text", text: "Seu pedido fico" }] })]);
  let erro = null;
  try { await mod.chamarClaude([], "4199"); } catch (e) { erro = e; }
  ok(/truncada/.test(erro?.message || ""), `mensagem: "${erro?.message}"`);
}

console.log("\n=== resposta normal junta todos os blocos ===");
{
  const { mod } = montar([resp(200, { stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "" }, { type: "text", text: "Oi! " }, { type: "text", text: "Bora pedir?" },
  ] })]);
  const r = await mod.chamarClaude([], "4199");
  ok(r === "Oi! Bora pedir?", `juntou os blocos: "${r}"`);
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
