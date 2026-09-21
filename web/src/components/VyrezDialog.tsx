import { useCallback, useEffect, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import type { Vyrez } from "../lib/types";

// Editor výřezu fotky. Kurátor si posunutím a zoomem navolí, co z fotky
// bude na tabletu vidět; rámeček má přesně ten poměr, ve kterém fotku
// zobrazuje Unity.
//
// Ven jde výřez v PODÍLECH 0..1 vůči originálu, ne v pixelech. Server podle
// nich ořízne originál v plném rozlišení, takže se výřez dá kdykoli posunout
// zpátky a fotka se opakovaným ořezáváním nezhoršuje.
//
// Fotka se sem načítá z `.orig` přes `?original=1`, aby kurátor viděl a mohl
// navolit celou plochu, ne jen to, co zbylo po minulém ořezu.

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_KROK = 0.2;

export function VyrezDialog({
  url,
  pomer,
  vyrez,
  popisPomeru,
  ukladani,
  onUloz,
  onZrus,
}: {
  url: string;
  pomer: number;
  vyrez: Vyrez | null;
  popisPomeru: string;
  ukladani: boolean;
  onUloz: (v: Vyrez) => void;
  onZrus: () => void;
}) {
  const [stred, setStred] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  // Poslední výřez z knihovny v PROCENTECH plochy fotky.
  const [oblast, setOblast] = useState<Area | null>(null);

  // POZOR na pořadí argumentů: onCropComplete dává nejdřív výřez v procentech
  // a teprve druhý v pixelech. Pixely by tu byly k ničemu — server počítá
  // z originálu, který má jiné rozměry než náhled v editoru.
  const zmena = useCallback((vProcentech: Area, _vPixelech: Area) => {
    setOblast(vProcentech);
  }, []);

  // Escape zavírá, Enter ukládá — stejně jako potvrzovací dialogy v CMS.
  useEffect(() => {
    function klavesa(e: KeyboardEvent) {
      if (e.key === "Escape") onZrus();
      if (e.key === "Enter" && oblast && !ukladani) {
        onUloz({
          x: oblast.x / 100,
          y: oblast.y / 100,
          w: oblast.width / 100,
          h: oblast.height / 100,
        });
      }
    }
    window.addEventListener("keydown", klavesa);
    return () => window.removeEventListener("keydown", klavesa);
  }, [oblast, ukladani, onUloz, onZrus]);

  // Knihovna umí `initialCroppedAreaPercentages`, ale jen při prvním
  // vykreslení — proto se dialog montuje vždy znovu (key v rodiči).
  const pocatecni = vyrez
    ? { x: vyrez.x * 100, y: vyrez.y * 100, width: vyrez.w * 100, height: vyrez.h * 100 }
    : undefined;

  function uloz() {
    if (!oblast) return;
    onUloz({
      x: oblast.x / 100,
      y: oblast.y / 100,
      w: oblast.width / 100,
      h: oblast.height / 100,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Výřez fotky"
      onClick={(e) => {
        if (e.target === e.currentTarget) onZrus();
      }}
    >
      <div className="w-full max-w-xl rounded-xl bg-surface shadow-cardHover overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">Výřez fotky</h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Uvnitř rámečku je to, co uvidí návštěvník na tabletu. Fotku posuňte tažením,
            přiblížit ji můžete kolečkem nebo dvěma prsty. Poměr {popisPomeru} je daný
            zařízením a nejde změnit.
          </p>
        </div>

        {/* Plocha editoru. Tmavé pozadí schválně: ať je hned vidět, co z fotky
            vypadne ven z rámečku. Vysoká je kvůli poměru 772:800 — rámeček je
            skoro na výšku, a v nízké ploše by vyšel směšně malý. */}
        <div className="relative h-[380px] bg-[#1f2937] sm:h-[520px]">
          <Cropper
            image={url}
            crop={stred}
            zoom={zoom}
            aspect={pomer}
            minZoom={ZOOM_MIN}
            maxZoom={ZOOM_MAX}
            restrictPosition
            initialCroppedAreaPercentages={pocatecni}
            onCropChange={setStred}
            onZoomChange={setZoom}
            onCropComplete={zmena}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_KROK))}
              className="btn-ghost px-2.5 py-1.5"
              title="Oddálit"
              aria-label="Oddálit"
              disabled={zoom <= ZOOM_MIN}
            >
              <ZoomOut className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-32 accent-accent"
              aria-label="Přiblížení"
            />
            <button
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_KROK))}
              className="btn-ghost px-2.5 py-1.5"
              title="Přiblížit"
              aria-label="Přiblížit"
              disabled={zoom >= ZOOM_MAX}
            >
              <ZoomIn className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={onZrus} className="btn-ghost" disabled={ukladani}>
              Zrušit
            </button>
            <button onClick={uloz} className="btn-primary" disabled={ukladani || !oblast}>
              {ukladani && <Loader2 className="h-4 w-4 animate-spin" />}
              Uložit výřez
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
