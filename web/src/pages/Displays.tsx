import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ImageOff, Loader2, Search, Sparkles } from "lucide-react";
import { api, formatDateTime } from "../lib/api";
import {
  JAZYKY,
  NEPRIRAZENO,
  SEKCE_TEMATA,
  STAV_ZARIZENI_LABEL,
  najdiSekci,
  type DisplaySummary,
  type StavZarizeni,
} from "../lib/types";

const TECKA_STAVU: Record<StavZarizeni, string> = {
  online: "dot-online",
  vypadava: "dot-vypadava",
  offline: "dot-offline",
  neznamy: "dot-neznamy",
};

// „online · tep před 40 s". U displeje, který se ještě neozval, nemá smysl
// psát čas, tam zůstane jen slovní stav.
function popisStavu(d: DisplaySummary): string {
  const stav = STAV_ZARIZENI_LABEL[d.stav];
  if (!d.naposledy) return `Tablet: ${stav}`;
  const pred = Date.now() - Date.parse(d.naposledy);
  const kdy =
    pred < 90_000
      ? `před ${Math.max(0, Math.round(pred / 1000))} s`
      : pred < 5_400_000
        ? `před ${Math.round(pred / 60_000)} min`
        : `naposledy ${new Date(d.naposledy).toLocaleString("cs-CZ")}`;
  return `Tablet: ${stav} · tep ${kdy}${d.verze ? ` · verze ${d.verze}` : ""}`;
}

export default function Displays() {
  const [displays, setDisplays] = useState<DisplaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // "" = všechny sekce, "0" = displeje bez sekce, jinak číslo tématu.
  const [sekce, setSekce] = useState("");

  useEffect(() => {
    api
      .displays()
      .then(setDisplays)
      .catch((e) => setError(e instanceof Error ? e.message : "Načtení selhalo."));
  }, []);

  const filtered = displays?.filter((d) => {
    if (sekce) {
      // Starý název sekce najdiSekci přeloží, takže filtr sedí i na displeje
      // uložené před srovnáním s oficiální tabulí.
      const cislo = najdiSekci(d.category ?? "")?.cislo;
      if (sekce === "0" ? cislo !== undefined : String(cislo ?? "") !== sekce) return false;
    }
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return d.id.includes(q) || d.druh.toLowerCase().includes(q);
  });

  const prirazenoCount = displays?.filter((d) => d.druh !== NEPRIRAZENO).length ?? 0;
  const kRevizi = displays?.filter((d) => d.cekaNaRevizi).length ?? 0;
  const bezPrekladu =
    displays?.filter((d) => d.druh !== NEPRIRAZENO && d.jazyky && (!d.jazyky.en || !d.jazyky.pl))
      .length ?? 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">Displeje</h1>
          <p className="text-sm text-fg-muted mt-1.5">
            {displays
              ? `${displays.length} displejů, ${prirazenoCount} přiřazeno. Obsah se ukládá přímo na disk.`
              : "Obsah se ukládá přímo na disk."}
          </p>
          {bezPrekladu > 0 && (
            <p className="mt-2 text-sm text-fg-muted">
              {bezPrekladu === 1
                ? "1 druh nemá kompletní překlady (EN nebo PL)."
                : `${bezPrekladu} druhů nemá kompletní překlady (EN nebo PL).`}
            </p>
          )}
          {kRevizi > 0 && (
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-amber-deep">
              <Sparkles className="h-4 w-4" strokeWidth={1.75} />
              {kRevizi === 1
                ? "1 druh čeká na revizi textů od AI"
                : `${kRevizi} druhů čeká na revizi textů od AI`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="input w-64"
            value={sekce}
            onChange={(e) => setSekce(e.target.value)}
            aria-label="Filtr podle sekce"
          >
            <option value="">Všechny sekce</option>
            {SEKCE_TEMATA.map((s) => (
              <option key={s.cislo} value={String(s.cislo)}>
                {s.cislo}. {s.cs}
              </option>
            ))}
            <option value="0">Bez sekce</option>
          </select>
          <div className="relative">
            <Search className="h-4 w-4 text-fg-dim absolute left-3 top-1/2 -translate-y-1/2" strokeWidth={1.75} />
            <input
              className="input pl-9 w-64"
              placeholder="Hledat číslo nebo druh"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      {!displays && !error && (
        <div className="grid place-items-center py-20 text-fg-dim">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}

      {filtered && filtered.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-fg-muted">
          Tomuhle výběru neodpovídá žádný displej.{" "}
          <button
            onClick={() => {
              setSekce("");
              setQuery("");
            }}
            className="font-semibold text-accent hover:underline"
          >
            Zrušit filtr
          </button>
        </div>
      )}

      {filtered && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-8">
          {filtered.map((d) => {
            const prirazeno = d.druh !== NEPRIRAZENO;
            return (
              <Link key={d.id} to={`/displeje/${d.id}`} className="group">
                <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-canvas">
                  {d.thumbnail ? (
                    <img
                      src={d.thumbnail}
                      alt={d.druh}
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                    />
                  ) : (
                    <div className="h-full w-full grid place-items-center text-fg-dim/60 border border-dashed border-line rounded-lg">
                      <ImageOff className="h-6 w-6" strokeWidth={1.5} />
                    </div>
                  )}
                  {/* AI koncept z hromadného importu, kurátor ho ještě neviděl. */}
                  {d.cekaNaRevizi && (
                    <span className="absolute left-2 top-2 chip bg-amber-soft text-amber-deep shadow-card">
                      <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                      čeká na revizi
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-display text-xs font-bold text-fg-dim tnum">
                        {d.id.padStart(2, "0")}
                      </span>
                      <span
                        className={`text-sm font-semibold truncate ${
                          prirazeno
                            ? "text-fg group-hover:text-accent transition-colors"
                            : "text-fg-dim italic font-normal"
                        }`}
                      >
                        {d.druh}
                      </span>
                    </div>
                    <div className="text-[11px] text-fg-dim mt-0.5 tnum">
                      {formatDateTime(d.posledniZmena)}
                    </div>
                    {/* Stav jazyků: kurátor u 31 druhů uhlídá, kde co chybí. */}
                    {prirazeno && d.jazyky && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {JAZYKY.map((j) => (
                          <span
                            key={j}
                            title={
                              d.jazyky[j] ? `${j.toUpperCase()}: hotovo` : `${j.toUpperCase()}: chybí obsah`
                            }
                            className={`rounded px-1 py-0.5 text-[10px] font-bold uppercase ${
                              d.jazyky[j]
                                ? "bg-accent-soft text-accent"
                                : "bg-canvas text-fg-muted ring-1 ring-line"
                            }`}
                          >
                            {j}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Živý stav tabletu z tepu (server/src/tep.ts), ne
                      hodnota ze souboru. Popisek v title říká i kdy se
                      tablet naposled ozval, ať je vidět rozdíl mezi
                      "právě teď zmlkl" a "mlčí od včerejška". */}
                  <span
                    className={`mt-1 shrink-0 ${TECKA_STAVU[d.stav]}`}
                    title={popisStavu(d)}
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
