import { promises as fs } from "node:fs";
import path from "node:path";
import { DISPLAYS_DIR } from "./paths.js";
import { SEKCE, rozdelKb, slozKb } from "../../web/src/lib/kbSekce.js";

// Ukáže, co strukturovaný editor udělá s konkrétním kb.md: co se objeví
// v polích, co nahlásí kurátorovi a co se uloží zpátky. Nic nezapisuje.
//   npm run kb-ukazka -- 1

const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "1";
const raw = (await fs.readFile(path.join(DISPLAYS_DIR, id, "kb.md"), "utf8")).replace(/\n+$/, "");
const r = rozdelKb(raw);

console.log(`CO KURÁTOR UVIDÍ V POLÍCH (displej ${id})\n${"=".repeat(62)}`);
console.log(`\n[ Úvod (nad sekcemi) ]\n${r.preambule || "(prázdné)"}`);
for (const s of SEKCE) {
  const t = (r.pole[s.klic] ?? "").trim();
  const radky = t.split("\n");
  const nahled = t ? radky.slice(0, 4).join("\n") + (radky.length > 4 ? `\n  … (+${radky.length - 4} řádků)` : "") : "(prázdné)";
  console.log(`\n[ ${s.nadpis} ]\n${nahled}`);
}
console.log(`\n\nHLÁŠKY NAD FORMULÁŘEM\n${"=".repeat(62)}`);
for (const p of r.poznamky) console.log("• " + p);

const zpet = slozKb(r);
console.log(`\n\nCO SE ULOŽÍ DO kb.md (prvních 12 řádků z ${zpet.split("\n").length})\n${"=".repeat(62)}`);
console.log(zpet.split("\n").slice(0, 12).join("\n"));
