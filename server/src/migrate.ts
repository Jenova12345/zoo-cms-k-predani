import { promises as fs } from "node:fs";
import path from "node:path";
import { DISPLAYS_DIR } from "./paths.js";
import { SEED_DISPLAYS, DEFAULT_KB } from "./content.js";
import { serializeInfoText, convertToPng, NEPRIRAZENO, type SlideTyp } from "./displays.js";
import { writeFileAtomic } from "./atomic.js";

// Jednorázová migrace staré struktury (cs/slide-1..6, text.md, kb.md ve
// slide-6) na nový formát pro Unity (cs/<n>_<typ>, text.txt, kb.md v kořeni).
//
// Zachovává nahraná média: fotky ze slide-1 jdou do 1_info, zbylé fotky
// a videa do galerie 2_vid, kde tvoří jednu číslovanou řadu (01.png, 02.mp4…).
// Texty starých slidů se přesunou do znalostní báze kb.md, ať se o obsah
// nepřijde. 3_gal vzniká prázdný, texty do něj dopíše kurátor.
//
// Migrace je idempotentní: displej, který už nemá žádnou složku slide-*,
// se přeskočí.
//
// POZOR: data v pavilonu jsou dávno migrovaná, tohle je jen historická
// pojistka pro případ, že by se někde našla složka ve starém tvaru. Cíl
// odpovídá struktuře, kterou dnes čte Unity: `_gal` je TEXTOVÝ slide
// (dva texty + taxonomie + jedna fotka), `_vid` je GALERIE fotek i videí.

const IMAGE_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff"]);

interface OldSlide {
  n: number;
  dir: string;
  nadpis: string;
  text: string;
  kb: string | null;
  images: string[]; // absolutní cesty
  videos: string[]; // absolutní cesty
}

function parseSlideMarkdown(raw: string): { nadpis: string; text: string } {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.startsWith("# ")) {
    return { nadpis: lines[0].slice(2).trim(), text: lines.slice(1).join("\n").trim() };
  }
  return { nadpis: "", text: raw.trim() };
}

async function readOldSlides(csDir: string): Promise<OldSlide[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(csDir);
  } catch {
    return [];
  }
  const out: OldSlide[] = [];
  for (const name of entries) {
    const m = /^slide-(\d+)$/.exec(name);
    if (!m) continue;
    const dir = path.join(csDir, name);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const files = await fs.readdir(dir);
    let nadpis = "";
    let text = "";
    let kb: string | null = null;
    if (files.includes("kb.md")) {
      kb = await fs.readFile(path.join(dir, "kb.md"), "utf8");
    }
    if (files.includes("text.md")) {
      const parsed = parseSlideMarkdown(await fs.readFile(path.join(dir, "text.md"), "utf8"));
      nadpis = parsed.nadpis;
      text = parsed.text;
    }
    out.push({
      n: Number(m[1]),
      dir,
      nadpis,
      text,
      kb,
      images: files.filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort().map((f) => path.join(dir, f)),
      videos: files.filter((f) => path.extname(f).toLowerCase() === ".mp4").sort().map((f) => path.join(dir, f)),
    });
  }
  return out.sort((a, b) => a.n - b.n);
}

async function copyImagesAsPng(sources: string[], targetDir: string, prefix: string): Promise<number> {
  let ok = 0;
  for (const src of sources) {
    try {
      const png = await convertToPng(await fs.readFile(src));
      ok += 1;
      await fs.writeFile(path.join(targetDir, `${prefix}-${String(ok).padStart(2, "0")}.png`), png);
    } catch {
      console.warn(`  ! nepodařilo se převést do PNG, přeskočeno: ${src}`);
    }
  }
  return ok;
}

async function migrateDisplay(id: string): Promise<void> {
  const root = path.join(DISPLAYS_DIR, id);
  const csDir = path.join(root, "cs");
  const oldSlides = await readOldSlides(csDir);
  if (oldSlides.length === 0) {
    console.log(`Displej ${id}: už v novém formátu, přeskočeno.`);
    return;
  }

  let meta: { druh?: string; stav?: string } = {};
  try {
    meta = JSON.parse(await fs.readFile(path.join(root, "meta.json"), "utf8"));
  } catch {
    // meta dopíšeme níž
  }
  const druh = meta.druh ?? NEPRIRAZENO;
  const prirazeno = druh !== NEPRIRAZENO;

  // 1) kb.md do kořene: stará znalostní báze + texty obsahových slidů.
  let kb = oldSlides.find((s) => s.kb)?.kb ?? (prirazeno ? `# Znalostní báze: ${druh}\n` : DEFAULT_KB);
  const textove = oldSlides.filter((s) => !s.kb && (s.nadpis || s.text));
  if (textove.length) {
    kb = kb.replace(/\n+$/, "\n");
    kb += "\n## Texty z původních slidů\n";
    for (const s of textove) {
      kb += `\n### ${s.nadpis || `Slide ${s.n}`}\n${s.text}\n`;
    }
  }
  await writeFileAtomic(path.join(root, "kb.md"), kb.endsWith("\n") ? kb : kb + "\n");

  const slidy: { slozka: string; typ: SlideTyp }[] = [];
  if (prirazeno) {
    // 2) 1_info: pole (ze seedu, pokud druh známe, jinak aspoň Nazev) + fotky slide-1.
    const seed = Object.values(SEED_DISPLAYS).find((s) => s.druh === druh);
    const pole = seed ? seed.pole : { Nazev: druh };
    const info = path.join(csDir, "1_info");
    await fs.mkdir(info, { recursive: true });
    await writeFileAtomic(path.join(info, "text.txt"), serializeInfoText(pole));
    await copyImagesAsPng(oldSlides[0]?.images ?? [], info, "foto");

    // 3) 2_vid: galerie. Zbylé fotky a všechna videa v jedné číslované řadě
    // s vodící nulou, tak jak je čte Unity (řadí je abecedně).
    const vid = path.join(csDir, "2_vid");
    await fs.mkdir(vid, { recursive: true });
    let poradi = 0;
    const cislo = () => String(++poradi).padStart(2, "0");
    for (const src of oldSlides.slice(1).flatMap((s) => s.images)) {
      try {
        const png = await convertToPng(await fs.readFile(src));
        await fs.writeFile(path.join(vid, `${cislo()}.png`), png);
      } catch {
        console.warn(`  ! nepodařilo se převést do PNG, přeskočeno: ${src}`);
      }
    }
    for (const mp4 of oldSlides.flatMap((s) => s.videos)) {
      await fs.copyFile(mp4, path.join(vid, `${cislo()}.mp4`));
    }

    // 4) 3_gal: textový slide. Média sem nepatří (jedna fotka, kterou si
    // kurátor vybere) a texty jsou ve znalostní bázi, takže zakládáme
    // prázdnou složku.
    const gal = path.join(csDir, "3_gal");
    await fs.mkdir(gal, { recursive: true });

    // 5) 4_ai: prázdná složka.
    await fs.mkdir(path.join(csDir, "4_ai"), { recursive: true });

    slidy.push(
      { slozka: "1_info", typ: "info" },
      { slozka: "2_vid", typ: "vid" },
      { slozka: "3_gal", typ: "gal" },
      { slozka: "4_ai", typ: "ai" },
    );
  }

  // 6) Staré slide-* složky pryč.
  for (const s of oldSlides) {
    await fs.rm(s.dir, { recursive: true, force: true });
  }

  const newMeta = {
    druh,
    stav: meta.stav === "offline" ? "offline" : "online",
    posledniZmena: new Date().toISOString(),
    slidy,
  };
  await writeFileAtomic(path.join(root, "meta.json"), JSON.stringify(newMeta, null, 2) + "\n");
  console.log(`Displej ${id}: zmigrováno (${druh}${prirazeno ? `, slidů: ${slidy.length}` : ", bez slidů"}).`);
}

async function main() {
  console.log(`Migruji displeje v ${DISPLAYS_DIR} na formát pro Unity ...`);
  let ids: string[];
  try {
    ids = await fs.readdir(DISPLAYS_DIR);
  } catch {
    console.error("Datová složka nenalezena.");
    process.exit(1);
  }
  for (const id of ids.filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b))) {
    await migrateDisplay(id);
  }
  console.log("Migrace hotová.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
