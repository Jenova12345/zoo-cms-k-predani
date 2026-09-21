import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, X } from "lucide-react";

type ToastKind = "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let counter = 0;

// Potvrzení úspěchu zmizí samo, ale pomaleji, než trvá přečíst větu.
// Chyba nezmizí vůbec: kurátor si ji má přečíst a zavřít, ne ji minout,
// protože se zrovna díval do formuláře a hláška vyskočila jinde.
const TRVANI_USPECHU_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++counter;
      setToasts((prev) => [...prev, { id, kind, message }]);
      if (kind === "success") setTimeout(() => remove(id), TRVANI_USPECHU_MS);
    },
    [remove],
  );

  const apiValue: ToastApi = {
    success: (m) => push("success", m),
    error: (m) => push("error", m),
  };

  return (
    <ToastContext.Provider value={apiValue}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-3">
        {toasts.map((t) => {
          const uspech = t.kind === "success";
          return (
            <div
              key={t.id}
              className={`relative flex items-start gap-3 overflow-hidden rounded-xl bg-elevated py-4 pl-5 pr-3 shadow-cardHover border-2 min-w-[320px] max-w-md animate-fadeIn ${
                uspech ? "border-accent/45" : "border-danger/60"
              }`}
              role={uspech ? "status" : "alert"}
              aria-live={uspech ? "polite" : "assertive"}
            >
              {/* Barevný pruh: hlášku jde rozpoznat koutkem oka, bez čtení. */}
              <span
                className={`absolute inset-y-0 left-0 w-1.5 ${uspech ? "bg-accent" : "bg-danger"}`}
              />
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
                  uspech ? "bg-accent text-white" : "bg-danger text-white"
                }`}
              >
                {uspech ? (
                  <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                ) : (
                  <AlertCircle className="h-4 w-4" strokeWidth={2} />
                )}
              </span>
              <span className="flex-1 text-sm font-semibold leading-snug text-fg">{t.message}</span>
              <button
                onClick={() => remove(t.id)}
                className="shrink-0 rounded p-1 text-fg-dim hover:bg-canvas hover:text-fg"
                aria-label="Zavřít"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast musí být uvnitř ToastProvider");
  return ctx;
}
