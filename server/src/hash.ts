import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { compare, hash } from "bcryptjs";

// Bcrypt mimo hlavní vlákno.
//
// PROČ: bcryptjs je čistý JavaScript a cost 12 znamená zhruba čtvrt sekundy
// počítání. Když se sejde víc přihlášení naráz, hlavní vlákno je celou tu dobu
// vytížené a NEODBAVUJE nic jiného, včetně veřejného GET /api/displays/:id,
// na kterém visí tablety u expozice. Naměřeno na 20 souběžných pokusech:
// odezva pro tablet z 12 ms na stovky ms až 1,4 s. To je výpadek expozice
// kvůli někomu, kdo si hraje s přihlašovacím formulářem.
//
// JAK: malý pool worker vláken. Hlavní vlákno jen posílá zprávy a čeká na
// odpověď, takže zůstává volné pro HTTP provoz. Počítá se dál bcryptjs, tedy
// stejný algoritmus i stejný formát hashů ($2b$...), existující účty
// v data/users.json se přihlásí beze změny a nic se nemusí přehashovávat.
//
// Proč ne nativní bcrypt / @node-rs/bcrypt: znamenalo by to binárku pro každou
// platformu zvlášť. CMS se nasazuje i na Windows a instaluje se mimo tenhle
// stroj; když by se node_modules zkopírovalo z jiného systému, přestane
// fungovat přihlášení. Worker s čistým JS je přenositelný všude, kde běží Node.

const WORKER_SOUBOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bcryptWorker.js");

// Jedno vlákno necháváme hlavnímu procesu. Víc než 4 nemá smysl, přihlášení
// není hromadná operace.
const POCET_VLAKEN = Math.max(1, Math.min(4, os.cpus().length - 1));

interface Ukol {
  zprava: Record<string, unknown>;
  hotovo: (v: string | boolean) => void;
  selhalo: (e: Error) => void;
}

interface Vlakno {
  worker: Worker;
  ukol: Ukol | null;
}

let vlakna: Vlakno[] | null = null;
// Nouzový vypínač: BCRYPT_HLAVNI_VLAKNO=1 vrátí chování do hlavního vlákna.
// Slouží k porovnávacímu měření a jako záchrana, kdyby worker vlákna dělala
// v cizím prostředí problém. Běžně se nenastavuje.
let poolNepouzitelny = process.env.BCRYPT_HLAVNI_VLAKNO === "1";
const fronta: Ukol[] = [];
let dalsiId = 0;
const cekajici = new Map<number, Ukol>();

function zaloz(): Vlakno | null {
  try {
    // unref: pool nesmí držet naživu CLI skripty (useradd, import), které po
    // své práci normálně skončí.
    const worker = new Worker(WORKER_SOUBOR);
    worker.unref();
    const v: Vlakno = { worker, ukol: null };

    worker.on("message", (odpoved: { id: number; vysledek?: string | boolean; chyba?: string }) => {
      const ukol = cekajici.get(odpoved.id);
      cekajici.delete(odpoved.id);
      v.ukol = null;
      if (ukol) {
        if (odpoved.chyba) ukol.selhalo(new Error(odpoved.chyba));
        else ukol.hotovo(odpoved.vysledek as string | boolean);
      }
      podejDalsi(v);
      uvolniKdyzNeniPrace();
    });

    // Spadlé vlákno nesmí nechat přihlášení viset: rozdělaný úkol se dopočítá
    // v hlavním vlákně (pomalejší, ale nikdo nezůstane venku).
    const spadlo = (duvod: Error) => {
      const ukol = v.ukol;
      v.ukol = null;
      vlakna = vlakna?.filter((x) => x !== v) ?? null;
      if (ukol) {
        cekajici.delete(ukol.zprava.id as number);
        vHlavnimVlakne(ukol).catch(() => ukol.selhalo(duvod));
      }
    };
    worker.on("error", spadlo);
    worker.on("exit", (kod) => {
      if (kod !== 0) spadlo(new Error(`bcrypt vlákno skončilo s kódem ${kod}`));
    });

    return v;
  } catch {
    return null;
  }
}

function pool(): Vlakno[] | null {
  if (poolNepouzitelny) return null;
  if (vlakna && vlakna.length > 0) return vlakna;
  const nova: Vlakno[] = [];
  for (let i = 0; i < POCET_VLAKEN; i++) {
    const v = zaloz();
    if (v) nova.push(v);
  }
  if (nova.length === 0) {
    // Prostředí bez worker vláken: radši počítat v hlavním vlákně než
    // nepustit nikoho dovnitř.
    poolNepouzitelny = true;
    return null;
  }
  vlakna = nova;
  return vlakna;
}

// Vlákno s navěšeným posluchačem zpráv drží proces naživu i po unref() při
// založení. Jakmile pool nemá co počítat, uvolníme ho znovu, jinak by CLI
// skripty (useradd, import obsahu) po dokončení práce nedoběhly a zůstaly
// viset. Server tím netrpí, ten drží naživu HTTP server.
function uvolniKdyzNeniPrace(): void {
  if (fronta.length > 0) return;
  if (vlakna?.some((v) => v.ukol)) return;
  for (const v of vlakna ?? []) v.worker.unref();
}

function podejDalsi(v: Vlakno): void {
  if (v.ukol) return;
  const ukol = fronta.shift();
  if (!ukol) return;
  v.ukol = ukol;
  cekajici.set(ukol.zprava.id as number, ukol);
  // Po dobu počítání musí vlákno proces držet, ať se výsledek stihne vrátit.
  v.worker.ref();
  v.worker.postMessage(ukol.zprava);
}

// Záloha, když pool není k dispozici (nebo vlákno spadlo uprostřed práce).
async function vHlavnimVlakne(ukol: Ukol): Promise<void> {
  const z = ukol.zprava as { op: string; heslo: string; hash?: string; cost?: number };
  try {
    const vysledek =
      z.op === "hash" ? await hash(z.heslo, z.cost ?? 12) : await compare(z.heslo, z.hash ?? "");
    ukol.hotovo(vysledek);
  } catch (err) {
    ukol.selhalo(err instanceof Error ? err : new Error(String(err)));
  }
}

function zadej(zprava: Record<string, unknown>): Promise<string | boolean> {
  return new Promise((hotovo, selhalo) => {
    const ukol: Ukol = { zprava: { ...zprava, id: ++dalsiId }, hotovo, selhalo };
    const p = pool();
    if (!p) {
      void vHlavnimVlakne(ukol);
      return;
    }
    fronta.push(ukol);
    const volne = p.find((v) => !v.ukol);
    if (volne) podejDalsi(volne);
  });
}

// Hash hesla (zakládání účtu, změna hesla).
export async function hashHesla(heslo: string, cost: number): Promise<string> {
  return (await zadej({ op: "hash", heslo, cost })) as string;
}

// Ověření hesla proti uloženému hashi (přihlášení).
export async function overHash(heslo: string, hashHodnota: string): Promise<boolean> {
  return (await zadej({ op: "over", heslo, hash: hashHodnota })) as boolean;
}
