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
const ALIGN_LEFT    = cmd(ESC, 0x61, 0x00);
const ALIGN_CENTER  = cmd(ESC, 0x61, 0x01);
const ALIGN_RIGHT   = cmd(ESC, 0x61, 0x02);
const BOLD_ON       = cmd(ESC, 0x45, 0x01);
const BOLD_OFF      = cmd(ESC, 0x45, 0x00);
const SIZE_NORMAL   = cmd(GS, 0x21, 0x00);
const SIZE_DOUBLE_H = cmd(GS, 0x21, 0x01);
const NL            = cmd(LF);
const FEED          = (n = 3) => cmd(ESC, 0x64, n);
const CUT           = cmd(GS, 0x56, 0x42, 0x00);


// Remove acentos via NFD (mais confiável que CP850 em impressoras chinesas genéricas)
function removerAcentos(texto) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos
    .replace(/ç/g, "c").replace(/Ç/g, "C")
    .replace(/ñ/g, "n").replace(/Ñ/g, "N");
}

function textoParaBytes(texto) {
  const limpo = removerAcentos(texto);
  const bytes = [];
  for (const ch of limpo) {
    const c = ch.charCodeAt(0);
    if (c < 128) bytes.push(c);
    else bytes.push(0x3f); // '?' para desconhecido (raro depois do removerAcentos)
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
    this.wakeLock = null;
    this._onDisconnect = null; // referencia do handler p/ poder remover depois
    this._setupVisibilityListener();
  }

  // Quando a aba volta a ficar visível, tenta reconectar imediatamente
  _setupVisibilityListener() {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.isConnected() && this.temDispositivoSalvo()) {
        // Pequeno delay pra evitar problemas com a transição
        setTimeout(() => this.reconectarAuto().catch(() => {}), 500);
      }
    });
    // Também tenta reconectar quando a janela ganha foco
    window.addEventListener("focus", () => {
      if (!this.isConnected() && this.temDispositivoSalvo()) {
        setTimeout(() => this.reconectarAuto().catch(() => {}), 500);
      }
    });
  }

  // Mantém a tela do celular ligada (impede o navegador de suspender a aba)
  async manterAtivo(ativar = true) {
    try {
      if (ativar && "wakeLock" in navigator) {
        if (this.wakeLock) return; // já está ativo
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
      } else if (!ativar && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch (e) { console.warn("WakeLock falhou:", e.message); }
  }

  isSupported() { return !!navigator.bluetooth; }
  isConnected() { return this.device?.gatt?.connected && !!this.characteristic; }
  // Considera "disponível" se conectada OU se tem dispositivo salvo (vai reconectar automaticamente)
  isDisponivel() { return this.isConnected() || this.temDispositivoSalvo(); }
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

    // _setupConexao roda tanto em conectar() quanto em reconectarAuto(), e o
    // reconectarAuto recupera o MESMO objeto BluetoothDevice via getDevices().
    // Sem remover o handler anterior, os listeners acumulavam: apos N
    // reconexoes, uma unica queda disparava N callbacks -> N reconexoes
    // concorrentes travando o GATT.
    if (this._onDisconnect) {
      try { this.device.removeEventListener("gattserverdisconnected", this._onDisconnect); } catch {}
    }
    this._onDisconnect = () => {
      this.characteristic = null;
      this._notify();
      setTimeout(() => this.reconectarAuto().catch(() => {}), 2000);
    };
    this.device.addEventListener("gattserverdisconnected", this._onDisconnect);
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

  // Garante conexão antes de imprimir — tenta reconectar se cair
  async _garantirConexao() {
    if (this.isConnected()) return true;
    if (!this.temDispositivoSalvo()) return false;
    const r = await this.reconectarAuto();
    return !!r?.conectada;
  }

  async _sendBytes(bytes) {
    // Antes de mandar bytes, garante conexão (tenta reconectar se preciso)
    if (!this.isConnected()) {
      const ok = await this._garantirConexao();
      if (!ok) throw new Error("Impressora não conectada");
    }
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
  // Foco: cozinha/churrasqueira ver O QUE preparar.
  // SEM preços, SEM totais, SEM nome do estabelecimento.
  async imprimirComanda({ mesa, label, garcom, cliente, itens, hora }) {
    const agora = hora ? new Date(hora) : new Date();
    const cmds = [
      INIT,
      // Cabeçalho compacto
      ALIGN_CENTER, BOLD_ON,
      texto("COZINHA / GRILL"), NL,
      BOLD_OFF,
      texto("--------------------------------"), NL,
      NL,
      // Mesa em destaque (texto normal pra ficar limpo)
      ALIGN_LEFT, BOLD_ON,
      texto(`Mesa ${mesa}${label && label !== "Comanda 1" ? ` - ${label}` : ""}`), NL,
      BOLD_OFF,
    ];
    if (cliente && cliente !== "—") cmds.push(texto(`Cliente: ${cliente}`), NL);
    if (garcom && garcom !== "—") cmds.push(texto(`Garcom: ${garcom}`), NL);
    cmds.push(texto(`Hora: ${agora.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(NL, texto("--------------------------------"), NL, NL);
    // Itens em altura dobrada pra cozinha ler de longe
    for (const it of (itens || [])) {
      cmds.push(SIZE_DOUBLE_H, BOLD_ON, texto(`${it.qty||1}x ${it.nome}`), NL, SIZE_NORMAL, BOLD_OFF);
      if (it.obs) cmds.push(texto(`   obs: ${it.obs}`), NL);
      cmds.push(NL);
    }
    cmds.push(texto("--------------------------------"), NL);
    cmds.push(ALIGN_CENTER, texto("--- fim ---"), NL);
    cmds.push(FEED(4), CUT);
    await this._print(cmds);
  }

  // ── IMPRIMIR PEDIDO DELIVERY ──
  // Cupom completo: itens (cozinha) + dados do cliente (entrega) + valores (caixa)
  async imprimirPedidoDelivery({ id, cliente, telefone, endereco, itens, subtotal, desconto, cupom, total, obs, tempoPreparo, horario }) {
    const hora = horario ? new Date(horario) : new Date();
    const cmds = [
      INIT,
      // Cabeçalho
      ALIGN_CENTER, SIZE_DOUBLE_H, BOLD_ON,
      texto("DELIVERY"), NL,
      SIZE_NORMAL, BOLD_OFF,
      texto("--------------------------------"), NL,
      // Número do pedido em destaque
      SIZE_DOUBLE_H, BOLD_ON,
      texto(`Pedido #${id}`), NL,
      SIZE_NORMAL, BOLD_OFF,
      NL,
      // Dados do cliente
      ALIGN_LEFT, BOLD_ON,
      texto(`Cliente: ${cliente || "—"}`), NL,
      BOLD_OFF,
      texto(`Tel: ${telefone || "—"}`), NL,
      texto(`End: ${endereco || "—"}`), NL,
      texto(`Hora: ${hora.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL,
    ];
    if (tempoPreparo) cmds.push(texto(`Tempo: ~${tempoPreparo}min`), NL);
    if (obs) cmds.push(NL, BOLD_ON, texto(`OBS: ${obs}`), NL, BOLD_OFF);

    cmds.push(NL, texto("--------------------------------"), NL, NL);
    // Itens em altura dobrada (cozinha)
    for (const it of (itens || [])) {
      cmds.push(SIZE_DOUBLE_H, BOLD_ON, texto(`${it.qty||1}x ${it.nome}`), NL, SIZE_NORMAL, BOLD_OFF);
      if (it.obs) cmds.push(texto(`   obs: ${it.obs}`), NL);
      // Preço pequeno do lado (só pro conferente saber)
      const subItem = ((it.qty||1)*it.preco).toFixed(2);
      cmds.push(texto(`   R$ ${subItem}`), NL);
    }

    cmds.push(NL, texto("--------------------------------"), NL);
    // Valores
    if (subtotal !== undefined) {
      cmds.push(texto(`Subtotal:`.padEnd(22) + `R$ ${(subtotal||0).toFixed(2)}`.padStart(10)), NL);
    }
    cmds.push(texto(`Taxa entrega:`.padEnd(22) + `R$ 5,00`.padStart(10)), NL);
    if (desconto && desconto > 0) {
      cmds.push(texto(`Desconto${cupom ? ` (${cupom})` : ""}:`.padEnd(22) + `-R$ ${desconto.toFixed(2)}`.padStart(10)), NL);
    }
    cmds.push(NL, ALIGN_RIGHT, SIZE_DOUBLE_H, BOLD_ON, texto(`TOTAL R$ ${(total||0).toFixed(2)}`), NL, SIZE_NORMAL, BOLD_OFF);
    cmds.push(NL, NL, FEED(3), CUT);
    await this._print(cmds);
  }

  // ── IMPRIMIR RECIBO/COMANDA P/ CAIXA ──
  // Para conferência no caixa: itens COM preços, TOTAL, forma de pagamento
  async imprimirRecibo({ mesa, cliente, garcom, itens, total, pagamento, pagamentos, pagamentoTexto, abertura, fechamento }) {
    const ab = abertura ? new Date(abertura) : new Date();
    const fe = fechamento ? new Date(fechamento) : new Date();
    const cmds = [
      INIT,
      // Nome em altura dobrada (cabe na largura do papel 58mm)
      ALIGN_CENTER, SIZE_DOUBLE_H, BOLD_ON,
      texto("Imperio dos Espetos"), NL,
      SIZE_NORMAL, BOLD_OFF,
      texto("e Grill"), NL,
      NL,
      texto("===== COMANDA / CAIXA ====="), NL,
      NL,
      ALIGN_LEFT,
    ];
    if (mesa) cmds.push(BOLD_ON, texto(`Mesa: ${mesa}`), BOLD_OFF, NL);
    if (cliente && cliente !== "—") cmds.push(texto(`Cliente: ${cliente}`), NL);
    if (garcom && garcom !== "—") cmds.push(texto(`Garcom: ${garcom}`), NL);
    cmds.push(texto(`Aberta: ${ab.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(texto(`Fechada: ${fe.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`), NL);
    cmds.push(texto(`Data: ${fe.toLocaleDateString("pt-BR")}`), NL);
    cmds.push(NL, texto("--------------------------"), NL);
    for (const it of (itens || [])) {
      const qtd = String(it.qty || 1).padStart(2, " ");
      const nome = it.nome.length > 18 ? it.nome.slice(0, 18) : it.nome;
      const preco = `${((it.qty||1)*it.preco).toFixed(2)}`;
      // Layout 32 chars: "QQ NOME (até 18 chars)  PRECO"
      const meio = nome.padEnd(20, " ");
      cmds.push(texto(`${qtd} ${meio}${preco.padStart(7, " ")}`), NL);
    }
    cmds.push(texto("--------------------------"), NL, NL);
    cmds.push(ALIGN_RIGHT, SIZE_DOUBLE_H, BOLD_ON, texto(`TOTAL R$ ${(total||0).toFixed(2)}`), NL, SIZE_NORMAL, BOLD_OFF);
    // Comanda dividida: cada forma sai na sua linha, com o valor que coube
    const nomePg = { pix:"PIX", cartao:"Cartao", dinheiro:"Dinheiro", misto:"Misto" };
    if (Array.isArray(pagamentos) && pagamentos.length > 1) {
      cmds.push(ALIGN_LEFT, NL, texto("Pagamento:"), NL);
      for (const pg of pagamentos) {
        cmds.push(texto(`  ${nomePg[pg.tipo] || pg.tipo}  R$ ${(Number(pg.valor)||0).toFixed(2)}`), NL);
      }
    } else if (pagamentoTexto || pagamento) {
      const pgNome = pagamentoTexto || nomePg[pagamento] || pagamento;
      cmds.push(ALIGN_LEFT, NL, texto(`Pagamento: ${removerAcentos(String(pgNome))}`), NL);
    }
    cmds.push(NL, NL, ALIGN_CENTER);
    cmds.push(texto("Obrigado pela visita!"), NL);
    cmds.push(NL, FEED(3), CUT);
    await this._print(cmds);
  }

  // ── TESTE ──
  async imprimirTeste() {
    const cmds = [
      INIT,
      ALIGN_CENTER, SIZE_DOUBLE_H, BOLD_ON, texto("TESTE OK"), NL,
      SIZE_NORMAL, BOLD_OFF,
      texto("Imperio dos Espetos"), NL, NL,
      ALIGN_LEFT,
      texto("Impressora conectada"), NL,
      texto(`Data: ${new Date().toLocaleString("pt-BR")}`), NL,
      FEED(4), CUT,
    ];
    await this._print(cmds);
  }
}

// Singleton
export const impressora = new ImpressoraBT();
