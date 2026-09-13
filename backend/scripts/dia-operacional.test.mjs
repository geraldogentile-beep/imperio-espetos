// Testa a janela do expediente (06:00 as 06:00) sem precisar de banco.
//
//   node scripts/dia-operacional.test.mjs
//
// Motivo: a casa fecha 00:00. Contando o dia pela data civil, a comanda
// fechada 00:30 caia no dia seguinte -- e o fechamento do caixa da manha
// aparecia com "valores de ontem". Pior: fechar o caixa depois da meia-noite
// pegava a janela do dia NOVO e deixava a noite inteira de fora.

import fs from "fs";

const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const ini = src.indexOf("function janelaDiaOperacional");
const fim = src.indexOf("// ── FILA DE IMPRESSÃO");
const { janelaDiaOperacional, diaOperacional } = new Function(
  src.slice(ini, fim) + "\nreturn { janelaDiaOperacional, diaOperacional };"
)();

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Sabado 12/09/2026 e domingo 13/09
const em = (dia, h, min = 0) => new Date(2026, 8, dia, h, min, 0, 0);
const fmt = (d) => `${String(d.getDate()).padStart(2,"0")}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;

console.log("\n=== a noite de sabado é um expediente só ===");
{
  const abertura  = janelaDiaOperacional(em(12, 17, 0));   // abre 17:00 sabado
  const pico      = janelaDiaOperacional(em(12, 22, 30));  // pico
  const ultima    = janelaDiaOperacional(em(13, 0, 30));   // comanda 00:30 domingo
  const fechaCaixa= janelaDiaOperacional(em(13, 1, 15));   // caixa fecha 01:15

  ok(abertura.dataStr === "2026-09-12", `17:00 sáb -> ${abertura.dataStr}`);
  ok(pico.dataStr === "2026-09-12",     `22:30 sáb -> ${pico.dataStr}`);
  ok(ultima.dataStr === "2026-09-12",   `00:30 dom -> ${ultima.dataStr} (ainda é o sábado)`);
  ok(fechaCaixa.dataStr === "2026-09-12", `01:15 dom -> ${fechaCaixa.dataStr} (o caixa fecha o sábado)`);
  ok(abertura.inicio.getTime() === fechaCaixa.inicio.getTime(), "os quatro caem na MESMA janela");
}

console.log("\n=== a venda de 00:30 entra no fechamento certo ===");
{
  const { inicio, fim } = janelaDiaOperacional(em(13, 1, 15));   // caixa fechando 01:15 dom
  const dentro = [em(12, 18, 0), em(12, 23, 50), em(13, 0, 30)];
  const fora   = [em(12, 5, 0), em(13, 8, 0)];
  ok(dentro.every(d => d >= inicio && d < fim), "18:00, 23:50 e 00:30 estão na janela");
  ok(fora.every(d => !(d >= inicio && d < fim)), "05:00 de sáb e 08:00 de dom ficam de fora");
  console.log(`         janela: ${fmt(inicio)} → ${fmt(fim)}`);
}

console.log("\n=== o novo expediente começa às 06:00 ===");
{
  const antes  = janelaDiaOperacional(em(13, 5, 59));
  const depois = janelaDiaOperacional(em(13, 6, 1));
  ok(antes.dataStr === "2026-09-12",  `05:59 dom -> ${antes.dataStr}`);
  ok(depois.dataStr === "2026-09-13", `06:01 dom -> ${depois.dataStr}`);
  ok(antes.dataStr !== depois.dataStr, "a virada acontece às 06:00, não à meia-noite");
}

console.log("\n=== a janela nunca deixa buraco nem sobreposição ===");
{
  let furos = 0;
  for (let h = 0; h < 24; h++) {
    const a = janelaDiaOperacional(em(13, h, 0));
    const d = em(13, h, 0);
    if (!(d >= a.inicio && d < a.fim)) furos++;
  }
  ok(furos === 0, `as 24 horas do dia caem dentro da própria janela (${furos} furos)`);

  const j1 = janelaDiaOperacional(em(12, 12, 0));
  const j2 = janelaDiaOperacional(em(13, 12, 0));
  ok(j1.fim.getTime() === j2.inicio.getTime(), "o fim de uma janela é o início da seguinte");
}

console.log("\n=== diaOperacional e janelaDiaOperacional concordam ===");
{
  const horas = [0, 3, 5, 6, 7, 12, 18, 23];
  const iguais = horas.every(h => diaOperacional(em(13, h, 0)) === janelaDiaOperacional(em(13, h, 0)).dataStr);
  ok(iguais, "mesas e fechamento usam exatamente o mesmo dia");
}

console.log(falhas === 0 ? "\nTUDO PASSOU\n" : `\n${falhas} FALHA(S)\n`);
process.exit(falhas === 0 ? 0 : 1);
