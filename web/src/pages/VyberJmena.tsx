import { useEffect, useState } from "react";
import { Loader2, LogOut, UserRound } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { LogoMark, Wordmark } from "../components/Logo";
import { SpravaJmen } from "../components/SpravaJmen";
import type { Jmeno } from "../lib/types";

// Druhý krok přihlášení: kdo u počítače zrovna sedí. ZOO má jeden sdílený
// účet, takže bez tohohle by audit uměl říct jen „zoo", ne kdo co udělal.
//
// Ptá se při KAŽDÉM přihlášení znovu, nic se nepamatuje — jinak by se pod
// jménem prvního člověka podepsal každý další, kdo si k počítači sedne.
//
// Není to samostatná route: vykresluje se uvnitř Protected místo obsahu CMS,
// takže deep link zůstane zachovaný a po výběru se pokračuje tam, kam
// uživatel mířil.
export default function VyberJmena() {
  const { username, setUsername, setJmeno } = useAuth();
  const [jmena, setJmena] = useState<Jmeno[] | null>(null);
  const [chyba, setChyba] = useState<string | null>(null);
  const [vybiram, setVybiram] = useState<string | null>(null);
  const [spravovat, setSpravovat] = useState(false);

  useEffect(() => {
    api
      .jmena()
      .then((res) => setJmena(res.jmena))
      .catch((e) => {
        setJmena([]);
        setChyba(e instanceof Error ? e.message : "Seznam jmen se nepodařilo načíst.");
      });
  }, []);

  async function vyber(jmeno: string) {
    setVybiram(jmeno);
    setChyba(null);
    try {
      const res = await api.vyberJmeno(jmeno);
      setJmeno(res.jmeno); // tím Protected pustí dál
    } catch (e) {
      setChyba(e instanceof Error ? e.message : "Jméno se nepodařilo vybrat.");
      setVybiram(null);
    }
  }

  async function odhlas() {
    try {
      await api.logout();
    } catch {
      // i kdyby odhlášení selhalo, lokální stav zahodíme
    }
    setJmeno(null);
    setUsername(null);
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen grid place-items-center bg-bg p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <Wordmark subtitle="ZOO Ostrava" />
        </div>

        <div className="mt-6 rounded-2xl bg-surface p-6 shadow-card ring-1 ring-line">
          <h1 className="font-display text-xl font-bold tracking-tight text-fg">Kdo pracuje?</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Přihlášeno pod účtem <span className="font-semibold text-fg">{username}</span>. Vyberte
            své jméno — zapíše se ke všemu, co v CMS uděláte.
          </p>

          {chyba && <p className="mt-4 text-sm text-danger">{chyba}</p>}

          {jmena === null ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-fg-dim">
              <Loader2 className="h-4 w-4 animate-spin" /> Načítám seznam…
            </div>
          ) : (
            <>
              {jmena.length > 0 ? (
                <div className="mt-5 grid gap-2">
                  {jmena.map((j) => (
                    <button
                      key={j.jmeno}
                      onClick={() => vyber(j.jmeno)}
                      disabled={vybiram !== null}
                      className="flex items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-line hover:bg-accent-soft hover:ring-accent disabled:opacity-60"
                    >
                      {vybiram === j.jmeno ? (
                        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent" />
                      ) : (
                        <UserRound className="h-5 w-5 shrink-0 text-accent" strokeWidth={1.75} />
                      )}
                      <span className="font-medium text-fg">{j.jmeno}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-5 rounded-lg bg-canvas px-4 py-3 text-sm text-fg-muted ring-1 ring-line">
                  V seznamu zatím nikdo není. Přidejte své jméno níž a pak ho vyberte.
                </p>
              )}

              {/* Správa seznamu je schválně dostupná i tady, před vstupem do
                  CMS: kdo přišel poprvé, musí si své jméno umět přidat. */}
              <div className="mt-5 border-t border-line pt-4">
                {spravovat || jmena.length === 0 ? (
                  <>
                    <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
                      Úprava seznamu
                    </div>
                    <SpravaJmen jmena={jmena} onZmena={setJmena} kompaktni />
                  </>
                ) : (
                  <button
                    onClick={() => setSpravovat(true)}
                    className="text-sm font-medium text-accent hover:text-accent-hi"
                  >
                    Není tu moje jméno / upravit seznam
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <button
          onClick={odhlas}
          className="mx-auto mt-4 flex items-center gap-2 text-xs text-fg-dim hover:text-fg"
        >
          <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} /> Odhlásit se
        </button>
      </div>
    </div>
  );
}
