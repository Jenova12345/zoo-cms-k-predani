// Rozepsaný (neuložený) obsah kurátora vs. to, co je na disku.
//
// Pravidlo: pole, do kterého kurátor sáhl, patří jemu. Přenačtení displeje
// (po nahrání fotky, smazání fotky, označení mapy, nahrání videa, přehození
// slidů) smí přepsat jen to, čeho se nedotkl. Dřív se drafty přepisovaly
// bezpodmínečně, takže nahrání fotky smazalo rozepsaný formulář.
//
// Modul je schválně bez Reactu, aby se dal otestovat samostatně.

export type Dotcena = Set<string>;

export const KLIC_KB = "kb";
export const KLIC_CELED = "celed";

export function klicPole(n: number, klic: string): string {
  return `info:${n}:${klic}`;
}

// Textový slide (_gal) má na slidu víc polí (dva texty a tři části
// taxonomie), tedy stejný tvar značky jako info panel, jen s jinou předponou.
export function klicGalPole(n: number, klic: string): string {
  return `gal:${n}:${klic}`;
}

// Obecné informace (_txt) mají dvě pole na slide, tedy taky stejný tvar.
export function klicTextovehoPole(n: number, klic: string): string {
  return `txt:${n}:${klic}`;
}

// Minimum, které z obsahu slidu potřebujeme (kvůli testovatelnosti bez API typů).
interface SlideLike {
  n: number;
  typ: string;
  pole: Record<string, string>;
}

export type InfoDrafty = Record<number, Record<string, string>>;

// Data ze serveru + zachované rozepsané hodnoty dotčených polí. Společné pro
// typy, které mají na slidu víc textových polí (info panel, obecné informace);
// liší se jen typem slidu a předponou značky.
function slucPoleDrafty(
  prev: InfoDrafty,
  slidy: SlideLike[],
  dotcena: Dotcena,
  typ: string,
  klicFn: (n: number, klic: string) => string,
): InfoDrafty {
  const out: InfoDrafty = {};
  for (const s of slidy) {
    if (s.typ !== typ) continue;
    const draft = prev[s.n] ?? {};
    const vysledek: Record<string, string> = { ...s.pole };
    // Sjednocení klíčů: pole vyprázdněné kurátorem na disku vůbec není.
    for (const klic of new Set([...Object.keys(s.pole), ...Object.keys(draft)])) {
      if (dotcena.has(klicFn(s.n, klic))) vysledek[klic] = draft[klic] ?? "";
    }
    out[s.n] = vysledek;
  }
  return out;
}

export function slucInfoDrafty(
  prev: InfoDrafty,
  slidy: SlideLike[],
  dotcena: Dotcena,
): InfoDrafty {
  return slucPoleDrafty(prev, slidy, dotcena, "info", klicPole);
}

export function slucTextoveDrafty(
  prev: InfoDrafty,
  slidy: SlideLike[],
  dotcena: Dotcena,
): InfoDrafty {
  return slucPoleDrafty(prev, slidy, dotcena, "txt", klicTextovehoPole);
}

export function slucGalDrafty(
  prev: InfoDrafty,
  slidy: SlideLike[],
  dotcena: Dotcena,
): InfoDrafty {
  return slucPoleDrafty(prev, slidy, dotcena, "gal", klicGalPole);
}

export function slucText(prev: string, zeServeru: string, klic: string, dotcena: Dotcena): string {
  return dotcena.has(klic) ? prev : zeServeru;
}

// --- Neuložené změny ---------------------------------------------------

// Liší se rozepsaný formulář od toho, co je na disku? Porovnává se ořezaně:
// mezera navíc na konci pole není změna, o kterou by kurátor mohl přijít.
export function infoZmeneno(
  draft: Record<string, string> | undefined,
  pole: Record<string, string>,
): boolean {
  if (!draft) return false;
  for (const klic of new Set([...Object.keys(draft), ...Object.keys(pole)])) {
    if ((draft[klic] ?? "").trim() !== (pole[klic] ?? "").trim()) return true;
  }
  return false;
}

// Neuložená změna = pole, kterého se kurátor dotkl A které se zároveň liší
// od disku. Předvyplněná šablona (kb) tak „neuloženo" nedělá, kurátor do ní
// nesáhl, není o co přijít.
function poleNeulozeno(
  n: number,
  draft: Record<string, string> | undefined,
  pole: Record<string, string>,
  dotcena: Dotcena,
  klicFn: (n: number, klic: string) => string,
): boolean {
  if (!draft) return false;
  for (const klic of new Set([...Object.keys(draft), ...Object.keys(pole)])) {
    if (!dotcena.has(klicFn(n, klic))) continue;
    if ((draft[klic] ?? "").trim() !== (pole[klic] ?? "").trim()) return true;
  }
  return false;
}

export function infoNeulozeno(
  n: number,
  draft: Record<string, string> | undefined,
  pole: Record<string, string>,
  dotcena: Dotcena,
): boolean {
  return poleNeulozeno(n, draft, pole, dotcena, klicPole);
}

// Textový slide: stejné pravidlo, jen jiná předpona značky.
export function galNeulozeno(
  n: number,
  draft: Record<string, string> | undefined,
  pole: Record<string, string>,
  dotcena: Dotcena,
): boolean {
  return poleNeulozeno(n, draft, pole, dotcena, klicGalPole);
}

// Obecné informace: totéž s vlastní předponou.
export function textovyNeulozeno(
  n: number,
  draft: Record<string, string> | undefined,
  pole: Record<string, string>,
  dotcena: Dotcena,
): boolean {
  return poleNeulozeno(n, draft, pole, dotcena, klicTextovehoPole);
}

export function textZmeneno(draft: string, ulozeny: string): boolean {
  return draft.trim() !== ulozeny.trim();
}

// --- Přečíslování po změně pořadí --------------------------------------
// Server po reorderu přejmenuje složky na souvislou řadu 1.k v zadaném
// pořadí, takže slide, který byl `poradi[i]`, je nově `i + 1`. Drafty i
// značky dotčených polí se musí přestěhovat s ním, jinak by se rozepsaný
// text propsal do cizího slidu.

export function premapujDrafty<T>(zdroj: Record<number, T>, poradi: number[]): Record<number, T> {
  const out: Record<number, T> = {};
  poradi.forEach((stare, i) => {
    if (stare in zdroj) out[i + 1] = zdroj[stare];
  });
  return out;
}

export function premapujDotcena(dotcena: Dotcena, poradi: number[]): Dotcena {
  const nove: number[] = [];
  poradi.forEach((stare, i) => {
    nove[stare] = i + 1;
  });
  const out: Dotcena = new Set();
  for (const klic of dotcena) {
    const info = /^info:(\d+):(.*)$/.exec(klic);
    if (info) {
      const cil = nove[Number(info[1])];
      if (cil !== undefined) out.add(klicPole(cil, info[2]));
      continue;
    }
    const txt = /^txt:(\d+):(.*)$/.exec(klic);
    if (txt) {
      const cil = nove[Number(txt[1])];
      if (cil !== undefined) out.add(klicTextovehoPole(cil, txt[2]));
      continue;
    }
    const gal = /^gal:(\d+):(.*)$/.exec(klic);
    if (gal) {
      const cil = nove[Number(gal[1])];
      if (cil !== undefined) out.add(klicGalPole(cil, gal[2]));
      continue;
    }
    out.add(klic); // kb, celed, na čísle slidu nezávisí
  }
  return out;
}

// Po uložení už rozepsaná verze odpovídá disku, značky se zahodí.
export function zapomenSlide(dotcena: Dotcena, n: number): Dotcena {
  const out: Dotcena = new Set();
  for (const klic of dotcena) {
    if (
      klic.startsWith(`info:${n}:`) ||
      klic.startsWith(`gal:${n}:`) ||
      klic.startsWith(`txt:${n}:`)
    ) {
      continue;
    }
    out.add(klic);
  }
  return out;
}

export function zapomen(dotcena: Dotcena, ...klice: string[]): Dotcena {
  const out = new Set(dotcena);
  for (const k of klice) out.delete(k);
  return out;
}
