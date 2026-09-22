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
import { TYP_SLIDU_LABEL } from "../lib/types";
import type { AnalytikaNavstevnosti, Granularita, SouhrnObdobi } from "../lib/types";

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

// Změna proti minulému období. Null znamená „nebylo s čím porovnat" —
// dělit nulou a napsat +∞ % by bylo horší než nenapsat nic.
function zmena(ted: number, drive: number): number | null {
  if (drive === 0) return null;
  return Math.round(((ted - drive) / drive) * 100);
}

function Zmena({ ted, drive }: { ted: number; drive: number | undefined }) {
  if (drive === undefined) return null;
  const z = zmena(ted, drive);
  if (z === null) return <span className="text-xs text-fg-dim">minule nic</span>;
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

export default function Analytika() {
  const [predvolba, setPredvolba] = useState<Predvolba>("mesic");
  const [od, setOd] = useState(() => odecti(dnesISO(), 29));
  const [doDne, setDoDne] = useState(dnesISO);
  const [granularita, setGranularita] = useState<Granularita | null>(null); // null = nech na serveru
  const [porovnat, setPorovnat] = useState(true);

  const [data, setData] = useState<AnalytikaNavstevnosti | null>(null);
  const [nacitam, setNacitam] = useState(true);
  const [chyba, setChyba] = useState<string | null>(null);

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

      {chyba && <p className="text-sm text-danger">{chyba}</p>}

      {/* Kolik displejů vůbec posílá data, zůstává vidět: to není technikálie,
          ale to hlavní, co se o číslech níž musí vědět — jsou jen z části
          pavilonu. Naopak poškozené řádky a neznámé typy slidů kurátorovi nic
          neříkají a dělaly nahoře poplach, takže jsou sbalené stejně jako
          v přehledu. */}
      {data && data.kvalita.displejuSData < data.kvalita.displejuCelkem && (
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-soft px-4 py-3 text-sm text-amber-deep">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
          <div>
            Data posílá <strong className="font-semibold">{data.kvalita.displejuSData}</strong> z{" "}
            {data.kvalita.displejuCelkem} displejů. Čísla níž jsou jen z nich, zbytek se doplní sám,
            až začnou tablety zapisovat.
          </div>
        </div>
      )}

      {data &&
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
      {c && (
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

      {/* Žebříčky */}
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
      </div>
    </div>
  );
}
