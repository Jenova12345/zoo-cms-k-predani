// Tep tabletů (heartbeat). Tablet u expozice se jednou za minutu ozve na
// POST /api/displays/:id/heartbeat a CMS si zapamatuje, kdy to bylo. Z toho
// se v přehledu displejů i na dashboardu kreslí, který tablet doopravdy žije.
//
// Do té doby se stav zařízení bral z pole `stav` v meta.json. To bylo od
// začátku demo: zapsalo se při zakládání dat a nikdy ho nic nepřepsalo,
// takže tři displeje byly navěky "offline" a zbytek navěky "online".
//
// DRŽÍ SE TO JEN V PAMĚTI PROCESU, schválně:
//   - je to okamžitý stav, ne historie; po restartu serveru nemáme právo
//     tvrdit, že tablet žije, protože o tom nic nevíme,
//   - zápis na disk jednou za minutu ze 31 tabletů by jen mlel diskem ve
//     sdílené složce, ze které si Unity tahá obsah.
//
// Čas si razítkuje server vlastními hodinami. Tablet žádný čas neposílá,
// takže rozjeté hodiny na tabletu nemůžou stav rozhodit.

export type StavZarizeni = "online" | "vypadava" | "offline" | "neznamy";

// Tablet posílá tep každých 60 s (plus náhodných 0-10 s rozptylu, ať 31
// tabletů netrefí server ve stejnou sekundu). Prahy jsou násobky toho
// intervalu, ne kulatá čísla:
//
//   do 3 minut    chybí nejvýš dva tepy — běžné zaškobrtnutí wi-fi,
//                 na tohle se nemá nikdo budit
//   do 15 minut   chybí jich víc; pořád to bývá síť, ne tablet
//   nad 15 minut  patnáct zmeškaných tepů po sobě; bereme za vypnutý
//
// Kdyby Michal interval změnil, mění se tyhle dvě konstanty, nic jiného.
export const ONLINE_DO_MS = 3 * 60 * 1000;
export const VYPADAVA_DO_MS = 15 * 60 * 1000;

export interface Tep {
  kdyMs: number; // čas serveru, ne tabletu
  verze?: string; // verze aplikace na tabletu, do diagnostiky
  obsahZ?: string; // kdy si tablet naposled vyzvedl obsah (jeho vlastní údaj)
  poznamka?: string;
}

export interface StavTabletu {
  stav: StavZarizeni;
  naposledy: string | null; // ISO čas posledního tepu
  predMs: number | null; // jak dávno to bylo
  verze: string | null;
}

// Klíčem je číslo displeje. Mapa je tím shora omezená na počet displejů,
// nemůže růst donekonečna.
const tepy = new Map<number, Tep>();

// Kdy proces naběhl. Potřebné kvůli rozdílu mezi "nevíme" a "víme, že se
// neozval": po restartu je tabulka prázdná a tablet, který normálně žije,
// se ozve až do minuty. Než uplyne VYPADAVA_DO_MS, hlásíme proto "neznamy"
// místo poplachu. Až běžíme dost dlouho, je mlčení samo o sobě odpověď.
const startMs = Date.now();

export function zaznamenejTep(displej: number, info: Omit<Tep, "kdyMs"> = {}, ted = Date.now()): void {
  tepy.set(displej, { kdyMs: ted, ...info });
}

export function stavDispleje(displej: number, ted = Date.now()): StavTabletu {
  const tep = tepy.get(displej);
  if (!tep) {
    const bezimeKratce = ted - startMs < VYPADAVA_DO_MS;
    return {
      stav: bezimeKratce ? "neznamy" : "offline",
      naposledy: null,
      predMs: null,
      verze: null,
    };
  }
  const pred = ted - tep.kdyMs;
  return {
    stav: pred <= ONLINE_DO_MS ? "online" : pred <= VYPADAVA_DO_MS ? "vypadava" : "offline",
    naposledy: new Date(tep.kdyMs).toISOString(),
    predMs: pred,
    verze: tep.verze ?? null,
  };
}

// Jen pro testy a případnou diagnostiku.
export function zapomenTepy(): void {
  tepy.clear();
}
