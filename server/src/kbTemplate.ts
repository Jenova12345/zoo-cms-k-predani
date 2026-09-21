// Kostra znalostní báze, kterou editor předvyplní u nového druhu.
//
// V souboru je schválně JEN struktura nadpisů. Dřív tu byla celá metodika
// („jak psát") a u každé sekce ukázkový odstavec o pralesničce azurové. Když
// to kurátor uložil bez úprav, chatbot pak o jiném druhu tvrdil věci
// o pralesničce, text kb.md je jeho jediný zdroj, nerozliší vzor od faktu.
//
// Metodika i příklady se proto přesunuly do nápovědy v CMS (web/src/lib/
// kbSablona.ts), kde si je kurátor rozklikne, ale do souboru se nedostanou.
//
// NADPISY JSOU DOHODA S DANEM (chatbot): devět sekcí v tomhle pořadí, podle
// nich si chatbot hledá správnou pasáž. Strukturovaný editor v CMS je má
// zrcadlené ve web/src/lib/kbSekce.ts a obě kopie musí být shodné; že se
// nerozešly, ověřuje `npm run kb-check`.
export const KB_SEKCE = [
  "Popis",
  "Potrava",
  "Habitat",
  "Chování",
  "Rozmnožování",
  "Zajímavosti",
  "Ohrožení",
  "V naší expozici",
  "Další",
] as const;

export const KB_TEMPLATE = `# Název druhu\n\n${KB_SEKCE.map((n) => `## ${n}\n`).join("\n")}`;
