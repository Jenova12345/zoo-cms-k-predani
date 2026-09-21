import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";

import { DATA_ROOT, DISPLAYS_DIR, POSLEDNI_DISPLEJ, WEB_DIST } from "./paths.js";
import { appendAudit, readAudit } from "./audit.js";
import {
  jazykNeboVychozi,
  listDisplays,
  oznacRevizi,
  stavJazyku,
  ctiOriginalFotky,
  uklidDocasneSoubory,
  ulozVyrez,
  spustOrezSekvence,
  stavOrezuSekvence,
  readMeta,
  readSlides,
  readKb,
  writeKb,
  writeInfoPole,
  writeGalPole,
  writeTextSlide,
  saveImage,
  deleteMedia,
  setMapa,
  saveVideo,
  deleteVideo,
  addSlide,
  removeSlide,
  reorderSlides,
  displayExists,
  slideExists,
  SLIDE_TYPY_NABIDKA,
  NEPRIRAZENO,
  type SlideTyp,
} from "./displays.js";
import type { Vyrez } from "./vyrez.js";
import { KB_TEMPLATE } from "./kbTemplate.js";
import { LIMIT_MAX, ziskejQuestions, ziskejSummary } from "./analytics.js";
import { prehled as prehledUdalosti } from "./udalosti.js";
import { analytika, dnes, pocetDnu } from "./analytika.js";
import {
  popisZmen,
  sestavPayload,
  spustPrales,
  ulozNastaveni,
  validujNastaveni,
  ziskejNastaveni,
} from "./prales.js";
import { LAT, LON, ZASTARALE_PO_MS, spustPocasi, stavPocasi } from "./pocasi.js";
import { najdiDiru, stavDiry, stavVsech, ulozVideo } from "./diry.js";
import {
  jePovel,
  najdiInstalaci,
  popisPovelu,
  posliPovel,
  seznamInstalaci,
  spustVideomapping,
  zapisPosledni,
  ziskejPosledni,
} from "./videomapping.js";
import {
  type SessionData,
  COOKIE_MAX_AGE_S,
  NECINNOST_MS,
  SESSION_COOKIE,
  TEP_THROTTLE_MS,
  nactiNeboZalozKlic,
  neaktivni,
  prectiSession,
  vytvorSession,
} from "./session.js";
import { najdiUzivatele, overUdaje, pocetUzivatelu } from "./users.js";
import { najdiJmeno, pridejJmeno, seznamJmen, smazJmeno, validujJmeno } from "./jmena.js";
import { zaznamenejTep } from "./tep.js";

// Účet a vybrané jméno zjištěné v onRequest hooku (viz níž). Chráněné
// handlery si je berou přes zapisAudit() do auditu, ať se users.json nečte
// podruhé. `jmenoCloveka` je jméno vybrané po přihlášení — ZOO jede pod
// jedním sdíleným účtem, takže bez něj by audit neřekl, kdo co dělal.
declare module "fastify" {
  interface FastifyRequest {
    uzivatel: string | null;
    jmenoCloveka: string | null;
  }
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: "info" } });
app.decorateRequest("uzivatel", null);
app.decorateRequest("jmenoCloveka", null);

// Chybové odpovědi ven jen jako obecná hláška (žádné interní kódy, cesty ani
// stack), detail jde do server logu. Vlastní aplikační chyby, které nesou
// pole `chyba` (např. 429 z rate limitu), se pošlou tak, jak jsou.
app.setErrorHandler((err, req, reply) => {
  const e = err as { statusCode?: number; chyba?: unknown };
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : 500;
  if (statusCode >= 500) req.log.error(err);
  else req.log.info({ err }, "klientská chyba");
  if (typeof e.chyba === "string") {
    return reply.code(statusCode).send({ chyba: e.chyba });
  }
  return reply.code(statusCode).send({
    chyba: statusCode < 500 ? "Neplatný požadavek." : "Chyba serveru, zkuste to prosím znovu.",
  });
});

// Klíč pro podpis session cookie (SESSION_SECRET, jinak data/session.key).
await app.register(fastifyCookie, { secret: await nactiNeboZalozKlic(app.log) });
await app.register(fastifyMultipart, {
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB, aby prošlo i mp4 video na slide
});
// Rate limit se NEaplikuje globálně (tablety pollují veřejné čtení), jen na
// konkrétní routy, které si o něj řeknou přes config.rateLimit, viz /api/login.
await app.register(fastifyRateLimit, { global: false });

// Prázdné tělo u application/json Fastify ve výchozím stavu odmítá čtyřstovkou.
// U tepu z tabletu je přitom prázdné tělo nejpravděpodobnější podoba požadavku
// (Unity pošle hlavičku a nic víc) a přišli bychom kvůli tomu o informaci, že
// tablet žije — displej by se tvářil jako vypnutý, i když běží. Parser proto
// bere prázdné tělo jako {}. Pro ostatní endpointy se tím nic nemění: žádný
// z nich prázdné tělo neposílá a chybějící pole si stejně ohlídají samy.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, telo, hotovo) => {
  const text = typeof telo === "string" ? telo.trim() : "";
  if (!text) return hotovo(null, {});
  try {
    hotovo(null, JSON.parse(text));
  } catch {
    const chyba = new Error("Tělo požadavku není platný JSON.") as Error & { statusCode?: number };
    chyba.statusCode = 400;
    hotovo(chyba, undefined);
  }
});

// Servírování reálných souborů slidů (fotky, videa) pro CMS i tablet.
// Root je záměrně jen DISPLAYS_DIR, ne celý DATA_ROOT: users.json,
// session.key ani audit.jsonl se přes HTTP stáhnout nedají. Adresy souborů
// (/data/displeje/...) zůstávají stejné jako dřív.
await app.register(fastifyStatic, {
  root: DISPLAYS_DIR,
  prefix: "/data/displeje/",
  decorateReply: false,
});

// --- Session ---

// Stav session z požadavku. Kromě podpisu a expirace se ověřuje i proti
// users.json: účet musí pořád existovat a jeho serial (zmeneno/vytvoreno)
// sedět se serialem v session. Tím se smazání účtu i změna hesla propíšou do
// zneplatnění dosud vydaných cookies.
//
// „necinnost" je schválně vlastní stav, ne prosté „chybi": při něm se cookie
// maže a do auditu jde záznam, ať je v logu vidět, proč člověk zmizel.
type VysledekSession =
  | { stav: "chybi" }
  | { stav: "necinnost"; ucet: string; jmeno: string | null }
  | { stav: "ok"; ucet: string; jmeno: string | null; serial: string; data: SessionData };

async function overSession(req: FastifyRequest): Promise<VysledekSession> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return { stav: "chybi" };
  const odpodepsano = req.unsignCookie(raw);
  if (!odpodepsano.valid || !odpodepsano.value) return { stav: "chybi" };
  const data = prectiSession(odpodepsano.value);
  if (!data) return { stav: "chybi" };
  const user = await najdiUzivatele(data.u);
  if (!user) return { stav: "chybi" }; // účet mezitím smazán
  const serial = user.zmeneno ?? user.vytvoreno;
  if (data.v !== serial) return { stav: "chybi" }; // heslo změněno
  if (neaktivni(data)) {
    return { stav: "necinnost", ucet: user.jmeno, jmeno: data.j ?? null };
  }
  return { stav: "ok", ucet: user.jmeno, jmeno: data.j ?? null, serial, data };
}

// Zpětně kompatibilní zkratka pro místa, která chtějí jen účet.
async function prihlasenyUzivatel(req: FastifyRequest): Promise<string | null> {
  const ses = await overSession(req);
  return ses.stav === "ok" ? ses.ucet : null;
}

// Účet do auditu. Na chráněných cestách je vždy vyplněný, protože hook níž ho
// po ověření uloží na request; fallback je pojistka pro veřejné cesty.
function currentUser(req: FastifyRequest): string {
  return req.uzivatel ?? "neznámý";
}

// Zápis do auditu z handleru. Účet i jméno si bere z requestu sám — schválně,
// aby se na jméno nedalo zapomenout. Kdyby si každé volání skládalo záznam
// ručně (a bylo jich tu přes dvacet), stačí jedno opomenutí a v logu je
// akce bez člověka, který ji udělal.
async function zapisAudit(req: FastifyRequest, akce: string, cil: string): Promise<void> {
  await appendAudit({
    uzivatel: currentUser(req),
    ...(req.jmenoCloveka ? { jmeno: req.jmenoCloveka } : {}),
    akce,
    cil,
  });
}

// maxAge se řídí oknem NEČINNOSTI (plus krátká rezerva, viz COOKIE_MAX_AGE_S),
// ne absolutním stropem: cookie se obnovuje s každým tepem od člověka, takže
// když někdo zaklapne notebook na hodinu, zmizí i z prohlížeče, ne jen ze
// serveru. Absolutní strop (12 h) drží `exp` uvnitř podepsaného obsahu —
// prakticky rozhoduje tvrdší z obou.
const COOKIE_NASTAVENI = {
  path: "/",
  httpOnly: true, // JavaScript v prohlížeči se k session nedostane
  sameSite: "lax" as const,
  signed: true,
  maxAge: COOKIE_MAX_AGE_S,
};

// Veřejné API: přihlašovací tok a čtení obsahu displeje pro náhled tabletu
// (ten u expozice běží bez přihlášení). Všechno ostatní pod /api vyžaduje
// platnou session, zamykáme ve výchozím stavu, takže nový endpoint je
// chráněný automaticky, dokud ho někdo vědomě nepřidá sem.
const VEREJNE_API = new Set([
  "POST /api/login",
  "POST /api/logout",
  "GET /api/me",
  "GET /api/displays/:id", // data pro /tablet/:id
  "GET /api/prales", // data pro displej u deštného pralesa (Unity, každých 5 s)
  "POST /api/displays/:id/heartbeat", // tep tabletu (Unity, každou minutu)
]);

// Cesty, na které stačí přihlášení BEZ vybraného jména. Je to přesně to, co
// potřebuje obrazovka výběru jména: zjistit, kdo jsem, přečíst a doplnit
// seznam a jméno si vybrat. Seznam se smí editovat i tady schválně — kdo
// přišel poprvé, musí si své jméno umět přidat dřív, než se do CMS dostane.
// (GET /api/me a POST /api/logout tu nejsou: ty řeší už VEREJNE_API výš.)
const BEZ_JMENA = new Set([
  "GET /api/jmena",
  "POST /api/jmena",
  "DELETE /api/jmena/:jmeno",
  "POST /api/session/jmeno",
  "POST /api/session/tep",
]);

// Míří požadavek do /api namespace? Rozhodujeme podle SKUTEČNĚ napárované
// routy (router už cestu dekódoval a normalizoval), ne podle syrového
// req.url. Jinak by šlo autorizaci obejít procentním kódováním písmen
// (`/%61pi/...` = `/api/...`), zdvojeným lomítkem nebo velkými písmeny, protože
// router takovou cestu na chráněný handler napáruje, ale `req.url.startsWith`
// ji nepozná. Nenapárovanou cestu (404 pod /api) posuzujeme z dekódovaného
// tvaru, ať skončí v 401, ne v SPA fallbacku.
function miriNaApi(req: FastifyRequest): boolean {
  if ((req.routeOptions?.url ?? "").startsWith("/api")) return true;
  let cesta = req.url.split("?")[0].split("#")[0];
  for (let i = 0; i < 3; i++) {
    let dekod: string;
    try {
      dekod = decodeURIComponent(cesta);
    } catch {
      break; // nerozkódovatelná cesta: posuď ji v tom tvaru, jaký máme
    }
    if (dekod === cesta) break;
    cesta = dekod;
  }
  cesta = cesta.replace(/\/{2,}/g, "/").toLowerCase();
  return cesta.startsWith("/api");
}

app.addHook("onRequest", async (req, reply) => {
  if (!miriNaApi(req)) return; // statické soubory a SPA
  // HEAD se routuje na stejný handler jako GET.
  const metoda = req.method === "HEAD" ? "GET" : req.method;
  const cesta = req.routeOptions?.url ?? "";
  if (VEREJNE_API.has(`${metoda} ${cesta}`)) return;

  const ses = await overSession(req);

  if (ses.stav === "necinnost") {
    // Cookie se maže hned, takže se tenhle záznam zapíše jednou, ne při
    // každém dalším requestu z té samé záložky.
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    await appendAudit({
      uzivatel: ses.ucet,
      ...(ses.jmeno ? { jmeno: ses.jmeno } : {}),
      akce: "odhlášení pro nečinnost",
      cil: `systém, ${NECINNOST_MS / 60000} min bez aktivity`,
    });
    return reply
      .code(401)
      .send({ chyba: "Odhlášeno po hodině nečinnosti.", kod: "necinnost" });
  }

  if (ses.stav !== "ok") return reply.code(401).send({ chyba: "Přihlaste se prosím." });

  req.uzivatel = ses.ucet; // pro audit v chráněných handlerech
  req.jmenoCloveka = ses.jmeno;

  // Přihlášený, ale jméno si ještě nevybral. Schválně 403, ne 401: 401 klient
  // chápe jako „session je pryč" a vyhodí uživatele na přihlášení, my ho ale
  // chceme poslat jen o krok zpátky, na výběr jména.
  if (!ses.jmeno && !BEZ_JMENA.has(`${metoda} ${cesta}`)) {
    return reply.code(403).send({ chyba: "Nejdřív vyberte jméno.", kod: "jmeno" });
  }
});

function validId(id: string): boolean {
  return /^\d+$/.test(id);
}

// Slide se adresuje číselným prefixem složky (<n>_<typ>). Po přečíslování se
// čísla mění, klient si po každé strukturální změně načte detail znovu.
function validSlide(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

// --- Auth ---
// Ověřuje se proti bcrypt hashům v data/users.json (účty zakládá
// `npm run useradd`). Heslo se záměrně neořezává, mezera na kraji je jeho
// součástí, stejně jako při zakládání účtu.
app.post<{ Body: { username?: string; password?: string } }>(
  "/api/login",
  {
    // Tělo se validuje schématem, ale `attachValidation` nechá běžet handler i
    // při chybě (místo automatického 400), tak se i nevalidní pokus (číslo
    // místo řetězce apod.) zapíše do auditu a vrátí 400, ne 500.
    attachValidation: true,
    schema: {
      body: {
        type: "object",
        required: ["username", "password"],
        properties: {
          username: { type: "string" },
          password: { type: "string" },
        },
      },
    },
    // Brzda proti hádání hesel i proti DoS (bcrypt blokuje event loop): 5 pokusů
    // za 15 minut na kombinaci IP + přihlašovací jméno. `hook: preHandler`, ať
    // je při počítání klíče už rozparsované tělo requestu. 429 vrací stejný tvar
    // { chyba } jako ostatní chyby, takže ho klient zobrazí jako běžnou hlášku.
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "15 minutes",
        hook: "preHandler",
        keyGenerator: (req: FastifyRequest) => {
          const telo = req.body as { username?: unknown } | undefined;
          const jmeno = typeof telo?.username === "string" ? telo.username.trim().toLowerCase() : "";
          return `${req.ip}:${jmeno}`;
        },
        errorResponseBuilder: (_req, ctx) => ({
          // Plugin tenhle objekt vyhodí; statusCode z kontextu (429) drží
          // správný HTTP kód, `chyba` čte klient stejně jako u jiných chyb.
          statusCode: ctx.statusCode,
          chyba: "Příliš mnoho pokusů o přihlášení, zkuste to za pár minut.",
        }),
      },
    },
  },
  async (req, reply) => {
    if (req.validationError) {
      await appendAudit({
        uzivatel: "(neplatný požadavek)",
        akce: "neúspěšné přihlášení",
        cil: `systém, IP ${req.ip}`,
      });
      return reply.code(400).send({ ok: false, chyba: "Vyplňte jméno i heslo." });
    }
    const username = (req.body?.username ?? "").trim();
  const password = req.body?.password ?? "";
  if (!username || !password) {
    return reply.code(400).send({ ok: false, chyba: "Vyplňte jméno i heslo." });
  }

  const user = await overUdaje(username, password);
  if (!user) {
    // Jedna společná hláška: z odpovědi nejde poznat, jestli neexistuje jméno,
    // nebo nesedělo heslo. Do auditu NEzapisujeme zadaný řetězec doslova,
    // kurátor si mohl splést pole a napsat do "jména" heslo. Pro existující
    // účet logujeme jeho jméno, jinak neutrální značku.
    const existujici = await najdiUzivatele(username);
    await appendAudit({
      uzivatel: existujici ? existujici.jmeno : "(neznámé jméno)",
      akce: "neúspěšné přihlášení",
      cil: `systém, IP ${req.ip}`,
    });
    return reply.code(401).send({ ok: false, chyba: "Neplatné přihlašovací údaje." });
  }

  reply.setCookie(SESSION_COOKIE, vytvorSession(user.jmeno, user.zmeneno ?? user.vytvoreno), COOKIE_NASTAVENI);
  await appendAudit({ uzivatel: user.jmeno, akce: "přihlášení", cil: `systém, IP ${req.ip}` });
  return { ok: true, username: user.jmeno };
});

app.post("/api/logout", async (req, reply) => {
  const ses = await overSession(req);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  if (ses.stav === "ok") {
    await appendAudit({
      uzivatel: ses.ucet,
      ...(ses.jmeno ? { jmeno: ses.jmeno } : {}),
      akce: "odhlášení",
      cil: "systém",
    });
  }
  return { ok: true };
});

// Kdo jsem. `jmeno: null` u přihlášeného účtu znamená „ještě si nevybral" —
// web podle toho vykreslí výběr jména místo obsahu CMS.
app.get("/api/me", async (req) => {
  const ses = await overSession(req);
  if (ses.stav !== "ok") return { username: null, jmeno: null };
  return { username: ses.ucet, jmeno: ses.jmeno };
});

// --- Jména lidí u sdíleného účtu ---
// Seznam smí číst i měnit kdokoli přihlášený: ZOO jede pod jedním účtem,
// zvláštní admin tu není. Editace je dostupná i před výběrem jména, jinak by
// se nově příchozí nedostal dovnitř (jeho jméno v seznamu ještě není).

app.get("/api/jmena", async () => {
  return { jmena: await seznamJmen() };
});

app.post<{ Body: { jmeno?: string } }>("/api/jmena", async (req, reply) => {
  const jmeno = (req.body?.jmeno ?? "").trim();
  const chyba = validujJmeno(jmeno);
  if (chyba) return reply.code(400).send({ chyba });

  const res = await pridejJmeno(jmeno, currentUser(req));
  if (!res.ok) return reply.code(409).send({ chyba: res.chyba });

  await zapisAudit(req, "přidáno jméno do seznamu", jmeno);
  return { ok: true, jmena: await seznamJmen() };
});

app.delete<{ Params: { jmeno: string } }>("/api/jmena/:jmeno", async (req, reply) => {
  const jmeno = req.params.jmeno;
  const res = await smazJmeno(jmeno);
  if (!res.ok) return reply.code(404).send({ chyba: res.chyba });

  // Historie se nepřepisuje (audit je append-only) a nikoho to nevyhazuje
  // ven; kdo pod tím jménem pracuje, dopracuje.
  await zapisAudit(req, "smazáno jméno ze seznamu", jmeno.trim());
  return { ok: true, jmena: await seznamJmen() };
});

// Výběr jména po přihlášení. Cookie se vydá znovu, nově s `j`.
app.post<{ Body: { jmeno?: string } }>("/api/session/jmeno", async (req, reply) => {
  const ses = await overSession(req);
  if (ses.stav !== "ok") return reply.code(401).send({ chyba: "Přihlaste se prosím." });

  // Jméno musí být v seznamu — jinak by si kdokoli poslal libovolný řetězec
  // a audit by se rozešel se seznamem lidí. Bereme podobu ze seznamu, ne tu
  // poslanou, ať je v logu „Franta" i když klient pošle „franta".
  const zeSeznamu = await najdiJmeno((req.body?.jmeno ?? "").trim());
  if (!zeSeznamu) return reply.code(400).send({ chyba: "Vyberte jméno ze seznamu." });

  // `exp` se přenáší beze změny: výběrem jména se absolutní strop session
  // neprodlužuje, obnovuje se jen okno nečinnosti.
  reply.setCookie(
    SESSION_COOKIE,
    vytvorSession(ses.ucet, ses.serial, { jmeno: zeSeznamu, exp: ses.data.exp }),
    COOKIE_NASTAVENI,
  );
  await appendAudit({
    uzivatel: ses.ucet,
    jmeno: zeSeznamu,
    akce: "výběr jména",
    cil: `systém, IP ${req.ip}`,
  });
  return { ok: true, jmeno: zeSeznamu };
});

// Tep od člověka u klávesnice. JEDINÉ místo, které posouvá okno nečinnosti —
// ostatní requesty ho už jen kontrolují. Kdyby ho posouval každý request,
// vlastní pollery CMS (deštný prales každých 5 s, dashboard každou minutu) by
// otevřenou záložku držely přihlášenou donekonečna a audit by psal jméno
// člověka, který dávno odešel.
app.post<{ Body: { aktivita?: boolean } }>("/api/session/tep", async (req, reply) => {
  const ses = await overSession(req);
  if (ses.stav !== "ok") return reply.code(401).send({ chyba: "Přihlaste se prosím." });

  // `aktivita: true` = od minula byl klik nebo klávesa. Bez toho endpoint jen
  // ODPOVÍ, kolik zbývá, a okno NEPOSOUVÁ — web se sem ptá i při nečinnosti,
  // aby stihl varovat, a kdyby už to okno prodlužovalo, byli bychom zpátky
  // u „otevřená záložka = věčná session".
  const aktivita = req.body?.aktivita === true;

  const ted = Date.now();
  // Cookie se přepodepisuje nejvýš jednou za minutu; okno je tím přesné na
  // minutu, což u hodinového limitu stačí, a nevzniká Set-Cookie na každý tep.
  let akt = ses.data.akt;
  if (aktivita && ted - akt >= TEP_THROTTLE_MS) {
    akt = ted;
    reply.setCookie(
      SESSION_COOKIE,
      vytvorSession(ses.ucet, ses.serial, {
        jmeno: ses.jmeno ?? undefined,
        exp: ses.data.exp,
        akt,
      }),
      COOKIE_NASTAVENI,
    );
  }
  // Kolik času zbývá do vypršení. Web podle toho minutu předem upozorní, ať
  // kurátor nepřijde o rozepsaný text. Absolutní strop (`exp`) může být
  // blíž než okno nečinnosti, tak se bere ten dřívější z obou.
  const zbyvaMs = Math.max(0, Math.min(akt + NECINNOST_MS, ses.data.exp) - ted);
  return { ok: true, zbyvaMs };
});

// Výchozí šablona znalostní báze (nabízí ji editor u prázdného kb.md).
// Kostra znalostní báze. CMS ji sám nepoužívá (editor skládá kb.md ze sekcí,
// viz web/src/lib/kbSekce.ts), endpoint zůstává jako popis dohodnutého tvaru
// pro chatbota a případné generátory obsahu.
app.get("/api/kb-template", async () => {
  return { text: KB_TEMPLATE };
});

// --- Displeje ---
app.get("/api/displays", async () => {
  return { displays: await listDisplays() };
});

// `jazyk` je volitelný a výchozí je cs, takže klient, který ho neposílá
// (Unity, chatbot, tablet u expozice), dostane přesně to co dřív. Neznámá
// hodnota spadne zpátky na cs, do cesty se tak nikdy nedostane nic jiného
// než cs, en nebo pl.
app.get<{ Params: { id: string }; Querystring: { jazyk?: string } }>(
  "/api/displays/:id",
  async (req, reply) => {
    const { id } = req.params;
    if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
    const meta = await readMeta(id);
    if (!meta) return reply.code(404).send({ chyba: "Displej nenalezen." });

    const jazyk = jazykNeboVychozi(req.query.jazyk);
    return {
      id,
      meta,
      slides: await readSlides(id, jazyk),
      kb: await readKb(id, jazyk),
      // Doplňková pole pro CMS; klienti, kteří je neznají, je ignorují.
      jazyk,
      jazyky: await stavJazyku(id),
    };
  },
);

// --- Znalostní báze (kb.md v kořeni displeje, edituje se mimo slidy) ---
app.put<{ Params: { id: string }; Body: { text?: string; jazyk?: string } }>(
  "/api/displays/:id/kb",
  async (req, reply) => {
    const { id } = req.params;
    if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
    if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });

    // Text je povinný: chybějící nebo prázdné tělo by jinak tiše smazalo kb.md.
    const text = req.body?.text;
    if (typeof text !== "string" || text.trim() === "") {
      return reply.code(400).send({ chyba: "Text znalostní báze nesmí být prázdný." });
    }
    const jazyk = jazykNeboVychozi(req.body?.jazyk);
    await writeKb(id, text, jazyk);
    await zapisAudit(req, "úprava znalostní báze", `displej ${id} (${jazyk})`);
    return { ok: true };
  },
);

// Uložení polí info panelu. Vzniká cs/<slozka>/text.txt (Klic: Hodnota) a táž
// identita (name, latin_name, category, section) se propíše do meta.json.
app.put<{
  Params: { id: string; n: string };
  Body: { pole?: Record<string, string>; section?: string; jazyk?: string };
}>("/api/displays/:id/slides/:n", async (req, reply) => {
  const { id } = req.params;
  const n = Number(req.params.n);
  if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
  if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });
  if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

  const pole = req.body?.pole && typeof req.body.pole === "object" ? req.body.pole : {};
  const section = typeof req.body?.section === "string" ? req.body.section : undefined;
  const jazyk = jazykNeboVychozi(req.body?.jazyk);
  const res = await writeInfoPole(id, n, pole, section, jazyk);
  if (!res.ok) return reply.code(400).send({ chyba: res.chyba });
  await zapisAudit(req, "úprava info panelu", `displej ${id}, slide ${n} (${jazyk})`);
  return { ok: true, latin: res.latin, latinCorrected: res.latinCorrected };
});

// Texty textového slidu (_gal): dva dlouhé texty a taxonomie po částech.
// Na disku cs/<slozka>/text.txt jako "ObecnyText: …", "Zajimavosti: …"
// a jeden složený řádek "Taxonomie: Třída: … | Řád: … | Čeleď: …".
//
// Tři pole taxonomie chodí zvlášť (Trida, Rad, Celed) a skládá je až server,
// aby tvar řádku, který čte Unity, vznikal na jednom místě.
app.put<{
  Params: { id: string; n: string };
  Body: { pole?: Record<string, string>; jazyk?: string };
}>("/api/displays/:id/slides/:n/text", async (req, reply) => {
  const { id } = req.params;
  const n = Number(req.params.n);
  if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
  if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

  // Prázdné texty projdou: kurátor si slide založí a text dopíše později,
  // je to legitimní rozdělaná práce (za hotový takový slide označit nejde,
  // to hlídá editor). Chybějící objekt `pole` ale ne, to by znamenalo
  // špatně poskládaný požadavek a tiché smazání obsahu.
  const pole = req.body?.pole;
  if (!pole || typeof pole !== "object" || Array.isArray(pole)) {
    return reply.code(400).send({ chyba: "Chybí texty slidu." });
  }
  for (const hodnota of Object.values(pole)) {
    if (typeof hodnota !== "string") {
      return reply.code(400).send({ chyba: "Texty slidu musí být řetězce." });
    }
  }

  const jazyk = jazykNeboVychozi(req.body?.jazyk);
  const res = await writeGalPole(id, n, pole, jazyk);
  if (!res.ok) return reply.code(400).send({ chyba: res.chyba });
  await zapisAudit(req, "úprava textového slidu", `displej ${id}, slide ${n} (${jazyk})`);
  return { ok: true };
});

// Obecné informace (slide _txt): dva dlouhé texty, na disku
// cs/<slozka>/text.txt jako "ObecnyText: …" a "Zajimavosti: …".
//
// Vlastní cesta, ne rozšíření endpointu info panelu: ten má jinou validaci
// (povinná sekce a název) i jiná sdílená pole, a chování stávajících typů
// se měnit nemá. Oba texty se překládají, takže se posílá i `jazyk`.
app.put<{
  Params: { id: string; n: string };
  Body: { pole?: Record<string, string>; jazyk?: string };
}>("/api/displays/:id/slides/:n/txt", async (req, reply) => {
  const { id } = req.params;
  const n = Number(req.params.n);
  if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
  if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

  // Prázdné texty projdou (rozdělaná práce), chybějící objekt `pole` ne:
  // to by znamenalo špatně poskládaný požadavek a tiché smazání obsahu.
  // Stejné pravidlo jako u zajímavosti.
  const pole = req.body?.pole;
  if (!pole || typeof pole !== "object" || Array.isArray(pole)) {
    return reply.code(400).send({ chyba: "Chybí texty slidu." });
  }
  for (const hodnota of Object.values(pole)) {
    if (typeof hodnota !== "string") {
      return reply.code(400).send({ chyba: "Texty slidu musí být řetězce." });
    }
  }

  const jazyk = jazykNeboVychozi(req.body?.jazyk);
  const res = await writeTextSlide(id, n, pole, jazyk);
  if (!res.ok) return reply.code(400).send({ chyba: res.chyba });
  await zapisAudit(req, "úprava obecných informací", `displej ${id}, slide ${n} (${jazyk})`);
  return { ok: true };
});

// Upload fotky (info panel, textový slide, snímek 3D sekvence, položka
// galerie). Mimo galerii se vždy převádí do PNG kvůli Unity; v galerii si
// fotka drží příponu, protože Unity tam řadí abecedně a na formátu nezáleží.
app.post<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/image",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    const file = await req.file();
    if (!file) return reply.code(400).send({ chyba: "Chybí soubor." });
    const buffer = await file.toBuffer();
    const res = await saveImage(id, n, buffer);
    if (!res.ok) return reply.code(400).send({ chyba: res.chyba });

    await zapisAudit(req, "upload", `displej ${id}, slide ${n}: ${path.basename(res.url!)}`);
    return { ok: true, url: res.url };
  },
);

// Smazání jedné položky slidu: fotky (info panel, textový slide, snímek 3D
// sekvence) nebo jedné položky galerie, tam i videa.
app.delete<{ Params: { id: string; n: string; nazev: string } }>(
  "/api/displays/:id/slides/:n/images/:nazev",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    // Fastify parametr už dekóduje; druhé decodeURIComponent zbytečně padalo
    // na URIError u samotného "%". Stačí basename.
    const nazev = path.basename(req.params.nazev);
    const ok = await deleteMedia(id, n, nazev);
    if (!ok) return reply.code(400).send({ chyba: "Soubor se nepodařilo smazat." });

    await zapisAudit(req, "smazání souboru", `displej ${id}, slide ${n}: ${nazev}`);
    return { ok: true };
  },
);

// Označení fotky info panelu jako mapa výskytu (přejmenuje se na mapa.png).
// Body { nazev: null } značení zruší.
app.put<{ Params: { id: string; n: string }; Body: { nazev?: string | null } }>(
  "/api/displays/:id/slides/:n/images/mapa",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    // Název přichází z JSON těla jako holé jméno souboru (ne URL-encoded);
    // decodeURIComponent tu nemá co dělat a padal na "%".
    const nazev = typeof req.body?.nazev === "string" ? req.body.nazev : null;
    const res = await setMapa(id, n, nazev);
    if (!res.ok) return reply.code(400).send({ chyba: res.chyba });

    await zapisAudit(req, nazev ? "označení mapy výskytu" : "zrušení mapy výskytu", `displej ${id}, slide ${n}${nazev ? `: ${path.basename(nazev)}` : ""}`);
    return { ok: true };
  },
);

// Originál fotky pro editor výřezu. Editor musí ukázat CELOU plochu, jinak
// by šlo výřez jen zmenšovat dovnitř. Soubor `<nazev>.orig` se schválně
// neservíruje přes statické /data: nemá příponu obrázku, takže by prohlížeč
// musel typ hádat. Tady mu ho řekneme. Když originál ještě není (fotka se
// nikdy neořezávala), vrátí se samotná fotka.
app.get<{ Params: { id: string; n: string; nazev: string } }>(
  "/api/displays/:id/slides/:n/images/:nazev/original",
  async (req, reply) => {
    const { id, nazev } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });

    const res = await ctiOriginalFotky(id, n, nazev);
    if (!res.ok) return reply.code(404).send({ chyba: res.chyba });
    // Originál se mění jen ořezem a ten jde vždy z CMS, takže krátká cache
    // stačí; delší by kurátorovi po uložení ukázala starý obrázek.
    return reply.type(res.typ!).header("Cache-Control", "no-cache").send(res.data);
  },
);

// Souřadnice výřezu z klienta. Jsou v podílech 0..1 vůči ORIGINÁLU, ne
// v pixelech — přežijí tak i zmenšení fotky při nahrání. Rozsah hlídáme
// tady, ať se do ořezu nedostane nesmysl z rozbitého klienta; výřez mimo
// fotku by sharp.extract() shodil.
function parsujVyrez(v: unknown): { vyrez?: Vyrez; chyba?: string } {
  const o = v as Record<string, unknown> | undefined;
  const cislo = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) ? x : null;
  const x = cislo(o?.x);
  const y = cislo(o?.y);
  const w = cislo(o?.w);
  const h = cislo(o?.h);
  if (x === null || y === null || w === null || h === null) return { chyba: "Neplatný výřez." };
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) {
    return { chyba: "Výřez je mimo fotku." };
  }
  return { vyrez: { x, y, w, h } };
}

// Výřez fotky. Kurátor v editoru navolí, co z fotky bude na tabletu vidět;
// server ji doopravdy ořízne a originál si odloží vedle jako `<nazev>.orig`,
// takže se dá výřez kdykoli posunout zpátky. Souřadnice jsou v podílech 0..1
// vůči ORIGINÁLU, ne v pixelech — přežijí tak i zmenšení fotky při nahrání.
app.put<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/vyrez",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    const telo = (req.body ?? {}) as { soubor?: unknown; vyrez?: unknown };
    const soubor = typeof telo.soubor === "string" ? telo.soubor.trim() : "";
    if (!soubor) return reply.code(400).send({ chyba: "Chybí název souboru." });

    const { vyrez, chyba } = parsujVyrez(telo.vyrez);
    if (!vyrez) return reply.code(400).send({ chyba });

    const res = await ulozVyrez(id, n, soubor, vyrez);
    if (!res.ok) return reply.code(400).send({ chyba: res.chyba });

    await zapisAudit(req, "úprava výřezu fotky", `displej ${id}, slide ${n}: ${path.basename(soubor)}`);
    return { ok: true };
  },
);

// Hromadný ořez sekvence 360. Jeden výřez pro celou otáčku, ne po snímcích.
// POST jen úlohu nastartuje a vrátí se hned; 36 snímků se ořezává desítky
// sekund a request by mezitím spadl na timeout. Editor se pak ptá GETem
// níž, jak daleko to je.
app.post<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/vyrez-sekvence",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    const telo = (req.body ?? {}) as { vyrez?: unknown };
    const { vyrez, chyba } = parsujVyrez(telo.vyrez);
    if (!vyrez) return reply.code(400).send({ chyba });

    const res = await spustOrezSekvence(id, n, vyrez);
    if (!res.ok) return reply.code(409).send({ chyba: res.chyba });

    // Audit se zapisuje při startu, ne po dokončení: kdyby ořez spadl,
    // chceme v logu vidět, že ho někdo pustil.
    await zapisAudit(req, "hromadný ořez sekvence 360", `displej ${id}, slide ${n}: ${res.celkem} snímků`);
    return { ok: true, celkem: res.celkem };
  },
);

// Průběh běžícího ořezu. `bezi: false` s `chyba: null` znamená hotovo,
// `null` že se pro tenhle slide od startu serveru žádný ořez nepouštěl.
app.get<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/vyrez-sekvence",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    return { stav: stavOrezuSekvence(id, n) };
  },
);

// Nahrání videa: do galerie (_vid) se přidá jako další položka řady, na info
// panelu nahradí to jediné, které tam smí být. Ukládá se jako mp4.
app.post<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/video",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    const file = await req.file();
    if (!file) return reply.code(400).send({ chyba: "Chybí soubor." });
    const ext = path.extname(file.filename).toLowerCase();
    const jeMp4 = file.mimetype === "video/mp4" || ext === ".mp4";
    if (!jeMp4) return reply.code(400).send({ chyba: "Nahrajte prosím video ve formátu MP4." });

    const buffer = await file.toBuffer();
    const res = await saveVideo(id, n, file.filename, buffer);
    if (!res.ok) return reply.code(400).send({ chyba: res.chyba });
    await zapisAudit(req, "upload videa", `displej ${id}, slide ${n}: ${path.basename(res.url!)}`);
    return { ok: true, url: res.url };
  },
);

// Smazání videa info panelu. Z galerie se maže po jedné položce přes
// DELETE .../images/:nazev, tohle by tam smazalo všechna videa najednou.
app.delete<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n/video",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await slideExists(id, n))) return reply.code(404).send({ chyba: "Slide nenalezen." });

    if (!(await deleteVideo(id, n))) {
      return reply.code(400).send({ chyba: "Tenhle slide nemá samostatné video." });
    }
    await zapisAudit(req, "smazání videa", `displej ${id}, slide ${n}`);
    return { ok: true };
  },
);

// Přidání nového slidu zvoleného typu na konec displeje.
app.post<{ Params: { id: string }; Body: { typ?: string } }>(
  "/api/displays/:id/slides",
  async (req, reply) => {
    const { id } = req.params;
    if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
    if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });

    // Proti NABÍDCE, ne proti všem známým typům: `_txt` je pozůstalý typ,
    // existující složky se dál čtou a editují, ale nový už nezaložíme.
    const typ = req.body?.typ;
    if (!typ || !SLIDE_TYPY_NABIDKA.includes(typ as SlideTyp)) {
      return reply.code(400).send({ chyba: "Neplatný typ slidu." });
    }
    const n = await addSlide(id, typ as SlideTyp);
    await zapisAudit(req, "přidání slidu", `displej ${id}, slide ${n} (${typ})`);
    return { ok: true, n };
  },
);

// Odebrání slidu; zbylé složky se přečíslují na souvislou řadu.
app.delete<{ Params: { id: string; n: string } }>(
  "/api/displays/:id/slides/:n",
  async (req, reply) => {
    const { id } = req.params;
    const n = Number(req.params.n);
    if (!validId(id) || !validSlide(n)) return reply.code(400).send({ chyba: "Neplatné parametry." });
    if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });

    const res = await removeSlide(id, n);
    if (!res.ok) return reply.code(400).send({ chyba: res.chyba });
    await zapisAudit(req, "odebrání slidu", `displej ${id}, slide ${n}`);
    return { ok: true };
  },
);

// Změna pořadí slidů: přejmenují se číselné prefixy složek.
app.put<{ Params: { id: string }; Body: { poradi?: number[] } }>(
  "/api/displays/:id/slides/reorder",
  async (req, reply) => {
    const { id } = req.params;
    if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
    if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });

    const poradi = Array.isArray(req.body?.poradi)
      ? req.body!.poradi.map(Number).filter((x) => Number.isInteger(x))
      : [];
    await reorderSlides(id, poradi);
    await zapisAudit(req, "pořadí slidů", `displej ${id}`);
    return { ok: true };
  },
);

// Kurátor potvrzuje, že AI texty z hromadného importu přečetl a schvaluje je.
// Je to záznam o převzetí odpovědnosti za text o živém zvířeti, který uvidí
// veřejnost, proto vlastní endpoint a vlastní řádek v auditu se jménem a
// časem, ne vedlejší efekt uložení kb.md.
app.post<{ Params: { id: string } }>("/api/displays/:id/revize", async (req, reply) => {
  const { id } = req.params;
  if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
  const meta = await readMeta(id);
  if (!meta) return reply.code(404).send({ chyba: "Displej nenalezen." });
  if (!meta.cekaNaRevizi) {
    return reply.code(400).send({ chyba: "Tento displej na revizi nečeká." });
  }

  await oznacRevizi(id, false);
  await zapisAudit(req, "potvrzení revize AI textů", `displej ${id}${meta.druh ? ` (${meta.druh})` : ""}`);
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/api/displays/:id/refresh", async (req, reply) => {
  const { id } = req.params;
  if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
  if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });
  // Mock: skutečné odeslání na tablet přijde s Unity integrací.
  await zapisAudit(req, "odesláno na displej", `displej ${id}`);
  return { ok: true };
});

// Tep tabletu: "jsem tady, běžím". Volá ho Michalovo Unity jednou za minutu
// z každého tabletu, viz tep.ts. Endpoint je VEŘEJNÝ (stejně jako čtení obsahu
// pro tablet): tablet se nemá jak přihlásit a jede po LAN pavilonu.
//
// Tělo je celé nepovinné, obsah je jen pro diagnostiku. Zásadní informace je
// samotný fakt, že požadavek dorazil, a čas si bereme vlastní.
//
// ZÁMĚRNĚ SE NEZAPISUJE DO AUDITU: 31 tabletů po minutě je 45 tisíc řádků
// denně a audit log je na to, co udělal člověk, ne na provozní telemetrii.
app.post<{ Params: { id: string } }>("/api/displays/:id/heartbeat", async (req, reply) => {
  const { id } = req.params;
  if (!validId(id)) return reply.code(400).send({ chyba: "Neplatné id." });
  if (!(await displayExists(id))) return reply.code(404).send({ chyba: "Displej nenalezen." });

  // Cokoli z tabletu je cizí vstup: bereme jen řetězce a krátíme je, ať se
  // do paměti serveru nedá poslat megabajtová "verze".
  const telo = (req.body ?? {}) as Record<string, unknown>;
  const text = (x: unknown): string | undefined => {
    if (typeof x !== "string") return undefined;
    const t = x.trim();
    return t ? t.slice(0, 100) : undefined;
  };

  zaznamenejTep(Number(id), {
    verze: text(telo.verze),
    obsahZ: text(telo.obsahZ),
    poznamka: text(telo.poznamka),
  });
  return { ok: true };
});

// --- Displej u deštného pralesa ---
//
// Samostatná věc pro jeden displej: neukazuje obsah druhu, ale prostředí
// pavilonu a odpočet do bouřky z videomappingu. Se strukturou data/displeje
// nemá nic společného, nastavení leží v data/prales.json.
//
// GET /api/prales je VEŘEJNÝ (viz VEREJNE_API), stejně jako čtení obsahu pro
// tablet u expozice: Unity si ho tahá každých pět sekund z 31 tabletů a
// přihlašovat se nemá jak. Odpověď je proto celá z paměti, bez čtení z disku
// a bez čekání na síť, viz prales.ts a pocasi.ts.

app.get("/api/prales", async () => {
  return sestavPayload().payload;
});

// Podklad pro nastavovací stránku v CMS: uložené hodnoty, přesně to, co
// zrovna dostávají tablety, a stav stahování venkovní teploty (odkud je a
// kdy přišla). Stejný tvar vrací i PUT, ať si stránka po uložení jen
// vymění stav a nemusí se ptát podruhé.
function stavPraleseProCms() {
  const { payload, zdrojTeploty } = sestavPayload();
  const p = stavPocasi();
  const stariMs = p.ziskano ? Date.now() - Date.parse(p.ziskano) : null;
  return {
    nastaveni: ziskejNastaveni(),
    nahled: payload,
    pocasi: {
      zdroj: zdrojTeploty, // "internet" = stažená hodnota, "zaloha" = od kurátora
      teplota: p.teplota,
      ziskano: p.ziskano,
      posledniPokus: p.posledniPokus,
      chyba: p.chyba,
      // Hodnota se používá dál (podle zadání), tohle je jen upozornění pro
      // kurátora, že internet delší dobu nejede.
      zastarale: stariMs !== null && stariMs > ZASTARALE_PO_MS,
      souradnice: { lat: LAT, lon: LON },
    },
  };
}

// Chráněné přihlášením jako ostatní /api.
app.get("/api/prales/nastaveni", async () => {
  return stavPraleseProCms();
});

app.put<{ Body: unknown }>("/api/prales/nastaveni", async (req, reply) => {
  const res = validujNastaveni(req.body);
  if (!res.ok) return reply.code(400).send({ chyba: res.chyba });

  const stare = ziskejNastaveni();
  const zmeny = popisZmen(stare, res.nastaveni);
  await ulozNastaveni(res.nastaveni);

  // Uložení beze změny (kurátor otevřel stránku a klikl na Uložit) se do
  // auditu nepíše, jen by ho zaplevelilo. Skutečné změny ano, i s tím,
  // co se změnilo z čeho na co.
  if (zmeny.length > 0) {
    await zapisAudit(req, "úprava nastavení deštného pralesa", zmeny.join(", "));
  }

  return { ok: true, ...stavPraleseProCms() };
});

// --- Díry v zemi (zapuštěné expoziční prvky) ---
//
// Dva prvky, které nejsou displeje: Michalův přehrávač si video čte přímo
// z disku ze složky v datovém kořeni. Jediné, co CMS dělá, je dostat do té
// složky právě jeden .mp4. Viz diry.ts. Chráněné přihlášením jako ostatní
// /api; soubory se přes HTTP neservírují (static je zúžený na displeje/).

app.get("/api/diry", async () => {
  return { diry: await stavVsech() };
});

app.post<{ Params: { id: string } }>("/api/diry/:id/video", async (req, reply) => {
  const dira = najdiDiru(req.params.id);
  if (!dira) return reply.code(404).send({ chyba: "Neznámý prvek." });

  const file = await req.file();
  if (!file) return reply.code(400).send({ chyba: "Chybí soubor." });
  // Stejná kontrola jako u videa na slidu: přehrávač bere jen .mp4.
  const ext = path.extname(file.filename).toLowerCase();
  const jeMp4 = file.mimetype === "video/mp4" || ext === ".mp4";
  if (!jeMp4) return reply.code(400).send({ chyba: "Nahrajte prosím video ve formátu MP4." });

  const buffer = await file.toBuffer();
  const res = await ulozVideo(dira, file.filename, buffer);
  await zapisAudit(req, "upload videa", `díra ${dira.nazev}: ${res.soubor}`);
  return { ok: true, stav: await stavDiry(dira) };
});

// --- Videomapping ---
//
// Dvě instalace od firmy, která je dodala. Poslouchají OSC přes UDP, stačí
// jedna zpráva bez argumentů (/start, /stop). Viz videomapping.ts a osc.ts.
//
// UDP NEPOTVRZUJE DORUČENÍ. Endpoint proto nikdy neříká „zapnuto“, jen
// „odesláno“ a kdy. Chyba znamená, že selhala naše strana (neplatná adresa,
// síť je dole); že zpráva nedorazila na cílový počítač, se nedozvíme ani my,
// ani kurátor. Chráněné přihlášením jako ostatní /api.

app.get("/api/videomapping", async () => {
  return {
    instalace: seznamInstalaci().map((i) => ({
      ...i,
      // Co jsme odsud naposledy poslali. Není to stav instalace, ten CMS nezná.
      posledni: ziskejPosledni(i.id),
    })),
  };
});

app.post<{ Params: { id: string; povel: string } }>(
  "/api/videomapping/:id/:povel",
  async (req, reply) => {
    const { id, povel } = req.params;
    if (!jePovel(povel)) return reply.code(400).send({ chyba: "Neplatný povel." });
    const cil = najdiInstalaci(id);
    if (!cil) return reply.code(404).send({ chyba: "Instalace nenalezena." });

    const uzivatel = currentUser(req);
    const jmeno = req.jmenoCloveka;
    const res = await posliPovel(id, povel);
    const kam = `${cil.nazev} (${cil.host}:${cil.port})`;
    const co = `${popisPovelu(povel)} (/${povel})`;

    // Do auditu jde i neúspěch: kurátor se ptá „mačkal jsem to, nebo ne“ a
    // v logu musí být vidět obojí, včetně důvodu.
    await zapisAudit(
      req,
      res.ok ? "odeslán povel videomappingu" : "povel videomappingu selhal",
      res.ok ? `${kam}: ${co}` : `${kam}: ${co} — ${res.chyba ?? "neznámá chyba"}`,
    );

    zapisPosledni(id, { povel, odeslano: res.odeslano, uzivatel, jmeno, ok: res.ok });

    if (!res.ok) {
      req.log.error(`[videomapping] ${kam}: ${res.chyba}`);
      // 502: náš server běží, nepovedlo se předat povel dál do sítě.
      return reply.code(502).send({ chyba: res.chyba });
    }
    return { ok: true, odeslano: res.odeslano, povel, instalace: cil.nazev };
  },
);

// --- Analytika chatbota (Danielův backend) ---
// Frontend cizí službu neoslovuje, jde to přes nás: jedno místo na adresu,
// timeout, očištění odpovědi a hlášku, když backend ještě neběží. Endpointy
// nejsou ve VEREJNE_API, takže je chrání přihlášení jako ostatní /api.
//
// Odpověď je i při nedostupném chatbotovi HTTP 200 s obálkou
// { dostupne: false, duvod }, dashboard tak nemá důvod padat a rozliší
// "analytika zatím není" od skutečné chyby požadavku (400/401).

// Volitelný ISO čas; nesmyslnou hodnotu odmítáme, ať se nehádá s backendem.
function neplatneSince(raw: string | undefined): boolean {
  return raw !== undefined && raw !== "" && Number.isNaN(Date.parse(raw));
}

app.get<{ Querystring: { since?: string; limit?: string; answered?: string } }>(
  "/api/analytics/questions",
  async (req, reply) => {
    const { since, limit, answered } = req.query;
    if (neplatneSince(since)) return reply.code(400).send({ chyba: "Neplatný parametr since." });

    let cislo: number | undefined;
    if (limit !== undefined && limit !== "") {
      cislo = Number(limit);
      if (!Number.isFinite(cislo) || cislo < 1) {
        return reply.code(400).send({ chyba: "Neplatný parametr limit." });
      }
      cislo = Math.min(Math.trunc(cislo), LIMIT_MAX); // strop z kontraktu
    }

    if (answered !== undefined && answered !== "" && answered !== "true" && answered !== "false") {
      return reply.code(400).send({ chyba: "Neplatný parametr answered." });
    }

    return ziskejQuestions({
      since: since || undefined,
      limit: cislo,
      answered: answered === "true" ? true : answered === "false" ? false : undefined,
    });
  },
);

app.get<{ Querystring: { since?: string } }>("/api/analytics/summary", async (req, reply) => {
  const { since } = req.query;
  if (neplatneSince(since)) return reply.code(400).send({ chyba: "Neplatný parametr since." });
  return ziskejSummary(since || undefined);
});

// --- Události z tabletů (zapisuje Michalovo Unity, my jen čteme) ---
//
// `dny` je okno zpět (výchozí 30), `displej` volitelný filtr. Soubory se
// nečtou pokaždé znovu, modul si drží výsledky v paměti a přepočítá jen den,
// jehož soubor se změnil.
app.get<{ Querystring: { dny?: string; displej?: string } }>(
  "/api/udalosti/prehled",
  async (req, reply) => {
    const { dny, displej } = req.query;

    let oknoDnu: number | undefined;
    if (dny !== undefined && dny !== "") {
      oknoDnu = Number(dny);
      if (!Number.isFinite(oknoDnu) || oknoDnu < 1) {
        return reply.code(400).send({ chyba: "Neplatný parametr dny." });
      }
    }
    let cisloDispleje: number | undefined;
    if (displej !== undefined && displej !== "") {
      cisloDispleje = Number(displej);
      if (!Number.isInteger(cisloDispleje) || cisloDispleje < 1) {
        return reply.code(400).send({ chyba: "Neplatný parametr displej." });
      }
    }

    // Seznam displejů z CMS: podle něj se pozná i displej, ze kterého
    // nepřišla ani jedna událost (tichý tablet).
    const vsechnyDispleje = (await listDisplays()).map((d) => Number(d.id));

    return prehledUdalosti({ dny: oknoDnu, displej: cisloDispleje, vsechnyDispleje });
  },
);

// --- Analytika návštěvnosti (sekce Analytika) ---
//
// Na rozdíl od /api/udalosti/prehled, který kouká na pár posledních dnů,
// se sem chodí i s ročním rozsahem. Proto to jede přes denní souhrny
// v analytika.ts, ne přes načítání samotných událostí — viz komentář tam.
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROZSAH_DNU = 400; // rok s rezervou; delší rozsah nemá co ukázat

app.get<{
  Querystring: { od?: string; do?: string; granularita?: string; porovnat?: string };
}>("/api/analytika", async (req, reply) => {
  const q = req.query;
  const doDne = q.do && q.do !== "" ? q.do : dnes();
  if (!DATUM_RE.test(doDne)) return reply.code(400).send({ chyba: "Neplatné datum do." });

  // Výchozí okno je posledních 30 dnů, ať stránka po otevření něco ukáže.
  const vychoziOd = new Date(Date.parse(`${doDne}T00:00:00Z`) - 29 * 86400000)
    .toISOString()
    .slice(0, 10);
  const od = q.od && q.od !== "" ? q.od : vychoziOd;
  if (!DATUM_RE.test(od)) return reply.code(400).send({ chyba: "Neplatné datum od." });
  if (od > doDne) return reply.code(400).send({ chyba: "Datum od je až za datem do." });

  const dnu = pocetDnu(od, doDne);
  if (dnu > MAX_ROZSAH_DNU) {
    return reply.code(400).send({ chyba: `Rozsah smí mít nejvýš ${MAX_ROZSAH_DNU} dnů.` });
  }

  const g = q.granularita;
  if (g !== undefined && g !== "" && g !== "den" && g !== "tyden" && g !== "mesic") {
    return reply.code(400).send({ chyba: "Neplatná granularita." });
  }

  // Jména druhů do žebříčku a počet displejů, podle kterých se pozná,
  // kolik jich zatím posílá čitelná data.
  const displeje = await listDisplays();
  const druhy = new Map<number, string>();
  for (const d of displeje) {
    // NEPRIRAZENO je zástupný text pro displej bez druhu, ne jméno. V žebříčku
    // by z něj bylo deset řádků „Nepřiřazeno #19" — ať tam radši stojí
    // „Displej 19", což aspoň něco říká.
    if (d.druh && d.druh !== NEPRIRAZENO) druhy.set(Number(d.id), d.druh);
  }

  return analytika({
    od,
    do: doDne,
    granularita: g === undefined || g === "" ? undefined : g,
    porovnat: q.porovnat === "1" || q.porovnat === "true",
    druhy,
    posledniDisplej: POSLEDNI_DISPLEJ,
    displejuCelkem: displeje.length,
  });
});

// --- Audit ---
// `limit` a `before` (ISO čas) umožní donačítat starší záznamy po stránkách;
// bez nich se vrátí nejnovější stránka. Tvar odpovědi { entries } zůstává.
app.get<{ Querystring: { limit?: string; before?: string; preskoc?: string } }>(
  "/api/audit",
  async (req, reply) => {
    const { limit, before, preskoc } = req.query;

    let pocet: number | undefined;
    if (limit !== undefined && limit !== "") {
      pocet = Number(limit);
      if (!Number.isFinite(pocet) || pocet < 1) {
        return reply.code(400).send({ chyba: "Neplatný parametr limit." });
      }
    }
    if (before !== undefined && before !== "" && Number.isNaN(Date.parse(before))) {
      return reply.code(400).send({ chyba: "Neplatný parametr before." });
    }
    let preskocit: number | undefined;
    if (preskoc !== undefined && preskoc !== "") {
      preskocit = Number(preskoc);
      if (!Number.isFinite(preskocit) || preskocit < 0) {
        return reply.code(400).send({ chyba: "Neplatný parametr preskoc." });
      }
    }

    return {
      entries: await readAudit({
        limit: pocet,
        before: before || undefined,
        preskoc: preskocit,
      }),
    };
  },
);

// --- Frontend (buildnutý web) ---
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/",
  });
  // SPA fallback: vše mimo /api a /data vrací index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/data")) {
      return reply.code(404).send({ chyba: "Nenalezeno." });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn(`Web build nenalezen (${WEB_DIST}). Spusť 'npm run build'. V dev módu běží Vite zvlášť.`);
}

try {
  if (!existsSync(DISPLAYS_DIR)) {
    app.log.warn(`Datová složka nenalezena (${DISPLAYS_DIR}). Spusť 'npm run seed'.`);
  }
  // Zbytky po přerušeném přejmenování nebo zápisu (`.tmp-*`). Uklízí se při
  // startu, kdy se souborami nikdo jiný nepracuje.
  const uklizeno = await uklidDocasneSoubory();
  if (uklizeno.length > 0) {
    app.log.warn(
      `Uklizeny dočasné zbytky po předchozím běhu (${uklizeno.length}): ${uklizeno.slice(0, 5).join(", ")}`,
    );
  }
  // Displej u deštného pralesa: nastavení do paměti a start stahování
  // venkovní teploty na pozadí. První stažení se nečeká, aby start serveru
  // nezdržel výpadek internetu.
  await spustPrales(app.log);
  spustPocasi(app.log);
  // Adresy instalací videomappingu z prostředí (jen se přečtou a zalogují,
  // nic se nikam neposílá).
  spustVideomapping(app.log);
  if ((await pocetUzivatelu()) === 0) {
    app.log.warn(
      "Žádné účty v data/users.json, do CMS se nedá přihlásit. " +
        "Založ účet: npm run useradd -- <jmeno> <heslo>",
    );
  }
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Amphibiárium · Vzdálený přístup běží na http://${HOST}:${PORT}`);
  app.log.info(`Datová složka: ${DATA_ROOT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
