import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { SpravaJmen } from "../components/SpravaJmen";
import type { Jmeno } from "../lib/types";

// Nastavení CMS. Zatím je tu jediná věc: seznam jmen. Je dostupný i tady,
// nejen na obrazovce výběru, aby se dal seznam pročistit za běhu — bez
// odhlašování a bez toho, aby si kvůli tomu někdo musel sednout k počítači
// a znovu zadávat heslo.
export default function Nastaveni() {
  const { username, jmeno } = useAuth();
  const [jmena, setJmena] = useState<Jmeno[] | null>(null);
  const [chyba, setChyba] = useState<string | null>(null);

  useEffect(() => {
    api
      .jmena()
      .then((res) => setJmena(res.jmena))
      .catch((e) => {
        setJmena([]);
        setChyba(e instanceof Error ? e.message : "Seznam jmen se nepodařilo načíst.");
      });
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-fg">Nastavení</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Přihlášeno pod účtem <span className="font-semibold text-fg">{username}</span>
          {jmeno && (
            <>
              {" "}
              jako <span className="font-semibold text-fg">{jmeno}</span>
            </>
          )}
          .
        </p>
      </div>

      <section className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-accent" strokeWidth={1.75} />
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">
            Jména u sdíleného účtu
          </h2>
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          Z tohohle seznamu si každý po přihlášení vybere, kdo je — a to jméno se pak zapisuje ke
          všem akcím v auditu. Upravovat ho smí kdokoli přihlášený.
        </p>
        <p className="mt-1 text-xs text-fg-dim">
          Smazání jména nepřepisuje historii: staré záznamy v auditu si své jméno nechají. Kdo pod
          ním zrovna pracuje, dopracuje — vybere si jiné až při dalším přihlášení.
        </p>

        {chyba && <p className="mt-4 text-sm text-danger">{chyba}</p>}

        <div className="mt-5">
          {jmena === null ? (
            <div className="flex items-center gap-2 text-sm text-fg-dim">
              <Loader2 className="h-4 w-4 animate-spin" /> Načítám…
            </div>
          ) : (
            <SpravaJmen jmena={jmena} onZmena={setJmena} />
          )}
        </div>
      </section>
    </div>
  );
}
