// Nápověda k psaní znalostní báze a hlídání zbytků šablony.
//
// Metodika je tady, ne v kb.md: co je v souboru, to čte chatbot a vydává za
// fakta o druhu. Kurátor edituje sekce ve formuláři (web/src/lib/kbSekce.ts),
// nadpisy do souboru doplní CMS; metodiku si tady jen rozklikne.

export interface MetodikaSekce {
  nadpis: string;
  body: string[];
}

export const KB_METODIKA: MetodikaSekce[] = [
  {
    nadpis: "Než začnete psát",
    body: [
      "Chatbot odpovídá návštěvníkům POUZE z tohoto textu. Co tu není, o tom neřekne, a co tu je, bude tvrdit jako fakt.",
      "Pište pro laika, ne odborně. Tón si chatbot upraví sám podle toho, jestli se ptá dítě nebo dospělý. Vy dodáváte fakta.",
      "Jedna myšlenka, jeden odstavec. Krátké odstavce se lépe vyhledávají než dlouhé bloky.",
    ],
  },
  {
    nadpis: "Jak psát fakta",
    body: [
      "Konkrétně: „dožívá se 10 až 15 let\" je lepší než „žije poměrně dlouho\". Čísla, jména, místa.",
      "Co nevíte, nevymýšlejte. Radši nechte sekci kratší; chatbot má instrukci nefabulovat a řekne, že to neví.",
      "Nemusíte vyplnit všechny sekce. Když druh nemá zajímavost hodnou zmínky, sekci klidně vynechte.",
    ],
  },
  {
    nadpis: "Sekce",
    body: [
      "Sekcí je devět a jsou pevně dané; do souboru se zapíšou vždy v tomhle pořadí. Nadpisy si CMS doplní sama, vy píšete jen text pod ně.",
      "Co do které sekce patří, je napsané pod jejím názvem ve formuláři.",
      "Nemusíte vyplnit všechny. Sekci, kterou necháte prázdnou, do kb.md vůbec nezapíšeme.",
      "„Další\" je na to, co se nevejde jinam: nové objevy, souvislosti, opakované dotazy. Skončí tam i text, jehož nadpis jsme při otevření souboru nepoznali.",
    ],
  },
];

// Pasáže, které do uloženého kb.md nepatří: nevyplněný zástupný nadpis
// a zbytky staré šablony i s ukázkami o pralesničce azurové. Hledá se bez
// ohledu na velikost písmen, kurátor mohl text ručně upravit.
const ZBYTKY: { hledej: string; popis: string }[] = [
  { hledej: "# název druhu", popis: "nevyplněný nadpis „# Název druhu\"" },
  // Zástupný text, který zakládá seed u nepřiřazených displejů.
  { hledej: "displej zatím není přiřazen", popis: "zástupný text „Displej zatím není přiřazen\"" },
  { hledej: "šablona kb.md pro kurátory", popis: "hlavička staré šablony" },
  { hledej: "tento soubor je vzor", popis: "věta „Tento soubor je vzor\"" },
  { hledej: "zkopírujte strukturu a vyplňte", popis: "pokyn „Zkopírujte strukturu a vyplňte\"" },
  { hledej: "text pod nadpisy je nápověda", popis: "metodická poznámka pro kurátora" },
  { hledej: "chatbot čerpá odpovědi pouze z tohoto textu", popis: "metodická poznámka pro kurátora" },
  { hledej: "jak to funguje (přečtěte si prosím", popis: "metodická kapitola „Jak to funguje\"" },
  { hledej: "příklad (pralesnička azurová)", popis: "ukázkový text o pralesničce azurové" },
  { hledej: "*základní představení druhu", popis: "kurzívová nápověda pod nadpisem Popis" },
  { hledej: "zkontrolujte, že jste psali konkrétně", popis: "závěrečná poznámka ze šablony" },
  { hledej: "příklad:", popis: "odstavec začínající „Příklad:\"" },
];

// Co ze šablony v textu zůstalo. Prázdné pole = čistý text kurátora.
export function zbytkySablony(text: string): string[] {
  const male = text.toLowerCase();
  const nalezene = ZBYTKY.filter((z) => male.includes(z.hledej)).map((z) => z.popis);
  return [...new Set(nalezene)];
}
