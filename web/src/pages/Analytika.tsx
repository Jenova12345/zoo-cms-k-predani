import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Clock,
  Loader2,
  RefreshCw,
  Users,
} from "lucide-react";
import { api } from "../lib/api";
import { HeatMapa } from "../components/HeatMapa";
import { DNY_V_TYDNU, TYP_SLIDU_LABEL } from "../lib/types";
import type {
  Analytika as AnalytikaObalka,
  AnalyticsQuestions,
  AnalyticsSummary,
  AnalytikaNavstevnosti,
  DisplaySummary,
  Granularita,
  KdyChodi,
  SouhrnObdobi,
} from "../lib/types";

// Analytika návštěvnosti pavilonu. Čte se výhradně z událostí, které
// zapisují tablety (Unity) — CMS je jen zobrazuje.
//
// Všechna čísla počítá server nad denními souhrny (server/src/analytika.ts);
// tady se nic neagreguje. Roční rozsah je 11 milionů řádků logu, to nemá
// v prohlížeči co dělat.

type Predvolba = "mesic" | "pulrok" | "rok" | "vlastni";

const PREDVOLBY: { id: Predvolba; popis: string; dnu: number }[] = [
  { id: "mesic", popis: "Měsíc", dnu: 30 },
  { id: "pulrok", popis: "Půl roku", dnu: 183 },
  { id: "rok", popis: "Rok", dnu: 365 },
];

const GRANULARITY: { id: Granularita; popis: string }[] = [
  { id: "den", popis: "Po dnech" },
  { id: "tyden", popis: "Po týdnech" },
  { id: "mesic", popis: "Po měsících" },
];

function dnesISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function odecti(denStr: string, dnu: number): string {
  return new Date(Date.parse(`${denStr}T00:00:00Z`) - dnu * 86400000).toISOString().slice(0, 10);
}

function cislo(n: number): string {
  return n.toLocaleString("cs");
}

// Popisky osy Y. Plné číslo se do osy nevejde — „220 000" se v úzkém
// sloupci ořízne zleva na „20 000" a graf pak tiše lže o řád. Zkrácený
// tvar („220 tis.") se vejde vždycky; v tooltipu zůstává číslo celé.
const KOMPAKTNE = new Intl.NumberFormat("cs", { notation: "compact", maximumFractionDigits: 1 });

function cisloOsy(n: number): string {
  return n < 10000 ? cislo(n) : KOMPAKTNE.format(n);
}

// Doba se čte líp jako „2 min 12 s" než jako 132 sekund.
function doba(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const zbytek = s % 60;
  return zbytek ? `${m} min ${zbytek} s` : `${m} min`;
}

function datumCesky(iso: string): string {
  const [r, m, d] = iso.split("-");
  return `${Number(d)}. ${Number(m)}. ${r}`;
}

// Kolik musí mít minulé období naměřeno, aby z něj šlo počítat procento.
// Pod touhle hranicí je poměr jen šum: z 2 relací na 1 400 vyjde „+70 710 %",
// což vypadá jako zázračný růst, a přitom to znamená jen „tehdy se ještě
// neměřilo". Zaokrouhlené na desítky, přesná hodnota není podstatná —
// důležité je nepouštět ven čísla, která nikdo neumí přečíst.
const MIN_PRO_POROVNANI = 30;

// Změna proti minulému období. Null znamená „nebylo s čím porovnat" —
// dělit nulou a napsat +∞ % by bylo horší než nenapsat nic.
function zmena(ted: number, drive: number): number | null {
  if (drive < MIN_PRO_POROVNANI) return null;
  return Math.round(((ted - drive) / drive) * 100);
}

function Zmena({ ted, drive }: { ted: number; drive: number | undefined }) {
  if (drive === undefined) return null;
  const z = zmena(ted, drive);
  if (z === null) {
    // Říká se PROČ tam procento není, ať to nevypadá jako chyba načtení.
    return (
      <span
        className="text-xs text-fg-dim"
        title={`Předchozí období má jen ${drive.toLocaleString("cs-CZ")} — na procento je to málo, vyšlo by nesmyslné číslo.`}
      >
        {drive === 0 ? "minule nic" : "minule skoro nic"}
      </span>
    );
  }
  const barva = z > 0 ? "text-accent" : z < 0 ? "text-danger" : "text-fg-dim";
  return (
    <span className={`text-xs font-semibold tnum ${barva}`}>
      {z > 0 ? "+" : ""}
      {z} %
    </span>
  );
}

function Dlazdice({
  ikona: Ikona,
  popis,
  hodnota,
  podpis,
  ted,
  drive,
}: {
  ikona: typeof Users;
  popis: string;
  hodnota: string;
  podpis?: string;
  ted?: number;
  drive?: number;
}) {
  return (
    <div className="rounded-xl bg-surface p-4 ring-1 ring-line">
      <div className="flex items-center gap-2 text-fg-muted">
        <Ikona className="h-4 w-4 text-accent" strokeWidth={1.75} />
        <span className="text-xs font-semibold uppercase tracking-wide">{popis}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-2xl font-bold tracking-tight text-fg tnum">{hodnota}</span>
        {ted !== undefined && <Zmena ted={ted} drive={drive} />}
      </div>
      {podpis && <div className="mt-0.5 text-xs text-fg-dim">{podpis}</div>}
    </div>
  );
}

// Žebříček i rozpad typů jsou seznamy s proužkem, ne grafy — proto bez
// knihovny. Proužek je podíl vůči nejsilnější položce, ne vůči součtu:
// jde o to, jak jsou na tom položky mezi sebou.
function Prouzek({
  popis,
  poznamka,
  hodnota,
  zMaxima,
  vpravo,
}: {
  popis: string;
  poznamka?: string;
  hodnota: string;
  zMaxima: number;
  vpravo?: string;
}) {
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium text-fg">
          {popis}
          {poznamka && <span className="ml-1.5 text-xs font-normal text-fg-dim">{poznamka}</span>}
        </span>
        <span className="shrink-0 text-sm tnum text-fg-muted">
          {hodnota}
          {vpravo && <span className="ml-2 text-xs text-fg-dim">{vpravo}</span>}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-lineSoft">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${Math.max(2, zMaxima * 100)}%` }}
        />
      </div>
    </li>
  );
}

// --- Záložky ---------------------------------------------------------------
//
// Analytika má dost sekcí na to, aby se pod sebou nedaly přehlédnout. Období
// zůstává jedno pro všechny záložky: jsou to tři pohledy na tatáž data.

type Zalozka = "navstevnost" | "chovani" | "ai";

const ZALOZKY: { klic: Zalozka; popis: string }[] = [
  { klic: "navstevnost", popis: "Návštěvnost" },
  { klic: "chovani", popis: "Chování" },
  { klic: "ai", popis: "AI" },
];

// Popisek koše „slidů na relaci". Čeština má tři tvary a rozsah („4-5")
// se chová jako množné číslo, ne jako dvojka — proto se to nedá odvodit
// z prvního znaku.
function popisKose(kos: string): string {
  if (kos === "1") return "1 slide";
  if (kos === "2" || kos === "3") return `${kos} slidy`;
  if (kos === "11+") return "11 a víc slidů";
  return `${kos.replace("-", "–")} slidů`;
}

// --- Kdy lidi chodí: den v týdnu × hodina -----------------------------------

// Mřížka má 7 × 24 buněk a barví se stejnou logikou jako heat mapa: škála
// jde od NEJMENŠÍ nenulové hodnoty k největší, ne od nuly. Provoz pavilonu
// je soustředěný do pár hodin, takže škála od nuly by ukázala pět tmavých
// polí a zbytek prázdný.
function KdyChodiMrizka({ data }: { data: KdyChodi }) {
  const hodnoty = data.mrizka.flat().filter((n) => n > 0);
  const min = hodnoty.length ? Math.min(...hodnoty) : 0;
  const rozpeti = data.max - min;

  // Prázdné krajní hodiny se schovají: pavilon má v noci zavřeno a dvanáct
  // prázdných sloupců jen ubírá místo těm, kde se něco děje.
  const aktivni = Array.from({ length: 24 }, (_, h) =>
    data.mrizka.some((radek) => radek[h] > 0) ? h : -1,
  ).filter((h) => h >= 0);
  const odH = aktivni.length ? aktivni[0] : 8;
  const doH = aktivni.length ? aktivni[aktivni.length - 1] : 18;
  const hodiny = Array.from({ length: doH - odH + 1 }, (_, i) => odH + i);

  if (data.max === 0) return <p className="mt-4 text-sm text-fg-dim">Zatím žádná data.</p>;

  // Mřížka se roztahuje přes celou kartu: buňky jsou zlomky šířky, ne pevné
  // pixely. Čísla v buňkách se ukazují jen když je dost místa (od ~34 px),
  // jinak by se lámala přes sebe — na úzkém okně zůstane jen barva a tooltip.
  const sirkaBunky = `${100 / (hodiny.length + 1)}%`;

  return (
    <div className="mt-4">
      <table className="w-full table-fixed border-separate border-spacing-1">
        <thead>
          <tr>
            <th style={{ width: sirkaBunky }} />
            {hodiny.map((h) => (
              <th
                key={h}
                className="pb-1 text-xs font-semibold text-fg-muted tnum"
                style={{ width: sirkaBunky }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DNY_V_TYDNU.map((denNazev, i) => (
            <tr key={denNazev}>
              <td className="pr-2 text-right text-sm font-semibold text-fg-muted">{denNazev}</td>
              {hodiny.map((h) => {
                const n = data.mrizka[i][h];
                // Prázdná buňka je světlá plocha, ne „nejmenší hodnota":
                // rozdíl mezi „nikdo nepřišel" a „přišel jeden" je podstatný.
                const podil = n <= 0 ? null : rozpeti > 0 ? (n - min) / rozpeti : 1;
                return (
                  <td
                    key={h}
                    title={`${denNazev} ${h}:00 — ${n.toLocaleString("cs-CZ")} relací`}
                    className="h-11 rounded-md text-center align-middle text-[11px] font-semibold tnum"
                    style={{
                      background:
                        podil === null
                          ? "var(--barva-canvas, #F4F6F5)"
                          : `rgba(15,118,110,${0.12 + podil * 0.88})`,
                      // Na tmavém poli je tmavý text nečitelný.
                      color: podil !== null && podil > 0.55 ? "#FFFFFF" : "var(--barva-fg-dim, #6B7B76)",
                    }}
                  >
                    {n > 0 ? cislo(n) : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-dim">
        <span className="tnum">{cislo(min)}</span>
        <div
          className="h-2 w-32 rounded-full"
          style={{ background: "linear-gradient(90deg, rgba(15,118,110,0.12), rgb(15,118,110))" }}
        />
        <span className="tnum">{cislo(data.max)}</span>
        <span>relací za hodinu · škála od nejmenší po největší naměřenou hodnotu</span>
      </div>
    </div>
  );
}

// --- AI dotazy v čase -------------------------------------------------------

// Dotazy dodává Danielův backend a vrací je jako jednotlivé záznamy, ne jako
// řadu v čase — sečíst do dnů je tedy na nás.
//
// POZOR NA STROP: kontrakt vrací nejvýš 2000 dotazů na jeden požadavek
// a stránkování neumí. Za delší období jich může být víc, a pak graf NENÍ
// celý obrázek. Když se to stane, napíše se to nad grafem místo kreslení
// křivky, která vypadá jako pravda.
function AiVCase({
  dotazy,
  od,
  doDne,
}: {
  dotazy: AnalyticsQuestions;
  od: string;
  doDne: string;
}) {
  const poDnech = useMemo(() => {
    const m = new Map<string, number>();
    for (const q of dotazy.questions) {
      const den = q.timestamp.slice(0, 10);
      if (den < od || den > doDne) continue;
      m.set(den, (m.get(den) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [dotazy, od, doDne]);

  const max = poDnech.reduce((a, [, n]) => Math.max(a, n), 0);
  const useknuto = dotazy.total > dotazy.questions.length;

  if (poDnech.length === 0) {
    return <p className="mt-4 text-sm text-fg-dim">Za tohle období nedorazily žádné dotazy.</p>;
  }

  return (
    <>
      {useknuto && (
        <p className="mt-3 rounded-lg bg-amber-soft px-3 py-2 text-xs text-amber-deep">
          Chatbot za tohle období eviduje {cislo(dotazy.total)} dotazů, ale na jeden požadavek jich
          pošle nejvýš {cislo(dotazy.questions.length)}. Graf je jen z nich — neberte ho jako celý
          obrázek. Kratší období vrátí úplná čísla.
        </p>
      )}
      <div className="mt-4 flex h-40 items-end gap-0.5">
        {poDnech.map(([den, n]) => (
          <div
            key={den}
            title={`${datumCesky(den)} — ${cislo(n)} dotazů`}
            className="flex-1 rounded-t-sm bg-accent/70 transition-colors hover:bg-accent"
            style={{ height: `${max > 0 ? Math.max(2, (n / max) * 100) : 0}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-fg-dim tnum">
        <span>{datumCesky(poDnech[0][0])}</span>
        <span>špička {cislo(max)} / den</span>
        <span>{datumCesky(poDnech[poDnech.length - 1][0])}</span>
      </div>
    </>
  );
}

export default function Analytika() {
  const [predvolba, setPredvolba] = useState<Predvolba>("mesic");
  const [od, setOd] = useState(() => odecti(dnesISO(), 29));
  const [doDne, setDoDne] = useState(dnesISO);
  const [granularita, setGranularita] = useState<Granularita | null>(null); // null = nech na serveru
  const [porovnat, setPorovnat] = useState(true);

  const [data, setData] = useState<AnalytikaNavstevnosti | null>(null);
  const [nacitam, setNacitam] = useState(true);
  const [chyba, setChyba] = useState<string | null>(null);

  // Záložky. Období je SPOLEČNÉ pro všechny: jsou to tři pohledy na tatáž
  // data, ne tři nezávislé stránky.
  const [zalozka, setZalozka] = useState<Zalozka>("navstevnost");

  // Displeje (pro půdorys) a dotazy na AI. Stahují se až s otevřením záložky,
  // která je potřebuje — bez toho by každé načtení Analytiky volalo backend
  // chatbota, i když si nikdo mapu ani AI neotevře.
  const [displeje, setDispleje] = useState<DisplaySummary[] | null>(null);
  const [aiDotazy, setAiDotazy] = useState<AnalytikaObalka<AnalyticsQuestions> | null>(null);
  const [aiSouhrn, setAiSouhrn] = useState<AnalytikaObalka<AnalyticsSummary> | null>(null);

  const nacti = useCallback(async () => {
    setNacitam(true);
    setChyba(null);
    try {
      const a = await api.analytika({
        od,
        do: doDne,
        granularita: granularita ?? undefined,
        porovnat,
      });
      setData(a);
    } catch (e) {
      setChyba(e instanceof Error ? e.message : "Data se nepodařilo načíst.");
    } finally {
      setNacitam(false);
    }
  }, [od, doDne, granularita, porovnat]);

  useEffect(() => {
    void nacti();
  }, [nacti]);

  // Půdorys potřebuje seznam displejů. Stáhne se jednou, na období nezávisí.
  useEffect(() => {
    if (zalozka !== "chovani" || displeje) return;
    api.displays().then(setDispleje, () => setDispleje([]));
  }, [zalozka, displeje]);

  // Dotazy a souhrn z backendu chatbota. Závisí na období, takže se po jeho
  // změně natáhnou znovu; `od` se posílá jako začátek dne, ať okno sedí
  // s tím, co ukazuje zbytek stránky.
  useEffect(() => {
    if (zalozka !== "ai") return;
    let zruseno = false;
    const since = new Date(`${od}T00:00:00`).toISOString();
    void api
      .analyticsQuestions({ since, limit: 2000 })
      .then((d) => !zruseno && setAiDotazy(d))
      .catch(() => !zruseno && setAiDotazy({ dostupne: false, duvod: "Nepodařilo se načíst." }));
    void api
      .analyticsSummary(since)
      .then((d) => !zruseno && setAiSouhrn(d))
      .catch(() => !zruseno && setAiSouhrn({ dostupne: false, duvod: "Nepodařilo se načíst." }));
    return () => {
      zruseno = true;
    };
  }, [zalozka, od]);

  // Návštěvy z tabletů barví půdorys. Je to přímé měření toho, kde se lidi
  // zastavili, takže má přednost před dotazy na AI.
  const navstevyProMapu = useMemo(() => {
    if (!data) return null;
    const m = new Map<number, number>();
    for (const d of data.displeje) m.set(d.displej, d.relaci);
    return m.size ? m : null;
  }, [data]);

  function zvolPredvolbu(p: Predvolba) {
    setPredvolba(p);
    setGranularita(null); // ať ji server navrhne k nové délce období
    const nalez = PREDVOLBY.find((x) => x.id === p);
    if (!nalez) return;
    const dnesek = dnesISO();
    setDoDne(dnesek);
    setOd(odecti(dnesek, nalez.dnu - 1));
  }

  const maxRelaci = useMemo(
    () => Math.max(1, ...(data?.displeje ?? []).map((d) => d.relaci)),
    [data],
  );
  const maxZobrazeni = useMemo(
    () => Math.max(1, ...(data?.typySlidu ?? []).map((t) => t.zobrazeni)),
    [data],
  );

  // Oranžová tečka u „Kvalita dat": zahazuje se nezanedbatelný kus vstupu?
  // Kolik řádků dorazilo celkem nevíme (souhrny drží jen výsledky, ne počet
  // řádků), takže se to poměřuje proti počtu událostí, které se přečíst
  // podařily. Je to odhad, a stačí: jde o to, aby se na tichou chybu přišlo,
  // ne o přesné procento.
  const vyraznaZtrata = useMemo(() => {
    if (!data) return false;
    const { poskozeneRadky } = data.kvalita;
    const precteno = data.celkem.relaci + data.celkem.zobrazeni;
    return poskozeneRadky > 0 && poskozeneRadky > (precteno + poskozeneRadky) * 0.01;
  }, [data]);

  const c: SouhrnObdobi | undefined = data?.celkem;
  const p = data?.porovnani?.celkem;
  const prazdno = !!data && data.celkem.relaci === 0 && data.celkem.zobrazeni === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-fg">Analytika</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Jak návštěvníci používají tablety u expozice. Data zapisují samy tablety, CMS je jen
            čte.
          </p>
        </div>
        <button onClick={() => void nacti()} className="btn-ghost" disabled={nacitam}>
          {nacitam ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          )}
          Obnovit
        </button>
      </div>

      {/* Ovládání období */}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-xl bg-canvas px-4 py-3 ring-1 ring-line">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
            Období
          </div>
          <div className="flex gap-1">
            {PREDVOLBY.map((v) => (
              <button
                key={v.id}
                onClick={() => zvolPredvolbu(v.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  predvolba === v.id
                    ? "bg-accent text-white"
                    : "text-fg-muted hover:bg-surface hover:text-fg"
                }`}
              >
                {v.popis}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
            Vlastní rozsah
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={od}
              max={doDne}
              onChange={(e) => {
                setOd(e.target.value);
                setPredvolba("vlastni");
                setGranularita(null);
              }}
              className="input py-1.5 text-sm"
              aria-label="Od data"
            />
            <span className="text-fg-dim">–</span>
            <input
              type="date"
              value={doDne}
              min={od}
              max={dnesISO()}
              onChange={(e) => {
                setDoDne(e.target.value);
                setPredvolba("vlastni");
                setGranularita(null);
              }}
              className="input py-1.5 text-sm"
              aria-label="Do data"
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
            Dělení
          </div>
          <div className="flex gap-1">
            {GRANULARITY.map((g) => (
              <button
                key={g.id}
                onClick={() => setGranularita(g.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  data?.granularita === g.id
                    ? "bg-surface text-fg ring-1 ring-line"
                    : "text-fg-muted hover:bg-surface hover:text-fg"
                }`}
              >
                {g.popis}
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={porovnat}
            onChange={(e) => setPorovnat(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          Porovnat s předchozím obdobím
        </label>
      </div>

      {/* Záložky. Období nad nimi platí pro všechny — jsou to tři pohledy
          na tatáž data, ne tři nezávislé stránky. */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {ZALOZKY.map((z) => (
          <button
            key={z.klic}
            onClick={() => setZalozka(z.klic)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold transition-colors ${
              zalozka === z.klic
                ? "border-accent text-accent"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
            aria-current={zalozka === z.klic ? "page" : undefined}
          >
            {z.popis}
          </button>
        ))}
      </div>

      {chyba && <p className="text-sm text-danger">{chyba}</p>}

      {/* Čísla z TABLETŮ: dlaždice i obě poznámky o kvalitě dat. Na záložce AI
          se neukazují — tam jsou data z backendu chatbota a „Relací 8 901"
          nad grafem dotazů by svádělo k tomu číst to jako jeden celek.

          Kolik displejů vůbec posílá data, zůstává vidět: to není technikálie,
          ale to hlavní, co se o číslech níž musí vědět — jsou jen z části
          pavilonu. Naopak poškozené řádky a neznámé typy slidů kurátorovi nic
          neříkají a dělaly nahoře poplach, takže jsou sbalené stejně jako
          v přehledu. */}
      {zalozka !== "ai" &&
        data &&
        data.kvalita.displejuSData < data.kvalita.displejuCelkem && (
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-soft px-4 py-3 text-sm text-amber-deep">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
          <div>
            Data posílá <strong className="font-semibold">{data.kvalita.displejuSData}</strong> z{" "}
            {data.kvalita.displejuCelkem} displejů. Čísla níž jsou jen z nich, zbytek se doplní sám,
            až začnou tablety zapisovat.
          </div>
        </div>
      )}

      {zalozka !== "ai" &&
        data &&
        (data.kvalita.poskozeneRadky > 0 ||
          data.kvalita.zahozenaTrvani > 0 ||
          data.kvalita.neznameTypy.length > 0) && (
          <details className="rounded-lg border border-line bg-canvas px-4 py-2.5">
            <summary className="cursor-pointer text-xs font-semibold text-fg-muted">
              Kvalita dat (pro správce)
              {vyraznaZtrata && (
                <span
                  className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-amber align-middle"
                  title="Zahazuje se nezanedbatelná část vstupu, koukněte se na to"
                />
              )}
            </summary>
            <p className="mt-2 text-xs text-fg-muted">
              {data.kvalita.poskozeneRadky > 0 && (
                <>{cislo(data.kvalita.poskozeneRadky)}× se přeskočil poškozený řádek logu. </>
              )}
              {data.kvalita.zahozenaTrvani > 0 && (
                <>
                  {cislo(data.kvalita.zahozenaTrvani)}× se do průměrů nezapočítalo trvání delší než
                  celá relace (zbytek stopek z minulé relace).{" "}
                </>
              )}
              {data.kvalita.neznameTypy.length > 0 && (
                <>Neznámé typy slidů z tabletu: {data.kvalita.neznameTypy.join(", ")}.</>
              )}
            </p>
            <p className="mt-1.5 text-[11px] text-fg-dim">
              Čte se {data.od} až {data.do} ze složky udalosti/unity. Ukázky odmítnutých řádků píše
              server do logu s předponou [udalosti].
            </p>
          </details>
        )}

      {/* Souhrnné dlaždice */}
      {zalozka !== "ai" && c && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Dlazdice
            ikona={Users}
            popis="Relací"
            hodnota={cislo(c.relaci)}
            podpis="kolikrát někdo přišel k displeji"
            ted={c.relaci}
            drive={p?.relaci}
          />
          <Dlazdice
            ikona={Clock}
            popis="Průměrně u displeje"
            hodnota={doba(c.prumernaDobaS)}
            podpis="jedna relace od začátku do konce"
          />
          {/* „Skutečné dotazy" tu bývaly čtvrtou dlaždicí a počítaly akci
              `otevren_chat`. Tu ale Unity neposílá (ověřeno nad celými
              produkčními logy), takže ukazovaly natvrdo nulu a vypadalo to,
              že se návštěvníci AI neptají. Kolik dotazů doopravdy padlo, ví
              Danielův backend a je to v dashboardu. */}
          <Dlazdice
            ikona={Bot}
            popis="Otevření AI slidu"
            hodnota={cislo(c.aiZobrazeni)}
            podpis="kolikrát se AI slide zobrazil"
            ted={c.aiZobrazeni}
            drive={p?.aiZobrazeni}
          />
        </div>
      )}

      {/* --- Záložka: Návštěvnost --- */}
      {zalozka === "navstevnost" && (
        <>
      {/* Hlavní graf */}
      <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">
            Návštěvnost v čase
          </h2>
          <span className="text-xs text-fg-dim">
            {datumCesky(od)} – {datumCesky(doDne)}
            {data?.porovnani && (
              <>
                {" · předchozí období "}
                {datumCesky(data.porovnani.od)} – {datumCesky(data.porovnani.do)}
              </>
            )}
          </span>
        </div>

        <div className="mt-4 h-72">
          {nacitam && !data ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-dim">
              <Loader2 className="h-4 w-4 animate-spin" /> Počítám…
            </div>
          ) : prazdno ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <BarChart3 className="h-8 w-8 text-fg-dim" strokeWidth={1.5} />
              <p className="text-sm font-medium text-fg-muted">
                Za tohle období nepřišla žádná čitelná data.
              </p>
              <p className="text-xs text-fg-dim">
                Zkuste jiný rozsah, nebo počkejte, až tablety začnou zapisovat.
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data?.body ?? []} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="vypln" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0F766E" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#0F766E" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#F0F2F1" vertical={false} />
                <XAxis
                  dataKey="popis"
                  tick={{ fill: "#8A9994", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "#E6E9E7" }}
                  minTickGap={16}
                />
                <YAxis
                  tick={{ fill: "#8A9994", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(v) => cisloOsy(Number(v))}
                />
                <Tooltip
                  cursor={{ stroke: "#5FA39A", strokeWidth: 1 }}
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid #E6E9E7",
                    boxShadow: "0 8px 24px -8px rgba(16,40,34,0.14)",
                    fontSize: 13,
                  }}
                  labelStyle={{ color: "#16302B", fontWeight: 700 }}
                  // Výchozí oddělovač Rechartsu je " : " — mezera před
                  // dvojtečkou se v češtině nepíše.
                  separator=": "
                  formatter={(v) => [cislo(Number(v ?? 0)), "relací"]}
                />
                <Area
                  type="monotone"
                  dataKey="relaci"
                  stroke="#0F766E"
                  strokeWidth={2}
                  fill="url(#vypln)"
                  dot={false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

          <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">
            Nejsledovanější displeje
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Podle počtu relací. Vpravo průměrná doba, kterou u displeje návštěvník stráví.
          </p>
          {data && data.displeje.length > 0 ? (
            <ul className="mt-3 divide-y divide-lineSoft">
              {data.displeje.slice(0, 12).map((d) => (
                <Prouzek
                  key={d.displej}
                  popis={d.druh ?? `Displej ${d.displej}`}
                  // Číslo displeje jen u pojmenovaných — u „Displej 20" by
                  // z toho bylo „Displej 20 #20".
                  poznamka={d.druh ? `#${d.displej}` : undefined}
                  hodnota={cislo(d.relaci)}
                  vpravo={doba(d.prumernaDobaS)}
                  zMaxima={d.relaci / maxRelaci}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-fg-dim">Zatím žádná data.</p>
          )}
          {data && data.kvalita.mimoZebricek.length > 0 && (
            <p className="mt-3 text-xs text-fg-dim">
              Mimo žebříček: displeje {data.kvalita.mimoZebricek.join(", ")} — v přehledu CMS
              nejsou, do celkových čísel se ale počítají.
            </p>
          )}
        </section>

            <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
              <h2 className="font-display text-lg font-bold tracking-tight text-fg">
                Porovnání sekcí
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">
                Zóny expozice podle počtu relací. Vpravo průměrná doba u displeje.
              </p>
              {data && data.sekce.length > 0 ? (
                <ul className="mt-3 divide-y divide-lineSoft">
                  {data.sekce.map((sek) => (
                    <Prouzek
                      key={sek.sekce}
                      popis={sek.sekce}
                      poznamka={`${sek.displeju}× displej`}
                      hodnota={cislo(sek.relaci)}
                      vpravo={doba(sek.prumernaDobaS)}
                      zMaxima={sek.relaci / Math.max(1, ...data.sekce.map((x) => x.relaci))}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-fg-dim">
                  Zatím žádná data. Sekce se bere z info panelu displeje; displej bez sekce se
                  do porovnání nepočítá.
                </p>
              )}
            </section>
          </div>
        </>
      )}

      {/* --- Záložka: Chování --- */}
      {zalozka === "chovani" && (
        <>
          <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
            <h2 className="font-display text-lg font-bold tracking-tight text-fg">
              Kdy lidi chodí
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              Začátky relací podle dne v týdnu a hodiny. Prázdné noční hodiny se neukazují.
            </p>
            {data ? (
              <KdyChodiMrizka data={data.kdyChodi} />
            ) : (
              <p className="mt-4 text-sm text-fg-dim">Načítám…</p>
            )}
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">Typy slidů</h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Co si návštěvníci pouštějí. Vpravo průměrná doba na jednom slidu.
          </p>
          {data && data.typySlidu.length > 0 ? (
            <ul className="mt-3 divide-y divide-lineSoft">
              {data.typySlidu.map((t) => (
                <Prouzek
                  key={t.typ}
                  popis={TYP_SLIDU_LABEL[t.typ] ?? t.typ}
                  poznamka={t.znamy ? undefined : "neznámý typ"}
                  hodnota={cislo(t.zobrazeni)}
                  vpravo={doba(t.prumernaDobaS)}
                  zMaxima={t.zobrazeni / maxZobrazeni}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-fg-dim">Zatím žádná data.</p>
          )}
          {data && data.kvalita.zahozenaTrvani > 0 && (
            <p className="mt-3 text-xs text-fg-dim">
              {cislo(data.kvalita.zahozenaTrvani)} údajů o trvání bylo nesmyslných (delší než celá
              relace) a do průměrů se nezapočítalo.
            </p>
          )}
        </section>

            <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
              <h2 className="font-display text-lg font-bold tracking-tight text-fg">
                Kolik slidů projde návštěvník
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">
                Relace podle počtu zhlédnutých slidů. Relace bez jediného slidu se nepočítá — to je
                někdo, kdo kolem jen prošel.
              </p>
              {data && data.slidyNaRelaci.prumer !== null ? (
                <>
                  <div className="mt-3 font-display text-2xl font-bold text-fg tnum">
                    {data.slidyNaRelaci.prumer.toLocaleString("cs-CZ")}
                    <span className="ml-1.5 text-xs font-normal text-fg-muted">
                      slidů na relaci v průměru
                    </span>
                  </div>
                  <ul className="mt-3 divide-y divide-lineSoft">
                    {data.slidyNaRelaci.kose.map((k) => (
                      <Prouzek
                        key={k.kos}
                        popis={popisKose(k.kos)}
                        hodnota={cislo(k.relaci)}
                        zMaxima={
                          k.relaci / Math.max(1, ...data.slidyNaRelaci.kose.map((x) => x.relaci))
                        }
                      />
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-4 text-sm text-fg-dim">Zatím žádná data.</p>
              )}
            </section>
          </div>

          <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
            {displeje === null ? (
              <p className="text-sm text-fg-dim">Načítám půdorys…</p>
            ) : displeje.length === 0 ? (
              <p className="text-sm text-fg-dim">Seznam displejů se nepodařilo načíst.</p>
            ) : (
              <HeatMapa
                displays={displeje}
                summary={null}
                navstevy={navstevyProMapu}
                popisObdobi={`${datumCesky(od)} – ${datumCesky(doDne)}`}
              />
            )}
          </section>
        </>
      )}

      {/* --- Záložka: AI --- */}
      {zalozka === "ai" && (
        <>
          <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
            <h2 className="font-display text-lg font-bold tracking-tight text-fg">
              Dotazy na AI v čase
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              Kolik dotazů návštěvníci položili chatbotovi. Data dodává backend chatbota, ne
              tablety.
            </p>
            {!aiDotazy ? (
              <p className="mt-4 text-sm text-fg-dim">Načítám…</p>
            ) : !aiDotazy.dostupne ? (
              <p className="mt-4 text-sm text-fg-dim">
                Analytika chatbota není připojená. {aiDotazy.duvod}
              </p>
            ) : (
              <AiVCase dotazy={aiDotazy.data} od={od} doDne={doDne} />
            )}
          </section>

          <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
            <h2 className="font-display text-lg font-bold tracking-tight text-fg">
              Na co se lidi ptají
            </h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              Druhy podle počtu dotazů za zvolené období.
            </p>
            {!aiSouhrn ? (
              <p className="mt-4 text-sm text-fg-dim">Načítám…</p>
            ) : !aiSouhrn.dostupne ? (
              <p className="mt-4 text-sm text-fg-dim">Analytika chatbota není připojená.</p>
            ) : aiSouhrn.data.per_species.length === 0 ? (
              <p className="mt-4 text-sm text-fg-dim">Za tohle období nedorazily žádné dotazy.</p>
            ) : (
              <ul className="mt-3 divide-y divide-lineSoft">
                {aiSouhrn.data.per_species.slice(0, 12).map((sp) => (
                  <Prouzek
                    key={sp.species_latin || sp.species_name}
                    popis={sp.species_name || sp.species_latin || "?"}
                    hodnota={cislo(sp.count)}
                    zMaxima={
                      sp.count / Math.max(1, ...aiSouhrn.data.per_species.map((x) => x.count))
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
