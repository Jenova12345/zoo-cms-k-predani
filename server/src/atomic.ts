import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Atomický zápis souboru: obsah se nejdřív zapíše do dočasného souboru ve
// STEJNÉ složce a teprve hotový soubor se přejmenuje na cílový název.
//
// Proč: holé fs.writeFile otevírá soubor s flagem "w", takže ho nejdřív zkrátí
// na nulu a teprve pak plní. Kdo soubor čte v tom okamžiku. Danielův chatbot
// sleduje naše soubory file watcherem, Unity je čte přímo z disku, dostane
// prázdný nebo useknutý soubor a JSON.parse mu spadne. Rename je oproti tomu
// v rámci jednoho filesystému atomický: čtenář vidí buď celý starý, nebo celý
// nový obsah, nikdy půlku. Watcher navíc dostane jednu událost místo dvou
// (zkrácení + zápis).
//
// Dočasný soubor proto MUSÍ ležet ve stejné složce jako cíl: rename přes
// hranici filesystému (jiný disk, síťová složka) není atomický a Node ho
// odmítne chybou EXDEV.
//
// Název dočasného souboru:
//   .tmp-<cílový název>-<pid>-<náhoda>
// Tečkový prefix ".tmp-" je stejná konvence jako v renumberSlides
// (displays.ts), aby ho file watcher i naše vlastní listování složek
// přeskočily. PID a náhodný suffix zaručí, že si dva souběžné zápisy téhož
// souboru nešlápnou po stejném dočasném souboru.

export interface AtomicOptions {
  // Práva výsledného souboru (např. 0o600 u users.json). Bez uvedení platí
  // stejné výchozí chování jako u fs.writeFile.
  mode?: number;
}

function tmpPath(cesta: string): string {
  const unikat = `${process.pid}-${randomBytes(4).toString("hex")}`;
  return path.join(path.dirname(cesta), `.tmp-${path.basename(cesta)}-${unikat}`);
}

export async function writeFileAtomic(
  cesta: string,
  obsah: string | Buffer,
  options: AtomicOptions = {},
): Promise<void> {
  const tmp = tmpPath(cesta);
  try {
    // 0o666 je výchozí hodnota fs.writeFile; skutečná práva ještě ořeže umask.
    await fs.writeFile(tmp, obsah, { encoding: "utf8", mode: options.mode ?? 0o666 });
    await fs.rename(tmp, cesta);
  } catch (err) {
    // Zápis nebo rename selhal: dočasný soubor po sobě ukliď, ať se ve složce
    // displeje nehromadí. Cílový soubor drží pořád původní obsah, takže
    // chatbot ani Unity nic rozbitého nevidí.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (options.mode !== undefined) {
    try {
      await fs.chmod(cesta, options.mode);
    } catch {
      // na Windows nebo síťovém disku nemusí jít, není to kritické
    }
  }
}
