import { useCallback, useEffect, useMemo, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "../lib/api";
import type { StavOrezuSekvence, Vyrez } from "../lib/types";

// Editor výřezu SEKVENCE 360. Na rozdíl od jedné fotky se tu nastavuje
// jeden jediný výřez pro všechny snímky naráz: model se na nich otáčí, a
// kdyby měl každý snímek svůj rámeček, otáčka by při přehrání poskakovala.
//
// Proto je tu navíc pruh náhledů. Kurátor navolí výřez na jednom snímku,
// ale musí vidět, jestli se model vejde i v půlce otáčky, kde bývá nejširší.
// Náhledy jsou ořezané jen CSS — nic se nepočítá, dokud se neuloží.
//
// Ořez 36 snímků trvá desítky sekund, takže uložení úlohu jen nastartuje
// a dialog se pak doptává na průběh.

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_KROK = 0.2;
const NAHLEDU = 5; // kolik snímků z otáčky se ukáže v pruhu pod editorem
const INTERVAL_DOTAZU_MS = 700;

function naVyrez(o: Area): Vyrez {
  return { x: o.x / 100, y: o.y / 100, w: o.width / 100, h: o.height / 100 };
}

export function VyrezSekvenceDialog({
  displayId,
  n,
  snimky,
  pomer,
  popisPomeru,
  vyrez,
  onHotovo,
  onZrus,
}: {
  displayId: string;
  n: number;
  snimky: string[]; // názvy souborů sekvence v pořadí (001.png, 002.png, …)
  pomer: number;
  popisPomeru: string;
  vyrez: Vyrez | null;
  onHotovo: () => void;
  onZrus: () => void;
}) {
  const [stred, setStred] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [oblast, setOblast] = useState<Area | null>(null);
  // Snímek, na kterém se výřez zrovna nastavuje. Rámeček zůstává stejný,
  // mění se jen obrázek pod ním — snímky mají stejné rozměry.
  const [aktivni, setAktivni] = useState(0);
  const [uloha, setUloha] = useState<StavOrezuSekvence | null>(null);
  const [chyba, setChyba] = useState<string | null>(null);

  const bezi = uloha?.bezi === true;

  // POZOR na pořadí argumentů: onCropComplete dává nejdřív výřez
  // v procentech a teprve druhý v pixelech. Pixely by tu byly k ničemu —
  // server počítá z originálu, který má jiné rozměry než náhled v editoru.
  const zmena = useCallback((vProcentech: Area, _vPixelech: Area) => {
    setOblast(vProcentech);
  }, []);

  // Rovnoměrně rozprostřené snímky po otáčce: první, poslední a pár mezi
  // nimi. Víc než pět by přes LAN natahovalo zbytečně moc originálů.
  const nahledy = useMemo(() => {
    const kolik = Math.min(NAHLEDU, snimky.length);
    if (kolik <= 1) return snimky.slice(0, kolik).map((_, i) => i);
    return Array.from({ length: kolik }, (_, i) =>
      Math.round((i * (snimky.length - 1)) / (kolik - 1)),
    );
  }, [snimky]);

  // Knihovna re-aplikuje `initialCroppedAreaPercentages` při KAŽDÉM načtení
  // obrázku, ne jen při prvním. Když se tedy přepne snímek, dostane zpátky
  // to, co jí sem pošleme — proto tu je aktuální výřez, ne ten uložený.
  // Kdyby se posílal pořád ten uložený, přepnutí snímku by kurátorovi
  // zahodilo, co si právě navolil.
  const drzenyVyrez = oblast
    ? { x: oblast.x, y: oblast.y, width: oblast.width, height: oblast.height }
    : vyrez
      ? { x: vyrez.x * 100, y: vyrez.y * 100, width: vyrez.w * 100, height: vyrez.h * 100 }
      : undefined;

  // Průběh ořezu. Ptáme se, dokud úloha běží; server ji drží v paměti,
  // takže se na ni dá doptat i po znovunačtení stránky.
  useEffect(() => {
    if (!bezi) return;
    let platne = true;
    const t = setTimeout(async () => {
      try {
        const { stav } = await api.stavOrezuSekvence(displayId, n);
        if (!platne) return;
        setUloha(stav);
        if (!stav) {
          // Server o úloze neví — typicky se mezitím restartoval. Ořez je
          // buď hotový, nebo se vůbec nestal; v obou případech jsou snímky
          // konzistentní, jen nevíme které.
          setChyba("Ořez už neběží (restart serveru?). Zkontrolujte snímky, případně spusťte znovu.");
        } else if (!stav.bezi) {
          if (stav.chyba) setChyba(stav.chyba);
          else onHotovo();
        }
      } catch {
        // Výpadek jednoho dotazu nic neznamená, zkusí se za chvíli znovu.
        if (platne) setUloha((p) => (p ? { ...p } : p));
      }
    }, INTERVAL_DOTAZU_MS);
    return () => {
      platne = false;
      clearTimeout(t);
    };
  }, [bezi, uloha, displayId, n, onHotovo]);

  useEffect(() => {
    function klavesa(e: KeyboardEvent) {
      if (bezi) return; // během ořezu se dialog nezavírá, ať je vidět průběh
      if (e.key === "Escape") onZrus();
      if (e.key === "ArrowLeft") setAktivni((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setAktivni((i) => Math.min(snimky.length - 1, i + 1));
    }
    window.addEventListener("keydown", klavesa);
    return () => window.removeEventListener("keydown", klavesa);
  }, [bezi, onZrus, snimky.length]);

  async function spust() {
    if (!oblast) return;
    setChyba(null);
    setUloha({ bezi: true, hotovo: 0, celkem: snimky.length, chyba: null });
    try {
      await api.oriznSekvenci(displayId, n, naVyrez(oblast));
    } catch (e) {
      setUloha(null);
      setChyba(e instanceof Error ? e.message : "Ořez se nepodařilo spustit.");
    }
  }

  const procenta = uloha && uloha.celkem > 0 ? (uloha.hotovo / uloha.celkem) * 100 : 0;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Výřez sekvence 360"
      onClick={(e) => {
        if (e.target === e.currentTarget && !bezi) onZrus();
      }}
    >
      <div className="w-full max-w-2xl rounded-xl bg-surface shadow-cardHover overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">
            Výřez sekvence 360
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Jeden výřez platí pro všech {snimky.length} snímků naráz — model se otáčí a rámeček
            musí sedět na celou otáčku. Projděte si šipkami pár snímků a zkontrolujte v náhledech
            dole, že model nikde nevyjede ven. Poměr {popisPomeru} je daný zařízením.
          </p>
          <p className="mt-1 text-xs text-fg-dim">
            Originály snímků si CMS nechá stranou, aby šel výřez kdykoli posunout zpátky —
            u dlouhé sekvence tím složka na disku zabere zhruba dvojnásobek.
          </p>
        </div>

        <div className="relative h-[340px] bg-[#1f2937] sm:h-[440px]">
          <Cropper
            image={api.originalUrl(displayId, n, snimky[aktivni])}
            crop={stred}
            zoom={zoom}
            aspect={pomer}
            minZoom={ZOOM_MIN}
            maxZoom={ZOOM_MAX}
            restrictPosition
            initialCroppedAreaPercentages={drzenyVyrez}
            onCropChange={setStred}
            onZoomChange={setZoom}
            onCropComplete={zmena}
          />
        </div>

        {/* Posuvník otáčkou. Rámeček zůstává, mění se snímek pod ním. */}
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <button
            onClick={() => setAktivni((i) => Math.max(0, i - 1))}
            className="btn-ghost px-2 py-1.5"
            disabled={aktivni === 0 || bezi}
            title="Předchozí snímek"
            aria-label="Předchozí snímek"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, snimky.length - 1)}
            step={1}
            value={aktivni}
            onChange={(e) => setAktivni(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label="Snímek sekvence"
            disabled={bezi}
          />
          <button
            onClick={() => setAktivni((i) => Math.min(snimky.length - 1, i + 1))}
            className="btn-ghost px-2 py-1.5"
            disabled={aktivni >= snimky.length - 1 || bezi}
            title="Další snímek"
            aria-label="Další snímek"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <span className="w-24 shrink-0 text-right text-xs text-fg-muted tnum">
            Snímek {aktivni + 1} / {snimky.length}
          </span>
        </div>

        {/* Náhledy z různých míst otáčky, ořezané aktuálním rámečkem. Počítá
            je prohlížeč posunutím obrázku v okně s poměrem stran — na disku
            se do uložení nic nemění. */}
        <div className="border-b border-line px-5 py-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
            Jak to bude vypadat v otáčce
          </div>
          <div className="flex gap-2">
            {nahledy.map((i) => (
              <div key={snimky[i]} className="flex-1">
                <div
                  className="relative overflow-hidden rounded bg-[#1f2937] ring-1 ring-line"
                  style={{ aspectRatio: String(pomer) }}
                >
                  {oblast && (
                    <img
                      src={api.originalUrl(displayId, n, snimky[i])}
                      alt={`Náhled snímku ${i + 1}`}
                      className="absolute max-w-none"
                      style={{
                        width: `${(100 / oblast.width) * 100}%`,
                        height: `${(100 / oblast.height) * 100}%`,
                        left: `${(-oblast.x / oblast.width) * 100}%`,
                        top: `${(-oblast.y / oblast.height) * 100}%`,
                      }}
                    />
                  )}
                </div>
                <div className="mt-1 text-center text-[10px] text-fg-dim tnum">{i + 1}</div>
              </div>
            ))}
          </div>
        </div>

        {chyba && <p className="px-5 pt-3 text-sm text-danger">{chyba}</p>}

        {uloha && bezi ? (
          <div className="px-5 py-4">
            <div className="flex items-center justify-between text-xs text-fg-muted tnum">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Ořezávám sekvenci…
              </span>
              <span>
                {uloha.hotovo} / {uloha.celkem}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-lineSoft">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${procenta}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-fg-muted">
              Snímky se přepíšou až všechny naráz na konci, takže se na tabletu nikdy neobjeví
              půlka sekvence v novém a půlka ve starém výřezu. Okno můžete zavřít, ořez doběhne
              sám.
            </p>
          </div>
        ) : (
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
              <button onClick={onZrus} className="btn-ghost">
                Zrušit
              </button>
              <button onClick={spust} className="btn-primary" disabled={!oblast}>
                Oříznout všech {snimky.length} snímků
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
