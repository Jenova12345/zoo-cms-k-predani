import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Film, Info, Loader2, RefreshCw } from "lucide-react";
import { api, formatDateTime } from "../lib/api";
import { NAHRAVANI_MAX_B, NAHRAVANI_MAX_MB, vMB } from "../lib/limity";
import { useToast } from "../components/Toast";
import type { DiraStav } from "../lib/types";

// Díry v zemi: dva zapuštěné expoziční prvky.
//
// Nejsou to displeje a nemají slidy. Michalův přehrávač si video čte přímo
// z disku ze složky v datovém kořeni a bere cokoli s příponou .mp4, co tam
// najde. Jediné, co tahle stránka umí, je dostat do té složky právě jeden
// soubor: nahrát a vyměnit. Mazání tu schválně není, prázdná díra nedává
// provozní smysl.
//
// Náhled videa se tu nepřehrává: soubory z těchhle složek se přes HTTP
// neservírují (statické servírování je zúžené na data/displeje). Místo
// přehrávače se ukazuje název souboru, velikost a čas nahrání.

function KartaDiry({
  dira,
  onNahrano,
}: {
  dira: DiraStav;
  onNahrano: () => Promise<void>;
}) {
  const toast = useToast();
  const [nahravam, setNahravam] = useState(false);
  const [procenta, setProcenta] = useState(0);
  const zruseni = useRef<AbortController | null>(null);
  const vstup = useRef<HTMLInputElement>(null);

  async function nahraj(file: File) {
    if (file.type !== "video/mp4" && !/\.mp4$/i.test(file.name)) {
      toast.error("Nahrajte prosím video ve formátu MP4.");
      return;
    }
    // Limit hlídáme ještě před odesláním, ať kurátor nečeká na upload, který
    // server stejně utne.
    if (file.size > NAHRAVANI_MAX_B) {
      toast.error(
        `Video má ${vMB(file.size)}, maximum je ${NAHRAVANI_MAX_MB} MB. Zmenšete ho a zkuste to znovu.`,
      );
      return;
    }
    const rizeni = new AbortController();
    zruseni.current = rizeni;
    setProcenta(0);
    setNahravam(true);
    try {
      await api.uploadDiraVideo(dira.id, file, {
        signal: rizeni.signal,
        onProgress: setProcenta,
      });
      await onNahrano();
      toast.success(`${dira.nazev}: video nahráno.`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        // Zrušený upload nic nepřepsal, ve složce zůstalo původní video.
        toast.error("Nahrávání zrušeno, ve složce zůstalo původní video.");
      } else {
        toast.error(e instanceof Error ? e.message : "Upload videa selhal.");
      }
    } finally {
      zruseni.current = null;
      setNahravam(false);
    }
  }

  return (
    <div className="rounded-xl border border-line shadow-card">
      <div className="border-b border-line px-6 py-4">
        <h2 className="font-display text-xl font-bold tracking-tight text-fg">{dira.nazev}</h2>
        <p className="mt-0.5 break-all font-mono text-xs text-fg-dim">{dira.cesta}</p>
      </div>

      <div className="space-y-4 px-6 py-5">
        <input
          ref={vstup}
          type="file"
          accept="video/mp4"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void nahraj(f);
            e.target.value = "";
          }}
        />

        {nahravam && (
          <div className="rounded-xl border border-line bg-canvas px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-fg tnum">
                Nahrávám video {procenta} %
              </span>
              <button
                onClick={() => zruseni.current?.abort()}
                className="btn-ghost px-2.5 py-1 text-xs"
              >
                Zrušit nahrávání
              </button>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
              <div className="h-full bg-accent transition-all" style={{ width: `${procenta}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">
              Dokud nahrávání nedoběhne, zůstává ve složce původní video.
            </p>
          </div>
        )}

        {/* Co teď ve složce leží */}
        <div className="rounded-lg border border-dashed border-line bg-canvas px-4 py-3">
          <div className="kicker">Ve složce teď je</div>
          {dira.soubor ? (
            <div className="mt-1.5 text-sm text-fg-muted">
              <span className="break-all font-semibold text-fg">{dira.soubor}</span>
              {dira.velikost !== null && <> · {vMB(dira.velikost)}</>}
              {dira.nahrano && <> · nahráno {formatDateTime(dira.nahrano)}</>}
            </div>
          ) : (
            <div className="mt-1.5 text-sm text-fg-muted">
              Zatím žádné video. Dokud tu nějaké nebude, prvek nemá co přehrávat.
            </div>
          )}
        </div>

        {/* Ruční zásah do složky: přehrávač by nevěděl, které video pustit. */}
        {dira.vicSouboru.length > 0 && (
          <div
            className="flex items-start gap-2.5 rounded-lg border border-amber/40 bg-amber-soft px-4 py-3"
            role="alert"
          >
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-deep"
              strokeWidth={1.75}
            />
            <div className="min-w-0 text-sm text-fg">
              <div className="font-semibold">Ve složce je víc videí než jedno.</div>
              <div className="mt-0.5 break-all text-fg-muted">
                {dira.vicSouboru.join(", ")} — přehrávač neví, které pustit. Nahrajte video znovu
                přes tlačítko níž, tím ve složce zůstane jen ono.
              </div>
            </div>
          </div>
        )}

        <button
          onClick={() => vstup.current?.click()}
          disabled={nahravam}
          className={dira.soubor ? "btn-ghost" : "btn-primary"}
        >
          {nahravam ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Film className="h-4 w-4" strokeWidth={1.75} />
          )}
          {dira.soubor ? "Vyměnit video" : "Nahrát video"}
        </button>
      </div>
    </div>
  );
}

export default function Diry() {
  const [diry, setDiry] = useState<DiraStav[] | null>(null);
  const [chyba, setChyba] = useState<string | null>(null);

  async function nacti() {
    try {
      setDiry(await api.diry());
      setChyba(null);
    } catch (e) {
      setChyba(e instanceof Error ? e.message : "Načtení selhalo.");
    }
  }

  useEffect(() => {
    void nacti();
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-fg">Díry v zemi</h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-fg-muted">
            Dva zapuštěné expoziční prvky. U každého je jedno video ve formátu MP4; nahrané video
            jde kdykoliv vyměnit za jiné.
          </p>
        </div>
        <button onClick={() => void nacti()} className="btn-ghost" disabled={!diry}>
          <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
          Obnovit
        </button>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-dashed border-line bg-canvas px-4 py-3.5">
        <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-fg-dim" strokeWidth={1.75} />
        <div className="text-sm leading-relaxed text-fg-muted">
          Video se uloží do složky na serveru a <strong className="font-semibold text-fg">
          přehrávač u prvku si ho odtud načte sám</strong>. CMS se přehrávače na nic neptá, takže
          neví, jestli už video hraje; ověřit se to dá jen na místě v pavilonu. Ve složce je vždy
          jen jedno video: při výměně se to předchozí odstraní.
        </div>
      </div>

      {chyba && <div className="text-sm text-danger">{chyba}</div>}

      {!diry && !chyba && (
        <div className="flex items-center gap-2 text-sm text-fg-dim">
          <Loader2 className="h-4 w-4 animate-spin" />
          Načítám…
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {diry?.map((d) => (
          <KartaDiry key={d.id} dira={d} onNahrano={nacti} />
        ))}
      </div>
    </div>
  );
}
