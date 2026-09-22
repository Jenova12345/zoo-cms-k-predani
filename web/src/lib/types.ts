// Jazyky pavilonu. Zrcadlí server/src/displays.ts.
export const JAZYKY = ["cs", "en", "pl"] as const;
export type Jazyk = (typeof JAZYKY)[number];

export const JAZYK_LABEL: Record<Jazyk, string> = {
  cs: "Čeština",
  en: "English",
  pl: "Polski",
};

// Pole info panelu, která kurátor píše v každém jazyce zvlášť. Ostatní
// (Sekce, Latinsky) jsou společná a zadávají se jen v češtině.
export const PREKLADANA_POLE = [
  "Nazev",
  "Strava",
  "Velikost",
  "DobaLihnuti",
  "Ohrozeni",
  "DelkaZivota",
] as const;

export function jePrekladane(klic: string): boolean {
  return (PREKLADANA_POLE as readonly string[]).includes(klic);
}

export interface StavJazyka {
  jazyk: Jazyk;
  celkem: number;
  chybi: number;
  hotovo: boolean;
}

// Živý stav tabletu u expozice. Počítá ho server z tepu, který tablet posílá
// každou minutu (server/src/tep.ts):
//   online    tep přišel před méně než 3 minutami
//   vypadava  3 až 15 minut ticho, nejčastěji vypadlá wi-fi
//   offline   přes 15 minut ticho, bereme za vypnutý
//   neznamy   server běží krátce a tablet se ještě nestihl ozvat
export type StavZarizeni = "online" | "vypadava" | "offline" | "neznamy";

export const STAV_ZARIZENI_LABEL: Record<StavZarizeni, string> = {
  online: "online",
  vypadava: "vypadává",
  offline: "offline",
  neznamy: "zatím se neozval",
};

export interface DisplaySummary {
  id: string;
  druh: string;
  jazyky: Record<Jazyk, boolean>; // které jazyky jsou hotové
  category: string | null; // sekce z meta.json (kvůli filtru v přehledu)
  latin_name: string | null; // párování s analytikou chatbota (species_latin)
  cekaNaRevizi: boolean; // AI koncept z hromadného importu, kurátor ho ještě neviděl
  stav: StavZarizeni; // živý stav zařízení, ne pole ze souboru
  naposledy: string | null; // ISO čas posledního tepu
  verze: string | null; // verze aplikace na tabletu
  posledniZmena: string; // poslední změna obsahu, se stavem zařízení nesouvisí
  thumbnail: string | null;
}

// Typ slidu = suffix názvu složky na disku (<n>_<typ>), pořadí = číselný
// prefix. Cílová struktura má pět typů. Pozor na dva suffixy, jejichž název
// neodpovídá obsahu (zůstaly kvůli tomu, že je tak čte Unity):
//   "gal" NENÍ galerie, ale TEXTOVÝ slide (dva texty + taxonomie + fotka),
//   "vid" NENÍ jen video, ale GALERIE fotek i videí dohromady.
// Typ "3d" má na disku suffix _3d nebo _mod, server čte obojí. Typ "txt"
// (obecné informace) je pozůstatek: nový už nejde založit, existující se
// dál čtou a editují. Zrcadlí server/src/displays.ts.
export type SlideTyp = "info" | "ai" | "3d" | "vid" | "gal" | "txt";

export interface DisplayMeta {
  druh: string;
  name?: string; // = Nazev (identifikace pro chatbota)
  latin_name?: string; // kanonizované latinské jméno (chatbot podle něj páruje)
  category?: string; // = Sekce (zóna expozice)
  section?: string; // taxonomická čeleď, např. Dendrobatidae
  // Obsah je AI koncept z hromadného importu a čeká na kontrolu kurátora.
  // Ruší se uložením znalostní báze (viz server/src/displays.ts, writeKb).
  cekaNaRevizi?: boolean;
  stav: "online" | "offline";
  posledniZmena: string;
  slidy?: { slozka: string; typ: SlideTyp }[];
}

// Jedna položka galerie (_vid). Fotky a videa jsou na disku promíchané
// v jedné číslované řadě, takže se přenášejí i s typem.
export interface MediaPolozka {
  nazev: string; // název souboru na disku (01.jpg), kvůli mazání
  url: string;
  typ: "foto" | "video";
}

export interface SlideContent {
  n: number; // číselný prefix složky slidu
  typ: SlideTyp;
  slozka: string; // název složky na disku (u 3D modelu i varianta <n>_mod)
  // info: obsah text.txt ("Klic: Hodnota"); gal: dva texty + rozpadlá
  // taxonomie (Trida, Rad, Celed); txt: dva texty
  pole: Record<string, string>;
  obrazky: string[]; // URL fotek (info: fotky; gal: jedna; 3d: sekvence snímků)
  media: MediaPolozka[]; // jen vid: fotky i videa v pořadí, jak je řadí Unity
  mapa: string | null; // jen info: URL mapa.png
  video: string | null; // jen info: volitelné video (galerie má `media`)
  // Poměr, ve kterém Unity fotky tohohle slidu zobrazuje ("772:800").
  // null = tenhle typ se neořezává, editor výřezu se u něj nenabízí.
  pomerVyrezu: string | null;
  // Navolené výřezy podle názvu souboru. Co tu chybí, nikdo neořezával —
  // u toho se v CMS ukáže odznak „neoříznuto".
  vyrezy: Record<string, Vyrez>;
  // Jen 3D: sekvence má JEDEN výřez pro všechny snímky (objekt se otáčí,
  // výřez musí sedět na celou otáčku), takže odznak je na celé řadě.
  vyrezSekvence: Vyrez | null;
}

// Průběh hromadného ořezu sekvence 360. `bezi: false` bez chyby = hotovo.
export interface StavOrezuSekvence {
  bezi: boolean;
  hotovo: number;
  celkem: number;
  chyba: string | null;
}

// Výřez fotky v podílech 0..1 vůči originálu (ne v pixelech, ať přežije
// zmenšení fotky při nahrání). Zrcadlí server/src/vyrez.ts.
export interface Vyrez {
  x: number;
  y: number;
  w: number;
  h: number;
}

// "772:800" → 0.965. Poměr posíláme jako text, ať je v UI co ukázat.
export function pomerNaCislo(popis: string): number | null {
  const m = /^(\d+):(\d+)$/.exec(popis.trim());
  if (!m) return null;
  const sirka = Number(m[1]);
  const vyska = Number(m[2]);
  return vyska > 0 ? sirka / vyska : null;
}

export interface DisplayDetail {
  id: string;
  meta: DisplayMeta;
  slides: SlideContent[];
  kb: string; // znalostní báze kb.md v kořeni displeje
  jazyk: Jazyk; // jazyk, ve kterém je obsah v této odpovědi
  jazyky: StavJazyka[]; // co v kterém jazyce chybí
}

export interface AuditEntry {
  cas: string;
  uzivatel: string; // účet
  // Jméno vybrané po přihlášení. ZOO jede pod jedním sdíleným účtem, takže
  // teprve tohle řekne, kdo akci udělal. Záznamy zapsané dřív ho nemají.
  jmeno?: string;
  akce: string;
  cil: string;
}

// Jméno v seznamu lidí, kteří pod sdíleným účtem pracují (data/jmena.json).
export interface Jmeno {
  jmeno: string;
  pridano: string; // ISO datum
  pridalUcet: string;
}

// --- Analytika návštěvnosti ---
// Zrcadlí server/src/analytika.ts. Server posílá hotová čísla, klient nic
// nepočítá: agregace roku logů nemá co dělat v prohlížeči.

export type Granularita = "den" | "tyden" | "mesic";

export interface BodGrafu {
  klic: string;
  popis: string; // krátký popisek na osu ("21. 9.", "zář 26")
  relaci: number;
}

export interface SouhrnObdobi {
  relaci: number;
  zobrazeni: number;
  prumernaDobaS: number | null; // doba u displeje = rozpětí jedné relace
  aiZobrazeni: number; // otevření AI slidu
}

export interface RadekZebricku {
  displej: number;
  druh: string | null;
  relaci: number;
  zobrazeni: number;
  prumernaDobaS: number | null;
}

export interface RadekTypu {
  typ: string;
  znamy: boolean;
  zobrazeni: number;
  prumernaDobaS: number | null;
}

export interface AnalytikaNavstevnosti {
  od: string;
  do: string;
  granularita: Granularita;
  body: BodGrafu[];
  celkem: SouhrnObdobi;
  porovnani: { od: string; do: string; celkem: SouhrnObdobi } | null;
  displeje: RadekZebricku[];
  typySlidu: RadekTypu[];
  kvalita: {
    poskozeneRadky: number;
    zahozenaTrvani: number;
    neznameTypy: string[];
    displejuSData: number;
    displejuCelkem: number;
    mimoZebricek: number[];
  };
}

// Popisky typů slidů. Klíče jsou typy CMS; co v mapě není, přišlo
// z tabletu v neznámé podobě a ukáže se tak, jak přišlo.
export const TYP_SLIDU_LABEL: Record<string, string> = {
  info: "Infopanel",
  gal: "Informace",
  vid: "Galerie",
  "3d": "3D model",
  ai: "AI otázky",
  txt: "Text (starší)",
};

// --- Události z tabletů (Michalovo Unity) ---
// Tvar odpovídá server/src/udalosti.ts.

// Období přehledu. Server posílá každé číslo pro všechna tři naráz, takže
// přepnutí období v dashboardu nestojí další dotaz.
// `den` = od dnešní půlnoci, `tyden` a `mesic` = posledních 7 a 30 dní.
export type Obdobi = "den" | "tyden" | "mesic";

export interface PodleObdobi<T> {
  den: T;
  tyden: T;
  mesic: T;
}

export interface StavDispleje {
  displej: number;
  navstevy: PodleObdobi<number>;
  prumernaDobaS: PodleObdobi<number | null>;
  posledniUdalost: string | null;
  tichy: boolean;
}

export interface StavTypuSlidu {
  typ: string;
  znamy: boolean;
  otevreni: PodleObdobi<number>;
  prumernaDobaS: PodleObdobi<number | null>;
}

export interface PrehledUdalosti {
  od: string;
  do: string;
  maData: boolean;
  celkem: PodleObdobi<{ relaci: number; udalosti: number }>;
  displeje: StavDispleje[];
  typySlidu: StavTypuSlidu[];
  ticheDispleje: number[];
  kvalita: { poskozeneRadky: number; zahozenaTrvani: number; neznameTypy: string[] };
}

// --- Analytika chatbota (Danielův backend) ---
// Tvar podle jeho kontraktu; k nám to chodí přes náš proxy endpoint
// /api/analytics/... (viz server/src/analytics.ts), který zaručí, že chybějící
// pole ani nedostupný backend dashboard neshodí.

export interface AnalyticsQuestion {
  timestamp: string;
  session_id: string;
  display_id: number | null; // může být null, druh párujeme přes species_latin
  species_latin: string;
  species_name: string;
  user_message: string;
  answered: boolean;
  language: string;
  mode: string;
}

export interface AnalyticsQuestions {
  questions: AnalyticsQuestion[];
  total: number;
  since: string;
}

export interface AnalyticsSpecies {
  species_latin: string;
  species_name: string;
  display_id: number | null;
  count: number;
}

export interface AnalyticsSummary {
  since: string;
  total_questions: number;
  answered: number;
  unanswered: number;
  per_species: AnalyticsSpecies[];
}

// Buď data, nebo důvod, proč nejsou, chatbot backend nemusí běžet.
export type Analytika<T> = { dostupne: true; data: T } | { dostupne: false; duvod: string };

export const NEPRIRAZENO = "Nepřiřazeno";

// Sekce expozice pro rozbalovátko info panelu. Zrcadlí server/src/displays.ts,
// stejně jako ostatní sdílené konstanty v tomhle souboru.
export interface SekceDef {
  cislo: number; // číslo tématu na oficiální tabuli i na podlaze pavilonu
  cs: string;
  en: string;
  pl: string;
}

// Témata (sekce) pavilonu podle oficiální tabule od Michala.
//
// Do cs/<slide>/text.txt a do meta.json.category se zapisuje POUZE český
// název (`cs`). Překlady jsou zatím jen pro CMS: kontrakt s Unity ani
// s chatbotem se nemění, oba dál čtou jeden řetězec.
export const SEKCE_TEMATA: SekceDef[] = [
  {
    cislo: 1,
    cs: "Červoři — záhadní obojživelníci",
    en: "Caecilians — Mysterious Amphibians",
    pl: "Płazy beznogie — tajemnicze stworzenia",
  },
  {
    cislo: 2,
    cs: "Rozmanitost žab",
    en: "Diversity of Frogs",
    pl: "Różnorodność żab",
  },
  {
    cislo: 3,
    cs: "Pralesničky — jedovaté krásky",
    en: "Poison Dart Frogs — Poisonous Beauties",
    pl: "Drzewołazy — trujące piękności",
  },
  {
    cislo: 4,
    cs: "Šesté vymírání",
    en: "The Sixth Extinction",
    pl: "Szóste wymieranie",
  },
  {
    cislo: 5,
    cs: "Historie obojživelníků — přechod obratlovců z vody na souš",
    en: "History of Amphibians — the Transition of Vertebrates from Water to Land",
    pl: "Historia płazów — wyjście kręgowców z wody na ląd",
  },
  {
    cislo: 6,
    cs: 'Lezci — novodobí "obojživelníci"',
    en: 'Mudskippers — Modern-day "Amphibians"',
    pl: 'Poskoczki — współczesne "płazy"',
  },
  {
    cislo: 7,
    cs: "Madagaskar — žabí ráj",
    en: "Madagascar — Frog Paradise",
    pl: "Madagaskar — raj dla żab",
  },
  {
    cislo: 8,
    cs: "Listovnice — královny noci",
    en: "Leaf Frogs — Queens of the Night",
    pl: "Chwytnice — królowe nocy",
  },
  {
    cislo: 9,
    cs: "Caudata — obojživelníci s ocasem",
    en: "Caudata — Amphibians with a Tail",
    pl: "Caudata — płazy ogoniaste",
  },
  {
    cislo: 10,
    cs: "Neotenie — původ moderních obojživelníků",
    en: "Neoteny — the Origin of Modern Amphibians",
    pl: "Neotenia — pochodzenie współczesnych płazów",
  },
  {
    cislo: 11,
    cs: "Obojživelníci České republiky",
    en: "Amphibians of the Czech Republic",
    pl: "Płazy Republiki Czeskiej",
  },
];

// Platné hodnoty pole Sekce (české názvy v pořadí podle čísla tématu).
export const SEKCE = SEKCE_TEMATA.map((s) => s.cs);

// Názvy, pod kterými sekce fungovaly před srovnáním s oficiální tabulí.
// Displeje uložené dřív je mají v text.txt i v meta.json, takže musí dál
// projít validací. Klíč je starý název, hodnota nový.
export const SEKCE_STARE: Record<string, string> = {
  Listovnice: "Listovnice — královny noci",
  Caudata: "Caudata — obojživelníci s ocasem",
  Červoři: "Červoři — záhadní obojživelníci",
  Lezci: 'Lezci — novodobí "obojživelníci"',
  Madagaskar: "Madagaskar — žabí ráj",
  Neotenie: "Neotenie — původ moderních obojživelníků",
  Pralesničky: "Pralesničky — jedovaté krásky",
};

// Porovnávací tvar názvu sekce. Oddělovač mezi hlavním názvem a přívlastkem
// se srazí na obyčejnou mezeru, ať je v uložené hodnotě čárka, em dash, en
// dash nebo spojovník.
//
// Proč: názvy sekcí se přepsaly z „Červoři, záhadní obojživelníci" na
// „Červoři — záhadní obojživelníci", ale displeje uložené dřív mají v
// text.txt i v meta.json pořád čárkovou podobu. Bez tohohle by je kurátor
// nemohl uložit („Neplatná sekce.") a v editoru by se mu rozbalovátko tiše
// přeplo na prázdno. Na disku se nic nepřepisuje, starý tvar se sám nahradí
// novým při prvním uložení displeje.
//
// Ověřeno, že všech jedenáct sekcí zůstává po normalizaci navzájem odlišných.
function porovnavaciTvar(hodnota: string): string {
  return hodnota
    .replace(/\s*[,\u2014\u2013-]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Je hodnota platnou sekcí (nový nebo starý název)?
export function jeSekce(hodnota: string): boolean {
  return najdiSekci(hodnota) !== null;
}

// Sekce podle uložené hodnoty, ať je název starý nebo nový a ať je
// oddělovač čárka, nebo pomlčka.
export function najdiSekci(hodnota: string): SekceDef | null {
  const cs = SEKCE_STARE[hodnota.trim()] ?? hodnota;
  const hledany = porovnavaciTvar(cs);
  return SEKCE_TEMATA.find((s) => porovnavaciTvar(s.cs) === hledany) ?? null;
}

// Pole info panelu: klíč přesně tak, jak se zapisuje do text.txt.
//
// `hint` je nápověda pro kurátora pod polem. Michalovo Unity má pevné
// rozvržení a delší text se na tabletu ořízne, proto má většina polí
// `limitZnaku`.
//
// LIMIT JE TVRDÝ: přes něj se panel neuloží, dokud kurátor text nezkrátí.
// Dřív to bylo jen doporučení (oranžové počítadlo), jenže oříznutý text na
// tabletu nikdo neviděl a do pavilonu se tak dostávaly půlky vět.
// Platí stejně ve všech třech jazycích — vynucuje se v tom poli, ve kterém
// se zrovna edituje, takže delší překlad se neuloží stejně jako delší
// čeština.
export interface InfoPoleDef {
  klic: string;
  label: string;
  povinne: boolean;
  hint: string;
  limitZnaku?: number;
}

// Metadata druhu se na tablet vejdou jen heslovitě: jeden krátký řádek
// v mřížce vedle fotky. Limit má každý údaj vlastní, protože se do nich
// píše různě dlouhý text — strava vyjmenovává víc věcí, doba líhnutí je
// vždycky jen číslo s jednotkou. Hodnoty jsou z provozu v pavilonu, ne
// odhad: sedí na to, co v polích doopravdy stojí.
const METADATA_HINT = "Pište heslovitě, ne větu (např. 3 až 4 cm).";

export const INFO_POLE: InfoPoleDef[] = [
  {
    klic: "Sekce",
    label: "Sekce",
    povinne: true,
    hint: "Vyberte sekci, určuje barvu na tabletu.",
  },
  {
    klic: "Nazev",
    label: "Název",
    povinne: true,
    hint: "Krátký název, vejde se na 1 až 2 řádky.",
    // 45, ne 40: anglický název displeje 12 je „Panamanian Golden Frog —
    // dead frog models" (41 znaků). Jsou to opravdu modely mrtvých žab,
    // takže se ten dovětek škrtnout nedá.
    limitZnaku: 45,
  },
  {
    klic: "Latinsky",
    label: "Latinský název",
    povinne: false,
    hint: "Latinský název, systém ho upraví do správného tvaru.",
    limitZnaku: 40,
  },
  { klic: "Strava", label: "Strava", povinne: false, hint: METADATA_HINT, limitZnaku: 70 },
  { klic: "Velikost", label: "Velikost", povinne: false, hint: METADATA_HINT, limitZnaku: 40 },
  {
    klic: "DobaLihnuti",
    label: "Doba líhnutí",
    povinne: false,
    hint: METADATA_HINT,
    limitZnaku: 20,
  },
  { klic: "Ohrozeni", label: "Ohrožení", povinne: false, hint: METADATA_HINT, limitZnaku: 25 },
  {
    klic: "DelkaZivota",
    label: "Délka života",
    povinne: false,
    hint: METADATA_HINT,
    limitZnaku: 20,
  },
];

// Typy, které kurátor vidí v nabídce „Přidat slide". Pořadí = pořadí
// v nabídce. Schválně tu NEJSOU:
//   txt   pozůstalý typ, existující slidy se dál editují, nový už ne;
//   info  infopanel je na displeji právě jeden a zakládá se s displejem,
//         druhý by na tabletu přebil ten první;
//   ai    slide s AI průvodcem je na displeji taky jen jeden a nic se do
//         něj nevyplňuje.
// Server je v SLIDE_TYPY_NABIDKA pořád přijímá (viz server/src/displays.ts):
// prázdný displej si přes „Přidat Infopanel" musí umět založit ten první.
export const SLIDE_TYPY: SlideTyp[] = ["3d", "vid", "gal"];

export const SLIDE_TYP_LABEL: Record<SlideTyp, string> = {
  info: "Infopanel",
  ai: "AI otázky",
  "3d": "3D model",
  vid: "Galerie",
  gal: "Informace",
  txt: "Obecné informace",
};

// Krátké vysvětlení pro kurátora, co který typ slidu na tabletu dělá
// (nabídka „Přidat slide").
export const SLIDE_TYP_POPIS: Record<SlideTyp, string> = {
  info: "Základní info o druhu: název, strava, velikost a fotky.",
  ai: "Chat s AI průvodcem. Nic se sem nevyplňuje.",
  "3d": "Otočení modelu ze sekvence fotek.",
  vid: "Fotky a videa za sebou, tablet je střídá.",
  gal: "Dva delší texty o druhu, zařazení a jedna fotka.",
  txt: "Dva delší texty o druhu. Bez fotek a videa.",
};

// --- Textový slide (_gal) ---
//
// Dva dlouhé texty a k nim taxonomie po částech. Klíče ObecnyText
// a Zajimavosti čte Unity beze změny, proto se shodují s typem `_txt`.
// Taxonomii server složí do jednoho řádku "Taxonomie: Třída: … | Řád: …
// | Čeleď: …" s popisky v jazyce, ve kterém se slide ukládá.
// Zrcadlí GAL_KLICE a TAXONOMIE_SLOZKY v server/src/displays.ts.

export interface TaxonomiePoleDef {
  klic: string;
  label: string;
  placeholder: string;
}

export const TAXONOMIE_POLE: TaxonomiePoleDef[] = [
  { klic: "Trida", label: "Třída", placeholder: "Např. Obojživelníci" },
  { klic: "Rad", label: "Řád", placeholder: "Např. Žáby" },
  { klic: "Celed", label: "Čeleď", placeholder: "Např. Pralesničkovití" },
];

// Klíč, pod kterým server hlásí nerozpoznaný tvar taxonomie na disku
// (ruční zásah do text.txt). Neukládá se, jen se kurátorovi ukáže.
export const TAXONOMIE_ZBYTEK = "TaxonomieZbytek";

// Je textový slide prázdný? Taxonomie se nepočítá: je nepovinná a slide
// jen s ní by na tabletu zůstal skoro prázdný.
export function galPrazdny(pole: Record<string, string>): boolean {
  return TEXTOVA_POLE.every((def) => !(pole[def.klic] ?? "").trim());
}

// --- Dva dlouhé texty (slide _gal i pozůstalý _txt) ---
// Obě pole se překládají (sdílené s češtinou není nic). Klíče musí sedět na
// server/src/displays.ts (TEXTOVE_KLICE), zapisují se v tomhle tvaru do
// text.txt a Unity je čte beze změny. Textový slide `_gal` k nim přidává
// ještě taxonomii (TAXONOMIE_POLE) a jednu fotku.

export interface TextovePoleDef {
  klic: string;
  label: string;
  hint: string;
  limitSlov: number;
}

export const TEXTOVA_POLE: TextovePoleDef[] = [
  {
    klic: "ObecnyText",
    label: "Obecný text",
    hint: "Souvislý text o druhu, klidně na několik odstavců.",
    limitSlov: 250,
  },
  {
    klic: "Zajimavosti",
    label: "Zajímavosti",
    hint: "Co návštěvníka zaujme. Klidně několik bodů pod sebou.",
    limitSlov: 250,
  },
];

// Je slide obecných informací prázdný? Prázdný slide nejde označit za hotový,
// stejně jako u ostatních typů.
export function textovyPrazdny(pole: Record<string, string>): boolean {
  return TEXTOVA_POLE.every((def) => !(pole[def.klic] ?? "").trim());
}

// --- Displej u deštného pralesa ---
// Samostatný displej: místo obsahu druhu ukazuje prostředí pavilonu a odpočet
// do bouřky z videomappingu. Zrcadlí server/src/prales.ts.

export interface PralesNastaveni {
  teplotaVnitrni: number;
  vlhkost: string;
  teplotaVenkovniZaloha: number;
  bourkaZapnuta: boolean;
  bourkaIntervalMin: number;
  varovaniBlikaniSvetel: boolean;
  varovaniVodniEfekty: boolean;
}

// Plochý JSON pro Unity. Anglické názvy polí jsou z kontraktu, ne z rozmaru.
export interface PralesPayload {
  countdown_seconds: number;
  temperature_internal: number;
  humidity_text: string;
  temperature_external: number;
  current_date: string;
  alert_flashing_lights: boolean;
  alert_water_effects: boolean;
}

export interface PralesPocasi {
  zdroj: "internet" | "zaloha";
  teplota: number | null; // poslední stažená; null = zatím žádná
  ziskano: string | null; // ISO čas posledního úspěšného stažení
  posledniPokus: string | null;
  chyba: string | null;
  zastarale: boolean; // stažená hodnota je starší než hodina
  souradnice: { lat: number; lon: number };
}

export interface PralesStav {
  nastaveni: PralesNastaveni;
  nahled: PralesPayload; // přesně to, co teď dostávají tablety
  pocasi: PralesPocasi;
}

// Meze validace ze serveru (server/src/prales.ts). Tady jen pro hlášky
// a atributy polí; zdroj pravdy je server, který vstup ověřuje znovu.
export const PRALES_TEPLOTA_MIN = -50;
export const PRALES_TEPLOTA_MAX = 60;
export const PRALES_VLHKOST_MAX_ZNAKU = 40;
export const PRALES_INTERVAL_MIN = 1;
export const PRALES_INTERVAL_MAX = 1440;


// --- Videomapping ---
// Dvě instalace v pavilonu, ovládané OSC zprávou přes UDP.
// Zrcadlí server/src/videomapping.ts.

export type VideomappingPovel = "start" | "stop";

// Co jsme z CMS naposledy poslali. NENÍ to stav instalace: UDP doručení
// nepotvrzuje, takže CMS skutečný stav videomappingu nezná. Drží se jen
// v paměti serveru, po jeho restartu je prázdné (historie je v audit logu).
export interface VideomappingPosledni {
  povel: VideomappingPovel;
  odeslano: string; // ISO čas odeslání
  uzivatel: string; // účet
  // Jméno vybrané po přihlášení, jako v auditu. Ukazuje se přednostně —
  // účet sám o sobě neřekne, kdo tlačítko zmáčkl.
  jmeno: string | null;
  ok: boolean;
}

export interface VideomappingInstalace {
  id: string;
  nazev: string; // jak instalaci zná obsluha (WaterSense, Les)
  host: string;
  port: number;
  posledni: VideomappingPosledni | null;
}

export const VIDEOMAPPING_POVEL_LABEL: Record<VideomappingPovel, string> = {
  start: "zapnout",
  stop: "vypnout",
};


// --- Díry v zemi (zapuštěné expoziční prvky) ---
// Nejsou to displeje: jen složka v datovém kořeni s jedním .mp4, které si
// Michalův přehrávač čte přímo z disku. Zrcadlí server/src/diry.ts.

export interface DiraStav {
  id: string;
  nazev: string; // s diakritikou, pro kurátora
  slozka: string; // název složky na disku (bez diakritiky)
  cesta: string; // plná cesta na disku, ať jde zkontrolovat
  soubor: string | null; // název videa, null když ještě nic nenahráno
  velikost: number | null; // v bajtech
  nahrano: string | null; // ISO čas poslední změny souboru
  vicSouboru: string[]; // víc .mp4 ve složce = přehrávač neví, co pustit
}
