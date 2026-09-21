import { promises as fs } from "node:fs";
import path from "node:path";
import { DISPLAYS_DIR } from "./paths.js";
import { parseInfoText } from "./displays.js";
import { canonicalizeLatin } from "./latin.js";
import { writeFileAtomic } from "./atomic.js";

// Jednorázově doplní identifikaci pro chatbota (name, latin_name, category) do
// existujících meta.json z polí info panelu (cs/*_info/text.txt). Bezpečné a
// idempotentní: mění jen meta.json, sahá jen na chybějící/rozdílné hodnoty,
// médií ani textů se nedotýká. section (čeleď) nezná, tu doplní kurátor v UI.

async function findInfoText(csDir: string): Promise<Record<string, string> | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(csDir);
  } catch {
    return null;
  }
  const infoDir = entries.find((e) => /^\d+_info$/.test(e));
  if (!infoDir) return null;
  try {
    const raw = await fs.readFile(path.join(csDir, infoDir, "text.txt"), "utf8");
    return parseInfoText(raw);
  } catch {
    return null;
  }
}

async function backfillDisplay(id: string): Promise<void> {
  const root = path.join(DISPLAYS_DIR, id);
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await fs.readFile(path.join(root, "meta.json"), "utf8"));
  } catch {
    return;
  }
  const pole = await findInfoText(path.join(root, "cs"));
  if (!pole) {
    console.log(`Displej ${id}: bez info panelu, přeskočeno.`);
    return;
  }

  const nazev = (pole.Nazev ?? "").trim();
  const latin = canonicalizeLatin(pole.Latinsky ?? "");
  const kategorie = (pole.Sekce ?? "").trim();

  const zmeny: string[] = [];
  if (nazev && meta.name !== nazev) {
    meta.name = nazev;
    zmeny.push("name");
  }
  if (nazev && meta.druh !== nazev) {
    meta.druh = nazev;
    zmeny.push("druh");
  }
  if (latin && meta.latin_name !== latin) {
    meta.latin_name = latin;
    zmeny.push("latin_name");
  }
  if (kategorie && meta.category !== kategorie) {
    meta.category = kategorie;
    zmeny.push("category");
  }

  if (zmeny.length === 0) {
    console.log(`Displej ${id}: identifikace už kompletní, beze změny.`);
    return;
  }
  await writeFileAtomic(path.join(root, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`Displej ${id}: doplněno ${zmeny.join(", ")} (latin_name=${meta.latin_name ?? "-"}).`);
}

async function main() {
  console.log(`Doplňuji identifikaci pro chatbota do meta.json v ${DISPLAYS_DIR} ...`);
  let ids: string[];
  try {
    ids = await fs.readdir(DISPLAYS_DIR);
  } catch {
    console.error("Datová složka nenalezena.");
    process.exit(1);
  }
  for (const id of ids.filter((x) => /^\d+$/.test(x)).sort((a, b) => Number(a) - Number(b))) {
    await backfillDisplay(id);
  }
  console.log("Backfill hotový. section (čeleď) doplňte v editoru u konkrétních druhů.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
