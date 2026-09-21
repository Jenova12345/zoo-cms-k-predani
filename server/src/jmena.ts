import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";
import { writeFileAtomic } from "./atomic.js";

// Seznam jmen lidí, kteří v CMS pracují. ZOO má jeden sdílený účet (login
// + heslo), ale sedí pod ním víc lidí — do auditu proto nestačí účet, musí
// tam být i konkrétní člověk. Jméno si každý vybere po přihlášení ze
// seznamu, který je tady.
//
// Stejná filozofie jako zbytek CMS: žádná databáze, jen soubor na disku
// vedle users.json.
//
//   {
//     "verze": 1,
//     "jmena": [
//       { "jmeno": "Franta", "pridano": "2026-09-18T…", "pridalUcet": "zoo" }
//     ]
//   }
//
// Schválně NE do users.json: ten má jiný životní cyklus (bcrypt hashe, práva
// 0600, pojistka proti úbytku účtů) a jména nejsou účty. Míchat obojí by
// znamenalo, že běžný kurátor zapisuje do souboru s hesly.
//
// Soubor se neservíruje přes HTTP — statické servírování je zúžené na
// data/displeje (viz index.ts).

export const JMENA_FILE = path.join(DATA_ROOT, "jmena.json");

// Jméno člověka, ne přihlašovací jméno: mezery a apostrofy jsou v pořádku
// („Anna Nováková", „O'Brien"), řídicí znaky a lomítka ne — v auditu se
// vypisuje jako „účet / jméno" a lomítko by tam mátlo.
const JMENO_RE = /^[\p{L}\p{N} .'-]{1,40}$/u;

export interface Jmeno {
  jmeno: string;
  pridano: string; // ISO datum
  pridalUcet: string; // účet, pod kterým se jméno přidalo
}

interface JmenaFile {
  verze: number;
  jmena: Jmeno[];
}

// Porovnáváme bez ohledu na velikost písmen i na okolní mezery, ať v seznamu
// neskončí „Franta" i „franta " jako dvě různé položky.
function klic(jmeno: string): string {
  return jmeno.trim().toLocaleLowerCase("cs");
}

export function validujJmeno(jmeno: string): string | null {
  const j = jmeno.trim();
  if (!j) return "Zadejte jméno.";
  if (!JMENO_RE.test(j)) {
    return "Jméno smí mít 1 až 40 znaků: písmena, číslice, mezera, tečka, pomlčka nebo apostrof.";
  }
  return null;
}

// Prázdný seznam vrací JEN když soubor prokazatelně neexistuje (ENOENT).
// Jiná chyba čtení ani poškozený JSON se nesmí tvářit jako „žádná jména",
// navázal by na to zápis, který by seznam tiše přepsal. Stejná úvaha jako
// u users.json.
export async function readJmena(): Promise<Jmeno[]> {
  let raw: string;
  try {
    raw = await fs.readFile(JMENA_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let data: JmenaFile;
  try {
    data = JSON.parse(raw) as JmenaFile;
  } catch {
    throw new Error(`${JMENA_FILE} je poškozený (nevalidní JSON), zápis by seznam přepsal.`);
  }
  if (!Array.isArray(data.jmena)) {
    throw new Error(`${JMENA_FILE} je poškozený (chybí pole jmena).`);
  }
  return data.jmena;
}

// Seznam pro výběr: řadíme česky, ať se v něm dá očima hledat.
export async function seznamJmen(): Promise<Jmeno[]> {
  return (await readJmena()).sort((a, b) => a.jmeno.localeCompare(b.jmeno, "cs"));
}

async function writeJmena(jmena: Jmeno[]): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const data: JmenaFile = { verze: 1, jmena };
  await writeFileAtomic(JMENA_FILE, JSON.stringify(data, null, 2) + "\n");
}

// Sedí zadané jméno na některé ze seznamu? Vrací jméno v té podobě, jak je
// v seznamu (ne jak ho poslal klient) — v auditu má stát „Franta", i když
// někdo pošle „franta".
export async function najdiJmeno(jmeno: string): Promise<string | null> {
  const k = klic(jmeno);
  return (await readJmena()).find((j) => klic(j.jmeno) === k)?.jmeno ?? null;
}

export async function pridejJmeno(
  jmeno: string,
  ucet: string,
): Promise<{ ok: boolean; chyba?: string }> {
  const chyba = validujJmeno(jmeno);
  if (chyba) return { ok: false, chyba };

  const jmena = await readJmena();
  const k = klic(jmeno);
  if (jmena.some((j) => klic(j.jmeno) === k)) {
    return { ok: false, chyba: `Jméno „${jmeno.trim()}" už v seznamu je.` };
  }
  jmena.push({ jmeno: jmeno.trim(), pridano: new Date().toISOString(), pridalUcet: ucet });
  await writeJmena(jmena);
  return { ok: true };
}

// Smazání jména NEPŘEPISUJE historii: audit je append-only, staré záznamy si
// své jméno nechají. Nevyhazuje ani nikoho, kdo pod tím jménem zrovna
// pracuje — dopracuje, při dalším přihlášení si vybere jiné.
//
// Prázdný seznam není zámek: přidat jméno jde i z obrazovky výběru, takže se
// smí smazat i to poslední.
export async function smazJmeno(jmeno: string): Promise<{ ok: boolean; chyba?: string }> {
  const jmena = await readJmena();
  const k = klic(jmeno);
  const zbyla = jmena.filter((j) => klic(j.jmeno) !== k);
  if (zbyla.length === jmena.length) {
    return { ok: false, chyba: `Jméno „${jmeno.trim()}" v seznamu není.` };
  }
  await writeJmena(zbyla);
  return { ok: true };
}
