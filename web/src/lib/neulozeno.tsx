import { createContext, useContext, useState, type ReactNode } from "react";

// Sdílená informace „na stránce jsou rozepsané neuložené změny".
//
// Detail displeje ji ohlásí, levý navigační panel se jí ptá dřív, než pustí
// kurátora pryč. Bez toho by odchod přes menu (nebo Odhlásit) tiše zahodil
// rozdělanou práci, beforeunload na to nestačí, uvnitř SPA se nespouští.
interface NeulozenoApi {
  jeNeulozeno: boolean;
  nastavNeulozeno: (v: boolean) => void;
}

const NeulozenoContext = createContext<NeulozenoApi | null>(null);

export function NeulozenoProvider({ children }: { children: ReactNode }) {
  const [jeNeulozeno, nastavNeulozeno] = useState(false);
  return (
    <NeulozenoContext.Provider value={{ jeNeulozeno, nastavNeulozeno }}>
      {children}
    </NeulozenoContext.Provider>
  );
}

export function useNeulozeno(): NeulozenoApi {
  const ctx = useContext(NeulozenoContext);
  if (!ctx) throw new Error("useNeulozeno musí být uvnitř NeulozenoProvider");
  return ctx;
}
