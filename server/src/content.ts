// Reálný český obsah pro displeje 1-3 v novém formátu pro Unity:
// 1_info (pole do text.txt), 2_vid (prázdné, video nahraje kurátor),
// 3_gal (zajímavost: text.txt + jedna fotka), 4_ai (prázdná složka)
// a kb.md v kořeni.

export interface SeedDisplay {
  druh: string;
  barva: string; // pozadí PNG placeholderů
  celed: string; // taxonomická čeleď -> meta.section
  pole: Record<string, string>; // info panel: řádky "Klic: Hodnota" do text.txt
  zajimavost: string; // slide _gal: dlouhý odstavec do "Popis: …"
  kb: string; // znalostní báze kb.md v kořeni displeje
}

export const SEED_DISPLAYS: Record<number, SeedDisplay> = {
  1: {
    druh: "Axolotl mexický",
    barva: "#0f766e",
    celed: "Ambystomatidae",
    pole: {
      Sekce: "Neotenie, původ moderních obojživelníků",
      Nazev: "Axolotl mexický",
      Latinsky: "Ambystoma mexicanum",
      Strava: "vodní bezobratlí, larvy hmyzu, drobní korýši",
      Velikost: "25 až 30 cm",
      DobaLihnuti: "14 až 21 dní",
      Ohrozeni: "kriticky ohrožený",
      DelkaZivota: "10 až 15 let",
    },
    zajimavost:
      "Axolotl má mimořádnou schopnost regenerace: dokáže obnovit ztracené končetiny, ocas, části srdce i míchy bez vzniku jizev. Jev, kdy zůstává celý život v larvální formě i s vnějšími keříčkovitými žábrami, se nazývá neotenie. V přírodě dnes přežívají poslední populace jen v kanálech Xochimilca poblíž hlavního města Mexika.",
    kb: `# Znalostní báze: Axolotl mexický

Tato sekce slouží jako podklad pro AI průvodce u displeje. Obsahuje fakta, na která se návštěvníci nejčastěji ptají.

## Základní fakta
- Druh: Axolotl mexický (Ambystoma mexicanum)
- Skupina: ocasatí obojživelníci
- Velikost: 25 až 30 cm
- Zvláštnost: celý život si zachovává larvální podobu (neotenie)

## Popis
Axolotl mexický je ocasatý obojživelník, který si po celý život zachovává larvální podobu včetně vnějších keříčkovitých žaber. Dorůstá délky kolem 25 až 30 centimetrů a vyznačuje se širokou hlavou s výrazem připomínajícím úsměv. V přírodě má tmavě hnědé až olivové zbarvení, v chovech jsou běžné i světlé a růžové formy.

## Výskyt
Pochází z jezerní soustavy Xochimilco a dříve i Chalco poblíž hlavního města Mexika. Žije výhradně ve sladkovodních kanálech a jezerech v nadmořské výšce kolem 2 200 metrů. Dnes přežívají poslední divoké populace pouze v kanálech Xochimilca.

## Zajímavost
Axolotl má mimořádnou schopnost regenerace: dokáže obnovit ztracené končetiny, ocas, části srdce i míchy bez vzniku jizev. Jev, kdy zůstává celý život ve larvální formě, se nazývá neotenie.

## Ohrožení
V přírodě je axolotl kriticky ohrožený. Hlavními příčinami jsou znečištění vody, úbytek biotopu a vysazené invazní ryby. Ochranné programy se snaží obnovit kvalitu vody v kanálech Xochimilca.

## Časté otázky
- "Je to ryba?" Ne, je to obojživelník, příbuzný mloků a čolků.
- "Proč pořád vypadá jako mládě?" Kvůli neotenii zůstává ve vodní larvální formě i v dospělosti.
- "Umí dorůst nohu?" Ano, dokáže regenerovat končetiny i další orgány.
- "Kde žije?" V kanálech Xochimilco poblíž Ciudad de México.

## Tón odpovědí
Přátelský, stručný, vhodný pro děti i dospělé. Bez latinských termínů, pokud se na ně návštěvník přímo nezeptá.
`,
  },
  2: {
    druh: "Mlok skvrnitý",
    barva: "#a16207",
    celed: "Salamandridae",
    pole: {
      Sekce: "Caudata, obojživelníci s ocasem",
      Nazev: "Mlok skvrnitý",
      Latinsky: "Salamandra salamandra",
      Strava: "žížaly, slimáci, pavouci a hmyz",
      Velikost: "15 až 25 cm",
      Ohrozeni: "zvláště chráněný druh",
      DelkaZivota: "přes 20 let",
    },
    zajimavost:
      "Mlok skvrnitý nerodí vajíčka, ale rovnou živé larvy, které samice klade do chladné tekoucí vody. Žlutočerné zbarvení je u každého jedince trochu jiné, takže funguje jako otisk prstu a podle kresby se dá poznat konkrétní zvíře. Výrazné barvy nejsou pro ozdobu: varují predátory, že kůže vylučuje jedovatý sekret.",
    kb: `# Znalostní báze: Mlok skvrnitý

Podklad pro AI průvodce u displeje.

## Základní fakta
- Druh: Mlok skvrnitý (Salamandra salamandra)
- Skupina: ocasatí obojživelníci
- Velikost: 15 až 25 cm
- Zvláštnost: rodí živé larvy, žlutočerné varovné zbarvení

## Popis
Mlok skvrnitý je nápadný ocasatý obojživelník s leskle černým tělem a sytě žlutými až oranžovými skvrnami. Výrazné zbarvení je varovné a upozorňuje predátory na jedovaté kožní výměšky.

## Výskyt
Obývá vlhké listnaté a smíšené lesy s čistými potoky. Vyskytuje se ve velké části Evropy včetně České republiky. Přes den se ukrývá pod kameny a kládami, aktivní je hlavně za vlhka a po dešti.

## Zajímavost
Mlok skvrnitý nerodí vajíčka, ale rovnou živé larvy, které samice klade do chladné tekoucí vody. Žlutočerné zbarvení je u každého jedince trochu jiné, takže funguje jako otisk prstu.

## Ohrožení
Mloka ohrožuje úbytek vlhkých lesů, znečištění potoků a plísňové onemocnění Bsal. V České republice je zvláště chráněným druhem.

## Časté otázky
- "Je jedovatý?" Ano, kožní výměšky jsou jedovaté, proto má varovné zbarvení. Pro člověka při běžném pozorování není nebezpečný.
- "Žije i u nás?" Ano, vyskytuje se i v České republice, ve vlhkých lesích.
- "Proč je černožlutý?" Je to varování pro predátory.

## Tón odpovědí
Přátelský a poučný, zdůraznit ochranu druhu a jeho biotopu.
`,
  },
  3: {
    druh: "Rosnička zelená",
    barva: "#15803d",
    celed: "Hylidae",
    pole: {
      Sekce: "Obojživelníci České republiky",
      Nazev: "Rosnička zelená",
      Latinsky: "Hyla arborea",
      Strava: "drobný hmyz: mouchy, komáři, mšice, pavouci",
      Velikost: "4 až 5 cm",
      DobaLihnuti: "10 až 14 dní",
      Ohrozeni: "zvláště chráněný druh",
      DelkaZivota: "až 15 let",
    },
    zajimavost:
      "Samci rosničky mají velký hrdelní rezonátor a jejich hlasité sborové kvákání je slyšet do daleka. Lidé je dříve chovali ve sklenici jako živé barometry, protože před změnou počasí volaly víc. Přísavné terčíky na prstech jí dovolí šplhat po hladkých listech i po skle.",
    kb: `# Znalostní báze: Rosnička zelená

Podklad pro AI průvodce u displeje.

## Základní fakta
- Druh: Rosnička zelená (Hyla arborea)
- Skupina: žáby (bezocasí obojživelníci)
- Velikost: 4 až 5 cm
- Zvláštnost: jediná evropská žába, která šplhá; přísavné terčíky na prstech

## Popis
Rosnička zelená je drobná žába s hladkou, obvykle jasně zelenou kůží a tmavým pruhem po stranách těla. Na koncích prstů má přísavné terčíky, díky nimž se udrží i na listech a větvičkách. Zbarvení dokáže měnit podle prostředí a teploty.

## Výskyt
Žije v křovinách, na okrajích lesů, v zahradách a rákosinách poblíž stojatých vod. Rozšířená je ve velké části Evropy včetně teplejších oblastí České republiky.

## Zajímavost
Samci rosničky mají velký hrdelní rezonátor a jejich hlasité sborové kvákání je slyšet do daleka. Lidé je dříve chovali jako živé barometry, protože před změnou počasí více volaly.

## Ohrožení
Rosničku ohrožuje hlavně mizení a zarůstání tůní, znečištění vody a pesticidy. V České republice je zvláště chráněným druhem.

## Časté otázky
- "Proč kvákají tak nahlas?" Samci se ozývají, aby přilákali samice; mají velký hrdelní rezonátor.
- "Je to ta žába na barometr?" Ano, dříve se chovala jako živý předpovídač počasí.
- "Umí lézt po skle?" Ano, díky přísavkám na prstech.

## Tón odpovědí
Lehký a hravý, vhodný pro děti, zmínit šplhání a hlasité kvákání.
`,
  },
};

export const DEFAULT_KB =
  "# Znalostní báze\n\nDisplej zatím není přiřazen. Po přiřazení druhu sem doplňte podklady pro AI průvodce.\n";

// Jednoduchý SVG placeholder: barevný blok s názvem druhu a popiskem.
// Seed ho rasterizuje do PNG (Unity čte fotky jako .png).
export function placeholderSvg(druh: string, barva: string, popisek: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600" role="img" aria-label="${esc(druh)}">
  <rect width="800" height="600" fill="${barva}"/>
  <rect width="800" height="600" fill="url(#g)"/>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.18"/>
    </linearGradient>
  </defs>
  <text x="50%" y="46%" fill="#ffffff" font-family="Arial, sans-serif" font-size="56" font-weight="700" text-anchor="middle">${esc(druh)}</text>
  <text x="50%" y="56%" fill="#ffffff" fill-opacity="0.85" font-family="Arial, sans-serif" font-size="26" text-anchor="middle">${esc(popisek)}</text>
</svg>
`;
}
