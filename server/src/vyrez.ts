import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { writeFileAtomic } from "./atomic.js";

// Výřez fotky ("jako profilovka na FB"). Kurátor si u fotky navolí, co z ní
// bude na tabletu vidět; my ji doopravdy ořízneme a ORIGINÁL SI NECHÁME,
// aby šlo výřez kdykoli posunout zpátky.
//
// Na disku to vypadá takhle (v běžné složce slidu):
//
//   foto-abc.png        oříznutá fotka — TOHLE čte Unity
//   foto-abc.png.orig   originál před oříznutím, jen pro CMS
//   .vyrezy.json        souřadnice výřezů, jen pro CMS
//
// Obě pomocné věci jsou pro Unity i pro zbytek CMS neviditelné: listFiles()
// porovnává příponu přesně (".orig" není ".png"), sekvence 360 vyžaduje
// ^(\d{3,})\.png$ a galerie bere jen .png/.jpg/.jpeg/.mp4.
//
// Ořezává se na POMĚR STRAN, ne na pevné rozlišení: fotka si nechá plné
// rozlišení, jaké z ořezu vyjde, a Unity si ji zobrazí v jakékoli velikosti.

export interface Vyrez {
  x: number; // vše 0..1 vůči ORIGINÁLU, ne vůči oříznuté fotce
  y: number;
  w: number;
  h: number;
}

export interface Pomer {
  sirka: number;
  vyska: number;
}

// Poměry, ve kterých Unity fotky zobrazuje (dodal Michal).
//
//   info  772:800  infopanel, skoro čtverec na výšku
//   gal   3:2      slide „Informace"
//   vid   16:10    galerie (1280:800)
//
// Co tu není, se neořezává:
//   3d    fáze 2 (hromadný ořez celé sekvence jedním výřezem),
//   mapa.png se neořezává vůbec, je to schéma a ořez by ukousl kus areálu,
//   video v galerii — to by se muselo překódovat, viz jdeOriznout().
export const POMERY: Record<string, Pomer> = {
  info: { sirka: 772, vyska: 800 },
  gal: { sirka: 3, vyska: 2 },
  vid: { sirka: 16, vyska: 10 },
  "3d": { sirka: 16, vyska: 10 },
};

export function pomerProTyp(typ: string): Pomer | null {
  return POMERY[typ] ?? null;
}

export function popisPomeru(p: Pomer): string {
  return `${p.sirka}:${p.vyska}`;
}

// Přípony, které umíme oříznout. Video se takhle oříznout nedá (muselo by se
// překódovat), takže se v galerii přeskočí.
const ORIZNUTELNE = [".png", ".jpg", ".jpeg"];

export function jdeOriznout(nazev: string): boolean {
  return ORIZNUTELNE.includes(path.extname(nazev).toLowerCase());
}

export const PRIPONA_ORIGINALU = ".orig";
export const SOUBOR_VYREZU = ".vyrezy.json";

export function origNazev(nazev: string): string {
  return `${nazev}${PRIPONA_ORIGINALU}`;
}

interface SouborVyrezu {
  verze: number;
  vyrezy: Record<string, Vyrez>;
  // Sekvence 360 má JEDEN výřez pro všechny snímky, ne výřez na snímek.
  // Kdyby se ukládal po souborech, bylo by tu 36 stejných záznamů a nic by
  // neřeklo, že mají zůstat stejné.
  sekvence?: Vyrez;
}

export async function readVyrezy(dir: string): Promise<Record<string, Vyrez>> {
  try {
    const raw = await fs.readFile(path.join(dir, SOUBOR_VYREZU), "utf8");
    const data = JSON.parse(raw) as SouborVyrezu;
    return data && typeof data === "object" && data.vyrezy ? data.vyrezy : {};
  } catch {
    // Chybí nebo je rozbitý: bereme jako "žádné výřezy". Je to jen pomůcka
    // pro editor, ne zdroj pravdy — ta je v samotných souborech na disku.
    return {};
  }
}

async function readCely(dir: string): Promise<SouborVyrezu> {
  try {
    const raw = await fs.readFile(path.join(dir, SOUBOR_VYREZU), "utf8");
    const data = JSON.parse(raw) as SouborVyrezu;
    if (data && typeof data === "object" && data.vyrezy) return data;
  } catch {
    // chybí nebo je rozbitý
  }
  return { verze: 1, vyrezy: {} };
}

async function writeVyrezy(dir: string, vyrezy: Record<string, Vyrez>): Promise<void> {
  const cely = await readCely(dir);
  const data: SouborVyrezu = { ...cely, verze: 1, vyrezy };
  await writeFileAtomic(path.join(dir, SOUBOR_VYREZU), JSON.stringify(data, null, 2) + "\n");
}

export async function readVyrezSekvence(dir: string): Promise<Vyrez | null> {
  return (await readCely(dir)).sekvence ?? null;
}

async function writeVyrezSekvence(dir: string, sekvence: Vyrez): Promise<void> {
  const cely = await readCely(dir);
  const data: SouborVyrezu = { ...cely, verze: 1, sekvence };
  await writeFileAtomic(path.join(dir, SOUBOR_VYREZU), JSON.stringify(data, null, 2) + "\n");
}

function omez(hodnota: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, hodnota));
}

// Největší výřez daného poměru, který se do fotky vejde, umístěný na střed.
// Tohle dostane každá nově nahraná fotka, aby na tabletu seděl poměr i tehdy,
// když kurátor editor jen zavře.
export function vyrezNaStred(sirkaPx: number, vyskaPx: number, pomer: Pomer): Vyrez {
  const cilovy = pomer.sirka / pomer.vyska;
  let w = sirkaPx;
  let h = Math.round(w / cilovy);
  if (h > vyskaPx) {
    h = vyskaPx;
    w = Math.round(h * cilovy);
  }
  return {
    x: (sirkaPx - w) / 2 / sirkaPx,
    y: (vyskaPx - h) / 2 / vyskaPx,
    w: w / sirkaPx,
    h: h / vyskaPx,
  };
}

// Normalizovaný výřez → pixely. Poměr se dopočítá znovu z šířky, ať sedí
// na pixel přesně i po zaokrouhlení; kdyby se vzaly obě strany tak, jak
// přišly z prohlížeče, mohl by být výsledek o pixel vedle.
function naPixely(v: Vyrez, sirkaPx: number, vyskaPx: number, pomer: Pomer) {
  const cilovy = pomer.sirka / pomer.vyska;
  let w = Math.round(omez(v.w, 0, 1) * sirkaPx);
  let h = Math.round(w / cilovy);
  if (h > vyskaPx) {
    h = vyskaPx;
    w = Math.round(h * cilovy);
  }
  if (w > sirkaPx) {
    w = sirkaPx;
    h = Math.round(w / cilovy);
  }
  w = Math.max(1, Math.min(w, sirkaPx));
  h = Math.max(1, Math.min(h, vyskaPx));
  // Posun se nakonec zarovná dovnitř fotky: kdyby výřez přetekl okraj,
  // sharp.extract() by spadl na "bad extract area".
  return {
    left: omez(Math.round(omez(v.x, 0, 1) * sirkaPx), 0, sirkaPx - w),
    top: omez(Math.round(omez(v.y, 0, 1) * vyskaPx), 0, vyskaPx - h),
    width: w,
    height: h,
  };
}

// Zdroj pro ořez: originál, když už existuje, jinak samotná fotka. Při prvním
// ořezu se originál založí ZE SOUČASNÉ fotky — než ji přepíšeme, ať se
// nedá ztratit ani při pádu uprostřed operace.
async function zajistiOriginal(dir: string, nazev: string): Promise<string> {
  const orig = path.join(dir, origNazev(nazev));
  try {
    await fs.access(orig);
    return orig;
  } catch {
    // originál zatím není
  }
  const soucasna = path.join(dir, nazev);
  await writeFileAtomic(orig, await fs.readFile(soucasna));
  return orig;
}

export interface VysledekOrezu {
  ok: boolean;
  chyba?: string;
  vyrez?: Vyrez;
  nazev?: string; // jméno po ořezu; u JPG se mění přípona na .png
}

// Unity čte fotky JEN jako PNG (potvrdil Michal). Ořezaná fotka proto vždycky
// odchází jako PNG, a když se ořezává starší JPG, změní se mu i přípona —
// jinak by na disku ležel soubor .jpg s PNG obsahem a tablet by ho neukázal.
export function pngNazev(nazev: string): string {
  return nazev.replace(/\.jpe?g$/i, ".png");
}

// Ořízne fotku na poměr. `vyrez` = null znamená "na střed" (nová fotka).
export async function oriznFotku(
  dir: string,
  nazev: string,
  pomer: Pomer,
  vyrez: Vyrez | null,
): Promise<VysledekOrezu> {
  if (!jdeOriznout(nazev)) {
    return { ok: false, chyba: "Tenhle soubor se ořezávat nedá (video se musí překódovat)." };
  }

  let origCesta: string;
  try {
    origCesta = await zajistiOriginal(dir, nazev);
  } catch {
    return { ok: false, chyba: "Originál fotky se nepodařilo přečíst." };
  }

  try {
    const zdroj = sharp(await fs.readFile(origCesta), { limitInputPixels: 40_000_000 });
    const meta = await zdroj.metadata();
    const sirkaPx = meta.width ?? 0;
    const vyskaPx = meta.height ?? 0;
    if (!sirkaPx || !vyskaPx) return { ok: false, chyba: "Fotku se nepodařilo přečíst." };

    const pouzity = vyrez ?? vyrezNaStred(sirkaPx, vyskaPx, pomer);
    const obdelnik = naPixely(pouzity, sirkaPx, vyskaPx, pomer);

    const data = await zdroj.extract(obdelnik).png().toBuffer();

    // Atomicky: Unity čte složku přímo a půlka souboru by mu udělala
    // rozbitý obrázek uprostřed expozice.
    const cil = pngNazev(nazev);
    await writeFileAtomic(path.join(dir, cil), data);

    if (cil !== nazev) {
      // Byl to JPG: původní soubor zmizí a originál i záznam jdou pod nové
      // jméno. Pořadí je schválně takové, že fotka pro Unity existuje
      // po celou dobu — nejdřív vznikne nová, teprve pak mizí stará.
      try {
        await fs.rename(path.join(dir, origNazev(nazev)), path.join(dir, origNazev(cil)));
      } catch {
        // originál se nepodařilo přejmenovat, zůstane pod starým jménem
      }
      try {
        await fs.unlink(path.join(dir, nazev));
      } catch {
        // starý soubor už není, nevadí
      }
    }

    // Uloží se výřez PŘEPOČÍTANÝ na skutečné pixely, ne to, co přišlo
    // z prohlížeče — editor se pak otevře přesně tam, kde fotka je.
    const ulozeny: Vyrez = {
      x: obdelnik.left / sirkaPx,
      y: obdelnik.top / vyskaPx,
      w: obdelnik.width / sirkaPx,
      h: obdelnik.height / vyskaPx,
    };
    const vsechny = await readVyrezy(dir);
    delete vsechny[nazev];
    vsechny[cil] = ulozeny;
    await writeVyrezy(dir, vsechny);

    return { ok: true, vyrez: ulozeny, nazev: cil };
  } catch {
    return { ok: false, chyba: "Ořez se nepodařil, fotka zůstala beze změny." };
  }
}

// Úklid po smazané fotce: originál i záznam o výřezu.
export async function zapomenVyrez(dir: string, nazev: string): Promise<void> {
  try {
    await fs.unlink(path.join(dir, origNazev(nazev)));
  } catch {
    // originál nebyl, nevadí
  }
  const vsechny = await readVyrezy(dir);
  if (nazev in vsechny) {
    delete vsechny[nazev];
    await writeVyrezy(dir, vsechny);
  }
}

// Přejmenování fotky (přečíslování galerie i sekvence 360) musí vzít
// originál i záznam s sebou, jinak by se výřez rozešel se svou fotkou.
export async function prejmenujVyrezy(
  dir: string,
  dvojice: { from: string; to: string }[],
): Promise<void> {
  if (dvojice.length === 0) return;
  const vsechny = await readVyrezy(dir);
  const nove: Record<string, Vyrez> = { ...vsechny };
  let zmena = false;
  for (const { from, to } of dvojice) {
    if (from === to) continue;
    if (from in vsechny) {
      delete nove[from];
      nove[to] = vsechny[from];
      zmena = true;
    }
  }
  if (zmena) await writeVyrezy(dir, nove);
}

// ── Hromadný ořez sekvence 360 ────────────────────────────────────────────
//
// Sekvence se ořezává JEDNÍM výřezem naráz, ne po snímcích: objekt se na
// snímcích otáčí, takže výřez musí sedět na celou otáčku, a kdyby se dal
// nastavit po jednom, animace by při přehrání poskakovala.
//
// Ořez 36+ snímků trvá desítky sekund. Kdyby se snímky přepisovaly rovnou,
// Unity by po celou tu dobu četlo sekvenci půl nově a půl staře oříznutou —
// a pád uprostřed by ten stav nechal na disku natrvalo. Proto se ořez dělá
// nadvakrát: nejdřív se všechno spočítá do souborů `<snímek>.png.part`
// (pro Unity i pro výpisy CMS neviditelných, přípona je ".part"), a teprve
// když projdou VŠECHNY, se naráz přejmenují na místo. Buď se tedy změní celá
// sekvence, nebo žádný snímek.
const PRIPONA_ROZDELANE = ".part";

// Zbytky po pádu z minula. Ořez je vždycky počítá znovu, takže staré se
// musí uklidit, aby se omylem nepřejmenoval snímek z předchozího pokusu.
async function uklidRozdelane(dir: string): Promise<void> {
  let soubory: string[];
  try {
    soubory = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const f of soubory) {
    if (!f.endsWith(PRIPONA_ROZDELANE)) continue;
    try {
      await fs.unlink(path.join(dir, f));
    } catch {
      // mezitím zmizel, nevadí
    }
  }
}

export async function oriznSekvenci(
  dir: string,
  soubory: string[],
  pomer: Pomer,
  vyrez: Vyrez,
  pokrok?: (hotovo: number, celkem: number) => void,
): Promise<{ ok: boolean; chyba?: string; vyrez?: Vyrez }> {
  const celkem = soubory.length;
  if (celkem === 0) return { ok: false, chyba: "Sekvence nemá žádné snímky." };

  await uklidRozdelane(dir);

  const rozdelane: string[] = [];
  let ulozeny: Vyrez | null = null;

  try {
    for (let i = 0; i < celkem; i++) {
      const nazev = soubory[i];
      const origCesta = await zajistiOriginal(dir, nazev);
      const zdroj = sharp(await fs.readFile(origCesta), { limitInputPixels: 40_000_000 });
      const meta = await zdroj.metadata();
      const sirkaPx = meta.width ?? 0;
      const vyskaPx = meta.height ?? 0;
      if (!sirkaPx || !vyskaPx) throw new Error(`snímek ${nazev} se nepodařilo přečíst`);

      const obdelnik = naPixely(vyrez, sirkaPx, vyskaPx, pomer);
      const data = await zdroj.extract(obdelnik).png().toBuffer();
      const tmp = path.join(dir, nazev + PRIPONA_ROZDELANE);
      await fs.writeFile(tmp, data);
      rozdelane.push(tmp);

      // Výřez se ukládá přepočítaný na pixely prvního snímku — editor se pak
      // otevře přesně tam, kde sekvence doopravdy je.
      if (ulozeny === null) {
        ulozeny = {
          x: obdelnik.left / sirkaPx,
          y: obdelnik.top / vyskaPx,
          w: obdelnik.width / sirkaPx,
          h: obdelnik.height / vyskaPx,
        };
      }
      pokrok?.(i + 1, celkem);
    }

    // Přepnutí naráz: tohle jsou milisekundy, ne minuty.
    for (let i = 0; i < celkem; i++) {
      await fs.rename(rozdelane[i], path.join(dir, soubory[i]));
    }
    await writeVyrezSekvence(dir, ulozeny!);
    return { ok: true, vyrez: ulozeny! };
  } catch (e) {
    // Nic se ještě nepřejmenovalo (nebo jen část, a ta je s novým výřezem
    // v pořádku) — smažeme rozdělané a sekvence zůstává tak, jak byla.
    for (const p of rozdelane) {
      try {
        await fs.unlink(p);
      } catch {
        // už je přejmenovaný nebo smazaný
      }
    }
    const duvod = e instanceof Error ? e.message : String(e);
    return { ok: false, chyba: `Ořez sekvence se nepodařil (${duvod}). Snímky zůstaly beze změny.` };
  }
}

// Doříznutí JEDNOHO snímku výřezem, který už sekvence má. Používá se, když
// kurátor přidá snímek do hotové sekvence — jinak by v otáčce zůstal jeden
// nezarovnaný záběr.
export async function doriznSnimek(
  dir: string,
  nazev: string,
  pomer: Pomer,
): Promise<{ ok: boolean; chyba?: string }> {
  const vyrez = await readVyrezSekvence(dir);
  if (!vyrez) return { ok: true }; // sekvence se ještě neořezávala, nic neděláme
  const res = await oriznSekvenci(dir, [nazev], pomer, vyrez);
  return { ok: res.ok, chyba: res.chyba };
}
