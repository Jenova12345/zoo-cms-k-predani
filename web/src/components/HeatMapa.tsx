import { useState } from "react";

import { canonicalizeLatin } from "../lib/latin";
import { NEPRIRAZENO } from "../lib/types";
import type { AnalyticsSpecies, AnalyticsSummary, DisplaySummary } from "../lib/types";

// Heat mapa nad půdorysem pavilonu. Bývala v dashboardu; přehled má ukazovat
// AKTUÁLNÍ STAV (co se děje teď), a mapa je pohled na delší období, proto
// patří do Analytiky. Soubor je společný, aby se kreslení plánku a párování
// druhů nemuselo nikde opisovat.

// --- Heat mapa nad reálným půdorysem pavilonu ---

interface HeatNode {
  id: string;
  n: number; // číslo displeje
  popis: string; // druh z našich meta.json (záloha: druh z analytiky)
  x: number; // % šířky půdorysu
  y: number; // % výšky půdorysu
  count: number; // dotazů za sledované období
  score: number; // 0 až 1, intenzita pro barvu a velikost
}

// Oficiální půdorys pavilonu od ZOO, verze S ČÍSLY DISPLEJŮ (17. 8. 2026).
// Kopie podklady/Amphibiarium_mapa 1.png, servíruje se z web/public. Poměr
// stran drží mapu ve správném tvaru při jakékoli šířce okna.
const PUDORYS = "/pavilon-pudorys.png";
const PUDORYS_POMER = "6459 / 6434";

// ┌─ POZICE DISPLEJŮ NA PŮDORYSU ────────────────────────────────────────────┐
// │ Tady se souřadnice ladí. x a y jsou procenta šířky a výšky obrázku       │
// │ (levý horní roh = 0, 0), takže se body škálují s velikostí mapy.         │
// │ Bod displeje N leží na obdélníčku s číslem N.                            │
// └─────────────────────────────────────────────────────────────────────────┘
//
// Jak souřadnice vznikly: v plánku je u každé vitríny natištěné číslo displeje
// (1 až 31). Středy obdélníčků jsou odečtené z obrázku detekcí barevných ploch
// (spojité komponenty jedné barvy) a k nim přiřazená čísla přečtená z plánku.
// Kolečka s čísly 1 až 11 jsou sekce (skupiny displejů), ty tu nejsou. Bez čísla
// jsou na plánku i tři tvary, které tedy displeje nejsou: kruhová nádrž
// u sekce 1, zelený pruh u stěny a prostřední fialový box u sekce 8.
// Komentáře u skupin uvádějí barvu a číslo sekce z plánku, jen pro orientaci.
const PUDORYS_BODY: { displej: number; x: number; y: number }[] = [
  // tyrkysová, sekce 1
  { displej: 1, x: 17.4, y: 58.0 },
  // lososová, sekce 2
  { displej: 2, x: 27.2, y: 66.6 },
  { displej: 3, x: 29.5, y: 70.4 },
  { displej: 4, x: 33.1, y: 73.4 },
  { displej: 5, x: 37.3, y: 77.0 },
  { displej: 6, x: 42.0, y: 79.1 },
  { displej: 7, x: 47.7, y: 79.1 },
  // žlutá, sekce 3
  { displej: 8, x: 13.5, y: 77.7 },
  { displej: 9, x: 17.6, y: 81.6 },
  { displej: 10, x: 21.8, y: 85.1 },
  { displej: 11, x: 25.7, y: 88.4 },
  // malinová, sekce 4
  { displej: 12, x: 29.4, y: 93.0 },
  { displej: 13, x: 43.7, y: 95.6 },
  { displej: 14, x: 51.2, y: 93.8 },
  // oranžová, sekce 7
  { displej: 15, x: 73.5, y: 67.3 },
  { displej: 16, x: 77.2, y: 63.7 },
  { displej: 17, x: 79.0, y: 59.3 },
  { displej: 18, x: 78.9, y: 54.3 },
  // fialová, sekce 8 (prostřední box strip nemá číslo, displej to není)
  { displej: 19, x: 94.7, y: 46.7 },
  { displej: 20, x: 94.8, y: 35.6 },
  // modrá, sekce 9, vnější stěna severovýchodní chodby
  { displej: 21, x: 92.8, y: 27.8 },
  { displej: 22, x: 88.9, y: 24.1 },
  { displej: 23, x: 83.5, y: 18.7 },
  // modrá, sekce 9, vnitřní stěna téže chodby
  { displej: 24, x: 79.4, y: 33.5 },
  { displej: 25, x: 75.7, y: 29.9 },
  { displej: 26, x: 72.2, y: 26.5 },
  // hnědá, sekce 10
  { displej: 27, x: 71.0, y: 6.2 },
  { displej: 28, x: 65.2, y: 4.1 },
  { displej: 29, x: 58.5, y: 4.2 },
  { displej: 30, x: 58.9, y: 17.9 },
  // zelená, sekce 11
  { displej: 31, x: 50.9, y: 17.9 },
];

// Nízká návštěvnost zelená → vysoká červená. Stejné zastávky má i legenda
// pod mapou (HEAT_GRADIENT), ať se barvy nerozejdou.
function heatColor(score: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.0, [134, 196, 138]], // světle zelená
    [0.35, [21, 128, 61]], // zelená
    [0.7, [194, 116, 12]], // oranžová
    [1.0, [220, 38, 38]], // červená
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i];
    const [s1, c1] = stops[i + 1];
    if (score <= s1) {
      const t = (score - s0) / (s1 - s0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(220, 38, 38)";
}

const HEAT_GRADIENT = "linear-gradient(90deg, #86C48A, #15803D 35%, #C2740C 70%, #DC2626)";

// Bez analytiky se body kreslí neutrálně šedě, heat mapa bez dat nemá co barvit.
const NEUTRAL = "#A3ADAA";

interface MapaData {
  nodes: HeatNode[];
  maxNode: HeatNode | null; // displej s nejvíc dotazy
  // Krajní naměřené hodnoty. Legenda je musí vypsat: u relativní škály je
  // nejtmavší bod „nejvíc z toho, co tu je", ne „hodně", a bez čísel by to
  // bylo zavádějící.
  min: number;
  max: number;
  nenaparovano: AnalyticsSpecies[]; // druhy z analytiky bez displeje u nás
  mimoPudorys: number[]; // displeje z CMS, které na plánku nejsou
  chybiVCms: number[]; // displeje z plánku, které v CMS nejsou
}

// Párování analytiky na displeje: primárně přes species_latin proti latin_name
// z našich meta.json (obojí kanonizované stejnými pravidly), display_id jen
// jako záloha, podle kontraktu může být null.
function naparuj(
  displays: DisplaySummary[],
  summary: AnalyticsSummary | null,
  navstevy: Map<number, number> | null,
): MapaData {
  const podleCisla = new Map(displays.map((d) => [Number(d.id), d]));

  const podleLatiny = new Map<string, { count: number; species_name: string }>();
  const podleId = new Map<number, { count: number; species_name: string }>();
  for (const s of summary?.per_species ?? []) {
    const latin = canonicalizeLatin(s.species_latin);
    if (latin) {
      const drive = podleLatiny.get(latin);
      podleLatiny.set(latin, {
        count: (drive?.count ?? 0) + s.count,
        species_name: s.species_name || drive?.species_name || "",
      });
    }
    if (s.display_id !== null) {
      const drive = podleId.get(s.display_id);
      podleId.set(s.display_id, {
        count: (drive?.count ?? 0) + s.count,
        species_name: s.species_name || drive?.species_name || "",
      });
    }
  }

  const pouziteLatiny = new Set<string>();
  const pouziteId = new Set<number>();

  // Párování se počítá pro VŠECHNY displeje z CMS, i pro ty mimo půdorys,
  // jinak by druh napárovaný na displej 35 hlásil, že nemá displej.
  const zasahy = new Map<number, { count: number; species_name: string } | undefined>();
  for (const d of displays) {
    const latin = canonicalizeLatin(d.latin_name ?? "");
    const podleJmena = latin ? podleLatiny.get(latin) : undefined;
    const zaloha = podleJmena ? undefined : podleId.get(Number(d.id));
    if (podleJmena) pouziteLatiny.add(latin);
    if (zaloha) pouziteId.add(Number(d.id));
    zasahy.set(Number(d.id), podleJmena ?? zaloha);
  }

  // Body kreslíme podle půdorysu; displej, který v CMS není, se vynechá.
  const bezScore = PUDORYS_BODY.flatMap((bod) => {
    const d = podleCisla.get(bod.displej);
    if (!d) return [];
    const zasah = zasahy.get(bod.displej);
    // Druh bere přednostně z našich meta.json, jméno z analytiky je záloha.
    const cmsDruh = d.druh === NEPRIRAZENO ? "" : d.druh;
    return [
      {
        id: d.id,
        n: bod.displej,
        popis: cmsDruh || zasah?.species_name || NEPRIRAZENO,
        x: bod.x,
        y: bod.y,
        // Když z tabletů chodí návštěvy, barví mapu ony: je to přímé měření
        // toho, kde se lidi zastavili. Dotazy na chatbota jsou záloha.
        count: navstevy ? (navstevy.get(bod.displej) ?? 0) : (zasah?.count ?? 0),
      },
    ];
  });

  // Škála jde od NEJMENŠÍ k NEJVĚTŠÍ naměřené hodnotě, ne od nuly. Když mají
  // tablety podobná čísla (200 až 250 návštěv), škála od nuly je všechny
  // obarví skoro stejně a mapa nic neřekne. Počítá se jen z displejů, které
  // data MAJÍ — nula znamená „tablet nic neposlal", ne „nejméně navštívený",
  // a ty zůstávají neutrálně šedé.
  const sData = bezScore.filter((n) => n.count > 0);
  const max = sData.reduce((a, b) => Math.max(a, b.count), 0);
  const min = sData.length ? sData.reduce((a, b) => Math.min(a, b.count), Infinity) : 0;
  const rozpeti = max - min;
  const nodes: HeatNode[] = bezScore.map((n) => ({
    ...n,
    // Všechny stejné (rozpětí 0) → prostřední odstín: tvrdit „tenhle je
    // nejmíň" o displeji se stejným číslem jako ostatní by byla lež.
    score: n.count <= 0 ? 0 : rozpeti > 0 ? Math.max(0.04, (n.count - min) / rozpeti) : 0.5,
  }));

  const nenaparovano = (summary?.per_species ?? []).filter((s) => {
    const latin = canonicalizeLatin(s.species_latin);
    if (latin && pouziteLatiny.has(latin)) return false;
    if (s.display_id !== null && pouziteId.has(s.display_id)) return false;
    return true;
  });

  const naPudorysu = new Set(PUDORYS_BODY.map((b) => b.displej));

  return {
    nodes,
    maxNode: max > 0 ? nodes.reduce((a, b) => (b.count > a.count ? b : a), nodes[0]) : null,
    min: sData.length ? min : 0,
    max,
    nenaparovano,
    mimoPudorys: displays.map((d) => Number(d.id)).filter((n) => !naPudorysu.has(n)),
    chybiVCms: PUDORYS_BODY.filter((b) => !podleCisla.has(b.displej)).map((b) => b.displej),
  };
}


// --- Komponenta ------------------------------------------------------------

function pocetDotazuCs(n: number): string {
  if (n === 1) return "1 dotaz";
  if (n >= 2 && n <= 4) return `${n} dotazy`;
  return `${n} dotazů`;
}

const cisloCs = (n: number) => n.toLocaleString("cs-CZ");

export function HeatMapa({
  displays,
  summary,
  navstevy,
  popisObdobi,
}: {
  displays: DisplaySummary[];
  // Souhrn dotazů na AI. `null` = analytika chatbota není k dispozici; mapa
  // pak jen ukáže displeje bez intenzity.
  summary: AnalyticsSummary | null;
  // Návštěvy z tabletů podle čísla displeje. Když jsou, barví mapu ony: je to
  // přímé měření toho, kde se lidi zastavili. Dotazy na AI jsou záloha.
  navstevy: Map<number, number> | null;
  popisObdobi: string;
}) {
  const [hover, setHover] = useState<HeatNode | null>(null);
  const mapa = naparuj(displays, summary, navstevy);
  const maCim = summary !== null || navstevy !== null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="kicker">{navstevy ? "Kde se lidi zastavují" : "Mapa dotazů na AI"}</div>
          <h3 className="font-display text-lg font-semibold text-fg mt-1.5">Půdorys pavilonu</h3>
          <div className="mt-1 text-[11px] text-fg-dim">
            Barví: {navstevy ? "návštěvy z tabletů" : "dotazy na AI"} · {popisObdobi}
          </div>
        </div>
        {mapa.maxNode && (
          <div className="text-right">
            <div className="font-display text-xl font-bold text-fg tnum leading-none">
              {cisloCs(mapa.maxNode.count)}
            </div>
            <div className="text-[11px] text-fg-dim mt-1">špička · displej {mapa.maxNode.n}</div>
          </div>
        )}
      </div>

      <div
        className="relative mx-auto w-full max-w-[760px]"
        style={{ aspectRatio: PUDORYS_POMER }}
        onMouseLeave={() => setHover(null)}
      >
        {/* Plánek je jen tichý obrys: odbarvený a ztlumený, ať barevné zóny
            nepřebíjejí body návštěvnosti. */}
        <img
          src={PUDORYS}
          alt="Půdorys pavilonu Amphibiárium"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
          style={{ filter: "grayscale(1)", opacity: 0.35 }}
        />

        {mapa.nodes.map((node) => {
          const zvyraznit = maCim && node.count > 0;
          const color = zvyraznit ? heatColor(node.score) : NEUTRAL;
          const active = hover?.id === node.id;
          const velikost = 2.2 + node.score * 2.8;
          return (
            <button
              key={node.id}
              onMouseEnter={() => setHover(node)}
              className="absolute rounded-full border-2 border-white transition-transform"
              style={{
                left: `${node.x}%`,
                top: `${node.y}%`,
                width: `${velikost}%`,
                height: `${velikost}%`,
                background: color,
                boxShadow: [
                  "0 1px 3px rgba(16,40,34,0.3)",
                  active ? "0 0 0 3px rgba(15,118,110,0.55)" : "",
                  zvyraznit ? `0 0 ${8 + node.score * 18}px ${node.score * 4}px ${color}55` : "",
                ]
                  .filter(Boolean)
                  .join(", "),
                transform: `translate(-50%, -50%) scale(${active ? 1.2 : 1})`,
                zIndex: active ? 20 : 1,
              }}
              aria-label={
                maCim
                  ? `Displej ${node.n}, ${node.popis}, ${
                      navstevy ? `${cisloCs(node.count)} návštěv` : pocetDotazuCs(node.count)
                    }`
                  : `Displej ${node.n}, ${node.popis}`
              }
            />
          );
        })}

        {hover && (
          <div
            className="absolute z-30 pointer-events-none rounded-lg border border-line bg-surface px-3 py-2 shadow-cardHover"
            style={{
              left: `${hover.x}%`,
              top: `${hover.y}%`,
              maxWidth: 220,
              // U kraje mapy se bublina zarovná dovnitř, ať nevylézá z plochy.
              transform: `translate(${
                hover.x > 78 ? "-88%" : hover.x < 22 ? "-12%" : "-50%"
              }, ${hover.y < 18 ? "18px" : "calc(-100% - 18px)"})`,
            }}
          >
            <div className="font-display text-sm font-semibold text-fg tnum">
              Displej {hover.n}
            </div>
            <div className="text-[11px] text-fg-muted">{hover.popis}</div>
            {maCim && (
              <div className="text-[11px] text-fg-muted tnum">
                {navstevy ? `${cisloCs(hover.count)}× návštěva` : pocetDotazuCs(hover.count)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-[760px] space-y-2.5">
        {maCim && mapa.max > 0 ? (
          <>
            {/* Legenda MUSÍ nést čísla: škála je relativní, takže nejtmavší bod
                znamená „nejvíc z toho, co tu je". Bez krajních hodnot by
                vypadal jako „hodně", i když je rozdíl mezi displeji malý. */}
            <div className="flex items-center gap-3 text-[11px] text-fg-dim max-w-md">
              <span className="tnum">{cisloCs(mapa.min)}</span>
              <div className="h-1.5 flex-1 rounded-full" style={{ background: HEAT_GRADIENT }} />
              <span className="tnum">{cisloCs(mapa.max)}</span>
            </div>
            <p className="text-[11px] text-fg-dim">
              {mapa.min === mapa.max
                ? "Všechny displeje s daty mají stejné číslo, mapa je proto jednobarevná."
                : "Barva se škáluje od nejmenší po největší naměřenou hodnotu, ne od nuly — proto jsou vidět i malé rozdíly. Šedý bod znamená, že tablet za období neposlal nic."}
            </p>
            {mapa.nenaparovano.length > 0 && (
              <p className="text-[11px] text-fg-dim">
                {mapa.nenaparovano.length}{" "}
                {mapa.nenaparovano.length === 1 ? "druh z analytiky" : "druhů z analytiky"} se
                nepodařilo napárovat na displej (
                {mapa.nenaparovano
                  .slice(0, 3)
                  .map((s) => s.species_latin || s.species_name || "?")
                  .join(", ")}
                {mapa.nenaparovano.length > 3 ? ", …" : ""}). Zkontrolujte latinský název v info
                panelu displeje.
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-fg-dim">
            Body ukazují displeje na půdorysu. Intenzita se dokreslí, až za zvolené období dorazí
            návštěvy z tabletů nebo dotazy na chatbota.
          </p>
        )}

        {/* Kolečka na plánku jsou zóny expozice, ať si je nikdo neplete
            s čísly displejů. */}
        <p className="text-[11px] text-fg-dim">
          Body leží na obdélníčcích s čísly displejů z plánku od ZOO (číslo, druh a počet ukáže
          nájezd myší). Kolečka s čísly 1 až 11 na plánku jsou sekce, tedy skupiny displejů; ty
          v mapě body nemají.
        </p>

        {mapa.mimoPudorys.length > 0 && (
          <p className="text-[11px] text-fg-dim">
            Půdorys od ZOO zachycuje displeje 1 až {PUDORYS_BODY.length}. V CMS jsou navíc displeje{" "}
            <span className="tnum">{mapa.mimoPudorys.join(", ")}</span>, na plánku nejsou, v mapě
            se proto nezobrazují.
          </p>
        )}
        {mapa.chybiVCms.length > 0 && (
          <p className="text-[11px] text-fg-dim">
            Displeje <span className="tnum">{mapa.chybiVCms.join(", ")}</span> jsou na půdorysu, ale
            v CMS chybí.
          </p>
        )}
      </div>
    </div>
  );
}
