import { promises as fs } from "node:fs";
import path from "node:path";
import { UDALOSTI_DIR } from "./paths.js";

// Události z tabletů u expozice. Zapisuje je Michalovo Unity, jeden JSON
// na řádek, do <DATA_ROOT>/udalosti/unity/ ve dvou strukturách naráz:
//
//   <displej>/RRRR-MM-DD.jsonl   nová, číslo displeje je název podsložky
//   RRRR-MM-DD.jsonl             stará plochá, číslo displeje je v řádku
//
// Obě se čtou. U nové je zdroj pravdy název složky, ne pole `displej`
// uvnitř řádku: tablet se dá přehodit na jiný displej a v logu pak zůstane
// staré číslo. Podsložky s nečíselným názvem (7-zaloha) se ignorují.
//
// Čtení je schválně tolerantní. Je to cizí formát, který se ještě může měnit,
// a data z provozu bývají špinavá: poškozený řádek se přeskočí a spočítá,
// neznámý typ slidu se zahodit nesmí, nesmyslné trvání se nesmí započítat
// do průměrů. Co všechno se přeskočilo, jde do dashboardu jako poznámka,
// ať se na tichou chybu nepřijde až za půl roku.

export interface Udalost {
  casMs: number;
  cas: string;
  displej: number;
  relace: string;
  akce: string;
  typSurovy?: string; // typ slidu tak, jak přišel z tabletu
  typCms?: string; // namapovaný na typy CMS, když se povedlo
  cislo?: number; // číslo slidu přečíslované na řadu od 1 (Unity čísluje od 0)
  trvaniS?: number;
  zprava?: string;
}

// Unity posílá typy slidů anglicky a jinak, než je zná CMS. Mapa je
// schválně širší, než co dnes chodí (bere i naše vlastní názvy), a klíče se
// porovnávají malými písmeny bez podtržítek. Co v mapě není, se nezahazuje:
// projde dál jako `typSurovy` a dashboard to ukáže tak, jak to přišlo.
const TYP_MAPA: Record<string, string> = {
  info: "info",
  model3d: "3d",
  model: "3d",
  mod: "3d",
  "3d": "3d",
  gallery: "gal",
  gal: "gal",
  zajimavost: "gal",
  ai: "ai",
  chat: "ai",
  video: "vid",
  vid: "vid",
  txt: "txt",
  text: "txt",
};

export function namapujTyp(surovy: unknown): string | undefined {
  if (typeof surovy !== "string") return undefined;
  const klic = surovy.trim().toLowerCase().replace(/[\s_-]/g, "");
  return TYP_MAPA[klic];
}

const DEN_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SLOZKA_DISPLEJE_RE = /^\d+$/;

// Kolik nečitelných řádků z jednoho souboru se vypíše, než se log utne.
// Na tabletech zůstaly staré řádky ve špatném formátu a celý den takových
// řádků by zaplavil výstup serveru.
const LOG_POSKOZENYCH = 5;

export interface SouborDne {
  rel: string; // cesta relativně k UDALOSTI_DIR
  den: string; // RRRR-MM-DD z názvu souboru
  displej?: number; // z názvu podsložky; u ploché struktury chybí
}

interface NactenyDen {
  mtimeMs: number;
  velikost: number;
  udalosti: Udalost[];
  poskozene: number;
}

// Soubory se nečtou při každém požadavku znovu. Den, který se od minule
// nezměnil (stejný čas úpravy i velikost), se vezme z paměti; dnešní soubor
// se přečte znovu, protože do něj tablety pořád přisypávají.
//
// Cache je OMEZENÁ, a to schválně. Drží naparsované události, kterých je
// v jednom dni jednoho displeje řádově tisíce; bez stropu by se při velkém
// okně nafoukla do gigabajtů a GC by se v ní utloukl (naměřeno: roční okno
// 11 M událostí = 3 GB haldy a druhý průchod POMALEJŠÍ než první). Dlouhé
// rozsahy patří do analytika.ts, která drží jen denní souhrny — pár čísel
// místo pole událostí.
//
// Strop je nastavený tak, aby se do něj VEŠLO celé okno dashboardu
// (MAX_DNU_PREHLEDU × počet displejů) i s rezervou. Kdyby byl menší,
// dashboard by si při každém obnovení přečetl všechny soubory znovu.
const MAX_DNU_V_CACHE = 1400; // ~37 displejů × 31 dnů + rezerva
const cache = new Map<string, NactenyDen>();

// Nejstarší zápisy ven. Map si v JS pamatuje pořadí vkládání, takže stačí
// brát od začátku; znovu použitý den se přesune na konec (viz nactiDen).
function omezCache(): void {
  while (cache.size > MAX_DNU_V_CACHE) {
    const nejstarsi = cache.keys().next();
    if (nejstarsi.done) return;
    cache.delete(nejstarsi.value);
  }
}

function cislo(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

// Číslo displeje z hodnoty, kterou tablet napsal do pole `displej`. Kromě
// čísla bereme i řetězec: starší Unity tam psalo jméno kiosku (`"Kiosek_5"`,
// někdy jen `"5"`). Bere se POSLEDNÍ skupina číslic, protože právě tak je
// jméno složené — prefix a číslo displeje na konci.
function cisloDispleje(x: unknown): number | undefined {
  const primo = cislo(x);
  if (primo !== undefined) return primo;
  if (typeof x !== "string") return undefined;
  const nalez = /(\d+)\s*$/.exec(x.trim());
  if (!nalez) return undefined;
  const n = Number(nalez[1]);
  return Number.isFinite(n) ? n : undefined;
}

// Neuvozovkovaná hodnota u `displej`, tedy `{"displej":Kiosek_5,…}`. To není
// platný JSON a `JSON.parse` na tom skončí, takže se zahodil CELÝ řádek —
// i když všechno ostatní v něm bylo v pořádku. Číslo displeje přitom stejně
// bereme z názvu složky, takže je to jediné pole, o které vůbec nestojíme.
//
// Opravuje se schválně JEN tohle jedno pole a JEN když parsování selhalo:
// není to obecné „spravování" cizího JSONu, jen záplata na známý tvar. Když
// se ani po ní nepodaří řádek přečíst, zahodí se jako dřív.
const NEUVOZOVKOVANY_DISPLEJ = /("displej"\s*:\s*)([A-Za-z_][\w-]*)(\s*[,}])/;

function opravNeuvozovkovanyDisplej(radek: string): string | null {
  if (!NEUVOZOVKOVANY_DISPLEJ.test(radek)) return null;
  return radek.replace(NEUVOZOVKOVANY_DISPLEJ, (_, pred, hodnota, za) => `${pred}"${hodnota}"${za}`);
}

function zkrat(radek: string): string {
  const r = radek.trim();
  return r.length > 200 ? `${r.slice(0, 200)}…` : r;
}

export function parsujRadek(radek: string, displejZeSlozky?: number): Udalost | null {
  let syrovy: Record<string, unknown>;
  try {
    syrovy = JSON.parse(radek) as Record<string, unknown>;
  } catch {
    // Druhý pokus, viz opravNeuvozovkovanyDisplej().
    const opraveny = opravNeuvozovkovanyDisplej(radek);
    if (opraveny === null) return null;
    try {
      syrovy = JSON.parse(opraveny) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!syrovy || typeof syrovy !== "object") return null;

  const cas = typeof syrovy.cas === "string" ? syrovy.cas : "";
  const casMs = Date.parse(cas);
  // Název složky vyhrává nad polem v řádku. V ploché struktuře žádná
  // složka není, tam zbývá jen pole.
  const displej = displejZeSlozky ?? cisloDispleje(syrovy.displej);
  const akce = typeof syrovy.akce === "string" ? syrovy.akce : "";
  // Bez času, displeje nebo akce nejde událost k ničemu použít.
  if (!Number.isFinite(casMs) || displej === undefined || !akce) return null;

  const typSurovy = typeof syrovy.typ === "string" ? syrovy.typ : undefined;
  const cisloUnity = cislo(syrovy.cislo);

  return {
    casMs,
    cas,
    displej,
    relace: typeof syrovy.relace === "string" ? syrovy.relace : "",
    akce,
    typSurovy,
    typCms: namapujTyp(typSurovy),
    // Unity čísluje slidy od nuly, složky na disku od jedničky.
    cislo: cisloUnity === undefined ? undefined : cisloUnity + 1,
    trvaniS: cislo(syrovy.trvani_s),
    zprava:
      typeof syrovy.zprava === "string"
        ? syrovy.zprava
        : typeof syrovy.chyba === "string"
          ? syrovy.chyba
          : undefined,
  };
}

async function nactiDen(soubor: SouborDne): Promise<NactenyDen> {
  const cesta = path.join(UDALOSTI_DIR, soubor.rel);
  let stat;
  try {
    stat = await fs.stat(cesta);
  } catch {
    cache.delete(soubor.rel);
    return { mtimeMs: 0, velikost: 0, udalosti: [], poskozene: 0 };
  }

  const ulozeny = cache.get(soubor.rel);
  if (ulozeny && ulozeny.mtimeMs === stat.mtimeMs && ulozeny.velikost === stat.size) {
    // Přesun na konec pořadí: co se používá, to se nevyhodí jako první.
    cache.delete(soubor.rel);
    cache.set(soubor.rel, ulozeny);
    return ulozeny;
  }

  let obsah: string;
  try {
    obsah = await fs.readFile(cesta, "utf8");
  } catch {
    return { mtimeMs: 0, velikost: 0, udalosti: [], poskozene: 0 };
  }

  const udalosti: Udalost[] = [];
  let poskozene = 0;
  const radky = obsah.split("\n");
  for (let i = 0; i < radky.length; i++) {
    const radek = radky[i];
    if (!radek.trim()) continue;
    const u = parsujRadek(radek, soubor.displej);
    if (u) {
      udalosti.push(u);
      continue;
    }
    // Jeden rozbitý řádek nesmí shodit celý den. Přeskočí se, započítá
    // do kvality a napíše do logu, ať se o něm ví.
    poskozene++;
    if (poskozene <= LOG_POSKOZENYCH) {
      console.warn(
        `[udalosti] ${soubor.rel}:${i + 1} nečitelný řádek, přeskakuji: ${zkrat(radek)}`,
      );
    } else if (poskozene === LOG_POSKOZENYCH + 1) {
      console.warn(`[udalosti] ${soubor.rel}: další nečitelné řádky už nevypisuji.`);
    }
  }

  const novy: NactenyDen = { mtimeMs: stat.mtimeMs, velikost: stat.size, udalosti, poskozene };
  cache.set(soubor.rel, novy);
  omezCache();
  return novy;
}

// Soubory dnů v rozsahu (včetně krajů). Den se bere z názvu souboru a číslo
// displeje z názvu podsložky, ne z obsahu. Prochází se obě struktury naráz:
// podsložky <číslo>/ i staré ploché soubory přímo v unity/.
export async function souboryVRozsahu(od: string, doDne: string): Promise<SouborDne[]> {
  let polozky;
  try {
    polozky = await fs.readdir(UDALOSTI_DIR, { withFileTypes: true });
  } catch {
    return []; // složka ještě neexistuje, tablety zatím nic neposlaly
  }

  const soubory: SouborDne[] = [];
  for (const polozka of polozky) {
    if (polozka.isDirectory()) {
      // Jen čistě číselné složky. Cokoli jiného (7-zaloha, docasne) není
      // displej a nemá se do statistik připlést.
      if (!SLOZKA_DISPLEJE_RE.test(polozka.name)) continue;
      const displej = Number(polozka.name);
      if (!Number.isSafeInteger(displej)) continue;

      let vnitrni: string[];
      try {
        vnitrni = await fs.readdir(path.join(UDALOSTI_DIR, polozka.name));
      } catch {
        continue; // složka zmizela mezi výpisem a čtením, nebo na ni nemáme práva
      }
      for (const nazev of vnitrni) {
        const m = DEN_RE.exec(nazev);
        if (m === null || m[1] < od || m[1] > doDne) continue;
        soubory.push({ rel: path.join(polozka.name, nazev), den: m[1], displej });
      }
      continue;
    }

    const m = DEN_RE.exec(polozka.name);
    if (m === null || m[1] < od || m[1] > doDne) continue;
    soubory.push({ rel: polozka.name, den: m[1] });
  }

  // Pojistka proti dvojímu počítání: když má den aspoň jednu podsložku,
  // je plochý soubor téhož dne jen pozůstatek po přechodu na novou
  // strukturu (typicky zkopírovaná data) a nečte se. Dnes se nepotkávají
  // (ploché srpnové soubory vs. zářijové podsložky), ale až se potkají,
  // ať se relace nezapočítají dvakrát.
  const dnySPodslozkou = new Set(
    soubory.filter((s) => s.displej !== undefined).map((s) => s.den),
  );

  return soubory
    .filter((s) => {
      if (s.displej !== undefined || !dnySPodslozkou.has(s.den)) return true;
      console.warn(
        `[udalosti] ${s.rel}: den už je v podsložkách displejů, plochý soubor přeskakuji.`,
      );
      return false;
    })
    .sort((a, b) => a.den.localeCompare(b.den) || (a.displej ?? -1) - (b.displej ?? -1));
}

// --- Souhrn pro dashboard ---------------------------------------------

// Období dashboardu. Každé číslo, které se dá počítat za období, se vrací
// pro všechna tři naráz — jeden dotaz pak obslouží i přepínání období
// v prohlížeči, bez dalšího kola na server.
//
// POZOR na význam: `den` je od dnešní půlnoci (kalendářní den), `tyden`
// a `mesic` jsou posledních 7 a 30 × 24 h (klouzavé). Tak se to počítalo
// odjakživa a dashboard to takhle i popisuje.
export type Obdobi = "den" | "tyden" | "mesic";

export interface PodleObdobi<T> {
  den: T;
  tyden: T;
  mesic: T;
}

export interface StavDispleje {
  displej: number;
  navstevy: PodleObdobi<number>;
  prumernaDobaS: PodleObdobi<number | null>; // průměrná délka relace u displeje
  posledniUdalost: string | null;
  tichy: boolean; // 24 hodin bez jediné události, nejspíš spadlý tablet
}

export interface StavTypuSlidu {
  typ: string; // typ CMS, nebo surový název z tabletu, když ho neznáme
  znamy: boolean;
  otevreni: PodleObdobi<number>;
  prumernaDobaS: PodleObdobi<number | null>; // průměrná doba na slidu
}

export interface Prehled {
  od: string;
  do: string;
  maData: boolean;
  celkem: PodleObdobi<{ relaci: number; udalosti: number }>;
  displeje: StavDispleje[];
  typySlidu: StavTypuSlidu[];
  ticheDispleje: number[];
  kvalita: {
    poskozeneRadky: number;
    zahozenaTrvani: number;
    neznameTypy: string[];
  };
}

const OBDOBI: Obdobi[] = ["den", "tyden", "mesic"];

// Nová trojice čísel. Pozor na sdílené reference: pole se musí vyrábět
// pokaždé nové, jinak by si všechna tři období psala do jednoho.
function zaObdobi<T>(tovarna: () => T): PodleObdobi<T> {
  return { den: tovarna(), tyden: tovarna(), mesic: tovarna() };
}

// Trvání delší než celá relace je zbytek stopek z minulé relace. Tolerance
// je kvůli krátkým relacím, kde se poslední slide počítá ještě po poslední
// zaznamenané události.
const TOLERANCE_S = 60;

export function den(datum: Date): string {
  const y = datum.getFullYear();
  const m = String(datum.getMonth() + 1).padStart(2, "0");
  const d = String(datum.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Strop okna. Dashboard z delší historie stejně NIC neukazuje — nejdelší
// číslo, které počítá, je návštěvnost za 30 dnů, chyby za posledních 20
// záznamů a ticho za 24 hodin; sám si říká o `dny: 30`. Dřív se sem dalo
// poslat `dny=366`, čtečka natáhla do paměti rok událostí (11 M kusů, 3 GB
// haldy) a server se na minutu zastavil. Delší rozsahy obsluhuje
// analytika.ts nad denními souhrny.
export const MAX_DNU_PREHLEDU = 31;

export async function prehled(opts: {
  dny?: number;
  displej?: number;
  vsechnyDispleje?: number[];
  ted?: number; // kvůli testovatelnosti
}): Promise<Prehled> {
  const dny = Math.min(Math.max(Math.trunc(opts.dny ?? 30), 1), MAX_DNU_PREHLEDU);
  const ted = opts.ted ?? Date.now();
  const doDne = den(new Date(ted));
  const od = den(new Date(ted - (dny - 1) * 86400000));

  const soubory = await souboryVRozsahu(od, doDne);
  const udalosti: Udalost[] = [];
  let poskozeneRadky = 0;
  for (const soubor of soubory) {
    // U nové struktury je číslo displeje známé z názvu složky, takže se
    // cizí složky nemusí vůbec číst.
    if (opts.displej !== undefined && soubor.displej !== undefined) {
      if (soubor.displej !== opts.displej) continue;
    }
    const dn = await nactiDen(soubor);
    poskozeneRadky += dn.poskozene;
    for (const u of dn.udalosti) {
      if (opts.displej !== undefined && u.displej !== opts.displej) continue;
      udalosti.push(u);
    }
  }

  // Relace: potřebujeme její skutečné rozpětí, podle něj se pozná nesmyslné
  // trvání slidu i doba strávená u displeje.
  const relace = new Map<string, { displej: number; od: number; do: number }>();
  for (const u of udalosti) {
    const klic = `${u.displej}:${u.relace || u.cas}`;
    const r = relace.get(klic);
    if (!r) relace.set(klic, { displej: u.displej, od: u.casMs, do: u.casMs });
    else {
      r.od = Math.min(r.od, u.casMs);
      r.do = Math.max(r.do, u.casMs);
    }
  }

  const hraniceDnes = new Date(ted);
  hraniceDnes.setHours(0, 0, 0, 0);
  const zacatekDnes = hraniceDnes.getTime();
  const pred7 = ted - 7 * 86400000;
  const pred30 = ted - 30 * 86400000;
  const pred24h = ted - 86400000;

  // Do kterých období událost nebo relace spadá. Jeden výpočet, ať se
  // hranice neopisují na pěti místech.
  const doObdobi = (casMs: number): Obdobi[] => {
    const kam: Obdobi[] = ["mesic"];
    if (casMs >= pred7) kam.push("tyden");
    if (casMs >= zacatekDnes) kam.push("den");
    return kam;
  };

  interface StavSDobami extends StavDispleje {
    dobyS: PodleObdobi<number[]>;
  }

  const podleDispleje = new Map<number, StavSDobami>();
  const dej = (n: number) => {
    let s = podleDispleje.get(n);
    if (!s) {
      s = {
        displej: n,
        navstevy: zaObdobi(() => 0),
        prumernaDobaS: zaObdobi<number | null>(() => null),
        posledniUdalost: null,
        tichy: true,
        dobyS: zaObdobi<number[]>(() => []),
      };
      podleDispleje.set(n, s);
    }
    return s;
  };

  const celkem = zaObdobi(() => ({ relaci: 0, udalosti: 0 }));

  // Návštěva = jedna relace. Počítá se podle jejího začátku; délka relace
  // jde do průměru u toho displeje, ke kterému relace patří.
  for (const r of relace.values()) {
    const s = dej(r.displej);
    const doba = Math.round((r.do - r.od) / 1000);
    for (const o of doObdobi(r.od)) {
      s.navstevy[o]++;
      celkem[o].relaci++;
      if (doba > 0) s.dobyS[o].push(doba);
    }
  }

  interface StavTypu {
    znamy: boolean;
    otevreni: PodleObdobi<number>;
    doby: PodleObdobi<number[]>;
  }

  const typy = new Map<string, StavTypu>();
  const neznameTypy = new Set<string>();
  let zahozenaTrvani = 0;

  for (const u of udalosti) {
    const s = dej(u.displej);
    if (!s.posledniUdalost || u.cas > s.posledniUdalost) s.posledniUdalost = u.cas;
    if (u.casMs >= pred24h) s.tichy = false;

    const obdobiUdalosti = doObdobi(u.casMs);
    for (const o of obdobiUdalosti) celkem[o].udalosti++;

    if (u.akce !== "zobrazen_slide") continue;

    const klic = u.typCms ?? (u.typSurovy ? u.typSurovy.trim() : "neurčeno");
    if (!u.typCms && u.typSurovy) neznameTypy.add(u.typSurovy.trim());
    let t = typy.get(klic);
    if (!t) {
      t = { znamy: !!u.typCms, otevreni: zaObdobi(() => 0), doby: zaObdobi<number[]>(() => []) };
      typy.set(klic, t);
    }
    for (const o of obdobiUdalosti) t.otevreni[o]++;

    if (u.trvaniS === undefined) continue;
    const r = relace.get(`${u.displej}:${u.relace || u.cas}`);
    const strop = r ? Math.round((r.do - r.od) / 1000) + TOLERANCE_S : TOLERANCE_S;
    // Zbytek stopek z minulé relace: delší, než trvala celá relace.
    if (u.trvaniS < 0 || u.trvaniS > strop) {
      zahozenaTrvani++;
      continue;
    }
    for (const o of obdobiUdalosti) t.doby[o].push(u.trvaniS);
  }

  const prumer = (pole: number[]): number | null =>
    pole.length ? Math.round(pole.reduce((a, b) => a + b, 0) / pole.length) : null;

  const prumeryZaObdobi = (doby: PodleObdobi<number[]>): PodleObdobi<number | null> => {
    const out = zaObdobi<number | null>(() => null);
    for (const o of OBDOBI) out[o] = prumer(doby[o]);
    return out;
  };

  // Displeje, které v datech nejsou vůbec, jsou taky "tiché": tablet se
  // neozval ani jednou.
  for (const n of opts.vsechnyDispleje ?? []) {
    if (opts.displej !== undefined && n !== opts.displej) continue;
    dej(n);
  }

  // Řadí se podle měsíce: pořadí tak zůstane stabilní, i když si kurátor
  // v prohlížeči přepne období na den. Řazení podle zvoleného období si
  // dashboard udělá sám, má na to všechna tři čísla.
  const displeje: StavDispleje[] = [...podleDispleje.values()]
    .map(({ dobyS, ...zbytek }) => ({ ...zbytek, prumernaDobaS: prumeryZaObdobi(dobyS) }))
    .sort((a, b) => b.navstevy.mesic - a.navstevy.mesic || a.displej - b.displej);

  const typySlidu: StavTypuSlidu[] = [...typy.entries()]
    .map(([typ, t]) => ({
      typ,
      znamy: t.znamy,
      otevreni: t.otevreni,
      prumernaDobaS: prumeryZaObdobi(t.doby),
    }))
    .sort((a, b) => b.otevreni.mesic - a.otevreni.mesic);

  return {
    od,
    do: doDne,
    maData: udalosti.length > 0,
    celkem,
    displeje,
    typySlidu,
    ticheDispleje: displeje.filter((d) => d.tichy).map((d) => d.displej),
    kvalita: {
      poskozeneRadky,
      zahozenaTrvani,
      neznameTypy: [...neznameTypy].sort(),
    },
  };
}
