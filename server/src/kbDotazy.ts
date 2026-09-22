import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeFileAtomic } from "./atomic.js";
import { KB_VYRESENO_FILE } from "./paths.js";

// Dotazy, které kurátor vyřešil (doplnil odpověď do znalostní báze).
//
// PROČ TO DRŽÍME MY: seznam dotazů dodává Danielův analytický backend a ten
// je jen ke ČTENÍ — nemáme kam si do něj poznamenat „tohle je hotové".
//
// PROČ SI KLÍČ POČÍTÁME: dotaz z backendu nemá žádné `id`. Přijde jako
// `{timestamp, session_id, display_id, species_latin, species_name,
// user_message, answered, language, mode}` a nic z toho není stabilní
// identifikátor. Klíč je proto otisk trojice, která jeden konkrétní dotaz
// určuje: čas + relace + text. Pořadí v odpovědi ani doba čtení do něj
// nevstupují, takže vyjde pokaždé stejně.
//
// ČÍM JE TO KŘEHKÉ: kdyby backend změnil formát času nebo začal text dotazu
// ořezávat, klíče se rozejdou a vyřešené dotazy se objeví jako nevyřešené.
// Nic se neztratí (soubor zůstane), ale bude to vypadat jako chyba.
// Normalizace níž to riziko zmenšuje, neodstraňuje — spolehlivé by bylo
// jedině `id` přímo od Daniela.

export interface VyresenyDotaz {
  cas: string; // kdy to kurátor odklikl
  uzivatel: string;
  jmeno?: string; // vybrané jméno člověka, viz audit.ts
  // Text dotazu a druh se ukládají ZÁMĚRNĚ podruhé, i když je backend taky
  // zná. Kdyby staré dotazy z backendu vypadly nebo se klíč rozešel, pořád
  // půjde vypsat, co se vyřešilo a kdo to odklikl.
  otazka: string;
  druh: string;
}

interface Soubor {
  verze: number;
  polozky: Record<string, VyresenyDotaz>;
}

const VERZE = 1;

// Text se před otiskem srovná: ořez krajů a slepení bílých znaků do jedné
// mezery. Kurátorovi to nic nemění a drobná úprava formátování na straně
// backendu tím pádem klíč nerozbije.
function srovnej(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Čas na ISO tvar. Backend ho posílá jako řetězec; kdyby jednou přišel
// s milisekundami a podruhé bez nich, otisk by se lišil, i když jde
// o tentýž okamžik.
function srovnejCas(cas: string): string {
  const ms = Date.parse(cas);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : srovnej(cas);
}

export function klicDotazu(dotaz: {
  timestamp: string;
  session_id: string;
  user_message: string;
}): string {
  const zaklad = [
    srovnejCas(dotaz.timestamp),
    srovnej(dotaz.session_id),
    srovnej(dotaz.user_message),
  ].join("\u0000");
  // 16 znaků = 64 bitů. Na pár tisíc dotazů ročně je šance na kolizi
  // zanedbatelná a klíč se vejde do URL i do logu.
  return createHash("sha256").update(zaklad).digest("hex").slice(0, 16);
}

const KLIC_RE = /^[0-9a-f]{16}$/;

export function platnyKlic(klic: string): boolean {
  return KLIC_RE.test(klic);
}

async function nacti(): Promise<Soubor> {
  try {
    const raw = await fs.readFile(KB_VYRESENO_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<Soubor>;
    if (data?.verze !== VERZE || !data.polozky || typeof data.polozky !== "object") {
      // Cizí nebo poškozený tvar: bereme jako prázdno. Zahodit se nic
      // nemůže — zapisuje se až při dalším označení a to soubor přepíše.
      return { verze: VERZE, polozky: {} };
    }
    return { verze: VERZE, polozky: data.polozky };
  } catch {
    return { verze: VERZE, polozky: {} }; // soubor ještě není
  }
}

export async function vyreseneDotazy(): Promise<Record<string, VyresenyDotaz>> {
  return (await nacti()).polozky;
}

// Zápisy chodí z jednoho procesu a jsou to jednotlivá kliknutí, ale číst
// a zapisovat celý soubor bez zámku by při dvou kliknutích těsně po sobě
// znamenalo, že se to druhé přepíše prvním. Fronta to serializuje.
let fronta: Promise<unknown> = Promise.resolve();

function vRade<T>(prace: () => Promise<T>): Promise<T> {
  const dalsi = fronta.then(prace, prace);
  // Chyba jedné operace nesmí zastavit frontu pro ty další.
  fronta = dalsi.catch(() => undefined);
  return dalsi;
}

export async function oznacVyreseny(
  klic: string,
  zaznam: VyresenyDotaz,
): Promise<{ pridano: boolean }> {
  return vRade(async () => {
    const data = await nacti();
    if (data.polozky[klic]) return { pridano: false }; // už označený, neprepisujeme kdo a kdy
    data.polozky[klic] = zaznam;
    await writeFileAtomic(KB_VYRESENO_FILE, `${JSON.stringify(data, null, 2)}\n`);
    return { pridano: true };
  });
}

export async function zrusVyreseny(klic: string): Promise<{ smazano: boolean }> {
  return vRade(async () => {
    const data = await nacti();
    if (!data.polozky[klic]) return { smazano: false };
    delete data.polozky[klic];
    await writeFileAtomic(KB_VYRESENO_FILE, `${JSON.stringify(data, null, 2)}\n`);
    return { smazano: true };
  });
}
