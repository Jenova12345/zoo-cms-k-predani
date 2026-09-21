import { promises as fs, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";
import { writeFileAtomic } from "./atomic.js";
import { teplotaVenku, type ZdrojTeploty } from "./pocasi.js";

// Displej u deštného pralesa. Na rozdíl od ostatních displejů nezobrazuje
// obsah druhu ze složek data/displeje, ale stav prostředí pavilonu a odpočet
// do další bouřky z videomappingu. Proto vlastní modul, vlastní soubor
// (data/prales.json) a vlastní endpoint; struktura data/displeje se ho
// netýká a nic se v ní kvůli němu nemění.
//
// Endpoint /api/prales si tahá Unity každých pět sekund z 31 tabletů, tedy
// zhruba šest požadavků za sekundu nepřetržitě. Odpověď proto NESMÍ sahat na
// disk: nastavení se drží v paměti a z disku se čte jen při startu a při
// změně (uložení z CMS, nebo ruční editace souboru, tu odchytí watcher níž).
// Venkovní teplota má stejný režim, viz pocasi.ts.

const SOUBOR = path.join(DATA_ROOT, "prales.json");

export interface PralesNastaveni {
  // Teplota uvnitř pavilonu ve °C. Neměří se, kurátor ji zadává ručně podle
  // technologie pavilonu.
  teplotaVnitrni: number;
  // Vlhkost jako TEXT, ne číslo: na displeji je rozsah ("80-100%").
  vlhkost: string;
  // Použije se, když se venkovní teplotu nepodaří stáhnout a v paměti není
  // ani žádná dřív stažená (typicky po restartu serveru bez internetu).
  teplotaVenkovniZaloha: number;
  // Odpočet do bouřky se dá vypnout, aniž by kurátor přišel o nastavený
  // interval: proto zvlášť přepínač a zvlášť hodnota. Vypnuto = posílá se 0.
  bourkaZapnuta: boolean;
  bourkaIntervalMin: number;
  // Varování pro návštěvníky (epilepsie, mokro u vodních efektů).
  varovaniBlikaniSvetel: boolean;
  varovaniVodniEfekty: boolean;
}

// Plochý JSON, který čte Unity. Názvy polí jsou z kontraktu s Michalem
// (anglicky, snake_case), proto se liší od zbytku CMS.
export interface PralesPayload {
  countdown_seconds: number;
  temperature_internal: number;
  humidity_text: string;
  temperature_external: number;
  current_date: string;
  alert_flashing_lights: boolean;
  alert_water_effects: boolean;
}

export const VYCHOZI_NASTAVENI: PralesNastaveni = {
  teplotaVnitrni: 20,
  vlhkost: "80-100%",
  teplotaVenkovniZaloha: 20,
  bourkaZapnuta: true,
  bourkaIntervalMin: 15,
  varovaniBlikaniSvetel: false,
  varovaniVodniEfekty: false,
};

// --- Meze pro validaci (zrcadlí je i web, viz web/src/pages/Prales.tsx) ---
export const TEPLOTA_MIN = -50;
export const TEPLOTA_MAX = 60;
export const VLHKOST_MAX_ZNAKU = 40;
export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 1440; // jeden den

// --- Nastavení v paměti ---

let nastaveni: PralesNastaveni = { ...VYCHOZI_NASTAVENI };
let watcher: FSWatcher | null = null;

type Log = { info: (msg: string) => void; warn: (msg: string) => void };

// Soubor je cizí vstup (kurátor ho může editovat i ručně), takže se čte
// tolerantně: co je nesmyslné nebo chybí, spadne na výchozí hodnotu. Rozbitý
// prales.json nesmí shodit start serveru ani odpověď tabletům.
function ocisti(raw: unknown): PralesNastaveni {
  const r = (raw ?? {}) as Record<string, unknown>;
  const v = { ...VYCHOZI_NASTAVENI };

  const vnitrni = teplotaNeboNull(r.teplotaVnitrni);
  if (vnitrni !== null) v.teplotaVnitrni = vnitrni;

  const zaloha = teplotaNeboNull(r.teplotaVenkovniZaloha);
  if (zaloha !== null) v.teplotaVenkovniZaloha = zaloha;

  if (typeof r.vlhkost === "string" && r.vlhkost.trim() !== "") {
    v.vlhkost = r.vlhkost.trim().slice(0, VLHKOST_MAX_ZNAKU);
  }

  if (typeof r.bourkaZapnuta === "boolean") v.bourkaZapnuta = r.bourkaZapnuta;

  const interval = Number(r.bourkaIntervalMin);
  if (Number.isInteger(interval) && interval >= INTERVAL_MIN && interval <= INTERVAL_MAX) {
    v.bourkaIntervalMin = interval;
  }

  if (typeof r.varovaniBlikaniSvetel === "boolean") {
    v.varovaniBlikaniSvetel = r.varovaniBlikaniSvetel;
  }
  if (typeof r.varovaniVodniEfekty === "boolean") {
    v.varovaniVodniEfekty = r.varovaniVodniEfekty;
  }
  return v;
}

function teplotaNeboNull(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TEPLOTA_MIN || n > TEPLOTA_MAX) return null;
  return zaokrouhliNaDesetinu(n);
}

// Jedno desetinné místo stačí: víc by na displeji stejně nikdo nepřečetl a
// float bez zaokrouhlení umí vyrobit 20.400000000000002.
function zaokrouhliNaDesetinu(n: number): number {
  return Math.round(n * 10) / 10;
}

// null = soubor se nepodařilo přečíst (chybí, nebo v něm není platný JSON).
// Volající se podle toho rozhodne: při startu se vezmou výchozí hodnoty, za
// běhu se nechá to, co je v paměti.
async function nactiZDisku(log: Log | null): Promise<PralesNastaveni | null> {
  let raw: string;
  try {
    raw = await fs.readFile(SOUBOR, "utf8");
  } catch (err) {
    // Chybějící soubor je normální stav při prvním spuštění, o tom se mlčí.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.warn(`[prales] ${SOUBOR} se nepodařilo přečíst: ${String(err)}`);
    }
    return null;
  }
  try {
    return ocisti(JSON.parse(raw));
  } catch (err) {
    log?.warn(`[prales] ${SOUBOR} není platný JSON, nechávám dosavadní nastavení: ${String(err)}`);
    return null;
  }
}

// Zavolat jednou při startu serveru. Načte nastavení do paměti a nastaví
// sledování souboru, aby se ruční editace na disku projevila stejně jako
// uložení z CMS (obsah displejů to má taky tak, viz README).
export async function spustPrales(log: Log): Promise<void> {
  nastaveni = (await nactiZDisku(log)) ?? { ...VYCHOZI_NASTAVENI };
  await fs.mkdir(DATA_ROOT, { recursive: true }).catch(() => {});

  // Sleduje se SLOŽKA, ne soubor: zápis je atomický (tmp + rename), takže
  // sledování konkrétního inode by se po prvním uložení utrhlo.
  try {
    let planovano: NodeJS.Timeout | null = null;
    watcher = watch(DATA_ROOT, (_udalost, nazev) => {
      if (nazev !== "prales.json") return;
      // Rename umí vyrobit několik událostí za sebou; přečti až po nich.
      if (planovano) clearTimeout(planovano);
      planovano = setTimeout(() => {
        planovano = null;
        void nactiZDisku(log).then((nove) => {
          // Rozbitý soubor nastavení nezahazuje: displej dál jede na tom, co
          // v paměti bylo, dokud to kurátor neopraví. Do logu jde varování.
          if (nove) nastaveni = nove;
        });
      }, 100);
      planovano.unref?.();
    });
    watcher.unref?.();
  } catch (err) {
    // Na některých systémech souborů (síťový disk) watch nefunguje. Není to
    // kritické: uložení z CMS mění paměť rovnou, jen ruční editace souboru
    // se pak projeví až po restartu.
    log.warn(`[prales] sledování ${SOUBOR} se nepodařilo zapnout: ${String(err)}`);
  }

  log.info(
    `[prales] nastaveni načteno (bouřka ${
      nastaveni.bourkaZapnuta ? `každých ${nastaveni.bourkaIntervalMin} min` : "vypnutá"
    })`,
  );
}

// Čte se z paměti, žádné I/O. Kopie, ať si ji volající nemůže přepsat.
export function ziskejNastaveni(): PralesNastaveni {
  return { ...nastaveni };
}

export interface ValidaceChyba {
  ok: false;
  chyba: string;
}

// Validace vstupu z CMS. Přísnější než `ocisti`: tady se špatná hodnota
// neopravuje potichu, ale vrací se kurátorovi hláška, ať vidí, co je špatně.
export function validujNastaveni(raw: unknown): { ok: true; nastaveni: PralesNastaveni } | ValidaceChyba {
  const r = (raw ?? {}) as Record<string, unknown>;

  const teplotaVnitrni = teplotaNeboNull(r.teplotaVnitrni);
  if (teplotaVnitrni === null) {
    return { ok: false, chyba: `Vnitřní teplota musí být číslo mezi ${TEPLOTA_MIN} a ${TEPLOTA_MAX} °C.` };
  }

  const teplotaVenkovniZaloha = teplotaNeboNull(r.teplotaVenkovniZaloha);
  if (teplotaVenkovniZaloha === null) {
    return {
      ok: false,
      chyba: `Záložní venkovní teplota musí být číslo mezi ${TEPLOTA_MIN} a ${TEPLOTA_MAX} °C.`,
    };
  }

  if (typeof r.vlhkost !== "string" || r.vlhkost.trim() === "") {
    return { ok: false, chyba: "Vyplňte vlhkost (například 80-100%)." };
  }
  const vlhkost = r.vlhkost.trim();
  if (vlhkost.length > VLHKOST_MAX_ZNAKU) {
    return { ok: false, chyba: `Vlhkost může mít nejvýš ${VLHKOST_MAX_ZNAKU} znaků.` };
  }
  if (/[\r\n]/.test(vlhkost)) {
    return { ok: false, chyba: "Vlhkost musí být na jednom řádku." };
  }

  if (typeof r.bourkaZapnuta !== "boolean") {
    return { ok: false, chyba: "Chybí přepínač odpočtu do bouřky." };
  }

  const interval = Number(r.bourkaIntervalMin);
  if (!Number.isInteger(interval) || interval < INTERVAL_MIN || interval > INTERVAL_MAX) {
    return {
      ok: false,
      chyba: `Interval bouřky musí být celé číslo minut mezi ${INTERVAL_MIN} a ${INTERVAL_MAX}.`,
    };
  }

  if (typeof r.varovaniBlikaniSvetel !== "boolean" || typeof r.varovaniVodniEfekty !== "boolean") {
    return { ok: false, chyba: "Chybí přepínače varování." };
  }

  return {
    ok: true,
    nastaveni: {
      teplotaVnitrni,
      vlhkost,
      teplotaVenkovniZaloha,
      bourkaZapnuta: r.bourkaZapnuta,
      bourkaIntervalMin: interval,
      varovaniBlikaniSvetel: r.varovaniBlikaniSvetel,
      varovaniVodniEfekty: r.varovaniVodniEfekty,
    },
  };
}

// Uloží na disk a hned promítne do paměti. Pořadí je schválně takové: kdyby
// zápis selhal, v paměti zůstane to, co je na disku, a tablety dostávají
// hodnoty, které si kurátor může ověřit v souboru.
export async function ulozNastaveni(nove: PralesNastaveni): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await writeFileAtomic(SOUBOR, JSON.stringify(nove, null, 2) + "\n");
  nastaveni = { ...nove };
}

// --- Odpočet do bouřky ---

// Zbývající sekundy do další bouřky. Vypnutý odpočet = 0.
//
// Odvozeno od PŮLNOCI, ne od startu serveru: bouřky jedou v pevném rastru
// (interval 15 min = 0:15, 0:30, 0:45, …), takže po restartu serveru odpočet
// naváže přesně tam, kde má být, a nerozejde se s videomappingem. Kdyby se
// počítalo od startu, každý restart by rastr posunul.
//
// Půlnoc je LOKÁLNÍ (čas serveru), stejně jako current_date v odpovědi.
// U intervalu, který se do dne nevejde beze zbytku (např. 7 min), je poslední
// cyklus před půlnocí kratší; pavilon je v tu dobu zavřený, takže to nikomu
// nevadí, ale je dobré o tom vědět.
export function odpocetSekund(n: PralesNastaveni, ted: Date = new Date()): number {
  if (!n.bourkaZapnuta) return 0;
  const intervalMs = n.bourkaIntervalMin * 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;

  const pulnoc = new Date(ted.getFullYear(), ted.getMonth(), ted.getDate(), 0, 0, 0, 0);
  const odPulnoci = ted.getTime() - pulnoc.getTime();
  const zbyvaMs = intervalMs - (odPulnoci % intervalMs);
  // Nahoru: 0 znamená "odpočet vypnutý", takže zapnutý odpočet nikdy nesmí
  // poslat 0. Nejmenší hodnota je 1 sekunda.
  return Math.ceil(zbyvaMs / 1000);
}

// Datum systémovým časem serveru ve tvaru D.M.RR (12.8.26), jak ho chce
// displej. Bez vedoucích nul u dne i měsíce, rok dvouciferný.
export function datumProDisplej(ted: Date = new Date()): string {
  const rok = String(((ted.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  return `${ted.getDate()}.${ted.getMonth() + 1}.${rok}`;
}

// --- Odpověď pro displej ---

// Poskládá přesně to, co se pošle Unity. Jedno místo pro veřejný endpoint
// i pro náhled v CMS, aby kurátor viděl doopravdy tutéž hodnotu, ne její
// druhý výpočet, který by se časem mohl rozejít.
//
// Nesahá na disk: nastavení je v paměti, venkovní teplota taky (stahuje ji
// na pozadí pocasi.ts).
export function sestavPayload(ted: Date = new Date()): {
  payload: PralesPayload;
  zdrojTeploty: ZdrojTeploty;
} {
  const n = nastaveni;
  const venku = teplotaVenku(n.teplotaVenkovniZaloha);
  return {
    payload: {
      countdown_seconds: odpocetSekund(n, ted),
      temperature_internal: n.teplotaVnitrni,
      humidity_text: n.vlhkost,
      temperature_external: venku.teplota,
      current_date: datumProDisplej(ted),
      alert_flashing_lights: n.varovaniBlikaniSvetel,
      alert_water_effects: n.varovaniVodniEfekty,
    },
    zdrojTeploty: venku.zdroj,
  };
}

// --- Popis změn do auditu ---

function prepinac(v: boolean): string {
  return v ? "zapnuto" : "vypnuto";
}

// Do audit logu nejde jen "něco se změnilo", ale co konkrétně. Kurátor pak
// v logu pozná, kdo vypnul varování před blikáním, aniž by musel porovnávat
// verze souboru.
export function popisZmen(stare: PralesNastaveni, nove: PralesNastaveni): string[] {
  const zmeny: string[] = [];
  if (stare.teplotaVnitrni !== nove.teplotaVnitrni) {
    zmeny.push(`vnitřní teplota ${stare.teplotaVnitrni} → ${nove.teplotaVnitrni} °C`);
  }
  if (stare.vlhkost !== nove.vlhkost) {
    zmeny.push(`vlhkost „${stare.vlhkost}" → „${nove.vlhkost}"`);
  }
  if (stare.teplotaVenkovniZaloha !== nove.teplotaVenkovniZaloha) {
    zmeny.push(
      `záložní venkovní teplota ${stare.teplotaVenkovniZaloha} → ${nove.teplotaVenkovniZaloha} °C`,
    );
  }
  if (stare.bourkaZapnuta !== nove.bourkaZapnuta) {
    zmeny.push(`odpočet do bouřky ${prepinac(stare.bourkaZapnuta)} → ${prepinac(nove.bourkaZapnuta)}`);
  }
  if (stare.bourkaIntervalMin !== nove.bourkaIntervalMin) {
    zmeny.push(`interval bouřky ${stare.bourkaIntervalMin} → ${nove.bourkaIntervalMin} min`);
  }
  if (stare.varovaniBlikaniSvetel !== nove.varovaniBlikaniSvetel) {
    zmeny.push(
      `varování blikající světla ${prepinac(stare.varovaniBlikaniSvetel)} → ${prepinac(nove.varovaniBlikaniSvetel)}`,
    );
  }
  if (stare.varovaniVodniEfekty !== nove.varovaniVodniEfekty) {
    zmeny.push(
      `varování vodní efekty ${prepinac(stare.varovaniVodniEfekty)} → ${prepinac(nove.varovaniVodniEfekty)}`,
    );
  }
  return zmeny;
}
