import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DATA_ROOT } from "./paths.js";
import { appendAudit } from "./audit.js";
import { DEFAULT_KB } from "./content.js";
import { canonicalizeLatin } from "./latin.js";
import {
  JAZYKY,
  NEPRIRAZENO,
  addSlide,
  displayExists,
  oznacRevizi,
  parseGalText,
  parseInfoText,
  readKb,
  readMeta,
  readSlides,
  validateInfoPole,
  writeGalPole,
  writeInfoPole,
  writeKb,
  type Jazyk,
} from "./displays.js";

// Hromadný import obsahu do CMS z připravené složky, kde má každý druh
// vlastní podsložku. Umí infopanel (_info), textový slide „Informace"
// (_gal) a znalostní bázi, všechno ve všech třech jazycích.
//
// Zdrojová složka nemusí nést všechno: import se řídí tím, co v ní opravdu
// je. Zdroj jen s textovým slidem nebo jen se znalostní bází nepotřebuje ani
// latinské jméno, ani sekci, a NEVOLÁ se u něj writeInfoPole(), takže se nemá
// jak dotknout identity druhu v meta.json.
//
//   npm run import-obsahu -- <zdroj> <mapovani.json>              nanečisto (výchozí)
//   npm run import-obsahu -- <zdroj> <mapovani.json> --zapsat     opravdu zapsat
//   npm run import-obsahu -- <zdroj> <mapovani.json> --zapsat --prepsat
//
// ZÁSADNÍ: nic se nezapisuje přes holé fs. Všechno jde stejnou cestou jako
// když obsah uloží kurátor v CMS, přes writeInfoPole() a writeKb() z
// displays.ts. Tím projde validace povinných polí, kanonizace latinského
// jména, atomický zápis (tmp + rename kvůli file watcheru chatbota),
// propsání identity do meta.json i signál k reingestu. Import navíc zapisuje
// vlastní řádky do audit logu, aby šlo poznat, co je hromadný import a co
// ruční práce kurátora.

const NAPOVEDA = `
Hromadný import obsahu do CMS Amphibiárium

  npm run import-obsahu -- <zdrojova-slozka> <mapovani.json> [prepinace]

Zdrojová složka: pro každý druh jedna podsložka s
  meta.json          (name, latin_name; volitelně section a příznak AI konceptu)
  kb.md              znalostní báze pro chatbota (VYNECHEJTE, když ji
                     nechcete přepsat: prázdná nebo chybějící se neimportuje)
  <jazyk>/<n>_info/text.txt  pole info panelu ve tvaru "Klic: Hodnota"
  <jazyk>/<n>_gal/text.txt   textový slide (ObecnyText, Zajimavosti, Taxonomie)

Čeština je povinná, en/pl volitelné. V překladu infopanelu stačí přeložená
pole (Nazev, Strava, …), sekci a latinské jméno si server doplní z češtiny.
Znalostní báze se importuje jen česky (kb.md); kb.en.md a kb.pl.md import
neřeší. Zdrojová složka musí nést aspoň jednu z těch tří věcí, klidně jen
kb.md: takový zdroj se páruje názvem složky a slidů se vůbec nedotkne.

Cílový slide se na displeji hledá podle TYPU, ne podle čísla ve zdroji:
existující _info/_gal se přepíše, chybějící se založí na konci.

Mapovací soubor: JSON { "<klíč>": <číslo displeje> }, kde klíč je
  latinský název druhu (párovací klíč), nebo název zdrojové podsložky.
  Příklad: { "Dendrobates tinctorius": 12, "axolotl": 1 }

Přepínače
  --nanecisto   jen vypíše, co by se stalo (VÝCHOZÍ, nic nezapíše)
  --zapsat      opravdu zapsat do datové složky
  --prepsat     přepsat i displeje, které už obsah mají (jinak se přeskočí)
`;

interface ZdrojovaMeta {
  name?: string;
  latin_name?: string;
  section?: string;
  status?: string;
  ai_draft_pending_curator_review?: boolean;
}

type Duvod = string;

// Obsah jednoho typu slidu ve zdrojové složce, po jazycích. Čeština je
// zdroj pravdy, en/pl jsou volitelné překlady.
interface ObsahTypu {
  cs: Record<string, string>;
  preklady: Partial<Record<Jazyk, Record<string, string>>>;
  // Jazyky, které zdroj má, ale neprojdou. Neblokují import češtiny, jen se
  // vypíšou, ať o nich kurátor ví.
  vadnePreklady: { jazyk: Jazyk; duvod: Duvod }[];
  novySlide: boolean; // displej slide tohoto typu ještě nemá, bude se zakládat
}

interface Polozka {
  slozka: string;
  latin: string;
  nazev: string;
  displej?: string;
  kb: string;
  // Co zdrojová složka nese. `null` = tenhle typ obsahu ve zdroji není
  // a import se ho ani nedotkne.
  info: ObsahTypu | null;
  gal: ObsahTypu | null;
  section: string;
  cekaNaRevizi: boolean;
  prepisuje: string[]; // co na cílovém displeji dnes je (jen s --prepsat)
  poznamky: string[]; // co má kurátor vidět, ale nebrání to importu
  preskocit?: Duvod;
}

// --- Čtení zdroje ------------------------------------------------------

// Najde ve zdrojové složce podsložku slidu daného typu (<n>_info, <n>_gal).
// Číslo je jen štítek, cílový slide se na displeji hledá podle typu, takže
// bereme první, která sedí; převodník vyrábí vždycky "1_info" a "1_gal".
async function najdiSlozkuSlidu(
  cesta: string,
  jazyk: Jazyk,
  typ: "info" | "gal",
): Promise<string | null> {
  const re = new RegExp(`^\\d+_${typ}$`);
  try {
    const polozky = await fs.readdir(path.join(cesta, jazyk), { withFileTypes: true });
    const nalezene = polozky
      .filter((e) => e.isDirectory() && re.test(e.name))
      .map((e) => e.name)
      .sort();
    return nalezene[0] ?? null;
  } catch {
    return null;
  }
}

// Načte jeden typ obsahu ve všech jazycích. Vrací null, když zdroj tenhle
// typ vůbec nemá: takový import se ho pak ani nedotkne.
async function nactiTyp(
  cesta: string,
  typ: "info" | "gal",
  parsuj: (raw: string) => Record<string, string>,
  overPreklad: (pole: Record<string, string>, jazyk: Jazyk) => string | null,
): Promise<ObsahTypu | null> {
  const slozkaCs = await najdiSlozkuSlidu(cesta, "cs", typ);
  if (!slozkaCs) return null;
  const raw = await precti(path.join(cesta, "cs", slozkaCs, "text.txt"));
  if (!raw.trim()) return null;

  const preklady: ObsahTypu["preklady"] = {};
  const vadnePreklady: ObsahTypu["vadnePreklady"] = [];
  for (const jazyk of JAZYKY) {
    if (jazyk === "cs") continue;
    const slozka = await najdiSlozkuSlidu(cesta, jazyk, typ);
    if (!slozka) continue;
    const rawJazyk = await precti(path.join(cesta, jazyk, slozka, "text.txt"));
    if (!rawJazyk.trim()) continue;
    const prelozene = parsuj(rawJazyk);
    const chyba = overPreklad(prelozene, jazyk);
    if (chyba) {
      vadnePreklady.push({ jazyk, duvod: chyba.toLowerCase() });
      continue;
    }
    preklady[jazyk] = prelozene;
  }

  return { cs: parsuj(raw), preklady, vadnePreklady, novySlide: false };
}

// Textový slide nemá povinná pole jako infopanel; prázdný překlad ale nemá
// smysl zapisovat, přepsal by tím to, co v jazyce dnes je.
function overGalPreklad(pole: Record<string, string>): string | null {
  const maText = (pole.ObecnyText ?? "").trim() || (pole.Zajimavosti ?? "").trim();
  return maText ? null : "Chybí oba texty.";
}

async function nactiZdroj(korenn: string, slozka: string): Promise<Polozka> {
  const zaklad: Polozka = {
    slozka,
    latin: "",
    nazev: "",
    kb: "",
    info: null,
    gal: null,
    section: "",
    cekaNaRevizi: false,
    prepisuje: [],
    poznamky: [],
  };
  const cesta = path.join(korenn, slozka);

  let meta: ZdrojovaMeta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(cesta, "meta.json"), "utf8")) as ZdrojovaMeta;
  } catch {
    return { ...zaklad, preskocit: "meta.json chybí nebo není platný JSON" };
  }

  const kb = await precti(path.join(cesta, "kb.md"));

  const info = await nactiTyp(cesta, "info", parseInfoText, (pole, jazyk) =>
    validateInfoPole(pole, jazyk),
  );
  const gal = await nactiTyp(cesta, "gal", parseGalText, (pole) => overGalPreklad(pole));

  // Zdroj smí nést jen znalostní bázi: kb.md je samostatný obsah v kořeni
  // displeje, ne slide, takže se import nemá čeho dalšího chytat. Latinské
  // jméno takový zdroj nemá odkud vzít a nepotřebuje ho, na displej se páruje
  // názvem složky a identity v meta.json se nedotkne (writeKb sahá jen na
  // kb.md). Prázdný zdroj ale pořád nedává smysl.
  if (!info && !gal && !kb.trim()) {
    return { ...zaklad, kb, preskocit: "zdroj nemá ani info panel, ani textový slide, ani znalostní bázi" };
  }

  // Latinské jméno je identita druhu pro chatbota a bere se z infopanelu.
  // Zdroj, který nese jen textový slide, ho nemá odkud vzít a nepotřebuje ho:
  // na displej se páruje názvem složky a identity v meta.json se nedotkne.
  const latin = canonicalizeLatin((meta.latin_name ?? "").trim());
  if (info && !latin) {
    return {
      ...zaklad,
      kb,
      nazev: meta.name ?? "",
      preskocit: "zdroj má info panel, ale v meta.json chybí latin_name",
    };
  }

  if (info) {
    // Identita z meta.json doplní to, co v text.txt chybí (zdrojem pravdy pro
    // pole zůstává text.txt, protože přesně to čte tablet).
    if (!(info.cs.Nazev ?? "").trim() && meta.name) info.cs.Nazev = meta.name.trim();
    if (!(info.cs.Latinsky ?? "").trim()) info.cs.Latinsky = latin;
  }

  if (gal && !(gal.cs.ObecnyText ?? "").trim() && !(gal.cs.Zajimavosti ?? "").trim()) {
    return { ...zaklad, kb, latin, preskocit: "textový slide nemá ani jeden z obou textů" };
  }

  return {
    ...zaklad,
    latin,
    nazev: (info?.cs.Nazev ?? meta.name ?? "").trim(),
    kb,
    info,
    gal,
    section: (meta.section ?? "").trim(),
    cekaNaRevizi: jeAiKoncept(meta, kb),
  };
}

async function precti(cesta: string): Promise<string> {
  try {
    return await fs.readFile(cesta, "utf8");
  } catch {
    return "";
  }
}

// Příznak AI konceptu bereme odkudkoliv, kde ho generátor může nechat,
// z meta.json (boolean nebo status) i z textu kb.md.
function jeAiKoncept(meta: ZdrojovaMeta, kb: string): boolean {
  const PRIZNAK = "ai_draft_pending_curator_review";
  if (meta.ai_draft_pending_curator_review === true) return true;
  if (typeof meta.status === "string" && meta.status.includes(PRIZNAK)) return true;
  return kb.includes(PRIZNAK);
}

// --- Mapování zdroj → displej -----------------------------------------

function normalizuj(klic: string): string {
  return klic.trim().toLowerCase().replace(/\s+/g, " ");
}

async function nactiMapovani(soubor: string): Promise<Map<string, string>> {
  const raw = JSON.parse(await fs.readFile(soubor, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Mapovací soubor musí být JSON objekt { \"klíč\": číslo displeje }.");
  }
  const mapa = new Map<string, string>();
  for (const [klic, hodnota] of Object.entries(raw)) {
    const id = String(hodnota).trim();
    if (!/^\d+$/.test(id)) {
      throw new Error(`Mapování "${klic}": "${String(hodnota)}" není číslo displeje.`);
    }
    mapa.set(normalizuj(klic), id);
    // Klíčem smí být i latinský název v jiném tvaru než kanonickém.
    mapa.set(normalizuj(canonicalizeLatin(klic)), id);
  }
  return mapa;
}

// --- Stav cílového displeje -------------------------------------------

// Co na displeji je, rozdělené podle toho, čeho by se import mohl dotknout.
// Zámek „displej už má obsah" je totiž TYPOVĚ CITLIVÝ: import textového
// slidu nemá být blokovaný tím, že displej má vyplněný infopanel, protože
// se ho ani nedotkne. Kdyby byl zámek společný, kurátor by musel pouštět
// --prepsat i tam, kde se nic nepřepisuje, a tím by si odemkl i přepis
// všeho ostatního.
//
// Do `jine` jde všechno, co import nikdy nepřepisuje (galerie, videa, 3D,
// obecné informace). Vypisuje se jen pro přehled, na rozhodování nemá vliv.
interface StavDispleje {
  info: string[];
  gal: string[];
  kb: string[];
  jine: string[];
}

async function coJeNaDispleji(id: string): Promise<StavDispleje> {
  const stav: StavDispleje = { info: [], gal: [], kb: [], jine: [] };
  const meta = await readMeta(id);
  if (meta && meta.druh !== NEPRIRAZENO) stav.info.push(`druh „${meta.druh}"`);
  // Seed zakládá u nepřiřazených displejů zástupný text, ten se nepočítá
  // jako obsah, jinak by import nemohl obsadit žádný volný displej.
  const kb = (await readKb(id)).trim();
  if (kb && kb !== DEFAULT_KB.trim()) stav.kb.push("znalostní bázi");

  let vyplnenychGal = 0;
  for (const s of await readSlides(id)) {
    if (s.typ === "info") {
      if (Object.values(s.pole).some((v) => v.trim())) stav.info.push("vyplněný info panel");
      if (s.obrazky.length) stav.info.push(`${s.obrazky.length}× fotku info panelu`);
      if (s.video) stav.jine.push("video info panelu");
    } else if (s.typ === "gal") {
      // Textový slide i obecné informace drží texty v `pole` stejně jako info
      // panel; bez téhle větve by import považoval vyplněný slide za prázdný
      // a přepsal ho. Slidů může být na displeji víc, ale hlásíme je jednou:
      // přepíše se stejně jen ten první.
      if (Object.values(s.pole).some((v) => v.trim())) vyplnenychGal += 1;
      // Fotka textového slidu se nepřepisuje, import médií se nedotýká.
      if (s.obrazky.length) stav.jine.push("fotku textového slidu");
    } else if (s.typ === "txt") {
      if (Object.values(s.pole).some((v) => v.trim())) stav.jine.push("vyplněné obecné informace");
    } else if (s.typ === "3d") {
      if (s.obrazky.length) stav.jine.push(`3D sekvenci (${s.obrazky.length} snímků)`);
    } else if (s.typ === "vid") {
      if (s.media.length) stav.jine.push(`galerii (${s.media.length} položek)`);
    }
  }
  if (vyplnenychGal === 1) stav.gal.push("vyplněný textový slide");
  else if (vyplnenychGal > 1) stav.gal.push(`${vyplnenychGal} vyplněné textové slidy`);
  return stav;
}

// Co z toho by import opravdu přepsal: jen typy obsahu, které zdroj nese.
function coPrepise(p: Polozka, stav: StavDispleje): string[] {
  return [
    ...(p.info ? stav.info : []),
    ...(p.gal ? stav.gal : []),
    ...(p.kb.trim() ? stav.kb : []),
  ];
}

// Opak: co na displeji je a co tenhle import nechá být. Kurátor to má vidět
// černé na bílém, je to hlavní věc, kterou u hromadného zápisu řeší.
function coZustane(p: Polozka, stav: StavDispleje): string[] {
  return [
    ...(p.info ? [] : stav.info),
    ...(p.gal ? [] : stav.gal),
    ...(p.kb.trim() ? [] : stav.kb),
    ...stav.jine,
  ];
}

// --- Výpis -------------------------------------------------------------

// Co se u položky zapsalo, do logu i do auditu.
function popisZapsaneho(p: Polozka): string {
  const kusy: string[] = [];
  if (p.info) kusy.push(`info panel (${["cs", ...Object.keys(p.info.preklady)].join("+")})`);
  if (p.gal) kusy.push(`textový slide (${["cs", ...Object.keys(p.gal.preklady)].join("+")})`);
  if (p.kb.trim()) kusy.push("znalostní báze");
  return kusy.join(", ");
}

function radek(p: Polozka): string {
  const zdroj = p.slozka.padEnd(28);
  if (p.preskocit) return `  ⤫ ${zdroj} PŘESKOČENO: ${p.preskocit}`;
  const cil = `→ displej ${p.displej}`.padEnd(16);

  const co: string[] = [];
  if (p.info) {
    const jazyky = ["cs", ...Object.keys(p.info.preklady)].join(" + ");
    co.push(`${p.info.novySlide ? "založí se" : "zapíše se"} info panel (${jazyky})`);
  }
  if (p.gal) {
    const jazyky = ["cs", ...Object.keys(p.gal.preklady)].join(" + ");
    co.push(`${p.gal.novySlide ? "založí se" : "zapíše se"} textový slide (${jazyky})`);
  }
  co.push(p.kb.trim() ? "znalostní báze" : "bez znalostní báze");
  if (p.cekaNaRevizi) co.push("označí se jako AI koncept k revizi");

  const vadne = [...(p.info?.vadnePreklady ?? []), ...(p.gal?.vadnePreklady ?? [])];
  const radky = [`  ✓ ${zdroj} ${cil} ${p.latin || "(bez latinského jména)"}`, `      ${co.join(", ")}`];
  for (const pozn of p.poznamky) radky.push(`      ! ${pozn}`);
  if (vadne.length) {
    radky.push(
      `      PŘEKLAD SE NEZAPÍŠE: ${vadne.map((v) => `${v.jazyk} (${v.duvod})`).join(", ")}`,
    );
  }
  if (p.prepisuje.length) {
    radky.push(`      PŘEPÍŠE, co tam dnes je: ${p.prepisuje.join(", ")}`);
  }
  return radky.join("\n");
}

// --- Hlavní běh --------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const zapsat = argv.includes("--zapsat");
  const prepsat = argv.includes("--prepsat");
  const nanecisto = argv.includes("--nanecisto");
  const pozicni = argv.filter((a) => !a.startsWith("--"));

  if (pozicni.length < 2) {
    console.error(NAPOVEDA.trim());
    process.exit(1);
  }
  if (zapsat && nanecisto) {
    console.error("Chyba: --zapsat a --nanecisto se vylučují. Vyberte jedno.");
    process.exit(1);
  }

  const [zdrojovaSlozka, mapovaciSoubor] = pozicni;
  console.log(`Datová složka: ${DATA_ROOT}`);
  console.log(`Zdroj:         ${path.resolve(zdrojovaSlozka)}`);
  console.log(`Mapování:      ${path.resolve(mapovaciSoubor)}`);
  console.log(
    zapsat
      ? prepsat
        ? "Režim:         ZÁPIS + PŘEPIS existujícího obsahu"
        : "Režim:         ZÁPIS"
      : "Režim:         NANEČISTO (nic se nezapíše, spusťte s --zapsat)",
  );
  console.log("");

  let mapa: Map<string, string>;
  try {
    mapa = await nactiMapovani(mapovaciSoubor);
  } catch (e) {
    console.error(`Chyba mapovacího souboru: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  let podslozky: string[];
  try {
    const entries = await fs.readdir(zdrojovaSlozka, { withFileTypes: true });
    podslozky = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    console.error(`Chyba: zdrojovou složku ${zdrojovaSlozka} se nepodařilo přečíst.`);
    process.exit(1);
  }
  if (podslozky.length === 0) {
    console.error("Chyba: ve zdrojové složce nejsou žádné podsložky druhů.");
    process.exit(1);
  }

  // 1) Načtení a kontrola všeho dopředu, ať se nezapisuje polovina.
  const polozky: Polozka[] = [];
  const obsazeneDispleje = new Map<string, string>(); // id -> zdrojová složka
  for (const slozka of podslozky) {
    const p = await nactiZdroj(zdrojovaSlozka, slozka);
    if (!p.preskocit) {
      // Bez latinského jména se páruje jen názvem složky. Prázdné jméno se
      // do mapy neptáme: klíč "" by mohl sedět na prázdný klíč v mapování
      // a poslat obsah na cizí displej.
      const id =
        (p.latin ? mapa.get(normalizuj(p.latin)) : undefined) ?? mapa.get(normalizuj(p.slozka));
      if (!id) {
        p.preskocit = `v mapovacím souboru není „${p.latin}" ani „${p.slozka}"`;
      } else if (obsazeneDispleje.has(id)) {
        p.preskocit = `displej ${id} už v tomhle běhu obsadil zdroj „${obsazeneDispleje.get(id)}"`;
      } else if (!(await displayExists(id))) {
        p.preskocit = `displej ${id} v datové složce neexistuje`;
      } else {
        p.displej = id;
        const chyba = p.info ? validateInfoPole(p.info.cs) : null;
        const stav = await coJeNaDispleji(id);
        // Zámek se ptá jen na typy obsahu, které zdroj opravdu nese.
        const kolize = coPrepise(p, stav);
        if (chyba) {
          p.preskocit = `info panel neprojde validací: ${chyba.toLowerCase()}`;
        } else if (kolize.length > 0 && !prepsat) {
          p.preskocit = `displej ${id} už má ${kolize.join(", ")}, přepis jen s --prepsat`;
        } else {
          p.prepisuje = kolize; // prázdné = na tenhle typ obsahu je displej volný
          const slidy = await readSlides(id);
          if (p.info) p.info.novySlide = !slidy.some((s) => s.typ === "info");
          if (p.gal) {
            const galSlidy = slidy.filter((s) => s.typ === "gal");
            p.gal.novySlide = galSlidy.length === 0;
            // Displej může mít textových slidů víc (na disku třeba 3_gal
            // i 4_gal). Zapisujeme do prvního v pořadí a říkáme to nahlas,
            // ať to není loterie.
            if (galSlidy.length > 1) {
              p.poznamky.push(
                `displej má ${galSlidy.length} textové slidy, zapíšu do prvního (${galSlidy[0].slozka})`,
              );
            }
          }
          // Obsah, kterého se import nedotkne, ale kurátor o něm má vědět.
          const zustane = coZustane(p, stav);
          if (zustane.length) {
            p.poznamky.push(`nedotčeno zůstane: ${zustane.join(", ")}`);
          }
          // Displej si rezervuje až zdroj, který se opravdu zapíše.
          obsazeneDispleje.set(id, p.slozka);
        }
      }
    }
    polozky.push(p);
  }

  // 2) Výpis plánu.
  for (const p of polozky) console.log(radek(p));
  console.log("");

  const kZapsani = polozky.filter((p) => !p.preskocit);
  const preskocene = polozky.filter((p) => p.preskocit);

  if (!zapsat) {
    console.log(`NANEČISTO: zapsalo by se ${kZapsani.length}, přeskočilo ${preskocene.length}.`);
    if (preskocene.length) {
      console.log("Důvody přeskočení:");
      for (const p of preskocene) console.log(`  • ${p.slozka}: ${p.preskocit}`);
    }
    console.log("\nOstrý běh: stejný příkaz s --zapsat");
    return;
  }

  // 3) Zápis, vždy přes funkce z displays.ts, nikdy přes holé fs.
  const kdo = `import-obsahu (${os.userInfo().username})`;
  let hotovo = 0;
  const selhalo: { slozka: string; duvod: string }[] = [];

  for (const p of kZapsani) {
    const id = p.displej!;
    try {
      const slidy = await readSlides(id);

      // Infopanel. Zdroj, který ho nenese, se ho vůbec nedotkne, takže se
      // nemá jak stát, že by se smazala identita druhu z meta.json.
      if (p.info) {
        const existujici = slidy.find((s) => s.typ === "info");
        const n = existujici ? existujici.n : await addSlide(id, "info");

        const res = await writeInfoPole(id, n, p.info.cs, p.section);
        if (!res.ok) throw new Error(res.chyba ?? "zápis info panelu selhal");

        // Překlady až po češtině: doplnSdilenaPole() si z ní bere sekci
        // a latinské jméno, takže musí být na disku dřív. Sekci a Latinsky
        // ze zdroje překladu server stejně přepíše hodnotou z češtiny.
        for (const [jazyk, prelozene] of Object.entries(p.info.preklady)) {
          const resJazyk = await writeInfoPole(id, n, prelozene, p.section, jazyk as Jazyk);
          if (!resJazyk.ok) {
            throw new Error(`zápis překladu ${jazyk} selhal: ${resJazyk.chyba ?? "neznámá chyba"}`);
          }
        }
      }

      // Textový slide. writeGalPole() zapisuje JEDINÝ soubor
      // (<jazyk>/<slozka>/text.txt), takže fotka slidu, galerie, video ani
      // infopanel se tím nemají jak změnit. Taxonomii skládá z Trida/Rad/
      // Celed až server, aby tvar řádku pro Unity vznikal na jednom místě.
      if (p.gal) {
        const galSlidy = slidy.filter((s) => s.typ === "gal");
        const n = galSlidy.length ? galSlidy[0].n : await addSlide(id, "gal");

        const res = await writeGalPole(id, n, p.gal.cs, "cs");
        if (!res.ok) throw new Error(res.chyba ?? "zápis textového slidu selhal");

        for (const [jazyk, prelozene] of Object.entries(p.gal.preklady)) {
          const resJazyk = await writeGalPole(id, n, prelozene, jazyk as Jazyk);
          if (!resJazyk.ok) {
            throw new Error(
              `zápis překladu textového slidu (${jazyk}) selhal: ${resJazyk.chyba ?? "neznámá chyba"}`,
            );
          }
        }
      }

      if (p.kb.trim()) await writeKb(id, p.kb);

      // Značka se ruší jen vědomým schválením kurátora v CMS, takže na pořadí
      // vůči zápisu obsahu nezáleží, nastavuje se na konci, ať je jasné, že
      // platí pro celý naimportovaný obsah.
      if (p.cekaNaRevizi) await oznacRevizi(id, true);

      await appendAudit({
        uzivatel: kdo,
        akce: "hromadný import",
        cil:
          `displej ${id} ← ${p.slozka} (${p.latin || "bez latinského jména"}): ${popisZapsaneho(p)}` +
          (p.cekaNaRevizi ? ", označeno k revizi kurátorem" : ""),
      });
      hotovo++;
      console.log(`  zapsáno: displej ${id} ← ${p.slozka}, ${popisZapsaneho(p)}`);
    } catch (e) {
      const duvod = e instanceof Error ? e.message : String(e);
      selhalo.push({ slozka: p.slozka, duvod });
      console.error(`  CHYBA u ${p.slozka}: ${duvod}`);
    }
  }

  await appendAudit({
    uzivatel: kdo,
    akce: "hromadný import",
    cil: `souhrn: naimportováno ${hotovo}, přeskočeno ${preskocene.length + selhalo.length}`,
  });

  // 4) Souhrn.
  console.log("");
  console.log(`Naimportováno: ${hotovo}`);
  console.log(`Přeskočeno:    ${preskocene.length + selhalo.length}`);
  for (const p of preskocene) console.log(`  • ${p.slozka}: ${p.preskocit}`);
  for (const s of selhalo) console.log(`  • ${s.slozka}: zápis selhal, ${s.duvod}`);
  const kRevizi = kZapsani.filter((p) => p.cekaNaRevizi).length;
  if (hotovo > 0) {
    console.log("");
    console.log(`Čeká na revizi kurátora: ${kRevizi} (v CMS je vidět v přehledu displejů).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
