// Klientská verze kanonizace latinského jména, jen pro živý náhled v editoru.
// Autoritativní očištění dělá server (viz server/src/latin.ts); tato funkce
// musí držet stejná pravidla, aby náhled odpovídal tomu, co se uloží.

const QUOTES = /["'“”‘’‚„«»`´]/g;

export function canonicalizeLatin(raw: string): string {
  let s = (raw ?? "").replace(QUOTES, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.\s]+$/g, "").trim();
  if (!s) return "";
  s = s.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
