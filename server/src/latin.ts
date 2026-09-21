// Kanonický tvar latinského (vědeckého) jména druhu. Chatbot páruje druh na
// dotaz přesně přes latin_name, takže tvar musí být konzistentní:
//   'dendrobates tinctorius "azureus".'  ->  'Dendrobates tinctorius azureus'
//
// Pravidla: pryč uvozovky a koncová tečka, ořez krajů, kolaps mezer na jednu,
// rod (první písmeno) velké, zbytek malými.

const QUOTES = /["'“”‘’‚„«»`´]/g;

export function canonicalizeLatin(raw: string): string {
  let s = (raw ?? "").replace(QUOTES, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.\s]+$/g, "").trim(); // koncová tečka i případné mezery za ní
  if (!s) return "";
  s = s.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Byl vstup opravdu upraven? (pro upozornění kurátorovi)
export function latinBylUpraven(raw: string): boolean {
  return canonicalizeLatin(raw) !== (raw ?? "").trim();
}
