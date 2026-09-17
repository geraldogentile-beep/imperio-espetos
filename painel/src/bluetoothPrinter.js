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
// O que faz a conexao aguentar o dia inteiro no caixa:
//  - toda operacao Bluetooth passa por UMA fila (duas impressoes ao mesmo
//    tempo davam "GATT operation already in progress" e o ticket sumia);
//  - conectar tem tempo limite: antes, um connect() que nunca respondia
//    deixava o app "reconectando" para sempre e nada mais imprimia;
//  - quem pede para imprimir durante uma reconexao espera por ela;
//  - quando cai, tenta de novo em 2s, 5s, 10s, 20s e depois a cada 30s;
//  - de tempos em tempos manda um comando neutro para a impressora nao
//    desligar a conexao por inatividade.
// Os testes automatizados encurtam estes tempos por globalThis.__impressoraTempos
const TEMPOS = (typeof globalThis !== "undefined" && globalThis.__impressoraTempos) || {};
const TEMPO_CONECTAR_MS = TEMPOS.conectar ?? 12000;
const TEMPO_DESCOBERTA_MS = TEMPOS.descoberta ?? 8000;
const TEMPO_ANUNCIO_MS = TEMPOS.anuncio ?? 6000;
const TEMPO_ESCRITA_MS = TEMPOS.escrita ?? 5000;
const INTERVALO_MANTER_VIVA_MS = TEMPOS.manterViva ?? 40000;
const ESPERAS_RECONEXAO_MS = TEMPOS.esperas ?? [2000, 5000, 10000, 20000, 30000];

function comTempo(promessa, ms, mensagem) {
  let t;
  return Promise.race([
    promessa,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(mensagem)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// Erro de conexao (a impressora caiu ou nao responde). Quem imprime pela fila
// usa isso para devolver o ticket sem gastar tentativa.
function erroConexao(mensagem) {
  const e = new Error(mensagem);
  e.semConexao = true;
  return e;
}

class ImpressoraBT {
  constructor() {
    this.device = null;
    this.characteristic = null;
    this.listeners = new Set();
    this.tentandoReconectar = false;
    this.ultimoErro = null;
    this.wakeLock = null;
    this._onDisconnect = null;      // handler atual
    this._deviceOuvido = null;      // em qual objeto o handler esta pendurado
    this._reconexao = null;         // promessa da reconexao em andamento (compartilhada)
    this._fila = Promise.resolve(); // uma operacao Bluetooth por vez
    this._timerReconexao = null;
    this._tentativasSeguidas = 0;
    this._manterViva = null;
    this._setupVisibilityListener();
  }

  // Quando a aba volta a ficar visível, tenta reconectar imediatamente
  _setupVisibilityListener() {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.isConnected() && this.temDispositivoSalvo()) {
        setTimeout(() => this.reconectarAuto().catch(() => {}), 500);
      }
    });
    if (typeof window !== "undefined") {
      window.addEventListener("focus", () => {
        if (!this.isConnected() && this.temDispositivoSalvo()) {
          setTimeout(() => this.reconectarAuto().catch(() => {}), 500);
        }
      });
    }
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
  isConnected() { return !!(this.device?.gatt?.connected && this.characteristic); }
  // Considera "disponível" se conectada OU se tem dispositivo salvo (vai reconectar automaticamente)
  isDisponivel() { return this.isConnected() || this.temDispositivoSalvo(); }
  // Se tem dispositivo salvo (foi pareado antes)
  temDispositivoSalvo() {
    try { return !!localStorage.getItem("imperio_printer_name"); } catch { return false; }
  }
  nomeSalvo() {
    try { return localStorage.getItem("imperio_printer_name") || null; } catch { return null; }
  }

  onStatus(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  status() {
    return {
      conectada: this.isConnected(),
      nome: this.device?.name || this.nomeSalvo(),
      reconectando: this.tentandoReconectar,
      salva: this.temDispositivoSalvo(),
      erro: this.ultimoErro,
    };
  }
  _notify() {
    const s = this.status();
    this.listeners.forEach(cb => { try { cb(s); } catch {} });
  }

  // Uma operacao por vez no Bluetooth, mesmo que a anterior tenha falhado
  _emSerie(fn) {
    const p = this._fila.then(() => fn(), () => fn());
    this._fila = p.catch(() => {});
    return p;
  }

  _pararManterViva() { clearInterval(this._manterViva); this._manterViva = null; }
  _iniciarManterViva() {
    this._pararManterViva();
    this._manterViva = setInterval(() => {
      if (!this.isConnected()) return;
      // ESC @ (inicializar) nao imprime nada; so mantem o canal ativo
      this._emSerie(() => this._escrever(INIT)).catch(() => {});
    }, INTERVALO_MANTER_VIVA_MS);
  }

  // Conexao caiu: limpa o estado e agenda novas tentativas
  _marcarQueda(motivo) {
    this.characteristic = null;
    if (motivo) this.ultimoErro = motivo;
    this._pararManterViva();
    this._notify();
    this._agendarReconexao();
  }

  _agendarReconexao() {
    clearTimeout(this._timerReconexao);
    if (!this.temDispositivoSalvo()) return;
    const espera = ESPERAS_RECONEXAO_MS[Math.min(this._tentativasSeguidas, ESPERAS_RECONEXAO_MS.length - 1)];
    this._timerReconexao = setTimeout(async () => {
      if (this.isConnected() || !this.temDispositivoSalvo()) return;
      const r = await this.reconectarAuto();
      if (!r?.conectada) { this._tentativasSeguidas++; this._agendarReconexao(); }
    }, espera);
  }

  // Faz a conexão ao GATT e configura característica (compartilhado entre conectar e reconectar)
  async _setupConexao() {
    const device = this.device;
    let server;
    try {
      server = await comTempo(device.gatt.connect(), TEMPO_CONECTAR_MS, "A impressora não respondeu ao conectar");
    } catch (e) {
      try { device.gatt.disconnect(); } catch {}   // cancela a tentativa pendurada
      throw e;
    }

    try {
      let service = null;
      for (const uuid of SERVICES_CONHECIDOS) {
        try {
          service = await comTempo(server.getPrimaryService(uuid), TEMPO_DESCOBERTA_MS, "tempo");
          if (service) break;
        } catch {}
      }
      if (!service) {
        const services = await comTempo(server.getPrimaryServices(), TEMPO_DESCOBERTA_MS, "A impressora não listou seus serviços");
        service = services.find(s => !s.uuid.startsWith("00001800") && !s.uuid.startsWith("00001801"));
      }
      if (!service) throw new Error("Nenhum serviço de impressão encontrado");

      const chars = await comTempo(service.getCharacteristics(), TEMPO_DESCOBERTA_MS, "A impressora não respondeu");
      const ch = chars.find(c => c.properties.writeWithoutResponse) || chars.find(c => c.properties.write);
      if (!ch) throw new Error("Característica de escrita não encontrada");
      this.characteristic = ch;
    } catch (e) {
      try { device.gatt.disconnect(); } catch {}
      throw e;
    }

    // O mesmo aparelho pode chegar como outro objeto na reconexao: tira o
    // handler de onde ele estava, senao uma queda disparava varias reconexoes.
    if (this._onDisconnect && this._deviceOuvido) {
      try { this._deviceOuvido.removeEventListener("gattserverdisconnected", this._onDisconnect); } catch {}
    }
    this._onDisconnect = () => this._marcarQueda("A conexão com a impressora caiu");
    device.addEventListener("gattserverdisconnected", this._onDisconnect);
    this._deviceOuvido = device;

    this.ultimoErro = null;
    this._tentativasSeguidas = 0;
    clearTimeout(this._timerReconexao);
    this._iniciarManterViva();
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
      await this._emSerie(() => this._setupConexao());

      // Salva dados para reconexão automática
      try {
        localStorage.setItem("imperio_printer_name", this.device.name || "Impressora");
        localStorage.setItem("imperio_printer_id", this.device.id || "");
      } catch {}
      this._notify();
      return { nome: this.device.name };
    } catch (e) {
      this.characteristic = null;
      this.ultimoErro = e.message || "Erro ao conectar";
      this._notify();
      throw e;
    }
  }

  // Alguns aparelhos so aceitam reconectar depois de "ouvir" a impressora
  async _esperarAnuncio(device) {
    if (typeof device.watchAdvertisements !== "function") return;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    try {
      await comTempo(new Promise((resolve, reject) => {
        device.addEventListener("advertisementreceived", () => resolve(), { once: true });
        device.watchAdvertisements(ctrl ? { signal: ctrl.signal } : undefined).catch(reject);
      }), TEMPO_ANUNCIO_MS, "A impressora não foi encontrada por perto");
    } finally {
      try { ctrl?.abort(); } catch {}
    }
  }

  // Tenta reconectar automaticamente (sem precisar de interação).
  // Quem chama enquanto uma tentativa esta em andamento recebe a MESMA
  // promessa, em vez de um "ja em andamento" que fazia a impressao falhar.
  reconectarAuto() {
    if (this.isConnected()) return Promise.resolve({ conectada: true, nome: this.device?.name });
    if (!this.isSupported()) return Promise.resolve({ erro: "Este navegador não tem Bluetooth" });
    if (!this.temDispositivoSalvo()) return Promise.resolve({ erro: "Nenhuma impressora pareada neste aparelho" });
    if (!this.device && !navigator.bluetooth.getDevices) {
      return Promise.resolve({ erro: "Reconexão automática não suportada neste navegador. Use \"Parear de novo\"." });
    }
    if (this._reconexao) return this._reconexao;

    this.tentandoReconectar = true;
    this._notify();

    this._reconexao = this._emSerie(async () => {
      if (this.isConnected()) return { conectada: true, nome: this.device?.name };
      // Na mesma sessao a impressora ja esta na memoria: reconecta nela direto
      // (getDevices nem existe em todo Chrome). Depois de recarregar a pagina,
      // procura entre as impressoras que este navegador ja autorizou.
      let device = this.device;
      if (!device) {
        const idSalvo = localStorage.getItem("imperio_printer_id");
        const nomeSalvo = localStorage.getItem("imperio_printer_name");
        const devices = await navigator.bluetooth.getDevices();
        device = devices.find(d => d.id === idSalvo) || devices.find(d => d.name === nomeSalvo);
        if (!device) {
          return { erro: "Impressora pareada não encontrada. Use \"Parear de novo\"." };
        }
        this.device = device;
      }
      try {
        await this._setupConexao();
      } catch (primeira) {
        // Segunda chance, esperando a impressora aparecer
        await this._esperarAnuncio(device);
        await this._setupConexao();
      }
      return { conectada: true, nome: device.name };
    }).catch(e => {
      this.characteristic = null;
      this.ultimoErro = e.message || "Falha na reconexão";
      return { erro: this.ultimoErro };
    }).finally(() => {
      this._reconexao = null;
      this.tentandoReconectar = false;
      this._notify();
    });
    return this._reconexao;
  }

  async desconectar() {
    clearTimeout(this._timerReconexao);
    this._pararManterViva();
    if (this._onDisconnect && this._deviceOuvido) {
      try { this._deviceOuvido.removeEventListener("gattserverdisconnected", this._onDisconnect); } catch {}
    }
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch {}
    this.characteristic = null;
    this.device = null;
    this.ultimoErro = null;
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

  // Garante conexão antes de imprimir — espera a reconexão se precisar
  async garantirConexao() {
    if (this.isConnected()) return true;
    if (!this.temDispositivoSalvo()) return false;
    const r = await this.reconectarAuto();
    return !!r?.conectada;
  }
  _garantirConexao() { return this.garantirConexao(); }

  // Escreve em pedacos. Chamar sempre de dentro de _emSerie.
  async _escrever(bytes) {
    const tamanho = 100; // BLE max ~180, 100 é seguro
    for (let i = 0; i < bytes.length; i += tamanho) {
      const ch = this.characteristic;
      if (!ch || !this.device?.gatt?.connected) throw erroConexao("A impressora desconectou durante a impressão");
      const chunk = bytes.slice(i, i + tamanho);
      try {
        const escrita = ch.properties.writeWithoutResponse ? ch.writeValueWithoutResponse(chunk) : ch.writeValue(chunk);
        await comTempo(escrita, TEMPO_ESCRITA_MS, "a impressora não confirmou o envio");
      } catch (e) {
        // Falha de escrita quase sempre e conexao perdida
        this._marcarQueda("Falha ao enviar para a impressora: " + (e.message || e));
        throw erroConexao("A impressora parou de responder durante a impressão");
      }
      await new Promise(r => setTimeout(r, 30));
    }
  }

  async _print(comandos) {
    const total = comandos.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of comandos) { merged.set(c, offset); offset += c.length; }

    // Espera a reconexao (se houver) FORA da fila, para nao travar a fila
    // enquanto a impressora nao volta.
    if (!this.isConnected()) {
      const ok = await this.garantirConexao();
      if (!ok) throw erroConexao(this.temDispositivoSalvo() ? "Impressora desconectada" : "Nenhuma impressora pareada neste aparelho");
    }
    await this._emSerie(async () => {
      if (!this.isConnected()) throw erroConexao("Impressora desconectada");
      await this._escrever(merged);
    });
  }

  // ── IMPRIMIR COMANDA DA COZINHA ──
  // Foco: cozinha/churrasqueira ver O QUE preparar.
  // SEM preços, SEM totais, SEM nome do estabelecimento.
  async imprimirComanda({ mesa, label, garcom, cliente, itens, hora, obs, reimpressao }) {
    const agora = hora ? new Date(hora) : new Date();
    const cmds = [
      INIT,
      // Cabeçalho compacto
      ALIGN_CENTER, BOLD_ON,
      texto("COZINHA / GRILL"), NL,
      // Reimpressao: a cozinha precisa saber que NAO e pedido novo
      ...(reimpressao ? [SIZE_DOUBLE_H, texto("** REIMPRESSAO **"), NL, SIZE_NORMAL] : []),
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
    // Observacao da mesa em negrito, depois dos itens (a dona pediu so embaixo)
    if (obs) cmds.push(BOLD_ON, texto(`>> OBS: ${obs}`), NL, BOLD_OFF, NL);
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
  async imprimirRecibo({ mesa, cliente, garcom, itens, total, subtotal, desconto, descontoInfo, gorjeta, gorjetaInfo, pagamento, pagamentos, pagamentoTexto, abertura, fechamento, recebidoDinheiro, troco }) {
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
    cmds.push(texto("--------------------------"), NL);
    // So mostra subtotal/desconto quando houve desconto — senao poluiria o cupom
    if (Number(desconto) > 0) {
      cmds.push(ALIGN_RIGHT);
      cmds.push(texto(`Subtotal  R$ ${(Number(subtotal) || 0).toFixed(2)}`), NL);
      const rotulo = descontoInfo ? `Desconto (${removerAcentos(String(descontoInfo))})` : "Desconto";
      cmds.push(texto(`${rotulo}  -R$ ${Number(desconto).toFixed(2)}`), NL);
    }
    cmds.push(NL);
    cmds.push(ALIGN_RIGHT, SIZE_DOUBLE_H, BOLD_ON, texto(`TOTAL R$ ${(total||0).toFixed(2)}`), NL, SIZE_NORMAL, BOLD_OFF);
    // Gorjeta sai DEPOIS do total: o cliente ve o que e conta e o que e extra
    if (Number(gorjeta) > 0) {
      const rot = gorjetaInfo ? `Gorjeta (${removerAcentos(String(gorjetaInfo))})` : "Gorjeta";
      cmds.push(ALIGN_RIGHT, texto(`${rot}  +R$ ${Number(gorjeta).toFixed(2)}`), NL);
      cmds.push(BOLD_ON, texto(`A PAGAR R$ ${((Number(total)||0) + Number(gorjeta)).toFixed(2)}`), NL, BOLD_OFF);
    }
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
    // Troco: o caixa confere na hora e o cliente tambem
    if (Number(recebidoDinheiro) > 0) {
      cmds.push(ALIGN_RIGHT, texto(`Recebido em dinheiro R$ ${Number(recebidoDinheiro).toFixed(2)}`), NL);
      cmds.push(SIZE_DOUBLE_H, BOLD_ON, texto(`TROCO R$ ${(Number(troco) || 0).toFixed(2)}`), NL, SIZE_NORMAL, BOLD_OFF);
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
