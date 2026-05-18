// ============================================================
// IMPRESSORA TÉRMICA BLUETOOTH (Baihuo MY-7779 e similares)
// Protocolo ESC/POS via Web Bluetooth API
// ============================================================

// UUIDs comuns em impressoras térmicas chinesas (MY-7779, Goojprt, etc)
const SERVICES_CONHECIDOS = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
];

// ── COMANDOS ESC/POS ──
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
const cmd = (...bytes) => new Uint8Array(bytes);

const INIT          = cmd(ESC, 0x40);
const CODEPAGE_850  = cmd(ESC, 0x74, 0x02); // Latin Português
const ALIGN_LEFT    = cmd(ESC, 0x61, 0x00);
const ALIGN_CENTER  = cmd(ESC, 0x61, 0x01);
const ALIGN_RIGHT   = cmd(ESC, 0x61, 0x02);
const BOLD_ON       = cmd(ESC, 0x45, 0x01);
const BOLD_OFF      = cmd(ESC, 0x45, 0x00);
const SIZE_NORMAL   = cmd(GS, 0x21, 0x00);
const SIZE_DOUBLE_W = cmd(GS, 0x21, 0x10);
const SIZE_DOUBLE_H = cmd(GS, 0x21, 0x01);
const SIZE_DOUBLE   = cmd(GS, 0x21, 0x11);
const NL            = cmd(LF);
const FEED          = (n = 3) => cmd(ESC, 0x64, n);
const CUT           = cmd(GS, 0x56, 0x42, 0x00);

// ── Conversão de texto pra CP850 (suporta acentos PT-BR) ──
const CP850_MAP = {
  "á":0xa0, "à":0x85, "â":0x83, "ã":0xc6, "ä":0x84,
  "Á":0xb5, "À":0xb7, "Â":0xb6, "Ã":0xc7, "Ä":0x8e,
  "é":0x82, "è":0x8a, "ê":0x88, "ë":0x89,
  "É":0x90, "È":0xd4, "Ê":0xd2, "Ë":0xd3,
  "í":0xa1, "ì":0x8d, "î":0x8c, "ï":0x8b,
  "Í":0xd6, "Ì":0xde, "Î":0xd7, "Ï":0xd8,
  "ó":0xa2, "ò":0x95, "ô":0x93, "õ":0xe4, "ö":0x94,
  "Ó":0xe0, "Ò":0xe3, "Ô":0xe2, "Õ":0xe5, "Ö":0x99,
  "ú":0xa3, "ù":0x97, "û":0x96, "ü":0x81,
  "Ú":0xe9, "Ù":0xeb, "Û":0xea, "Ü":0x9a,
  "ç":0x87, "Ç":0x80,
  "ñ":0xa4, "Ñ":0xa5,
  "°":0xf8,
};

function textoParaBytes(texto) {
  const bytes = [];
  for (const ch of texto) {
    const c = ch.charCodeAt(0);
    if (c < 128) bytes.push(c);
    else bytes.push(CP850_MAP[ch] || 0x3f); // '?' para desconhecido
  }
  return new Uint8Array(bytes);
}

function texto(t) { return textoParaBytes(t); }

// ── CLASSE PRINCIPAL ──
class ImpressoraBT {
  constructor() {
    this.device = null;
    this.characteristic = null;
    this.listeners = new Set();
    this.tentandoReconectar = false;
  }

  isSupported() { return !!navigator.bluetooth; }
  isConnected() { return this.device?.gatt?.connected && !!this.characteristic; }
  // Se tem dispositivo salvo (foi pareado antes)
  temDispositivoSalvo() {
    try { return !!localStorage.getItem("imperio_printer_name"); } catch { return false; }
  }

  onStatus(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  _notify() {
    const s = { conectada: this.isConnected(), nome: this.device?.name || null, reconectando: this.tentandoReconectar };
    this.listeners.forEach(cb => { try { cb(s); } catch {} });
  }

  // Faz a conexão ao GATT e configura característica (compartilhado entre conectar e reconectar)
  async _setupConexao() {
    const server = await this.device.gatt.connect();

    let service = null;
    for (const uuid of SERVICES_CONHECIDOS) {
      try {
        service = await server.getPrimaryService(uuid);
        if (service) break;
      } catch {}
    }
    if (!service) {
      const services = await server.getPrimaryServices();
      service = services.find(s => !s.uuid.startsWith("00001800") && !s.uuid.startsWith("00001801"));
    }
    if (!service) throw new Error("Nenhum serviço de impressão encontrado");

    const chars = await service.getCharacteristics();
    this.characteristic = chars.find(c => c.properties.writeWithoutResponse) || chars.find(c => c.properties.write);
    if (!this.characteristic) throw new Error("Característica de escrita não encontrada");

    this.device.addEventListener("gattserverdisconnected", () => {
      this.characteristic = null;
      this._notify();
      // Tenta reconectar automaticamente após desconexão
      setTimeout(() => this.reconectarAuto().catch(() => {}), 2000);
    });
  }

  async conectar() {
    if (!this.isSupported()) {
      throw new Error("Seu navegador não suporta Bluetooth Web. Use Chrome ou Edge no Android/desktop.");
    }
    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: SERVICES_CONHECIDOS,
      });
      await this._setupConexao();

      // Salva dados para reconexão automática
      try {
        localStorage.setItem("imperio_printer_name", this.device.name || "Impressora");
        localStorage.setItem("imperio_printer_id", this.device.id || "");
      } catch {}
      this._notify();
      return { nome: this.device.name };
    } catch (e) {
      this.device = null;
      this.characteristic = null;
      throw e;
    }
  }

  // Tenta reconectar automaticamente (sem precisar de interação)
  // Funciona se: (1) o navegador suporta getDevices, (2) já foi pareado antes, (3) impressora está em alcance
  async reconectarAuto() {
    if (this.isConnected()) return { conectada: true };
    if (!this.isSupported() || !navigator.bluetooth.getDevices) {
      return { erro: "Reconexão automática não suportada neste navegador" };
    }
    if (!this.temDispositivoSalvo()) return { erro: "Nenhuma impressora pareada anteriormente" };
    if (this.tentandoReconectar) return { erro: "Reconexão já em andamento" };

    this.tentandoReconectar = true;
    this._notify();

    try {
      const idSalvo = localStorage.getItem("imperio_printer_id");
      const nomeSalvo = localStorage.getItem("imperio_printer_name");
      const devices = await navigator.bluetooth.getDevices();
      // Tenta achar pelo ID primeiro, fallback no nome
      this.device = devices.find(d => d.id === idSalvo) || devices.find(d => d.name === nomeSalvo);

      if (!this.device) {
        this.tentandoReconectar = false;
        this._notify();
        return { erro: "Impressora pareada não encontrada (foi removida do Bluetooth do dispositivo?)" };
      }

      await this._setupConexao();
      this.tentandoReconectar = false;
      this._notify();
      return { conectada: true, nome: this.device.name };
    } catch (e) {
      this.device = null;
      this.characteristic = null;
      this.tentandoReconectar = false;
      this._notify();
      return { erro: e.message || "Falha na reconexão" };
    }
  }

  async desconectar() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.characteristic = null;
    this.device = null;
    try {
      localStorage.removeItem("imperio_printer_name");
      localStorage.removeItem("imperio_printer_id");
    } catch {}
    this._notify();
  }

  // Esquece o dispositivo (precisará escolher de novo no próximo conectar)
  async esquecer() {
    try {
      if (this.device?.forget) await this.device.forget();
    } catch {}
    await this.desconectar();
  }

  async _sendBytes(bytes) {
    if (!this.isConnected()) throw new Error("Impressora não conectada");
    const tamanho = 100; // BLE max ~180, 100 é seguro
    for (let i = 0; i < bytes.length; i += tamanho) {
      const chunk = bytes.slice(i, i + tamanho);
      if (this.characteristic.properties.writeWithoutResponse) {
        await this.characteristic.writeValueWithoutResponse(chunk);
      } else {
        await this.characteristic.writeValue(chunk);
      }
      await new Promise(r => setTimeout(r, 30));
    }
  }

  async _print(comandos) {
    const total = comandos.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of comandos) { merged.set(c, offset); offset += c.length; }
    await this._sendBytes(merged);
  }

  // ── IMPRIMIR COMANDA DA COZINHA ──
  async imprimirComanda({ mesa, label, garcom, cliente, itens, hora }) {
    const agora = hora ? new Date(hora) : new Date();
    const cmds = [
      INIT, CODEPAGE_850,
      ALIGN_CENTER, SIZE_DOUBLE, BOLD_ON,
      texto("COZINHA"), NL,
      SIZE_NORMAL, BOLD_OFF,
      texto("Império dos Espetos"), NL,
      NL,
      ALIGN_LEFT, SIZE_DOUBLE_H, BOLD_ON,
      texto(`Mesa ${mesa}${label && label !== "Comanda 1" ? ` - ${label}` : ""}`), NL,
      SIZE_NORMAL, BOLD_OFF,
    ];
    if (cliente) { cmds.push(texto(`Cliente: ${cliente}`), NL); }
    if (garcom && garcom !== "—") { cmds.push(texto(`Garçom: ${garcom}`), NL); }
    cmds.push(texto(`${agora.toLocaleDateString("pt-BR")} ${agora.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(NL, texto("------------------------"), NL);
    for (const it of (itens || [])) {
      cmds.push(SIZE_DOUBLE_H, BOLD_ON, texto(`${it.qty||1}x ${it.nome}`), NL, SIZE_NORMAL, BOLD_OFF);
      if (it.obs) cmds.push(texto(`  obs: ${it.obs}`), NL);
    }
    cmds.push(texto("------------------------"), NL, NL);
    cmds.push(ALIGN_CENTER, texto("--- fim ---"), NL);
    cmds.push(FEED(4), CUT);
    await this._print(cmds);
  }

  // ── IMPRIMIR RECIBO DO CLIENTE ──
  async imprimirRecibo({ mesa, cliente, garcom, itens, total, pagamento, abertura, fechamento }) {
    const ab = abertura ? new Date(abertura) : new Date();
    const fe = fechamento ? new Date(fechamento) : new Date();
    const cmds = [
      INIT, CODEPAGE_850,
      ALIGN_CENTER, SIZE_DOUBLE, BOLD_ON,
      texto("Império dos Espetos"), NL,
      SIZE_NORMAL, BOLD_OFF,
      texto("e Grill"), NL,
      NL,
      texto("------- COMPROVANTE -------"), NL,
      NL,
      ALIGN_LEFT,
    ];
    if (mesa) cmds.push(BOLD_ON, texto(`Mesa: ${mesa}`), BOLD_OFF, NL);
    if (cliente && cliente !== "—") cmds.push(texto(`Cliente: ${cliente}`), NL);
    if (garcom && garcom !== "—") cmds.push(texto(`Garçom: ${garcom}`), NL);
    cmds.push(texto(`Aberta: ${ab.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(texto(`Fechada: ${fe.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(texto(`Data: ${fe.toLocaleDateString("pt-BR")}`), NL);
    cmds.push(NL, texto("------------------------"), NL);
    for (const it of (itens || [])) {
      const linhaItem = `${it.qty||1}x ${it.nome}`;
      const preco = `R$ ${((it.qty||1)*it.preco).toFixed(2)}`;
      // Tenta alinhar (32 caracteres por linha em impressora 58mm)
      const espaco = Math.max(1, 32 - linhaItem.length - preco.length);
      cmds.push(texto(linhaItem + " ".repeat(espaco) + preco), NL);
    }
    cmds.push(texto("------------------------"), NL, NL);
    cmds.push(ALIGN_RIGHT, SIZE_DOUBLE_H, BOLD_ON, texto(`TOTAL: R$ ${(total||0).toFixed(2)}`), NL, SIZE_NORMAL, BOLD_OFF);
    if (pagamento) {
      const pgNome = { pix:"PIX", cartao:"Cartão", dinheiro:"Dinheiro" }[pagamento] || pagamento;
      cmds.push(ALIGN_LEFT, texto(`Pagamento: ${pgNome}`), NL);
    }
    cmds.push(NL, NL, ALIGN_CENTER);
    cmds.push(texto("Obrigado pela visita! 🍢"), NL);
    cmds.push(NL, FEED(3), CUT);
    await this._print(cmds);
  }

  // ── TESTE ──
  async imprimirTeste() {
    const cmds = [
      INIT, CODEPAGE_850,
      ALIGN_CENTER, SIZE_DOUBLE, BOLD_ON, texto("TESTE"), NL,
      SIZE_NORMAL, BOLD_OFF, texto("Império dos Espetos"), NL, NL,
      ALIGN_LEFT, texto("Teste de impressão OK"), NL,
      texto("Acentos: ção á é í ó ú ã õ"), NL,
      texto(`Data: ${new Date().toLocaleString("pt-BR")}`), NL,
      FEED(4), CUT,
    ];
    await this._print(cmds);
  }
}

// Singleton
export const impressora = new ImpressoraBT();
