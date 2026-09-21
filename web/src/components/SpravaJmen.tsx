import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { Jmeno } from "../lib/types";
import Confirm from "./Confirm";

// Správa seznamu jmen. Je na dvou místech: na obrazovce výběru (tam, kde
// člověk zjistí, že jeho jméno chybí) a v Nastavení (aby se dal seznam
// pročistit za běhu, bez odhlašování).
//
// Editovat smí kdokoli přihlášený — ZOO jede pod jedním sdíleným účtem,
// zvláštní admin tu není.

export function SpravaJmen({
  jmena,
  onZmena,
  kompaktni = false,
}: {
  jmena: Jmeno[];
  onZmena: (jmena: Jmeno[]) => void;
  // Na obrazovce výběru jde o vedlejší kolej pod hlavním seznamem, tak je
  // podání drobnější než v Nastavení.
  kompaktni?: boolean;
}) {
  const [nove, setNove] = useState("");
  const [busy, setBusy] = useState(false);
  const [chyba, setChyba] = useState<string | null>(null);
  const [smazat, setSmazat] = useState<string | null>(null);

  async function pridej(e: React.FormEvent) {
    e.preventDefault();
    const j = nove.trim();
    if (!j || busy) return;
    setBusy(true);
    setChyba(null);
    try {
      const res = await api.pridejJmeno(j);
      onZmena(res.jmena);
      setNove("");
    } catch (err) {
      setChyba(err instanceof Error ? err.message : "Jméno se nepodařilo přidat.");
    } finally {
      setBusy(false);
    }
  }

  async function smaz(j: string) {
    setSmazat(null);
    setBusy(true);
    setChyba(null);
    try {
      const res = await api.smazJmeno(j);
      onZmena(res.jmena);
    } catch (err) {
      setChyba(err instanceof Error ? err.message : "Jméno se nepodařilo smazat.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={pridej} className="flex gap-2">
        <input
          className={`input flex-1 ${chyba ? "input-error" : ""}`}
          value={nove}
          onChange={(e) => {
            setNove(e.target.value);
            setChyba(null);
          }}
          placeholder="Jméno, např. Franta"
          maxLength={40}
          aria-label="Nové jméno"
        />
        <button type="submit" className="btn-ghost shrink-0" disabled={busy || !nove.trim()}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" strokeWidth={1.75} />
          )}
          Přidat
        </button>
      </form>

      {chyba && <p className="text-sm text-danger">{chyba}</p>}

      {jmena.length > 0 ? (
        <ul className="divide-y divide-lineSoft rounded-lg ring-1 ring-line">
          {jmena.map((j) => (
            <li key={j.jmeno} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className={kompaktni ? "text-sm text-fg" : "text-sm font-medium text-fg"}>
                {j.jmeno}
              </span>
              <button
                onClick={() => setSmazat(j.jmeno)}
                disabled={busy}
                className="rounded p-1.5 text-fg-dim hover:bg-danger-soft hover:text-danger"
                title={`Smazat jméno ${j.jmeno}`}
                aria-label={`Smazat jméno ${j.jmeno}`}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">Seznam je zatím prázdný — přidejte první jméno.</p>
      )}

      <Confirm
        open={!!smazat}
        titulek="Smazat jméno ze seznamu?"
        text={
          <>
            Jméno <strong className="font-semibold text-fg">{smazat}</strong> zmizí z nabídky při
            přihlášení. Záznamy v auditu, které pod ním vznikly, zůstávají — audit se nepřepisuje.
          </>
        }
        potvrdit="Smazat jméno"
        onPotvrdit={() => smazat && smaz(smazat)}
        onZrusit={() => setSmazat(null)}
      />
    </div>
  );
}
