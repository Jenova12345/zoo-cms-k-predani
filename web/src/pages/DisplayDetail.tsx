import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Crop,
  ArrowLeft,
  CheckCircle2,
  Save,
  Send,
  Sparkles,
  UploadCloud,
  Loader2,
  Monitor,
  ImageIcon,
  Box,
  Lightbulb,
  Info,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Film,
  AlertTriangle,
  AlignLeft,
  GripVertical,
  Map,
  X,
} from "lucide-react";
import { api, formatDateTime, nazevSouboru } from "../lib/api";
import { NAHRAVANI_MAX_B, NAHRAVANI_MAX_MB, vMB } from "../lib/limity";
import { canonicalizeLatin } from "../lib/latin";
import { VyrezDialog } from "../components/VyrezDialog";
import { VyrezSekvenceDialog } from "../components/VyrezSekvenceDialog";
import {
  INFO_POLE,
  type InfoPoleDef,
  pomerNaCislo,
  type Vyrez,
  NEPRIRAZENO,
  JAZYKY,
  JAZYK_LABEL,
  SEKCE_TEMATA,
  najdiSekci,
  jePrekladane,
  type Jazyk,
  SLIDE_TYPY,
  SLIDE_TYP_LABEL,
  SLIDE_TYP_POPIS,
  TAXONOMIE_POLE,
  TAXONOMIE_ZBYTEK,
  TEXTOVA_POLE,
  galPrazdny,
  textovyPrazdny,
  type DisplayDetail as Detail,
  type MediaPolozka,
  type SlideContent,
  type SlideTyp,
} from "../lib/types";
import {
  galNeulozeno,
  infoNeulozeno,
  klicGalPole,
  klicPole,
  klicTextovehoPole,
  premapujDotcena,
  premapujDrafty,
  slucGalDrafty,
  slucInfoDrafty,
  slucText,
  slucTextoveDrafty,
  textovyNeulozeno,
  textZmeneno,
  zapomen,
  zapomenSlide,
  KLIC_CELED,
  KLIC_KB,
  type Dotcena,
} from "../lib/drafty";
import { KB_METODIKA, zbytkySablony } from "../lib/kbSablona";
import { SEKCE, jePrazdna, rozdelKb, slozKb, type RozdelenaKb } from "../lib/kbSekce";
import { useNeulozeno } from "../lib/neulozeno";
import { useToast } from "../components/Toast";
import Confirm from "../components/Confirm";

// Ovládání fotky (smazat, označit jako mapu). Schválně je vidět pořád:
// schované pod hoverem ho kurátorka nenajde, na dotykovém displeji se k němu
// nedostane vůbec a terč 24 px se špatně trefuje. Tady je 36 px, s popiskem
// pro odečítač obrazovky a viditelným rámečkem při průchodu klávesnicí.
const OVLADANI_LISTA =
  "absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/60 px-1.5 py-1.5";
const OVLADANI_TLACITKO =
  "grid h-9 w-9 place-items-center rounded text-white transition hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40";
const OVLADANI_SMAZAT = `${OVLADANI_TLACITKO} hover:bg-danger`;

// Sdílené věci se ukládají jednou (do češtiny) a ostatní jazyky je čtou
// odtud. Kurátor tak nenahrává 36 snímků třikrát.
const SDILENE_HLASKA = "Společné pro všechny jazyky, nahrává se jednou.";

const TYP_IKONA: Record<SlideTyp, typeof Info> = {
  info: Info,
  ai: Sparkles,
  "3d": Box,
  vid: ImageIcon, // _vid = galerie fotek i videí (ne jen video)
  gal: AlignLeft, // _gal = textový slide (dva texty + taxonomie + fotka)
  txt: Lightbulb, // _txt = pozůstalé obecné informace (dva texty, bez médií)
};

// Záložka "kb" = znalostní báze (kb.md v kořeni displeje), mimo slidy.
type ActiveTab = number | "kb";

// Displej bez slidů: žádné číslo slidu neexistuje, tak držíme 0 a vykreslí se
// prázdný stav s výzvou přidat první panel. (Dřív se skákalo na znalostní bázi,
// takže kurátor na prázdném displeji vůbec nepoznal, že má začít Infopanelem.)
const ZADNY_SLIDE = 0;

// Slide, do kterého kurátor ještě nic nevyplnil. Podle toho se ukáže výzva
// „co teď" a v záložce oranžová tečka, po přidání slidu je totiž snadné
// odejít v domnění, že přidáním je hotovo.
function jePrazdny(s: SlideContent): boolean {
  switch (s.typ) {
    case "info":
      return !(s.pole.Nazev ?? "").trim() && s.obrazky.length === 0 && !s.mapa && !s.video;
    case "gal":
      // Taxonomie se nepočítá: je nepovinná a slide jen s ní by na tabletu
      // zůstal skoro prázdný.
      return galPrazdny(s.pole) && s.obrazky.length === 0;
    case "3d":
      return s.obrazky.length === 0;
    case "vid":
      return s.media.length === 0;
    case "txt":
      // Obecné informace jsou prázdné, dokud není vyplněný aspoň jeden
      // z obou textů. Média tenhle typ nemá.
      return textovyPrazdny(s.pole);
    default:
      return false; // AI slide se nevyplňuje, prázdná složka je správný stav
  }
}

// JAK SE OBSAH DOSTANE NA TABLET (a proč o tom texty mluví takhle):
// Unity klient si obsah načte SÁM ze sdílené složky, po chvíli nečinnosti,
// když displej přepne na spořič. Na žádný povel z CMS nečeká; endpoint
// /refresh je mock, který jen zapíše řádek do auditu. Texty proto nesmí
// slibovat „odeslání" ani „zveřejnění na povel", uložený obsah se na tablet
// dostane tak jako tak.
const VYZVEDNE_SI_SAM =
  "Tablet si uložený obsah vyzvedne sám ze sdílené složky, obvykle do minuty, jakmile u něj nikdo nestojí a přepne se na spořič.";

// Co má kurátor s prázdným slidem udělat. Formulace odpovídá tomu, jak se
// obsah daného typu ukládá: fotky a video hned při nahrání, texty tlačítkem.
const PRAZDNY_NAVOD: Record<SlideTyp, string> = {
  info: "Vyplňte Sekci a Název, nahrajte fotku a uložte. Než slide uložíte, nemá tablet co zobrazit.",
  gal: "Napište oba texty, doplňte zařazení druhu, přidejte fotku a uložte. Stačí vyplnit aspoň jedno z obou textových polí.",
  "3d": "Nahrajte sekvenci snímků modelu. Ukládají se hned po nahrání a tablet si je pak vyzvedne sám.",
  vid: "Nahrajte fotky a videa do galerie. Ukládají se hned po nahrání a tablet si je pak vyzvedne sám.",
  txt: "Napište obecný text o druhu, doplňte zajímavosti a uložte. Stačí vyplnit aspoň jedno z obou polí.",
  ai: "",
};

// Co ve slidu je, do potvrzení mazání, ať kurátor vidí, o co přijde.
function obsahSlidu(s: SlideContent): string[] {
  const kusy: string[] = [];
  if (s.obrazky.length) {
    kusy.push(s.typ === "3d" ? pocetSnimku(s.obrazky.length) : pocetFotek(s.obrazky.length));
  }
  if (s.media.length) {
    const fotek = s.media.filter((m) => m.typ === "foto").length;
    const videi = s.media.length - fotek;
    if (fotek) kusy.push(pocetFotek(fotek));
    if (videi) kusy.push(videi === 1 ? "video" : `${videi} videí`);
  }
  if (s.mapa) kusy.push("mapa výskytu");
  if (s.video) kusy.push("video");
  if (s.typ === "info" && Object.values(s.pole).some((v) => v.trim())) {
    kusy.push("vyplněné údaje o druhu");
  }
  if (s.typ === "gal" || s.typ === "txt") {
    for (const def of TEXTOVA_POLE) {
      if ((s.pole[def.klic] ?? "").trim()) kusy.push(def.label.toLowerCase());
    }
  }
  if (s.typ === "gal" && TAXONOMIE_POLE.some((def) => (s.pole[def.klic] ?? "").trim())) {
    kusy.push("zařazení druhu");
  }
  return kusy;
}

function pocetFotek(n: number): string {
  if (n === 1) return "1 fotka";
  if (n >= 2 && n <= 4) return `${n} fotky`;
  return `${n} fotek`;
}

// Aktuální čas pro potvrzení „Uloženo v HH:MM".
function ted(): string {
  return new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
}

export default function DisplayDetail() {
  const { id = "" } = useParams();
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveTab>(1);
  const [infoDrafts, setInfoDrafts] = useState<Record<number, Record<string, string>>>({});
  // Textový slide (_gal): víc polí na slide (dva texty a tři části
  // taxonomie), stejný tvar jako info panel. Drží je rodič, jako lokální
  // stav editoru se ztrácely při přepnutí záložky.
  const [galDrafts, setGalDrafts] = useState<Record<number, Record<string, string>>>({});
  // Obecné informace (_txt): dvě pole na slide, stejný tvar jako info panel.
  const [txtDrafts, setTxtDrafts] = useState<Record<number, Record<string, string>>>({});
  const [kbDraft, setKbDraft] = useState("");
  const [sectionDraft, setSectionDraft] = useState(""); // meta.section (čeleď), na úrovni displeje
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [smazatOpen, setSmazatOpen] = useState(false);
  // Zveřejnění na tabletu se ptá jedním společným dialogem: co se zveřejní
  // (popis) a co se po potvrzení spustí (akce).
  const [zverejnit, setZverejnit] = useState<{
    popis: ReactNode;
    akce: () => Promise<void>;
  } | null>(null);
  // Zpětná vazba „uloženo" přímo u tlačítka, toast může kurátorovi utéct,
  // tohle zůstane na obrazovce, dokud nepřepne slide.
  const [ulozeno, setUlozeno] = useState<{ klic: string; cas: string } | null>(null);
  // Přetahování záložek: index taženého slidu a místo, kam se pustí
  // (0.počet, tedy „před i-tý" a nakonec „na konec").
  const [taham, setTaham] = useState<number | null>(null);
  const [pustimNa, setPustimNa] = useState<number | null>(null);
  // Klíče polí, do kterých kurátor sáhl. Podle nich se pozná, co je jeho
  // rozepsaná verze (přenačtení ji nesmí přepsat) a co je neuložené.
  const [dotcena, setDotcena] = useState<Dotcena>(() => new Set());
  const [odchodOpen, setOdchodOpen] = useState(false);
  const [revizeOpen, setRevizeOpen] = useState(false);
  const [jazyk, setJazyk] = useState<Jazyk>("cs");
  // Čeština jako reference při překládání (načte se, jen když je potřeba).
  const [referenceCs, setReferenceCs] = useState<Detail | null>(null);
  const [prepinam, setPrepinam] = useState(false);
  // Jazyky, ve kterých kurátor něco rozepsal a přepnul jinam. Musí se
  // počítat do „neuložených změn", jinak by o ně při odchodu tiše přišel.
  const [neulozeneJazyky, setNeulozeneJazyky] = useState<Jazyk[]>([]);
  const navigate = useNavigate();
  const { nastavNeulozeno } = useNeulozeno();

  // load() a další callbacky by ze stavu četly zastaralou hodnotu, proto
  // zrcadlo v ref (přepisuje se při každém renderu).
  const dotcenaRef = useRef(dotcena);
  dotcenaRef.current = dotcena;
  const jazykRef = useRef(jazyk);
  jazykRef.current = jazyk;

  // Rozepsané změny odložené při přepnutí jazyka. Bez toho by kurátor
  // přechodem na EN přišel o rozdělanou češtinu.
  const zasoba = useRef<
    Partial<
      Record<
        Jazyk,
        {
          infoDrafts: Record<number, Record<string, string>>;
          galDrafts: Record<number, Record<string, string>>;
          txtDrafts: Record<number, Record<string, string>>;
          kbDraft: string;
          sectionDraft: string;
          dotcena: Dotcena;
        }
      >
    >
  >({});

  function oznacDotcene(klic: string) {
    setDotcena((prev) => (prev.has(klic) ? prev : new Set(prev).add(klic)));
  }

  // Po uložení rozepsaná verze odpovídá disku, značky zahodíme hned (i v ref,
  // ať následné load() vezme serverovou podobu, třeba kanonizovanou latinu).
  function ulozeneZahod(uprav: (d: Dotcena) => Dotcena) {
    const nove = uprav(dotcenaRef.current);
    dotcenaRef.current = nove;
    setDotcena(nove);
  }

  // `rezim` říká, co se stane s rozepsaným obsahem:
  //   "slouc": ze serveru se propíšou jen pole, kterých se kurátor
  //                  nedotkl (po uložení a po změně struktury slidů),
  //   "nechDrafty": drafty se nesahá vůbec (nahrání a mazání fotek, videa,
  //                  označení mapy, tam kurátor rozepsaný formulář typicky má).
  const load = useCallback(
    async (rezim: "slouc" | "nechDrafty" = "slouc") => {
      try {
        const d = await api.display(id, jazykRef.current);
        setDetail(d);
        if (rezim === "slouc") {
          const dot = dotcenaRef.current;
          setInfoDrafts((prev) => slucInfoDrafty(prev, d.slides, dot));
          setGalDrafts((prev) => slucGalDrafty(prev, d.slides, dot));
          setTxtDrafts((prev) => slucTextoveDrafty(prev, d.slides, dot));
          setKbDraft((prev) => slucText(prev, d.kb, KLIC_KB, dot));
          setSectionDraft((prev) => slucText(prev, d.meta.section ?? "", KLIC_CELED, dot));
        }
        // Pokud aktivní slide po změně struktury zmizel, vrátíme se na první.
        setActive((cur) =>
          cur === "kb" || d.slides.some((s) => s.n === cur) ? cur : d.slides[0]?.n ?? ZADNY_SLIDE,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Načtení selhalo.");
      }
    },
    [id],
  );

  // Přenačtení obsahu po práci se soubory: rozepsaný formulář zůstává.
  const reloadObsah = useCallback(() => load("nechDrafty"), [load]);

  // Přepnutí jazyka: rozepsané změny se odloží stranou a při návratu se
  // vrátí. Na disk se nic nezapisuje, dokud kurátor neklikne na Uložit.
  async function prepniJazyk(cil: Jazyk) {
    if (cil === jazykRef.current || prepinam) return;
    const odkud = jazykRef.current;
    zasoba.current[odkud] = {
      infoDrafts,
      galDrafts,
      txtDrafts,
      kbDraft,
      sectionDraft,
      dotcena: dotcenaRef.current,
    };
    setNeulozeneJazyky((prev) => {
      const bez = prev.filter((j) => j !== odkud && j !== cil);
      return neulozenoCokoliv ? [...bez, odkud] : bez;
    });
    setPrepinam(true);
    try {
      const d = await api.display(id, cil);
      jazykRef.current = cil;
      setJazyk(cil);
      setDetail(d);
      setUlozeno(null);

      const odlozene = zasoba.current[cil];
      if (odlozene) {
        setInfoDrafts(odlozene.infoDrafts);
        setGalDrafts(odlozene.galDrafts);
        setTxtDrafts(odlozene.txtDrafts);
        setKbDraft(odlozene.kbDraft);
        setSectionDraft(odlozene.sectionDraft);
        dotcenaRef.current = odlozene.dotcena;
        setDotcena(odlozene.dotcena);
      } else {
        const prazdna: Dotcena = new Set();
        dotcenaRef.current = prazdna;
        setDotcena(prazdna);
        setInfoDrafts(slucInfoDrafty({}, d.slides, prazdna));
        setGalDrafts(slucGalDrafty({}, d.slides, prazdna));
        setTxtDrafts(slucTextoveDrafty({}, d.slides, prazdna));
        setKbDraft(d.kb);
        setSectionDraft(d.meta.section ?? "");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Přepnutí jazyka selhalo.");
    } finally {
      setPrepinam(false);
    }
  }

  // Čeština jako podklad pro překlad. Načte se jednou při prvním přepnutí.
  useEffect(() => {
    if (jazyk === "cs" || referenceCs) return;
    let platne = true;
    api
      .display(id, "cs")
      .then((d) => platne && setReferenceCs(d))
      .catch(() => undefined);
    return () => {
      platne = false;
    };
  }, [jazyk, referenceCs, id]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Neuložené změny ---------------------------------------------------
  // Neuložené je jen to, čeho se kurátor dotkl a co se zároveň liší od disku.
  const celedNeulozena =
    dotcena.has(KLIC_CELED) && sectionDraft.trim() !== (detail?.meta.section ?? "").trim();
  const kbNeulozena = dotcena.has(KLIC_KB) && textZmeneno(kbDraft, detail?.kb ?? "");

  function slideNeulozen(s: SlideContent): boolean {
    if (s.typ === "info") {
      return infoNeulozeno(s.n, infoDrafts[s.n], s.pole, dotcena) || celedNeulozena;
    }
    if (s.typ === "gal") {
      return galNeulozeno(s.n, galDrafts[s.n], s.pole, dotcena);
    }
    if (s.typ === "txt") {
      return textovyNeulozeno(s.n, txtDrafts[s.n], s.pole, dotcena);
    }
    return false;
  }

  const neulozenoCokoliv =
    !!detail && (detail.slides.some(slideNeulozen) || kbNeulozena);

  // Rozepsané je i to, co čeká odložené v jiném jazyce.
  const neulozenoVJazycich = neulozenoCokoliv
    ? [jazyk, ...neulozeneJazyky.filter((j) => j !== jazyk)]
    : neulozeneJazyky;
  const neulozenoKdekoliv = neulozenoVJazycich.length > 0;

  // Levý navigační panel se na neuložené změny ptá sám (odchod přes menu
  // nebo Odhlásit beforeunload nezachytí, uvnitř SPA se nespouští).
  useEffect(() => {
    nastavNeulozeno(neulozenoKdekoliv);
    return () => nastavNeulozeno(false);
  }, [neulozenoKdekoliv, nastavNeulozeno]);

  // Zavření okna nebo záložky s rozepsanými změnami: zeptá se prohlížeč sám.
  useEffect(() => {
    if (!neulozenoKdekoliv) return;
    function varuj(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", varuj);
    return () => window.removeEventListener("beforeunload", varuj);
  }, [neulozenoKdekoliv]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/displeje" className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg">
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} /> Zpět na displeje
        </Link>
        <div className="text-sm text-danger">{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="grid place-items-center py-20 text-fg-dim">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const slide = active === "kb" ? null : detail.slides.find((s) => s.n === active) ?? null;
  const prirazeno = detail.meta.druh !== NEPRIRAZENO;
  const pozice = slide ? detail.slides.findIndex((s) => s.n === slide.n) : -1;

  async function withBusy(fn: () => Promise<void>, fail: string) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : fail);
    } finally {
      setBusy(false);
    }
  }

  async function saveKb() {
    setSaving(true);
    try {
      await api.saveKb(id, kbDraft, jazyk);
      ulozeneZahod((d) => zapomen(d, KLIC_KB));
      await load();
      oznacUlozeno();
      toast.success("Znalostní báze uložena. Načte si ji chatbot, na tablet se neposílá.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uložení selhalo.");
    } finally {
      setSaving(false);
    }
  }

  // Potvrzení „uloženo" u tlačítka aktivní záložky.
  function oznacUlozeno() {
    setUlozeno({ klic: String(active), cas: ted() });
    setNeulozeneJazyky((prev) => prev.filter((j) => j !== jazykRef.current));
  }

  // Zveřejnění na tabletu vidí návštěvníci u expozice, proto se na něj vždycky
  // ptáme. Editory sem posílají popis toho, co se zveřejní, a vlastní akci.
  function zeptejSeNaZverejneni(popis: ReactNode, akce: () => Promise<void>) {
    setZverejnit({ popis, akce });
  }

  // Uloží pole info panelu (text.txt + identita do meta.json). `odeslat`
  // rozhoduje, jestli se obsah jen zapíše na disk, nebo se rovnou zveřejní
  // na tabletu. Latinské jméno server očistí na kanonický tvar.
  async function saveInfo(n: number, pole: Record<string, string>, odeslat: boolean) {
    setSaving(true);
    try {
      const res = await api.saveInfo(id, n, pole, sectionDraft, jazyk);
      if (odeslat) await api.refresh(id);
      // Uloženo = rozepsaná verze odpovídá disku. Značky pryč ještě před
      // přenačtením, ať se ve formuláři objeví serverová podoba (kanonizovaná
      // latina) místo toho, co kurátor napsal.
      ulozeneZahod((d) => zapomen(zapomenSlide(d, n), KLIC_CELED));
      await load();
      oznacUlozeno();
      const zaklad = odeslat
        ? `Uloženo a zapsáno jako hotové (displej ${id}). Tablet si obsah vyzvedne sám.`
        : "Uloženo. Tablet si změnu vyzvedne sám, obvykle do minuty.";
      if (res.latinCorrected && res.latin) {
        toast.success(`${zaklad} Latinské jméno upraveno na kanonický tvar: ${res.latin}`);
      } else {
        toast.success(zaklad);
      }
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : odeslat
            ? "Uložení nebo zápis do auditu selhal."
            : "Uložení selhalo.",
      );
    } finally {
      setSaving(false);
    }
  }

  // Slidy, jejichž obsah se ukládá hned při nahrání (3D, video): tlačítko
  // nic nikam netlačí, jen zapíše do auditu, že je kurátor s obsahem hotový.
  async function sendToDisplay() {
    await withBusy(async () => {
      await api.refresh(id);
      oznacUlozeno();
      toast.success(`Zapsáno jako hotové (displej ${id}). Tablet si obsah vyzvedne sám.`);
    }, "Zápis do auditu selhal.");
  }

  // Vědomé schválení AI textů. Nezapisuje obsah, jen ruší značku „čeká na
  // revizi" a nechá v auditu záznam, kdo za texty ručí.
  async function potvrditRevizi() {
    setRevizeOpen(false);
    await withBusy(async () => {
      await api.potvrditRevizi(id);
      await load();
      toast.success("Schváleno. Do auditu se zapsalo vaše jméno a čas.");
    }, "Potvrzení revize selhalo.");
  }

  async function addSlide(typ: SlideTyp) {
    setAddOpen(false);
    await withBusy(async () => {
      const { n } = await api.addSlide(id, typ);
      await load();
      setActive(n);
      toast.success(`Slide ${SLIDE_TYP_LABEL[typ]} přidán, teď vyplňte obsah a uložte.`);
    }, "Přidání slidu selhalo.");
  }

  async function removeSlide() {
    if (!slide) return;
    setSmazatOpen(false);
    await withBusy(async () => {
      await api.deleteSlide(id, slide.n);
      await load();
      toast.success("Slide smazán");
    }, "Smazání slidu selhalo.");
  }

  // Uloží nové pořadí (server přečísluje prefixy složek na disku) a zůstane na
  // přesunutém slidu, který má po přečíslování jiné číslo. Používají to šipky
  // i přetahování záložek.
  async function ulozPoradi(poradi: number[], indexPoZmene: number) {
    await withBusy(async () => {
      await api.reorderSlides(id, poradi);
      // Server slidy přečísluje, takže se rozepsaný obsah musí přestěhovat
      // s nimi, jinak by text patřil cizímu slidu.
      const preskladana = premapujDotcena(dotcenaRef.current, poradi);
      dotcenaRef.current = preskladana;
      setDotcena(preskladana);
      const d = await api.display(id);
      setDetail(d);
      setInfoDrafts((prev) => slucInfoDrafty(premapujDrafty(prev, poradi), d.slides, preskladana));
      setGalDrafts((prev) => slucGalDrafty(premapujDrafty(prev, poradi), d.slides, preskladana));
      setTxtDrafts((prev) => slucTextoveDrafty(premapujDrafty(prev, poradi), d.slides, preskladana));
      setKbDraft((prev) => slucText(prev, d.kb, KLIC_KB, preskladana));
      setSectionDraft((prev) => slucText(prev, d.meta.section ?? "", KLIC_CELED, preskladana));
      setActive(d.slides[indexPoZmene]?.n ?? d.slides[0]?.n ?? ZADNY_SLIDE);
    }, "Změna pořadí selhala.");
  }

  // Prohodí slide se sousedem (šipky v liště slidu).
  async function moveSlide(dir: -1 | 1) {
    if (!slide) return;
    const order = detail!.slides.map((s) => s.n);
    const j = pozice + dir;
    if (j < 0 || j >= order.length) return;
    [order[pozice], order[j]] = [order[j], order[pozice]];
    await ulozPoradi(order, j);
  }

  // Přetažení záložky: `zIndexu` se vloží na pozici `naIndex` (0.počet).
  async function pustSlide(zIndexu: number, naIndex: number) {
    setTaham(null);
    setPustimNa(null);
    // Puštění na vlastní místo (před sebe i za sebe) nic nemění.
    if (naIndex === zIndexu || naIndex === zIndexu + 1) return;
    const order = detail!.slides.map((s) => s.n);
    const [presouvany] = order.splice(zIndexu, 1);
    const cil = naIndex > zIndexu ? naIndex - 1 : naIndex;
    order.splice(cil, 0, presouvany);
    await ulozPoradi(order, cil);
  }

  return (
    <div className="space-y-8">
      {/* Hlavička */}
      <div className="border-b border-line pb-6">
        <Link
          to="/displeje"
          onClick={(e) => {
            // Odchod ze stránky je jediné místo, kde se rozepsané změny
            // ztratí, přepínání záložek slidů si je drží.
            if (!neulozenoKdekoliv) return;
            e.preventDefault();
            setOdchodOpen(true);
          }}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} /> Displeje
        </Link>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-2xl font-bold text-fg-dim tnum">
              {detail.id.padStart(2, "0")}
            </span>
            <h1 className={`font-display text-3xl font-bold tracking-tight ${prirazeno ? "text-fg" : "text-fg-dim italic"}`}>
              {detail.meta.druh}
            </h1>
            <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
              <span className={detail.meta.stav === "online" ? "dot-online" : "dot-offline"} />
              {detail.meta.stav}
            </span>
          </div>
          <Link to={`/tablet/${id}`} target="_blank" className="btn-ghost">
            <Monitor className="h-4 w-4" strokeWidth={1.75} /> Náhled tabletu
          </Link>
        </div>
        <p className="mt-2 text-xs text-fg-muted tnum">
          Poslední změna: {formatDateTime(detail.meta.posledniZmena)}
        </p>
      </div>

      {/* Obsah přišel z hromadného importu a je od AI, dokud ho kurátor
          neprojde, má to vědět hned po otevření displeje. */}
      {detail.meta.cekaNaRevizi && (
        <div className="-mt-3 flex flex-wrap items-start justify-between gap-4 rounded-lg border border-amber/40 bg-amber-soft px-4 py-3">
          <div className="flex items-start gap-2.5">
            <Sparkles className="h-5 w-5 shrink-0 text-amber" strokeWidth={1.75} />
            <div className="max-w-2xl text-sm text-fg-muted">
              <span className="font-semibold text-fg">
                Texty jsou od AI a čekají na vaši revizi.
              </span>{" "}
              Přišly hromadným importem. Projděte je (hlavně znalostní bázi, ze které chatbot
              odpovídá návštěvníkům), opravte, co nesedí, a teprve pak schvalte. Samotné uložení
              textu za schválení nepovažujeme.
            </div>
          </div>
          <button onClick={() => setRevizeOpen(true)} disabled={busy} className="btn-amber shrink-0">
            <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} /> Zkontrolováno, schvaluji
          </button>
        </div>
      )}

      {/* Displej má slidy, ale ještě nemá druh, kurátor má vědět, co dodělat. */}
      {!prirazeno && detail.slides.length > 0 && (
        <div className="-mt-3 flex items-start gap-2.5 border-l-2 border-amber pl-4 py-1">
          <Info className="h-5 w-5 text-amber shrink-0 mt-0.5" strokeWidth={1.75} />
          <div className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">Displej ještě nemá přiřazený druh.</span>{" "}
            {detail.slides.some((s) => s.typ === "info")
              ? "Vyplňte Sekci a Název v Infopanelu a uložte. Název se pak objeví i v seznamu displejů."
              : "Přidejte slide Infopanel a vyplňte v něm Sekci a Název. Název se pak objeví i v seznamu displejů."}
          </div>
        </div>
      )}

      {/* Jazyk. U každého je vidět, kolik položek v něm ještě chybí. */}
      <div className="flex flex-wrap items-center gap-5">
        <span className="kicker">Jazyk</span>
        <div className="flex flex-wrap items-center gap-4">
          {JAZYKY.map((kod) => {
            const stav = detail.jazyky?.find((j) => j.jazyk === kod);
            const aktivni = kod === jazyk;
            return (
              <button
                key={kod}
                onClick={() => prepniJazyk(kod)}
                disabled={prepinam}
                className={`flex items-center gap-1.5 text-sm font-semibold transition border-b-2 pb-0.5 disabled:opacity-60 ${
                  aktivni
                    ? "text-accent border-accent"
                    : "text-fg-muted border-transparent hover:text-fg"
                }`}
              >
                {JAZYK_LABEL[kod]}
                {stav && (
                  <span
                    className={`text-[10px] font-medium ${
                      stav.hotovo ? "text-accent" : "text-amber-deep"
                    }`}
                  >
                    {stav.hotovo ? "hotovo" : `chybí ${stav.chybi}`}
                  </span>
                )}
              </button>
            );
          })}
          {prepinam && <Loader2 className="h-4 w-4 animate-spin text-fg-muted" />}
        </div>
        {jazyk !== "cs" && (
          <span className="text-xs text-fg-muted">
            Fotky, video, 3D snímky, mapa, latinský název a čeleď se berou z češtiny.
          </span>
        )}
      </div>

      {/* Záložky: slidy podle složek na disku + znalostní báze + přidání slidu.
          Záložku slidu lze chytit myší a přetáhnout na jinou pozici; svislá
          zelená čárka ukazuje, kam se pustí. Šipky v liště níž dělají totéž. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line">
        {detail.slides.map((s, i) => {
          const isActive = active === s.n;
          const Ikona = TYP_IKONA[s.typ];
          const tahano = taham === i;
          return (
            <div
              key={s.n}
              className="relative flex items-center"
              onDragOver={(e) => {
                if (taham === null) return;
                e.preventDefault();
                // Před záložku, nebo za ni? Podle toho, kde je kurzor v její šířce.
                const r = e.currentTarget.getBoundingClientRect();
                setPustimNa(e.clientX < r.left + r.width / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (taham !== null && pustimNa !== null) void pustSlide(taham, pustimNa);
              }}
            >
              {/* Ukazatel místa vpuštění (v mezeře mezi záložkami) */}
              {taham !== null && pustimNa === i && (
                <span className="absolute -left-3 top-0 bottom-2.5 w-0.5 rounded-full bg-accent" />
              )}
              {taham !== null && pustimNa === i + 1 && i === detail.slides.length - 1 && (
                <span className="absolute -right-3 top-0 bottom-2.5 w-0.5 rounded-full bg-accent" />
              )}
              <button
                draggable={!busy && detail.slides.length > 1}
                onDragStart={(e) => {
                  setTaham(i);
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox táhne jen s vyplněnými daty.
                  e.dataTransfer.setData("text/plain", String(s.n));
                }}
                onDragEnd={() => {
                  setTaham(null);
                  setPustimNa(null);
                }}
                onClick={() => setActive(s.n)}
                title={
                  detail.slides.length > 1
                    ? "Přetáhněte pro změnu pořadí"
                    : SLIDE_TYP_LABEL[s.typ]
                }
                className={`-mb-px pb-3 border-b-2 text-sm font-semibold transition flex items-center gap-1.5 ${
                  detail.slides.length > 1 ? "cursor-grab active:cursor-grabbing" : ""
                } ${tahano ? "opacity-40" : ""} ${
                  isActive ? "text-accent border-accent" : "text-fg-muted border-transparent hover:text-fg"
                }`}
              >
                <Ikona className="h-3.5 w-3.5" strokeWidth={1.75} />
                {i + 1} · {SLIDE_TYP_LABEL[s.typ]}
                {jePrazdny(s) && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-amber"
                    title="Prázdný slide, chybí obsah"
                  />
                )}
                {slideNeulozen(s) && (
                  <span
                    className="h-2 w-2 rounded-full border-2 border-accent"
                    title="Neuložené změny"
                  />
                )}
              </button>
            </div>
          );
        })}
        <div className="relative">
          <button
            onClick={() => setAddOpen((o) => !o)}
            disabled={busy}
            className="-mb-px pb-3 border-b-2 border-transparent text-sm font-semibold text-fg-muted hover:text-accent transition flex items-center gap-1.5 disabled:opacity-50"
            title="Přidat nový slide"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} /> Přidat slide
          </button>
          {addOpen && (
            <>
              {/* Klik mimo nabídku ji zavře. */}
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-xl border border-line bg-surface p-1.5 shadow-cardHover">
                <p className="px-3 pt-1.5 pb-2 text-[11px] text-fg-muted">
                  Nový slide se zařadí k ostatním stejného typu. Pořadí pak můžete změnit
                  přetažením.
                </p>
                {SLIDE_TYPY.map((typ) => {
                  const Ikona = TYP_IKONA[typ];
                  return (
                    <button
                      key={typ}
                      onClick={() => addSlide(typ)}
                      className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-canvas transition group/typ"
                    >
                      <Ikona
                        className="h-4 w-4 mt-0.5 shrink-0 text-fg-dim group-hover/typ:text-accent transition"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-fg">
                          {SLIDE_TYP_LABEL[typ]}
                        </span>
                        <span className="block text-xs text-fg-muted">{SLIDE_TYP_POPIS[typ]}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => setActive("kb")}
          className={`-mb-px pb-3 border-b-2 text-sm font-semibold transition flex items-center gap-1.5 ml-auto ${
            active === "kb" ? "text-amber-deep border-amber" : "text-fg-muted border-transparent hover:text-fg"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
          Znalostní báze (AI)
        </button>
      </div>

      {detail.slides.length > 1 && (
        <p className="-mt-6 flex items-center gap-1.5 text-[11px] text-fg-muted">
          <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
          Přetáhněte pro změnu pořadí, nebo použijte šipky vpravo.
        </p>
      )}

      {/* Lišta správy aktivního slidu: pořadí a odebrání */}
      {slide && (
        <div className="-mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-fg-muted tnum">
            Slide {pozice + 1} z {detail.slides.length} · {SLIDE_TYP_LABEL[slide.typ]} · složka{" "}
            {slide.slozka}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => moveSlide(-1)}
              disabled={busy || pozice === 0}
              className="btn-ghost px-2.5 py-1.5"
              title="Posunout slide doleva"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              onClick={() => moveSlide(1)}
              disabled={busy || pozice === detail.slides.length - 1}
              className="btn-ghost px-2.5 py-1.5"
              title="Posunout slide doprava"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              onClick={() => setSmazatOpen(true)}
              disabled={busy}
              className="btn-ghost px-2.5 py-1.5 text-danger hover:text-danger hover:border-danger/40"
              title="Smazat slide"
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      )}

      {/* Prázdný (typicky právě přidaný) slide: co teď. Bez toho kurátor
          slide přidá a odejde v domnění, že tím je hotovo. */}
      {slide && jePrazdny(slide) && (
        <div className="-mt-4 flex items-start gap-2.5 rounded-lg border border-amber/40 bg-amber-soft px-4 py-3">
          <Lightbulb className="h-5 w-5 shrink-0 text-amber" strokeWidth={1.75} />
          <div className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">Tento slide je zatím prázdný.</span>{" "}
            {PRAZDNY_NAVOD[slide.typ]}
          </div>
        </div>
      )}

      {/* Obsah záložky */}
      {active === "kb" ? (
        <KbEditor
          cekaNaRevizi={detail.meta.cekaNaRevizi === true}
          jazyk={jazyk}
          referenceCs={jazyk === "cs" ? null : referenceCs?.kb ?? null}
          value={kbDraft}
          onChange={(v) => {
            setUlozeno(null);
            oznacDotcene(KLIC_KB);
            setKbDraft(v);
          }}
          onSave={saveKb}
          saving={saving}
          neulozeno={kbNeulozena}
          ulozenoCas={ulozeno?.klic === "kb" ? ulozeno.cas : null}
        />
      ) : !slide ? (
        <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-canvas">
            <Info className="h-6 w-6 text-fg-dim" strokeWidth={1.5} />
          </span>
          <h2 className="mt-4 font-display text-lg font-bold text-fg">
            Tento displej zatím nemá obsah
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-fg-muted">
            Začněte přidáním <strong className="font-semibold text-fg">Infopanelu</strong>: to
            je základní panel s názvem druhu, údaji o něm a fotkami. Každý displej ho má
            právě jeden. Další slidy (Informace, Galerie, 3D model) přidáte kdykoliv potom.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button onClick={() => addSlide("info")} disabled={busy} className="btn-primary">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" strokeWidth={1.75} />
              )}
              Přidat Infopanel
            </button>
            <button onClick={() => setAddOpen(true)} disabled={busy} className="btn-ghost">
              Vybrat jiný typ
            </button>
          </div>
        </div>
      ) : slide.typ === "info" ? (
        <InfoEditor
          key={slide.n}
          slide={slide}
          pole={infoDrafts[slide.n] ?? slide.pole}
          section={sectionDraft}
          onSectionChange={(v) => {
            setUlozeno(null);
            oznacDotcene(KLIC_CELED);
            setSectionDraft(v);
          }}
          onChange={(patch) => {
            // Rozepsaná změna = už to není stav, který se uložil, a pole se
            // stává kurátorovým: přenačtení ho smí přepsat.
            setUlozeno(null);
            for (const klic of Object.keys(patch)) oznacDotcene(klicPole(slide.n, klic));
            setInfoDrafts((prev) => ({
              ...prev,
              [slide.n]: { ...(prev[slide.n] ?? slide.pole), ...patch },
            }));
          }}
          onSave={(pole, odeslat) => saveInfo(slide.n, pole, odeslat)}
          jazyk={jazyk}
          referenceCs={
            jazyk === "cs"
              ? null
              : referenceCs?.slides.find((x) => x.n === slide.n)?.pole ?? null
          }
          zeptejSe={zeptejSeNaZverejneni}
          neulozeno={slideNeulozen(slide)}
          ulozenoCas={ulozeno?.klic === String(slide.n) ? ulozeno.cas : null}
          saving={saving}
          busy={busy}
          displayId={id}
          reload={reloadObsah}
          withBusy={withBusy}
        />
      ) : slide.typ === "gal" ? (
        <TextovyEditor
          key={slide.n}
          slide={slide}
          displayId={id}
          busy={busy}
          reload={reloadObsah}
          withBusy={withBusy}
          zeptejSe={zeptejSeNaZverejneni}
          jazyk={jazyk}
          referenceCs={
            jazyk === "cs"
              ? null
              : referenceCs?.slides.find((x) => x.n === slide.n)?.pole ?? null
          }
          pole={galDrafts[slide.n] ?? slide.pole}
          onZmena={(patch) => {
            setUlozeno(null);
            for (const klic of Object.keys(patch)) oznacDotcene(klicGalPole(slide.n, klic));
            setGalDrafts((prev) => ({
              ...prev,
              [slide.n]: { ...(prev[slide.n] ?? slide.pole), ...patch },
            }));
          }}
          onUlozeno={() => {
            ulozeneZahod((d) => zapomenSlide(d, slide.n));
            oznacUlozeno();
          }}
          neulozeno={slideNeulozen(slide)}
          ulozenoCas={ulozeno?.klic === String(slide.n) ? ulozeno.cas : null}
        />
      ) : slide.typ === "txt" ? (
        <ObecneEditor
          key={slide.n}
          slide={slide}
          displayId={id}
          busy={busy}
          reload={reloadObsah}
          zeptejSe={zeptejSeNaZverejneni}
          jazyk={jazyk}
          referenceCs={
            jazyk === "cs"
              ? null
              : referenceCs?.slides.find((x) => x.n === slide.n)?.pole ?? null
          }
          pole={txtDrafts[slide.n] ?? slide.pole}
          onZmena={(patch) => {
            setUlozeno(null);
            for (const klic of Object.keys(patch)) {
              oznacDotcene(klicTextovehoPole(slide.n, klic));
            }
            setTxtDrafts((prev) => ({
              ...prev,
              [slide.n]: { ...(prev[slide.n] ?? slide.pole), ...patch },
            }));
          }}
          onUlozeno={() => {
            ulozeneZahod((d) => zapomenSlide(d, slide.n));
            oznacUlozeno();
          }}
          neulozeno={slideNeulozen(slide)}
          ulozenoCas={ulozeno?.klic === String(slide.n) ? ulozeno.cas : null}
        />
      ) : slide.typ === "3d" ? (
        <ModelEditor
          key={slide.n}
          slide={slide}
          displayId={id}
          busy={busy}
          reload={reloadObsah}
          withBusy={withBusy}
          onSend={sendToDisplay}
          zeptejSe={zeptejSeNaZverejneni}
        />
      ) : slide.typ === "vid" ? (
        <GalerieEditor
          key={slide.n}
          slide={slide}
          displayId={id}
          busy={busy}
          reload={reloadObsah}
          withBusy={withBusy}
          onSend={sendToDisplay}
          zeptejSe={zeptejSeNaZverejneni}
        />
      ) : (
        <AiSlideInfo onOpenKb={() => setActive("kb")} />
      )}

      {/* Mazání slidu je nevratné, smaže se složka na disku i s obsahem.
          Když ve slidu něco je, vyjmenujeme to a potvrzovací tlačítko se na
          chvíli zamkne, ať se nevratná akce nedá odklepnout překlikem. */}
      <Confirm
        open={smazatOpen && !!slide}
        titulek="Opravdu smazat?"
        prodlevaMs={slide && obsahSlidu(slide).length > 0 ? 3000 : 0}
        text={
          <>
            Tato akce je <strong className="font-semibold text-fg">nevratná</strong> a smaže obsah
            slidu z disku
            {slide && (
              <>
                {" "}
                - slide {pozice + 1} ({SLIDE_TYP_LABEL[slide.typ]}), složka{" "}
                <span className="font-mono">{slide.slozka}</span>
              </>
            )}
            .{" "}
            {slide && obsahSlidu(slide).length > 0 && (
              <>
                Přijdete o:{" "}
                <strong className="font-semibold text-fg">{obsahSlidu(slide).join(", ")}</strong>.{" "}
              </>
            )}
            Fotky, video ani text z tohoto slidu už nepůjde vrátit, ani přes audit log.
          </>
        }
        potvrdit="Smazat slide"
        onPotvrdit={removeSlide}
        onZrusit={() => setSmazatOpen(false)}
      />

      {/* Schválení AI textů: kurátor za ně od téhle chvíle ručí, proto se
          ptáme a proto to jde do auditu na jeho jméno. */}
      <Confirm
        open={revizeOpen}
        varianta="publikovat"
        titulek="Schvalujete texty od AI?"
        text={
          <>
            Potvrzujete, že jste texty tohoto druhu prošli a odpovídají skutečnosti. Platí to
            hlavně pro znalostní bázi, ze které chatbot odpovídá návštěvníkům. Do{" "}
            <strong className="font-semibold text-fg">auditu se zapíše vaše jméno a čas</strong>.
            Značka „čeká na revizi" pak zmizí z přehledu displejů.
          </>
        }
        potvrdit="Schvaluji"
        onPotvrdit={potvrditRevizi}
        onZrusit={() => setRevizeOpen(false)}
      />

      {/* Odchod na seznam displejů s rozepsanými změnami. */}
      <Confirm
        open={odchodOpen}
        titulek="Odejít bez uložení?"
        text={
          <>
            Máte rozepsané změny, které nejsou uložené (
            {neulozenoVJazycich.map((j) => JAZYK_LABEL[j]).join(", ")}). Když teď odejdete na
            seznam displejů, přijdete o ně a vrátit to nepůjde.
          </>
        }
        potvrdit="Odejít bez uložení"
        onPotvrdit={() => {
          setOdchodOpen(false);
          navigate("/displeje");
        }}
        onZrusit={() => setOdchodOpen(false)}
      />

      {/* Zveřejnění na tabletu má následek venku: od té chvíle obsah vidí
          návštěvníci u expozice. Ptáme se na něj stejně jako na mazání. */}
      <Confirm
        open={!!zverejnit}
        varianta="publikovat"
        titulek="Označit obsah jako hotový?"
        text={
          <>
            {zverejnit?.popis} Na tablet se obsah dostane sám, obvykle do minuty od uložení, a to
            i bez tohoto kroku. Tímhle se do auditu zapíše, že je hotový a zkontrolovaný. Pokračovat?
          </>
        }
        potvrdit="Označit jako hotové"
        onPotvrdit={() => {
          const akce = zverejnit?.akce;
          setZverejnit(null);
          if (akce) void akce();
        }}
        onZrusit={() => setZverejnit(null)}
      />
    </div>
  );
}

// --- Sdílené: nápovědy, počítadla, prázdné stavy ---

// Jediný formát videa, který projde. Server ho vynucuje na obou koncích
// (přípona i MIME typ, viz /api/displays/:id/slides/:n/video) a Unity na
// tabletu stejně nic jiného nepřehraje. Hláška je na jednom místě, ať se
// u nahrazení videa a u prázdného pole neliší.
const VIDEO_FORMAT = `Jen MP4 (H.264), do ${NAHRAVANI_MAX_MB} MB. Jiný formát se nenahraje.`;

// Nápověda pod polem: co tam patří a jaký je limit. Vlevo text, vpravo
// počítadlo (když má pole limit), ať kurátor vidí, že přetahuje.
function PodPolem({ hint, pocitadlo }: { hint?: string; pocitadlo?: ReactNode }) {
  if (!hint && !pocitadlo) return null;
  return (
    <div className="mt-1 flex items-start justify-between gap-3">
      {hint ? <p className="text-xs text-fg-muted">{hint}</p> : <span />}
      {pocitadlo && <div className="shrink-0 text-xs tnum">{pocitadlo}</div>}
    </div>
  );
}

// Počítadlo délky. Dvě chování podle toho, co limit znamená:
//   tvrdy      počet znaků na info panelu — přes limit se neuloží, proto
//              červeně (stejná barva jako chybová hláška pod polem);
//   doporučení počet slov u dlouhých textů — na tabletu se text ořízne, ale
//              uložit jde, proto jen oranžové upozornění.
function Pocitadlo({
  kolik,
  limit,
  jednotka,
  tvrdy = false,
}: {
  kolik: number;
  limit: number;
  jednotka: "znaků" | "slov";
  tvrdy?: boolean;
}) {
  const pres = kolik > limit;
  const barva = !pres ? "text-fg-muted" : tvrdy ? "text-danger font-semibold" : "text-amber-deep font-semibold";
  return (
    <span className={barva}>
      {kolik} / {limit} {jednotka}
      {pres && (tvrdy ? ` · o ${kolik - limit} přes limit` : " · na tabletu se může zkrátit")}
    </span>
  );
}

// Český originál jako podklad k překladu. Ukazuje se jen u prázdného pole
// a schválně se nikam nepředvyplňuje: předvyplněná čeština by se snadno
// uložila jako "překlad".
function CeskyOriginal({ text }: { text: string | null }) {
  if (!text || !text.trim()) return null;
  return (
    <div className="rounded-lg border border-dashed border-line bg-canvas px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
        Česky (podklad k překladu)
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">{text}</p>
    </div>
  );
}

// Stav rozepsaného obsahu u tlačítek. Neuložené změny musí být vidět dřív,
// než kurátor odejde, toast na to nestačí, ten mezitím zmizí.
function StavUlozeni({
  neulozeno,
  ulozenoCas,
}: {
  neulozeno: boolean;
  ulozenoCas: string | null;
}) {
  if (neulozeno) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-deep">
        <span className="h-2 w-2 rounded-full bg-amber" />
        Neuloženo, nezapomeňte uložit
      </span>
    );
  }
  if (ulozenoCas) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
        <CheckCircle2 className="h-4 w-4" strokeWidth={2} /> Uloženo v {ulozenoCas}
      </span>
    );
  }
  return null;
}

// Jemná nápověda místo prázdného místa: co se sem nahrává. Záměrně bez rámečku
// - stojí pod nahrávacím polem, které rámeček už má.
function PrazdnyStav({
  ikona: Ikona,
  text,
  hint,
}: {
  ikona: typeof Info;
  text: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Ikona className="h-4 w-4 shrink-0 text-fg-dim" strokeWidth={1.5} />
      <p>
        <span className="font-medium text-fg-muted">{text}</span>
        {hint && <span className="text-fg-muted">, {hint}</span>}
      </p>
    </div>
  );
}

function pocetSlov(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

// --- Sdílené: upload fotek + mřížka ---

function PhotoDropzone({
  uploading,
  prubeh,
  onZrus,
  onFiles,
  vice = true,
  popis,
  accept = "image/*",
}: {
  uploading: boolean;
  prubeh?: { hotovo: number; celkem: number } | null;
  onZrus?: () => void;
  onFiles: (files: FileList | File[]) => void;
  vice?: boolean; // false = slide unese jen jednu fotku (textový slide)
  popis?: string;
  accept?: string; // galerie bere i MP4, jinde jen obrázky
}) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInput.current?.click()}
      className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
        dragOver ? "border-accent bg-accent-soft" : "border-line hover:border-accent/60 hover:bg-canvas"
      }`}
    >
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        multiple={vice}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {uploading ? (
        <Loader2 className="h-7 w-7 mx-auto text-accent animate-spin" />
      ) : (
        <UploadCloud className={`h-7 w-7 mx-auto ${dragOver ? "text-accent" : "text-fg-dim"}`} strokeWidth={1.5} />
      )}
      {uploading && prubeh ? (
        <>
          <p className="mt-2 text-sm font-semibold text-fg tnum">
            Nahrávám {prubeh.hotovo} / {prubeh.celkem}
          </p>
          <div className="mx-auto mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-canvas">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.round((prubeh.hotovo / prubeh.celkem) * 100)}%` }}
            />
          </div>
          {onZrus && (
            <button
              onClick={(e) => {
                e.stopPropagation(); // klik nesmí otevřít výběr souborů
                onZrus();
              }}
              className="btn-ghost mt-3 px-2.5 py-1 text-xs"
            >
              Zrušit nahrávání
            </button>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-sm font-medium text-fg-muted">
            {!vice
              ? "Přetáhněte fotku sem nebo klikněte"
              : accept.includes("video")
                ? "Přetáhněte fotky a videa sem nebo klikněte"
                : "Přetáhněte fotky sem nebo klikněte"}
          </p>
          <p className="text-xs text-fg-muted">
            {popis ?? "JPG nebo PNG, systém si formát převede sám"}
          </p>
        </>
      )}
    </div>
  );
}

// `seradPodleNazvu` je pro 3D sekvenci: pořadí souborů z prohlížeče není
// zaručené, ale snímky z renderu jsou pojmenované po sobě (frame_001…),
// takže seřazení podle názvu odpovídá pořadí v modelu.
// Výřez fotky: odznak „neoříznuto", otevření editoru a uložení. Sdílené mezi
// info panelem a galerií, protože obě mají stejné fotky a stejný postup, jen
// jiný poměr stran (ten přijde ze serveru v `slide.pomerVyrezu`).
function useVyrez(displayId: string, slide: SlideContent, reload: () => Promise<void>) {
  const toast = useToast();
  const [otevrena, setOtevrena] = useState<string | null>(null);
  const [ukladani, setUkladani] = useState(false);
  // Po ořezu má soubor stejné jméno, takže by prohlížeč ukázal starou fotku
  // z cache. Číslo verze se přilepí za URL a donutí ho načíst znovu.
  const [verze, setVerze] = useState<Record<string, number>>({});

  const pomer = slide.pomerVyrezu ? pomerNaCislo(slide.pomerVyrezu) : null;

  async function uloz(v: Vyrez) {
    if (!otevrena) return;
    setUkladani(true);
    try {
      await api.saveVyrez(displayId, slide.n, otevrena, v);
      setVerze((p) => ({ ...p, [otevrena]: (p[otevrena] ?? 0) + 1 }));
      setOtevrena(null);
      await reload();
      toast.success("Výřez uložen. Tablet si fotku vyzvedne sám.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uložení výřezu selhalo.");
    } finally {
      setUkladani(false);
    }
  }

  return {
    // Typ slidu, který se neořezává (zatím „Informace" a 360), editor nenabízí.
    lzeOrezat: pomer !== null,
    popisPomeru: slide.pomerVyrezu,
    oriznuta: (nazev: string) => nazev in slide.vyrezy,
    otevri: (nazev: string) => setOtevrena(nazev),
    // URL fotky s číslem verze, ať se po ořezu překreslí.
    src: (url: string, nazev: string) =>
      verze[nazev] ? `${url}?v=${verze[nazev]}` : url,
    dialog:
      otevrena && pomer && slide.pomerVyrezu ? (
        // key = název souboru: knihovna bere počáteční výřez jen při prvním
        // vykreslení, takže se dialog pro každou fotku montuje znovu.
        <VyrezDialog
          key={otevrena}
          url={api.originalUrl(displayId, slide.n, otevrena)}
          pomer={pomer}
          popisPomeru={slide.pomerVyrezu}
          vyrez={slide.vyrezy[otevrena] ?? null}
          ukladani={ukladani}
          onUloz={uloz}
          onZrus={() => setOtevrena(null)}
        />
      ) : null,
  };
}

function usePhotoUpload(
  displayId: string,
  n: number,
  reload: () => Promise<void>,
  seradPodleNazvu = false,
  jenJedna = false,
  // Zavolá se po úspěšném nahrání JEDNÉ fotky (název souboru na disku).
  // Podle toho se hned otevře editor výřezu. U hromadného nahrávání se
  // nevolá: dvacet dialogů za sebou by kurátora umlátilo, fotky mají
  // zatím ořez na střed a doladí je po jedné.
  poNahraniJedne?: (nazev: string) => void,
) {
  const toast = useToast();
  // Průběh po souborech: u 3D sekvence jde o desítky uploadů za sebou
  // a bez počítadla kurátor po dvaceti vteřinách usoudí, že to zamrzlo.
  const [prubeh, setPrubeh] = useState<{ hotovo: number; celkem: number } | null>(null);
  const zruseni = useRef<AbortController | null>(null);

  const upload = async (files: FileList | File[]) => {
    let list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) {
      toast.error("Přetáhněte prosím obrázek.");
      return;
    }
    if (seradPodleNazvu) {
      list.sort((a, b) => a.name.localeCompare(b.name, "cs", { numeric: true }));
    }
    // Zajímavost má na disku právě jednu fotku, server by ostatní stejně
    // přepsal, takže je ani nenahráváme a rovnou to řekneme.
    const vicNezUnese = jenJedna && list.length > 1;
    if (jenJedna) list = list.slice(0, 1);

    const rizeni = new AbortController();
    zruseni.current = rizeni;
    setPrubeh({ hotovo: 0, celkem: list.length });

    let hotovo = 0;
    let zruseno = false;
    let chyba: string | null = null;
    let posledniUrl: string | null = null;

    for (const file of list) {
      try {
        const res = await api.uploadImage(displayId, n, file, rizeni.signal);
        posledniUrl = res.url;
        hotovo++;
        setPrubeh({ hotovo, celkem: list.length });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") zruseno = true;
        else chyba = `${file.name}: ${e instanceof Error ? e.message : "upload selhal"}`;
        break;
      }
    }

    zruseni.current = null;
    setPrubeh(null);
    await reload(); // ať je hned vidět, co se stihlo nahrát

    // Přerušený upload se nesmí spolknout: kurátor musí vědět, kolik souborů
    // na disku opravdu je, jinak odejde s nekompletní sekvencí. Počet se bere
    // ze serveru, ne z počítadla: zrušení nezastaví soubor, který už odešel,
    // takže ten se ještě uloží a klientské číslo by bylo o jedna nižší.
    if (zruseno || chyba) {
      let naDisku = hotovo;
      try {
        const d = await api.display(displayId);
        naDisku = d.slides.find((x) => x.n === n)?.obrazky.length ?? hotovo;
      } catch {
        // nepodařilo se přečíst stav, zůstane počítadlo z klienta
      }
      const kolik = `Z ${list.length} vybraných se nenahrály všechny, na slidu je teď ${naDisku} souborů.`;
      toast.error(
        zruseno ? `Nahrávání zrušeno. ${kolik}` : `Upload selhal u ${chyba} ${kolik}`,
      );
      return;
    }
    if (list.length === 1 && posledniUrl && poNahraniJedne) {
      poNahraniJedne(nazevSouboru(posledniUrl));
    }
    toast.success(
      vicNezUnese
        ? "Nahrála se první vybraná fotka. Zajímavost jich unese jen jednu."
        : list.length === 1
          ? seradPodleNazvu
            ? "Snímek nahrán"
            : "Fotka nahrána"
          : `${seradPodleNazvu ? pocetSnimku(list.length) : pocetFotek(list.length)} nahráno`,
    );
  };

  const zrus = () => zruseni.current?.abort();
  return { uploading: prubeh !== null, prubeh, upload, zrus };
}

// --- Info panel: formulář polí + fotky + mapa výskytu ---

function InfoEditor({
  slide,
  pole,
  section,
  onSectionChange,
  onChange,
  onSave,
  jazyk,
  referenceCs,
  zeptejSe,
  neulozeno,
  ulozenoCas,
  saving,
  busy,
  displayId,
  reload,
  withBusy,
}: {
  slide: SlideContent;
  pole: Record<string, string>;
  section: string;
  onSectionChange: (v: string) => void;
  onChange: (patch: Record<string, string>) => void;
  onSave: (pole: Record<string, string>, odeslat: boolean) => Promise<void>;
  jazyk: Jazyk;
  referenceCs: Record<string, string> | null; // český originál při překladu
  zeptejSe: (popis: ReactNode, akce: () => Promise<void>) => void;
  neulozeno: boolean;
  ulozenoCas: string | null;
  saving: boolean;
  busy: boolean;
  displayId: string;
  reload: () => Promise<void>;
  withBusy: (fn: () => Promise<void>, fail: string) => Promise<void>;
}) {
  const toast = useToast();
  const [showErrors, setShowErrors] = useState(false);
  const vyrez = useVyrez(displayId, slide, reload);
  const { uploading, prubeh, upload, zrus } = usePhotoUpload(
    displayId,
    slide.n,
    reload,
    false,
    false,
    // Po nahrání jedné fotky rovnou nabídneme výřez: server ji zatím ořízl
    // na střed, kurátor si ji teď posune tam, kde je zvíře.
    vyrez.lzeOrezat ? vyrez.otevri : undefined,
  );

  // Sekce uložená pod starým názvem nebo se starým oddělovačem (čárka místo
  // em dashe). V nabídce je jen aktuální pojmenování, takže hodnota z disku
  // by se s žádnou položkou nesešla a rozbalovátko by tiše spadlo na prázdné
  // „vyberte sekci". Dohledáme ji proto přes najdiSekci(), která je k obojímu
  // tolerantní, a necháme ji v nabídce navíc.
  const ulozenaSekce = (pole.Sekce ?? "").trim();
  const sekceDef = ulozenaSekce ? najdiSekci(ulozenaSekce) : null;
  // Sedí uložený řetězec přesně na některou položku nabídky? Když ne, je to
  // starý zápis a musí dostat vlastní <option>, jinak by ho select neuměl
  // vybrat.
  const staraSekce = sekceDef && sekceDef.cs !== ulozenaSekce ? sekceDef : null;

  const chybi = (klic: string) => !(pole[klic] ?? "").trim();
  // Pole, které kurátor v tomhle jazyce opravdu edituje. Sekci a latinu drží
  // čeština, takže je v překladu nemá smysl vymáhat ani měřit: nešly by
  // opravit a uložení by se zaseklo napořád.
  const editovatelne = (klic: string) => jazyk === "cs" || jePrekladane(klic);

  const chybejici = INFO_POLE.filter((d) => d.povinne && chybi(d.klic) && editovatelne(d.klic));

  // Délka nad limit. Na rozdíl od počtu slov u dlouhých textů je tohle
  // tvrdá podmínka: Unity má pevné rozvržení a delší text na tabletu
  // zmizí pod okrajem, takže ho nepustíme na disk.
  const delka = (klic: string) => (pole[klic] ?? "").trim().length;
  const prilisDlouha = INFO_POLE.filter(
    (d) => d.limitZnaku !== undefined && editovatelne(d.klic) && delka(d.klic) > d.limitZnaku,
  );

  const valid = chybejici.length === 0 && prilisDlouha.length === 0;

  // Živý náhled kanonického tvaru latinského jména (autoritativně čistí server).
  const latinRaw = pole.Latinsky ?? "";
  const latinNahled = canonicalizeLatin(latinRaw);
  const latinSeZmeni = !!latinNahled && latinNahled !== latinRaw.trim();

  // `odeslat` = uložit a rovnou zveřejnit na tabletu. Zveřejnění se ještě
  // potvrzuje dialogem, protože od té chvíle obsah vidí návštěvníci.
  function handleSave(odeslat: boolean) {
    if (!valid) {
      setShowErrors(true);
      // Vyjmenujeme přesně to, co je špatně, ne obecnou technickou chybu.
      // Nevyplněné pole má přednost: to se opraví psaním, dlouhé škrtáním.
      const vyctem = (pole: InfoPoleDef[]) => {
        const jmena = pole.map((d) => d.label);
        return jmena.length === 1 ? jmena[0] : `${jmena.slice(0, -1).join(", ")} a ${jmena.at(-1)}`;
      };
      if (chybejici.length) {
        toast.error(`Ještě chybí vyplnit: ${vyctem(chybejici)}.`);
      } else {
        toast.error(`Zkraťte prosím: ${vyctem(prilisDlouha)}. Delší text se na tablet nevejde.`);
      }
      // Kurátora pošleme přímo na první problémové pole.
      const prvni = chybejici[0] ?? prilisDlouha[0];
      document.getElementById(`pole-${prvni.klic}`)?.focus();
      return;
    }
    if (!odeslat) {
      void onSave(pole, false);
      return;
    }
    zeptejSe(
      <>
        Označí se jako hotový <strong className="font-semibold text-fg">Infopanel</strong> displeje{" "}
        {displayId}, údaje o druhu i nahrané fotky.
      </>,
      () => onSave(pole, true),
    );
  }

  // Mazání fotky je nevratné (soubor zmizí z disku), takže se ptáme stejně
  // jako u slidu. Drží se URL fotky, na kterou kurátor klikl.
  const [smazatFotku, setSmazatFotku] = useState<string | null>(null);

  async function removeImage(url: string) {
    setSmazatFotku(null);
    await withBusy(async () => {
      await api.deleteMedia(displayId, slide.n, nazevSouboru(url));
      await reload();
      toast.success("Fotka odebrána");
    }, "Odebrání fotky selhalo.");
  }

  async function markMapa(url: string | null) {
    await withBusy(async () => {
      await api.setMapa(displayId, slide.n, url ? nazevSouboru(url) : null);
      await reload();
      toast.success(url ? "Fotka označena jako mapa výskytu (mapa.png)" : "Značení mapy zrušeno");
    }, "Změna mapy výskytu selhala.");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
      {/* Formulář polí (na disk jde text.txt jako "Klic: Hodnota") */}
      <div className="space-y-4">
        {/* Co je povinné, má být vidět předem, ne až z chybové hlášky. */}
        <p className="text-xs text-fg-muted">
          Pole označená <span className="font-bold text-danger">*</span> jsou povinná, bez nich
          panel neuložíte. Ostatní můžete nechat prázdná.
        </p>
        {INFO_POLE.map((def) => {
          const hodnota = pole[def.klic] ?? "";
          const nevyplneno = showErrors && def.povinne && chybi(def.klic);
          // Délka se hlásí hned při psaní, ne až po pokusu o uložení: kurátor
          // má vidět, že přetahuje, dokud je text ještě rozepsaný.
          const dlouhe =
            def.limitZnaku !== undefined &&
            editovatelne(def.klic) &&
            hodnota.trim().length > def.limitZnaku;
          const chybne = nevyplneno || dlouhe;
          return (
            <div key={def.klic}>
              <label className="label" htmlFor={`pole-${def.klic}`}>
                {def.label}
                {def.povinne ? (
                  <>
                    <span className="font-bold text-danger" aria-hidden="true">
                      {" *"}
                    </span>
                    <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wider text-danger">
                      povinné
                    </span>
                  </>
                ) : (
                  <span className="text-fg-muted font-normal"> · volitelné</span>
                )}
              </label>
              {jazyk !== "cs" && !jePrekladane(def.klic) ? (
                // Sdílené pole: v překladu se needituje, mění se v češtině.
                <div className="input bg-canvas text-fg-muted">{hodnota || "nevyplněno"}</div>
              ) : def.klic === "Sekce" ? (
                <select
                  id={`pole-${def.klic}`}
                  className={`input ${chybne ? "input-error" : ""}`}
                  value={hodnota}
                  onChange={(e) => onChange({ Sekce: e.target.value })}
                >
                  <option value="">vyberte sekci</option>
                  {SEKCE_TEMATA.map((sekce) => (
                    <option key={sekce.cs} value={sekce.cs}>
                      {sekce.cislo}. {sekce.cs}
                    </option>
                  ))}
                  {/* Displej uložený dřív má starý zápis sekce (jiný název
                      nebo čárku místo pomlčky). Necháme ho v nabídce, ať
                      kurátor vidí, co v souboru opravdu je; uložením se
                      přepíše aktuálním tvarem. */}
                  {staraSekce && (
                    <option value={hodnota}>{hodnota} (starý zápis)</option>
                  )}
                </select>
              ) : (
                <input
                  id={`pole-${def.klic}`}
                  className={`input ${chybne ? "input-error" : ""}`}
                  value={hodnota}
                  onChange={(e) => onChange({ [def.klic]: e.target.value })}
                  placeholder={def.povinne ? "" : "Nepovinné, prázdné se neukládá"}
                />
              )}
              <PodPolem
                hint={def.hint}
                pocitadlo={
                  def.limitZnaku && hodnota.trim() ? (
                    <Pocitadlo
                      kolik={hodnota.trim().length}
                      limit={def.limitZnaku}
                      jednotka="znaků"
                      tvrdy={editovatelne(def.klic)}
                    />
                  ) : undefined
                }
              />
              {nevyplneno && (
                <p className="mt-1 text-xs text-danger">Tohle pole je potřeba vyplnit.</p>
              )}
              {dlouhe && (
                <p className="mt-1 text-xs text-danger">
                  Maximálně {def.limitZnaku} znaků, teď jich je {hodnota.trim().length}. Dokud
                  text nezkrátíte, panel nejde uložit.
                </p>
              )}
              {jazyk !== "cs" && !jePrekladane(def.klic) && (
                <p className="mt-1 text-xs text-fg-muted">
                  Společné pro všechny jazyky, mění se v češtině.
                </p>
              )}
              {/* Český originál jako podklad k překladu. Schválně se
                  nepředvyplňuje, aby se čeština omylem neuložila jako
                  angličtina. */}
              {jazyk !== "cs" && jePrekladane(def.klic) && !hodnota.trim() &&
                (referenceCs?.[def.klic] ?? "").trim() && (
                  <p className="mt-1 text-xs text-fg-muted">
                    <span className="font-semibold">Česky:</span> {referenceCs?.[def.klic]}
                  </p>
                )}
              {def.klic === "Sekce" && staraSekce && (
                <p className="mt-1 text-xs text-amber-deep">
                  „{hodnota}" je starší zápis (jiný název nebo čárka místo pomlčky).
                  Podle tabule v pavilonu je to teď{" "}
                  <span className="font-semibold">
                    {staraSekce.cislo}. {staraSekce.cs}
                  </span>
                  , vyberte ho ze seznamu, ať sedí čísla na podlaze a zápis je všude stejný.
                </p>
              )}
              {def.klic === "Latinsky" && latinSeZmeni && (
                <p className="mt-1 text-xs text-amber-deep">
                  Uloží se v kanonickém tvaru: <span className="font-mono">{latinNahled}</span>
                </p>
              )}
            </div>
          );
        })}

        {/* Taxonomická čeleď: jde jen do meta.json (identifikace pro chatbota). */}
        <div>
          <label className="label">
            Čeleď (taxonomická)<span className="text-fg-muted font-normal"> · volitelné</span>
          </label>
          {jazyk === "cs" ? (
            <>
              <input
                className="input"
                value={section}
                onChange={(e) => onSectionChange(e.target.value)}
                placeholder="Např. Dendrobatidae"
              />
              <PodPolem hint="Na tabletu se nezobrazuje, slouží jen chatbotovi k rozpoznání druhu." />
            </>
          ) : (
            <>
              <div className="input bg-canvas text-fg-muted">{section || "nevyplněno"}</div>
              <PodPolem hint="Společné pro všechny jazyky, mění se v češtině." />
            </>
          )}
        </div>

        <div className="space-y-3 pt-1">
          {/* Souhrn chybějících polí zůstane na obrazovce (na rozdíl od toastu). */}
          {showErrors && chybejici.length > 0 && (
            <p className="text-sm text-danger">
              Ještě chybí vyplnit:{" "}
              <span className="font-semibold">{chybejici.map((d) => d.label).join(", ")}</span>. Bez
              nich se panel neuloží.
            </p>
          )}
          {showErrors && prilisDlouha.length > 0 && (
            <p className="text-sm text-danger">
              Je moc dlouhé:{" "}
              <span className="font-semibold">{prilisDlouha.map((d) => d.label).join(", ")}</span>.
              Zkraťte to, delší text se na tablet nevejde.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => handleSave(false)} className="btn-primary" disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" strokeWidth={1.75} />
              )}
              Uložit
            </button>
            <button onClick={() => handleSave(true)} className="btn-ghost" disabled={saving}>
              <Send className="h-4 w-4" strokeWidth={1.75} />
              Uložit a označit jako hotové
            </button>
            <StavUlozeni neulozeno={neulozeno} ulozenoCas={ulozenoCas} />
          </div>
          {/* Rozdíl mezi tlačítky musí být čitelný bez školení, a hlavně
              pravdivý: uložený obsah jde na tablet tak jako tak. */}
          <div className="space-y-1 text-xs text-fg-muted">
            <p>
              <strong className="font-semibold text-fg">Uložit</strong>: zapíše obsah na disk.{" "}
              {VYZVEDNE_SI_SAM}
            </p>
            <p>
              <strong className="font-semibold text-fg">Uložit a označit jako hotové</strong>: uloží a navíc zapíše do auditu (jako „odesláno na displej"), že je obsah hotový a
              zkontrolovaný. Na to, kdy se objeví na tabletu, to vliv nemá.
            </p>
            <p>
              Fotky a video se ukládají hned při nahrání. Tablet si je vyzvedne stejně jako
              zbytek.
            </p>
          </div>
        </div>
      </div>

      {/* Fotky info panelu + mapa výskytu */}
      <div className="space-y-4 lg:border-l lg:border-line lg:pl-10">
        <div>
          <span className="label">Fotky info panelu</span>
          <p className="text-xs text-fg-muted -mt-1">
            Hlavní vizuál druhu. Jednu fotku můžete označit jako mapu výskytu ikonkou mapy,
            která se objeví po najetí na fotku. {SDILENE_HLASKA}
          </p>
        </div>

        <PhotoDropzone uploading={uploading} prubeh={prubeh} onZrus={zrus} onFiles={upload} />

        {slide.obrazky.length === 0 && !slide.mapa ? (
          <PrazdnyStav
            ikona={ImageIcon}
            text="Zatím žádná fotka"
            hint="Nahrajte hlavní fotku druhu. Když nahrajete víc fotek, tablet je bude střídat."
          />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {slide.obrazky.map((url) => {
              const nazev = nazevSouboru(url);
              return (
                <div key={url} className="group relative aspect-square rounded-lg overflow-hidden bg-canvas ring-1 ring-line">
                  <img
                    src={vyrez.src(url, nazev)}
                    alt="Fotka info panelu"
                    className="h-full w-full object-cover"
                  />
                  {/* Fotka nahraná dřív, než se ořezávání zavedlo. Na tabletu
                      se zobrazí, jak vyjde, proto to má kurátor vidět. */}
                  {vyrez.lzeOrezat && !vyrez.oriznuta(nazev) && (
                    <span className="absolute left-1.5 top-1.5 chip bg-amber text-white text-[10px] px-1.5 py-0.5">
                      neoříznuto
                    </span>
                  )}
                  <div className={`${OVLADANI_LISTA} justify-between`}>
                    <div className="flex items-center gap-1">
                      {vyrez.lzeOrezat && (
                        <button
                          onClick={() => vyrez.otevri(nazev)}
                          disabled={busy}
                          className={OVLADANI_TLACITKO}
                          title="Upravit výřez"
                          aria-label="Upravit výřez fotky"
                        >
                          <Crop className="h-5 w-5" strokeWidth={2} />
                        </button>
                      )}
                      <button
                        onClick={() => markMapa(url)}
                        disabled={busy}
                        className={OVLADANI_TLACITKO}
                        title="Označit jako mapu výskytu"
                        aria-label="Označit jako mapu výskytu"
                      >
                        <Map className="h-5 w-5" strokeWidth={2} />
                      </button>
                    </div>
                    <button
                      onClick={() => setSmazatFotku(url)}
                      disabled={busy}
                      className={OVLADANI_SMAZAT}
                      title="Smazat fotku"
                      aria-label="Smazat fotku"
                    >
                      <Trash2 className="h-5 w-5" strokeWidth={2} />
                    </button>
                  </div>
                </div>
              );
            })}
            {slide.mapa && (
              <div key="mapa" className="group relative aspect-square rounded-lg overflow-hidden bg-canvas ring-2 ring-amber">
                <img src={slide.mapa} alt="Mapa výskytu" className="h-full w-full object-cover" />
                <span className="absolute left-1.5 top-1.5 chip bg-amber text-white text-[10px] px-1.5 py-0.5">
                  mapa výskytu
                </span>
                <div className={`${OVLADANI_LISTA} justify-between`}>
                  <button
                    onClick={() => markMapa(null)}
                    disabled={busy}
                    className={OVLADANI_TLACITKO}
                    title="Zrušit značení mapy (stane se běžnou fotkou)"
                    aria-label="Zrušit značení mapy výskytu"
                  >
                    <X className="h-5 w-5" strokeWidth={2} />
                  </button>
                  <button
                    onClick={() => setSmazatFotku(slide.mapa!)}
                    disabled={busy}
                    className={OVLADANI_SMAZAT}
                    title="Smazat mapu"
                    aria-label="Smazat mapu výskytu"
                  >
                    <Trash2 className="h-5 w-5" strokeWidth={2} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {vyrez.dialog}

        {/* Volitelné video info panelu (finální struktura od Michala).
            Na zařízení ho Michal zařadí na začátek galerie fotek. */}
        <div className="pt-2 border-t border-lineSoft">
          <span className="label">Video info panelu <span className="text-fg-muted font-normal">· volitelné</span></span>
          <p className="text-xs text-fg-muted -mt-1 mb-3">
            Volitelné krátké video do galerie tohoto panelu. Pro velké video přes celou obrazovku
            použijte samostatný slide <strong className="font-semibold text-fg-muted">Video</strong>.{" "}
            {SDILENE_HLASKA}
          </p>
          <VideoBlok
            slide={slide}
            displayId={displayId}
            busy={busy}
            reload={reload}
            withBusy={withBusy}
          />
        </div>
      </div>

      <Confirm
        open={!!smazatFotku}
        titulek={smazatFotku === slide.mapa ? "Smazat mapu výskytu?" : "Smazat fotku?"}
        text={
          smazatFotku === slide.mapa ? (
            <>
              Mapa výskytu se smaže z disku. Vrátit to nepůjde, bude ji potřeba nahrát a znovu
              označit.
            </>
          ) : (
            <>Fotka se smaže z disku. Vrátit to nepůjde, bude ji potřeba nahrát znovu.</>
          )
        }
        potvrdit={smazatFotku === slide.mapa ? "Smazat mapu" : "Smazat fotku"}
        onPotvrdit={() => smazatFotku && removeImage(smazatFotku)}
        onZrusit={() => setSmazatFotku(null)}
      />
    </div>
  );
}

// --- Textový slide (_gal): dva dlouhé texty a zařazení vlevo, fotka vpravo ---
//
// Oba texty i zařazení se překládají, sdílené s češtinou tu není nic. Fotka
// je naopak společná: nahrává se jednou do češtiny a ostatní jazyky si ji
// odtud berou, stejně jako u všech ostatních médií.

function TextovyEditor({
  slide,
  displayId,
  busy,
  reload,
  withBusy,
  zeptejSe,
  jazyk,
  referenceCs,
  pole,
  onUlozeno,
  onZmena,
  neulozeno,
  ulozenoCas,
}: {
  slide: SlideContent;
  displayId: string;
  busy: boolean;
  reload: () => Promise<void>;
  withBusy: (fn: () => Promise<void>, fail: string) => Promise<void>;
  zeptejSe: (popis: ReactNode, akce: () => Promise<void>) => void;
  jazyk: Jazyk;
  referenceCs: Record<string, string> | null;
  pole: Record<string, string>;
  onUlozeno: () => void;
  onZmena: (patch: Record<string, string>) => void;
  neulozeno: boolean;
  ulozenoCas: string | null;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [smazatFotku, setSmazatFotku] = useState(false);
  const [chybiObsah, setChybiObsah] = useState(false);
  // Slide má na disku právě jednu fotku, tak ji ani nenabízíme víc.
  const { uploading, prubeh, upload, zrus } = usePhotoUpload(displayId, slide.n, reload, false, true);
  const fotka = slide.obrazky[0] ?? null;

  const prazdny = galPrazdny(pole);
  // Nerozpoznaný tvar taxonomie na disku (ruční zásah do text.txt). Ukazuje
  // se místo tichého zahození, uložením se přepíše.
  const zbytekTaxonomie = (slide.pole[TAXONOMIE_ZBYTEK] ?? "").trim();

  // `odeslat` = navíc zapsat do auditu, že je kurátor s texty hotový.
  async function ulozit(odeslat: boolean) {
    setSaving(true);
    try {
      await api.saveSlideText(displayId, slide.n, pole, jazyk);
      if (odeslat) await api.refresh(displayId);
      onUlozeno();
      await reload();
      toast.success(
        odeslat
          ? `Texty uloženy a zapsány jako hotové (displej ${displayId}).`
          : "Texty uloženy. Tablet si je vyzvedne sám, obvykle do minuty.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uložení selhalo.");
    } finally {
      setSaving(false);
    }
  }

  // Prázdný slide se dá uložit (rozdělaná práce), ale ne označit za hotový.
  // Hotovo je záznam do auditu, že obsah někdo zkontroloval; u prázdna to
  // nedává smysl a na tabletu by zůstalo prázdné místo.
  function zverejnit() {
    if (prazdny) {
      setChybiObsah(true);
      toast.error("Ještě chybí vyplnit: aspoň jeden z obou textů.");
      document.getElementById(`gal-${slide.n}-${TEXTOVA_POLE[0].klic}`)?.focus();
      return;
    }
    setChybiObsah(false);
    zeptejSe(
      <>
        Označí se jako hotový slide{" "}
        <strong className="font-semibold text-fg">Informace</strong> displeje {displayId},
        texty i fotka.
      </>,
      () => ulozit(true),
    );
  }

  async function removeImage(url: string) {
    setSmazatFotku(false);
    await withBusy(async () => {
      await api.deleteMedia(displayId, slide.n, nazevSouboru(url));
      await reload();
      toast.success("Fotka odebrána");
    }, "Odebrání fotky selhalo.");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
      {/* Texty a zařazení (na disk jdou do text.txt) */}
      <div className="space-y-6">
        {TEXTOVA_POLE.map((def) => {
          const hodnota = pole[def.klic] ?? "";
          return (
            <div key={def.klic}>
              <label className="label" htmlFor={`gal-${slide.n}-${def.klic}`}>
                {def.label}
                <span className="text-fg-muted font-normal"> · překládá se</span>
              </label>
              <textarea
                id={`gal-${slide.n}-${def.klic}`}
                className="input min-h-[200px] resize-y leading-relaxed"
                value={hodnota}
                onChange={(e) => onZmena({ [def.klic]: e.target.value })}
              />
              {/* Český originál jako podklad k překladu. Schválně se
                  nepředvyplňuje, aby se čeština omylem neuložila jako
                  angličtina. */}
              {!hodnota.trim() && <CeskyOriginal text={referenceCs?.[def.klic] ?? null} />}
              <PodPolem
                hint={`${def.hint} Ideálně do ${def.limitSlov} slov, delší text se na tabletu ořízne.`}
                pocitadlo={
                  hodnota.trim() ? (
                    <Pocitadlo kolik={pocetSlov(hodnota)} limit={def.limitSlov} jednotka="slov" />
                  ) : undefined
                }
              />
            </div>
          );
        })}

        {/* Zařazení druhu. Na disk jde jako JEDEN řádek "Taxonomie: Třída: …
            | Řád: … | Čeleď: …", složí ho server podle jazyka. Kurátor ho
            vyplňuje po částech, ať nemusí hlídat oddělovače. */}
        <div>
          <span className="label">
            Zařazení druhu
            <span className="text-fg-muted font-normal"> · nepovinné, překládá se</span>
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TAXONOMIE_POLE.map((def) => {
              const hodnota = pole[def.klic] ?? "";
              return (
                <div key={def.klic}>
                  <label
                    className="block text-xs font-medium text-fg-muted mb-1"
                    htmlFor={`gal-${slide.n}-${def.klic}`}
                  >
                    {def.label}
                  </label>
                  <input
                    id={`gal-${slide.n}-${def.klic}`}
                    className="input"
                    value={hodnota}
                    onChange={(e) => onZmena({ [def.klic]: e.target.value })}
                    placeholder={def.placeholder}
                  />
                  {!hodnota.trim() && <CeskyOriginal text={referenceCs?.[def.klic] ?? null} />}
                </div>
              );
            })}
          </div>
          <PodPolem
            hint={
              jazyk === "cs"
                ? "Na tabletu se poskládá do jednoho řádku, oddělovače doplní systém. Nevyplněnou část vynechá."
                : "Vyplňte v jazyce překladu, popisky (Class, Order, Family) doplní systém sám."
            }
          />
          {/* Latinská čeleď z info panelu je jiný údaj (jde jen chatbotovi),
              ať ji kurátor nehledá tady. */}
          <p className="mt-1 text-xs text-fg-muted">
            Tohle je text pro návštěvníka na tabletu. Latinská čeleď pro chatbota
            (např. <span className="font-mono">Dendrobatidae</span>) se vyplňuje zvlášť
            v Infopanelu.
          </p>
          {zbytekTaxonomie && (
            <p className="mt-2 text-sm text-amber-deep">
              V souboru na disku je zařazení v tvaru, kterému nerozumíme:{" "}
              <span className="font-mono">{zbytekTaxonomie}</span>. Uložením slidu se přepíše
              tím, co je v polích výš.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => ulozit(false)} className="btn-primary" disabled={saving || busy}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" strokeWidth={1.75} />
            )}
            Uložit
          </button>
          <button onClick={zverejnit} className="btn-ghost" disabled={saving || busy}>
            <Send className="h-4 w-4" strokeWidth={1.75} />
            Uložit a označit jako hotové
          </button>
          <StavUlozeni neulozeno={neulozeno} ulozenoCas={ulozenoCas} />
        </div>

        {chybiObsah && prazdny && (
          <p className="text-sm text-danger">
            Ještě chybí vyplnit: <span className="font-semibold">aspoň jeden z obou textů</span>.
            Bez toho slide nejde označit za hotový, uložit rozepsaný ale můžete.
          </p>
        )}

        <p className="text-xs text-fg-muted">
          <strong className="font-semibold text-fg">Uložit</strong> zapíše texty na disk.{" "}
          {VYZVEDNE_SI_SAM} Druhé tlačítko navíc zapíše do auditu, že jsou texty hotové.
        </p>
      </div>

      {/* Jedna fotka vpravo */}
      <div className="space-y-4 lg:border-l lg:border-line lg:pl-10">
        <div>
          <span className="label">Fotka slidu</span>
          <p className="text-xs text-fg-muted -mt-1">
            Jedna fotka, na zařízení vpravo vedle textu. Nová nahraná ji nahradí. {SDILENE_HLASKA}
          </p>
        </div>

        <PhotoDropzone
          uploading={uploading}
          prubeh={prubeh}
          onZrus={zrus}
          onFiles={upload}
          vice={false}
          popis="Jedna fotka (JPG nebo PNG), nová nahradí tu předchozí."
        />

        {fotka ? (
          <div className="group relative aspect-[4/3] max-w-sm rounded-lg overflow-hidden bg-canvas ring-1 ring-line">
            <img src={fotka} alt="Fotka slidu" className="h-full w-full object-cover" />
            <div className={`${OVLADANI_LISTA} justify-end`}>
              <button
                onClick={() => setSmazatFotku(true)}
                disabled={busy}
                className={OVLADANI_SMAZAT}
                title="Smazat fotku"
                aria-label="Smazat fotku slidu"
              >
                <Trash2 className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>
          </div>
        ) : (
          <PrazdnyStav
            ikona={ImageIcon}
            text="Zatím žádná fotka"
            hint="Nahrajte jednu fotku k textu, na tabletu bude vpravo vedle něj."
          />
        )}
      </div>

      <Confirm
        open={smazatFotku}
        titulek="Smazat fotku?"
        text={<>Fotka se smaže z disku. Vrátit to nepůjde, bude ji potřeba nahrát znovu.</>}
        potvrdit="Smazat fotku"
        onPotvrdit={() => fotka && removeImage(fotka)}
        onZrusit={() => setSmazatFotku(false)}
      />
    </div>
  );
}

// --- Obecné informace (_txt): dva dlouhé texty, žádná média ---
//
// Oba texty se překládají, sdílené s češtinou není nic. Slide nemá fotky ani
// video, takže se tu neukládá nic „hned při nahrání": všechno jde na disk až
// tlačítkem, stejně jako u zajímavosti.

function ObecneEditor({
  slide,
  displayId,
  busy,
  reload,
  zeptejSe,
  jazyk,
  referenceCs,
  pole,
  onZmena,
  onUlozeno,
  neulozeno,
  ulozenoCas,
}: {
  slide: SlideContent;
  displayId: string;
  busy: boolean;
  reload: () => Promise<void>;
  zeptejSe: (popis: ReactNode, akce: () => Promise<void>) => void;
  jazyk: Jazyk;
  referenceCs: Record<string, string> | null;
  pole: Record<string, string>;
  onZmena: (patch: Record<string, string>) => void;
  onUlozeno: () => void;
  neulozeno: boolean;
  ulozenoCas: string | null;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [chybiObsah, setChybiObsah] = useState(false);

  const prazdny = textovyPrazdny(pole);

  // `odeslat` = navíc zapsat do auditu, že je kurátor s texty hotový.
  async function ulozit(odeslat: boolean) {
    setSaving(true);
    try {
      await api.saveTextSlide(displayId, slide.n, pole, jazyk);
      if (odeslat) await api.refresh(displayId);
      onUlozeno();
      await reload();
      toast.success(
        odeslat
          ? `Obecné informace uloženy a zapsány jako hotové (displej ${displayId}).`
          : "Obecné informace uloženy. Tablet si je vyzvedne sám, obvykle do minuty.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Uložení selhalo.");
    } finally {
      setSaving(false);
    }
  }

  // Prázdný slide se dá uložit (rozdělaná práce), ale ne označit za hotový:
  // na tabletu by zůstalo prázdné místo a v auditu by stálo, že to někdo
  // zkontroloval. Stejné pravidlo jako u ostatních typů.
  function zverejnit() {
    if (prazdny) {
      setChybiObsah(true);
      toast.error("Ještě chybí vyplnit: aspoň jeden z obou textů.");
      document.getElementById(`txt-${slide.n}-${TEXTOVA_POLE[0].klic}`)?.focus();
      return;
    }
    setChybiObsah(false);
    zeptejSe(
      <>
        Označí se jako hotový slide{" "}
        <strong className="font-semibold text-fg">Obecné informace</strong> displeje {displayId}.
      </>,
      () => ulozit(true),
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {TEXTOVA_POLE.map((def) => {
        const hodnota = pole[def.klic] ?? "";
        return (
          <div key={def.klic}>
            <label className="label" htmlFor={`txt-${slide.n}-${def.klic}`}>
              {def.label}
              <span className="text-fg-muted font-normal"> · překládá se</span>
            </label>
            <textarea
              id={`txt-${slide.n}-${def.klic}`}
              className="input min-h-[200px] resize-y leading-relaxed"
              value={hodnota}
              onChange={(e) => onZmena({ [def.klic]: e.target.value })}
            />
            {/* Český originál jako podklad k překladu. Schválně se
                nepředvyplňuje, aby se čeština omylem neuložila jako
                angličtina. */}
            {!hodnota.trim() && <CeskyOriginal text={referenceCs?.[def.klic] ?? null} />}
            <PodPolem
              hint={`${def.hint} Ideálně do ${def.limitSlov} slov, delší text se na tabletu ořízne.`}
              pocitadlo={
                hodnota.trim() ? (
                  <Pocitadlo kolik={pocetSlov(hodnota)} limit={def.limitSlov} jednotka="slov" />
                ) : undefined
              }
            />
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => ulozit(false)} className="btn-primary" disabled={saving || busy}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" strokeWidth={1.75} />
          )}
          Uložit
        </button>
        <button onClick={zverejnit} className="btn-ghost" disabled={saving || busy}>
          <Send className="h-4 w-4" strokeWidth={1.75} />
          Uložit a označit jako hotové
        </button>
        <StavUlozeni neulozeno={neulozeno} ulozenoCas={ulozenoCas} />
      </div>

      {chybiObsah && prazdny && (
        <p className="text-sm text-danger">
          Ještě chybí vyplnit: <span className="font-semibold">aspoň jeden z obou textů</span>.
          Bez toho slide nejde označit za hotový, uložit rozepsaný ale můžete.
        </p>
      )}

      <p className="text-xs text-fg-muted">
        <strong className="font-semibold text-fg">Uložit</strong> zapíše oba texty na disk.{" "}
        {VYZVEDNE_SI_SAM} Druhé tlačítko navíc zapíše do auditu, že jsou texty hotové.
      </p>
    </div>
  );
}

// --- 3D model (_3d): sekvence snímků 001.png, 002.png… ---

function pocetSnimku(n: number): string {
  if (n === 1) return "1 snímek";
  if (n >= 2 && n <= 4) return `${n} snímky`;
  return `${n} snímků`;
}

function ModelEditor({
  slide,
  displayId,
  busy,
  reload,
  withBusy,
  onSend,
  zeptejSe,
}: {
  slide: SlideContent;
  displayId: string;
  busy: boolean;
  reload: () => Promise<void>;
  withBusy: (fn: () => Promise<void>, fail: string) => Promise<void>;
  onSend: () => Promise<void>;
  zeptejSe: (popis: ReactNode, akce: () => Promise<void>) => void;
}) {
  const toast = useToast();
  // Snímky se nahrávají seřazené podle názvu, ať sekvence sedí na render.
  const { uploading, prubeh, upload, zrus } = usePhotoUpload(displayId, slide.n, reload, true);

  // Výřez sekvence 360: jeden rámeček pro celou otáčku, ne po snímcích.
  const [vyrezOtevren, setVyrezOtevren] = useState(false);
  // Po ořezu mají snímky stejná jména, takže by prohlížeč ukázal staré
  // obrázky z cache. Číslo verze se přilepí za URL a donutí ho načíst znovu.
  const [verzeSnimku, setVerzeSnimku] = useState(0);
  const pomerSekvence = slide.pomerVyrezu ? pomerNaCislo(slide.pomerVyrezu) : null;
  const snimky = slide.obrazky.map(nazevSouboru);

  const vyrezHotov = useCallback(async () => {
    setVyrezOtevren(false);
    setVerzeSnimku((v) => v + 1);
    await reload();
    toast.success("Sekvence oříznuta. Tablet si snímky vyzvedne sám.");
  }, [reload, toast]);

  // U jednoho snímku z dlouhé sekvence stačí lehčí potvrzení: krátká otázka
  // bez varování o nevratnosti (snímek se dá znovu nahrát z renderu).
  const [smazatSnimek, setSmazatSnimek] = useState<string | null>(null);
  const [chybiObsah, setChybiObsah] = useState(false);

  async function removeFrame(url: string) {
    setSmazatSnimek(null);
    await withBusy(async () => {
      await api.deleteMedia(displayId, slide.n, nazevSouboru(url));
      await reload();
      toast.success("Snímek odebrán, sekvence přečíslována");
    }, "Odebrání snímku selhalo.");
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Snímky 3D modelu</span>
          {slide.obrazky.length > 0 && pomerSekvence && !slide.vyrezSekvence && (
            <span className="rounded bg-amber-soft px-1.5 py-0.5 text-[10px] font-semibold text-amber-deep">
              neoříznuto
            </span>
          )}
        </div>
        <p className="text-xs text-fg-muted -mt-1">
          {SDILENE_HLASKA} Sekvence fotek, jak se model otáčí, tablet mezi nimi přepíná. Vyberte všechny snímky
          najednou, seřadí se podle názvu souboru a uloží pod čísly{" "}
          <span className="font-mono">001.png</span>, <span className="font-mono">002.png</span>…
          Po smazání snímku se zbytek sám přečísluje, v sekvenci nezůstane díra.
        </p>
      </div>

      <PhotoDropzone uploading={uploading} prubeh={prubeh} onZrus={zrus} onFiles={upload} />

      {slide.obrazky.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-fg-muted tnum">
              {pocetSnimku(slide.obrazky.length)} v sekvenci
            </div>
            {pomerSekvence && (
              <button
                onClick={() => setVyrezOtevren(true)}
                className="btn-ghost"
                disabled={busy || uploading}
              >
                <Crop className="h-4 w-4" strokeWidth={1.75} />
                {slide.vyrezSekvence ? "Upravit výřez sekvence" : "Nastavit výřez sekvence"}
              </button>
            )}
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-3">
            {slide.obrazky.map((url, i) => (
              <div
                key={url}
                className="group relative aspect-square rounded-lg overflow-hidden bg-canvas ring-1 ring-line"
              >
                <img
                  src={verzeSnimku ? `${url}?v=${verzeSnimku}` : url}
                  alt={`Snímek ${i + 1}`}
                  className="h-full w-full object-cover"
                />
                <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white tnum">
                  {nazevSouboru(url)}
                </span>
                <div className={`${OVLADANI_LISTA} justify-end`}>
                  <button
                    onClick={() => setSmazatSnimek(url)}
                    disabled={busy}
                    className={OVLADANI_SMAZAT}
                    title="Smazat snímek"
                    aria-label={`Smazat snímek ${nazevSouboru(url)}`}
                  >
                    <Trash2 className="h-5 w-5" strokeWidth={2} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <PrazdnyStav
          ikona={Box}
          text="Zatím žádné snímky"
          hint="Nahrajte sekvenci fotek, jak se model postupně otáčí (např. 36 snímků). Vyberte je všechny najednou."
        />
      )}

      {chybiObsah && slide.obrazky.length === 0 && (
        <p className="text-sm text-danger">
          Ještě chybí nahrát: <span className="font-semibold">snímky 3D modelu</span>. Prázdný
          slide nejde označit za hotový.
        </p>
      )}
      <button
        onClick={() => {
          if (slide.obrazky.length === 0) {
            setChybiObsah(true);
            toast.error("Ještě chybí nahrát: snímky 3D modelu.");
            return;
          }
          setChybiObsah(false);
          zeptejSe(
            <>
              Označí se jako hotový slide{" "}
              <strong className="font-semibold text-fg">3D model</strong> displeje {displayId}
              {", "}
              {pocetSnimku(slide.obrazky.length)}.
            </>,
            onSend,
          );
        }}
        className="btn-primary w-fit"
        disabled={busy}
      >
        <Send className="h-4 w-4" strokeWidth={1.75} /> Označit jako hotové
      </button>
      <p className="text-xs text-fg-muted">
        Snímky jsou uložené hned po nahrání. {VYZVEDNE_SI_SAM} Tlačítkem se do auditu zapíše, že
        je slide hotový.
      </p>

      <Confirm
        open={!!smazatSnimek}
        titulek="Smazat snímek?"
        text={
          <>
            Snímek <span className="font-mono">{smazatSnimek && nazevSouboru(smazatSnimek)}</span>{" "}
            se smaže a sekvence se přečísluje.
          </>
        }
        potvrdit="Smazat snímek"
        onPotvrdit={() => smazatSnimek && removeFrame(smazatSnimek)}
        onZrusit={() => setSmazatSnimek(null)}
      />

      {vyrezOtevren && pomerSekvence && slide.pomerVyrezu && snimky.length > 0 && (
        <VyrezSekvenceDialog
          displayId={displayId}
          n={slide.n}
          snimky={snimky}
          pomer={pomerSekvence}
          popisPomeru={slide.pomerVyrezu}
          vyrez={slide.vyrezSekvence}
          onHotovo={vyrezHotov}
          onZrus={() => setVyrezOtevren(false)}
        />
      )}
    </div>
  );
}

// --- Video info panelu: jedno volitelné MP4 ---

// Nahrání, nahrazení a odebrání jednoho MP4. Používá ho už jen info panel
// (Michal ho na zařízení řadí na začátek galerie fotek); galerie `_vid` má
// vlastní blok, protože tam videí může být víc a míchají se s fotkami.
function VideoBlok({
  slide,
  displayId,
  busy,
  reload,
  withBusy,
}: {
  slide: SlideContent;
  displayId: string;
  busy: boolean;
  reload: () => Promise<void>;
  withBusy: (fn: () => Promise<void>, fail: string) => Promise<void>;
}) {
  const toast = useToast();
  const [uploadingVideo, setUploadingVideo] = useState(false);
  // Procenta odeslaných bajtů: u stovek MB je kolečko bez čísla k ničemu.
  const [procenta, setProcenta] = useState(0);
  const zruseniVidea = useRef<AbortController | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  async function uploadVideoFile(file: File) {
    if (file.type !== "video/mp4" && !/\.mp4$/i.test(file.name)) {
      toast.error("Nahrajte prosím video ve formátu MP4.");
      return;
    }
    // Limit hlídáme ještě před odesláním, ať kurátor nečeká na upload, který
    // server stejně utne (a nedostane jen obecné 413).
    if (file.size > NAHRAVANI_MAX_B) {
      toast.error(
        `Video má ${vMB(file.size)}, maximum je ${NAHRAVANI_MAX_MB} MB. Zmenšete ho a zkuste to znovu.`,
      );
      return;
    }
    const rizeni = new AbortController();
    zruseniVidea.current = rizeni;
    setProcenta(0);
    setUploadingVideo(true);
    try {
      await api.uploadVideo(displayId, slide.n, file, {
        signal: rizeni.signal,
        onProgress: setProcenta,
      });
      await reload();
      toast.success("Video nahráno");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        // Zrušený upload nic nepřepsal, na slidu zůstalo původní video.
        toast.error("Nahrávání videa zrušeno, nic se nezměnilo.");
      } else {
        toast.error(e instanceof Error ? e.message : "Upload videa selhal.");
      }
    } finally {
      zruseniVidea.current = null;
      setUploadingVideo(false);
    }
  }

  const [smazatVideo, setSmazatVideo] = useState(false);

  async function removeVideo() {
    setSmazatVideo(false);
    await withBusy(async () => {
      await api.deleteVideo(displayId, slide.n);
      await reload();
      toast.success("Video odebráno");
    }, "Odebrání videa selhalo.");
  }

  return (
    <div className="space-y-4">
      <input
        ref={videoInput}
        type="file"
        accept="video/mp4"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) uploadVideoFile(f);
          e.target.value = "";
        }}
      />

      {uploadingVideo && (
        <div className="rounded-xl border border-line bg-canvas px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-fg tnum">
              Nahrávám video {procenta} %
            </span>
            <button
              onClick={() => zruseniVidea.current?.abort()}
              className="btn-ghost px-2.5 py-1 text-xs"
            >
              Zrušit nahrávání
            </button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
            <div className="h-full bg-accent transition-all" style={{ width: `${procenta}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-fg-muted">
            Dokud nahrávání nedoběhne, zůstává na slidu původní video.
          </p>
        </div>
      )}

      {slide.video ? (
        <div className="space-y-3">
          <video key={slide.video} src={slide.video} controls className="w-full rounded-lg border border-line bg-black" />
          <div className="flex items-center gap-3">
            <button onClick={() => videoInput.current?.click()} disabled={uploadingVideo || busy} className="btn-ghost">
              {uploadingVideo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" strokeWidth={1.75} />}
              Nahradit video
            </button>
            <button
              onClick={() => setSmazatVideo(true)}
              disabled={busy}
              className="btn-ghost text-danger hover:text-danger hover:border-danger/40"
            >
              <X className="h-4 w-4" strokeWidth={1.75} /> Odebrat video
            </button>
          </div>
          {/* Formát musí být vidět i tady, ne jen na prázdném poli: kurátor,
              který video nahrazuje, prázdnou výzvu nikdy neuvidí. */}
          <p className="text-xs text-fg-muted">{VIDEO_FORMAT}</p>
        </div>
      ) : (
        <button
          onClick={() => videoInput.current?.click()}
          disabled={uploadingVideo}
          className="w-full rounded-xl border-2 border-dashed border-line p-8 text-center hover:border-accent/60 hover:bg-canvas transition disabled:opacity-60"
        >
          {uploadingVideo ? (
            <Loader2 className="h-7 w-7 mx-auto text-accent animate-spin" />
          ) : (
            <Film className="h-7 w-7 mx-auto text-fg-dim" strokeWidth={1.5} />
          )}
          <p className="mt-2 text-sm font-medium text-fg-muted">Nahrát video</p>
          <p className="text-xs text-fg-muted">Klikněte a vyberte soubor. {VIDEO_FORMAT}</p>
        </button>
      )}

      <Confirm
        open={smazatVideo}
        titulek="Smazat video?"
        text={
          <>
            Video se smaže z disku. Vrátit to nepůjde, bude ho potřeba nahrát znovu a znovu počkat
            na upload.
          </>
        }
        potvrdit="Smazat video"
        onPotvrdit={removeVideo}
        onZrusit={() => setSmazatVideo(false)}
      />
    </div>
  );
}

// --- Galerie (_vid): fotky i videa v jedné řadě ---
//
// Na disku je to jedna číslovaná sekvence (01.jpg, 02.mp4, 03.png…) a Unity
// ji řadí ABECEDNĚ, takže pořadí položek = pořadí nahrání. Čísla i jednotnou
// šířku hlídá server, kurátor je nikde nezadává.

// Nahrávání do galerie: fotky i videa jedním dropzonem. Fotky jdou přes
// stejný endpoint jako všude jinde, videa přes XHR kvůli procentům (u stovek
// MB je kolečko bez čísla k ničemu). Průběh je po souborech, u právě
// nahrávaného videa navíc v procentech.
function useGalerieUpload(displayId: string, n: number, reload: () => Promise<void>) {
  const toast = useToast();
  const [prubeh, setPrubeh] = useState<{ hotovo: number; celkem: number } | null>(null);
  const [procenta, setProcenta] = useState<number | null>(null);
  const zruseni = useRef<AbortController | null>(null);

  const upload = async (files: FileList | File[]) => {
    const vsechny = Array.from(files);
    const list = vsechny.filter(
      (f) => f.type.startsWith("image/") || f.type === "video/mp4" || /\.mp4$/i.test(f.name),
    );
    if (list.length === 0) {
      toast.error("Přetáhněte prosím fotky nebo videa ve formátu MP4.");
      return;
    }
    const preskocene = vsechny.length - list.length;

    // Pořadí v galerii = pořadí nahrání, proto se soubory z prohlížeče řadí
    // podle názvu: u výběru víc souborů najednou není pořadí zaručené.
    list.sort((a, b) => a.name.localeCompare(b.name, "cs", { numeric: true }));

    // Limit videa hlídáme ještě před odesláním, ať kurátor nečeká na upload,
    // který server stejně utne (a nedostane jen obecné 413).
    const velke = list.find((f) => !f.type.startsWith("image/") && f.size > NAHRAVANI_MAX_B);
    if (velke) {
      toast.error(
        `Video ${velke.name} má ${vMB(velke.size)}, maximum je ${NAHRAVANI_MAX_MB} MB. Zmenšete ho a zkuste to znovu.`,
      );
      return;
    }

    const rizeni = new AbortController();
    zruseni.current = rizeni;
    setPrubeh({ hotovo: 0, celkem: list.length });

    let hotovo = 0;
    let zruseno = false;
    let chyba: string | null = null;

    for (const file of list) {
      try {
        if (file.type.startsWith("image/")) {
          await api.uploadImage(displayId, n, file, rizeni.signal);
        } else {
          setProcenta(0);
          await api.uploadVideo(displayId, n, file, {
            signal: rizeni.signal,
            onProgress: setProcenta,
          });
          setProcenta(null);
        }
        hotovo++;
        setPrubeh({ hotovo, celkem: list.length });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") zruseno = true;
        else chyba = `${file.name}: ${e instanceof Error ? e.message : "upload selhal"}`;
        break;
      }
    }

    zruseni.current = null;
    setPrubeh(null);
    setProcenta(null);
    await reload(); // ať je hned vidět, co se stihlo nahrát

    // Přerušený upload se nesmí spolknout: kurátor musí vědět, kolik souborů
    // na disku opravdu je. Počet se bere ze serveru, ne z počítadla: zrušení
    // nezastaví soubor, který už odešel.
    if (zruseno || chyba) {
      let naDisku = hotovo;
      try {
        const d = await api.display(displayId);
        naDisku = d.slides.find((x) => x.n === n)?.media.length ?? hotovo;
      } catch {
        // nepodařilo se přečíst stav, zůstane počítadlo z klienta
      }
      const kolik = `Z ${list.length} vybraných se nenahrály všechny, v galerii je teď ${naDisku} položek.`;
      toast.error(zruseno ? `Nahrávání zrušeno. ${kolik}` : `Upload selhal u ${chyba} ${kolik}`);
      return;
    }

    const zaklad =
      list.length === 1 ? "Položka nahrána" : `${pocetPolozek(list.length)} nahráno`;
    toast.success(
      preskocene
        ? `${zaklad}. ${preskocene === 1 ? "Jeden soubor" : `${preskocene} souborů`} se přeskočil, galerie bere jen fotky a MP4.`
        : zaklad,
    );
  };

  const zrus = () => zruseni.current?.abort();
  return { uploading: prubeh !== null, prubeh, procenta, upload, zrus };
}

function pocetPolozek(n: number): string {
  if (n === 1) return "1 položka";
  if (n >= 2 && n <= 4) return `${n} položky`;
  return `${n} položek`;
}

function GalerieEditor({
  slide,
  displayId,
  busy,
  reload,
  withBusy,
  onSend,
  zeptejSe,
}: {
  slide: SlideContent;
  displayId: string;
  busy: boolean;
  reload: () => Promise<void>;
  withBusy: (fn: () => Promise<void>, fail: string) => Promise<void>;
  onSend: () => Promise<void>;
  zeptejSe: (popis: ReactNode, akce: () => Promise<void>) => void;
}) {
  const toast = useToast();
  const vyrez = useVyrez(displayId, slide, reload);
  const { uploading, prubeh, procenta, upload, zrus } = useGalerieUpload(displayId, slide.n, reload);
  const [smazatPolozku, setSmazatPolozku] = useState<MediaPolozka | null>(null);
  const [chybiObsah, setChybiObsah] = useState(false);

  const fotek = slide.media.filter((m) => m.typ === "foto").length;
  const videi = slide.media.length - fotek;

  async function removeItem(polozka: MediaPolozka) {
    setSmazatPolozku(null);
    await withBusy(async () => {
      await api.deleteMedia(displayId, slide.n, polozka.nazev);
      await reload();
      toast.success("Položka odebrána, galerie přečíslována");
    }, "Odebrání položky selhalo.");
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <span className="label">Fotky a videa galerie</span>
        <p className="text-xs text-fg-muted -mt-1">
          {SDILENE_HLASKA} Fotky i videa se na tabletu střídají v tom pořadí, v jakém jsou
          tady. Nahrané položky se ukládají pod čísly <span className="font-mono">01</span>,{" "}
          <span className="font-mono">02</span>… a po smazání se zbytek sám přečísluje, takže
          v řadě nezůstane díra. Vybírat můžete víc souborů najednou, seřadí se podle názvu.
        </p>
      </div>

      <PhotoDropzone
        uploading={uploading}
        prubeh={prubeh}
        onZrus={zrus}
        onFiles={upload}
        accept="image/*,video/mp4"
        popis={`Fotky JPG nebo PNG a videa MP4 (H.264), do ${NAHRAVANI_MAX_MB} MB. Jiný formát videa se nenahraje.`}
      />

      {/* Procenta jen u videa; fotky odejdou tak rychle, že by se ukazatel
          jen mihl a mátl. */}
      {procenta !== null && (
        <div className="rounded-xl border border-line bg-canvas px-4 py-3">
          <span className="text-sm font-semibold text-fg tnum">Nahrávám video {procenta} %</span>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
            <div className="h-full bg-accent transition-all" style={{ width: `${procenta}%` }} />
          </div>
        </div>
      )}

      {slide.media.length > 0 ? (
        <>
          <div className="text-xs text-fg-muted tnum">
            {pocetPolozek(slide.media.length)} v galerii
            {fotek > 0 && videi > 0 ? ` (${pocetFotek(fotek)}, ${videi === 1 ? "1 video" : `${videi} videí`})` : ""}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {slide.media.map((m, i) => (
              <div
                key={m.url}
                className="group relative aspect-square rounded-lg overflow-hidden bg-canvas ring-1 ring-line"
              >
                {m.typ === "video" ? (
                  // Náhled bez ovládání a bez autoplay: v mřížce jde jen
                  // o to poznat, který záběr to je.
                  <video src={m.url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                ) : (
                  <img
                    src={vyrez.src(m.url, m.nazev)}
                    alt={`Položka ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                )}
                {/* Video se takhle oříznout nedá (muselo by se překódovat),
                    odznak i tlačítko proto patří jen fotkám. */}
                {m.typ === "foto" && vyrez.lzeOrezat && !vyrez.oriznuta(m.nazev) && (
                  <span className="absolute left-1 top-7 chip bg-amber text-white text-[10px] px-1.5 py-0.5">
                    neoříznuto
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white tnum">
                  {m.nazev}
                </span>
                {m.typ === "video" && (
                  <span className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded bg-black/55">
                    <Film className="h-3.5 w-3.5 text-white" strokeWidth={2} />
                  </span>
                )}
                <div className={`${OVLADANI_LISTA} justify-between`}>
                  {m.typ === "foto" && vyrez.lzeOrezat ? (
                    <button
                      onClick={() => vyrez.otevri(m.nazev)}
                      disabled={busy}
                      className={OVLADANI_TLACITKO}
                      title="Upravit výřez"
                      aria-label="Upravit výřez fotky"
                    >
                      <Crop className="h-5 w-5" strokeWidth={2} />
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    onClick={() => setSmazatPolozku(m)}
                    disabled={busy}
                    className={OVLADANI_SMAZAT}
                    title="Smazat položku"
                    aria-label={`Smazat položku ${m.nazev}`}
                  >
                    <Trash2 className="h-5 w-5" strokeWidth={2} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <PrazdnyStav
          ikona={ImageIcon}
          text="Galerie je zatím prázdná"
          hint="Nahrajte fotky a videa, tablet je bude střídat v pořadí, v jakém je nahrajete."
        />
      )}

      {chybiObsah && slide.media.length === 0 && (
        <p className="text-sm text-danger">
          Ještě chybí nahrát: <span className="font-semibold">aspoň jednu fotku nebo video</span>.
          Prázdný slide nejde označit za hotový.
        </p>
      )}
      <button
        onClick={() => {
          if (slide.media.length === 0) {
            setChybiObsah(true);
            toast.error("Ještě chybí nahrát: aspoň jednu fotku nebo video.");
            return;
          }
          setChybiObsah(false);
          zeptejSe(
            <>
              Označí se jako hotový slide{" "}
              <strong className="font-semibold text-fg">Galerie</strong> displeje {displayId}
              {", "}
              {pocetPolozek(slide.media.length)}.
            </>,
            onSend,
          );
        }}
        className="btn-primary w-fit"
        disabled={busy}
      >
        <Send className="h-4 w-4" strokeWidth={1.75} /> Označit jako hotové
      </button>
      <p className="text-xs text-fg-muted">
        Položky jsou uložené hned po nahrání. {VYZVEDNE_SI_SAM} Tlačítkem se do auditu zapíše,
        že je slide hotový.
      </p>

      {vyrez.dialog}

      <Confirm
        open={!!smazatPolozku}
        titulek={smazatPolozku?.typ === "video" ? "Smazat video?" : "Smazat fotku?"}
        text={
          <>
            Položka <span className="font-mono">{smazatPolozku?.nazev}</span> se smaže z disku
            a galerie se přečísluje. Vrátit to nepůjde, bude ji potřeba nahrát znovu.
          </>
        }
        potvrdit="Smazat položku"
        onPotvrdit={() => smazatPolozku && removeItem(smazatPolozku)}
        onZrusit={() => setSmazatPolozku(null)}
      />
    </div>
  );
}

// --- AI slide: prázdná složka, obsah se needituje ---

function AiSlideInfo({ onOpenKb }: { onOpenKb: () => void }) {
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start gap-2.5 border-l-2 border-amber pl-4 py-1">
        <Sparkles className="h-5 w-5 text-amber shrink-0 mt-0.5" strokeWidth={1.75} />
        <div className="text-sm text-fg-muted">
          <span className="font-semibold text-fg">AI slide.</span> Na disku je jen prázdná složka,
          její existence říká tabletu, že má na tomto místě zobrazit AI průvodce. Žádný obsah se sem
          neukládá; podklady pro odpovědi průvodce se editují ve znalostní bázi displeje.
        </div>
      </div>
      <button onClick={onOpenKb} className="btn-amber w-fit">
        <Sparkles className="h-4 w-4" strokeWidth={1.75} /> Otevřít znalostní bázi (AI)
      </button>
    </div>
  );
}

// --- Znalostní báze: kb.md v kořeni displeje, mimo slidy ---
//
// Editor je strukturovaný: kurátor nevidí jeden velký Markdown, ale pole na
// každou sekci. Převod tam i zpět dělá web/src/lib/kbSekce.ts, tenhle soubor
// jen kreslí formulář. Rozepsaný obsah zůstává navenek JEDEN řetězec
// (kbDraft), takže sloučení draftů při přenačtení displeje i hlášení
// „neuloženo" fungují dál beze změny.

// Výška pole podle obsahu. Prázdná sekce má být nízká, ať se devět polí
// vejde na obrazovku; sekce, do které spadl přenesený text ze staré KB, má
// být vidět celá, jinak ji kurátor luští čtyřřádkovým okýnkem.
function radkyPodleObsahu(text: string, nejmene: number, nejvic: number): number {
  const pocet = text ? text.split("\n").length : 0;
  return Math.min(Math.max(nejmene, pocet + 1), nejvic);
}

function KbPoleSekce({
  nadpis,
  napoveda,
  hodnota,
  onChange,
}: {
  nadpis: string;
  napoveda: string;
  hodnota: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{nadpis}</label>
      <p className="mb-1.5 text-xs text-fg-muted">{napoveda}</p>
      <textarea
        className="input resize-y text-[13px] leading-relaxed"
        rows={radkyPodleObsahu(hodnota, 4, 20)}
        value={hodnota}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Prázdné pole se do kb.md nezapíše."
      />
    </div>
  );
}

function KbEditor({
  cekaNaRevizi,
  jazyk,
  referenceCs,
  value,
  onChange,
  onSave,
  saving,
  neulozeno,
  ulozenoCas,
}: {
  cekaNaRevizi: boolean;
  jazyk: Jazyk;
  referenceCs: string | null;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  neulozeno: boolean;
  ulozenoCas: string | null;
}) {
  const toast = useToast();
  const [zbytkyOpen, setZbytkyOpen] = useState<string[] | null>(null);

  // Pravdou během psaní jsou rozdělená pole, ne složený text. Kdyby se
  // skládalo a znovu parsovalo při každém úhozu, rozsekal by se kurátorovi
  // text pod rukama ve chvíli, kdy do pole napíše řádek začínající „## ".
  const [stav, setStav] = useState<RozdelenaKb>(() => rozdelKb(value));
  // Poslední text, který z tohohle editoru vyšel. Cokoli jiného přišlo
  // zvenčí (přenačtení displeje, přepnutí jazyka) a pole se přerovnají.
  const posledniSlozeno = useRef(value);
  // Stav i mimo render. Dvě změny těsně za sebou (rychlé psaní, vložení do
  // dvou polí po sobě) by se jinak počítaly z téhož renderu a ta první by
  // se ztratila: druhý handler by složil kb.md ze stavu, který ji ještě
  // nemá. Ověřeno, stalo se to.
  const stavRef = useRef(stav);

  useEffect(() => {
    if (value === posledniSlozeno.current) return;
    const nove = rozdelKb(value);
    stavRef.current = nove;
    setStav(nove);
    posledniSlozeno.current = value;
  }, [value]);

  function posli(uprav: (predchozi: RozdelenaKb) => RozdelenaKb) {
    const novy = uprav(stavRef.current);
    stavRef.current = novy;
    setStav(novy);
    const slozeno = slozKb(novy);
    posledniSlozeno.current = slozeno;
    onChange(slozeno);
  }

  function zmenSekci(klic: string, text: string) {
    posli((p) => ({ ...p, pole: { ...p.pole, [klic]: text } }));
  }

  // Před uložením zkontroluj, jestli v textu nezůstaly kusy šablony. Chatbot
  // by je vydával za fakta o druhu, takže na ně upozorníme, ale uložení
  // neblokujeme, kurátor může mít důvod.
  function ulozitSKontrolou() {
    if (jePrazdna(stavRef.current)) {
      toast.error("Znalostní báze je prázdná. Vyplňte aspoň jednu sekci.");
      return;
    }
    const zbytky = zbytkySablony(slozKb(stavRef.current));
    if (zbytky.length > 0) {
      setZbytkyOpen(zbytky);
      return;
    }
    onSave();
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start gap-2.5 border-l-2 border-amber pl-4 py-1">
        <Sparkles className="h-5 w-5 text-amber shrink-0 mt-0.5" strokeWidth={1.75} />
        <div className="text-sm text-fg-muted">
          <span className="font-semibold text-fg">Znalostní báze displeje.</span> Není to slide,
          čte ji AI průvodce (chatbot) na tabletu. Píšete po sekcích, CMS z nich složí soubor
          kb.md v kořeni složky displeje. Sekci, kterou nevyplníte, do souboru vůbec nezapíšeme.
          {cekaNaRevizi && (
            <>
              {" "}
              <strong className="font-semibold text-fg">
                Tenhle text napsala AI a nikdo ho zatím nezkontroloval.
              </strong>{" "}
              Přečtěte ho celý, návštěvníkům se z něj odpovídá na dotazy o živém zvířeti. Až
              budete hotoví, schvalte ho tlačítkem nahoře u displeje; uložení textu samo o sobě
              za schválení neplatí.
            </>
          )}
        </div>
      </div>

      {/* Co se při rozdělení souboru nepovedlo zařadit. Kurátor to musí vidět:
          obsah se neztratil, ale leží jinde, než by čekal. */}
      {stav.poznamky.length > 0 && (
        <div className="rounded-lg border border-amber/40 bg-amber/5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <AlertTriangle className="h-4 w-4 text-amber" strokeWidth={1.75} />
            Při otevření souboru jsme narazili na tohle
          </div>
          <ul className="mt-2 space-y-1 pl-6">
            {stav.poznamky.map((p) => (
              <li key={p} className="list-disc text-sm text-fg-muted">
                {p}
              </li>
            ))}
          </ul>
          <p className="mt-2 pl-6 text-xs text-fg-muted">
            Nic se neztratilo. Text najdete níž v polích; přesuňte ho, kam patří, a uložte.
          </p>
        </div>
      )}

      {/* Metodika je schválně mimo textová pole: co je v poli, to se uloží do
          kb.md a chatbot to vydá za fakta o druhu. */}
      <details className="rounded-lg border border-line bg-canvas px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold text-fg">
          Jak psát znalostní bázi (nápověda)
        </summary>
        <div className="mt-3 space-y-3">
          {KB_METODIKA.map((sekce) => (
            <div key={sekce.nadpis}>
              <div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                {sekce.nadpis}
              </div>
              <ul className="mt-1 space-y-1">
                {sekce.body.map((radek) => (
                  <li key={radek} className="flex gap-2 text-sm text-fg-muted">
                    <span className="text-fg-dim">•</span>
                    <span>{radek}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>

      {jazyk !== "cs" && !value.trim() && <CeskyOriginal text={referenceCs} />}

      <div>
        <label className="label">Úvod (nad sekcemi)</label>
        <p className="mb-1.5 text-xs text-fg-muted">
          Nadpis souboru a případná úvodní věta. Obvykle stačí „# Znalostní báze: název druhu“.
        </p>
        <textarea
          className="input resize-y font-mono text-[13px] leading-relaxed"
          rows={radkyPodleObsahu(stav.preambule, 2, 8)}
          value={stav.preambule}
          onChange={(e) => {
            const text = e.target.value;
            posli((p) => ({ ...p, preambule: text }));
          }}
          placeholder="# Znalostní báze: název druhu"
        />
      </div>

      {SEKCE.map((sekce) => (
        <KbPoleSekce
          key={sekce.klic}
          nadpis={sekce.nadpis}
          napoveda={sekce.napoveda}
          hodnota={stav.pole[sekce.klic] ?? ""}
          onChange={(v) => zmenSekci(sekce.klic, v)}
        />
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={ulozitSKontrolou} className="btn-primary w-fit" disabled={saving}>
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" strokeWidth={1.75} />
          )}
          Uložit znalostní bázi
        </button>
        <StavUlozeni neulozeno={neulozeno} ulozenoCas={ulozenoCas} />
      </div>
      <p className="text-xs text-fg-muted">
        Znalostní bázi si načítá chatbot sám, na tablet nejde, proto tu druhé tlačítko není.
      </p>

      {/* Zbytky šablony v textu: chatbot je nerozliší od faktů o druhu. */}
      <Confirm
        open={!!zbytkyOpen}
        titulek="V textu zůstaly kusy šablony"
        text={
          <>
            Chatbot bere obsah kb.md jako fakta o tomhle druhu, takže by pokyny i ukázky
            vydával za pravdu. Našli jsme:
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {zbytkyOpen?.map((z) => (
                <li key={z}>{z}</li>
              ))}
            </ul>
          </>
        }
        potvrdit="Uložit i tak"
        onPotvrdit={() => {
          setZbytkyOpen(null);
          onSave();
        }}
        onZrusit={() => setZbytkyOpen(null)}
      />
    </div>
  );
}
