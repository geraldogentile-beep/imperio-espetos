// QR Code do WhatsApp que nunca aparecia.
//
// Precisa do servidor: TESTE_URL=http://localhost:3000 node scripts/whatsapp-qr.test.mjs
//
// Motivo: com uma sessao antiga em auth_info (numero desligado no celular ou
// sessao expirada), o Baileys tenta restaurar e NUNCA emite QR. A dona
// clicava em "Gerar QR" e ficava na tela vazia. "Desconectar" tambem nao
// resolvia: sock.logout() estourava, virava erro 500 e a pasta ficava intacta.

import fs from "node:fs";
import path from "node:path";

const BASE = process.env.TESTE_URL;
if (!BASE) { console.error("defina TESTE_URL (ex.: http://localhost:3000)"); process.exit(1); }
const AUTH = path.resolve(process.env.TESTE_AUTH_DIR || "./auth_info");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

const token = await (async () => {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: process.env.TESTE_PIN || "9999" }) });
  return (await r.json()).token;
})();
const api = async (metodo, rota, corpo) => {
  const r = await fetch(BASE + rota, { method: metodo, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: corpo ? JSON.stringify(corpo) : undefined });
  return { status: r.status, corpo: await r.json().catch(() => ({})) };
};
const arquivadas = () => fs.readdirSync(path.dirname(AUTH)).filter(n => n.startsWith(path.basename(AUTH) + ".old-"));

console.log("\n=== a tela sabe dizer o que esta acontecendo ===");
{
  const st = await api("GET", "/whatsapp/status");
  ok(st.status === 200 && "temSessao" in st.corpo, `status diz se ha sessao guardada (${JSON.stringify(st.corpo).slice(0, 90)})`);
  const qr = await api("GET", "/whatsapp/qr");
  ok(qr.status === 200 && "temSessao" in qr.corpo, "a consulta do QR tambem");
}

console.log("\n=== sessao velha travando o QR ===");
{
  // Simula o caso: pasta de sessao existindo (como a da dona, morta)
  fs.mkdirSync(AUTH, { recursive: true });
  fs.writeFileSync(path.join(AUTH, "creds.json"), JSON.stringify({ teste: true }));
  const antes = arquivadas().length;

  const r = await api("POST", "/whatsapp/reconectar", { limparSessao: true });
  ok(r.status === 200 && r.corpo.sessaoLimpa === true, `reconectar com limpeza arquiva a sessao (HTTP ${r.status})`);
  ok(!fs.existsSync(path.join(AUTH, "creds.json")), "a credencial velha sai da frente");
  ok(arquivadas().length === antes + 1, "e fica guardada numa pasta .old-, nunca apagada");
}

console.log("\n=== desconectar funciona mesmo com a conexao morta ===");
{
  fs.mkdirSync(AUTH, { recursive: true });
  fs.writeFileSync(path.join(AUTH, "creds.json"), JSON.stringify({ teste: true }));
  const antes = arquivadas().length;

  const r = await api("POST", "/whatsapp/logout");
  ok(r.status === 200, `nao devolve mais erro 500 (HTTP ${r.status})`);
  ok(r.corpo.sessaoArquivada === true && arquivadas().length === antes + 1, "e arquiva a sessao do mesmo jeito");
  ok(!fs.existsSync(path.join(AUTH, "creds.json")), "a pasta some da frente");
}

console.log("\n=== sem limpar nada quando nao foi pedido ===");
{
  await dormir(500);
  const antes = arquivadas().length;
  const r = await api("POST", "/whatsapp/reconectar", {});
  ok(r.status === 200 && r.corpo.sessaoLimpa === false, "reconectar simples nao mexe na sessao");
  ok(arquivadas().length === antes, "nada foi arquivado");
}

// limpa as pastas que este teste criou
for (const n of arquivadas()) { try { fs.rmSync(path.join(path.dirname(AUTH), n), { recursive: true }); } catch {} }

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
