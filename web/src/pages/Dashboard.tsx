import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, MonitorCheck, MonitorX, RefreshCw } from "lucide-react";
import { api, formatDate, formatDateTime } from "../lib/api";
import { canonicalizeLatin } from "../lib/latin";
import {
  NEPRIRAZENO,
  SLIDE_TYP_LABEL,
  STAV_ZARIZENI_LABEL,
  type SlideTyp,
  type StavZarizeni,
} from "../lib/types";
import type {
  Analytika,
  AnalyticsQuestion,
  AnalyticsQuestions,
  AnalyticsSpecies,
  AnalyticsSummary,
  DisplaySummary,
  PrehledUdalosti,
} from "../lib/types";

// Data dashboardu jsou reálná: displeje z našeho /api/displays (meta.json na
// disku) a dotazy návštěvníků z analytiky chatbota přes náš proxy endpoint
// /api/analytics/... Chatbot backend nemusí běžet, pak se místo čísel píše
// hláška, stránka se normálně otevře.

// Jak často se přenačte stav tabletů. Tep chodí po minutě, častější dotazy
// by jen zatěžovaly server bez nové informace.
const OBNOVA_STAVU_MS = 60_000;

// Barvy proužku a legendy stavu tabletů. Oranžová = pár tepů chybí, ale
// tablet nejspíš žije; červená = přes 15 minut ticho, tohle je porucha;
// prázdné pole = server běží krátce a tablet se ještě nestihl ozvat.
const PROUZEK_STAVU: Record<StavZarizeni, string> = {
  online: "bg-accent-soft border-accent/40",
  vypadava: "bg-amber-soft border-amber/50",
  offline: "bg-danger-soft border-danger/50",
  neznamy: "bg-lineSoft border-line",
};

const PROUZEK_LEGENDA: Record<StavZarizeni, string> = {
  online: "h-2 w-2 rounded-full bg-accent-soft border border-accent/40",
  vypadava: "h-2 w-2 rounded-full bg-amber-soft border border-amber/50",
  offline: "h-2 w-2 rounded-full bg-danger-soft border border-danger/50",
  neznamy: "h-2 w-2 rounded-full bg-lineSoft border border-line",
};

// Popisek proužku: displej, druh a kdy naposled přišel tep.
function popisTabletu(d: DisplaySummary): string {
  const zaklad = `Displej ${d.id}: ${d.druh} — tablet ${STAV_ZARIZENI_LABEL[d.stav]}`;
  if (!d.naposledy) return zaklad;
  const predMin = Math.round((Date.now() - Date.parse(d.naposledy)) / 60_000);
  const kdy = predMin < 1 ? "před chvílí" : `před ${predMin} min`;
  return `${zaklad}, tep ${kdy}${d.verze ? `, verze ${d.verze}` : ""}`;
}

const LIMIT_POSLEDNI = 200; // kolik dotazů stáhnout
const VYPSAT_POSLEDNI = 15; // kolik jich vypsat
const LIMIT_NEZVLADNUTE = 50;
const VYPSAT_NEZVLADNUTE = 12;

const NEPRIPOJENO = "Analytika chatbota zatím není připojená.";
const BEZ_DOTAZU = "Zatím žádné dotazy.";

// Klidná hláška místo čísla, chyby nebo prázdné plochy.
function Hlaska({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-line bg-canvas px-4 py-3">
      <Info className="h-4 w-4 mt-0.5 shrink-0 text-fg-dim" strokeWidth={1.75} />
      <div className="min-w-0">
        <div className="text-sm text-fg-muted">{text}</div>
        {detail && <div className="text-[11px] text-fg-dim mt-0.5">{detail}</div>}
      </div>
    </div>
  );
}

function Cekam({ text = "Načítám…" }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-fg-dim">
      <Loader2 className="h-4 w-4 animate-spin" />
      {text}
    </div>
  );
}

function Divider() {
  return <div className="border-t border-line" />;
}

function cisloCs(n: number): string {
  return n.toLocaleString("cs-CZ");
}

function pocetDotazu(n: number): string {
  if (n === 1) return "1 dotaz";
  if (n >= 2 && n <= 4) return `${n} dotazy`;
  return `${cisloCs(n)} dotazů`;
}

function druhLabel(q: { species_name: string; species_latin: string }): string {
  return q.species_name || q.species_latin || "neurčený druh";
}

// Nejnovější dotazy první; kontrakt pořadí negarantuje, tak si ho srovnáme sami.
function nejnovejsi(questions: AnalyticsQuestion[], kolik: number): AnalyticsQuestion[] {
  return [...questions]
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
    .slice(0, kolik);
}

// Doba u displeje: vteřiny se čtou blbě, minuty jsou pro kurátora užitečnější.
function dobaCs(sekundy: number | null): string {
  if (sekundy === null) return "?";
  if (sekundy < 60) return `${sekundy} s`;
  const m = Math.floor(sekundy / 60);
  const zbytek = sekundy % 60;
  return zbytek ? `${m} min ${zbytek} s` : `${m} min`;
}

// Druh u čísla displeje, ať kurátor nemusí dohledávat, který to je.
function druhDispleje(displays: DisplaySummary[] | null, n: number): string {
  const d = displays?.find((x) => Number(x.id) === n);
  return !d || d.druh === NEPRIRAZENO ? "" : d.druh;
}

// Typ slidu z tabletu: známý přeložíme do názvosloví CMS, neznámý ukážeme
// tak, jak přišel (Michal formát ještě může změnit).
function typSlidoLabel(t: { typ: string; znamy: boolean }): string {
  if (!t.znamy) return t.typ;
  return SLIDE_TYP_LABEL[t.typ as SlideTyp] ?? t.typ;
}

// --- Heat mapa nad reálným půdorysem pavilonu ---

interface HeatNode {
  id: string;
  n: number; // číslo displeje
  popis: string; // druh z našich meta.json (záloha: druh z analytiky)
  x: number; // % šířky půdorysu
  y: number; // % výšky půdorysu
  count: number; // dotazů za sledované období
  score: number; // 0 až 1, intenzita pro barvu a velikost
}

// Oficiální půdorys pavilonu od ZOO, verze S ČÍSLY DISPLEJŮ (17. 8. 2026).
// Kopie podklady/Amphibiarium_mapa 1.png, servíruje se z web/public. Poměr
// stran drží mapu ve správném tvaru při jakékoli šířce okna.
const PUDORYS = "/pavilon-pudorys.png";
const PUDORYS_POMER = "6459 / 6434";

// ┌─ POZICE DISPLEJŮ NA PŮDORYSU ────────────────────────────────────────────┐
// │ Tady se souřadnice ladí. x a y jsou procenta šířky a výšky obrázku       │
// │ (levý horní roh = 0, 0), takže se body škálují s velikostí mapy.         │
// │ Bod displeje N leží na obdélníčku s číslem N.                            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Jak souřadnice vznikly: v plánku je u každé vitríny natištěné číslo displeje
// (1 až 31). Středy obdélníčků jsou odečtené z obrázku detekcí barevných ploch
// (spojité komponenty jedné barvy) a k nim přiřazená čísla přečtená z plánku.
// Kolečka s čísly 1 až 11 jsou sekce (skupiny displejů), ty tu nejsou. Bez čísla
// jsou na plánku i tři tvary, které tedy displeje nejsou: kruhová nádrž
// u sekce 1, zelený pruh u stěny a prostřední fialový box u sekce 8.
// Komentáře u skupin uvádějí barvu a číslo sekce z plánku, jen pro orientaci.
const PUDORYS_BODY: { displej: number; x: number; y: number }[] = [
  // tyrkysová, sekce 1
  { displej: 1, x: 17.4, y: 58.0 },
  // lososová, sekce 2
  { displej: 2, x: 27.2, y: 66.6 },
  { displej: 3, x: 29.5, y: 70.4 },
  { displej: 4, x: 33.1, y: 73.4 },
  { displej: 5, x: 37.3, y: 77.0 },
  { displej: 6, x: 42.0, y: 79.1 },
  { displej: 7, x: 47.7, y: 79.1 },
  // žlutá, sekce 3
  { displej: 8, x: 13.5, y: 77.7 },
  { displej: 9, x: 17.6, y: 81.6 },
  { displej: 10, x: 21.8, y: 85.1 },
  { displej: 11, x: 25.7, y: 88.4 },
  // malinová, sekce 4
  { displej: 12, x: 29.4, y: 93.0 },
  { displej: 13, x: 43.7, y: 95.6 },
  { displej: 14, x: 51.2, y: 93.8 },
  // oranžová, sekce 7
  { displej: 15, x: 73.5, y: 67.3 },
  { displej: 16, x: 77.2, y: 63.7 },
  { displej: 17, x: 79.0, y: 59.3 },
  { displej: 18, x: 78.9, y: 54.3 },
  // fialová, sekce 8 (prostřední box strip nemá číslo, displej to není)
  { displej: 19, x: 94.7, y: 46.7 },
  { displej: 20, x: 94.8, y: 35.6 },
  // modrá, sekce 9, vnější stěna severovýchodní chodby
  { displej: 21, x: 92.8, y: 27.8 },
  { displej: 22, x: 88.9, y: 24.1 },
  { displej: 23, x: 83.5, y: 18.7 },
  // modrá, sekce 9, vnitřní stěna téže chodby
  { displej: 24, x: 79.4, y: 33.5 },
  { displej: 25, x: 75.7, y: 29.9 },
  { displej: 26, x: 72.2, y: 26.5 },
  // hnědá, sekce 10
  { displej: 27, x: 71.0, y: 6.2 },
  { displej: 28, x: 65.2, y: 4.1 },
  { displej: 29, x: 58.5, y: 4.2 },
  { displej: 30, x: 58.9, y: 17.9 },
  // zelená, sekce 11
  { displej: 31, x: 50.9, y: 17.9 },
];

// Nízká návštěvnost zelená → vysoká červená. Stejné zastávky má i legenda
// pod mapou (HEAT_GRADIENT), ať se barvy nerozejdou.
function heatColor(score: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.0, [134, 196, 138]], // světle zelená
    [0.35, [21, 128, 61]], // zelená
    [0.7, [194, 116, 12]], // oranžová
    [1.0, [220, 38, 38]], // červená
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i];
    const [s1, c1] = stops[i + 1];
    if (score <= s1) {
      const t = (score - s0) / (s1 - s0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(220, 38, 38)";
}

const HEAT_GRADIENT = "linear-gradient(90deg, #86C48A, #15803D 35%, #C2740C 70%, #DC2626)";

// Bez analytiky se body kreslí neutrálně šedě, heat mapa bez dat nemá co barvit.
const NEUTRAL = "#A3ADAA";

interface MapaData {
  nodes: HeatNode[];
  maxNode: HeatNode | null; // displej s nejvíc dotazy
  nenaparovano: AnalyticsSpecies[]; // druhy z analytiky bez displeje u nás
  mimoPudorys: number[]; // displeje z CMS, které na plánku nejsou
  chybiVCms: number[]; // displeje z plánku, které v CMS nejsou
}

// Párování analytiky na displeje: primárně přes species_latin proti latin_name
// z našich meta.json (obojí kanonizované stejnými pravidly), display_id jen
// jako záloha, podle kontraktu může být null.
function naparuj(
  displays: DisplaySummary[],
  summary: AnalyticsSummary | null,
  navstevy: Map<number, number> | null,
): MapaData {
  const podleCisla = new Map(displays.map((d) => [Number(d.id), d]));

  const podleLatiny = new Map<string, { count: number; species_name: string }>();
  const podleId = new Map<number, { count: number; species_name: string }>();
  for (const s of summary?.per_species ?? []) {
    const latin = canonicalizeLatin(s.species_latin);
    if (latin) {
      const drive = podleLatiny.get(latin);
      podleLatiny.set(latin, {
        count: (drive?.count ?? 0) + s.count,
        species_name: s.species_name || drive?.species_name || "",
      });
    }
    if (s.display_id !== null) {
      const drive = podleId.get(s.display_id);
      podleId.set(s.display_id, {
        count: (drive?.count ?? 0) + s.count,
        species_name: s.species_name || drive?.species_name || "",
      });
    }
  }

  const pouziteLatiny = new Set<string>();
  const pouziteId = new Set<number>();

  // Párování se počítá pro VŠECHNY displeje z CMS, i pro ty mimo půdorys,
  // jinak by druh napárovaný na displej 35 hlásil, že nemá displej.
  const zasahy = new Map<number, { count: number; species_name: string } | undefined>();
  for (const d of displays) {
    const latin = canonicalizeLatin(d.latin_name ?? "");
    const podleJmena = latin ? podleLatiny.get(latin) : undefined;
    const zaloha = podleJmena ? undefined : podleId.get(Number(d.id));
    if (podleJmena) pouziteLatiny.add(latin);
    if (zaloha) pouziteId.add(Number(d.id));
    zasahy.set(Number(d.id), podleJmena ?? zaloha);
  }

  // Body kreslíme podle půdorysu; displej, který v CMS není, se vynechá.
  const bezScore = PUDORYS_BODY.flatMap((bod) => {
    const d = podleCisla.get(bod.displej);
    if (!d) return [];
    const zasah = zasahy.get(bod.displej);
    // Druh bere přednostně z našich meta.json, jméno z analytiky je záloha.
    const cmsDruh = d.druh === NEPRIRAZENO ? "" : d.druh;
    return [
      {
        id: d.id,
        n: bod.displej,
        popis: cmsDruh || zasah?.species_name || NEPRIRAZENO,
        x: bod.x,
        y: bod.y,
        // Když z tabletů chodí návštěvy, barví mapu ony: je to přímé měření
        // toho, kde se lidi zastavili. Dotazy na chatbota jsou záloha.
        count: navstevy ? (navstevy.get(bod.displej) ?? 0) : (zasah?.count ?? 0),
      },
    ];
  });

  const max = bezScore.reduce((a, b) => Math.max(a, b.count), 0);
  const nodes: HeatNode[] = bezScore.map((n) => ({
    ...n,
    score: max > 0 && n.count > 0 ? Math.max(0.08, n.count / max) : 0,
  }));

  const nenaparovano = (summary?.per_species ?? []).filter((s) => {
    const latin = canonicalizeLatin(s.species_latin);
    if (latin && pouziteLatiny.has(latin)) return false;
    if (s.display_id !== null && pouziteId.has(s.display_id)) return false;
    return true;
  });

  const naPudorysu = new Set(PUDORYS_BODY.map((b) => b.displej));

  return {
    nodes,
    maxNode: max > 0 ? nodes.reduce((a, b) => (b.count > a.count ? b : a), nodes[0]) : null,
    nenaparovano,
    mimoPudorys: displays.map((d) => Number(d.id)).filter((n) => !naPudorysu.has(n)),
    chybiVCms: PUDORYS_BODY.filter((b) => !podleCisla.has(b.displej)).map((b) => b.displej),
  };
}

export default function Dashboard() {
  const [displays, setDisplays] = useState<DisplaySummary[] | null>(null);
  const [chybaDispleju, setChybaDispleju] = useState<string | null>(null);
  const [summary, setSummary] = useState<Analytika<AnalyticsSummary> | null>(null);
  const [posledni, setPosledni] = useState<Analytika<AnalyticsQuestions> | null>(null);
  const [nezvladnute, setNezvladnute] = useState<Analytika<AnalyticsQuestions> | null>(null);
  const [udalosti, setUdalosti] = useState<Analytika<PrehledUdalosti> | null>(null);
  const [nacitani, setNacitani] = useState(true);
  const [hover, setHover] = useState<HeatNode | null>(null);

  // Každý zdroj se vykreslí, jak dorazí, na nedostupný chatbot se čeká do
  // timeoutu a stránka by kvůli němu neměla stát u kolečka. Analytika
  // nevyhazuje výjimku (vrací obálku), seznam displejů ano.
  async function load() {
    setNacitani(true);
    await Promise.all([
      api.displays().then(
        (data) => {
          setDisplays(data);
          setChybaDispleju(null);
        },
        (e: unknown) => {
          setChybaDispleju(
            e instanceof Error ? e.message : "Seznam displejů se nepodařilo načíst.",
          );
        },
      ),
      api.udalosti({ dny: 30 }).then(setUdalosti),
      api.analyticsSummary().then(setSummary),
      api.analyticsQuestions({ limit: LIMIT_POSLEDNI }).then(setPosledni),
      api.analyticsQuestions({ answered: false, limit: LIMIT_NEZVLADNUTE }).then(setNezvladnute),
    ]);
    setNacitani(false);
  }

  useEffect(() => {
    void load();
  }, []);

  // Stav tabletů je živá věc: tep chodí každou minutu, takže se stejně často
  // přenačte i seznam displejů. Zbytek dashboardu (analytika chatbota, události)
  // se neobnovuje — je to drahé a mění se v řádu hodin, ne minut.
  useEffect(() => {
    const t = setInterval(() => {
      api.displays().then(setDisplays, () => {
        // Přeskočené kolo nevadí, za minutu je další. Chybu z prvního
        // načtení už uživatel vidí, druhou hlásit nebudeme.
      });
    }, OBNOVA_STAVU_MS);
    return () => clearInterval(t);
  }, []);

  const summaryData = summary?.dostupne ? summary.data : null;
  const udalostiData = udalosti?.dostupne ? udalosti.data : null;
  const maUdalosti = !!udalostiData?.maData;

  // Kolik tabletů je v jakém stavu. Počítá se ze stejného seznamu, jaký
  // kreslí proužek, takže se čísla a barvy nemůžou rozejít.
  const stavy = useMemo(() => {
    if (!displays) return null;
    const soucet = { online: 0, vypadava: 0, offline: 0, neznamy: 0 };
    for (const d of displays) soucet[d.stav]++;
    return soucet;
  }, [displays]);

  // Návštěvy z tabletů barví heat mapu, když nějaké jsou.
  const navstevyProMapu = useMemo(() => {
    if (!maUdalosti || !udalostiData) return null;
    return new Map(udalostiData.displeje.map((d) => [d.displej, d.navstevyMesic]));
  }, [maUdalosti, udalostiData]);

  const mapa = useMemo(
    () => naparuj(displays ?? [], summaryData, navstevyProMapu),
    [displays, summaryData, navstevyProMapu],
  );

  // Tiché displeje: nejdůležitější věc na dashboardu, znamená spadlý tablet.
  const tiche = udalostiData
    ? udalostiData.displeje.filter((d) => d.tichy).sort((a, b) => a.displej - b.displej)
    : [];
  const navstivene = udalostiData
    ? udalostiData.displeje.filter((d) => d.navstevyMesic > 0)
    : [];

  const obdobi = summaryData?.since ? formatDateTime(summaryData.since) : null;
  const prazdnaAnalytika = summaryData !== null && summaryData.total_questions === 0;

  // Kolečko jen dokud nejsou displeje (ty jsou z našeho disku, tedy hned);
  // analytika se dolije do sekcí sama.
  if (!displays && !chybaDispleju) {
    return (
      <div className="grid place-items-center py-24 text-fg-dim">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Titulek */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">Přehled provozu</h1>
          <p className="text-sm text-fg-muted mt-1.5">
            Pavilon Amphibiárium, ZOO Ostrava
            {obdobi && <span className="text-fg-dim"> · dotazy od {obdobi}</span>}
          </p>
        </div>
        <button onClick={() => void load()} className="btn-ghost" disabled={nacitani}>
          {nacitani ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          )}
          Obnovit
        </button>
      </div>

      {/* Události z tabletů. Nejdřív tiché displeje: spadlý tablet je to
          jediné, co kurátor musí řešit hned. */}
      <section className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
          <h2 className="font-display text-xl font-bold tracking-tight text-fg">
            Provoz tabletů u expozice
          </h2>
          {udalostiData?.maData && (
            <span className="text-xs text-fg-muted tnum">
              {udalostiData.od} až {udalostiData.do}
            </span>
          )}
        </div>

        {udalosti === null ? (
          <Cekam text="Načítám události z tabletů…" />
        ) : !udalosti.dostupne ? (
          <Hlaska text="Události z tabletů se nepodařilo načíst." detail={udalosti.duvod} />
        ) : !udalostiData?.maData ? (
          <Hlaska
            text="Z tabletů zatím nepřišla žádná událost."
            detail={`Čte se ${udalostiData?.od} až ${udalostiData?.do} ze složky udalosti/unity. Až tablety začnou zapisovat, objeví se tu návštěvy, doba u displeje i chyby.`}
          />
        ) : (
          <>
            {/* Tiché displeje */}
            {tiche.length === 0 ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3">
                <MonitorCheck className="h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} />
                <div className="text-sm text-fg-muted">
                  <span className="font-semibold text-fg">Všechny tablety se hlásí.</span> Za
                  posledních 24 hodin přišla událost z každého displeje.
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3">
                <div className="flex items-start gap-2.5">
                  <MonitorX className="h-5 w-5 shrink-0 text-danger" strokeWidth={1.75} />
                  <div className="text-sm text-fg-muted">
                    <span className="font-semibold text-fg">
                      {tiche.length === 1
                        ? "1 displej se 24 hodin neozval."
                        : `${tiche.length} displejů se 24 hodin neozvalo.`}
                    </span>{" "}
                    Nejspíš spadlý nebo odpojený tablet, stojí za kontrolu na místě.
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
                  {tiche.map((d) => (
                    <span
                      key={d.displej}
                      className="chip bg-surface text-fg tnum ring-1 ring-danger/30"
                      title={
                        d.posledniUdalost
                          ? `Poslední událost: ${formatDateTime(d.posledniUdalost)}`
                          : "Zatím nikdy nic neposlal"
                      }
                    >
                      {d.displej}
                      <span className="text-fg-muted">
                        {d.posledniUdalost ? formatDate(d.posledniUdalost) : "nikdy"}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Souhrn období */}
            <div className="grid grid-cols-2 divide-x divide-line border-y border-line sm:grid-cols-4">
              {[
                { popis: "Návštěv (30 dní)", hodnota: cisloCs(udalostiData.celkem.relaci) },
                { popis: "Událostí", hodnota: cisloCs(udalostiData.celkem.udalosti) },
                { popis: "Otevření chatbota", hodnota: cisloCs(udalostiData.celkem.chatu) },
                { popis: "Chyb z tabletů", hodnota: cisloCs(udalostiData.celkem.chyb) },
              ].map((k) => (
                <div key={k.popis} className="px-5 py-4 first:pl-0">
                  <div className="font-display text-2xl font-bold text-fg tnum">{k.hodnota}</div>
                  <div className="text-xs text-fg-muted mt-0.5">{k.popis}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
              {/* Návštěvy podle displeje */}
              <div>
                <h3 className="kicker mb-3">Návštěvy podle displeje</h3>
                {navstivene.length === 0 ? (
                  <Hlaska text="Zatím žádná návštěva." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left kicker">
                        <th className="pb-2 font-semibold">Displej</th>
                        <th className="pb-2 font-semibold text-right">Dnes</th>
                        <th className="pb-2 font-semibold text-right">Týden</th>
                        <th className="pb-2 font-semibold text-right">Měsíc</th>
                        <th className="pb-2 font-semibold text-right">Průměr u displeje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {navstivene.map((d) => (
                        <tr key={d.displej} className="border-t border-lineSoft">
                          <td className="py-2 pr-3">
                            <span className="font-semibold text-fg tnum">{d.displej}</span>{" "}
                            <span className="text-fg-muted">{druhDispleje(displays, d.displej)}</span>
                          </td>
                          <td className="py-2 text-right tnum text-fg-muted">{d.navstevyDnes}</td>
                          <td className="py-2 text-right tnum text-fg-muted">{d.navstevyTyden}</td>
                          <td className="py-2 text-right tnum font-semibold text-fg">
                            {d.navstevyMesic}
                          </td>
                          <td className="py-2 text-right tnum text-fg-muted">
                            {dobaCs(d.prumernaDobaS)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Typy slidů */}
              <div className="lg:border-l lg:border-line lg:pl-10">
                <h3 className="kicker mb-3">Co lidi otevírají</h3>
                {udalostiData.typySlidu.length === 0 ? (
                  <Hlaska text="Zatím nikdo neotevřel žádný slide." />
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left kicker">
                        <th className="pb-2 font-semibold">Typ slidu</th>
                        <th className="pb-2 font-semibold text-right">Otevření</th>
                        <th className="pb-2 font-semibold text-right">Průměrně u něj</th>
                      </tr>
                    </thead>
                    <tbody>
                      {udalostiData.typySlidu.map((t) => (
                        <tr key={t.typ} className="border-t border-lineSoft">
                          <td className="py-2 pr-3 text-fg">
                            {typSlidoLabel(t)}
                            {!t.znamy && (
                              <span
                                className="ml-2 text-[10px] font-semibold uppercase text-amber-deep"
                                title="Tenhle typ CMS nezná, ukazuje se tak, jak přišel z tabletu"
                              >
                                neznámý typ
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right tnum font-semibold text-fg">
                            {cisloCs(t.otevreni)}
                          </td>
                          <td className="py-2 text-right tnum text-fg-muted">
                            {dobaCs(t.prumernaDobaS)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Chyby z tabletů */}
            <div>
              <h3 className="kicker mb-3">Chyby z tabletů</h3>
              {udalostiData.chyby.length === 0 ? (
                <Hlaska text="Žádná chyba, tablety nic nehlásily." />
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {udalostiData.chyby.map((ch, i) => (
                      <tr key={`${ch.cas}-${i}`} className="border-t border-lineSoft">
                        <td className="py-2 pr-4 whitespace-nowrap text-fg-muted tnum">
                          {formatDateTime(ch.cas)}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap font-semibold text-fg tnum">
                          Displej {ch.displej}
                        </td>
                        <td className="py-2 text-danger">{ch.zprava}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Co se z dat vyhodilo. Bez téhle poznámky by tichá chyba
                v datech vypadala jako pravda. */}
            {(udalostiData.kvalita.zahozenaTrvani > 0 ||
              udalostiData.kvalita.poskozeneRadky > 0 ||
              udalostiData.kvalita.neznameTypy.length > 0) && (
              <p className="text-xs text-fg-muted">
                <span className="font-semibold text-fg">Poznámka k datům:</span>{" "}
                {udalostiData.kvalita.zahozenaTrvani > 0 && (
                  <>
                    {udalostiData.kvalita.zahozenaTrvani}× se do průměrů nezapočítalo trvání delší
                    než celá relace (zbytek stopek z minulé relace).{" "}
                  </>
                )}
                {udalostiData.kvalita.poskozeneRadky > 0 && (
                  <>{udalostiData.kvalita.poskozeneRadky}× se přeskočil poškozený řádek. </>
                )}
                {udalostiData.kvalita.neznameTypy.length > 0 && (
                  <>
                    Neznámé typy slidů z tabletu:{" "}
                    {udalostiData.kvalita.neznameTypy.join(", ")}.
                  </>
                )}
              </p>
            )}
          </>
        )}
      </section>

      {/* KPI ze summary; co z dat nejde spočítat, tady není */}
      {summaryData && !prazdnaAnalytika && (
        <div className="grid grid-cols-3 divide-x divide-line border-y border-line">
          {[
            { label: "Dotazů na AI", value: summaryData.total_questions },
            { label: "Odpovězeno", value: summaryData.answered },
            { label: "Bez odpovědi", value: summaryData.unanswered },
          ].map((s) => (
            <div key={s.label} className="px-6 py-5 first:pl-0">
              <div className="kicker">{s.label}</div>
              <div className="mt-2 font-display text-4xl font-bold text-fg tnum leading-none">
                {cisloCs(s.value)}
              </div>
            </div>
          ))}
        </div>
      )}
      {!summary && <Cekam text="Načítám analytiku chatbota…" />}
      {summary && !summary.dostupne && <Hlaska text={NEPRIPOJENO} detail={summary.duvod} />}
      {prazdnaAnalytika && (
        <Hlaska
          text={BEZ_DOTAZU}
          detail={`Chatbot je připojený, za sledované období${obdobi ? ` (od ${obdobi})` : ""} ale nezaznamenal žádný dotaz.`}
        />
      )}

      {/* Mapa dotazů: hero na ploše, bez rámečku */}
      <section className="space-y-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="kicker">
              {navstevyProMapu ? "Kde se lidi zastavují" : "Mapa dotazů na AI"}
            </div>
            <h2 className="font-display text-lg font-semibold text-fg mt-1.5">
              Půdorys pavilonu
            </h2>
          </div>
          {mapa.maxNode && (
            <div className="text-right">
              <div className="font-display text-xl font-bold text-fg tnum leading-none">
                {cisloCs(mapa.maxNode.count)}
              </div>
              <div className="text-[11px] text-fg-dim mt-1">
                špička · displej {mapa.maxNode.n}
              </div>
            </div>
          )}
        </div>

        {chybaDispleju && <Hlaska text="Seznam displejů se nepodařilo načíst." detail={chybaDispleju} />}

        {displays && displays.length === 0 && (
          <Hlaska
            text="V CMS zatím nejsou žádné displeje."
            detail="Datová složka je prázdná, displeje vytvoří `npm run seed`."
          />
        )}

        {displays && displays.length > 0 && (
          <>
            {/* Půdorys drží poměr stran, body jsou umístěné v procentech, takže
                se mapa i body škálují se šířkou okna. */}
            <div
              className="relative mx-auto w-full max-w-[760px]"
              style={{ aspectRatio: PUDORYS_POMER }}
              onMouseLeave={() => setHover(null)}
            >
              {/* Plánek je jen tichý obrys: odbarvený a ztlumený, ať barevné
                  zóny nepřebíjejí body návštěvnosti. */}
              <img
                src={PUDORYS}
                alt="Půdorys pavilonu Amphibiárium"
                draggable={false}
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                style={{ filter: "grayscale(1)", opacity: 0.35 }}
              />

              {mapa.nodes.map((node) => {
                const zvyraznit = summaryData !== null && node.count > 0;
                const color = zvyraznit ? heatColor(node.score) : NEUTRAL;
                const active = hover?.id === node.id;
                // Velikost v procentech mapy, ať bod zůstane v poměru k plánku.
                const velikost = 2.2 + node.score * 2.8;
                return (
                  <button
                    key={node.id}
                    onMouseEnter={() => setHover(node)}
                    className="absolute rounded-full border-2 border-white transition-transform"
                    style={{
                      left: `${node.x}%`,
                      top: `${node.y}%`,
                      width: `${velikost}%`,
                      height: `${velikost}%`,
                      background: color,
                      boxShadow: [
                        "0 1px 3px rgba(16,40,34,0.3)",
                        active ? "0 0 0 3px rgba(15,118,110,0.55)" : "",
                        zvyraznit ? `0 0 ${8 + node.score * 18}px ${node.score * 4}px ${color}55` : "",
                      ]
                        .filter(Boolean)
                        .join(", "),
                      transform: `translate(-50%, -50%) scale(${active ? 1.2 : 1})`,
                      zIndex: active ? 20 : 1,
                    }}
                    aria-label={
                      summaryData
                        ? `Displej ${node.n}, ${node.popis}, ${pocetDotazu(node.count)}`
                        : `Displej ${node.n}, ${node.popis}`
                    }
                  />
                );
              })}

              {hover && (
                <div
                  className="absolute z-30 pointer-events-none rounded-lg border border-line bg-surface px-3 py-2 shadow-cardHover"
                  style={{
                    left: `${hover.x}%`,
                    top: `${hover.y}%`,
                    maxWidth: 220,
                    // U kraje mapy se bublina zarovná dovnitř, ať nevylézá z plochy.
                    transform: `translate(${
                      hover.x > 78 ? "-88%" : hover.x < 22 ? "-12%" : "-50%"
                    }, ${hover.y < 18 ? "18px" : "calc(-100% - 18px)"})`,
                  }}
                >
                  <div className="font-display text-sm font-semibold text-fg tnum">
                    Displej {hover.n}
                  </div>
                  <div className="text-[11px] text-fg-muted">{hover.popis}</div>
                  {summaryData && (
                    <div className="text-[11px] text-fg-muted tnum">{pocetDotazu(hover.count)}</div>
                  )}
                </div>
              )}
            </div>

            {/* Legenda a poznámky zarovnané pod mapu */}
            <div className="mx-auto w-full max-w-[760px] space-y-2.5">
            {summaryData ? (
              <>
                <div className="flex items-center gap-3 text-[11px] text-fg-dim max-w-md">
                  <span>Méně</span>
                  <div className="h-1.5 flex-1 rounded-full" style={{ background: HEAT_GRADIENT }} />
                  <span>Více</span>
                </div>
                {mapa.nenaparovano.length > 0 && (
                  <p className="text-[11px] text-fg-dim">
                    {mapa.nenaparovano.length}{" "}
                    {mapa.nenaparovano.length === 1 ? "druh z analytiky" : "druhů z analytiky"} se
                    nepodařilo napárovat na displej (
                    {mapa.nenaparovano
                      .slice(0, 3)
                      .map((s) => s.species_latin || s.species_name || "?")
                      .join(", ")}
                    {mapa.nenaparovano.length > 3 ? ", …" : ""}). Zkontrolujte latinský název v
                    info panelu displeje.
                  </p>
                )}
              </>
            ) : !summary ? (
              <Cekam />
            ) : (
              <Hlaska
                text={NEPRIPOJENO}
                detail="Body ukazují displeje na půdorysu, intenzita se dokreslí, až začnou chodit návštěvy z tabletů nebo dotazy na chatbota."
              />
            )}

            {/* Kolečka na plánku jsou zóny expozice, ať si je nikdo neplete
                s čísly displejů. */}
            <p className="text-[11px] text-fg-dim">
              Body leží na obdélníčcích s čísly displejů z plánku od ZOO (číslo, druh a počet
              dotazů ukáže nájezd myší). Kolečka s čísly 1 až 11 na plánku jsou sekce, tedy skupiny
              displejů; ty v mapě body nemají.
            </p>

            {/* Plánek od ZOO zachycuje 31 displejů, v CMS jich může být víc. */}
            {mapa.mimoPudorys.length > 0 && (
              <p className="text-[11px] text-fg-dim">
                Půdorys od ZOO zachycuje displeje 1 až {PUDORYS_BODY.length}. V CMS jsou navíc displeje{" "}
                <span className="tnum">{mapa.mimoPudorys.join(", ")}</span>, na plánku nejsou, v
                mapě se proto nezobrazují.
              </p>
            )}
            {mapa.chybiVCms.length > 0 && (
              <p className="text-[11px] text-fg-dim">
                Displeje <span className="tnum">{mapa.chybiVCms.join(", ")}</span> jsou na půdorysu,
                ale v CMS chybí.
              </p>
            )}
            </div>
          </>
        )}
      </section>

      <Divider />

      {/* Dvousloupcový editorial spread: poslední dotazy | co AI nezvládla */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <section>
          <div className="flex items-baseline justify-between gap-3 mb-5">
            <div className="kicker">Poslední dotazy návštěvníků</div>
            {posledni?.dostupne && posledni.data.total > VYPSAT_POSLEDNI && (
              <span className="text-[11px] text-fg-dim tnum">
                {VYPSAT_POSLEDNI} z {cisloCs(posledni.data.total)}
              </span>
            )}
          </div>
          {!posledni && <Cekam />}
          {/* Důvod nedostupnosti je jednou nahoře, tady by se jen opakoval. */}
          {posledni && !posledni.dostupne && <Hlaska text={NEPRIPOJENO} />}
          {posledni?.dostupne && posledni.data.questions.length === 0 && (
            <Hlaska text={BEZ_DOTAZU} />
          )}
          {posledni?.dostupne && posledni.data.questions.length > 0 && (
            <ul className="divide-y divide-lineSoft">
              {nejnovejsi(posledni.data.questions, VYPSAT_POSLEDNI).map((q, i) => (
                <li key={`${q.session_id}-${q.timestamp}-${i}`} className="py-3">
                  <div className="text-sm text-fg">{q.user_message}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-fg-dim">
                    <span>{druhLabel(q)}</span>
                    <span>·</span>
                    <span className="tnum">{formatDateTime(q.timestamp)}</span>
                    {!q.answered && <span className="text-amber">· bez odpovědi</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="lg:border-l lg:border-line lg:pl-10">
          <div className="flex items-baseline justify-between gap-3 mb-5">
            <div className="kicker">Co AI nezvládla</div>
            {nezvladnute?.dostupne && nezvladnute.data.total > VYPSAT_NEZVLADNUTE && (
              <span className="text-[11px] text-fg-dim tnum">
                {VYPSAT_NEZVLADNUTE} z {cisloCs(nezvladnute.data.total)}
              </span>
            )}
          </div>
          {!nezvladnute && <Cekam />}
          {nezvladnute && !nezvladnute.dostupne && <Hlaska text={NEPRIPOJENO} />}
          {nezvladnute?.dostupne && nezvladnute.data.questions.length === 0 && (
            <Hlaska
              text="Zatím žádné nezvládnuté dotazy."
              detail="Všechny zaznamenané dotazy chatbot odpověděl."
            />
          )}
          {nezvladnute?.dostupne && nezvladnute.data.questions.length > 0 && (
            <ul className="divide-y divide-lineSoft">
              {nejnovejsi(nezvladnute.data.questions, VYPSAT_NEZVLADNUTE).map((q, i) => (
                <li key={`${q.session_id}-${q.timestamp}-${i}`} className="py-3">
                  <div className="text-sm text-fg">{q.user_message}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-dim">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber" />
                    <span>{druhLabel(q)}</span>
                    <span>·</span>
                    <span className="tnum">{formatDateTime(q.timestamp)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Divider />

      {/* Stav tabletů v pavilonu. Živá data z tepu, který Michalovo Unity
          posílá každou minutu (server/src/tep.ts). Proužek je teď monitoring,
          ne jen výčet založených displejů. */}
      <section>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div className="kicker">
            Tablety v pavilonu{displays ? ` · ${displays.length}` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-fg-muted">
            {(["online", "vypadava", "offline", "neznamy"] as StavZarizeni[]).map((st) => (
              <span key={st} className="flex items-center gap-1.5">
                <span className={PROUZEK_LEGENDA[st]} />
                {STAV_ZARIZENI_LABEL[st]}
              </span>
            ))}
          </div>
        </div>

        {stavy && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span className="font-semibold text-fg tnum">
              {stavy.online} z {displays?.length ?? 0} online
            </span>
            {stavy.vypadava > 0 && (
              <span className="text-amber-deep tnum">{stavy.vypadava} vypadává</span>
            )}
            {stavy.offline > 0 && (
              <span className="font-semibold text-danger tnum">{stavy.offline} offline</span>
            )}
            {stavy.neznamy > 0 && (
              <span className="text-fg-muted tnum">
                {stavy.neznamy} se zatím neozvalo (server běží krátce)
              </span>
            )}
          </div>
        )}

        {displays && displays.length > 0 && (
          <div className="flex items-end gap-1.5 mt-4">
            {displays.map((d) => (
              <div
                key={d.id}
                title={popisTabletu(d)}
                className="flex-1 flex flex-col items-center gap-1.5"
              >
                <span className={`w-full h-6 rounded-full border ${PROUZEK_STAVU[d.stav]}`} />
                <span className="text-[9px] text-fg-dim tnum">{d.id}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
