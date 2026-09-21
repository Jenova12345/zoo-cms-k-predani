import { promises as fs } from "node:fs";
import path from "node:path";

import { DISPLAYS_DIR } from "./paths.js";
import { DEFAULT_KB } from "./content.js";
import { KB_SEKCE } from "./kbTemplate.js";
// Parser strukturovaného editoru. Je jen jeden, ve webu, a tenhle skript ho
// spouští přímo na něm: kdyby se kopíroval sem, mohly by se rozejít a editor
// by mlčky mrvil obsah. Modul je bez Reactu i bez DOM, tsx ho přeloží.
import { SEKCE, rozdelKb, slozKb } from "../../web/src/lib/kbSekce.js";

// Kontrola strukturované znalostní báze. Nic nezapisuje, jen čte.
//
//   npm run kb-check
//
// Ověřuje dvě věci:
//
// 1) Seznam nadpisů na serveru (kostra pro nový druh) je shodný se seznamem,
//    podle kterého editor parsuje a skládá. Kdyby se rozešly, editor by
//    zapisoval nadpisy, které kostra nezná, a Danovu chatbotu by přestaly
//    sedět sekce.
//
// 2) Nad KAŽDÝM kb.md v datové složce: rozdelKb() -> slozKb() neztratí ani
//    řádek textu. To je celý smysl editoru; jakmile tohle přestane platit,
//    otevření a uložení KB v CMS tiše sežere obsah, který kurátor psal.
//    U souboru, který je už v kanonickém tvaru, musí být výsledek shodný
//    bajt po bajtu.

interface Nalez {
  soubor: string;
  chyby: string[];
  poznamky: string[];
  kanonicky: boolean;
}

// Soubor, který drží jen zástupný text seedu. Nekontroluje se, jen se počítá.
interface Zastupny {
  zastupny: true;
}

function jeZastupny(n: Nalez | Zastupny): n is Zastupny {
  return "zastupny" in n;
}

// Řádky, které nesou obsah. Nadpisy `## …` se při složení přepisují na
// kanonické znění (a prázdné sekce mizí), takže se porovnávají zvlášť.
function obsahoveRadky(text: string): string[] {
  return text
    .split("\n")
    .map((r) => r.replace(/[ \t]+$/, "").trim())
    .filter((r) => r !== "" && !/^##[ \t]+/.test(r));
}

async function zkontrolujSoubor(
  cesta: string,
  nazev: string,
): Promise<Nalez | Zastupny | null> {
  let raw: string;
  try {
    raw = await fs.readFile(cesta, "utf8");
  } catch {
    return null;
  }
  // Stejná úprava, jakou dělá readKb() na serveru: to je text, který dostane
  // editor, a jeho se kontrola týká.
  const puvodni = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!puvodni.trim()) return null;
  // Zástupný text u nepřiřazeného displeje editor do polí ZÁMĚRNĚ nepřenáší
  // (nepsal ho kurátor a není co rozdělovat), takže ho sem netaháme jako
  // ztrátu obsahu. Počítá se zvlášť.
  if (puvodni.trim() === DEFAULT_KB.trim()) return { zastupny: true };

  const rozdelena = rozdelKb(puvodni);
  const slozena = slozKb(rozdelena);

  const chyby: string[] = [];

  // a) Žádný obsahový řádek se nesmí ztratit.
  const pred = obsahoveRadky(puvodni);
  const po = new Set(obsahoveRadky(slozena));
  const ztracene = pred.filter((r) => !po.has(r));
  if (ztracene.length) {
    chyby.push(
      `ztratilo se ${ztracene.length} řádků, např.: ${ztracene
        .slice(0, 3)
        .map((r) => `„${r.slice(0, 60)}“`)
        .join(", ")}`,
    );
  }

  // b) Druhý průchod už nesmí nic změnit. Do sekce „Další" se ukládají
  // i původní `## nadpisy`, které při dalším otevření znovu projdou
  // parserem; kdyby se u nich přidával prázdný řádek nebo se obsah
  // přeskládal, nabalovalo by se to s každým uložením.
  const podruhe = slozKb(rozdelKb(slozena));
  if (podruhe !== slozena) {
    const a = slozena.split("\n");
    const b = podruhe.split("\n");
    const kde = a.findIndex((r, i) => r !== b[i]);
    chyby.push(
      `druhé uložení text změnilo (řádek ${kde + 1}: „${a[kde] ?? "(nic)"}“ -> „${b[kde] ?? "(nic)"}“)`,
    );
  }

  // c) Soubor už v kanonickém tvaru musí projít beze změny.
  const kanonicky = puvodni === slozena;

  return { soubor: nazev, chyby, poznamky: rozdelena.poznamky, kanonicky };
}

// Ukázka v dohodnutém tvaru (tak vypadá startovací KB od Dana). Na téhle se
// hlídá to nejpřísnější: rozdelKb() -> slozKb() musí vrátit BAJT PO BAJTU
// tentýž soubor. Reálné kb.md v datové složce jsou zatím ve starém tvaru,
// takže by na to samy nestačily.
const DANUV_TVAR = `# Znalostní báze: Axolotl mexický

## Popis
Ocasatý obojživelník, 25 až 30 cm. Celý život si zachovává larvální podobu.

## Potrava
Loví drobné vodní bezobratlé, larvy hmyzu a červy.

## Habitat
Kanály Xochimilco poblíž Ciudad de México, sladká voda v 2 200 m n. m.

## Chování
Aktivní hlavně za šera. Většinu času tráví u dna.

## Rozmnožování
Samice klade 100 až 300 vajíček na vodní rostliny.

## Zajímavosti
Dokáže obnovit ztracenou končetinu i části srdce a míchy, bez jizev.

## Ohrožení
Kriticky ohrožený: znečištění vody, úbytek biotopu, invazní ryby.

## V naší expozici
Máme čtyři jedince. Nejlépe jsou vidět dopoledne, než se zavrtají.

## Další
Neotenie je jev, kdy si živočich do dospělosti drží larvální znaky.`;

function zkontrolujDanuvTvar(): boolean {
  const slozena = slozKb(rozdelKb(DANUV_TVAR));
  if (slozena === DANUV_TVAR) {
    console.log("  ✓ soubor v dohodnutém tvaru projde beze změny (bajt po bajtu)");
    return true;
  }
  console.error("  CHYBA: soubor v dohodnutém tvaru se při průchodu editorem změnil");
  const a = DANUV_TVAR.split("\n");
  const b = slozena.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) console.error(`    řádek ${i + 1}: „${a[i] ?? "(nic)"}“ -> „${b[i] ?? "(nic)"}“`);
  }
  return false;
}

async function main(): Promise<void> {
  let selhalo = false;

  // --- 1) Kostra na serveru vs. sekce v editoru ---
  console.log("Sekce: server/src/kbTemplate.ts vs web/src/lib/kbSekce.ts");
  const naServeru = [...KB_SEKCE];
  const vEditoru = SEKCE.map((s) => s.nadpis);
  if (naServeru.join("|") !== vEditoru.join("|")) {
    selhalo = true;
    console.error("  CHYBA: seznamy se rozešly");
    console.error(`    server: ${naServeru.join(", ")}`);
    console.error(`    editor: ${vEditoru.join(", ")}`);
  } else {
    console.log(`  ✓ shodné, ${naServeru.length} sekcí: ${naServeru.join(", ")}`);
  }
  console.log("");

  // --- 2) Průchod souboru v dohodnutém tvaru ---
  console.log("Formát dohodnutý s Danem");
  if (!zkontrolujDanuvTvar()) selhalo = true;
  console.log("");

  // --- 3) Bezztrátovost nad reálnými daty ---
  console.log(`Znalostní báze v ${DISPLAYS_DIR}`);
  let slozky: string[];
  try {
    const entries = await fs.readdir(DISPLAYS_DIR, { withFileTypes: true });
    slozky = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    console.error(`  CHYBA: datovou složku ${DISPLAYS_DIR} se nepodařilo přečíst.`);
    process.exit(1);
  }

  let zkontrolovano = 0;
  let kanonickych = 0;
  let zastupnych = 0;
  const sPoznamkou: Nalez[] = [];

  for (const slozka of slozky) {
    // Čeština i případné překlady, parser je na jazyku nezávislý.
    for (const soubor of ["kb.md", "kb.en.md", "kb.pl.md"]) {
      const nalez = await zkontrolujSoubor(
        path.join(DISPLAYS_DIR, slozka, soubor),
        `${slozka}/${soubor}`,
      );
      if (!nalez) continue;
      if (jeZastupny(nalez)) {
        zastupnych++;
        continue;
      }
      zkontrolovano++;
      if (nalez.kanonicky) kanonickych++;
      if (nalez.chyby.length) {
        selhalo = true;
        console.error(`  ✗ ${nalez.soubor}`);
        for (const c of nalez.chyby) console.error(`      ${c}`);
      } else if (nalez.poznamky.length) {
        sPoznamkou.push(nalez);
      }
    }
  }

  console.log(
    `  ✓ ${zkontrolovano} souborů prošlo bez ztráty řádku (${kanonickych} už v kanonickém tvaru)`,
  );
  if (zastupnych) {
    console.log(`  · ${zastupnych}× jen zástupný text seedu, editor ho nepřenáší (záměr)`);
  }

  if (sPoznamkou.length) {
    console.log("");
    console.log("Co editor kurátorovi nahlásí při otevření:");
    for (const n of sPoznamkou) {
      console.log(`  ${n.soubor}`);
      for (const p of n.poznamky) console.log(`      • ${p}`);
    }
  }

  console.log("");
  if (selhalo) {
    console.error("NEPROŠLO.");
    process.exit(1);
  }
  console.log("Vše v pořádku.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
