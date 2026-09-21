// Reingest signál pro chatbota (Daniel). Po uložení kb.md nebo meta.json (a
// faktů v text.txt) dá CMS chatbotu vědět, že se má obsah displeje znovu načíst.
//
// ZATÍM VYPNUTO. Dokud se sync s Danielem nedomluví, běží to na sucho: nikam se
// nevolá, jen se zaloguje, že by se reingest poslal. Zapíná se konfigurací:
//   REINGEST_ENABLED=true
//   REINGEST_URL=https://chatbot.example/reingest
//   REINGEST_TOKEN=<tajný token do hlavičky X-Reingest-Token>
//
// Selhání volání nikdy neshodí ani neblokuje uložení obsahu.

const ENABLED = process.env.REINGEST_ENABLED === "true";
const URL = process.env.REINGEST_URL ?? "";
const TOKEN = process.env.REINGEST_TOKEN ?? "";

export interface ReingestPayload {
  displej: number; // číslo displeje
  soubor: string; // cesta k souboru relativně k datové složce, např. "displeje/1/kb.md"
}

// Fire-and-forget: voláme přes `void notifyReingest(...)`, uložení na nic nečeká.
export async function notifyReingest(id: string, relativniCesta: string): Promise<void> {
  const payload: ReingestPayload = { displej: Number(id), soubor: `displeje/${id}/${relativniCesta}` };

  if (!ENABLED || !URL) {
    console.log(
      `[reingest] VYPNUTO, poslal bych POST na '${URL || "(nenastavená URL)"}' ` +
        `s tělem ${JSON.stringify(payload)}`,
    );
    return;
  }

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Reingest-Token": TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`[reingest] odesláno pro displej ${id}, soubor ${relativniCesta} (HTTP ${res.status})`);
  } catch (err) {
    // Uložení už proběhlo, reingest je jen best-effort.
    console.warn(`[reingest] volání selhalo (uložení proběhlo v pořádku): ${String(err)}`);
  }
}
