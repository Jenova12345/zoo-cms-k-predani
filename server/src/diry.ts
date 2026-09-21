import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";
import { writeFileAtomic } from "./atomic.js";
import { sanitizeFilename } from "./displays.js";

// Díry v zemi: dva zapuštěné expoziční prvky, které NEJSOU displeje.
//
// Michalův externí přehrávač si video čte přímo z disku a bere cokoli s
// příponou .mp4, co ve složce najde. Naše jediná úloha je dostat do té složky
// právě jeden soubor. Žádné meta.json, žádné slidy, žádný typ slidu:
// se strukturou data/displeje tohle nemá nic společného, proto vlastní modul
// a vlastní složky přímo v datovém kořeni (stejně jako prales.json).
//
//   <DATA_ROOT>/Cervori/<cokoli>.mp4
//   <DATA_ROOT>/Paleonaleziste/<cokoli>.mp4
//
// Na produkčním Windows serveru je DATA_ROOT C:\ZZ_CMS_Data, takže cesty
// vyjdou na C:\ZZ_CMS_Data\Cervori\ a C:\ZZ_CMS_Data\Paleonaleziste\.
//
// Názvy složek jsou schválně BEZ DIAKRITIKY, stejně jako klíče v text.txt:
// cestu čte cizí přehrávač a nemusí mít rozumné kódování. Kurátorovi se v CMS
// ukazuje `nazev` s diakritikou.

export interface DiraDef {
  id: string; // v URL endpointu
  nazev: string; // jak to zná obsluha
  slozka: string; // název složky v DATA_ROOT (ASCII)
}

export const DIRY: DiraDef[] = [
  { id: "cervori", nazev: "Červoři", slozka: "Cervori" },
  { id: "paleonaleziste", nazev: "Paleonaleziště", slozka: "Paleonaleziste" },
];

export function najdiDiru(id: string): DiraDef | null {
  return DIRY.find((d) => d.id === id) ?? null;
}

function slozkaDiry(dira: DiraDef): string {
  return path.join(DATA_ROOT, dira.slozka);
}

// Všechna .mp4 ve složce, seřazená. Neexistující složka není chyba, jen zatím
// nikdo nic nenahrál.
async function mp4VeSlozce(dira: DiraDef): Promise<string[]> {
  try {
    const soubory = await fs.readdir(slozkaDiry(dira));
    return soubory.filter((f) => path.extname(f).toLowerCase() === ".mp4").sort();
  } catch {
    return [];
  }
}

export interface StavDiry {
  id: string;
  nazev: string;
  slozka: string;
  cesta: string; // plná cesta na disku, ať ji kurátor vidí a umí zkontrolovat
  soubor: string | null; // název nahraného videa, null když tam nic není
  velikost: number | null; // v bajtech
  nahrano: string | null; // ISO čas poslední změny souboru
  // Víc než jedno .mp4 ve složce: přehrávač by nevěděl, které pustit. Nemělo
  // by nastat (upload po sobě uklízí), ale když někdo nakopíruje soubor ručně,
  // musí to být v CMS vidět.
  vicSouboru: string[];
}

export async function stavDiry(dira: DiraDef): Promise<StavDiry> {
  const soubory = await mp4VeSlozce(dira);
  const zaklad = {
    id: dira.id,
    nazev: dira.nazev,
    slozka: dira.slozka,
    cesta: slozkaDiry(dira),
    vicSouboru: soubory.length > 1 ? soubory : [],
  };
  if (soubory.length === 0) {
    return { ...zaklad, soubor: null, velikost: null, nahrano: null };
  }
  try {
    const st = await fs.stat(path.join(slozkaDiry(dira), soubory[0]));
    return {
      ...zaklad,
      soubor: soubory[0],
      velikost: st.size,
      nahrano: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return { ...zaklad, soubor: soubory[0], velikost: null, nahrano: null };
  }
}

export async function stavVsech(): Promise<StavDiry[]> {
  return Promise.all(DIRY.map(stavDiry));
}

// Uloží video do složky díry a nechá tam právě jeden soubor.
//
// POŘADÍ JE SCHVÁLNĚ TOHLE: nejdřív se atomicky zapíše nové video a teprve po
// úspěchu se uklidí ostatní .mp4. Kdyby se mazalo první, přerušený upload
// (200 MB po pavilonové síti) by nechal složku prázdnou a exponát by nehrál
// nic. Takhle zůstane hrát to původní a kurátor to jen zkusí znovu. Stejné
// pravidlo jako u videa na slidu, viz saveVideo v displays.ts.
export async function ulozVideo(
  dira: DiraDef,
  filename: string,
  data: Buffer,
): Promise<{ soubor: string }> {
  const dir = slozkaDiry(dira);
  await fs.mkdir(dir, { recursive: true }); // složka nemusí existovat

  let safe = sanitizeFilename(filename);
  if (path.extname(safe).toLowerCase() !== ".mp4") {
    safe = safe.replace(/\.[^.]*$/, "") + ".mp4";
  }

  const stara = await mp4VeSlozce(dira);
  await writeFileAtomic(path.join(dir, safe), data);
  for (const old of stara) {
    if (old === safe) continue; // právě přepsaný soubor stejného jména
    await fs.unlink(path.join(dir, old)).catch(() => {});
  }
  return { soubor: safe };
}
