import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_KB } from "./content.js";

// Převod jednoho blokového textového souboru se znalostními bázemi do
// zdrojové struktury, kterou čte importObsahu.ts. Sám na datovou složku CMS
// NESAHÁ: čte jeden soubor a vyrábí novou složku se zdrojem plus
// mapovani.json.
//
//   npm run prevod-kb -- <vstup.txt> <vystupni-slozka>            nanečisto
//   npm run prevod-kb -- <vstup.txt> <vystupni-slozka> --zapsat   opravdu zapsat
//
// Proti prevodObsahu.ts je tenhle převodník schválně hloupý. Znalostní báze
// není sada polí „Klic: Hodnota", ale volný Markdown, takže se obsah bloku
// NIJAK neparsuje: co je mezi dvěma hlavičkami, to jde do kb.md bajt po
// bajtu. Kdyby se hledaly klíče, rozsekal by se každý řádek typu
// „- Velikost: 25 až 30 cm", kterých je znalostní báze plná.
//
// Ze stejného důvodu je oddělovač bloků jen jeden a musí se dodržet:
// „=== DISPLEJ 27 ===". Volnější tvary z prevodObsahu.ts (samotné „27",
// „#27") by se pletly s Markdownem uvnitř textu.
//
// Jazyky: jen čeština (kb.md). Překlady znalostní báze neřeší ani tenhle
// převodník, ani import; kb.en.md a kb.pl.md si chatbot dělá po svém.

const NAPOVEDA = `
Převod blokového textu se znalostními bázemi do zdrojové struktury pro import

  npm run prevod-kb -- <vstup.txt> <vystupni-slozka> [--zapsat]

Vstupní soubor
  Blok displeje začíná řádkem "=== DISPLEJ 27 ===" (projde i "=== 27 ==="
  nebo "=== Displej č. 27 ==="). Všechno až po další takovou hlavičku je
  obsah kb.md pro ten displej, doslova, včetně Markdownu, nadpisů
  a odrážek typu "- Velikost: 25 cm".

  Text před první hlavičkou se ignoruje (hodí se na poznámky pro sebe).

Výstup
  <vystupni-slozka>/<NN>-kb/kb.md      znalostní báze displeje
  <vystupni-slozka>/<NN>-kb/meta.json  prázdné {}, importér ho vyžaduje
  <vystupni-slozka>/mapovani.json      { "<NN>-kb": <číslo displeje> }

  Zdroj nenese infopanel ani textový slide, takže import sáhne JEN na kb.md
  v kořeni displeje. Panely, slidy, fotky ani meta.json zůstanou být.

Jazyky
  Jen čeština. Překlady znalostní báze import neřeší.

Přepínače
  --zapsat   opravdu vytvořit výstupní složku (bez něj se jen vypíše plán)
`;

// Hlavička bloku. Číslo je povinné: "=== ČESKY ===" ani jiná omáčka bez
// čísla se za začátek bloku nepovažuje a skončí jako chyba.
const HLAVICKA_RE = /^\s*={2,}\s*(?:displej\s*)?(?:č\.?\s*)?#?\s*(\d{1,3})\s*={2,}\s*$/i;
// Hlavička, která číslo nemá. Chytáme ji zvlášť, ať kurátor dostane
// konkrétní hlášku místo tichého zahození celého bloku.
const HLAVICKA_BEZ_CISLA_RE = /^\s*={2,}\s*[^=]*\s*={2,}\s*$/;

interface Blok {
  id: string;
  radek: number; // řádek hlavičky, kvůli hlášení
  text: string;
  varovani: string[];
}

interface Problem {
  radek: number;
  zprava: string;
}

// --- Parser ------------------------------------------------------------

const ZPRAVA_PRED_HLAVICKOU =
  "text před první hlavičkou „=== DISPLEJ n ===“ se do žádného kb.md nedostane";

function parsuj(raw: string): { bloky: Blok[]; problemy: Problem[] } {
  const bloky: Blok[] = [];
  const problemy: Problem[] = [];
  const radky = raw.replace(/\r\n/g, "\n").split("\n");

  let aktualni: Blok | null = null;
  const sebrane: string[] = [];

  const uzavri = () => {
    if (!aktualni) return;
    aktualni.text = sebrane.join("\n");
    sebrane.length = 0;
  };

  radky.forEach((radek, i) => {
    const cislo = i + 1;

    const hlavicka = HLAVICKA_RE.exec(radek);
    if (hlavicka) {
      uzavri();
      aktualni = { id: String(Number(hlavicka[1])), radek: cislo, text: "", varovani: [] };
      bloky.push(aktualni);
      return;
    }

    if (HLAVICKA_BEZ_CISLA_RE.test(radek)) {
      problemy.push({
        radek: cislo,
        zprava: `„${radek.trim().slice(0, 40)}" vypadá jako hlavička, ale není v ní číslo displeje`,
      });
      return;
    }

    if (!aktualni) {
      // Text před první hlavičkou. Hlásíme jednou, ne na každém řádku.
      if (radek.trim() && problemy.every((p) => p.zprava !== ZPRAVA_PRED_HLAVICKOU)) {
        problemy.push({ radek: cislo, zprava: ZPRAVA_PRED_HLAVICKOU });
      }
      return;
    }

    sebrane.push(radek);
  });

  uzavri();
  return { bloky, problemy };
}

// --- Skládání ----------------------------------------------------------

// Zbytky kostry, které chatbot vydá za fakta o druhu. Stejný smysl má
// kontrola v CMS (web/src/lib/kbSablona.ts) před ručním uložením; tady
// hlídáme hromadný zápis, který přes UI neprojde.
const PODEZRELE: { hledej: string; popis: string }[] = [
  { hledej: "Displej zatím není přiřazen", popis: "věta z výchozí kostry" },
  { hledej: "šablona kb.md pro kurátory", popis: "hlavička staré šablony" },
  { hledej: "ai_draft_pending_curator_review", popis: "příznak AI konceptu" },
  { hledej: "TODO", popis: "nedopsaná poznámka TODO" },
  { hledej: "doplnit", popis: "nedopsaná poznámka „doplnit“" },
];

interface Druh {
  id: string;
  slozka: string;
  text: string;
  chyby: string[]; // druh se nevyexportuje
  varovani: string[]; // vyexportuje se, ale kurátor to má vidět
}

function sestav(bloky: Blok[]): Druh[] {
  const podleId = new Map<string, Blok[]>();
  for (const b of bloky) {
    const seznam = podleId.get(b.id) ?? [];
    seznam.push(b);
    podleId.set(b.id, seznam);
  }

  const druhy: Druh[] = [];
  for (const [id, jeho] of [...podleId].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const chyby: string[] = [];
    const varovani: string[] = [];

    if (jeho.length > 1) {
      varovani.push(
        `displej je v souboru ${jeho.length}×, beru poslední blok (řádek ${jeho[jeho.length - 1].radek})`,
      );
    }
    const blok = jeho[jeho.length - 1];

    // Koncové prázdné řádky pryč, writeKb() stejně zapisuje s jedním \n na
    // konci; trojité a delší mezery mezi odstavci srovnáme na jednu.
    const text = blok.text.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

    if (!text.trim()) {
      chyby.push(`blok na řádku ${blok.radek} je prázdný`);
    } else if (text.trim() === DEFAULT_KB.trim()) {
      chyby.push("blok je jen výchozí kostra, import by ji zapsal jako fakta o druhu");
    } else {
      for (const p of PODEZRELE) {
        if (text.toLowerCase().includes(p.hledej.toLowerCase())) {
          varovani.push(`v textu zůstalo „${p.hledej}“ — ${p.popis}`);
        }
      }
    }

    druhy.push({ id, slozka: `${id.padStart(2, "0")}-kb`, text, chyby, varovani });
  }
  return druhy;
}

// --- Zápis výstupu -----------------------------------------------------

async function zapis(druhy: Druh[], vystup: string): Promise<void> {
  await fs.mkdir(vystup, { recursive: true });

  for (const d of druhy) {
    const koren = path.join(vystup, d.slozka);
    await fs.mkdir(koren, { recursive: true });
    // meta.json vzniká vždycky, importér ho vyžaduje. Je prázdný schválně:
    // identita druhu (name, latin_name, section) se z KB zdroje NEBERE, aby
    // import nemohl přepsat to, co je dnes v meta.json displeje.
    await fs.writeFile(path.join(koren, "meta.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(koren, "kb.md"), d.text + "\n", "utf8");
  }

  // Mapování na čísla displejů. Klíčem je název složky: KB zdroj nenese
  // latinské jméno, takže importér páruje právě jím (druhý párovací klíč).
  const mapovani: Record<string, number> = {};
  for (const d of druhy) mapovani[d.slozka] = Number(d.id);
  await fs.writeFile(
    path.join(vystup, "mapovani.json"),
    JSON.stringify(mapovani, null, 2) + "\n",
    "utf8",
  );
}

// --- Hlavní běh --------------------------------------------------------

function radek(d: Druh): string {
  const zdroj = d.slozka.padEnd(12);
  if (d.chyby.length) {
    return [`  ⤫ ${zdroj} PŘESKOČENO`, ...d.chyby.map((c) => `      ${c}`)].join("\n");
  }
  const znaku = d.text.length;
  const radku = d.text.split("\n").length;
  const radky = [`  ✓ ${zdroj} → displej ${d.id}: kb.md, ${znaku} znaků / ${radku} řádků`];
  for (const v of d.varovani) radky.push(`      ! ${v}`);
  return radky.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const zapsat = argv.includes("--zapsat");
  const pozicni = argv.filter((a) => !a.startsWith("--"));

  if (pozicni.length < 2) {
    console.error(NAPOVEDA.trim());
    process.exit(1);
  }

  const [vstup, vystup] = pozicni;
  console.log(`Vstup:   ${path.resolve(vstup)}`);
  console.log(`Výstup:  ${path.resolve(vystup)}`);
  console.log(
    zapsat ? "Režim:   ZÁPIS" : "Režim:   NANEČISTO (nic se nezapíše, spusťte s --zapsat)",
  );
  console.log("");

  let raw: string;
  try {
    raw = await fs.readFile(vstup, "utf8");
  } catch {
    console.error(`Chyba: vstupní soubor ${vstup} se nepodařilo přečíst.`);
    process.exit(1);
  }

  const { bloky, problemy } = parsuj(raw);
  if (bloky.length === 0) {
    console.error(
      'Chyba: v souboru není ani jeden blok. Hlavička bloku je řádek "=== DISPLEJ 27 ===".',
    );
    if (problemy.length) {
      console.error("\nCo se v souboru našlo:");
      for (const p of problemy) console.error(`  řádek ${p.radek}: ${p.zprava}`);
    }
    process.exit(1);
  }

  const druhy = sestav(bloky);
  for (const d of druhy) console.log(radek(d));
  console.log("");

  if (problemy.length) {
    console.log("Problémy ve vstupním souboru:");
    for (const p of problemy) console.log(`  řádek ${p.radek}: ${p.zprava}`);
    console.log("");
  }

  const kZapsani = druhy.filter((d) => d.chyby.length === 0);
  const vynechane = druhy.filter((d) => d.chyby.length > 0);

  if (!zapsat) {
    console.log(`NANEČISTO: vyexportovalo by se ${kZapsani.length}, vynechalo ${vynechane.length}.`);
    console.log("\nOstrý běh: stejný příkaz s --zapsat");
    return;
  }

  if (kZapsani.length === 0) {
    console.error("Chyba: není co zapsat, všechny bloky mají chybu.");
    process.exit(1);
  }

  await zapis(kZapsani, vystup);
  console.log(`Hotovo: ${kZapsani.length} zdrojových složek v ${path.resolve(vystup)}.`);
  console.log("");
  console.log("Dál to vezme importér (nanečisto, nic nezapíše):");
  console.log(`  npm run import-obsahu -- ${vystup} ${path.join(vystup, "mapovani.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
