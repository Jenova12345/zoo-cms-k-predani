import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DISPLAYS_DIR, DISPLAY_COUNT } from "./paths.js";
import { SEED_DISPLAYS, DEFAULT_KB, placeholderSvg, type SeedDisplay } from "./content.js";
import { serializeInfoText, serializeGalText } from "./displays.js";
import { canonicalizeLatin } from "./latin.js";
import { VYCHOZI_HESLO, VYCHOZI_JMENO, zalozVychoziUcet } from "./users.js";
import { writeFileAtomic } from "./atomic.js";

// Vygeneruje strukturu složek pro všech 37 displejů ve formátu pro Unity:
//
//   <id>/kb.md                znalostní báze (kořen displeje)
//   <id>/meta.json            doplněk (druh, stav, poslední změna)
//   <id>/cs/1_info/text.txt   pole "Klic: Hodnota" + fotky .png + mapa.png
//   <id>/cs/2_vid/            galerie (fotky i videa nahraje kurátor)
//   <id>/cs/3_gal/text.txt    textový slide: dva texty + Taxonomie + fotka
//   <id>/cs/4_ai/             prázdná složka = AI slide
//
// Displeje 1-3 s obsahem, 4-37 jako "Nepřiřazeno" bez slidů (kurátor je
// přidá výběrem typu).

async function pngPlaceholder(druh: string, barva: string, popisek: string): Promise<Buffer> {
  return sharp(Buffer.from(placeholderSvg(druh, barva, popisek))).png().toBuffer();
}

async function seedDisplay(id: number, seed: SeedDisplay | null) {
  const root = path.join(DISPLAYS_DIR, String(id));
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "cs"), { recursive: true });

  const druh = seed ? seed.druh : "Nepřiřazeno";
  // Pár displejů offline kvůli realistickému status boardu.
  const stav: "online" | "offline" = id % 11 === 0 ? "offline" : "online";

  await writeFileAtomic(path.join(root, "kb.md"), seed ? seed.kb : DEFAULT_KB);

  const slidy: { slozka: string; typ: string }[] = [];
  if (seed) {
    // 1_info: pole + hlavní foto + mapa výskytu
    const info = path.join(root, "cs", "1_info");
    await fs.mkdir(info, { recursive: true });
    await writeFileAtomic(path.join(info, "text.txt"), serializeInfoText(seed.pole));
    await fs.writeFile(
      path.join(info, "foto-uvod.png"),
      await pngPlaceholder(seed.druh, seed.barva, "Amphibiárium · ZOO Ostrava"),
    );
    await fs.writeFile(
      path.join(info, "mapa.png"),
      await pngPlaceholder("Mapa výskytu", "#334155", seed.druh),
    );

    // 2_vid: prázdná galerie, fotky a videa nahraje kurátor
    await fs.mkdir(path.join(root, "cs", "2_vid"), { recursive: true });

    // 3_gal: textový slide, dva texty a jedna fotka. Taxonomii seed
    // nevyplňuje: třídu ani řád nemáme odkud vzít, doplní je kurátor.
    const gal = path.join(root, "cs", "3_gal");
    await fs.mkdir(gal, { recursive: true });
    await writeFileAtomic(
      path.join(gal, "text.txt"),
      serializeGalText({ ObecnyText: seed.zajimavost }, "cs"),
    );
    await fs.writeFile(
      path.join(gal, "foto-zajimavost.png"),
      await pngPlaceholder(seed.druh, seed.barva, "Textový slide"),
    );

    // 4_ai: prázdná složka
    await fs.mkdir(path.join(root, "cs", "4_ai"), { recursive: true });

    slidy.push(
      { slozka: "1_info", typ: "info" },
      { slozka: "2_vid", typ: "vid" },
      { slozka: "3_gal", typ: "gal" },
      { slozka: "4_ai", typ: "ai" },
    );
  }

  // Identifikace pro chatbota se seedne z týchž polí info panelu.
  const meta: Record<string, unknown> = {
    druh,
    stav,
    posledniZmena: new Date().toISOString(),
    slidy,
  };
  if (seed) {
    meta.name = seed.pole.Nazev;
    meta.latin_name = canonicalizeLatin(seed.pole.Latinsky ?? "");
    if (seed.pole.Sekce) meta.category = seed.pole.Sekce;
    meta.section = seed.celed;
  }
  await writeFileAtomic(path.join(root, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

async function main() {
  console.log(`Generuji ${DISPLAY_COUNT} displejů do ${DISPLAYS_DIR} ...`);
  await fs.mkdir(DISPLAYS_DIR, { recursive: true });
  for (let id = 1; id <= DISPLAY_COUNT; id++) {
    await seedDisplay(id, SEED_DISPLAYS[id] ?? null);
  }
  console.log("Hotovo. Displeje 1-3 mají obsah (1_info, 2_vid, 3_gal, 4_ai, kb.md), 4-37 jsou Nepřiřazeno.");

  // Účet, aby se dalo přihlásit hned po instalaci. Existující účty se nikdy
  // nepřepisují, opakovaný seed dat se uživatelů nedotkne.
  if (await zalozVychoziUcet()) {
    console.log("");
    console.log(`Založen výchozí účet:  ${VYCHOZI_JMENO} / ${VYCHOZI_HESLO}`);
    console.log("Po prvním přihlášení heslo změňte:");
    console.log(`  npm run useradd -- ${VYCHOZI_JMENO} <noveheslo> --zmenit-heslo`);
  } else {
    console.log("Účty v data/users.json ponechány beze změny.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
