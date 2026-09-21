import { useEffect, useState } from "react";
import { AlertTriangle, Info, Loader2, Power, PowerOff, RefreshCw } from "lucide-react";
import { api, formatDateTime } from "../lib/api";
import { useToast } from "../components/Toast";
import type { VideomappingInstalace, VideomappingPovel } from "../lib/types";

// Ovládání videomappingu v pavilonu.
//
// PROČ TEXTY MLUVÍ TAKHLE OPATRNĚ: povel se posílá jako OSC zpráva přes UDP.
// UDP je jednosměrné a nikdo ho nepotvrzuje, takže se nedozvíme, jestli zpráva
// dorazila, jestli ji instalace přečetla, ani jestli se rozeběhla. CMS proto
// nikde netvrdí „zapnuto“ ani neukazuje stav instalace: píše jen, že byl povel
// odeslán, a kdy. Kdo chce vědět, jestli mapping běží, musí se podívat do
// pavilonu.
//
// Chyba se ukáže jen tehdy, když selže NAŠE strana (neplatná adresa, síť je
// dole). I bez chyby platí všechno výše.

// Čas odeslání se ukazuje na sekundy: kurátor potřebuje poznat, jestli to, co
// vidí, je jeho poslední kliknutí, ne kliknutí spred deseti minut.
function casSekundy(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// „dnes v 14:32:05“ pro dnešek, jinak plné datum i s časem.
function kdyOdeslano(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dnes = new Date();
  const stejnyDen =
    d.getFullYear() === dnes.getFullYear() &&
    d.getMonth() === dnes.getMonth() &&
    d.getDate() === dnes.getDate();
  return stejnyDen ? `dnes v ${casSekundy(iso)}` : formatDateTime(iso);
}

function KartaInstalace({
  instalace,
  onPovel,
  posilam,
  chyba,
}: {
  instalace: VideomappingInstalace;
  onPovel: (povel: VideomappingPovel) => void;
  posilam: VideomappingPovel | null;
  chyba: string | null;
}) {
  const posledni = instalace.posledni;
  const zamceno = posilam !== null;

  return (
    <div className="rounded-xl border border-line shadow-card">
      <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold tracking-tight text-fg">
            {instalace.nazev}
          </h2>
          <p className="mt-0.5 font-mono text-xs text-fg-dim">
            OSC / UDP · {instalace.host}:{instalace.port}
          </p>
        </div>
      </div>

      <div className="space-y-4 px-6 py-5">
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => onPovel("start")}
            disabled={zamceno}
            className="btn-primary min-w-[140px]"
          >
            {posilam === "start" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Power className="h-4 w-4" strokeWidth={1.75} />
            )}
            Zapnout
          </button>
          <button
            onClick={() => onPovel("stop")}
            disabled={zamceno}
            className="btn-ghost min-w-[140px]"
          >
            {posilam === "stop" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PowerOff className="h-4 w-4" strokeWidth={1.75} />
            )}
            Vypnout
          </button>
        </div>

        {chyba && (
          <div
            className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" strokeWidth={1.75} />
            <div className="min-w-0 text-sm">
              <div className="font-semibold text-fg">Povel se nepodařilo odeslat.</div>
              <div className="mt-0.5 text-fg-muted">{chyba}</div>
            </div>
          </div>
        )}

        {/* Záměrně „odeslán povel", ne „zapnuto". Co instalace udělala, CMS neví. */}
        <div className="rounded-lg border border-dashed border-line bg-canvas px-4 py-3">
          <div className="kicker">Naposledy odesláno z CMS</div>
          {posledni ? (
            <div className="mt-1.5 text-sm text-fg-muted">
              <span className="font-semibold text-fg">
                Odeslán povel {posledni.povel === "start" ? "k zapnutí" : "k vypnutí"}
              </span>{" "}
              {kdyOdeslano(posledni.odeslano)}, {posledni.jmeno ?? `uživatel ${posledni.uzivatel}`}.
              {!posledni.ok && (
                <span className="font-semibold text-danger"> Odeslání tehdy selhalo.</span>
              )}
            </div>
          ) : (
            <div className="mt-1.5 text-sm text-fg-muted">
              Od spuštění serveru odsud nikdo tuhle instalaci neovládal.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Videomapping() {
  const toast = useToast();
  const [instalace, setInstalace] = useState<VideomappingInstalace[] | null>(null);
  const [chybaNacteni, setChybaNacteni] = useState<string | null>(null);
  // Který povel se zrovna odesílá, po instalacích.
  const [posilam, setPosilam] = useState<Record<string, VideomappingPovel | null>>({});
  // Poslední chyba odeslání, po instalacích. Nezmizí sama: kurátor ji má
  // přečíst, toast by mu mezitím utekl.
  const [chyby, setChyby] = useState<Record<string, string | null>>({});

  async function nacti() {
    try {
      setInstalace(await api.videomapping());
      setChybaNacteni(null);
    } catch (e) {
      setChybaNacteni(e instanceof Error ? e.message : "Načtení selhalo.");
    }
  }

  useEffect(() => {
    void nacti();
  }, []);

  async function posli(cil: VideomappingInstalace, povel: VideomappingPovel) {
    setPosilam((p) => ({ ...p, [cil.id]: povel }));
    setChyby((p) => ({ ...p, [cil.id]: null }));
    try {
      const res = await api.videomappingPovel(cil.id, povel);
      toast.success(
        `${cil.nazev}: odeslán povel k ${povel === "start" ? "zapnutí" : "vypnutí"} v ${casSekundy(res.odeslano)}.`,
      );
    } catch (e) {
      const text = e instanceof Error ? e.message : "Odeslání selhalo.";
      setChyby((p) => ({ ...p, [cil.id]: text }));
      toast.error(`${cil.nazev}: povel se nepodařilo odeslat.`);
    } finally {
      setPosilam((p) => ({ ...p, [cil.id]: null }));
      // Přenačtení srovná „naposledy odesláno" se serverem (ten je zdrojem
      // pravdy i pro čas a jméno v audit logu).
      await nacti();
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">Videomapping</h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-fg-muted">
            Zapnutí a vypnutí dvou instalací videomappingu v pavilonu. Tlačítko pošle instalaci
            povel; zbytek už si řídí sama.
          </p>
        </div>
        <button onClick={() => void nacti()} className="btn-ghost" disabled={!instalace}>
          <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          Obnovit
        </button>
      </div>

      {/* Tohle je nejdůležitější věta na stránce: kurátor nesmí odejít
          s dojmem, že mu CMS potvrdilo stav instalace. */}
      <div className="flex items-start gap-3 rounded-lg border border-amber/40 bg-amber-soft px-4 py-3.5">
        <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber-deep" strokeWidth={1.75} />
        <div className="text-sm leading-relaxed text-fg">
          <span className="font-semibold">CMS nezná skutečný stav instalací.</span> Povel se
          posílá jednosměrně a nikdo ho nepotvrzuje, takže systém umí říct jen to, že povel{" "}
          <strong className="font-semibold">odeslal</strong>, a kdy. Jestli se mapping opravdu
          rozeběhl, se pozná jen pohledem do pavilonu. Když se odeslání nepovede už u nás
          (nefunkční síť, změněná adresa), napíše se to jako chyba.
        </div>
      </div>

      {chybaNacteni && <div className="text-sm text-danger">{chybaNacteni}</div>}

      {!instalace && !chybaNacteni && (
        <div className="flex items-center gap-2 text-sm text-fg-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          Načítám…
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {instalace?.map((i) => (
          <KartaInstalace
            key={i.id}
            instalace={i}
            posilam={posilam[i.id] ?? null}
            chyba={chyby[i.id] ?? null}
            onPovel={(povel) => void posli(i, povel)}
          />
        ))}
      </div>

      <p className="border-t border-line pt-5 text-xs leading-relaxed text-fg-muted">
        Každé odeslání se zapisuje do <strong className="font-semibold text-fg">audit logu</strong>{" "}
        včetně jména, času, povelu a instalace, a to i když se odeslání nepovede. Přehled „naposledy
        odesláno" výše platí od posledního spuštění serveru, celá historie je v audit logu. Adresy
        instalací se nastavují v konfiguraci serveru (proměnné{" "}
        <span className="font-mono text-[11px]">VIDEOMAPPING_*</span>), ne v CMS.
      </p>
    </div>
  );
}
