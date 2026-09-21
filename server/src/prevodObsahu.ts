import { promises as fs } from "node:fs";
import path from "node:path";

import { canonicalizeLatin } from "./latin.js";
import {
  INFO_KLICE,
  JAZYKY,
  SEKCE,
  jeSekce,
  serializeGalText,
  serializeInfoText,
  type Jazyk,
} from "./displays.js";

// Převod obsahu z blokového textového souboru do struktury složek, kterou
// čte importObsahu.ts. Sám na datovou složku CMS NESAHÁ: čte jeden textový
// soubor a vyrábí novou složku se zdrojem plus mapovani.json.
//
//   npm run prevod-obsahu -- <vstup.txt> <vystupni-slozka>            nanečisto
//   npm run prevod-obsahu -- <vstup.txt> <vystupni-slozka> --zapsat   opravdu zapsat
//
// Umí dva typy obsahu a rozezná je podle klíčů v každém bloku zvlášť:
//   _info  infopanel   (Sekce, Nazev, Latinsky, Celed, Strava, …)
//   _gal   textový slide „Informace" (ObecnyText, Zajimavost, Trida, Rad, Celed)
//
// POZOR na klíč `Celed`, který je v obou sadách a znamená pokaždé něco jiného:
//   v infopanelu je to LATINSKÁ čeleď pro chatbota (Ambystomatidae) a míří
//   do meta.json jako `section`,
//   v textovém slidu je to ČESKÁ čeleď pro návštěvníka (Rosničkovití) a míří
//   do řádku `Taxonomie:` na tabletu.
// Blok, ve kterém je `Celed` sám a nic dalšího, se proto nedá zařadit
// a skončí jako chyba s výzvou použít --typ. Nikdy se netipuje.

const NAPOVEDA = `
Převod blokového textu do zdrojové struktury pro import

  npm run prevod-obsahu -- <vstup.txt> <vystupni-slozka> [--typ=info|gal] [--zapsat]

Vstupní soubor
  Sekce jazyků odděluje řádek "=== ČESKY ===" (bere i ENGLISH, POLSKI,
  CS/EN/PL). Uvnitř sekce začíná blok displeje řádkem se samotným číslem
  ("27", "#27", "Displej 27"). Pak následují řádky "Klic: Hodnota" nebo
  "Klic - Hodnota".

  Dlouhý text může pokračovat na dalších řádcích: řádek, který nezačíná
  známým klíčem, se přilepí k poslední hodnotě.

Klíče infopanelu (_info)
  Sekce, Nazev, Latinsky, Celed (LATINSKÁ čeleď -> meta.json "section"),
  Strava, Velikost, DobaLihnuti, Ohrozeni, DelkaZivota

Klíče textového slidu (_gal)
  ObecnyText, Zajimavost (na disku "Zajimavosti"), Trida, Rad,
  Celed (ČESKÁ čeleď pro návštěvníka -> řádek "Taxonomie:")

  Trida, Rad a Celed server složí do jednoho řádku
  "Taxonomie: Třída: X | Řád: Y | Čeleď: Z". Popisky se překládají, hodnoty
  ne, takže je v každém jazyce vyplňte v tom jazyce.

Klíče se porovnávají bez ohledu na diakritiku a velikost písmen, takže
projde i "Čeleď:", "Třída -" nebo "Délka života:".

Přepínače
  --typ=info|gal  vynutí typ u bloků, které nejde rozpoznat podle klíčů
  --zapsat        opravdu vytvořit výstupní složku (bez něj se jen vypíše plán)
`;

type TypObsahu = "info" | "gal";

// --- Rozpoznávání názvů jazyků a klíčů ---------------------------------

function normalizuj(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

const JAZYK_ALIAS: Record<string, Jazyk> = {
  cesky: "cs",
  cestina: "cs",
  cs: "cs",
  czech: "cs",
  english: "en",
  anglicky: "en",
  en: "en",
  polski: "pl",
  polsky: "pl",
  polstina: "pl",
  pl: "pl",
  polish: "pl",
};

// Klíč `Celed` není pole info panelu (do text.txt infopanelu nepatří), míří
// do meta.json jako `section`. V textovém slidu má stejný název, ale jiný
// význam i cíl, proto jsou tabulky klíčů dvě.
const KLIC_CELED = "Celed";

const KLIC_INFO: Record<string, string> = {
  sekce: "Sekce",
  section: "Sekce",
  tema: "Sekce",
  nazev: "Nazev",
  jmeno: "Nazev",
  name: "Nazev",
  latinsky: "Latinsky",
  latinskynazev: "Latinsky",
  latin: "Latinsky",
  latinname: "Latinsky",
  celed: KLIC_CELED,
  family: KLIC_CELED,
  strava: "Strava",
  potrava: "Strava",
  diet: "Strava",
  food: "Strava",
  velikost: "Velikost",
  size: "Velikost",
  dobalihnuti: "DobaLihnuti",
  lihnuti: "DobaLihnuti",
  incubation: "DobaLihnuti",
  ohrozeni: "Ohrozeni",
  threat: "Ohrozeni",
  status: "Ohrozeni",
  delkazivota: "DelkaZivota",
  lifespan: "DelkaZivota",
};

// Na disku je klíč `Zajimavosti` (množné číslo), Unity DataLoader čte přesně
// ten. Ve vstupu bereme i jednotné číslo, kurátoři píšou obojí.
const KLIC_GAL: Record<string, string> = {
  obecnytext: "ObecnyText",
  obecny: "ObecnyText",
  text: "ObecnyText",
  generaltext: "ObecnyText",
  zajimavost: "Zajimavosti",
  zajimavosti: "Zajimavosti",
  facts: "Zajimavosti",
  trida: "Trida",
  class: "Trida",
  rad: "Rad",
  order: "Rad",
  celed: "Celed",
  family: "Celed",
};

// Klíče, podle kterých se pozná typ bloku. `Celed` v žádné z nich schválně
// není: je v obou sadách a sám o sobě nic neurčuje.
const SIGNAL_INFO = new Set(
  Object.entries(KLIC_INFO)
    .filter(([, cil]) => cil !== KLIC_CELED)
    .map(([alias]) => alias),
);
const SIGNAL_GAL = new Set(
  Object.entries(KLIC_GAL)
    .filter(([, cil]) => cil !== "Celed")
    .map(([alias]) => alias),
);

// Je řetězec známý klíč (v kterékoli sadě)? Podle toho se pozná začátek
// nového pole; teprve po rozpoznání typu bloku se klíč přeloží tabulkou
// toho typu.
function znamyKlic(surovy: string): boolean {
  const n = normalizuj(surovy);
  return n in KLIC_INFO || n in KLIC_GAL;
}

// --- Parser ------------------------------------------------------------

const SEKCE_JAZYKA_RE = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;
// Blok displeje: samotné číslo, případně s běžnou omáčkou kolem
// ("27", "#27", "27:", "Displej 27", "Displej č. 27").
const CISLO_BLOKU_RE = /^\s*(?:displej\s*)?(?:č\.?\s*)?#?\s*(\d{1,3})\s*[:.]?\s*$/i;

// Oddělovač klíče a hodnoty: nejdřív dvojtečka, teprve pak pomlčka. Pořadí
// je zásadní, protože hodnoty samy pomlčky obsahují (názvy sekcí mají em
// dash: "Sekce: Neotenie — původ moderních obojživelníků"). Kdyby se zkoušela
// pomlčka první, rozsekl by se takový řádek uprostřed hodnoty.
const POLE_DVOJTECKA_RE = /^\s*([^:]{1,60}?)\s*:\s*([\s\S]*)$/;
const POLE_POMLCKA_RE = /^\s*([^:\u2014\u2013-]{1,60}?)\s*[\u2014\u2013-]\s*([\s\S]*)$/;

// Vypadá řádek jako klíč, který ale neznáme? Pak je to buď překlep, nebo
// věta uvnitř dlouhého textu. Přilepíme ho k textu (o nic se nepřijde)
// a zároveň nahlásíme, ať si toho kurátor všimne.
const VYPADA_JAKO_KLIC_RE = /^\s*[^\s:\u2014\u2013-][^:\u2014\u2013-]{0,40}\s*[:\u2014\u2013-]\s/;

interface SyrovePole {
  klic: string; // syrový zápis ze souboru, kvůli hlášení
  hodnota: string;
  radek: number;
}

interface Blok {
  id: string;
  jazyk: Jazyk;
  pole: SyrovePole[];
  radek: number;
}

interface Problem {
  radek: number;
  zprava: string;
}

function rozdel(radek: string): { klic: string; hodnota: string } | null {
  const dvojtecka = POLE_DVOJTECKA_RE.exec(radek);
  if (dvojtecka && znamyKlic(dvojtecka[1])) {
    return { klic: dvojtecka[1], hodnota: dvojtecka[2] };
  }
  const pomlcka = POLE_POMLCKA_RE.exec(radek);
  if (pomlcka && znamyKlic(pomlcka[1])) {
    return { klic: pomlcka[1], hodnota: pomlcka[2] };
  }
  return null;
}

function parsuj(raw: string): { bloky: Blok[]; problemy: Problem[] } {
  const bloky: Blok[] = [];
  const problemy: Problem[] = [];
  const radky = raw.replace(/\r\n/g, "\n").split("\n");

  let jazyk: Jazyk | null = null;
  let aktualni: Blok | null = null;
  let posledniPole: SyrovePole | null = null;

  radky.forEach((radek, i) => {
    const cislo = i + 1;
    if (!radek.trim()) {
      // Prázdný řádek uvnitř dlouhého textu je odstavcová mezera, jinde
      // nic neznamená.
      if (posledniPole) posledniPole.hodnota += "\n";
      return;
    }

    const hlavicka = SEKCE_JAZYKA_RE.exec(radek);
    if (hlavicka) {
      const nalezeny = JAZYK_ALIAS[normalizuj(hlavicka[1])];
      if (!nalezeny) {
        problemy.push({ radek: cislo, zprava: `neznámý jazyk „${hlavicka[1].trim()}"` });
        jazyk = null;
      } else {
        jazyk = nalezeny;
      }
      aktualni = null;
      posledniPole = null;
      return;
    }

    const cisloBloku = CISLO_BLOKU_RE.exec(radek);
    if (cisloBloku) {
      if (!jazyk) {
        problemy.push({
          radek: cislo,
          zprava: `blok displeje ${cisloBloku[1]} je před první hlavičkou jazyka, přeskočen`,
        });
        aktualni = null;
        posledniPole = null;
        return;
      }
      aktualni = { id: String(Number(cisloBloku[1])), jazyk, pole: [], radek: cislo };
      bloky.push(aktualni);
      posledniPole = null;
      return;
    }

    const rozdelene = rozdel(radek);
    if (rozdelene) {
      if (!aktualni) {
        problemy.push({
          radek: cislo,
          zprava: `pole „${rozdelene.klic.trim()}" je mimo blok displeje, přeskočeno`,
        });
        return;
      }
      posledniPole = { klic: rozdelene.klic, hodnota: rozdelene.hodnota, radek: cislo };
      aktualni.pole.push(posledniPole);
      return;
    }

    // Pokračovací řádek dlouhého textu.
    if (posledniPole) {
      if (VYPADA_JAKO_KLIC_RE.test(radek)) {
        problemy.push({
          radek: cislo,
          zprava: `„${radek.trim().slice(0, 40)}…" vypadá jako klíč, ale žádný takový neznám; beru to jako pokračování textu`,
        });
      }
      posledniPole.hodnota += "\n" + radek;
      return;
    }

    problemy.push({ radek: cislo, zprava: `řádek nedává smysl: „${radek.trim()}"` });
  });

  return { bloky, problemy };
}

// --- Zařazení bloku k typu obsahu --------------------------------------

function urciTyp(blok: Blok, vynuceny: TypObsahu | null): TypObsahu | { chyba: string } {
  if (vynuceny) return vynuceny;
  const klice = blok.pole.map((p) => normalizuj(p.klic));
  const maInfo = klice.some((k) => SIGNAL_INFO.has(k));
  const maGal = klice.some((k) => SIGNAL_GAL.has(k));

  if (maInfo && maGal) {
    return { chyba: "blok míchá klíče infopanelu a textového slidu, rozdělte ho na dva" };
  }
  if (maInfo) return "info";
  if (maGal) return "gal";
  if (klice.includes("celed")) {
    return {
      chyba: "v bloku je jen Celed, což může být latinská čeleď (infopanel) i česká (textový slide); doplňte další klíč nebo spusťte s --typ",
    };
  }
  return { chyba: "v bloku není žádný známý klíč" };
}

// --- Skládání druhů ----------------------------------------------------

interface ObsahTypu {
  // Kanonické klíče podle typu, v každém jazyce zvlášť.
  jazyky: Partial<Record<Jazyk, Record<string, string>>>;
}

interface Druh {
  id: string;
  slozka: string;
  latin: string;
  nazev: string;
  celedLatinska: string; // jen _info -> meta.json section
  info: ObsahTypu | null;
  gal: ObsahTypu | null;
  chyby: string[]; // druh se nevyexportuje
  varovani: string[]; // vyexportuje se, ale kurátor to má vidět
}

function slug(text: string): string {
  const zaklad = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return zaklad || "druh";
}

// Syrová pole bloku -> kanonické klíče podle typu. Neznámé klíče (patřící
// druhému typu) se nahlásí a zahodí.
function prelozKlice(
  blok: Blok,
  typ: TypObsahu,
  varovani: string[],
): Record<string, string> {
  const tabulka = typ === "info" ? KLIC_INFO : KLIC_GAL;
  const pole: Record<string, string> = {};
  for (const p of blok.pole) {
    const klic = tabulka[normalizuj(p.klic)];
    if (!klic) {
      varovani.push(
        `řádek ${p.radek}: klíč „${p.klic.trim()}" do ${typ === "info" ? "infopanelu" : "textového slidu"} nepatří, přeskočen`,
      );
      continue;
    }
    const hodnota = p.hodnota.replace(/\n{3,}/g, "\n\n").trim();
    if (hodnota) pole[klic] = hodnota;
  }
  return pole;
}

function sestav(bloky: Blok[], vynuceny: TypObsahu | null): Druh[] {
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
    const podleTypu: Record<TypObsahu, ObsahTypu> = {
      info: { jazyky: {} },
      gal: { jazyky: {} },
    };
    const maTyp: Record<TypObsahu, boolean> = { info: false, gal: false };

    for (const blok of jeho) {
      const typ = urciTyp(blok, vynuceny);
      if (typeof typ !== "string") {
        chyby.push(`řádek ${blok.radek} (${blok.jazyk}): ${typ.chyba}`);
        continue;
      }
      if (podleTypu[typ].jazyky[blok.jazyk]) {
        varovani.push(
          `blok ${typ} pro ${blok.jazyk} je v souboru víckrát, beru poslední (řádek ${blok.radek})`,
        );
      }
      podleTypu[typ].jazyky[blok.jazyk] = prelozKlice(blok, typ, varovani);
      maTyp[typ] = true;
    }

    const info = maTyp.info ? podleTypu.info : null;
    const gal = maTyp.gal ? podleTypu.gal : null;

    if (!info && !gal && chyby.length === 0) {
      chyby.push("displej nemá žádný použitelný blok");
    }

    // --- Kontroly infopanelu ---
    const infoCs = info?.jazyky.cs ?? {};
    let latin = "";
    let nazev = "";
    let celedLatinska = "";
    if (info) {
      if (!info.jazyky.cs) {
        chyby.push("infopanel nemá český blok, z něj se bere identita druhu");
      }
      latin = canonicalizeLatin(infoCs.Latinsky ?? "");
      if (!latin) chyby.push("infopanel nemá Latinsky, bez něj druh nenajde chatbot");
      nazev = (infoCs.Nazev ?? "").trim();
      if (!nazev) chyby.push("infopanel nemá Nazev");

      const sekce = (infoCs.Sekce ?? "").trim();
      if (!sekce) chyby.push("infopanel nemá Sekce, bez ní import neprojde validací");
      else if (!jeSekce(sekce)) {
        chyby.push(`Sekce „${sekce}" není platná, import by displej přeskočil`);
      }

      celedLatinska = (infoCs[KLIC_CELED] ?? "").trim();
      // Prázdná čeleď není chyba, ale při importu s --prepsat by SMAZALA
      // meta.section, které na displeji dnes je. To musí kurátor vidět.
      if (!celedLatinska) {
        varovani.push(
          "infopanel nemá Celed: import s --prepsat smaže latinskou čeleď, kterou displej dnes má",
        );
      }

      for (const jazyk of JAZYKY) {
        const pole = info.jazyky[jazyk];
        if (!pole || jazyk === "cs") continue;
        if (!(pole.Nazev ?? "").trim()) {
          varovani.push(`překlad infopanelu (${jazyk}) nemá Nazev, import ho přeskočí`);
        }
      }
    }

    // --- Kontroly textového slidu ---
    if (gal) {
      const galCs = gal.jazyky.cs ?? {};
      if (!gal.jazyky.cs) {
        chyby.push("textový slide nemá český blok");
      } else if (!(galCs.ObecnyText ?? "").trim() && !(galCs.Zajimavosti ?? "").trim()) {
        chyby.push("textový slide nemá ani ObecnyText, ani Zajimavost");
      }
      for (const jazyk of JAZYKY) {
        const pole = gal.jazyky[jazyk];
        if (!pole || jazyk === "cs") continue;
        if (!(pole.ObecnyText ?? "").trim() && !(pole.Zajimavosti ?? "").trim()) {
          varovani.push(`překlad textového slidu (${jazyk}) je bez textů, zapíše se prázdný`);
        }
      }
      // Taxonomie je nepovinná, ale když je půlka, kurátor to má vědět.
      const casti = ["Trida", "Rad", "Celed"].filter((k) => (galCs[k] ?? "").trim());
      if (casti.length > 0 && casti.length < 3) {
        varovani.push(
          `taxonomie je vyplněná jen zčásti (${casti.join(", ")}), chybějící část se na tabletu vynechá`,
        );
      }
    }

    druhy.push({
      id,
      slozka: `${id.padStart(2, "0")}-${slug(latin || nazev || (gal ? "informace" : id))}`,
      latin,
      nazev,
      celedLatinska,
      info,
      gal,
      chyby,
      varovani,
    });
  }
  return druhy;
}

// --- Zápis výstupu -----------------------------------------------------

// Do text.txt infopanelu jdou jen pole INFO_KLICE, Celed ne (ten patří do
// meta.json). Sekce a Latinsky se zapisují jen v češtině: do překladů si je
// server doplní sám podle SEKCE_TEMATA, hodnota ze zdroje by se přepsala.
function infoTextProJazyk(pole: Record<string, string>, jazyk: Jazyk): string {
  const kZapisu: Record<string, string> = {};
  for (const klic of INFO_KLICE) {
    if (jazyk !== "cs" && (klic === "Sekce" || klic === "Latinsky")) continue;
    const hodnota = (pole[klic] ?? "").trim();
    if (hodnota) kZapisu[klic] = hodnota;
  }
  return serializeInfoText(kZapisu);
}

async function zapisText(koren: string, jazyk: Jazyk, slozka: string, text: string) {
  if (!text.trim()) return;
  const dir = path.join(koren, jazyk, slozka);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "text.txt"), text, "utf8");
}

async function zapis(druhy: Druh[], vystup: string): Promise<void> {
  await fs.mkdir(vystup, { recursive: true });

  for (const d of druhy) {
    const koren = path.join(vystup, d.slozka);
    await fs.mkdir(koren, { recursive: true });

    // meta.json vzniká vždycky, importér ho vyžaduje. U zdroje, který nese
    // jen textový slide, je skoro prázdný: identita druhu se z něj nebere.
    const meta: Record<string, string> = {};
    if (d.nazev) meta.name = d.nazev;
    if (d.latin) meta.latin_name = d.latin;
    // Prázdnou čeleď do meta.json nepíšeme vůbec: prázdný řetězec by při
    // importu meta.section smazal stejně jako chybějící klíč.
    if (d.celedLatinska) meta.section = d.celedLatinska;
    await fs.writeFile(path.join(koren, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

    for (const jazyk of JAZYKY) {
      if (d.info?.jazyky[jazyk]) {
        await zapisText(koren, jazyk, "1_info", infoTextProJazyk(d.info.jazyky[jazyk]!, jazyk));
      }
      if (d.gal?.jazyky[jazyk]) {
        // Formát skládá přímo server (serializeGalText), takže výstup je bit
        // po bitu tentýž, jaký by vznikl uložením slidu v CMS. Včetně řádku
        // "Taxonomie: Třída: … | Řád: … | Čeleď: …" s popisky v daném jazyce.
        await zapisText(koren, jazyk, "1_gal", serializeGalText(d.gal.jazyky[jazyk]!, jazyk));
      }
    }
  }

  // Mapování na čísla displejů. Klíčem je latinské jméno, když ho známe
  // (importér ho páruje kanonizovaně), jinak název zdrojové složky, který
  // importér bere jako druhý párovací klíč. Zdroj jen s textovým slidem
  // latinské jméno nemá, a mít ho nemusí.
  const mapovani: Record<string, number> = {};
  for (const d of druhy) mapovani[d.latin || d.slozka] = Number(d.id);
  await fs.writeFile(
    path.join(vystup, "mapovani.json"),
    JSON.stringify(mapovani, null, 2) + "\n",
    "utf8",
  );
}

// --- Hlavní běh --------------------------------------------------------

function popisObsahu(d: Druh): string {
  const kusy: string[] = [];
  if (d.info) kusy.push(`infopanel (${JAZYKY.filter((j) => d.info!.jazyky[j]).join(" + ")})`);
  if (d.gal) kusy.push(`textový slide (${JAZYKY.filter((j) => d.gal!.jazyky[j]).join(" + ")})`);
  return kusy.join(", ");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const zapsat = argv.includes("--zapsat");
  const typArg = argv.find((a) => a.startsWith("--typ"));
  const pozicni = argv.filter((a) => !a.startsWith("--"));

  let vynuceny: TypObsahu | null = null;
  if (typArg) {
    const hodnota = typArg.split("=")[1];
    if (hodnota !== "info" && hodnota !== "gal") {
      console.error("Chyba: --typ musí být --typ=info nebo --typ=gal.");
      process.exit(1);
    }
    vynuceny = hodnota;
  }

  if (pozicni.length < 2) {
    console.error(NAPOVEDA.trim());
    process.exit(1);
  }
  const [vstupniSoubor, vystupniSlozka] = pozicni;

  let raw: string;
  try {
    raw = await fs.readFile(vstupniSoubor, "utf8");
  } catch {
    console.error(`Chyba: vstupní soubor ${vstupniSoubor} se nepodařilo přečíst.`);
    process.exit(1);
  }

  console.log(`Vstup:   ${path.resolve(vstupniSoubor)}`);
  console.log(`Výstup:  ${path.resolve(vystupniSlozka)}`);
  console.log(`Typ:     ${vynuceny ? `vynucen (${vynuceny})` : "podle klíčů v každém bloku"}`);
  console.log(
    zapsat ? "Režim:   ZÁPIS" : "Režim:   NANEČISTO (nic se nezapíše, spusťte s --zapsat)",
  );
  console.log("");

  const { bloky, problemy } = parsuj(raw);
  if (bloky.length === 0) {
    console.error("Chyba: ve vstupu nejsou žádné bloky displejů.");
    console.error("Zkontrolujte, že soubor má hlavičky jazyků a čísla displejů.");
    if (problemy.length) {
      console.error("\nCo se nepodařilo přečíst:");
      for (const p of problemy) console.error(`  řádek ${p.radek}: ${p.zprava}`);
    }
    process.exit(1);
  }

  const druhy = sestav(bloky, vynuceny);
  const dobre = druhy.filter((d) => d.chyby.length === 0);
  const spatne = druhy.filter((d) => d.chyby.length > 0);

  for (const d of druhy) {
    if (d.chyby.length) {
      console.log(`  ⤫ displej ${d.id.padEnd(3)} NEVYEXPORTUJE SE`);
      for (const ch of d.chyby) console.log(`      • ${ch}`);
      continue;
    }
    console.log(`  ✓ displej ${d.id.padEnd(3)} ${d.latin || "(bez latinského jména)"}`);
    console.log(`      ${popisObsahu(d)}`);
    console.log(`      složka ${d.slozka}, latinská čeleď ${d.celedLatinska || "—"}`);
    for (const v of d.varovani) console.log(`      ! ${v}`);
  }

  if (problemy.length) {
    console.log("");
    console.log("Řádky, které se nepodařilo přečíst:");
    for (const p of problemy) console.log(`  řádek ${p.radek}: ${p.zprava}`);
  }

  console.log("");
  console.log(`Vyexportovat: ${dobre.length}, s chybou: ${spatne.length}`);
  console.log(`Platné sekce: ${SEKCE.length} (viz SEKCE_TEMATA v server/src/displays.ts)`);

  if (!zapsat) {
    console.log("\nOstrý běh: stejný příkaz s --zapsat");
    return;
  }
  if (dobre.length === 0) {
    console.error("\nNení co zapsat, všechny druhy mají chybu.");
    process.exit(1);
  }

  await zapis(dobre, vystupniSlozka);
  console.log("");
  console.log(`Zapsáno do ${path.resolve(vystupniSlozka)}`);
  console.log("Další krok (nanečisto, nic nezapíše):");
  console.log(
    `  npm run import-obsahu -- ${vystupniSlozka} ${path.join(vystupniSlozka, "mapovani.json")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
