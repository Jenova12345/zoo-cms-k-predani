// Analytika chatbota (Daniel), čtení dotazů návštěvníků pro dashboard.
//
// Kontrakt (závazný, od Daniela):
//   GET <ANALYTICS_URL>/analytics/questions?since=<ISO>&limit=<n>&answered=<bool>
//   GET <ANALYTICS_URL>/analytics/summary?since=<ISO>
// Bez autentizace, `since` volitelné (backend si drží default 24 h),
// `limit` default 500, max 2000.
//
// Adresa se nastavuje proměnnou ANALYTICS_URL (default http://127.0.0.1:8000,
// chatbot běží na stejném serveru). Timeout přes ANALYTICS_TIMEOUT_MS.
//
// Backend zatím nemusí běžet, takže se nedostupnost bere jako normální stav:
// nikdy se nevyhazuje výjimka, vrací se obálka { dostupne: false, duvod } a
// dashboard z ní napíše hlášku. Stejný přístup jako u reingestu, cizí služba
// nikdy neshodí naši.

const ANALYTICS_URL = (process.env.ANALYTICS_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");

const TIMEOUT_MS = (() => {
  const raw = Number(process.env.ANALYTICS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
})();

// Z kontraktu: limit default 500, max 2000.
export const LIMIT_DEFAULT = 500;
export const LIMIT_MAX = 2000;

// --- Tvar dat podle kontraktu ---

export interface AnalyticsQuestion {
  timestamp: string;
  session_id: string;
  display_id: number | null; // POZOR: může být null, párujeme primárně přes species_latin
  species_latin: string;
  species_name: string;
  user_message: string;
  answered: boolean;
  language: string;
  mode: string;
}

export interface AnalyticsQuestions {
  questions: AnalyticsQuestion[];
  total: number;
  since: string;
}

export interface AnalyticsSpecies {
  species_latin: string;
  species_name: string;
  display_id: number | null;
  count: number;
}

export interface AnalyticsSummary {
  since: string;
  total_questions: number;
  answered: number;
  unanswered: number;
  per_species: AnalyticsSpecies[];
}

// Obálka odpovědi pro frontend: buď data, nebo důvod, proč nejsou.
export type Analytika<T> = { dostupne: true; data: T } | { dostupne: false; duvod: string };

// --- Očištění odpovědi ---
// Backend je cizí a ještě se dolaďuje, takže se na tvar dat nespoléháme:
// chybějící pole nesmí shodit dashboard.

function text(v: unknown): string {
  if (typeof v === "string") return v;
  return v === null || v === undefined ? "" : String(v);
}

function cislo(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// display_id je podle kontraktu nullable; nesmyslné hodnoty bereme jako null.
function displayId(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pole(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function normalizujQuestions(raw: unknown): AnalyticsQuestions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const questions = pole(r.questions).map((item) => {
    const q = (item ?? {}) as Record<string, unknown>;
    return {
      timestamp: text(q.timestamp),
      session_id: text(q.session_id),
      display_id: displayId(q.display_id),
      species_latin: text(q.species_latin),
      species_name: text(q.species_name),
      user_message: text(q.user_message),
      answered: q.answered === true,
      language: text(q.language),
      mode: text(q.mode),
    };
  });
  return {
    questions,
    total: r.total === undefined ? questions.length : cislo(r.total),
    since: text(r.since),
  };
}

function normalizujSummary(raw: unknown): AnalyticsSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    since: text(r.since),
    total_questions: cislo(r.total_questions),
    answered: cislo(r.answered),
    unanswered: cislo(r.unanswered),
    per_species: pole(r.per_species).map((item) => {
      const s = (item ?? {}) as Record<string, unknown>;
      return {
        species_latin: text(s.species_latin),
        species_name: text(s.species_name),
        display_id: displayId(s.display_id),
        count: cislo(s.count),
      };
    }),
  };
}

// --- Volání ---

function duvodNedostupnosti(err: unknown): string {
  const jmeno = err instanceof Error ? err.name : "";
  if (jmeno === "TimeoutError") {
    return `Analytika chatbota neodpověděla do ${TIMEOUT_MS} ms (${ANALYTICS_URL}).`;
  }
  return `Analytika chatbota není dostupná na ${ANALYTICS_URL}.`;
}

async function zavolej<T>(
  cesta: string,
  params: URLSearchParams,
  normalizuj: (raw: unknown) => T,
): Promise<Analytika<T>> {
  const qs = params.toString();
  const url = `${ANALYTICS_URL}${cesta}${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[analytika] ${url} vrátilo HTTP ${res.status}`);
      return { dostupne: false, duvod: `Analytika chatbota odpověděla chybou HTTP ${res.status}.` };
    }
    return { dostupne: true, data: normalizuj(await res.json()) };
  } catch (err) {
    // Nedostupný nebo ještě nenasazený backend je očekávaný stav, ne pád.
    console.warn(`[analytika] ${url} selhalo: ${String(err)}`);
    return { dostupne: false, duvod: duvodNedostupnosti(err) };
  }
}

export interface QuestionsFiltr {
  since?: string; // ISO; když chybí, backend použije svůj default (24 h)
  limit?: number;
  answered?: boolean;
}

export async function ziskejQuestions(filtr: QuestionsFiltr = {}): Promise<Analytika<AnalyticsQuestions>> {
  const params = new URLSearchParams();
  if (filtr.since) params.set("since", filtr.since);
  const limit = filtr.limit === undefined ? LIMIT_DEFAULT : filtr.limit;
  params.set("limit", String(Math.min(Math.max(Math.trunc(limit), 1), LIMIT_MAX)));
  if (filtr.answered !== undefined) params.set("answered", String(filtr.answered));
  return zavolej("/analytics/questions", params, normalizujQuestions);
}

export async function ziskejSummary(since?: string): Promise<Analytika<AnalyticsSummary>> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  return zavolej("/analytics/summary", params, normalizujSummary);
}
