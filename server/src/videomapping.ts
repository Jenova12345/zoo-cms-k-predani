import { oscZprava, posliUdp } from "./osc.js";

// Zapínání a vypínání videomappingu v pavilonu z CMS.
//
// V pavilonu jsou dvě instalace od firmy, která je dodala. Každá poslouchá OSC
// přes UDP na svém počítači; stačí poslat jednu zprávu bez argumentů a zbytek
// si udělají sami:
//
//   WaterSense   10.10.10.51:7000
//   Les          10.10.10.52:7000
//
// CO CMS NEVÍ: UDP je jednosměrné a nikdo ho nepotvrzuje. Nedozvíme se, jestli
// zpráva dorazila, jestli ji někdo přečetl ani jestli se instalace opravdu
// rozeběhla. CMS proto NIKDY netvrdí „zapnuto“, jen „povel odeslán“ a kdy.
// Skutečný stav instalace vidí jen obsluha v pavilonu.

export type Povel = "start" | "stop";

// Adresy OSC zpráv. Bez argumentů, přesně jak je čeká firma od mappingu.
const OSC_ADRESA: Record<Povel, string> = {
  start: "/start",
  stop: "/stop",
};

export interface Instalace {
  id: string; // v URL endpointu
  nazev: string; // jak instalaci zná obsluha v pavilonu
  host: string;
  port: number;
}

// Adresy a porty NEJSOU natvrdo: firma je může změnit a kvůli tomu se nemá
// překládat aplikace. Berou se z prostředí, hodnoty níž jsou jen výchozí stav
// podle dodaného zapojení. Přehled v .env.example.
const VYCHOZI: { id: string; nazev: string; host: string; port: number; promenna: string }[] = [
  {
    id: "watersense",
    nazev: "WaterSense",
    host: "10.10.10.51",
    port: 7000,
    promenna: "VIDEOMAPPING_WATERSENSE",
  },
  {
    id: "les",
    nazev: "Les",
    host: "10.10.10.52",
    port: 7000,
    promenna: "VIDEOMAPPING_LES",
  },
];

// IPv4 adresa, nebo jméno stroje. Kontrolujeme jen hrubě: cílem je zachytit
// překlep v konfiguraci (prázdná hodnota, mezera, lomítko), ne validovat DNS.
function jePlatnyHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && /^[A-Za-z0-9._-]+$/.test(host);
}

function jePlatnyPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

type Log = { warn: (msg: string) => void; info: (msg: string) => void };

// Přečte `<PROMENNA>_HOST` a `<PROMENNA>_PORT`. Nesmyslná hodnota se nebere,
// spadne se na výchozí a do logu jde varování: tichá záměna adresy by
// znamenala, že kurátor mačká tlačítka a nic se neděje.
function zProstredi(
  def: (typeof VYCHOZI)[number],
  log: Log | null,
): Instalace {
  let host = def.host;
  const rawHost = process.env[`${def.promenna}_HOST`];
  if (rawHost !== undefined && rawHost.trim() !== "") {
    const orezany = rawHost.trim();
    if (jePlatnyHost(orezany)) host = orezany;
    else log?.warn(`[videomapping] ${def.promenna}_HOST='${rawHost}' není platná adresa, používám ${def.host}.`);
  }

  let port = def.port;
  const rawPort = process.env[`${def.promenna}_PORT`];
  if (rawPort !== undefined && rawPort.trim() !== "") {
    const cislo = Number(rawPort);
    if (jePlatnyPort(cislo)) port = cislo;
    else log?.warn(`[videomapping] ${def.promenna}_PORT='${rawPort}' není platný port, používám ${def.port}.`);
  }

  return { id: def.id, nazev: def.nazev, host, port };
}

// Konfigurace se čte jednou při startu, ne při každém požadavku: tlačítko má
// mačkat kurátor, ne přepisovat prostředí za běhu.
let instalace: Instalace[] = VYCHOZI.map((d) => zProstredi(d, null));

export function spustVideomapping(log: Log): void {
  instalace = VYCHOZI.map((d) => zProstredi(d, log));
  const prehled = instalace.map((i) => `${i.nazev} ${i.host}:${i.port}`).join(", ");
  log.info(`[videomapping] instalace: ${prehled}`);
}

export function seznamInstalaci(): Instalace[] {
  return instalace.map((i) => ({ ...i }));
}

export function najdiInstalaci(id: string): Instalace | null {
  return instalace.find((i) => i.id === id) ?? null;
}

export function jePovel(hodnota: unknown): hodnota is Povel {
  return hodnota === "start" || hodnota === "stop";
}

// Povel česky, do auditu i do hlášky v CMS.
export function popisPovelu(povel: Povel): string {
  return povel === "start" ? "zapnout" : "vypnout";
}

export interface VysledekOdeslani {
  ok: boolean;
  odeslano: string; // ISO čas pokusu (u úspěchu i u chyby)
  chyba?: string;
}

// Odešle povel jedné instalaci.
//
// Vrácené `ok: true` znamená POUZE to, že se datagram povedlo předat systému.
// Doručení ani reakci instalace UDP nepotvrzuje a CMS je nijak nezjišťuje.
export async function posliPovel(
  instalaceId: string,
  povel: Povel,
): Promise<VysledekOdeslani & { instalace: Instalace }> {
  const cil = najdiInstalaci(instalaceId);
  if (!cil) throw new Error(`Neznámá instalace: ${instalaceId}`);

  const odeslano = new Date().toISOString();
  try {
    await posliUdp(cil.host, cil.port, oscZprava(OSC_ADRESA[povel]));
    return { ok: true, odeslano, instalace: cil };
  } catch (err) {
    // Chyba je vždycky na naší straně (neplatná adresa, síť je dole, socket
    // nešel otevřít). Ven jde srozumitelná hláška, detail do logu volajícího.
    const duvod = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      odeslano,
      chyba: `Povel se nepodařilo odeslat na ${cil.host}:${cil.port}. ${duvod}`,
      instalace: cil,
    };
  }
}

// --- Poslední odeslané povely -----------------------------------------
//
// Drží se JEN V PAMĚTI a jen za běh tohoto procesu. Není to stav instalace
// (ten CMS nezná), je to záznam „co jsme odsud naposledy poslali“. Po
// restartu serveru je prázdný; úplná historie je v audit logu.

export interface PosledniPovel {
  povel: Povel;
  odeslano: string;
  uzivatel: string; // účet
  // Jméno vybrané po přihlášení, stejně jako v auditu: pod jedním sdíleným
  // účtem ZOO by samotný účet neřekl, kdo tlačítko zmáčkl. `null` jen
  // u záznamu zapsaného dřív, než se jméno začalo předávat.
  jmeno: string | null;
  ok: boolean;
}

const posledni = new Map<string, PosledniPovel>();

export function zapisPosledni(instalaceId: string, zaznam: PosledniPovel): void {
  posledni.set(instalaceId, zaznam);
}

export function ziskejPosledni(instalaceId: string): PosledniPovel | null {
  return posledni.get(instalaceId) ?? null;
}
