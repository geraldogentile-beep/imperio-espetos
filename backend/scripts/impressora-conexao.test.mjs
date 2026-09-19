// Conexao da impressora Bluetooth com um Bluetooth simulado (sem aparelho).
//   node scripts/impressora-conexao.test.mjs
//
// Motivo: quedas frequentes e, depois que a impressora voltava, nada mais
// imprimia (nem a conta, nem o envio para a cozinha).

globalThis.__impressoraTempos = { conectar: 150, descoberta: 150, anuncio: 100, escrita: 200, manterViva: 60, esperas: [40, 60, 80] };
const loja = new Map();
globalThis.localStorage = { getItem: k => (loja.has(k) ? loja.get(k) : null), setItem: (k, v) => loja.set(k, String(v)), removeItem: k => loja.delete(k) };
globalThis.document = { visibilityState: "visible", addEventListener() {} };
globalThis.window = { addEventListener() {} };

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const SERVICO = "000018f0-0000-1000-8000-00805f9b34fb";

class Impressora extends EventTarget {
  constructor() {
    super();
    this.id = "imp1"; this.name = "MY-7779";
    this.recebido = []; this.escritas = 0; this.emEscrita = false; this.sobreposicoes = 0;
    this.modoConnect = "ok"; this.derrubarNaEscrita = null;
    const eu = this;
    const caracteristica = {
      properties: { writeWithoutResponse: true },
      async writeValueWithoutResponse(chunk) {
        if (!eu.gatt.connected) throw new Error("GATT Server is disconnected");
        if (eu.emEscrita) { eu.sobreposicoes++; throw new Error("GATT operation already in progress"); }
        eu.emEscrita = true;
        await dormir(2);
        eu.emEscrita = false;
        eu.escritas++;
        if (eu.derrubarNaEscrita !== null && eu.escritas >= eu.derrubarNaEscrita) {
          eu.derrubarNaEscrita = null; eu.cair();
          throw new Error("GATT Server is disconnected");
        }
        eu.recebido.push(...chunk);
      },
    };
    const servico = { uuid: SERVICO, getCharacteristics: async () => [caracteristica] };
    const servidor = {
      getPrimaryService: async (u) => { if (u === SERVICO) return servico; throw new Error("not found"); },
      getPrimaryServices: async () => [servico],
    };
    this.gatt = {
      connected: false,
      async connect() {
        if (eu.modoConnect === "trava") return new Promise(() => {});   // nunca responde
        if (eu.modoConnect === "falha") throw new Error("Connection failed");
        await dormir(5);
        this.connected = true;
        return servidor;
      },
      disconnect() { this.connected = false; },
    };
  }
  cair() { this.gatt.connected = false; this.dispatchEvent(new Event("gattserverdisconnected")); }
}

const aparelho = new Impressora();
Object.defineProperty(globalThis.navigator, "bluetooth", {
  configurable: true,
  value: { requestDevice: async () => aparelho, getDevices: async () => [aparelho] },
});

const { impressora } = await import("../../painel/src/bluetoothPrinter.js");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const texto = (bytes) => String.fromCharCode(...bytes.filter(b => b >= 32 && b < 127));
const ticket = (n) => ({ mesa: n, label: "Comanda 1", garcom: "Maria", itens: [{ nome: "Espeto " + n, qty: 1 }], hora: new Date().toISOString() });
const esperarAte = async (cond, ms = 2000) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (cond()) return true; await dormir(10); } return cond(); };

console.log("\n=== 1) conecta e imprime ===");
{
  await impressora.conectar();
  ok(impressora.isConnected(), "conectada");
  await impressora.imprimirComanda(ticket(1));
  ok(texto(aparelho.recebido).includes("Espeto 1"), "ticket chegou");
}

console.log("\n=== 2) tres impressoes ao mesmo tempo nao se atropelam ===");
{
  aparelho.recebido = []; aparelho.sobreposicoes = 0;
  const r = await Promise.allSettled([impressora.imprimirComanda(ticket(2)), impressora.imprimirComanda(ticket(3)), impressora.imprimirComanda(ticket(4))]);
  ok(r.every(x => x.status === "fulfilled"), `as tres terminaram (${r.map(x => x.status).join(", ")})`);
  ok(aparelho.sobreposicoes === 0, `nenhuma escrita sobreposta (${aparelho.sobreposicoes})`);
  const t = texto(aparelho.recebido);
  ok(t.indexOf("Espeto 2") < t.indexOf("Espeto 3") && t.indexOf("Espeto 3") < t.indexOf("Espeto 4"), "saem inteiras e em ordem");
}

console.log("\n=== 3) cai no meio da impressao: avisa e volta sozinha ===");
{
  aparelho.escritas = 0; aparelho.derrubarNaEscrita = 1;
  let erro = null;
  try { await impressora.imprimirComanda(ticket(5)); } catch (e) { erro = e; }
  ok(erro?.semConexao === true, `erro marcado como falta de conexao: "${erro?.message}"`);
  ok(!impressora.isConnected(), "fica desconectada");
  ok(await esperarAte(() => impressora.isConnected()), "reconecta sozinha em seguida");
  aparelho.recebido = [];
  await impressora.imprimirComanda(ticket(6));
  ok(texto(aparelho.recebido).includes("Espeto 6"), "e volta a imprimir");
}

console.log("\n=== 3b) navegador sem getDevices: reconecta na impressora da sessao ===");
{
  const getDevices = navigator.bluetooth.getDevices;
  delete navigator.bluetooth.getDevices;
  aparelho.cair();
  ok(await esperarAte(() => impressora.isConnected()), "reconectou sem getDevices");
  aparelho.recebido = [];
  await impressora.imprimirComanda(ticket(60));
  ok(texto(aparelho.recebido).includes("Espeto 60"), "e imprimiu");
  navigator.bluetooth.getDevices = getDevices;
}

console.log("\n=== 4) conexao que nunca responde nao trava o app ===");
{
  aparelho.modoConnect = "trava";
  aparelho.cair();
  await dormir(700);   // varias tentativas, cada uma estoura o tempo
  ok(!impressora.isConnected(), "segue desconectada enquanto a impressora nao responde");
  const t0 = Date.now();
  const r = await impressora.reconectarAuto();
  ok(!!r?.erro && !/andamento/i.test(r.erro) && Date.now() - t0 < 1500,
     `nova tentativa termina com erro em ${Date.now() - t0} ms, em vez de "ja em andamento" para sempre ("${r?.erro}")`);
  aparelho.modoConnect = "ok";   // a impressora voltou
  ok(await esperarAte(() => impressora.isConnected(), 3000), "quando ela volta, o app reconecta (antes ficava 'reconectando' para sempre)");
  aparelho.recebido = [];
  await impressora.imprimirComanda(ticket(7));
  ok(texto(aparelho.recebido).includes("Espeto 7"), "e imprime normalmente");
}

console.log("\n=== 5) pedir para imprimir durante a reconexao espera por ela ===");
{
  aparelho.cair();
  aparelho.recebido = [];
  let erro = null;
  try { await impressora.imprimirComanda(ticket(8)); } catch (e) { erro = e; }
  ok(!erro, `imprimiu depois de reconectar ${erro ? "(erro: " + erro.message + ")" : ""}`);
  ok(texto(aparelho.recebido).includes("Espeto 8"), "ticket completo");
}

console.log("\n=== 6) parada, a conexao recebe sinal de vida ===");
{
  aparelho.recebido = [];
  await dormir(250);
  const bytes = aparelho.recebido;
  let inits = 0;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x1b && bytes[i + 1] === 0x40) inits++;
  ok(inits >= 2, `comando neutro enviado periodicamente (${inits} vezes)`);
  const semComandos = [];
  for (let i = 0; i < bytes.length; i++) { if (bytes[i] === 0x1b && bytes[i + 1] === 0x40) { i++; continue; } semComandos.push(bytes[i]); }
  ok(!texto(semComandos).trim(), "sem imprimir nada no papel (so ESC @)");
}

console.log("\n=== 6b) aviso de troca de mesa: destaque no topo, sem itens ===");
{
  aparelho.recebido = [];
  await impressora.imprimirComanda({ mesa: 7, label: "", garcom: "Maria", cliente: "Ana", itens: [], hora: new Date().toISOString(),
    aviso: "TROCA DE MESA", obs: "Pedidos da Mesa 3 agora sao da MESA 7" });
  const t = texto(aparelho.recebido);
  ok(t.includes("** TROCA DE MESA **") && t.indexOf("TROCA DE MESA") < t.indexOf("Mesa 7"), "aviso em destaque antes do numero da mesa");
  ok(t.includes("Mesa 7") && t.includes("Pedidos da Mesa 3 agora sao da MESA 7"), "diz de onde veio e para onde foi");
}

console.log("\n=== 7) sem impressora pareada: erro claro, sem ficar esperando ===");
{
  await impressora.desconectar();
  let erro = null;
  const t0 = Date.now();
  try { await impressora.imprimirComanda(ticket(9)); } catch (e) { erro = e; }
  ok(erro?.semConexao && /pareada/i.test(erro.message), `erro: "${erro?.message}"`);
  ok(Date.now() - t0 < 100, "responde na hora");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
