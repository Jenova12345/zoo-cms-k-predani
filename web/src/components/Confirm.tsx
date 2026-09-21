import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Send } from "lucide-react";

// Potvrzení akce, kterou nejde vzít zpět (mazání slidu), nebo která má
// následek venku u expozice (zveřejnění na tabletu). Záměrně vlastní dialog
// místo window.confirm: kurátor má vidět srozumitelnou českou hlášku ve stylu
// zbytku CMS, ne systémové okno prohlížeče s adresou.
//
// Escape a klik do pozadí = zrušit. Výchozí fokus je na „Zrušit", ať se
// nevratná akce nedá odklepnout omylem klávesou Enter.
//
// `varianta` mění jen tón dialogu: "nebezpeci" = červená (mazání),
// "publikovat" = zelená (zveřejnění není destruktivní, jen ho uvidí
// návštěvníci). `prodlevaMs` je pojistka proti překliku, potvrzovací
// tlačítko se odemkne až po odpočtu, takže omylem zdvojený klik z předchozí
// obrazovky akci nespustí.
export default function Confirm({
  open,
  titulek,
  text,
  potvrdit = "Smazat",
  varianta = "nebezpeci",
  prodlevaMs = 0,
  onPotvrdit,
  onZrusit,
}: {
  open: boolean;
  titulek: string;
  text: ReactNode;
  potvrdit?: string;
  varianta?: "nebezpeci" | "publikovat";
  prodlevaMs?: number;
  onPotvrdit: () => void;
  onZrusit: () => void;
}) {
  const zrusitRef = useRef<HTMLButtonElement>(null);
  const [zbyva, setZbyva] = useState(0);

  useEffect(() => {
    if (!open) return;
    zrusitRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onZrusit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onZrusit]);

  // Odpočet pojistky proti překliku. Běží jen u otevřeného dialogu.
  useEffect(() => {
    if (!open || prodlevaMs <= 0) {
      setZbyva(0);
      return;
    }
    setZbyva(Math.ceil(prodlevaMs / 1000));
    const t = setInterval(() => setZbyva((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [open, prodlevaMs]);

  if (!open) return null;

  const publikovat = varianta === "publikovat";
  const Ikona = publikovat ? Send : AlertTriangle;
  const zamceno = zbyva > 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-fg/25 px-4"
      onClick={onZrusit}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titulek}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-cardHover animate-fadeIn"
      >
        <div className="flex items-start gap-3">
          <span
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
              publikovat ? "bg-accent-soft" : "bg-danger-soft"
            }`}
          >
            <Ikona
              className={`h-5 w-5 ${publikovat ? "text-accent" : "text-danger"}`}
              strokeWidth={1.75}
            />
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold text-fg">{titulek}</h2>
            <div className="mt-1.5 text-sm text-fg-muted">{text}</div>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button ref={zrusitRef} onClick={onZrusit} className="btn-ghost">
            Zrušit
          </button>
          <button
            onClick={onPotvrdit}
            disabled={zamceno}
            className={publikovat ? "btn-primary" : "btn-danger"}
            title={zamceno ? "Pojistka proti překliku, chvilku počkejte" : undefined}
          >
            {potvrdit}
            {zamceno && <span className="tnum"> ({zbyva})</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
