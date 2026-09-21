import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, formatDateTime } from "../lib/api";
import type { AuditEntry } from "../lib/types";

const ACTION_STYLE: Record<string, string> = {
  přihlášení: "text-fg-muted",
  odhlášení: "text-fg-muted",
  "neúspěšné přihlášení": "text-danger",
  úprava: "text-accent",
  upload: "text-amber",
  "odesláno na displej": "text-accent",
  "hromadný import": "text-amber-deep",
  "potvrzení revize AI textů": "text-accent",
  "odeslán povel videomappingu": "text-accent",
  "povel videomappingu selhal": "text-danger",
};

const ACTION_DOT: Record<string, string> = {
  přihlášení: "bg-fg-dim",
  odhlášení: "bg-fg-dim",
  "neúspěšné přihlášení": "bg-danger",
  úprava: "bg-accent",
  upload: "bg-amber",
  "odesláno na displej": "bg-accent",
  "hromadný import": "bg-amber",
  "potvrzení revize AI textů": "bg-accent",
  "odeslán povel videomappingu": "bg-accent",
  "povel videomappingu selhal": "bg-danger",
};

// Kolik záznamů se načte naráz. Log může mít desítky tisíc řádků, takže se
// bere po stránkách a starší se donačítají tlačítkem.
const STRANKA = 100;

export default function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nacitamStarsi, setNacitamStarsi] = useState(false);
  const [maVice, setMaVice] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const davka = await api.audit({ limit: STRANKA });
      setEntries(davka);
      setMaVice(davka.length === STRANKA);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Načtení selhalo.");
    } finally {
      setLoading(false);
    }
  }

  // Starší stránka se ptá podle času posledního záznamu, který už máme.
  async function nactiStarsi() {
    const posledni = entries?.[entries.length - 1];
    if (!posledni) return;
    setNacitamStarsi(true);
    try {
      // Kolik záznamů s touhle milisekundou už máme: hromadné akce jich
      // zapíšou několik naráz a bez toho by na hranici stránky vypadly.
      const stejnyCas = entries.filter((e) => e.cas === posledni.cas).length;
      const davka = await api.audit({
        limit: STRANKA,
        before: posledni.cas,
        preskoc: stejnyCas,
      });
      setEntries((prev) => [...(prev ?? []), ...davka]);
      setMaVice(davka.length === STRANKA);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Načtení selhalo.");
    } finally {
      setNacitamStarsi(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">Audit log</h1>
          <p className="text-sm text-fg-muted mt-1.5">
            Append-only záznam akcí ze souboru data/audit.jsonl. Nejnovější nahoře.
          </p>
        </div>
        <button onClick={load} className="btn-ghost" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" strokeWidth={1.75} />}
          Obnovit
        </button>
      </div>

      {error && <div className="text-sm text-danger">{error}</div>}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left kicker">
            <th className="pb-3 font-semibold">Čas</th>
            <th className="pb-3 font-semibold">Uživatel</th>
            <th className="pb-3 font-semibold">Akce</th>
            <th className="pb-3 font-semibold">Cíl</th>
          </tr>
        </thead>
        <tbody>
          {!entries && !error && (
            <tr>
              <td colSpan={4} className="py-10 text-center text-fg-dim border-t border-line">
                <Loader2 className="h-5 w-5 animate-spin mx-auto" />
              </td>
            </tr>
          )}
          {entries && entries.length === 0 && (
            <tr>
              <td colSpan={4} className="py-10 text-center text-fg-dim border-t border-line">
                Zatím žádné záznamy.
              </td>
            </tr>
          )}
          {entries?.map((e, i) => (
            <tr key={i} className="border-t border-lineSoft hover:bg-canvas transition-colors">
              <td className="py-3 pr-4 text-fg-muted whitespace-nowrap tnum">
                {formatDateTime(e.cas)}
              </td>
              {/* „zoo / Franta": vepředu účet, za lomítkem konkrétní člověk.
                  Záznamy zapsané před zavedením jmen jméno nemají a zůstane
                  u nich jen účet. */}
              <td className="py-3 pr-4 whitespace-nowrap">
                {e.jmeno ? (
                  <>
                    <span className="text-fg-dim">{e.uzivatel}&nbsp;/&nbsp;</span>
                    <span className="font-medium text-fg">{e.jmeno}</span>
                  </>
                ) : (
                  <span className="font-medium text-fg">{e.uzivatel}</span>
                )}
              </td>
              <td className="py-3 pr-4">
                <span className={`inline-flex items-center gap-2 font-medium ${ACTION_STYLE[e.akce] ?? "text-fg-muted"}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${ACTION_DOT[e.akce] ?? "bg-fg-dim"}`} />
                  {e.akce}
                </span>
              </td>
              <td className="py-3 text-fg-muted">{e.cil}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {entries && entries.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-4 pt-1">
          {maVice ? (
            <button onClick={nactiStarsi} className="btn-ghost" disabled={nacitamStarsi}>
              {nacitamStarsi && <Loader2 className="h-4 w-4 animate-spin" />}
              Načíst starší záznamy
            </button>
          ) : (
            <span className="text-xs text-fg-muted">Načteno vše, co log obsahuje.</span>
          )}
          <span className="text-xs text-fg-muted tnum">načteno {entries.length} záznamů</span>
        </div>
      )}
    </div>
  );
}
