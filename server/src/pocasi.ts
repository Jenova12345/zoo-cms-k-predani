// Venkovní teplota pro displej u deštného pralesa.
//
// Zdroj je open-meteo.com: veřejné API bez klíče a bez registrace, takže se
// v pavilonu nemusí hlídat expirace tokenu.
//
//   GET https://api.open-meteo.com/v1/forecast
//         ?latitude=<lat>&longitude=<lon>&current=temperature_2m
//   → { "current": { "time": "2026-08-24T12:00", "temperature_2m": 23.4 } }
//
// Pravidla provozu (kvůli 31 tabletům, které se ptají každých pět sekund):
//   1. Teplota se stahuje NA POZADÍ, časovačem, nejvýš jednou za deset minut.
//      Požadavek z tabletu si ji jen přečte z paměti a nikdy na síť nečeká.
//   2. Když stažení selže (výpadek internetu, API neodpoví), použije se
//      poslední známá hodnota z paměti.
//   3. Když žádná není (třeba po restartu serveru bez internetu), použije se
//      záloha, kterou nastavil kurátor v CMS.
//   4. Selhání se nikdy nevyhazuje jako výjimka. Cizí služba nesmí shodit ani
//      zpomalit náš server, tablety mají přednost.
//
// Souřadnice jsou v konfiguraci (POCASI_LAT, POCASI_LON), ne natvrdo.

// ZOO Ostrava, Michálkovice. Přepíše se přes POCASI_LAT / POCASI_LON.
const VYCHOZI_LAT = 49.8265;
const VYCHOZI_LON = 18.3242;

function souradnice(promenna: string, vychozi: number, max: number): number {
  const raw = process.env[promenna];
  if (raw === undefined || raw.trim() === "") return vychozi;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > max) {
    console.warn(`[pocasi] ${promenna}='${raw}' není platná souřadnice, používám ${vychozi}.`);
    return vychozi;
  }
  return n;
}

export const LAT = souradnice("POCASI_LAT", VYCHOZI_LAT, 90);
export const LON = souradnice("POCASI_LON", VYCHOZI_LON, 180);

// Strop z požadavku: stahovat nejvýš jednou za deset minut. Schválně to není
// konfigurovatelné, ať se cizí veřejné API nedá omylem přetížit.
export const INTERVAL_MS = 10 * 60 * 1000;

const TIMEOUT_MS = (() => {
  const raw = Number(process.env.POCASI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
})();

// Od kdy se hodnota v CMS označí jako zastaralá. Na to, co dostane Unity, to
// vliv nemá (podle zadání se stará hodnota používá dál), je to jen upozornění
// pro kurátora, že internet delší dobu nejede.
export const ZASTARALE_PO_MS = 60 * 60 * 1000;

export type ZdrojTeploty = "internet" | "zaloha";

export interface StavPocasi {
  // Poslední úspěšně stažená teplota; null = zatím se nic nepodařilo stáhnout.
  teplota: number | null;
  ziskano: string | null; // ISO čas úspěšného stažení
  posledniPokus: string | null; // ISO čas posledního pokusu (i neúspěšného)
  chyba: string | null; // důvod posledního neúspěchu, jinak null
}

const stav: StavPocasi = {
  teplota: null,
  ziskano: null,
  posledniPokus: null,
  chyba: null,
};

let casovac: NodeJS.Timeout | null = null;

type Log = { info: (msg: string) => void; warn: (msg: string) => void };

function url(): string {
  const params = new URLSearchParams({
    latitude: String(LAT),
    longitude: String(LON),
    current: "temperature_2m",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function duvod(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") {
    return `open-meteo.com neodpovědělo do ${TIMEOUT_MS} ms.`;
  }
  return "Venkovní teplotu se nepodařilo stáhnout (nejspíš nejede internet).";
}

// Jeden pokus o stažení. Nikdy nevyhazuje: neúspěch se jen zapíše do stavu.
async function stahni(log: Log): Promise<void> {
  stav.posledniPokus = new Date().toISOString();
  try {
    const res = await fetch(url(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      stav.chyba = `open-meteo.com odpovědělo chybou HTTP ${res.status}.`;
      log.warn(`[pocasi] HTTP ${res.status}`);
      return;
    }
    const raw = (await res.json()) as { current?: { temperature_2m?: unknown } };
    const hodnota = Number(raw?.current?.temperature_2m);
    if (!Number.isFinite(hodnota)) {
      stav.chyba = "open-meteo.com vrátilo odpověď bez teploty.";
      log.warn("[pocasi] odpověď neobsahuje current.temperature_2m");
      return;
    }
    // Na displeji jsou celé stupně, zaokrouhlujeme tady, ať to nemusí řešit
    // Unity a ať je v CMS vidět přesně to, co jde ven.
    stav.teplota = Math.round(hodnota);
    stav.ziskano = stav.posledniPokus;
    stav.chyba = null;
  } catch (err) {
    // Výpadek internetu je v pavilonu očekávaný stav, ne chyba aplikace.
    stav.chyba = duvod(err);
    log.warn(`[pocasi] stažení selhalo: ${String(err)}`);
  }
}

// Zavolat jednou při startu serveru. První stažení běží na pozadí, start
// serveru na něj nečeká (bez internetu by se jinak zdržel o timeout).
export function spustPocasi(log: Log): void {
  if (casovac) return;
  log.info(`[pocasi] venkovní teplota z open-meteo.com pro ${LAT}, ${LON}, obnova každých 10 min`);
  void stahni(log);
  casovac = setInterval(() => void stahni(log), INTERVAL_MS);
  // Časovač nesmí držet proces naživu při vypínání serveru.
  casovac.unref?.();
}

export function stavPocasi(): StavPocasi {
  return { ...stav };
}

// Teplota do odpovědi tabletu. Čte se z paměti, žádné I/O ani čekání na síť.
// `zaloha` je hodnota od kurátora pro případ, že se ještě nikdy nic nestáhlo.
export function teplotaVenku(zaloha: number): { teplota: number; zdroj: ZdrojTeploty } {
  if (stav.teplota === null) return { teplota: zaloha, zdroj: "zaloha" };
  return { teplota: stav.teplota, zdroj: "internet" };
}
