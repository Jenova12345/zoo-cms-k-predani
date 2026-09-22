import { promises as fs } from "node:fs";
import path from "node:path";
import { ANALYTIKA_DIR, UDALOSTI_DIR } from "./paths.js";
import { writeFileAtomic } from "./atomic.js";
import { type SouborDne, den, parsujRadek, souboryVRozsahu } from "./udalosti.js";

// Analytika návštěvnosti z událostí Unity. Na rozdíl od dashboardu, který
// kouká na posledních pár dnů, se tady běžně ptáme na rok zpátky — a to je
// úplně jiná úloha.
//
// Naměřeno na roce syntetických dat (31 displejů × 365 dnů, 11 315 souborů,
// 11 M řádků, 1,4 GB): číst pokaždé všechny události trvá 47 s a sežere
// 3 GB haldy. Proto se čte JINAK:
//
//   1. Z každé dvojice (den, displej) se udělá DENNÍ SOUHRN — hrstka čísel
//      místo tisíců událostí. Soubor minulého dne se už nikdy nezmění,
//      takže se počítá právě jednou.
//   2. Dotaz na libovolný rozsah je pak jen sečtení souhrnů.
//
// Tímhle spadl rok na 6,2 s studeně / 119 ms z paměti při 18 MB haldy.
// Souhrny se navíc ukládají na disk (2,5 MB za celý rok), takže restart
// serveru neznamená šestisekundové čekání na první otevření.

export interface DenniSouhrn {
  den: string;
  displej: number;
  // Relace = počet událostí `relace_start`. Schválně ne počet unikátních
  // `relace` ID: relace přes půlnoc má začátek právě v jednom dni, takže
  // se nedá započítat dvakrát.
  relaci: number;
  zobrazeni: Record<string, number>; // typ slidu → počet zobrazení
  // Akce `otevren_chat`. Produkční Unity ji NEPOSÍLÁ (ověřeno nad celými logy),
  // takže je to prakticky vždy 0 a do API ani do stránky se už nedostane.
  // Počítat ji stojí jeden `if`, a kdyby ji Michal někdy začal posílat, máme
  // ji rovnou i zpětně — proto se z uložených souhrnů nemaže. Kolik dotazů
  // na AI doopravdy padlo, ví Danielův backend (dashboard, `analytics.ts`).
  otevreniChatu: number;
  // Doby se drží jako SOUČET a POČET, ne jako průměr. Průměrovat denní
  // průměry by dalo tichému čtvrtku stejnou váhu jako narvané sobotě.
  soucetTrvaniS: number;
  pocetTrvani: number;
  trvaniTypu: Record<string, { soucet: number; pocet: number }>;
  relaciSDobou: number;
  soucetDobRelaciS: number;
  poskozene: number;
  zahozenaTrvani: number;
  neznameTypy: string[];
}

// Trvání delší, než trvala celá relace, je zbytek stopek z minulé relace.
// Stejná tolerance jako v udalosti.ts, ať se obě čísla chovají stejně.
const TOLERANCE_S = 60;

function prazdny(denStr: string, displej: number): DenniSouhrn {
  return {
    den: denStr,
    displej,
    relaci: 0,
    zobrazeni: {},
    otevreniChatu: 0,
    soucetTrvaniS: 0,
    pocetTrvani: 0,
    trvaniTypu: {},
    relaciSDobou: 0,
    soucetDobRelaciS: 0,
    poskozene: 0,
    zahozenaTrvani: 0,
    neznameTypy: [],
  };
}

// Souhrn jednoho souboru. Události se drží jen po dobu zpracování JEDNOHO
// dne jednoho displeje (~stovky až tisíce řádků) a hned se pouští — díky
// tomu zůstává halda v desítkách MB i při ročním rozsahu.
function souhrnSouboru(obsah: string, soubor: SouborDne): DenniSouhrn {
  const s = prazdny(soubor.den, soubor.displej ?? 0);

  // Rozpětí relací v tomhle dni. Potřebujeme ho dvakrát: na dobu strávenou
  // u displeje a jako strop pro nesmyslná `trvani_s`.
  const relace = new Map<string, { od: number; do: number; maStart: boolean }>();
  const zobrazeni: { relace: string; typ: string; znamy: boolean; trvani?: number }[] = [];
  const nezname = new Set<string>();

  let od = 0;
  while (od < obsah.length) {
    let konec = obsah.indexOf("\n", od);
    if (konec === -1) konec = obsah.length;
    const radek = obsah.slice(od, konec);
    od = konec + 1;
    if (!radek.trim()) continue;

    const u = parsujRadek(radek, soubor.displej);
    if (!u) {
      s.poskozene++;
      continue;
    }
    if (soubor.displej === undefined) s.displej = u.displej;

    const klic = u.relace || u.cas;
    const r = relace.get(klic);
    if (!r) relace.set(klic, { od: u.casMs, do: u.casMs, maStart: u.akce === "relace_start" });
    else {
      r.od = Math.min(r.od, u.casMs);
      r.do = Math.max(r.do, u.casMs);
      if (u.akce === "relace_start") r.maStart = true;
    }

    if (u.akce === "relace_start") {
      s.relaci++;
      continue;
    }
    if (u.akce === "otevren_chat") {
      s.otevreniChatu++;
      continue;
    }
    if (u.akce !== "zobrazen_slide") continue;

    const typ = u.typCms ?? (u.typSurovy ? u.typSurovy.trim() : "neurčeno");
    if (!u.typCms && u.typSurovy) nezname.add(u.typSurovy.trim());
    s.zobrazeni[typ] = (s.zobrazeni[typ] ?? 0) + 1;
    zobrazeni.push({ relace: klic, typ, znamy: !!u.typCms, trvani: u.trvaniS });
  }

  // Doba u displeje = rozpětí relace. Bereme jen relace, které v tomhle dni
  // opravdu začaly — u relace přeteklé z včerejška by rozpětí useklé
  // půlnocí lhalo. (Pavilon večer zavírá, takže jich je pár promile.)
  for (const r of relace.values()) {
    if (!r.maStart) continue;
    const doba = Math.round((r.do - r.od) / 1000);
    if (doba <= 0) continue;
    s.relaciSDobou++;
    s.soucetDobRelaciS += doba;
  }

  for (const z of zobrazeni) {
    if (z.trvani === undefined) continue;
    const r = relace.get(z.relace);
    const strop = r ? Math.round((r.do - r.od) / 1000) + TOLERANCE_S : TOLERANCE_S;
    if (z.trvani < 0 || z.trvani > strop) {
      s.zahozenaTrvani++;
      continue;
    }
    s.soucetTrvaniS += z.trvani;
    s.pocetTrvani++;
    const t = (s.trvaniTypu[z.typ] ??= { soucet: 0, pocet: 0 });
    t.soucet += z.trvani;
    t.pocet++;
  }

  s.neznameTypy = [...nezname].sort();
  return s;
}

// --- Cache denních souhrnů -------------------------------------------

interface ZaznamCache {
  mtimeMs: number;
  velikost: number;
  souhrn: DenniSouhrn;
}

interface MesicCache {
  verze: number;
  dny: Record<string, ZaznamCache>; // klíč = cesta souboru relativně k UDALOSTI_DIR
}

// Uložené souhrny se počítaly tehdejším parserem. Když se změní to, CO se
// z řádku přečte, musí se číslo zvýšit — jinak by se dál sčítaly staré
// výsledky a oprava by se v číslech nikdy neprojevila.
//
//   1 → 2  parser přestal zahazovat řádky s nečíselným polem `displej`
//          (`"Kiosek_5"` i neuvozovkované `Kiosek_5`, viz udalosti.ts).
//          Souhrny se po nasazení jednou přepočítají z logů, ~6 s na rok.
const VERZE_CACHE = 2;

// Paměť procesu i to, co leží na disku. Klíčem je vždycky (mtime, velikost)
// souboru — dnešní den se tím počítá pokaždé znovu (tablety do něj pořád
// sypou), hotové dny se vezmou hotové.
const vPameti = new Map<string, ZaznamCache>();
const nactenéMesice = new Set<string>();
const spinaveMesice = new Set<string>();

function mesicKlice(denStr: string): string {
  return denStr.slice(0, 7); // RRRR-MM
}

function cestaMesice(mesic: string): string {
  return path.join(ANALYTIKA_DIR, `${mesic}.json`);
}

async function nactiMesic(mesic: string): Promise<void> {
  if (nactenéMesice.has(mesic)) return;
  nactenéMesice.add(mesic);
  let raw: string;
  try {
    raw = await fs.readFile(cestaMesice(mesic), "utf8");
  } catch {
    return; // ještě neexistuje, dopočítá se z logů
  }
  try {
    const data = JSON.parse(raw) as MesicCache;
    if (data?.verze !== VERZE_CACHE || !data.dny) return;
    for (const [klic, zaznam] of Object.entries(data.dny)) {
      if (!vPameti.has(klic)) vPameti.set(klic, zaznam);
    }
  } catch {
    // Poškozená cache není chyba, jen o ni přijdeme. Zdroj pravdy jsou logy.
    console.warn(`[analytika] ${mesic}.json je poškozený, přepočítávám z logů.`);
  }
}

async function ulozSpinaveMesice(): Promise<void> {
  if (spinaveMesice.size === 0) return;
  const mesice = [...spinaveMesice];
  spinaveMesice.clear();
  await fs.mkdir(ANALYTIKA_DIR, { recursive: true }).catch(() => {});
  for (const mesic of mesice) {
    const dny: Record<string, ZaznamCache> = {};
    for (const [klic, zaznam] of vPameti) {
      if (zaznam.souhrn.den.slice(0, 7) === mesic) dny[klic] = zaznam;
    }
    const data: MesicCache = { verze: VERZE_CACHE, dny };
    try {
      await writeFileAtomic(cestaMesice(mesic), JSON.stringify(data));
    } catch (e) {
      // Cache je jen zrychlení: když se nedá zapsat (plný disk, práva),
      // analytika pojede dál, jen pomaleji. Nesmí kvůli tomu spadnout.
      console.warn(`[analytika] ${mesic}.json se nepodařilo uložit: ${String(e)}`);
    }
  }
}

async function souhrnSouboruSCache(soubor: SouborDne): Promise<DenniSouhrn | null> {
  const mesic = mesicKlice(soubor.den);
  await nactiMesic(mesic);

  const cesta = path.join(UDALOSTI_DIR, soubor.rel);
  let stat;
  try {
    stat = await fs.stat(cesta);
  } catch {
    vPameti.delete(soubor.rel);
    return null; // soubor mezitím zmizel
  }

  const ulozeny = vPameti.get(soubor.rel);
  if (ulozeny && ulozeny.mtimeMs === stat.mtimeMs && ulozeny.velikost === stat.size) {
    return ulozeny.souhrn;
  }

  let obsah: string;
  try {
    obsah = await fs.readFile(cesta, "utf8");
  } catch {
    return null;
  }
  const souhrn = souhrnSouboru(obsah, soubor);
  vPameti.set(soubor.rel, { mtimeMs: stat.mtimeMs, velikost: stat.size, souhrn });
  spinaveMesice.add(mesic);
  return souhrn;
}

// --- Koše (den / týden / měsíc) --------------------------------------

export type Granularita = "den" | "tyden" | "mesic";

const MESICE_KRATCE = [
  "led", "úno", "bře", "dub", "kvě", "čvn",
  "čvc", "srp", "zář", "říj", "lis", "pro",
];

// Granularita se navrhne podle délky rozsahu, uživatel ji pak může přepnout.
// Hranice jsou tam, kde by graf přestal být čitelný: přes dva měsíce dnů už
// je to hřeben, přes osm měsíců týdnů taky.
export function navrhniGranularitu(dnu: number): Granularita {
  if (dnu <= 62) return "den";
  if (dnu <= 240) return "tyden";
  return "mesic";
}

function naDatum(denStr: string): Date {
  return new Date(`${denStr}T00:00:00Z`);
}

// Pondělí téhož týdne (ISO, jak je u nás zvykem).
function pondeli(denStr: string): string {
  const d = naDatum(denStr);
  const odPondeli = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - odPondeli);
  return d.toISOString().slice(0, 10);
}

function klicKose(denStr: string, g: Granularita): string {
  if (g === "den") return denStr;
  if (g === "tyden") return pondeli(denStr);
  return denStr.slice(0, 7);
}

function popisKose(klic: string, g: Granularita): string {
  if (g === "mesic") {
    const [rok, m] = klic.split("-");
    return `${MESICE_KRATCE[Number(m) - 1]} ${rok.slice(2)}`;
  }
  const [, m, d] = klic.split("-");
  return `${Number(d)}. ${Number(m)}.`;
}

// Všechny koše v rozsahu, i prázdné. Graf bez děr: den bez návštěv je
// informace („zavřeno"), ne důvod přeskočit bod na ose.
function koseVRozsahu(od: string, doDne: string, g: Granularita): string[] {
  const kose: string[] = [];
  const videne = new Set<string>();
  const konec = naDatum(doDne).getTime();
  for (let t = naDatum(od).getTime(); t <= konec; t += 86400000) {
    const klic = klicKose(new Date(t).toISOString().slice(0, 10), g);
    if (videne.has(klic)) continue;
    videne.add(klic);
    kose.push(klic);
  }
  return kose;
}

// --- Veřejné rozhraní -------------------------------------------------

export interface BodGrafu {
  klic: string;
  popis: string;
  relaci: number;
}

export interface SouhrnObdobi {
  relaci: number;
  zobrazeni: number;
  prumernaDobaS: number | null; // doba u displeje = rozpětí jedné relace
  aiZobrazeni: number; // otevření AI slidu
}

export interface RadekZebricku {
  displej: number;
  druh: string | null;
  relaci: number;
  zobrazeni: number;
  prumernaDobaS: number | null;
}

export interface RadekTypu {
  typ: string;
  znamy: boolean;
  zobrazeni: number;
  prumernaDobaS: number | null;
}

export interface AnalytikaNavstevnosti {
  od: string;
  do: string;
  granularita: Granularita;
  body: BodGrafu[];
  celkem: SouhrnObdobi;
  porovnani: { od: string; do: string; celkem: SouhrnObdobi } | null;
  displeje: RadekZebricku[];
  typySlidu: RadekTypu[];
  kvalita: {
    poskozeneRadky: number;
    zahozenaTrvani: number;
    neznameTypy: string[];
    displejuSData: number;
    displejuCelkem: number;
    mimoZebricek: number[]; // displeje nad POSLEDNI_DISPLEJ, co posílají data
  };
}

// Souhrny všech dvojic (den, displej) v rozsahu.
async function souhrnyVRozsahu(od: string, doDne: string): Promise<DenniSouhrn[]> {
  const soubory = await souboryVRozsahu(od, doDne);
  const ven: DenniSouhrn[] = [];
  for (const soubor of soubory) {
    const s = await souhrnSouboruSCache(soubor);
    if (s) ven.push(s);
  }
  await ulozSpinaveMesice();
  return ven;
}

function secti(souhrny: DenniSouhrn[]): SouhrnObdobi {
  let relaci = 0;
  let zobrazeni = 0;
  let aiZobrazeni = 0;
  let relaciSDobou = 0;
  let soucetDob = 0;
  for (const s of souhrny) {
    relaci += s.relaci;
    relaciSDobou += s.relaciSDobou;
    soucetDob += s.soucetDobRelaciS;
    for (const [typ, pocet] of Object.entries(s.zobrazeni)) {
      zobrazeni += pocet;
      if (typ === "ai") aiZobrazeni += pocet;
    }
  }
  return {
    relaci,
    zobrazeni,
    // Průměr ze SOUČTU a POČTU, ne z průměrů dnů.
    prumernaDobaS: relaciSDobou ? Math.round(soucetDob / relaciSDobou) : null,
    aiZobrazeni,
  };
}

function posunOdecti(denStr: string, dnu: number): string {
  return new Date(naDatum(denStr).getTime() - dnu * 86400000).toISOString().slice(0, 10);
}

export function pocetDnu(od: string, doDne: string): number {
  return Math.round((naDatum(doDne).getTime() - naDatum(od).getTime()) / 86400000) + 1;
}

export async function analytika(opts: {
  od: string;
  do: string;
  granularita?: Granularita;
  porovnat?: boolean;
  druhy?: Map<number, string>; // číslo displeje → druh z meta.json
  posledniDisplej?: number;
  displejuCelkem?: number;
}): Promise<AnalytikaNavstevnosti> {
  const dnu = pocetDnu(opts.od, opts.do);
  const granularita = opts.granularita ?? navrhniGranularitu(dnu);
  const souhrny = await souhrnyVRozsahu(opts.od, opts.do);

  // Hlavní graf: relace po koších, včetně prázdných.
  const poKosich = new Map<string, number>();
  for (const klic of koseVRozsahu(opts.od, opts.do, granularita)) poKosich.set(klic, 0);
  for (const s of souhrny) {
    const klic = klicKose(s.den, granularita);
    poKosich.set(klic, (poKosich.get(klic) ?? 0) + s.relaci);
  }
  const body: BodGrafu[] = [...poKosich.entries()].map(([klic, relaci]) => ({
    klic,
    popis: popisKose(klic, granularita),
    relaci,
  }));

  // Žebříček displejů.
  const posledni = opts.posledniDisplej ?? Number.MAX_SAFE_INTEGER;
  const podleDispleje = new Map<number, DenniSouhrn[]>();
  for (const s of souhrny) {
    const pole = podleDispleje.get(s.displej);
    if (pole) pole.push(s);
    else podleDispleje.set(s.displej, [s]);
  }

  const displeje: RadekZebricku[] = [];
  const mimoZebricek: number[] = [];
  let displejuSData = 0;
  for (const [displej, sada] of podleDispleje) {
    const souhrn = secti(sada);
    const zobrazeni = souhrn.zobrazeni;
    if (souhrn.relaci > 0 || zobrazeni > 0) displejuSData++;
    if (displej > posledni) {
      // Do celkových čísel se počítá, do žebříčku ne — přehled displejů
      // končí u POSLEDNI_DISPLEJ a analytika s ním má sedět.
      if (souhrn.relaci > 0 || zobrazeni > 0) mimoZebricek.push(displej);
      continue;
    }
    displeje.push({
      displej,
      druh: opts.druhy?.get(displej) ?? null,
      relaci: souhrn.relaci,
      zobrazeni,
      prumernaDobaS: souhrn.prumernaDobaS,
    });
  }
  displeje.sort((a, b) => b.relaci - a.relaci || b.zobrazeni - a.zobrazeni || a.displej - b.displej);

  // Rozpad typů slidů.
  const typy = new Map<string, { zobrazeni: number; soucet: number; pocet: number }>();
  const nezname = new Set<string>();
  let poskozeneRadky = 0;
  let zahozenaTrvani = 0;
  for (const s of souhrny) {
    poskozeneRadky += s.poskozene;
    zahozenaTrvani += s.zahozenaTrvani;
    for (const t of s.neznameTypy) nezname.add(t);
    for (const [typ, pocet] of Object.entries(s.zobrazeni)) {
      const t = typy.get(typ) ?? { zobrazeni: 0, soucet: 0, pocet: 0 };
      t.zobrazeni += pocet;
      typy.set(typ, t);
    }
    for (const [typ, d] of Object.entries(s.trvaniTypu)) {
      const t = typy.get(typ);
      if (!t) continue;
      t.soucet += d.soucet;
      t.pocet += d.pocet;
    }
  }
  const typySlidu: RadekTypu[] = [...typy.entries()]
    .map(([typ, t]) => ({
      typ,
      znamy: !nezname.has(typ),
      zobrazeni: t.zobrazeni,
      prumernaDobaS: t.pocet ? Math.round(t.soucet / t.pocet) : null,
    }))
    .sort((a, b) => b.zobrazeni - a.zobrazeni);

  // Porovnání: stejně dlouhý úsek bezprostředně před `od`.
  let porovnani: AnalytikaNavstevnosti["porovnani"] = null;
  if (opts.porovnat) {
    const predDo = posunOdecti(opts.od, 1);
    const predOd = posunOdecti(predDo, dnu - 1);
    porovnani = { od: predOd, do: predDo, celkem: secti(await souhrnyVRozsahu(predOd, predDo)) };
  }

  return {
    od: opts.od,
    do: opts.do,
    granularita,
    body,
    celkem: secti(souhrny),
    porovnani,
    displeje,
    typySlidu,
    kvalita: {
      poskozeneRadky,
      zahozenaTrvani,
      neznameTypy: [...nezname].sort(),
      displejuSData,
      displejuCelkem: opts.displejuCelkem ?? podleDispleje.size,
      mimoZebricek: mimoZebricek.sort((a, b) => a - b),
    },
  };
}

// Dnešek podle lokálního času serveru (tablety i CMS běží na stejném stroji).
export function dnes(ted = Date.now()): string {
  return den(new Date(ted));
}
