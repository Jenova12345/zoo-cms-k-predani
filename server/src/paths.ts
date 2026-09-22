import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// server/src -> repo root. Lze přepsat přes DATA_ROOT (kvůli budoucímu nasazení).
const repoRoot = path.resolve(here, "..", "..");

export const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.join(repoRoot, "data");

export const DISPLAYS_DIR = path.join(DATA_ROOT, "displeje");
export const AUDIT_FILE = path.join(DATA_ROOT, "audit.jsonl");

// Dotazy na AI, které kurátor vyřešil doplněním do znalostní báze. Seznam
// dotazů drží Danielův backend a je jen ke čtení, tohle je naše poznámka
// k nim (viz kbDotazy.ts).
export const KB_VYRESENO_FILE = path.join(DATA_ROOT, "kb-vyreseno.json");

// Události z tabletů (zapisuje Michalovo Unity): jeden soubor na den,
// jeden JSON na řádek, append only. Nově v podsložce podle čísla displeje
// (unity/2/2026-09-16.jsonl), starší soubory leží plocho přímo tady.
export const UDALOSTI_DIR = path.join(DATA_ROOT, "udalosti", "unity");

// Předpočítané denní souhrny událostí pro sekci Analytika (jeden soubor na
// měsíc). Je to JEN zrychlení, ne zdroj pravdy — smaž to a dopočítá se
// z logů. Leží schválně mimo udalosti/, do Michalovy složky nezapisujeme.
export const ANALYTIKA_DIR = path.join(DATA_ROOT, "analytika");

// Buildnutý web (vzniká přes `npm run build`). Servíruje ho stejný proces.
export const WEB_DIST = path.join(repoRoot, "web", "dist");

export const DISPLAY_COUNT = 37;

// Nejvyšší číslo displeje, který v pavilonu fyzicky je. Vyšší složky
// (32 a dál) zbyly po generování dat a do přehledu displejů se neukazují,
// viz listDisplays(). `DISPLAY_COUNT` výš je jen pro seed a schválně se
// nesnižuje: kdyby se změnil, `npm run seed` by přestal zakládat složky,
// které na disku pořád jsou.
export const POSLEDNI_DISPLEJ = 31;
