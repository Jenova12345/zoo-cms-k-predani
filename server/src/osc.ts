import dgram from "node:dgram";

// Odesílání OSC zpráv přes UDP.
//
// Firma od videomappingu poslouchá OSC na svých počítačích v pavilonu. Stačí
// poslat jednu zprávu bez argumentů (/start, /stop), zbytek si udělají sami.
//
// Knihovnu kvůli tomu netaháme: zpráva bez argumentů má dvanáct bajtů a celé
// kódování jsou dvě pravidla, viz `oscString` níž. Node umí UDP přes `dgram`.
//
// FORMÁT (OSC 1.0):
//   [adresa jako OSC string][typový řetězec "," jako OSC string]
//
// OSC string = bajty textu + aspoň jedna nula + doplnění nulami na násobek
// čtyř. Pro /start to je:
//
//   2f 73 74 61 72 74 00 00   "/start" + 2 nuly (6+1 zaokrouhleno na 8)
//   2c 00 00 00               ","      + 3 nuly (1+1 zaokrouhleno na 4)
//
// Typový řetězec je i u zprávy bez argumentů POVINNÝ (samotná čárka). Některé
// přijímače zprávu bez něj zahodí, proto se posílá vždycky.

// Adresa musí začínat lomítkem a nesmí obsahovat znaky, které si OSC rezervuje
// pro vzory (# * , ? [ ] { }), mezeru ani nic mimo tisknutelné ASCII. Sami
// posíláme jen /start a /stop, kontrola je pojistka proti překlepu
// v konfiguraci nebo v budoucím volajícím.
const ADRESA_RE = /^\/[\x21-\x7e]*$/;
const ZAKAZANE_ZNAKY = /[#*,?[\]{}]/;

export function jePlatnaOscAdresa(adresa: string): boolean {
  return ADRESA_RE.test(adresa) && !ZAKAZANE_ZNAKY.test(adresa);
}

// Text + nulové zakončení, doplněné nulami na násobek čtyř. Buffer.alloc
// nuluje sám, takže se doplňuje jen tím, že se alokuje rovnou celá délka.
function oscString(text: string): Buffer {
  const bajty = Buffer.from(text, "ascii");
  // +1 je povinná koncová nula; když délka vyjde na násobek čtyř, přidají se
  // čtyři nuly, ne žádná (proto ceil nad (délka + 1), ne nad délkou).
  const delka = 4 * Math.ceil((bajty.length + 1) / 4);
  const out = Buffer.alloc(delka);
  bajty.copy(out);
  return out;
}

// Celá OSC zpráva bez argumentů.
export function oscZprava(adresa: string): Buffer {
  if (!jePlatnaOscAdresa(adresa)) {
    throw new Error(`Neplatná OSC adresa: ${adresa}`);
  }
  return Buffer.concat([oscString(adresa), oscString(",")]);
}

// Kolik milisekund se čeká, než se odeslání prohlásí za neúspěšné. Samotný
// zápis do socketu je okamžitý; timeout je pojistka pro případ, že by v
// konfiguraci bylo jméno místo IP a zaseklo se překládání DNS.
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.OSC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3000;
})();

// Odešle jeden UDP datagram.
//
// POZOR NA VÝZNAM ÚSPĚCHU: UDP je jednosměrné a nepotvrzuje se. Úspěch tady
// znamená jen to, že se datagram povedlo předat operačnímu systému. NEznamená
// to, že dorazil, že ho někdo přečetl, ani že instalace zareagovala. Chyba
// naopak znamená, že selhala NAŠE strana (neplatná adresa, síť je dole,
// socket se nepodařilo otevřít). Podle toho musí mluvit i CMS.
export async function posliUdp(host: string, port: number, data: Buffer): Promise<void> {
  return new Promise((hotovo, selhalo) => {
    let dokonceno = false;
    const socket = dgram.createSocket("udp4");

    const casovac = setTimeout(() => {
      konec(new Error(`Odeslání na ${host}:${port} se nedokončilo do ${TIMEOUT_MS} ms.`));
    }, TIMEOUT_MS);

    // Jedna cesta ven pro všechny konce (chyba socketu, chyba send, timeout),
    // ať se socket zavře právě jednou a promise se nevyřeší dvakrát.
    function konec(err?: Error) {
      if (dokonceno) return;
      dokonceno = true;
      clearTimeout(casovac);
      try {
        socket.close();
      } catch {
        // socket už mohl být zavřený, na výsledku to nic nemění
      }
      if (err) selhalo(err);
      else hotovo();
    }

    socket.on("error", (err) => konec(err));
    socket.send(data, port, host, (err) => konec(err ?? undefined));
  });
}
