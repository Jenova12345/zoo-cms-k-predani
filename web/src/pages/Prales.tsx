import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CloudSun,
  Droplets,
  Info,
  Loader2,
  RefreshCw,
  Thermometer,
  Zap,
} from "lucide-react";
import { api, formatDateTime } from "../lib/api";
import { useToast } from "../components/Toast";
import { useNeulozeno } from "../lib/neulozeno";
import {
  PRALES_INTERVAL_MAX,
  PRALES_INTERVAL_MIN,
  PRALES_TEPLOTA_MAX,
  PRALES_TEPLOTA_MIN,
  PRALES_VLHKOST_MAX_ZNAKU,
  type PralesNastaveni,
  type PralesStav,
} from "../lib/types";

// Nastavení displeje u deštného pralesa.
//
// Tenhle displej jako jediný neukazuje obsah druhu ze složek data/displeje,
// ale prostředí pavilonu a odpočet do bouřky z videomappingu. Unity si data
// tahá z GET /api/prales každých pět sekund.
//
// Stránka je schválně rozdělená na dvě části: vlevo se nastavuje, vpravo je
// vidět, co endpoint POSÍLÁ TEĎ. Kurátor tak nemusí věřit tomu, že se uložení
// projevilo, ale vidí to na stejných číslech, jaká čtou tablety.

// Jak často se náhled obnovuje. Schválně stejně jako Unity, ať kurátor vidí
// tentýž rytmus, v jakém se ptají tablety.
const OBNOVA_MS = 5000;

interface Formular {
  teplotaVnitrni: string;
  vlhkost: string;
  teplotaVenkovniZaloha: string;
  bourkaZapnuta: boolean;
  bourkaIntervalMin: string;
  varovaniBlikaniSvetel: boolean;
  varovaniVodniEfekty: boolean;
}

function naFormular(n: PralesNastaveni): Formular {
  return {
    teplotaVnitrni: String(n.teplotaVnitrni),
    vlhkost: n.vlhkost,
    teplotaVenkovniZaloha: String(n.teplotaVenkovniZaloha),
    bourkaZapnuta: n.bourkaZapnuta,
    bourkaIntervalMin: String(n.bourkaIntervalMin),
    varovaniBlikaniSvetel: n.varovaniBlikaniSvetel,
    varovaniVodniEfekty: n.varovaniVodniEfekty,
  };
}

// Čárka i tečka jako oddělovač: na české klávesnici je na numerické části
// čárka a nikdo ji nebude přepínat kvůli jednomu poli.
function naCislo(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

type ChybyPoli = Partial<Record<keyof Formular, string>>;

// Stejná pravidla jako na serveru (server/src/prales.ts, validujNastaveni).
// Tady kvůli tomu, ať kurátor dostane hlášku hned u pole; server si vstup
// ověřuje znovu, tohle není jeho náhrada.
function zkontroluj(f: Formular): { chyby: ChybyPoli; nastaveni: PralesNastaveni | null } {
  const chyby: ChybyPoli = {};
  const mezeTeploty = `Zadejte číslo mezi ${PRALES_TEPLOTA_MIN} a ${PRALES_TEPLOTA_MAX} °C.`;

  const vnitrni = naCislo(f.teplotaVnitrni);
  if (vnitrni === null || vnitrni < PRALES_TEPLOTA_MIN || vnitrni > PRALES_TEPLOTA_MAX) {
    chyby.teplotaVnitrni = mezeTeploty;
  }

  const zaloha = naCislo(f.teplotaVenkovniZaloha);
  if (zaloha === null || zaloha < PRALES_TEPLOTA_MIN || zaloha > PRALES_TEPLOTA_MAX) {
    chyby.teplotaVenkovniZaloha = mezeTeploty;
  }

  const vlhkost = f.vlhkost.trim();
  if (vlhkost === "") chyby.vlhkost = "Vyplňte vlhkost, například 80-100%.";
  else if (vlhkost.length > PRALES_VLHKOST_MAX_ZNAKU) {
    chyby.vlhkost = `Nejvýš ${PRALES_VLHKOST_MAX_ZNAKU} znaků.`;
  }

  const interval = naCislo(f.bourkaIntervalMin);
  if (
    interval === null ||
    !Number.isInteger(interval) ||
    interval < PRALES_INTERVAL_MIN ||
    interval > PRALES_INTERVAL_MAX
  ) {
    chyby.bourkaIntervalMin = `Celé číslo minut mezi ${PRALES_INTERVAL_MIN} a ${PRALES_INTERVAL_MAX}.`;
  }

  if (Object.keys(chyby).length > 0) return { chyby, nastaveni: null };
  return {
    chyby,
    nastaveni: {
      teplotaVnitrni: vnitrni!,
      vlhkost,
      teplotaVenkovniZaloha: zaloha!,
      bourkaZapnuta: f.bourkaZapnuta,
      bourkaIntervalMin: interval!,
      varovaniBlikaniSvetel: f.varovaniBlikaniSvetel,
      varovaniVodniEfekty: f.varovaniVodniEfekty,
    },
  };
}

function stejne(a: Formular, b: Formular): boolean {
  return (
    a.teplotaVnitrni.trim() === b.teplotaVnitrni.trim() &&
    a.vlhkost.trim() === b.vlhkost.trim() &&
    a.teplotaVenkovniZaloha.trim() === b.teplotaVenkovniZaloha.trim() &&
    a.bourkaZapnuta === b.bourkaZapnuta &&
    a.bourkaIntervalMin.trim() === b.bourkaIntervalMin.trim() &&
    a.varovaniBlikaniSvetel === b.varovaniBlikaniSvetel &&
    a.varovaniVodniEfekty === b.varovaniVodniEfekty
  );
}

// 483 → "8:03". Sekundy samotné se čtou blbě, minuty jdou porovnat s tím,
// co dělá videomapping v pavilonu.
function odpocetCs(sekundy: number): string {
  const m = Math.floor(sekundy / 60);
  return `${m}:${String(sekundy % 60).padStart(2, "0")}`;
}

function casZa(sekundy: number): string {
  return new Date(Date.now() + sekundy * 1000).toLocaleTimeString("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function predJakDlouho(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minut = Math.floor(ms / 60000);
  if (minut < 1) return "před chvílí";
  if (minut === 1) return "před minutou";
  if (minut < 60) return `před ${minut} minutami`;
  const hodin = Math.floor(minut / 60);
  if (hodin === 1) return "před hodinou";
  if (hodin < 24) return `před ${hodin} hodinami`;
  const dnu = Math.floor(hodin / 24);
  return dnu === 1 ? "před dnem" : `před ${dnu} dny`;
}

// --- Drobné stavební prvky stránky ---

function Sekce({
  ikona: Ikona,
  titulek,
  popis,
  children,
}: {
  ikona: typeof Thermometer;
  titulek: string;
  popis: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5 border-t border-line pt-7 first:border-0 first:pt-0">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <Ikona className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold tracking-tight text-fg">{titulek}</h2>
          <p className="mt-0.5 text-sm text-fg-muted">{popis}</p>
        </div>
      </div>
      <div className="space-y-5 pl-11">{children}</div>
    </section>
  );
}

// Vysvětlivka pod polem: kde přesně se hodnota na displeji projeví a jak se
// jmenuje v odpovědi endpointu (kvůli ladění s Michalem).
function NaDispleji({ text, pole }: { text: string; pole: string }) {
  return (
    <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
      <span className="font-semibold text-fg-muted">Na displeji: </span>
      {text}{" "}
      <span className="whitespace-nowrap text-fg-dim">
        (v odpovědi <span className="font-mono text-[11px]">{pole}</span>)
      </span>
    </p>
  );
}

function Prepinac({
  zapnuto,
  onZmena,
  popisek,
  id,
}: {
  zapnuto: boolean;
  onZmena: (v: boolean) => void;
  popisek: string;
  id: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={zapnuto}
      onClick={() => onZmena(!zapnuto)}
      className="flex items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-lg"
    >
      <span
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          zapnuto ? "bg-accent" : "bg-line"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-card transition-all ${
            zapnuto ? "left-[22px]" : "left-0.5"
          }`}
        />
      </span>
      <span className="text-sm font-semibold text-fg">{popisek}</span>
      <span
        className={`chip ${zapnuto ? "bg-accent-soft text-accent" : "bg-canvas text-fg-muted"}`}
      >
        {zapnuto ? "zapnuto" : "vypnuto"}
      </span>
    </button>
  );
}

export default function Prales() {
  const toast = useToast();
  const { nastavNeulozeno } = useNeulozeno();

  const [stav, setStav] = useState<PralesStav | null>(null);
  const [chybaNacteni, setChybaNacteni] = useState<string | null>(null);
  const [form, setForm] = useState<Formular | null>(null);
  // Uložený stav pro porovnání „je co ukládat" a pro tlačítko Zahodit změny.
  const [ulozene, setUlozene] = useState<Formular | null>(null);
  const [uklada, setUklada] = useState(false);
  const [ukazChyby, setUkazChyby] = useState(false);

  // Kdy dorazil náhled a kolikátá je zrovna sekunda: mezi obnovami se odpočet
  // dopočítává lokálně, ať neposkakuje po pěti sekundách.
  const [prijato, setPrijato] = useState(0);
  const [ted, setTed] = useState(() => Date.now());

  // Aby polling nepřepsal rozepsaný formulář, když ho kurátor zrovna vyplňuje.
  const formRef = useRef<Formular | null>(null);
  formRef.current = form;

  function prevezmi(novy: PralesStav, prepisFormular: boolean) {
    setStav(novy);
    setPrijato(Date.now());
    setTed(Date.now());
    const jakoFormular = naFormular(novy.nastaveni);
    setUlozene(jakoFormular);
    if (prepisFormular) setForm(jakoFormular);
  }

  async function nacti(prepisFormular: boolean) {
    try {
      const data = await api.prales();
      // Formulář se přepíše jen při prvním načtení nebo po uložení; při
      // pravidelné obnově se aktualizuje jen náhled, ať se kurátorovi
      // nemění hodnoty pod rukama.
      prevezmi(data, prepisFormular || formRef.current === null);
      setChybaNacteni(null);
    } catch (e) {
      setChybaNacteni(e instanceof Error ? e.message : "Načtení selhalo.");
    }
  }

  useEffect(() => {
    void nacti(true);
    const obnova = setInterval(() => void nacti(false), OBNOVA_MS);
    const tik = setInterval(() => setTed(Date.now()), 1000);
    return () => {
      clearInterval(obnova);
      clearInterval(tik);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zmeneno = useMemo(
    () => (form && ulozene ? !stejne(form, ulozene) : false),
    [form, ulozene],
  );

  // Levý panel se ptá, jestli může kurátora pustit pryč ze stránky.
  useEffect(() => {
    nastavNeulozeno(zmeneno);
    return () => nastavNeulozeno(false);
  }, [zmeneno, nastavNeulozeno]);

  const chyby = form ? zkontroluj(form).chyby : {};

  function uprav(zmena: Partial<Formular>) {
    setForm((prev) => (prev ? { ...prev, ...zmena } : prev));
  }

  async function uloz() {
    if (!form) return;
    const { chyby: nalezene, nastaveni } = zkontroluj(form);
    if (!nastaveni) {
      setUkazChyby(true);
      toast.error(Object.values(nalezene)[0] ?? "Zkontrolujte prosím vyplněné hodnoty.");
      return;
    }
    setUklada(true);
    try {
      const novy = await api.savePrales(nastaveni);
      prevezmi(novy, true);
      setUkazChyby(false);
      toast.success("Nastavení uloženo, displej ho převezme do pěti sekund.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uložení selhalo.");
    } finally {
      setUklada(false);
    }
  }

  // Odpočet dopočítaný mezi obnovami. Nula znamená „vypnuto", ta se nesnižuje.
  const odpocet = (() => {
    if (!stav) return 0;
    const zaklad = stav.nahled.countdown_seconds;
    if (zaklad <= 0) return 0;
    return Math.max(0, zaklad - Math.floor((ted - prijato) / 1000));
  })();

  if (!stav || !form) {
    return (
      <div className="space-y-8">
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Deštný prales displej
        </h1>
        {chybaNacteni ? (
          <div className="text-sm text-danger">{chybaNacteni}</div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-fg-dim">
            <Loader2 className="h-4 w-4 animate-spin" />
            Načítám…
          </div>
        )}
      </div>
    );
  }

  const pocasi = stav.pocasi;
  const zInternetu = pocasi.zdroj === "internet";

  return (
    <div className="space-y-8">
      <div className="border-b border-line pb-6">
        <h1 className="font-display text-3xl font-bold tracking-tight text-fg">
          Deštný prales displej
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-fg-muted">
          Displej u deštného pralesa jako jediný neukazuje obsah druhu, ale prostředí pavilonu
          a odpočet do další bouřky z videomappingu. Data si z CMS stahuje každých pět sekund,
          takže se změna projeví hned po uložení. Ostatních displejů se tohle nastavení nijak
          netýká.
        </p>
      </div>

      {chybaNacteni && (
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" strokeWidth={1.75} />
          <span>
            Obnova náhledu selhala: {chybaNacteni} Nastavení jde uložit dál, jen náhled nemusí být
            aktuální.
          </span>
        </div>
      )}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* --- Nastavení --- */}
        <div className="space-y-8">
          <Sekce
            ikona={Thermometer}
            titulek="Prostředí pavilonu"
            popis="Hodnoty, které se na displeji ukazují jako stav uvnitř pavilonu. Neměří se, zadáváte je ručně."
          >
            <div>
              <label className="label" htmlFor="teplotaVnitrni">
                Vnitřní teplota (°C)
              </label>
              <input
                id="teplotaVnitrni"
                className={`input max-w-[200px] ${
                  ukazChyby && chyby.teplotaVnitrni ? "input-error" : ""
                }`}
                inputMode="decimal"
                value={form.teplotaVnitrni}
                onChange={(e) => uprav({ teplotaVnitrni: e.target.value })}
              />
              <NaDispleji
                text="teplota uvnitř pavilonu vedle vlhkosti."
                pole="temperature_internal"
              />
              {ukazChyby && chyby.teplotaVnitrni && (
                <p className="mt-1 text-xs text-danger">{chyby.teplotaVnitrni}</p>
              )}
            </div>

            <div>
              <label className="label" htmlFor="vlhkost">
                Vlhkost
              </label>
              <input
                id="vlhkost"
                className={`input max-w-[200px] ${ukazChyby && chyby.vlhkost ? "input-error" : ""}`}
                value={form.vlhkost}
                maxLength={PRALES_VLHKOST_MAX_ZNAKU}
                placeholder="80-100%"
                onChange={(e) => uprav({ vlhkost: e.target.value })}
              />
              <NaDispleji
                text="údaj o vlhkosti. Posílá se jako text, ne jako číslo, takže smí být i rozsah 80-100% nebo znak procenta."
                pole="humidity_text"
              />
              {ukazChyby && chyby.vlhkost && (
                <p className="mt-1 text-xs text-danger">{chyby.vlhkost}</p>
              )}
            </div>
          </Sekce>

          <Sekce
            ikona={CloudSun}
            titulek="Venkovní teplota"
            popis="Stahuje se sama z open-meteo.com pro Ostravu, nejvýš jednou za deset minut. Nastavuje se jen záloha pro výpadek internetu."
          >
            <div
              className={`rounded-lg border px-4 py-3 ${
                zInternetu && !pocasi.zastarale
                  ? "border-line bg-canvas"
                  : "border-amber/40 bg-amber-soft"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-display text-2xl font-bold tabular-nums text-fg">
                  {stav.nahled.temperature_external} °C
                </span>
                <span
                  className={`chip ${
                    zInternetu ? "bg-accent-soft text-accent" : "bg-white text-amber-deep"
                  }`}
                >
                  {zInternetu ? "z internetu" : "záloha z CMS"}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
                {zInternetu ? (
                  <>
                    Staženo {pocasi.ziskano ? predJakDlouho(pocasi.ziskano) : ""}
                    {pocasi.ziskano && (
                      <span className="text-fg-dim"> ({formatDateTime(pocasi.ziskano)})</span>
                    )}
                    .
                    {pocasi.zastarale && (
                      <span className="font-semibold text-amber-deep">
                        {" "}
                        Je to starší než hodina, internet nejspíš nejede. Displej zatím ukazuje
                        tuhle poslední známou hodnotu.
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    Skutečnou teplotu se zatím nepodařilo stáhnout, displej ukazuje záložní hodnotu
                    nastavenou níž.
                  </>
                )}
              </p>
              {pocasi.chyba && (
                <p className="mt-1 text-xs text-amber-deep">
                  Poslední pokus{" "}
                  {pocasi.posledniPokus ? predJakDlouho(pocasi.posledniPokus) : ""}: {pocasi.chyba}
                </p>
              )}
              <p className="mt-1 text-[11px] text-fg-dim">
                Souřadnice {pocasi.souradnice.lat}, {pocasi.souradnice.lon} (mění se v konfiguraci
                serveru, proměnné POCASI_LAT a POCASI_LON).
              </p>
            </div>

            <div>
              <label className="label" htmlFor="teplotaVenkovniZaloha">
                Záložní venkovní teplota (°C)
              </label>
              <input
                id="teplotaVenkovniZaloha"
                className={`input max-w-[200px] ${
                  ukazChyby && chyby.teplotaVenkovniZaloha ? "input-error" : ""
                }`}
                inputMode="decimal"
                value={form.teplotaVenkovniZaloha}
                onChange={(e) => uprav({ teplotaVenkovniZaloha: e.target.value })}
              />
              <NaDispleji
                text="venkovní teplota, ale jen v nouzi: použije se, když nejede internet a server ještě nestihl stáhnout žádnou skutečnou hodnotu. Jinak se nikde neukáže."
                pole="temperature_external"
              />
              {ukazChyby && chyby.teplotaVenkovniZaloha && (
                <p className="mt-1 text-xs text-danger">{chyby.teplotaVenkovniZaloha}</p>
              )}
            </div>
          </Sekce>

          <Sekce
            ikona={Droplets}
            titulek="Odpočet do bouřky"
            popis="Kolik zbývá do další bouřky ve videomappingu. Bouřky se opakují pořád dokola v nastaveném intervalu."
          >
            <Prepinac
              id="bourkaZapnuta"
              zapnuto={form.bourkaZapnuta}
              onZmena={(v) => uprav({ bourkaZapnuta: v })}
              popisek="Odpočet do bouřky"
            />

            <div>
              <label className="label" htmlFor="bourkaIntervalMin">
                Bouřka každých… (minut)
              </label>
              <input
                id="bourkaIntervalMin"
                className={`input max-w-[200px] ${
                  ukazChyby && chyby.bourkaIntervalMin ? "input-error" : ""
                } ${form.bourkaZapnuta ? "" : "bg-canvas text-fg-muted"}`}
                inputMode="numeric"
                value={form.bourkaIntervalMin}
                disabled={!form.bourkaZapnuta}
                onChange={(e) => uprav({ bourkaIntervalMin: e.target.value })}
              />
              <NaDispleji
                text="odpočet, který na displeji běží k nule. Když doběhne, začne další cyklus."
                pole="countdown_seconds"
              />
              {ukazChyby && chyby.bourkaIntervalMin && (
                <p className="mt-1 text-xs text-danger">{chyby.bourkaIntervalMin}</p>
              )}
            </div>

            <div className="flex items-start gap-2.5 rounded-lg border border-dashed border-line bg-canvas px-4 py-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-dim" strokeWidth={1.75} />
              <div className="text-xs leading-relaxed text-fg-muted">
                {form.bourkaZapnuta ? (
                  <>
                    Bouřky jedou v pevném rastru od půlnoci, ne od zapnutí serveru. Při intervalu{" "}
                    <span className="font-semibold">{form.bourkaIntervalMin || "?"} min</span> to
                    znamená bouřku v {rastrPriklad(form.bourkaIntervalMin)} a tak dál. Když se
                    server restartuje, odpočet naváže tam, kde má být, takže se s videomappingem
                    nerozejde.
                  </>
                ) : (
                  <>
                    Odpočet je vypnutý, displeji se posílá{" "}
                    <span className="font-mono">countdown_seconds: 0</span>. Interval zůstává
                    uložený, takže se dá odpočet kdykoli zapnout zpátky beze změny hodnoty.
                  </>
                )}
              </div>
            </div>
          </Sekce>

          <Sekce
            ikona={Zap}
            titulek="Varování pro návštěvníky"
            popis="Upozornění, která se na displeji zobrazí před efekty ve videomappingu."
          >
            <div>
              <Prepinac
                id="varovaniBlikaniSvetel"
                zapnuto={form.varovaniBlikaniSvetel}
                onZmena={(v) => uprav({ varovaniBlikaniSvetel: v })}
                popisek="Blikající světla"
              />
              <NaDispleji
                text="varování před blikajícími světly (kvůli citlivosti na záblesky). Zapnuté = varování se zobrazí."
                pole="alert_flashing_lights"
              />
            </div>

            <div>
              <Prepinac
                id="varovaniVodniEfekty"
                zapnuto={form.varovaniVodniEfekty}
                onZmena={(v) => uprav({ varovaniVodniEfekty: v })}
                popisek="Vodní efekty"
              />
              <NaDispleji
                text="varování před vodními efekty (u bouřky se doopravdy rozprašuje voda). Zapnuté = varování se zobrazí."
                pole="alert_water_effects"
              />
            </div>
          </Sekce>

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
            <button className="btn-primary" onClick={uloz} disabled={uklada || !zmeneno}>
              {uklada && <Loader2 className="h-4 w-4 animate-spin" />}
              Uložit nastavení
            </button>
            {zmeneno && (
              <button
                className="btn-ghost"
                onClick={() => {
                  setForm(ulozene);
                  setUkazChyby(false);
                }}
                disabled={uklada}
              >
                Zahodit změny
              </button>
            )}
            <span className="text-xs text-fg-muted">
              {zmeneno
                ? "Máte neuložené změny. Displeje zatím jedou na tom, co je vpravo."
                : "Uloženo. Displej má stejné hodnoty jako náhled vpravo."}
            </span>
          </div>
        </div>

        {/* --- Co endpoint posílá teď --- */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl border border-line shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3.5">
              <div>
                <div className="kicker">Co teď posílá</div>
                <div className="mt-0.5 font-mono text-xs text-fg-muted">GET /api/prales</div>
              </div>
              <button
                onClick={() => void nacti(false)}
                className="rounded-md p-1.5 text-fg-dim transition-colors hover:bg-canvas hover:text-fg"
                title="Obnovit hned"
                aria-label="Obnovit hned"
              >
                <RefreshCw className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="space-y-3 px-5 py-4">
              <div>
                <div className="kicker">Do bouřky</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-display text-3xl font-bold tabular-nums text-fg">
                    {odpocet > 0 ? odpocetCs(odpocet) : "vypnuto"}
                  </span>
                  {odpocet > 0 && (
                    <span className="text-xs text-fg-muted tnum">v {casZa(odpocet)}</span>
                  )}
                </div>
              </div>

              <pre className="overflow-x-auto rounded-lg bg-canvas p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
                {JSON.stringify(
                  { ...stav.nahled, countdown_seconds: odpocet },
                  null,
                  2,
                )}
              </pre>

              <p className="text-[11px] leading-relaxed text-fg-dim">
                Obnovuje se každých pět sekund, stejně jako se ptají tablety. Ukazuje{" "}
                <span className="font-semibold">uložený</span> stav, ne rozepsané změny ve
                formuláři.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// Ukázka rastru od půlnoci pro zadaný interval ("0:15, 0:30, 0:45"). Kurátor
// tak vidí, na jaké časy bouřky opravdu padnou, než to uloží.
function rastrPriklad(intervalRaw: string): string {
  const interval = Number(intervalRaw.trim());
  if (!Number.isInteger(interval) || interval < 1 || interval > PRALES_INTERVAL_MAX) return "…";
  const casy: string[] = [];
  for (let i = 1; i <= 3 && interval * i < 24 * 60; i++) {
    const minut = interval * i;
    casy.push(`${Math.floor(minut / 60)}:${String(minut % 60).padStart(2, "0")}`);
  }
  return casy.length > 0 ? casy.join(", ") : "…";
}
