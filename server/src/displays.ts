import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { DISPLAYS_DIR, POSLEDNI_DISPLEJ } from "./paths.js";
import { type StavZarizeni, stavDispleje } from "./tep.js";
import {
  type Vyrez,
  doriznSnimek,
  jdeOriznout,
  oriznFotku,
  oriznSekvenci,
  origNazev,
  pomerProTyp,
  popisPomeru,
  prejmenujVyrezy,
  readVyrezSekvence,
  readVyrezy,
  zapomenVyrez,
} from "./vyrez.js";
import { canonicalizeLatin } from "./latin.js";
import { notifyReingest } from "./reingest.js";
import { writeFileAtomic } from "./atomic.js";

// Zdroj pravdy pro Unity je struktura složek na disku. Unity čte typ slidu
// podle SUFFIXU složky, pořadí podle číselného PREFIXU:
//
//   data/displeje/<id>/
//     kb.md                 znalostní báze pro chatbota (NENÍ slide)
//     meta.json             doplněk (druh, stav, poslední změna, přehled slidů)
//     cs/
//       1_info/text.txt     info panel: řádky "Klic: Hodnota" + fotky .png
//       1_info/mapa.png     volitelná mapa výskytu (přesně tento název)
//       1_info/<video>.mp4  volitelné video (Michal ho řadí na začátek galerie)
//       2_ai/               prázdná složka = AI slide
//       3_3d/001.png…       3D model: sekvence snímků, číslovaná od 001
//       4_gal/text.txt      TEXTOVÝ slide: "ObecnyText:", "Zajimavosti:"
//                           a "Taxonomie:" (jeden složený řádek)
//       4_gal/<fotka>.png   textový slide: jedna fotka (na zařízení vpravo)
//       5_vid/01.jpg…       GALERIE: fotky i videa dohromady, číslovaná
//                           sekvenčně s vodící nulou (Unity je řadí abecedně)
//
// POZOR na dva suffixy, jejichž název neodpovídá obsahu. Zůstaly kvůli tomu,
// že je Unity čte, a přejmenovat je nejde bez zásahu na obou stranách:
//   _gal  NENÍ galerie, ale textový slide (dva texty + taxonomie + fotka),
//   _vid  NENÍ jen video, ale galerie fotek A videí dohromady.
//
// Šestý typ `_txt` (obecné informace, dva texty bez médií) je POZŮSTATEK.
// V cílové struktuře od Michala není, takže se nový už nezaloží (chybí
// v SLIDE_TYPY_NABIDKA), ale existující složky se dál čtou i editují, aby
// se nikomu neztratil rozepsaný obsah.
//
// Při změně pořadí nebo odebrání slidu se prefixy složek přečíslují na
// souvislou řadu.
//
// TĚŽKÁ MÉDIA JSOU VŽDYCKY JEN V cs/. Fotky, videa i 3D sekvence se ukládají
// výhradně do české složky a Unity si je odtud „vypůjčí" i pro en/pl. Ve
// složkách en/ a pl/ je jen text.txt s překladem. Proto všechny funkce, které
// sahají na média, píšou natvrdo do "cs" a parametr `jazyk` neberou.

export type SlideTyp = "info" | "ai" | "3d" | "vid" | "gal" | "txt";

// Všechny typy, které umíme přečíst z disku (včetně pozůstalého `_txt`).
export const SLIDE_TYPY: SlideTyp[] = ["info", "ai", "3d", "vid", "gal", "txt"];

// Typy, které server pustí do addSlide. `txt` tu schválně není, viz
// komentář výš.
//
// POZOR: není to totéž co nabídka v CMS. Ta je užší (SLIDE_TYPY ve
// web/src/lib/types.ts, dnes jen 3d/vid/gal) — infopanel ani AI slide se
// ručně přidávat nemají, protože každý z nich je na displeji právě jeden.
// Tady zůstávají povolené kvůli prázdnému displeji: ten si první infopanel
// musí umět založit tlačítkem „Přidat Infopanel".
export const SLIDE_TYPY_NABIDKA: SlideTyp[] = ["info", "ai", "3d", "vid", "gal"];

// Suffix složky pro nově zakládaný slide. Pro 3D model bere Michalovo Unity
// obojí (`_3d` i `_mod`); zakládáme `_3d`, existující `_mod` se zachová.
const SUFFIX_ALIAS: Record<string, SlideTyp> = {
  info: "info",
  ai: "ai",
  "3d": "3d",
  mod: "3d",
  vid: "vid",
  gal: "gal",
  txt: "txt",
};

// Klíče polí info panelu v pořadí, ve kterém se zapisují do text.txt.
export const INFO_KLICE = [
  "Sekce",
  "Nazev",
  "Latinsky",
  "Strava",
  "Velikost",
  "DobaLihnuti",
  "Ohrozeni",
  "DelkaZivota",
] as const;

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

// --- Jazyky ---------------------------------------------------------
//
// Na disku: displeje/<id>/<jazyk>/<slide>/... Struktura slidů (které slidy
// existují, v jakém pořadí a jakého typu) se řídí VŽDY češtinou; ostatní
// jazyky do svých složek přidávají jen text.txt s překladem.
export const JAZYKY = ["cs", "en", "pl"] as const;
export type Jazyk = (typeof JAZYKY)[number];
export const VYCHOZI_JAZYK: Jazyk = "cs";

// Validace vstupu z API. Zároveň brána proti cestě mimo datovou složku:
// jazyk se lepí do cesty, takže se nesmí vzít nic jiného než tahle trojice.
export function jeJazyk(hodnota: unknown): hodnota is Jazyk {
  return typeof hodnota === "string" && (JAZYKY as readonly string[]).includes(hodnota);
}

export function jazykNeboVychozi(hodnota: unknown): Jazyk {
  return jeJazyk(hodnota) ? hodnota : VYCHOZI_JAZYK;
}

// Pole info panelu, která píše kurátor v každém jazyce zvlášť.
export const PREKLADANA_POLE = [
  "Nazev",
  "Strava",
  "Velikost",
  "DobaLihnuti",
  "Ohrozeni",
  "DelkaZivota",
] as const;

// Pole, která jsou pro všechny jazyky společná. Kurátor je zadává v češtině
// a do ostatních jazyků se propíšou: latinské jméno beze změny, sekce
// v překladu podle SEKCE_TEMATA. Do souboru se zapisují, aby měl tablet
// v každém jazyce kompletní text.txt.
export const SDILENA_POLE = ["Sekce", "Latinsky"] as const;

export const MAPA_SOUBOR = "mapa.png";

// --- Klíče v text.txt textových slidů --------------------------------
//
// Blokový formát "Klic: Hodnota" jako u info panelu, ale hodnota smí
// pokračovat na dalších řádcích: blok končí až dalším klíčem nebo koncem
// souboru. Klíče jsou bez diakritiky, aby soubor přečetlo Unity i skripty,
// které počítají s ASCII.

// Textový slide (_gal): dva dlouhé texty, taxonomie a jedna fotka.
// ObecnyText a Zajimavosti čte Unity DataLoader beze změny, proto jsou
// stejné jako u pozůstalého `_txt`.
export const GAL_KLICE = ["ObecnyText", "Zajimavosti", "Taxonomie"] as const;

// Obecné informace (_txt, pozůstalý typ): tytéž dva texty bez taxonomie.
export const TEXTOVE_KLICE = ["ObecnyText", "Zajimavosti"] as const;
export type TextovyKlic = (typeof TEXTOVE_KLICE)[number];

// Klíče, pod kterými se dřív ukládal text slidu `_gal`, když to byla
// „zajímavost" s jediným odstavcem. Při čtení je pořád bereme a sypeme do
// ObecnyText, ať se obsah uložený starým CMS neztratí; při zápisu už se
// nepoužijí, takže prvním uložením soubor přejde do nového tvaru.
const GAL_STARE_KLICE = ["Popis", "Text"] as const;

// Regex klíče se staví z předané sady. Při čtení jsme k velikosti písmen
// tolerantní (ruční zásah do souboru, jiný zdroj), při zápisu píšeme vždy
// kanonický tvar ze sady.
function klicRegex(klice: readonly string[]): RegExp {
  return new RegExp(`^\\s*(${klice.join("|")})\\s*:\\s?(.*)$`, "i");
}

function kanonickyKlic(raw: string, klice: readonly string[]): string | null {
  const dolu = raw.trim().toLowerCase();
  return klice.find((k) => k.toLowerCase() === dolu) ?? null;
}

// --- Taxonomie (jen slide _gal) --------------------------------------
//
// Na disku je to JEDEN řádek ve tvaru, který čeká Unity:
//
//   Taxonomie: Třída: Obojživelníci | Řád: Žáby | Čeleď: Pralesničkovití
//
// V CMS ho kurátor zadává po částech ve třech polích a server ho složí.
// Nevyplněná část se vynechá i s popiskem; všechny tři prázdné = řádek
// `Taxonomie:` se nezapíše vůbec (stejně jako se nezapisují prázdná pole
// info panelu).
//
// Klíč `Taxonomie:` je ve všech jazycích stejný, aby ho Unity našlo,
// POPISKY uvnitř se překládají: na anglickém tabletu nemá být půl řádku
// česky. Hodnoty píše kurátor v každém jazyce zvlášť, jako ostatní texty
// slidu `_gal`.
export const TAXONOMIE_KLIC = "Taxonomie";
export const TAXONOMIE_SLOZKY = ["Trida", "Rad", "Celed"] as const;
export type TaxonomieSlozka = (typeof TAXONOMIE_SLOZKY)[number];

const TAXONOMIE_POPISKY: Record<Jazyk, Record<TaxonomieSlozka, string>> = {
  cs: { Trida: "Třída", Rad: "Řád", Celed: "Čeleď" },
  en: { Trida: "Class", Rad: "Order", Celed: "Family" },
  pl: { Trida: "Gromada", Rad: "Rząd", Celed: "Rodzina" },
};

const TAXONOMIE_ODDELOVAC = " | ";

// Porovnávání popisků bez ohledu na diakritiku a velikost písmen: kurátor
// nebo ruční zásah může napsat "Trida" i "TŘÍDA", a při čtení nevíme, ve
// kterém jazyce soubor vznikl.
const DIAKRITIKA_RE = /[\u0300-\u036f]/g; // kombinující znaky po rozkladu NFD

function bezDiakritiky(text: string): string {
  return text.normalize("NFD").replace(DIAKRITIKA_RE, "").toLowerCase().trim();
}

// Popisek (v kterémkoli jazyce, i holý ASCII tvar) -> složka taxonomie.
const TAXONOMIE_PODLE_POPISKU = new Map<string, TaxonomieSlozka>();
for (const slozka of TAXONOMIE_SLOZKY) {
  TAXONOMIE_PODLE_POPISKU.set(bezDiakritiky(slozka), slozka);
  for (const jazyk of JAZYKY) {
    TAXONOMIE_PODLE_POPISKU.set(bezDiakritiky(TAXONOMIE_POPISKY[jazyk][slozka]), slozka);
  }
}

// Tři části -> jeden řádek pro Unity. Prázdné části se vynechají.
export function serializeTaxonomie(
  pole: Record<string, string>,
  jazyk: Jazyk = "cs",
): string {
  const popisky = TAXONOMIE_POPISKY[jazyk];
  const dily: string[] = [];
  for (const slozka of TAXONOMIE_SLOZKY) {
    const hodnota = (pole[slozka] ?? "").replace(/[\r\n|]/g, " ").trim();
    if (hodnota) dily.push(`${popisky[slozka]}: ${hodnota}`);
  }
  return dily.join(TAXONOMIE_ODDELOVAC);
}

// Řádek zpátky na tři části. Co se rozpoznat nepodařilo, vrátíme v `zbytek`,
// aby to editor mohl kurátorovi ukázat místo tichého zahození.
export function parseTaxonomie(radek: string): {
  pole: Record<TaxonomieSlozka, string>;
  zbytek: string;
} {
  const pole = { Trida: "", Rad: "", Celed: "" };
  // Taxonomie je jednořádková; kdyby po ní v souboru zbyly další řádky
  // (ruční zásah), bereme jen ten první, zbytek by stejně nedával smysl.
  const prvni = radek.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  const nerozpoznane: string[] = [];

  for (const dil of prvni.split("|")) {
    if (!dil.trim()) continue;
    const del = dil.indexOf(":");
    const slozka = del === -1 ? undefined : TAXONOMIE_PODLE_POPISKU.get(bezDiakritiky(dil.slice(0, del)));
    if (!slozka) {
      nerozpoznane.push(dil.trim());
      continue;
    }
    pole[slozka] = dil.slice(del + 1).trim();
  }
  return { pole, zbytek: nerozpoznane.join(TAXONOMIE_ODDELOVAC) };
}

// --- 3D model (_3d) --------------------------------------------------
//
// Sekvence snímků 001.png, 002.png, … Unity je řadí podle čísla, my držíme
// pevnou šířku, aby souhlasilo i řazení abecední.
const SEKVENCE_CIFER = 3;
const SEKVENCE_RE = /^(\d{3,})\.png$/i;

function sekvencniNazev(poradi: number): string {
  return `${String(poradi).padStart(SEKVENCE_CIFER, "0")}.png`;
}

// --- Galerie (_vid) --------------------------------------------------
//
// Fotky i videa dohromady, pojmenovaná sekvenčně s vodící nulou (01.jpg,
// 02.mp4, 03.png…). Unity je řadí ABECEDNĚ, proto musí mít všechny položky
// stejný počet cifer: jinak by se 10 dostalo před 2. Šířka se proto počítá
// z celkového počtu položek, ne z pevné konstanty.
const GALERIE_PRIPONY = [".png", ".jpg", ".jpeg", ".mp4"] as const;
const GALERIE_VIDEO_PRIPONY = [".mp4"] as const;
const GALERIE_MIN_CIFER = 2;
const GALERIE_RE = /^(\d+)\.[a-z0-9]+$/i;

function galerieSirka(pocet: number): number {
  return Math.max(GALERIE_MIN_CIFER, String(Math.max(pocet, 1)).length);
}

function galerieNazev(poradi: number, pripona: string, sirka: number): string {
  return `${String(poradi).padStart(sirka, "0")}${pripona.toLowerCase()}`;
}

export function jeGalerieVideo(soubor: string): boolean {
  return (GALERIE_VIDEO_PRIPONY as readonly string[]).includes(
    path.extname(soubor).toLowerCase(),
  );
}

export interface DisplayMeta {
  druh: string; // CMS-interní český název (řídí přehled a stav "Nepřiřazeno")
  // Identifikace pro chatbota (Daniel). Jeden zdroj = pole info panelu; při
  // uložení se sem propíšou, ať se nerozejdou s cs/1_info/text.txt.
  name?: string; // = Nazev (český název)
  latin_name?: string; // = kanonizovaný Latinsky (chatbot podle něj páruje druh)
  category?: string; // = Sekce (zóna expozice)
  section?: string; // taxonomická čeleď, např. Dendrobatidae (jen v meta.json)
  // NEPOUŽÍVÁ SE. Zbytek po demu, kdy stav zařízení nebylo z čeho číst.
  // Na disku zůstává (zapisuje ho seed a migrace), ale přehled i dashboard
  // berou živý stav z tepu tabletu, viz tep.ts.
  stav: "online" | "offline";
  posledniZmena: string;
  // Obsah přišel z hromadného importu (AI koncept) a kurátor ho ještě
  // nepotvrdil. Pole je CMS-interní: Unity ani chatbot ho nečtou, jen se
  // podle něj v přehledu displejů ukazuje, co čeká na revizi. Ruší se ve
  // chvíli, kdy kurátor uloží znalostní bázi (viz writeKb).
  cekaNaRevizi?: boolean;
  // Doplněk pro rychlou orientaci; Unity čte jen složky.
  slidy?: { slozka: string; typ: SlideTyp }[];
}

// Jedna položka galerie (_vid). Fotky a videa jsou na disku promíchané
// v jedné číslované řadě, takže se musí přenášet i s typem.
export interface MediaPolozka {
  nazev: string; // název souboru na disku (01.jpg), kvůli mazání
  url: string; // URL do /data
  typ: "foto" | "video";
}

export interface SlideContent {
  n: number; // pořadí = číselný prefix složky
  typ: SlideTyp;
  slozka: string; // skutečný název složky na disku (kvůli variantě _mod)
  // info: obsah text.txt; gal: dva texty + rozpadlá taxonomie; txt: dva texty
  pole: Record<string, string>;
  // URL do /data (info: fotky bez mapy; gal: jedna fotka; 3d: sekvence).
  // U galerie (_vid) zůstává prázdné, ta má vlastní pole `media`.
  obrazky: string[];
  media: MediaPolozka[]; // jen vid: fotky i videa v pořadí, jak je řadí Unity
  mapa: string | null; // jen info: URL mapa.png
  video: string | null; // jen info: volitelné video (galerie má `media`)
  // Poměr stran, ve kterém Unity fotky tohohle slidu zobrazuje ("772:800").
  // null = tenhle typ se neořezává (viz POMERY ve vyrez.ts).
  pomerVyrezu: string | null;
  // Navolený výřez podle názvu souboru. Co tu není, ještě nikdo neořezával
  // — v CMS se u toho ukáže odznak „neoříznuto".
  vyrezy: Record<string, Vyrez>;
  // Jen 3D: sekvence má jeden společný výřez pro všechny snímky (viz
  // oriznSekvenci ve vyrez.ts), takže odznak „neoříznuto" je na celé řadě.
  vyrezSekvence: Vyrez | null;
}

export interface DisplaySummary {
  id: string;
  druh: string;
  // Sekce (téma) displeje z meta.json, kvůli filtru v přehledu. Může být
  // i starý název, přehled si ho přeloží přes SEKCE_STARE.
  category: string | null;
  // Které jazyky jsou hotové (přehled „EN chybí" u 31 druhů).
  jazyky: Record<Jazyk, boolean>;
  // AI koncept z importu, který ještě nikdo nezkontroloval.
  cekaNaRevizi: boolean;
  // Kvůli párování s analytikou chatbota (jeho species_latin proti našemu
  // latin_name); u nepřiřazeného displeje chybí, proto null.
  latin_name: string | null;
  // ŽIVÝ stav zařízení z tepu tabletu (viz tep.ts), ne pole `stav`
  // z meta.json. To zůstává na disku, ale nikdo ho nečte: byla to demo
  // hodnota, kterou nikdy nic nepřepsalo.
  stav: StavZarizeni;
  naposledy: string | null; // ISO čas posledního tepu, null = zatím žádný
  verze: string | null; // verze aplikace na tabletu z posledního tepu
  posledniZmena: string; // poslední změna OBSAHU v CMS, se stavem nesouvisí
  thumbnail: string | null;
}

export const NEPRIRAZENO = "Nepřiřazeno";

const SLIDE_DIR_RE = /^(\d+)_(info|vid|gal|ai|3d|mod|txt)$/;

function displayDir(id: string): string {
  return path.join(DISPLAYS_DIR, id);
}

function jazykDir(id: string, jazyk: Jazyk): string {
  return path.join(displayDir(id), jazyk);
}

// Struktura slidů se čte z češtiny, ta je zdroj pravdy.
function csDir(id: string): string {
  return jazykDir(id, "cs");
}

// URL, pod kterou server servíruje soubor z /data.
function dataUrl(...segments: string[]): string {
  return "/data/" + segments.map(encodeURIComponent).join("/");
}

function slideFileUrl(id: string, slozka: string, soubor: string): string {
  return dataUrl("displeje", id, "cs", slozka, soubor);
}

export async function readMeta(id: string): Promise<DisplayMeta | null> {
  try {
    const raw = await fs.readFile(path.join(displayDir(id), "meta.json"), "utf8");
    return JSON.parse(raw) as DisplayMeta;
  } catch {
    return null;
  }
}

// Atomicky (tmp + rename): meta.json čte chatbot přes file watcher, useknutý
// JSON by mu spadl na JSON.parse.
async function writeMeta(id: string, meta: DisplayMeta): Promise<void> {
  await writeFileAtomic(
    path.join(displayDir(id), "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );
}

// Po každé změně obsahu: posune posledniZmena a přepíše doplňkový přehled
// slidů v meta.json podle skutečného stavu složek.
export async function touchDisplay(id: string): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) return;
  meta.posledniZmena = new Date().toISOString();
  meta.slidy = (await listSlides(id)).map((s) => ({ slozka: s.slozka, typ: s.typ }));
  await writeMeta(id, meta);
}

// --- Struktura slidů na disku ---

interface SlideDirInfo {
  n: number;
  typ: SlideTyp;
  suffix: string; // suffix složky na disku ("3d" i "mod" znamenají typ "3d")
  slozka: string; // název složky, např. "1_info"
}

async function listSlides(id: string): Promise<SlideDirInfo[]> {
  try {
    const entries = await fs.readdir(csDir(id), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const m = SLIDE_DIR_RE.exec(e.name);
        if (!m) return null;
        const suffix = m[2].toLowerCase();
        return { n: Number(m[1]), typ: SUFFIX_ALIAS[suffix], suffix, slozka: e.name };
      })
      .filter((s): s is SlideDirInfo => s !== null)
      .sort((a, b) => a.n - b.n);
  } catch {
    return [];
  }
}

async function findSlide(id: string, n: number): Promise<SlideDirInfo | null> {
  return (await listSlides(id)).find((s) => s.n === n) ?? null;
}

export async function slideExists(id: string, n: number): Promise<boolean> {
  return (await findSlide(id, n)) !== null;
}

export async function slideTyp(id: string, n: number): Promise<SlideTyp | null> {
  return (await findSlide(id, n))?.typ ?? null;
}

function slideDirPath(id: string, slozka: string, jazyk: Jazyk = "cs"): string {
  return path.join(jazykDir(id, jazyk), slozka);
}

async function listFiles(id: string, slozka: string, ext: string): Promise<string[]> {
  try {
    const files = await fs.readdir(slideDirPath(id, slozka));
    return files.filter((f) => path.extname(f).toLowerCase() === ext).sort();
  } catch {
    return [];
  }
}

// --- text.txt info panelu: řádky "Klic: Hodnota" ---

export function parseInfoText(raw: string): Record<string, string> {
  const pole: Record<string, string> = {};
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if ((INFO_KLICE as readonly string[]).includes(m[1])) pole[m[1]] = m[2].trim();
  }
  return pole;
}

export function serializeInfoText(pole: Record<string, string>): string {
  const lines: string[] = [];
  for (const klic of INFO_KLICE) {
    const v = (pole[klic] ?? "").trim();
    if (v) lines.push(`${klic}: ${v}`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

async function readInfoPole(
  id: string,
  slozka: string,
  jazyk: Jazyk = "cs",
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(slideDirPath(id, slozka, jazyk), "text.txt"), "utf8");
    return parseInfoText(raw);
  } catch {
    return {};
  }
}

// --- text.txt textových slidů (_gal a pozůstalý _txt) ---------------

// Blokový parser: řádek s klíčem začíná nový blok, všechny další řádky až
// k dalšímu klíči k němu patří. Soubor BEZ jakéhokoli klíče (ruční zásah)
// se přečte celý jako obecný text, ať se obsah neztratí.
function parseBloky(raw: string, klice: readonly string[]): Record<string, string> {
  const re = klicRegex(klice);
  const radky = raw.replace(/\r\n/g, "\n").split("\n");
  const bloky = new Map<string, string[]>();
  let aktualni: string | null = null;

  for (const radek of radky) {
    const m = re.exec(radek);
    const klic = m ? kanonickyKlic(m[1], klice) : null;
    if (klic) {
      aktualni = klic;
      bloky.set(klic, [m![2]]);
      continue;
    }
    if (aktualni) bloky.get(aktualni)!.push(radek);
  }

  if (bloky.size === 0) {
    const cely = radky.join("\n").trim();
    return cely ? { ObecnyText: cely } : {};
  }

  const pole: Record<string, string> = {};
  for (const [klic, obsah] of bloky) {
    const text = obsah.join("\n").trim();
    if (text) pole[klic] = text;
  }
  return pole;
}

// Prázdné pole se nezapisuje (stejně jako u info panelu), takže prázdný
// slide má na disku prázdný text.txt a pozná se jako nevyplněný.
function serializeBloky(pole: Record<string, string>, klice: readonly string[]): string {
  const bloky: string[] = [];
  for (const klic of klice) {
    const v = (pole[klic] ?? "").replace(/\r\n/g, "\n").trim();
    if (v) bloky.push(`${klic}: ${v}`);
  }
  return bloky.length ? bloky.join("\n") + "\n" : "";
}

// --- Textový slide (_gal): dva texty + taxonomie ---

// Čteme i staré klíče (`Popis:`, `Text:`) z doby, kdy `_gal` byla zajímavost
// s jediným odstavcem; jejich obsah spadne do ObecnyText. Taxonomie se
// rozpadne na tři pole, aby ji editor mohl nabídnout po částech; co se
// rozpoznat nepodařilo, jde do klíče `TaxonomieZbytek`, ať to editor může
// kurátorovi ukázat místo tichého zahození.
export const GAL_TAXONOMIE_ZBYTEK = "TaxonomieZbytek";

export function parseGalText(raw: string): Record<string, string> {
  const bloky = parseBloky(raw, [...GAL_KLICE, ...GAL_STARE_KLICE]);

  const pole: Record<string, string> = {};
  for (const klic of TEXTOVE_KLICE) {
    if (bloky[klic]) pole[klic] = bloky[klic];
  }
  // Starý jednopolový tvar: obsah patří do hlavního textu, ale jen když
  // v souboru není novější ObecnyText (ten má přednost).
  if (!pole.ObecnyText) {
    const stary = GAL_STARE_KLICE.map((k) => bloky[k]).find((v) => v?.trim());
    if (stary) pole.ObecnyText = stary;
  }

  const { pole: taxonomie, zbytek } = parseTaxonomie(bloky[TAXONOMIE_KLIC] ?? "");
  for (const slozka of TAXONOMIE_SLOZKY) {
    if (taxonomie[slozka]) pole[slozka] = taxonomie[slozka];
  }
  if (zbytek) pole[GAL_TAXONOMIE_ZBYTEK] = zbytek;
  return pole;
}

// Tři pole taxonomie se skládají do jednoho řádku s popisky v jazyce
// souboru; klíč `Taxonomie:` zůstává ve všech jazycích stejný, Unity ho
// hledá podle něj.
export function serializeGalText(
  pole: Record<string, string>,
  jazyk: Jazyk = "cs",
): string {
  const kZapisu: Record<string, string> = {};
  for (const klic of TEXTOVE_KLICE) {
    if (pole[klic]) kZapisu[klic] = pole[klic];
  }
  const taxonomie = serializeTaxonomie(pole, jazyk);
  if (taxonomie) kZapisu[TAXONOMIE_KLIC] = taxonomie;
  return serializeBloky(kZapisu, GAL_KLICE);
}

async function readGalPole(
  id: string,
  slozka: string,
  jazyk: Jazyk = "cs",
): Promise<Record<string, string>> {
  try {
    return parseGalText(
      await fs.readFile(path.join(slideDirPath(id, slozka, jazyk), "text.txt"), "utf8"),
    );
  } catch {
    return {};
  }
}

// Zápis textového slidu. Na rozdíl od info panelu tu nejsou žádná sdílená
// pole: všechno včetně taxonomie se píše v každém jazyce zvlášť, takže se
// nic nedoplňuje z češtiny.
export async function writeGalPole(
  id: string,
  n: number,
  pole: Record<string, string>,
  jazyk: Jazyk = "cs",
): Promise<{ ok: boolean; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide || slide.typ !== "gal") {
    return { ok: false, chyba: "Slide není textový." };
  }
  // Neznámé klíče zahazujeme, do souboru půjde jen to, co typ slidu zná.
  // `TaxonomieZbytek` mezi ně schválně nepatří: je to jen hlášení pro
  // editor o nerozpoznaném tvaru na disku, uložením se přepíše.
  const ocistene: Record<string, string> = {};
  for (const klic of [...TEXTOVE_KLICE, ...TAXONOMIE_SLOZKY]) {
    const v = pole[klic];
    if (typeof v === "string") ocistene[klic] = v;
  }

  const dir = slideDirPath(id, slide.slozka, jazyk);
  await fs.mkdir(dir, { recursive: true }); // překladová složka nemusí existovat
  await writeFileAtomic(path.join(dir, "text.txt"), serializeGalText(ocistene, jazyk));
  await touchDisplay(id);
  // Souvislý text o druhu, chatbot ho může použít jako podklad.
  void notifyReingest(id, `${jazyk}/${slide.slozka}/text.txt`);
  return { ok: true };
}

// --- Obecné informace (_txt, pozůstalý typ): dva klíče, dlouhé hodnoty ---

export function parseTextSlide(raw: string): Record<string, string> {
  return parseBloky(raw, TEXTOVE_KLICE);
}

export function serializeTextSlide(pole: Record<string, string>): string {
  return serializeBloky(pole, TEXTOVE_KLICE);
}

async function readTextSlide(
  id: string,
  slozka: string,
  jazyk: Jazyk = "cs",
): Promise<Record<string, string>> {
  try {
    return parseTextSlide(
      await fs.readFile(path.join(slideDirPath(id, slozka, jazyk), "text.txt"), "utf8"),
    );
  } catch {
    return {};
  }
}

// Zápis obou textů. Na rozdíl od info panelu tu nejsou žádná sdílená pole:
// obojí se píše v každém jazyce zvlášť, takže se nic nedoplňuje z češtiny.
export async function writeTextSlide(
  id: string,
  n: number,
  pole: Record<string, string>,
  jazyk: Jazyk = "cs",
): Promise<{ ok: boolean; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide || slide.typ !== "txt") {
    return { ok: false, chyba: "Slide není typu obecné informace." };
  }
  // Neznámé klíče zahazujeme, do souboru půjde jen to, co typ slidu zná.
  const ocistene: Record<string, string> = {};
  for (const klic of TEXTOVE_KLICE) {
    const v = pole[klic];
    if (typeof v === "string") ocistene[klic] = v;
  }

  const dir = slideDirPath(id, slide.slozka, jazyk);
  await fs.mkdir(dir, { recursive: true }); // překladová složka nemusí existovat
  await writeFileAtomic(path.join(dir, "text.txt"), serializeTextSlide(ocistene));
  await touchDisplay(id);
  // Souvislý text o druhu, chatbot ho může použít jako podklad (stejně jako
  // textový slide).
  void notifyReingest(id, `${jazyk}/${slide.slozka}/text.txt`);
  return { ok: true };
}

// Validace povinných polí; vrací text chyby, nebo null když je vše v pořádku.
// V překladu kurátor vyplňuje jen název a další překládaná pole; sekci
// a latinské jméno drží čeština, takže se v en/pl nevaliduje.
export function validateInfoPole(
  pole: Record<string, string>,
  jazyk: Jazyk = "cs",
): string | null {
  const nazev = (pole.Nazev ?? "").trim();
  if (jazyk !== "cs") {
    return nazev ? null : "Vyplňte prosím název.";
  }
  const sekce = (pole.Sekce ?? "").trim();
  if (!sekce) return "Vyplňte prosím sekci.";
  // Starý název sekce (před srovnáním s oficiální tabulí) projde taky, jinak
  // by dřív uložený displej nešlo znovu uložit.
  if (!jeSekce(sekce)) return "Neplatná sekce.";
  if (!nazev) return "Vyplňte prosím název.";
  return null;
}

// Sdílená pole (sekce, latinské jméno) do textu překladu. Kurátor je zadává
// jednou v češtině; do en/pl je doplní server, aby měl tablet v každém
// jazyce úplný text.txt. Sekce se přeloží podle oficiální tabule.
async function doplnSdilenaPole(
  id: string,
  slozka: string,
  pole: Record<string, string>,
  jazyk: Jazyk,
): Promise<Record<string, string>> {
  if (jazyk === "cs") return pole;
  const cs = await readInfoPole(id, slozka, "cs");
  const meta = await readMeta(id);
  const vysledek: Record<string, string> = { ...pole };

  const latin = (meta?.latin_name ?? cs.Latinsky ?? "").trim();
  if (latin) vysledek.Latinsky = latin;
  else delete vysledek.Latinsky;

  const sekceCs = (cs.Sekce ?? meta?.category ?? "").trim();
  const def = najdiSekci(sekceCs);
  if (def) vysledek.Sekce = jazyk === "en" ? def.en : def.pl;
  else delete vysledek.Sekce;

  return vysledek;
}

export async function writeInfoPole(
  id: string,
  n: number,
  pole: Record<string, string>,
  section?: string,
  jazyk: Jazyk = "cs",
): Promise<{ ok: boolean; chyba?: string; latin: string; latinCorrected: boolean }> {
  const slide = await findSlide(id, n);
  if (!slide || slide.typ !== "info") {
    return { ok: false, chyba: "Slide není typu info.", latin: "", latinCorrected: false };
  }

  // Kanonizace latinského jména (chatbot podle něj páruje druh).
  const rawLatin = (pole.Latinsky ?? "").trim();
  const latin = canonicalizeLatin(rawLatin);
  const latinCorrected = latin !== rawLatin;

  let cleaned: Record<string, string> = { ...pole };
  if (latin) cleaned.Latinsky = latin;
  else delete cleaned.Latinsky;

  const chyba = validateInfoPole(cleaned, jazyk);
  if (chyba) return { ok: false, chyba, latin, latinCorrected };

  cleaned = await doplnSdilenaPole(id, slide.slozka, cleaned, jazyk);

  // 1) Fakta do <jazyk>/<slozka>/text.txt (formát Klic: Hodnota), atomicky.
  const dir = slideDirPath(id, slide.slozka, jazyk);
  await fs.mkdir(dir, { recursive: true }); // překladová složka nemusí existovat
  await writeFileAtomic(path.join(dir, "text.txt"), serializeInfoText(cleaned));

  // 2) Identita v meta.json patří češtině: meta.json je jeden na displej
  // a chatbot i přehled displejů podle něj pracují s českým názvem.
  const meta = jazyk === "cs" ? await readMeta(id) : null;
  if (meta) {
    const nazev = (cleaned.Nazev ?? "").trim();
    meta.druh = nazev; // validace zaručuje, že Nazev není prázdný
    meta.name = nazev;
    if (latin) meta.latin_name = latin;
    else delete meta.latin_name;
    const kategorie = (cleaned.Sekce ?? "").trim();
    if (kategorie) meta.category = kategorie;
    else delete meta.category;
    const celed = (section ?? "").trim();
    if (celed) meta.section = celed;
    else delete meta.section;
    meta.posledniZmena = new Date().toISOString();
    meta.slidy = (await listSlides(id)).map((s) => ({ slozka: s.slozka, typ: s.typ }));
    await writeMeta(id, meta);
  }

  // 3) Signál chatbotu, že se změnila fakta i identifikace (zatím vypnuto).
  void notifyReingest(id, `${jazyk}/${slide.slozka}/text.txt`);
  if (jazyk === "cs") void notifyReingest(id, "meta.json");
  if (jazyk !== "cs") await touchDisplay(id); // v cs to udělal zápis meta.json

  return { ok: true, latin, latinCorrected };
}

// --- Obsah slidů pro API ---

// Soubory galerie (_vid) v tom pořadí, ve kterém je uvidí Unity.
//
// Unity řadí ABECEDNĚ, takže tady musíme udělat totéž, a ne řadit podle
// čísla: kdyby na disku po ručním zásahu zůstala nestejně široká čísla
// (2.jpg vedle 10.jpg), CMS by ukazovalo jiné pořadí než tablet. Radši ať
// je ten nepořádek vidět; první uložení do slidu ho stejně srovná.
// Soubory bez číselného názvu (obsah nahraný starším CMS) se nezahazují,
// jen se řadí za očíslované, kam je zařadí i abecední řazení Unity.
async function galerieSoubory(id: string, slozka: string): Promise<string[]> {
  let soubory: string[];
  try {
    soubory = await fs.readdir(slideDirPath(id, slozka));
  } catch {
    return [];
  }
  const media = soubory.filter((f) =>
    (GALERIE_PRIPONY as readonly string[]).includes(path.extname(f).toLowerCase()),
  );
  const cislovane = media.filter((f) => GALERIE_RE.test(f)).sort((a, b) => a.localeCompare(b, "en"));
  const ostatni = media.filter((f) => !GALERIE_RE.test(f)).sort((a, b) => a.localeCompare(b, "en"));
  return [...cislovane, ...ostatni];
}

// Snímky 3D sekvence seřazené podle čísla v názvu (001.png, 002.png, …).
// Soubor s jiným názvem se ignoruje, ať se do sekvence nedostane nepořádek.
async function sekvence(id: string, slozka: string): Promise<string[]> {
  const files = await listFiles(id, slozka, ".png");
  return files
    .map((f) => ({ f, m: SEKVENCE_RE.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.f);
}

// Text se čte z požadovaného jazyka, média vždy z češtiny: fotky, videa
// i 3D sekvence jsou společné, kurátor je nahrává jednou.
async function toContent(id: string, s: SlideDirInfo, jazyk: Jazyk): Promise<SlideContent> {
  const pomer = pomerProTyp(s.typ);
  const content: SlideContent = {
    n: s.n,
    typ: s.typ,
    slozka: s.slozka,
    pole: {},
    obrazky: [],
    media: [],
    mapa: null,
    video: null,
    pomerVyrezu: pomer ? popisPomeru(pomer) : null,
    // 3D drží jeden výřez na celou sekvenci, ne mapu po souborech.
    vyrezy: pomer && s.typ !== "3d" ? await readVyrezy(slideDirPath(id, s.slozka)) : {},
    vyrezSekvence: s.typ === "3d" ? await readVyrezSekvence(slideDirPath(id, s.slozka)) : null,
  };
  if (s.typ === "info") {
    content.pole = await readInfoPole(id, s.slozka, jazyk);
    const pngs = await listFiles(id, s.slozka, ".png");
    content.obrazky = pngs
      .filter((f) => f !== MAPA_SOUBOR)
      .map((f) => slideFileUrl(id, s.slozka, f));
    if (pngs.includes(MAPA_SOUBOR)) content.mapa = slideFileUrl(id, s.slozka, MAPA_SOUBOR);
    // Volitelné video info panelu (Michal ho řadí na začátek galerie fotek).
    const videa = await listFiles(id, s.slozka, ".mp4");
    content.video = videa.length ? slideFileUrl(id, s.slozka, videa[0]) : null;
  } else if (s.typ === "gal") {
    // Textový slide: dva texty, taxonomie a jedna fotka.
    content.pole = await readGalPole(id, s.slozka, jazyk);
    const pngs = await listFiles(id, s.slozka, ".png");
    content.obrazky = pngs.length ? [slideFileUrl(id, s.slozka, pngs[0])] : [];
  } else if (s.typ === "3d") {
    content.obrazky = (await sekvence(id, s.slozka)).map((f) => slideFileUrl(id, s.slozka, f));
  } else if (s.typ === "vid") {
    // Galerie: fotky i videa v jedné řadě.
    content.media = (await galerieSoubory(id, s.slozka)).map((f) => ({
      nazev: f,
      url: slideFileUrl(id, s.slozka, f),
      typ: jeGalerieVideo(f) ? ("video" as const) : ("foto" as const),
    }));
  } else if (s.typ === "txt") {
    // Obecné informace: jen dva texty, žádná média. Jdou do `pole` stejně
    // jako u info panelu, takže se tvar odpovědi API nemění.
    content.pole = await readTextSlide(id, s.slozka, jazyk);
  }
  return content;
}

export async function readSlides(id: string, jazyk: Jazyk = "cs"): Promise<SlideContent[]> {
  const slides = await listSlides(id);
  return Promise.all(slides.map((s) => toContent(id, s, jazyk)));
}

export async function displayExists(id: string): Promise<boolean> {
  return (await readMeta(id)) !== null;
}

// --- Znalostní báze (kb.md v kořeni displeje) ---

// Znalostní báze: čeština zůstává v kb.md v kořeni displeje (přesně tam ji
// hledá chatbot), překlady jsou vedle jako kb.en.md a kb.pl.md.
export function kbSoubor(jazyk: Jazyk): string {
  return jazyk === "cs" ? "kb.md" : `kb.${jazyk}.md`;
}

export async function readKb(id: string, jazyk: Jazyk = "cs"): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(displayDir(id), kbSoubor(jazyk)), "utf8");
    return raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  } catch {
    return "";
  }
}

// POZOR: uložení znalostní báze značku „čeká na revizi" ZÁMĚRNĚ nechává být.
// Kurátor text ukládá z různých důvodů (překlep, doplnění věty) a to ještě
// neznamená, že ho celý přečetl a ručí za něj. Revizi ruší jen vědomé
// schválení. POST /api/displays/:id/revize, viz oznacRevizi().
export async function writeKb(id: string, text: string, jazyk: Jazyk = "cs"): Promise<void> {
  const body = text.replace(/\r\n/g, "\n");
  await writeFileAtomic(
    path.join(displayDir(id), kbSoubor(jazyk)),
    body.endsWith("\n") ? body : body + "\n",
  );
  await touchDisplay(id);
  // Signál chatbotu, že se změnila znalostní báze (zatím vypnuto).
  void notifyReingest(id, kbSoubor(jazyk));
}

// Nastaví nebo zruší značku „AI koncept čeká na revizi kurátora".
// Zapisuje se přes writeMeta (atomicky), ne přímo do souboru.
export async function oznacRevizi(id: string, ceka: boolean): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) return;
  if (meta.cekaNaRevizi === ceka || (!ceka && meta.cekaNaRevizi === undefined)) return;
  if (ceka) meta.cekaNaRevizi = true;
  else delete meta.cekaNaRevizi;
  await writeMeta(id, meta);
}

// --- Fotky ---

// Společný začátek zpracování každého uploadu. 40 Mpx strop vstupu (výchozí
// sharp limit je ~268 Mpx) je brzda proti obřím dekódovaným rastrům. SVG
// odmítáme úplně: renderuje se přes librsvg a i pár set bajtů (feTurbulence)
// může vyrobit desítky MB a spálit minuty CPU; navíc ho na displeji
// nepotřebujeme. Výstup se zmenší na rozumný strop, ať jedno velké foto
// nenafoukne soubor do stovek MB.
async function pripravObrazek(
  data: Buffer,
): Promise<{ img: ReturnType<typeof sharp>; format?: string }> {
  const img = sharp(data, { limitInputPixels: 40_000_000 });
  const meta = await img.metadata();
  if (meta.format === "svg") {
    throw new Error("SVG se nepřijímá, nahrajte JPG nebo PNG.");
  }
  return {
    img: img
      .rotate()
      .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }),
    format: meta.format,
  };
}

// Info panel, textový slide i 3D sekvence čte Unity jako .png, proto se tam
// každý upload převede.
export async function convertToPng(data: Buffer): Promise<Buffer> {
  const { img } = await pripravObrazek(data);
  return img.png().toBuffer();
}

// Galerie (_vid): fotka se ukládá jako PNG stejně jako všude jinde. Dřív si
// galerie příponu držela (JPG zůstal JPG), ale Michal potvrdil, že Unity čte
// fotky JEN jako PNG — JPG by na tabletu vůbec nenaskočil. Videa se tudy
// nepouštějí, ta si příponu .mp4 drží.
export async function zpracujGalerieObrazek(
  data: Buffer,
): Promise<{ buffer: Buffer; pripona: string }> {
  const { img } = await pripravObrazek(data);
  return { buffer: await img.png().toBuffer(), pripona: ".png" };
}

function uniquePngName(): string {
  return `foto-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.png`;
}

// Přejmenování s opakováním. Na Windows drží soubor nebo složku klidně
// antivirus nebo Unity klient, který čte obsah displeje, a rename spadne na
// EPERM/EBUSY. Bez opakování by uprostřed dvoufázového přečíslování zůstal
// slide pod dočasným názvem `.tmp-*`, tedy neviditelný pro CMS i pro tablet.
const RENAME_POKUSU = 5;
const RENAME_PAUZA_MS = 120;

async function renameSPokusy(from: string, to: string): Promise<void> {
  for (let pokus = 1; ; pokus++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const kod = (err as NodeJS.ErrnoException).code;
      if ((kod !== "EPERM" && kod !== "EBUSY") || pokus >= RENAME_POKUSU) throw err;
      await new Promise((hotovo) => setTimeout(hotovo, RENAME_PAUZA_MS * pokus));
    }
  }
}

// Zbytky po přerušeném přečíslování nebo atomickém zápisu: složky a soubory
// `.tmp-*` uvnitř data/displeje. Uklízí se při startu serveru, kdy nic jiného
// se soubory nepracuje, takže se nemůže smazat rozdělaný zápis.
export async function uklidDocasneSoubory(): Promise<string[]> {
  const uklizeno: string[] = [];
  async function projdi(dir: string): Promise<void> {
    let polozky;
    try {
      polozky = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const p of polozky) {
      const cesta = path.join(dir, p.name);
      if (p.name.startsWith(".tmp-")) {
        await fs.rm(cesta, { recursive: true, force: true }).catch(() => {});
        uklizeno.push(path.relative(DISPLAYS_DIR, cesta));
        continue;
      }
      if (p.isDirectory()) await projdi(cesta);
    }
  }
  await projdi(DISPLAYS_DIR);
  return uklizeno;
}

// Sekvence 3D modelu musí být souvislá řada od 001, po přidání i smazání
// snímku ji srovnáme. Dvoufázově (přes dočasné názvy), ať se nesrazí cíle.
async function renumberSequence(id: string, slozka: string): Promise<void> {
  const dir = slideDirPath(id, slozka);
  const soubory = await sekvence(id, slozka);
  const cile = soubory.map((f, i) => ({ from: f, to: sekvencniNazev(i + 1) }));
  // Sekvence 360 se zatím neořezává (fáze 2), ale až se to zapne, musí
  // originály putovat se snímky stejně jako v galerii.
  await prejmenujRadu(dir, cile.filter((t) => t.from !== t.to));
}

// Galerie (_vid) musí být souvislá řada od 01 se stejným počtem cifer
// u všech položek, jinak by abecední řazení v Unity dalo jiné pořadí než
// číselné. Srovnáváme po každém přidání i smazání, dvoufázově (přes dočasné
// názvy), ať se nesrazí cíle. Přípona každého souboru zůstává.
//
// Tohle je zároveň jediné místo, kde se do nové konvence dostane obsah
// nahraný starším CMS (video pod původním názvem): žádná migrace se nekoná,
// složka se srovná až ve chvíli, kdy do ní kurátor sáhne.
// Přečíslování dvoufázově přes `.tmp-*`, ať se názvy nesrazí. Spolu s fotkou
// se přejmenuje i její originál (`<nazev>.orig`), jinak by se výřez rozešel
// se svou fotkou a kurátor by při další úpravě dostal cizí originál.
async function prejmenujRadu(dir: string, meni: { from: string; to: string }[]): Promise<void> {
  if (meni.length === 0) return;
  const vse: { from: string; to: string }[] = [];
  for (const t of meni) {
    vse.push(t);
    try {
      await fs.access(path.join(dir, origNazev(t.from)));
      vse.push({ from: origNazev(t.from), to: origNazev(t.to) });
    } catch {
      // tahle fotka originál nemá (nikdy se neořezávala)
    }
  }
  for (const t of vse) {
    await renameSPokusy(path.join(dir, t.from), path.join(dir, `.tmp-${t.to}`));
  }
  for (const t of vse) {
    await renameSPokusy(path.join(dir, `.tmp-${t.to}`), path.join(dir, t.to));
  }
  await prejmenujVyrezy(dir, meni);
}

async function renumberGalerie(id: string, slozka: string): Promise<void> {
  const dir = slideDirPath(id, slozka);
  const soubory = await galerieSoubory(id, slozka);
  const sirka = galerieSirka(soubory.length);
  const cile = soubory.map((f, i) => ({
    from: f,
    to: galerieNazev(i + 1, path.extname(f), sirka),
  }));
  await prejmenujRadu(dir, cile.filter((t) => t.from !== t.to));
}

export async function saveImage(
  id: string,
  n: number,
  data: Buffer,
): Promise<{ ok: boolean; url?: string; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (
    !slide ||
    (slide.typ !== "info" && slide.typ !== "gal" && slide.typ !== "3d" && slide.typ !== "vid")
  ) {
    return {
      ok: false,
      chyba: "Fotky patří jen na info panel, textový slide, 3D model nebo do galerie.",
    };
  }

  if (slide.typ === "3d" && orezSekvenceBezi(id, n)) {
    return { ok: false, chyba: "Probíhá ořez sekvence, počkejte na dokončení." };
  }

  const dir = slideDirPath(id, slide.slozka);
  let obsah: Buffer;
  let nazev: string;

  if (slide.typ === "vid") {
    // Galerie: přípona zůstává, položka jde na konec řady. Zapisuje se pod
    // dočasným jménem, které se řadí až za všechno očíslované, a hned nato
    // se celá složka přečísluje, takže dostane správné číslo.
    let zpracovany;
    try {
      zpracovany = await zpracujGalerieObrazek(data);
    } catch {
      return { ok: false, chyba: "Obrázek se nepodařilo zpracovat. Použijte JPG nebo PNG." };
    }
    obsah = zpracovany.buffer;
    nazev = `zzz-nova-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}${zpracovany.pripona}`;
  } else {
    try {
      obsah = await convertToPng(data);
    } catch {
      return { ok: false, chyba: "Obrázek se nepodařilo převést do PNG. Použijte JPG nebo PNG." };
    }
    if (slide.typ === "3d") {
      // Snímek jde na konec sekvence; číslo bereme z nejvyššího, ne z počtu,
      // ať se netrefíme do existujícího souboru po ručním zásahu do složky.
      const cisla = (await sekvence(id, slide.slozka)).map((f) => Number(SEKVENCE_RE.exec(f)![1]));
      nazev = sekvencniNazev((cisla.length ? Math.max(...cisla) : 0) + 1);
    } else {
      // Textový slide má právě jednu fotku, předchozí nahradíme.
      if (slide.typ === "gal") {
        for (const old of await listFiles(id, slide.slozka, ".png")) {
          try {
            await fs.unlink(path.join(dir, old));
          } catch {
            // soubor mezitím zmizel, nevadí
          }
        }
      }
      nazev = uniquePngName();
    }
  }

  // Atomicky (tmp + rename) jako texty: Unity i chatbot čtou složku displeje
  // přímo, půlka souboru by jim vyrobila rozbitý obrázek.
  await writeFileAtomic(path.join(dir, nazev), obsah);
  if (slide.typ === "3d") await renumberSequence(id, slide.slozka);
  if (slide.typ === "vid") {
    await renumberGalerie(id, slide.slozka);
    // Po přečíslování má soubor jiné jméno, dohledáme ho podle přípony na
    // konci řady (tam ho renumberGalerie zařadilo).
    const po = await galerieSoubory(id, slide.slozka);
    nazev = po[po.length - 1] ?? nazev;
  }
  // Nově nahraná fotka se rovnou ořízne na střed v poměru, který Unity čeká.
  // Kurátor si výřez vzápětí posune v editoru, ale i když okno jen zavře, je
  // na tabletu správný poměr. Originál si ořez odloží stranou, takže se dá
  // výřez kdykoli posunout zpátky.
  const pomer = pomerProTyp(slide.typ);
  if (slide.typ === "3d") {
    // Sekvence se ořezává jako celek, ne po snímcích — ořez na střed by tu
    // nedával smysl, protože se objekt na snímcích otáčí a výřez musí sedět
    // na celou otáčku. Nový snímek proto dostane jen výřez, který sekvence
    // UŽ má; jinak zůstane neoříznutý a čeká na kurátora.
    if (pomer && jdeOriznout(nazev)) {
      const res = await doriznSnimek(dir, nazev, pomer);
      if (!res.ok) console.warn(`[vyrez] ${id}/${slide.slozka}/${nazev}: ${res.chyba}`);
    }
  } else if (pomer && jdeOriznout(nazev)) {
    const res = await oriznFotku(dir, nazev, pomer, null);
    // Ořez u staršího JPG změní příponu na .png, vrácená URL musí sedět.
    if (res.ok && res.nazev) nazev = res.nazev;
    if (!res.ok) {
      // Fotka je nahraná a použitelná, jen neoříznutá — v CMS u ní zůstane
      // odznak „neoříznuto". Shazovat kvůli tomu celý upload by bylo horší.
      console.warn(`[vyrez] ${id}/${slide.slozka}/${nazev}: ${res.chyba}`);
    }
  }

  await touchDisplay(id);
  return { ok: true, url: slideFileUrl(id, slide.slozka, nazev) };
}

// Ruční úprava výřezu z editoru. `vyrez` je v podílech 0..1 vůči originálu.
export async function ulozVyrez(
  id: string,
  n: number,
  soubor: string,
  vyrez: Vyrez,
): Promise<{ ok: boolean; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide) return { ok: false, chyba: "Slide nenalezen." };

  const pomer = pomerProTyp(slide.typ);
  if (!pomer) return { ok: false, chyba: "Fotky tohohle slidu se neořezávají." };
  if (slide.typ === "3d") {
    // Kdyby šel výřez nastavit po jednom snímku, otáčka by při přehrání
    // poskakovala. 3D má vlastní cestu: spustOrezSekvence().
    return { ok: false, chyba: "Sekvence 360 se ořezává celá naráz, ne po snímcích." };
  }

  const nazev = path.basename(soubor);
  if (!jdeOriznout(nazev)) return { ok: false, chyba: "Tenhle soubor se ořezávat nedá." };
  if (nazev === MAPA_SOUBOR) {
    return { ok: false, chyba: "Mapa výskytu se neořezává, je to schéma." };
  }

  const dir = slideDirPath(id, slide.slozka);
  try {
    await fs.access(path.join(dir, nazev));
  } catch {
    return { ok: false, chyba: "Fotka nenalezena." };
  }

  const res = await oriznFotku(dir, nazev, pomer, vyrez);
  if (!res.ok) return { ok: false, chyba: res.chyba };
  await touchDisplay(id);
  return { ok: true };
}

// ── Hromadný ořez sekvence 360 ────────────────────────────────────────────
//
// Ořez 36+ snímků trvá desítky sekund. Kdyby na něj čekal HTTP request,
// prohlížeč by mezitím spadl na timeout a kurátor by nevěděl, jestli ořez
// běží, nebo se ztratil. Request proto úlohu jen NASTARTUJE a vrátí se
// hned; editor se pak doptává na průběh druhým endpointem.
//
// Node jede na jednom vlákně, takže „na pozadí" tady znamená, že se úloha
// prokládá s ostatními requesty mezi jednotlivými `await`. To samo o sobě
// nestačí — ale sharp počítá ve vlastním threadpoolu libuv, takže samotné
// ořezávání hlavní vlákno neblokuje a CMS zůstává po celou dobu obsluhovat.

export interface StavOrezuSekvence {
  bezi: boolean;
  hotovo: number;
  celkem: number;
  chyba: string | null;
}

const orezySekvenci = new Map<string, StavOrezuSekvence>();

function klicOrezu(id: string, n: number): string {
  return `${id}/${n}`;
}

export function stavOrezuSekvence(id: string, n: number): StavOrezuSekvence | null {
  return orezySekvenci.get(klicOrezu(id, n)) ?? null;
}

// Běží zrovna ořez téhle sekvence? Nahrávání dalšího snímku mezitím musí
// počkat: ořez si na začátku uklidí rozdělané `.part` soubory, takže by
// si dvě operace nad stejnou složkou navzájem shodily mezivýsledky.
export function orezSekvenceBezi(id: string, n: number): boolean {
  return stavOrezuSekvence(id, n)?.bezi === true;
}

export async function spustOrezSekvence(
  id: string,
  n: number,
  vyrez: Vyrez,
): Promise<{ ok: boolean; chyba?: string; celkem?: number }> {
  const klic = klicOrezu(id, n);
  if (orezySekvenci.get(klic)?.bezi) {
    return { ok: false, chyba: "Ořez téhle sekvence už běží." };
  }

  const slide = await findSlide(id, n);
  if (!slide) return { ok: false, chyba: "Slide nenalezen." };
  if (slide.typ !== "3d") return { ok: false, chyba: "Tohle není sekvence 360." };

  const pomer = pomerProTyp(slide.typ);
  if (!pomer) return { ok: false, chyba: "Sekvence se neořezává." };

  const soubory = await sekvence(id, slide.slozka);
  if (soubory.length === 0) return { ok: false, chyba: "Sekvence nemá žádné snímky." };

  const dir = slideDirPath(id, slide.slozka);
  const stav: StavOrezuSekvence = {
    bezi: true,
    hotovo: 0,
    celkem: soubory.length,
    chyba: null,
  };
  orezySekvenci.set(klic, stav);

  // Schválně bez `await`: request se vrátí hned a úloha doběhne sama.
  void (async () => {
    const res = await oriznSekvenci(dir, soubory, pomer, vyrez, (hotovo) => {
      stav.hotovo = hotovo;
    });
    stav.bezi = false;
    stav.chyba = res.ok ? null : (res.chyba ?? "Ořez se nepodařil.");
    if (res.ok) {
      stav.hotovo = stav.celkem;
      await touchDisplay(id);
    }
  })().catch((e) => {
    stav.bezi = false;
    stav.chyba = e instanceof Error ? e.message : String(e);
  });

  return { ok: true, celkem: soubory.length };
}

// Originál fotky pro editor výřezu: `<nazev>.orig`, a když ještě není,
// samotná fotka (nikdy se neořezávala, takže JE originál).
export async function ctiOriginalFotky(
  id: string,
  n: number,
  soubor: string,
): Promise<{ ok: boolean; data?: Buffer; typ?: string; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide) return { ok: false, chyba: "Slide nenalezen." };
  const nazev = path.basename(soubor);
  if (!jdeOriznout(nazev)) return { ok: false, chyba: "Neplatný soubor." };

  const dir = slideDirPath(id, slide.slozka);
  for (const kandidat of [origNazev(nazev), nazev]) {
    try {
      const data = await fs.readFile(path.join(dir, kandidat));
      // Typ se bere z OBSAHU, ne z přípony: originál oříznutého JPG se
      // jmenuje `01.png.orig`, ale uvnitř je pořád JPEG.
      const format = (await sharp(data).metadata()).format;
      return { ok: true, data, typ: format === "jpeg" ? "image/jpeg" : "image/png" };
    } catch {
      // zkusíme další
    }
  }
  return { ok: false, chyba: "Fotka nenalezena." };
}

// Smazání jedné položky: fotky (všude) nebo videa (jen z galerie).
export async function deleteMedia(id: string, n: number, filename: string): Promise<boolean> {
  const slide = await findSlide(id, n);
  if (!slide) return false;
  const safe = path.basename(filename);
  const pripona = path.extname(safe).toLowerCase();
  // Mimo galerii se přes tuhle cestu smí mazat jen PNG; video info panelu
  // má vlastní endpoint, který maže celé pole videa.
  const povolene = slide.typ === "vid" ? (GALERIE_PRIPONY as readonly string[]) : [".png"];
  if (!povolene.includes(pripona)) return false;
  const dir = slideDirPath(id, slide.slozka);
  try {
    await fs.unlink(path.join(dir, safe));
  } catch {
    return false;
  }
  // S fotkou odchází i její originál a záznam o výřezu, ať ve složce
  // nezůstávají sirotci po smazaných fotkách.
  await zapomenVyrez(dir, safe);
  // Po vyjmutí položky srovnáme čísla zpět na souvislou řadu.
  if (slide.typ === "3d") await renumberSequence(id, slide.slozka);
  if (slide.typ === "vid") await renumberGalerie(id, slide.slozka);
  await touchDisplay(id);
  return true;
}

// Označení fotky jako "mapa výskytu": soubor se přejmenuje na mapa.png.
// Dosavadní mapa (pokud existuje) se vrátí mezi běžné fotky. `nazev: null`
// značení zruší (mapa.png se stane běžnou fotkou).
export async function setMapa(
  id: string,
  n: number,
  nazev: string | null,
): Promise<{ ok: boolean; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide || slide.typ !== "info") {
    return { ok: false, chyba: "Mapa výskytu patří jen na info panel." };
  }
  const dir = slideDirPath(id, slide.slozka);
  const mapaPath = path.join(dir, MAPA_SOUBOR);

  const demote = async () => {
    try {
      await fs.rename(mapaPath, path.join(dir, uniquePngName()));
    } catch {
      // mapa.png neexistuje, není co vracet
    }
  };

  if (nazev === null) {
    await demote();
    await touchDisplay(id);
    return { ok: true };
  }

  const safe = path.basename(nazev);
  if (path.extname(safe).toLowerCase() !== ".png" || safe === MAPA_SOUBOR) {
    return { ok: false, chyba: "Neplatný název souboru." };
  }
  try {
    await fs.access(path.join(dir, safe));
  } catch {
    return { ok: false, chyba: "Fotka nenalezena." };
  }
  await demote();
  await fs.rename(path.join(dir, safe), mapaPath);
  await touchDisplay(id);
  return { ok: true };
}

// --- Video (položka galerie _vid, volitelně jedno na info panelu) ---

// Rezervovaná jména zařízení na Windows (i s příponou, např. CON.mp4),
// zápis pod nimi na Windows selže nebo míří na zařízení, ne na soubor.
const WIN_REZERVOVANA = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

// Exportované, protože stejnou ochranu potřebují i díry v zemi (diry.ts).
export function sanitizeFilename(name: string): string {
  let base = path
    .basename(name)
    .replace(/[^\w.\- áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/g, "_")
    .replace(/[. ]+$/g, ""); // Windows zahazuje koncové tečky a mezery
  if (!base || WIN_REZERVOVANA.test(base)) base = `video-${Date.now()}`;
  return base;
}

export async function saveVideo(
  id: string,
  n: number,
  filename: string,
  data: Buffer,
): Promise<{ ok: boolean; url?: string; chyba?: string }> {
  const slide = await findSlide(id, n);
  if (!slide || (slide.typ !== "vid" && slide.typ !== "info")) {
    return { ok: false, chyba: "Video patří jen do galerie nebo na info panel." };
  }
  const dir = slideDirPath(id, slide.slozka);

  if (slide.typ === "vid") {
    // Galerie unese videí kolik chce, nové se PŘIDÁ na konec řady, nic se
    // nepřepisuje. Dočasné jméno se řadí za všechno očíslované a hned nato
    // se složka přečísluje. Původní název souboru se zahazuje schválně:
    // v galerii rozhoduje pořadové číslo, ne jak se soubor jmenoval.
    const docasny = `zzz-nove-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}.mp4`;
    await writeFileAtomic(path.join(dir, docasny), data);
    await renumberGalerie(id, slide.slozka);
    const po = await galerieSoubory(id, slide.slozka);
    const nazev = po[po.length - 1] ?? docasny;
    await touchDisplay(id);
    return { ok: true, url: slideFileUrl(id, slide.slozka, nazev) };
  }

  // Info panel má nejvýš jedno video, nové nahradí staré.
  const stara = await listFiles(id, slide.slozka, ".mp4");
  let safe = sanitizeFilename(filename);
  if (path.extname(safe).toLowerCase() !== ".mp4") {
    safe = safe.replace(/\.[^.]*$/, "") + ".mp4";
  }
  // Pořadí je schválně opačné než dřív: nejdřív se atomicky zapíše nové video
  // a teprve po úspěchu se smaže staré. Když upload selže, na slidu zůstane
  // původní video místo prázdna.
  await writeFileAtomic(path.join(dir, safe), data);
  for (const old of stara) {
    if (old === safe) continue; // právě zapsaný soubor stejného jména
    await fs.unlink(path.join(dir, old)).catch(() => {});
  }
  await touchDisplay(id);
  return { ok: true, url: slideFileUrl(id, slide.slozka, safe) };
}

// Smaže video info panelu (ten má nejvýš jedno). Na galerii se schválně
// nevztahuje: tam se maže po jedné položce přes deleteMedia(), tohle by
// smazalo všechna videa najednou.
export async function deleteVideo(id: string, n: number): Promise<boolean> {
  const slide = await findSlide(id, n);
  if (!slide || slide.typ !== "info") return false;
  for (const v of await listFiles(id, slide.slozka, ".mp4")) {
    try {
      await fs.unlink(path.join(slideDirPath(id, slide.slozka), v));
    } catch {
      // ignore
    }
  }
  await touchDisplay(id);
  return true;
}

// --- Správa slidů (pořadí drží číselný prefix názvu složky) ---

// Přejmenuje složky tak, aby prefixy tvořily souvislou řadu 1..k v zadaném
// pořadí. Dvoufázově (přes dočasné názvy), aby se cílové názvy nesrazily.
// Projde jazyky, které na disku existují. Struktura se řídí češtinou, ale
// přejmenování i mazání se musí promítnout i do překladů, jinak by se
// přeložený text po přečíslování přilepil k cizímu slidu.
async function proJazyky(id: string, akce: (jazyk: Jazyk) => Promise<void>): Promise<void> {
  for (const jazyk of JAZYKY) {
    try {
      await fs.access(jazykDir(id, jazyk));
    } catch {
      continue; // jazyk zatím nemá složku, není co řešit
    }
    await akce(jazyk);
  }
}

async function renumberSlides(id: string, ordered: SlideDirInfo[]): Promise<void> {
  const tmp: { from: string; to: string }[] = [];
  ordered.forEach((s, i) => {
    // Suffix se zachová takový, jaký je na disku (kvůli variantě _mod).
    tmp.push({ from: s.slozka, to: `${i + 1}_${s.suffix}` });
  });
  const changing = tmp.filter((t) => t.from !== t.to);
  if (changing.length === 0) return;

  await proJazyky(id, async (jazyk) => {
    const dir = jazykDir(id, jazyk);
    // Překlad nemusí mít složku každého slidu, přejmenujeme jen co existuje.
    const zdejsi: { from: string; to: string }[] = [];
    for (const t of changing) {
      try {
        await fs.access(path.join(dir, t.from));
        zdejsi.push(t);
      } catch {
        // tenhle slide v tomhle jazyce zatím nikdo nepřeložil
      }
    }
    for (const t of zdejsi) {
      await renameSPokusy(path.join(dir, t.from), path.join(dir, `.tmp-${t.to}`));
    }
    for (const t of zdejsi) {
      await renameSPokusy(path.join(dir, `.tmp-${t.to}`), path.join(dir, t.to));
    }
  });
}

// Nový slide se zařadí ZA POSLEDNÍ SLIDE STEJNÉHO TYPU, ne na konec řady:
// na tabletu mají jít slidy stejného druhu po sobě (všechny „Informace"
// pohromadě), jinak z toho kurátor musí pořadí složitě přetahovat ručně.
// Když displej zatím žádný slide daného typu nemá, přidá se na konec.
//
// Vrací ČÍSLO, které slide má po zařazení — ne to, pod kterým vznikla
// složka. CMS na něj hned přepíná záložku, takže musí sedět s diskem.
export async function addSlide(id: string, typ: SlideTyp): Promise<number> {
  const slides = await listSlides(id);
  const next = (slides.length ? Math.max(...slides.map((s) => s.n)) : 0) + 1;
  const slozka = `${next}_${typ}`;
  await fs.mkdir(path.join(csDir(id), slozka), { recursive: true });

  // Poslední slide téhož typu. `_mod` i `_3d` mají typ "3d", takže se
  // porovnává typ, ne suffix složky.
  const posledniStejny = [...slides].reverse().find((s) => s.typ === typ);
  if (!posledniStejny) {
    await touchDisplay(id);
    return next;
  }

  const novy: SlideDirInfo = { n: next, typ, suffix: typ, slozka };
  const poradi: SlideDirInfo[] = [];
  for (const s of slides) {
    poradi.push(s);
    if (s.n === posledniStejny.n) poradi.push(novy);
  }
  await renumberSlides(id, poradi);
  await touchDisplay(id);
  return posledniStejny.n + 1;
}

export async function removeSlide(id: string, n: number): Promise<{ ok: boolean; chyba?: string }> {
  const slides = await listSlides(id);
  const slide = slides.find((s) => s.n === n);
  if (!slide) return { ok: false, chyba: "Slide nenalezen." };
  // Smaže se slide ve všech jazycích, ne jen český originál.
  await proJazyky(id, async (jazyk) => {
    await fs.rm(slideDirPath(id, slide.slozka, jazyk), { recursive: true, force: true });
  });
  await renumberSlides(
    id,
    slides.filter((s) => s.n !== n),
  );
  await touchDisplay(id);
  return { ok: true };
}

export async function reorderSlides(id: string, poradi: number[]): Promise<void> {
  const slides = await listSlides(id);
  const byN = new Map(slides.map((s) => [s.n, s]));
  const next: SlideDirInfo[] = [];
  for (const n of poradi) {
    const s = byN.get(n);
    if (s && !next.includes(s)) next.push(s);
  }
  // Nevyjmenované slidy zachováme na konci ve stávajícím pořadí.
  for (const s of slides) if (!next.includes(s)) next.push(s);
  await renumberSlides(id, next);
  await touchDisplay(id);
}

// --- Stav jazyků -----------------------------------------------------
//
// Kolik přeložitelných položek čeština má a kolik z nich v daném jazyce
// chybí. Položka = info panel (název druhu), oba texty každého textového
// slidu a znalostní báze. Podle toho se v CMS ukazuje „EN chybí".
//
// Taxonomie se schválně NEPOČÍTÁ: je nepovinná, a kdyby se počítala,
// rozsvítilo by se „EN chybí" u všech displejů kvůli údaji, který kurátor
// vyplňovat nemusí.

export interface StavJazyka {
  jazyk: Jazyk;
  celkem: number; // kolik položek je vyplněných v češtině
  chybi: number; // kolik z nich v tomhle jazyce není
  hotovo: boolean;
}

export async function stavJazyku(id: string): Promise<StavJazyka[]> {
  const slides = await listSlides(id);
  const vyplneno = async (jazyk: Jazyk): Promise<Set<string>> => {
    const mnozina = new Set<string>();
    for (const s of slides) {
      if (s.typ === "info") {
        const pole = await readInfoPole(id, s.slozka, jazyk);
        if ((pole.Nazev ?? "").trim()) mnozina.add(`info:${s.n}`);
      } else if (s.typ === "gal") {
        // Oba texty se překládají zvlášť, proto se počítají jako dvě
        // položky (stejně jako u `_txt`). Taxonomie se nepočítá.
        const pole = await readGalPole(id, s.slozka, jazyk);
        for (const klic of TEXTOVE_KLICE) {
          if ((pole[klic] ?? "").trim()) mnozina.add(`gal:${s.n}:${klic}`);
        }
      } else if (s.typ === "txt") {
        // Oba texty se překládají zvlášť, proto se počítají jako dvě
        // položky: přeložený jen jeden z nich = jazyk ještě není hotový.
        const pole = await readTextSlide(id, s.slozka, jazyk);
        for (const klic of TEXTOVE_KLICE) {
          if ((pole[klic] ?? "").trim()) mnozina.add(`txt:${s.n}:${klic}`);
        }
      }
    }
    if ((await readKb(id, jazyk)).trim()) mnozina.add("kb");
    return mnozina;
  };

  const cs = await vyplneno("cs");
  const stav: StavJazyka[] = [];
  for (const jazyk of JAZYKY) {
    const moje = jazyk === "cs" ? cs : await vyplneno(jazyk);
    const chybi = [...cs].filter((klic) => !moje.has(klic)).length;
    stav.push({ jazyk, celkem: cs.size, chybi, hotovo: cs.size > 0 && chybi === 0 });
  }
  return stav;
}

// --- Přehled displejů ---

// Náhledová fotka displeje do přehledu. Hledá se podle PRIORITY TYPU slidu,
// ne v pořadí, v jakém slidy na displeji leží: náhled má být fotka druhu, a ta
// je na info panelu bez ohledu na to, kolikátý ten slide je.
//
//   1. info panel   první fotka (NIKDY mapa výskytu, viz níž)
//   2. galerie      první položka, která není video
//   3. textový slide jeho jediná fotka
//   4. null         přehled ukáže placeholder (ikona v Displays.tsx)
//
// POZOR na `mapa.png`: mapa výskytu se jako náhled nebere ANI když je to
// jediné PNG na info panelu. Dřív tu byl fallback `?? pngs[0]`, kvůli kterému
// displej s videem a mapou (ale bez fotky) ukazoval v přehledu mapu světa
// a kurátoři z toho nepoznali, o který druh jde. Prázdný náhled je čitelnější
// než špatný, a od té doby se stejně dřív sáhne do galerie.
async function thumbnailFor(id: string): Promise<string | null> {
  const slides = await listSlides(id);

  // 1. Info panel: fotka druhu, mapa výskytu se vynechá.
  for (const s of slides.filter((x) => x.typ === "info")) {
    const fotka = (await listFiles(id, s.slozka, ".png")).find((f) => f !== MAPA_SOUBOR);
    if (fotka) return slideFileUrl(id, s.slozka, fotka);
  }

  // 2. Galerie: první fotka. Video se na náhled nehodí, prohlížeč by z něj
  // v seznamu displejů musel tahat snímek.
  for (const s of slides.filter((x) => x.typ === "vid")) {
    const fotka = (await galerieSoubory(id, s.slozka)).find((f) => !jeGalerieVideo(f));
    if (fotka) return slideFileUrl(id, s.slozka, fotka);
  }

  // 3. Textový slide: má nejvýš jednu fotku, ale pořád je to fotka druhu.
  for (const s of slides.filter((x) => x.typ === "gal")) {
    const fotka = (await listFiles(id, s.slozka, ".png"))[0];
    if (fotka) return slideFileUrl(id, s.slozka, fotka);
  }

  return null;
}

export async function listDisplays(): Promise<DisplaySummary[]> {
  let ids: string[];
  try {
    ids = await fs.readdir(DISPLAYS_DIR);
  } catch {
    return [];
  }
  // Jen číselné složky do POSLEDNI_DISPLEJ včetně. Nečíselné (zálohy typu
  // "7-zaloha") a čísla nad rozsah pavilonu do přehledu nepatří: fyzicky
  // takové displeje nejsou, zůstaly po generování dat. Na disku se nic
  // nemaže a přímá adresa /displays/33 dál funguje.
  const numeric = ids
    .filter((id) => /^\d+$/.test(id) && Number(id) <= POSLEDNI_DISPLEJ)
    .sort((a, b) => Number(a) - Number(b));

  const out: DisplaySummary[] = [];
  const ted = Date.now(); // jeden čas pro celý výpis, ať se stavy neliší podle pořadí
  for (const id of numeric) {
    const meta = await readMeta(id);
    if (!meta) continue;
    const zarizeni = stavDispleje(Number(id), ted);
    out.push({
      id,
      druh: meta.druh,
      category: meta.category ?? null,
      jazyky: Object.fromEntries(
        (await stavJazyku(id)).map((s) => [s.jazyk, s.hotovo]),
      ) as Record<Jazyk, boolean>,
      latin_name: meta.latin_name ?? null,
      cekaNaRevizi: meta.cekaNaRevizi === true,
      stav: zarizeni.stav,
      naposledy: zarizeni.naposledy,
      verze: zarizeni.verze,
      posledniZmena: meta.posledniZmena,
      thumbnail: await thumbnailFor(id),
    });
  }
  return out;
}
