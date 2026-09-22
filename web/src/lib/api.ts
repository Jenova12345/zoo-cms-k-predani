import { NAHRAVANI_MAX_MB } from "./limity";
import type {
  Jazyk,
  Analytika,
  PrehledUdalosti,
  AnalyticsQuestions,
  AnalyticsSummary,
  AnalytikaNavstevnosti,
  AuditEntry,
  DisplayDetail,
  Granularita,
  Jmeno,
  DisplaySummary,
  PralesNastaveni,
  PralesStav,
  SlideTyp,
  DiraStav,
  VideomappingInstalace,
  VideomappingPovel,
  StavOrezuSekvence,
  Vyrez,
  VyresenyDotaz,
} from "./types";

// Jméno přihlášeného v localStorage (jen kvůli okamžitému vykreslení; zdrojem
// pravdy je podepsaná session cookie na serveru).
export const STORAGE_KEY = "amph_user";

// Důvod odhlášení pro přihlašovací obrazovku. Přežije přesměrování (je
// v sessionStorage), ale ne zavření záložky — je to jednorázová hláška.
export const DUVOD_KEY = "amph_duvod";

// Session vypršela nebo chybí: zahoď lokální stav a pošli na přihlášení.
// Náhled tabletu je veřejný, ten nepřesměrováváme.
function sessionVyprsela(duvod?: string) {
  const cesta = window.location.pathname;
  if (cesta.startsWith("/tablet") || cesta === "/login") return;
  localStorage.removeItem(STORAGE_KEY);
  try {
    if (duvod) sessionStorage.setItem(DUVOD_KEY, duvod);
  } catch {
    // privátní okno bez úložiště: hláška odpadne, odhlášení proběhne stejně
  }
  window.location.href = "/login";
}

// Server řekl „přihlášený jsi, ale jméno sis nevybral". Nepřesměrováváme na
// přihlášení (to by znamenalo zadávat znovu heslo), jen dáme vědět
// AuthProvideru, ať vykreslí výběr jména. Stane se to typicky tehdy, když
// mezitím vypršela cookie a člověk se přihlásil v jiné záložce.
export const UDALOST_CHYBI_JMENO = "amph:chybi-jmeno";

function chybiJmeno() {
  window.dispatchEvent(new CustomEvent(UDALOST_CHYBI_JMENO));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let kod: string | undefined;
    try {
      const body = await res.json();
      detail = body?.chyba ?? detail;
      kod = typeof body?.kod === "string" ? body.kod : undefined;
    } catch {
      // ignore
    }
    if (res.status === 401) sessionVyprsela(kod === "necinnost" ? detail : undefined);
    if (res.status === 403 && kod === "jmeno") chybiJmeno();
    // 413 utne multipart ještě v přenosu, takže ze serveru chodí jen obecná
    // hláška. Kurátor ale potřebuje vědět, co s tím, proto vlastní text.
    if (res.status === 413) {
      throw new Error(`Soubor je moc velký, maximum je ${NAHRAVANI_MAX_MB} MB.`);
    }
    throw new Error(detail || `Chyba ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async login(username: string, password: string): Promise<{ ok: boolean; username: string }> {
    return request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  },

  async logout(): Promise<void> {
    await request("/api/logout", { method: "POST" });
  },

  // `jmeno: null` u přihlášeného účtu = ještě si nevybral, web pak vykreslí
  // obrazovku výběru místo obsahu CMS.
  async me(): Promise<{ username: string | null; jmeno: string | null }> {
    return request("/api/me");
  },

  // Analytika návštěvnosti. Server vrací hotová čísla za zvolený rozsah;
  // `granularita` se dá nechat na něm (navrhne ji podle délky období).
  async analytika(p: {
    od: string;
    do: string;
    granularita?: Granularita;
    porovnat?: boolean;
  }): Promise<AnalytikaNavstevnosti> {
    const q = new URLSearchParams({ od: p.od, do: p.do });
    if (p.granularita) q.set("granularita", p.granularita);
    if (p.porovnat) q.set("porovnat", "1");
    return request(`/api/analytika?${q.toString()}`);
  },

  // --- Jména lidí u sdíleného účtu ---
  async jmena(): Promise<{ jmena: Jmeno[] }> {
    return request("/api/jmena");
  },

  async pridejJmeno(jmeno: string): Promise<{ jmena: Jmeno[] }> {
    return request("/api/jmena", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jmeno }),
    });
  },

  async smazJmeno(jmeno: string): Promise<{ jmena: Jmeno[] }> {
    return request(`/api/jmena/${encodeURIComponent(jmeno)}`, { method: "DELETE" });
  },

  async vyberJmeno(jmeno: string): Promise<{ jmeno: string }> {
    return request("/api/session/jmeno", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jmeno }),
    });
  },

  // Tep od člověka u klávesnice: jediné, co posouvá okno nečinnosti — a to
  // JEN s `aktivita: true`. Bez něj se endpoint jen zeptá, kolik zbývá, aby
  // šlo minutu předem varovat; kdyby posouval i tenhle dotaz, otevřená
  // záložka by se udržovala přihlášená donekonečna.
  async tep(aktivita: boolean): Promise<{ zbyvaMs: number }> {
    return request("/api/session/tep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aktivita }),
    });
  },

  async displays(): Promise<DisplaySummary[]> {
    const data = await request<{ displays: DisplaySummary[] }>("/api/displays");
    return data.displays;
  },

  // `jazyk` je volitelný, server bez něj vrací češtinu (stejně jako dřív).
  async display(id: string, jazyk: Jazyk = "cs"): Promise<DisplayDetail> {
    return request<DisplayDetail>(`/api/displays/${id}?jazyk=${jazyk}`);
  },

  // Uloží pole info panelu (na disku vznikne text.txt s řádky "Klic: Hodnota")
  // a identita se propíše i do meta.json. Vrací kanonizované latinské jméno a
  // příznak, jestli ho server musel opravit.
  async saveInfo(
    id: string,
    n: number,
    pole: Record<string, string>,
    section: string,
    jazyk: Jazyk = "cs",
  ): Promise<{ latin: string; latinCorrected: boolean }> {
    return request<{ ok: boolean; latin: string; latinCorrected: boolean }>(
      `/api/displays/${id}/slides/${n}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pole, section, jazyk }),
      },
    );
  },

  // Texty textového slidu (_gal): dva dlouhé texty a taxonomie po částech
  // (Trida, Rad, Celed). Do jednoho řádku "Taxonomie: …" je složí až server,
  // aby tvar, který čte Unity, vznikal na jednom místě. Všechno se překládá,
  // proto se posílá i jazyk; sdílené s češtinou tu není nic.
  async saveSlideText(
    id: string,
    n: number,
    pole: Record<string, string>,
    jazyk: Jazyk = "cs",
  ): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/text`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pole, jazyk }),
    });
  },

  // Obecné informace (slide _txt): oba texty naráz. Na disku vznikne text.txt
  // s klíči "ObecnyText:" a "Zajimavosti:". Oba se překládají, takže se posílá
  // i jazyk; sdílené s češtinou tu není nic.
  async saveTextSlide(
    id: string,
    n: number,
    pole: Record<string, string>,
    jazyk: Jazyk = "cs",
  ): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/txt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pole, jazyk }),
    });
  },

  // Uloží znalostní bázi (kb.md v kořeni displeje).
  async saveKb(id: string, text: string, jazyk: Jazyk = "cs"): Promise<void> {
    await request(`/api/displays/${id}/kb`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, jazyk }),
    });
  },

  // `signal` umožní kurátorovi rozdělané nahrávání zrušit (u 3D sekvence
  // a u galerie jde o desítky souborů za sebou).
  async uploadImage(
    id: string,
    n: number,
    file: File,
    signal?: AbortSignal,
  ): Promise<{ url: string }> {
    const form = new FormData();
    form.append("file", file);
    return request<{ ok: boolean; url: string }>(`/api/displays/${id}/slides/${n}/image`, {
      method: "POST",
      body: form,
      signal,
    });
  },

  // Smaže jednu položku slidu: fotku (info panel, textový slide, snímek 3D
  // sekvence) nebo jednu položku galerie, tam i video.
  async deleteMedia(id: string, n: number, nazev: string): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/images/${encodeURIComponent(nazev)}`, {
      method: "DELETE",
    });
  },

  // Výřez fotky. Souřadnice jsou v podílech 0..1 vůči originálu; server podle
  // nich ořízne `<nazev>.orig` a přepíše fotku, kterou čte Unity.
  async saveVyrez(id: string, n: number, soubor: string, vyrez: Vyrez): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/vyrez`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ soubor, vyrez }),
    });
  },

  // Spustí hromadný ořez sekvence 360. Vrací se hned, ořez běží dál na
  // serveru — průběh se zjišťuje stavOrezuSekvence().
  async oriznSekvenci(id: string, n: number, vyrez: Vyrez): Promise<{ celkem: number }> {
    return request(`/api/displays/${id}/slides/${n}/vyrez-sekvence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vyrez }),
    });
  },

  async stavOrezuSekvence(id: string, n: number): Promise<{ stav: StavOrezuSekvence | null }> {
    return request(`/api/displays/${id}/slides/${n}/vyrez-sekvence`);
  },

  // URL originálu pro editor výřezu (ne oříznuté fotky, tu by šlo jen zmenšovat).
  originalUrl(id: string, n: number, nazev: string): string {
    return `/api/displays/${id}/slides/${n}/images/${encodeURIComponent(nazev)}/original`;
  },

  // Označí fotku info panelu jako mapu výskytu (mapa.png); nazev=null značení zruší.
  async setMapa(id: string, n: number, nazev: string | null): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/images/mapa`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nazev }),
    });
  },

  // Video je jeden velký soubor, takže se nahrává přes XHR: fetch neumí
  // hlásit, kolik bajtů už odešlo, a kurátor u stovek MB potřebuje vidět,
  // že se něco děje (a umět to zrušit).
  async uploadVideo(
    id: string,
    n: number,
    file: File,
    opts: { onProgress?: (procenta: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ url: string }> {
    const form = new FormData();
    form.append("file", file);
    return xhrUpload<{ ok: boolean; url: string }>(
      `/api/displays/${id}/slides/${n}/video`,
      form,
      opts,
    );
  },

  async deleteVideo(id: string, n: number): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}/video`, { method: "DELETE" });
  },

  async addSlide(id: string, typ: SlideTyp): Promise<{ n: number }> {
    return request<{ ok: boolean; n: number }>(`/api/displays/${id}/slides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typ }),
    });
  },

  async deleteSlide(id: string, n: number): Promise<void> {
    await request(`/api/displays/${id}/slides/${n}`, { method: "DELETE" });
  },

  async reorderSlides(id: string, poradi: number[]): Promise<void> {
    await request(`/api/displays/${id}/slides/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poradi }),
    });
  },

  // Kurátor potvrdil, že AI texty z importu přečetl a schvaluje je. Server
  // zruší značku „čeká na revizi" a zapíše do auditu, kdo a kdy to potvrdil.
  async potvrditRevizi(id: string): Promise<void> {
    await request(`/api/displays/${id}/revize`, { method: "POST" });
  },

  async refresh(id: string): Promise<void> {
    await request(`/api/displays/${id}/refresh`, { method: "POST" });
  },

  // Nejnovější záznamy první. `before` (ISO čas posledního načteného záznamu)
  // vrátí starší stránku, takže se dá donačítat směrem do minulosti.
  async audit(
    filtr: { limit?: number; before?: string; preskoc?: number } = {},
  ): Promise<AuditEntry[]> {
    const params = new URLSearchParams();
    if (filtr.limit !== undefined) params.set("limit", String(filtr.limit));
    if (filtr.before) params.set("before", filtr.before);
    if (filtr.preskoc) params.set("preskoc", String(filtr.preskoc));
    const qs = params.toString();
    const data = await request<{ entries: AuditEntry[] }>(`/api/audit${qs ? `?${qs}` : ""}`);
    return data.entries;
  },

  // Události z tabletů. Vrací se v obálce jako analytika: dashboard nesmí
  // spadnout jen proto, že složka s událostmi ještě neexistuje.
  async udalosti(
    filtr: { dny?: number; displej?: number } = {},
  ): Promise<Analytika<PrehledUdalosti>> {
    const params = new URLSearchParams();
    if (filtr.dny !== undefined) params.set("dny", String(filtr.dny));
    if (filtr.displej !== undefined) params.set("displej", String(filtr.displej));
    const qs = params.toString();
    try {
      return {
        dostupne: true,
        data: await request<PrehledUdalosti>(`/api/udalosti/prehled${qs ? `?${qs}` : ""}`),
      };
    } catch (e) {
      return {
        dostupne: false,
        duvod: e instanceof Error ? e.message : "Události se nepodařilo načíst.",
      };
    }
  },

  // Displej u deštného pralesa: uložené nastavení, náhled toho, co zrovna
  // dostávají tablety, a stav stahování venkovní teploty.
  async prales(): Promise<PralesStav> {
    return request<PralesStav>("/api/prales/nastaveni");
  },

  // Uloží nastavení a vrátí rovnou nový stav (stejný tvar jako `prales()`),
  // takže se stránka nemusí ptát podruhé.
  async savePrales(nastaveni: PralesNastaveni): Promise<PralesStav> {
    return request<PralesStav>("/api/prales/nastaveni", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nastaveni),
    });
  },

  // Díry v zemi: co teď leží ve složkách obou prvků.
  async diry(): Promise<DiraStav[]> {
    const d = await request<{ diry: DiraStav[] }>("/api/diry");
    return d.diry;
  },

  // Nahrání nebo výměna videa díry. Stejně jako u videa na slidu jde přes XHR
  // kvůli procentům a možnosti zrušit; soubor má běžně stovky MB.
  async uploadDiraVideo(
    id: string,
    file: File,
    opts: { onProgress?: (procenta: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ stav: DiraStav }> {
    const form = new FormData();
    form.append("file", file);
    return xhrUpload<{ ok: boolean; stav: DiraStav }>(`/api/diry/${id}/video`, form, opts);
  },

  // Instalace videomappingu i s tím, co jsme jim naposledy poslali.
  async videomapping(): Promise<VideomappingInstalace[]> {
    const d = await request<{ instalace: VideomappingInstalace[] }>("/api/videomapping");
    return d.instalace;
  },

  // Odešle OSC povel jedné instalaci. Vrácený čas je čas ODESLÁNÍ, ne
  // potvrzení: UDP doručení nepotvrzuje a CMS stav instalace nezná.
  // Chyba znamená, že se povel nepodařilo odeslat z naší strany.
  async videomappingPovel(
    id: string,
    povel: VideomappingPovel,
  ): Promise<{ odeslano: string }> {
    return request<{ ok: boolean; odeslano: string }>(`/api/videomapping/${id}/${povel}`, {
      method: "POST",
    });
  },

  // Souhrn dotazů na chatbota (KPI karty a intenzita heat mapy).
  // `since` je ISO čas začátku období; bez něj si backend drží vlastní
  // výchozí okno (24 h). Kolik toho opravdu vrátil, říká `since` v odpovědi —
  // dashboard ukazuje TU hodnotu, ne to, o co jsme požádali.
  async analyticsSummary(since?: string): Promise<Analytika<AnalyticsSummary>> {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    return analytika<AnalyticsSummary>(`/api/analytics/summary${qs}`);
  },

  // Jednotlivé dotazy. answered=false = co AI nezvládla.
  async analyticsQuestions(
    filtr: { since?: string; limit?: number; answered?: boolean } = {},
  ): Promise<Analytika<AnalyticsQuestions>> {
    const params = new URLSearchParams();
    if (filtr.since) params.set("since", filtr.since);
    if (filtr.limit !== undefined) params.set("limit", String(filtr.limit));
    if (filtr.answered !== undefined) params.set("answered", String(filtr.answered));
    const qs = params.toString();
    return analytika<AnalyticsQuestions>(`/api/analytics/questions${qs ? `?${qs}` : ""}`);
  },

  // --- Vyřešené dotazy na AI ---
  // Klíč počítá server z dotazu, prohlížeč ho jen posílá zpátky. Všechna tři
  // volání vracejí CELOU mapu vyřešených, takže se stav nemusí skládat
  // z odpovědi a lokálního stavu a nemůže se rozejít.

  async vyreseneDotazy(): Promise<Record<string, VyresenyDotaz>> {
    const r = await request<{ polozky: Record<string, VyresenyDotaz> }>("/api/kb-dotazy/vyresene");
    return r.polozky;
  },

  async oznacDotazVyreseny(
    klic: string,
    popis: { otazka: string; druh: string },
  ): Promise<Record<string, VyresenyDotaz>> {
    const r = await request<{ polozky: Record<string, VyresenyDotaz> }>(
      "/api/kb-dotazy/vyreseno",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ klic, ...popis }),
      },
    );
    return r.polozky;
  },

  async zrusDotazVyreseny(klic: string): Promise<Record<string, VyresenyDotaz>> {
    const r = await request<{ polozky: Record<string, VyresenyDotaz> }>(
      `/api/kb-dotazy/vyresene/${encodeURIComponent(klic)}`,
      { method: "DELETE" },
    );
    return r.polozky;
  },
};

// Upload s hlášením průběhu. Chybové stavy řeší stejně jako request():
// 401 pošle na přihlášení, 413 vysvětlí limit česky, jinak se použije
// hláška ze serveru.
function xhrUpload<T>(
  url: string,
  form: FormData,
  opts: { onProgress?: (procenta: number) => void; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((hotovo, selhalo) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      let telo: { chyba?: string } | null = null;
      try {
        telo = JSON.parse(xhr.responseText);
      } catch {
        // odpověď bez JSON, hlášku složíme níž
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        hotovo(telo as T);
        return;
      }
      if (xhr.status === 401) sessionVyprsela();
      if (xhr.status === 413) {
        selhalo(new Error(`Soubor je moc velký, maximum je ${NAHRAVANI_MAX_MB} MB.`));
        return;
      }
      selhalo(new Error(telo?.chyba || `Chyba ${xhr.status}`));
    };

    xhr.onerror = () => selhalo(new Error("Spojení se serverem selhalo."));
    xhr.onabort = () => selhalo(new DOMException("Nahrávání zrušeno.", "AbortError"));

    if (opts.signal) {
      if (opts.signal.aborted) {
        selhalo(new DOMException("Nahrávání zrušeno.", "AbortError"));
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

// Analytika chatbota se nikdy nevrací jako výjimka: náš server posílá obálku
// { dostupne } i když Danielův backend neběží, a když selže i naše strana
// (nebo síť), udělá se obálka tady. Dashboard tak vždycky jen vypíše hlášku.
async function analytika<T>(url: string): Promise<Analytika<T>> {
  try {
    return await request<Analytika<T>>(url);
  } catch (e) {
    return {
      dostupne: false,
      duvod: e instanceof Error ? e.message : "Analytiku se nepodařilo načíst.",
    };
  }
}

// Z URL fotky (/data/.../soubor.jpg) vytáhne čistý název souboru.
export function nazevSouboru(url: string): string {
  const last = url.split("/").pop() ?? url;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// Formátování českého data a času.
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
}
