import { promises as fs } from "node:fs";
import path from "node:path";
import { AUDIT_FILE, DATA_ROOT } from "./paths.js";

export interface AuditEntry {
  cas: string; // ISO datum
  uzivatel: string; // účet, pod kterým se akce stala
  // Jméno člověka vybrané po přihlášení. ZOO má jeden sdílený účet, takže
  // samotný účet neřekne, kdo co dělal. Je to SAMOSTATNÉ pole, ne slepenec
  // do `uzivatel`: záznamy zapsané před zavedením jmen ho nemají a zobrazí
  // se jen s účtem, nic se zpětně nerozbije.
  jmeno?: string;
  akce: string;
  cil: string;
}

// Audit log je append-only textový soubor. Dřív rostl bez omezení a čtení ho
// celý natáhlo do paměti, po roce provozu (upload každé fotky je řádek) to je
// desítky MB, které se překlopí do JSONu pro prohlížeč. Proto:
//   1. rotace podle velikosti (starší část se odloží stranou),
//   2. čtení od KONCE souboru, jen tolik řádků, kolik se opravdu vypisuje,
//   3. stránkování (limit + before), aby si frontend uměl donačíst starší.
const MAX_BAJTU = 5 * 1024 * 1024;
const MAX_ARCHIVU = 12; // ~60 MB historie, pak se nejstarší zahazuje

export const AUDIT_LIMIT_VYCHOZI = 100;
export const AUDIT_LIMIT_MAX = 500;

const ARCHIV_RE = /^audit-[\dT-]+\.jsonl$/;

function archivNazev(): string {
  // audit-2026-08-19T14-05-31.jsonl, lexikograficky = chronologicky.
  return `audit-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jsonl`;
}

// Odloží současný log stranou a nejstarší archivy zahodí.
async function rotuj(): Promise<void> {
  try {
    await fs.rename(AUDIT_FILE, path.join(DATA_ROOT, archivNazev()));
  } catch {
    return; // soubor mezitím zmizel nebo ho někdo drží; příště to vyjde
  }
  const archivy = await seznamArchivu();
  for (const stary of archivy.slice(MAX_ARCHIVU)) {
    await fs.rm(path.join(DATA_ROOT, stary), { force: true }).catch(() => {});
  }
}

// Archivy od nejnovějšího po nejstarší.
async function seznamArchivu(): Promise<string[]> {
  try {
    const vse = await fs.readdir(DATA_ROOT);
    return vse.filter((f) => ARCHIV_RE.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

// Append-only zápis jednoho řádku do data/audit.jsonl.
export async function appendAudit(entry: Omit<AuditEntry, "cas">): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const record: AuditEntry = { cas: new Date().toISOString(), ...entry };
  await fs.appendFile(AUDIT_FILE, JSON.stringify(record) + "\n", "utf8");
  try {
    const { size } = await fs.stat(AUDIT_FILE);
    if (size > MAX_BAJTU) await rotuj();
  } catch {
    // stat selhal, rotace počká na příští zápis
  }
}

// Řádky souboru od konce k začátku, po blocích. Pracuje se nad Buffery, ne nad
// řetězci: hranice bloku může rozseknout vícebajtový znak a dekódování půlky
// UTF-8 sekvence by rozbilo diakritiku.
async function* radkyOdKonce(soubor: string): AsyncGenerator<string> {
  let fh;
  try {
    fh = await fs.open(soubor, "r");
  } catch {
    return;
  }
  try {
    const { size } = await fh.stat();
    const BLOK = 64 * 1024;
    let pozice = size;
    let zbytek = Buffer.alloc(0);

    while (pozice > 0) {
      const delka = Math.min(BLOK, pozice);
      pozice -= delka;
      const buf = Buffer.alloc(delka);
      await fh.read(buf, 0, delka, pozice);
      const cely = Buffer.concat([buf, zbytek]);

      const radky: string[] = [];
      let konec = cely.length;
      for (let i = cely.length - 1; i >= 0; i--) {
        if (cely[i] !== 0x0a) continue;
        const radek = cely.subarray(i + 1, konec).toString("utf8").trim();
        if (radek) radky.push(radek);
        konec = i;
      }
      zbytek = Buffer.from(cely.subarray(0, konec));
      for (const r of radky) yield r;
    }
    const posledni = zbytek.toString("utf8").trim();
    if (posledni) yield posledni;
  } finally {
    await fh.close();
  }
}

function parsuj(radek: string): AuditEntry | null {
  try {
    const e = JSON.parse(radek) as AuditEntry;
    return typeof e?.cas === "string" ? e : null;
  } catch {
    return null;
  }
}

export interface AuditFiltr {
  limit?: number;
  before?: string; // ISO čas: odsud dál do minulosti
  // Kolik záznamů s časem přesně `before` už klient má. Čas sám o sobě jako
  // kurzor nestačí: hromadné akce (20 souběžných pokusů o přihlášení, import)
  // zapíšou několik záznamů ve stejné milisekundě a ty by na hranici stránky
  // buď vypadly, nebo se zopakovaly.
  preskoc?: number;
}

// Nejnovější záznamy první. Čte se od konce aktuálního souboru a v případě
// potřeby se pokračuje do archivů, takže "donačíst starší" funguje i přes
// rotaci. Do paměti se nikdy nedostane víc než `limit` záznamů.
export async function readAudit(filtr: AuditFiltr = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(filtr.limit ?? AUDIT_LIMIT_VYCHOZI), 1), AUDIT_LIMIT_MAX);
  const soubory = [AUDIT_FILE, ...(await seznamArchivu()).map((f) => path.join(DATA_ROOT, f))];
  const vysledek: AuditEntry[] = [];
  let jestePreskocit = Math.max(0, Math.trunc(filtr.preskoc ?? 0));

  for (const soubor of soubory) {
    for await (const radek of radkyOdKonce(soubor)) {
      const e = parsuj(radek);
      if (!e) continue;
      if (filtr.before) {
        if (e.cas > filtr.before) continue; // novější, klient už je má
        if (e.cas === filtr.before) {
          // Ve stejné milisekundě: přeskoč ty, které klient dostal minule.
          if (jestePreskocit > 0) {
            jestePreskocit--;
            continue;
          }
        }
      }
      vysledek.push(e);
      if (vysledek.length >= limit) return vysledek;
    }
  }
  return vysledek;
}
