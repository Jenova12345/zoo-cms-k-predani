// Znalostní báze rozdělená na sekce: kb.md <-> pole strukturovaného editoru.
//
// Formát kb.md je dohodnutý s Danem (chatbot): devět sekcí, každá pod svým
// nadpisem `## Nadpis`, v pevném pořadí. Podle nadpisů si chatbot hledá
// správnou pasáž, takže se jejich znění nesmí měnit od boku; kostru pro nový
// druh drží server (server/src/kbTemplate.ts) a musí být s tímhle souborem
// shodná. Hlídá to `npm run kb-check`.
//
// Modul je schválně bez Reactu, aby šel spustit a otestovat samostatně
// (stejně jako drafty.ts).
//
// ZÁSADNÍ vlastnost: rozdelKb() -> slozKb() nesmí ztratit ani bajt textu
// kurátora. Proto se nic nezahazuje:
//   - text nad prvním `##` (typicky H1 s názvem druhu) jde do `preambule`,
//   - nadpis, který nepoznáme, jde i s původním řádkem `## …` do „Další",
//   - stejná sekce dvakrát se spojí, ne přepíše.

export interface Sekce {
  klic: string; // stabilní klíč pro stav editoru, nikdy se nezapisuje do souboru
  nadpis: string; // PŘESNÉ znění `## Nadpis` v kb.md
  napoveda: string; // co do sekce patří, ukazuje se pod polem v editoru
}

// Pořadí je pořadím v souboru i v editoru. Nemíchat.
export const SEKCE: Sekce[] = [
  {
    klic: "popis",
    nadpis: "Popis",
    napoveda: "Jak druh vypadá, jak je velký, jak dlouho se dožívá, čím je nápadný.",
  },
  {
    klic: "potrava",
    nadpis: "Potrava",
    napoveda: "Čím se živí ve volné přírodě a čím u nás, jak potravu získává.",
  },
  {
    klic: "habitat",
    nadpis: "Habitat",
    napoveda: "Kde žije geograficky i typ prostředí, jaké podmínky potřebuje.",
  },
  {
    klic: "chovani",
    nadpis: "Chování",
    napoveda: "Denní nebo noční aktivita, sociální chování, komunikace, pohyb.",
  },
  {
    klic: "rozmnozovani",
    nadpis: "Rozmnožování",
    napoveda: "Období, námluvy, kladení vajíček, péče o potomstvo.",
  },
  {
    klic: "zajimavosti",
    nadpis: "Zajímavosti",
    napoveda: "Překvapivé a zapamatovatelné věci, které si návštěvník odnese.",
  },
  {
    klic: "ohrozeni",
    nadpis: "Ohrožení",
    napoveda: "Jestli je druh ohrožený, čím, a jakou roli hraje zoo.",
  },
  {
    klic: "expozice",
    nadpis: "V naší expozici",
    napoveda:
      "Naše konkrétní zvířata: kolik jich máme, jak se jmenují, čím jsou zvláštní, kdy je nejlépe vidět.",
  },
  {
    klic: "dalsi",
    nadpis: "Další",
    napoveda:
      "Co se nevejde jinam: nové objevy, souvislosti, odpovědi na dotazy, které se opakují.",
  },
];

// Záchytná sekce pro nadpisy, které nepoznáme. Je to normální sekce, do které
// kurátor i sám píše; navíc do ní padá obsah, který by se jinak ztratil.
export const KLIC_DALSI = "dalsi";

export type KbPole = Record<string, string>;

export interface RozdelenaKb {
  // Text nad prvním `##`. Typicky `# Znalostní báze: Axolotl mexický` plus
  // úvodní věta. Volná KB bez jediného nadpisu skončí celá tady.
  preambule: string;
  pole: KbPole; // klic sekce -> text pod nadpisem
  poznamky: string[]; // co má kurátor vidět (neznámý nadpis, sekce dvakrát…)
}

// Zástupný text, který zakládá seed u nepřiřazeného displeje. Autoritativní
// kopie je server/src/content.ts (DEFAULT_KB). Porovnává se přesně, ne
// heuristikou: je to jediný text, u kterého víme jistě, že ho nepsal kurátor,
// a nemá smysl ho tahat do editoru.
const VYCHOZI_ZASTUPNY =
  "# Znalostní báze\n\nDisplej zatím není přiřazen. Po přiřazení druhu sem doplňte podklady pro AI průvodce.";

// --- Rozpoznávání nadpisů ----------------------------------------------

// Nadpis sekce je VÝHRADNĚ `## `, nikdy `###` a hlubší. Je to zásadní:
// v existujících kb.md jsou pod `## Texty z původních slidů` podnadpisy
// `### Popis`, `### Potrava`, `### Ohrožení`. Kdyby se braly i trojky,
// rozsekaly by cizí sekci a text by se rozlezl do polí, kam nepatří.
// `^##[ \t]+` to řeší samo: za `##` musí být mezera, takže `###` nesedí.
const NADPIS_RE = /^##[ \t]+(.+?)[ \t]*$/;

function normalizuj(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Starší a zkrácené tvary nadpisů, ať se rozdělí i KB, která nevznikla
// v tomhle editoru: dřívější kostra (`## Habitat a výskyt`, `## Ohrožení
// a ochrana`), jednotné číslo a klíč z infopanelu.
const ALIASY: Record<string, string> = {
  habitatavyskyt: "habitat",
  vyskyt: "habitat",
  prostredi: "habitat",
  ohrozeniaochrana: "ohrozeni",
  ochrana: "ohrozeni",
  zajimavost: "zajimavosti",
  strava: "potrava",
  vexpozici: "expozice",
  nasezvirata: "expozice",
  ostatni: KLIC_DALSI,
  nezarazeno: KLIC_DALSI,
};

const PODLE_NADPISU = new Map<string, string>();
for (const s of SEKCE) PODLE_NADPISU.set(normalizuj(s.nadpis), s.klic);
for (const [alias, klic] of Object.entries(ALIASY)) PODLE_NADPISU.set(alias, klic);

// Klíč sekce podle nadpisu ze souboru, nebo null když ho neznáme.
export function klicPodleNadpisu(nadpis: string): string | null {
  return PODLE_NADPISU.get(normalizuj(nadpis)) ?? null;
}

export function prazdnaPole(): KbPole {
  const pole: KbPole = {};
  for (const s of SEKCE) pole[s.klic] = "";
  return pole;
}

// --- kb.md -> pole -----------------------------------------------------

export function rozdelKb(text: string): RozdelenaKb {
  const pole = prazdnaPole();
  const poznamky: string[] = [];
  const cely = (text ?? "").replace(/\r\n/g, "\n");

  if (!cely.trim() || cely.trim() === VYCHOZI_ZASTUPNY) {
    return { preambule: "", pole, poznamky };
  }

  const preambule: string[] = [];
  // Do čeho se právě sbírá: null = preambule (jsme před prvním nadpisem).
  let cil: string | null = null;
  const nasbirane = new Map<string, string[]>();
  const videne = new Set<string>();

  const pridej = (radek: string) => {
    if (cil === null) {
      preambule.push(radek);
      return;
    }
    const seznam = nasbirane.get(cil) ?? [];
    seznam.push(radek);
    nasbirane.set(cil, seznam);
  };

  // Odděl to, co se do sekce teprve přilepí, od toho, co v ní už je: právě
  // jedním prázdným řádkem. Prázdné řádky, které na konci sbíraného textu
  // už jsou, se nejdřív seberou. Bez toho by se s každým uložením přidával
  // další (obsah „Další" projde parserem znovu při každém otevření) a text
  // by se pomalu roztahoval.
  const oddelPrazdnymRadkem = () => {
    if (cil === null) return;
    const seznam = nasbirane.get(cil);
    if (!seznam?.length) return;
    while (seznam.length && seznam[seznam.length - 1].trim() === "") seznam.pop();
    if (seznam.length) seznam.push("");
  };

  for (const radek of cely.split("\n")) {
    const nadpis = NADPIS_RE.exec(radek);
    if (!nadpis) {
      pridej(radek);
      continue;
    }

    const nazev = nadpis[1];
    const klic = klicPodleNadpisu(nazev);

    if (!klic) {
      // Neznámý nadpis: nezahazujeme ho ani nehádáme, kam patří. Jde do
      // „Další" i s původním řádkem `## …`, aby bylo vidět, odkud text je,
      // a aby se při uložení nic neztratilo.
      cil = KLIC_DALSI;
      oddelPrazdnymRadkem();
      pridej(`## ${nazev}`);
      poznamky.push(`nadpis „${nazev}“ neznáme, text pod ním jsme dali do sekce Další`);
      continue;
    }

    if (videne.has(klic)) {
      // Stejná sekce podruhé: spojit, ne přepsat.
      const sekce = SEKCE.find((s) => s.klic === klic)!;
      poznamky.push(`sekce „${sekce.nadpis}“ je v souboru víckrát, texty jsme spojili`);
      cil = klic;
      oddelPrazdnymRadkem();
      continue;
    }

    videne.add(klic);
    cil = klic;
  }

  for (const [klic, radky] of nasbirane) pole[klic] = orez(radky.join("\n"));

  const uvod = orez(preambule.join("\n"));
  if (uvod && videne.size === 0 && !nasbirane.has(KLIC_DALSI)) {
    poznamky.push(
      "tahle znalostní báze není rozdělená na sekce; text je celý v úvodu, rozeberte ho do polí níž",
    );
  }

  return { preambule: uvod, pole, poznamky };
}

// --- pole -> kb.md -----------------------------------------------------

// Prázdná sekce se do souboru NEZAPISUJE. Samotný nadpis bez textu chatbotu
// nic nedává a metodika kurátorům výslovně dovoluje sekci vynechat.
export function slozKb(rozdelena: { preambule: string; pole: KbPole }): string {
  const kusy: string[] = [];
  const uvod = orez(rozdelena.preambule ?? "");
  if (uvod) kusy.push(uvod);

  for (const s of SEKCE) {
    const text = orez(rozdelena.pole[s.klic] ?? "");
    if (!text) continue;
    // Text jde hned pod nadpis, bez prázdného řádku mezi. Tak vypadají
    // kb.md, které v datech už jsou; kdyby editor psal jinak, první uložení
    // by přeformátovalo celý soubor a diff by nešel přečíst.
    kusy.push(`## ${s.nadpis}\n${text}`);
  }

  return kusy.join("\n\n");
}

// Ořez krajů bez sahání do odsazení uvnitř: koncové mezery na řádcích pryč
// (v Markdownu jsou neviditelné a dělají falešné „neuloženo"), prázdné řádky
// na začátku a konci taky.
function orez(text: string): string {
  return text
    .split("\n")
    .map((r) => r.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

// Je v polích vůbec něco? Prázdnou KB server odmítne (PUT vyžaduje neprázdný
// text), takže se na to editor ptá dřív, než pošle požadavek.
export function jePrazdna(rozdelena: { preambule: string; pole: KbPole }): boolean {
  return slozKb(rozdelena).trim() === "";
}
