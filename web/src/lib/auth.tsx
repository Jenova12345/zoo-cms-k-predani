import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, STORAGE_KEY, UDALOST_CHYBI_JMENO } from "./api";

// Přihlášení má dva kroky: účet (login + heslo) a JMÉNO ČLOVĚKA. ZOO dostane
// jeden sdílený účet, pod kterým pracuje víc lidí, takže samotný účet by
// v auditu neřekl, kdo co dělal. Jméno se vybírá při každém přihlášení znovu,
// nic se nepamatuje.
//
// Zdroj pravdy pro obojí je podepsaná cookie na serveru; tady se to drží jen
// kvůli vykreslení.

interface AuthApi {
  username: string | null;
  jmeno: string | null;
  ready: boolean;
  setUsername: (name: string | null) => void;
  setJmeno: (jmeno: string | null) => void;
}

const AuthContext = createContext<AuthApi | null>(null);

// Okno nečinnosti hlídá server (60 min); tady se sleduje jen proto, aby
// obrazovka nevisela přihlášená, dokud na ni někdo neklikne, a aby šlo
// minutu předem varovat.
const TEP_INTERVAL_MS = 60 * 1000; // nejčastěji jednou za minutu
const VAROVAT_PRED_MS = 60 * 1000; // minutu předem

// Co se počítá jako „člověk je tady". Schválně jen skutečná interakce, ne
// HTTP requesty: CMS si sám chodí pro data (deštný prales každých 5 s,
// dashboard každou minutu) a z requestů by okno nikdy nevypršelo.
const UDALOSTI_AKTIVITY = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsernameState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );
  const [jmeno, setJmenoState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // Kolik zbývá do odhlášení, když je to už pod minutou; jinak null.
  const [varovani, setVarovani] = useState<number | null>(null);

  // Sjednotíme stav s cookie na serveru (po refreshi stránky).
  useEffect(() => {
    let active = true;
    api
      .me()
      .then((res) => {
        if (!active) return;
        if (res.username) {
          setUsernameState(res.username);
          setJmenoState(res.jmeno);
          localStorage.setItem(STORAGE_KEY, res.username);
        } else {
          setUsernameState(null);
          setJmenoState(null);
          localStorage.removeItem(STORAGE_KEY);
        }
      })
      .catch(() => {})
      .finally(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);

  // Server odmítl request s „nejdřív vyberte jméno" — náš stav je zastaralý
  // (typicky se mezitím přihlásil někdo jiný v jiné záložce).
  useEffect(() => {
    const posluchac = () => setJmenoState(null);
    window.addEventListener(UDALOST_CHYBI_JMENO, posluchac);
    return () => window.removeEventListener(UDALOST_CHYBI_JMENO, posluchac);
  }, []);

  const setUsername = useCallback((name: string | null) => {
    setUsernameState(name);
    if (name) localStorage.setItem(STORAGE_KEY, name);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  const setJmeno = useCallback((j: string | null) => setJmenoState(j), []);

  // --- Hlídání nečinnosti ---------------------------------------------
  // Byla od posledního tepu nějaká interakce? Tep se posílá jen tehdy —
  // otevřená a nedotčená záložka session neprodlužuje.
  const bylaAktivita = useRef(false);
  const posledniTep = useRef(0);

  useEffect(() => {
    if (!username || !jmeno) return;

    const oznac = () => {
      bylaAktivita.current = true;
    };
    for (const u of UDALOSTI_AKTIVITY) {
      window.addEventListener(u, oznac, { passive: true });
    }
    // Návrat na záložku po přepnutí bereme jako projev zájmu taky.
    const naViditelnost = () => {
      if (document.visibilityState === "visible") oznac();
    };
    document.addEventListener("visibilitychange", naViditelnost);

    let zastaveno = false;

    async function tik() {
      if (zastaveno) return;
      const ted = Date.now();
      // Okno se posouvá jen tehdy, když se od minula něco dělo. Jinak se
      // serveru jen ptáme, kolik zbývá, ať stihneme varovat.
      const posunout = bylaAktivita.current && ted - posledniTep.current >= TEP_INTERVAL_MS;
      if (posunout) {
        bylaAktivita.current = false;
        posledniTep.current = ted;
      }
      try {
        const { zbyvaMs } = await api.tep(posunout);
        if (!zastaveno) setVarovani(zbyvaMs <= VAROVAT_PRED_MS ? zbyvaMs : null);
      } catch {
        // 401 si už ošetřil api klient (přesměruje na přihlášení)
      }
    }

    // Kontroluje se po deseti sekundách, ať varování dorazí včas; tep
    // samotný je pořád nejvýš jednou za minutu.
    const t = setInterval(() => void tik(), 10_000);
    void tik();
    return () => {
      zastaveno = true;
      clearInterval(t);
      for (const u of UDALOSTI_AKTIVITY) window.removeEventListener(u, oznac);
      document.removeEventListener("visibilitychange", naViditelnost);
    };
  }, [username, jmeno]);

  // Kliknutí na varování = interakce, takže příští tik pošle tep a okno se
  // posune. Varování zmizí hned, ať to nevypadá, že se nic nestalo.
  const pokracovat = useCallback(() => {
    bylaAktivita.current = true;
    posledniTep.current = 0;
    setVarovani(null);
  }, []);

  return (
    <AuthContext.Provider value={{ username, jmeno, ready, setUsername, setJmeno }}>
      {children}
      {varovani !== null && <VarovaniNecinnost zbyvaMs={varovani} onPokracovat={pokracovat} />}
    </AuthContext.Provider>
  );
}

// Upozornění minutu před odhlášením. CMS má rozepsané drafty, takže tiché
// odhlášení by znamenalo ztrátu rozdělané práce.
function VarovaniNecinnost({
  zbyvaMs,
  onPokracovat,
}: {
  zbyvaMs: number;
  onPokracovat: () => void;
}) {
  const vteriny = Math.max(0, Math.round(zbyvaMs / 1000));
  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center p-4">
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-xl bg-fg px-5 py-3 text-white shadow-cardHover"
      >
        <span className="text-sm">
          Za <span className="font-semibold tnum">{vteriny} s</span> vás kvůli nečinnosti
          odhlásím. Rozepsané změny se ztratí.
        </span>
        <button
          onClick={onPokracovat}
          className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-semibold hover:bg-white/25"
        >
          Pokračovat v práci
        </button>
      </div>
    </div>
  );
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth musí být uvnitř AuthProvider");
  return ctx;
}
