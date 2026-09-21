# Amphibiárium · Vzdálený přístup

CMS pro správu obsahu displejů pavilonu Amphibiárium, ZOO Ostrava.
Obsah nahraný přes web **nebo** přetažený do složky na disku se reálně uloží do
struktury složek a zobrazí v náhledu tabletu.

## Stack

- **/server**. Fastify + TypeScript, reálné file I/O nad `/data`, žádná databáze.
  V produkčním (demo) režimu servíruje i buildnutý web, takže běží **jeden proces**.
- **/web**. React + Vite + TypeScript + Tailwind + Lucide + React Router.
- **/data**, reálný datový root se složkami displejů.

## Spuštění lokálně (demo režim, jeden proces)

```bash
npm install        # nainstaluje server i web (npm workspaces)
npm run seed       # vygeneruje 37 displejů do složky data/
npm run build      # buildne web do web/dist
npm run start      # spustí Fastify, který servíruje API i web
```

Pak otevři **http://127.0.0.1:3000**

Přihlášení po instalaci: **`spravce` / `Amphibiarium2026`** (účet zakládá `npm run seed`).
Heslo hned změň, viz níž.

> Pořadí je důležité: nejdřív `seed` (vytvoří data), pak `build` (vytvoří web/dist),
> pak `start`. `start` čte buildnutý web z `web/dist`.

## Účty a přihlášení

Účty kurátorů jsou v **`data/users.json`**, heslo vždy jen jako **bcrypt hash**
(nikdy v otevřené podobě). Žádná databáze, stejně jako u obsahu.

```bash
npm run useradd -- jmeno heslo                  # nový účet (heslo min. 8 znaků)
npm run useradd -- jmeno noveheslo --zmenit-heslo   # změna hesla
npm run useradd -- --smazat jmeno               # zrušení účtu
npm run userlist                                # výpis účtů
```

- Přihlášení drží **podepsaná cookie** (`httpOnly`), platnost **12 hodin**
  (přepíše se přes `SESSION_TTL_HOURS`).
- Podpisový klíč je v `data/session.key` (vyrobí se sám při prvním spuštění),
  nebo se dá zadat přes `SESSION_SECRET`.
- `data/users.json` ani `data/session.key` **nepatří do gitu** (jsou v `.gitignore`)
  a neservírují se přes HTTP.
- Neúspěšné pokusy o přihlášení se zapisují do audit logu i s IP adresou.

**Co je chráněné a co veřejné:**

| | |
|---|---|
| **Veřejné** (bez přihlášení) | `/tablet/:id`, `GET /api/displays/:id`, `GET /api/prales`, soubory `/data/displeje/...`, `/api/login`, `/api/logout`, `/api/me` |
| **Chráněné** (401 bez session) | všechny zápisy a mazání, `GET /api/displays`, `GET /api/audit`, `GET /api/kb-template` |

Veřejné je záměrně přesně to, co potřebuje tablet u expozice. Nový endpoint je
chráněný automaticky, dokud se vědomě nepřidá do seznamu `VEREJNE_API`
v `server/src/index.ts`.

## Konfigurace přes prostředí (`.env.example`)

Server čte **proměnné prostředí** (soubor `.env` se sám nenačítá). Přehled a
šablona jsou v **`.env.example`**, zkopíruj na `.env` a hodnoty nastav ve své
službě/shellu. `.env` je v `.gitignore`, `.env.example` zůstává v gitu.

Nejdůležitější je **`SESSION_SECRET`**, klíč pro podpis session cookie:

- Když je nastavený (aspoň 16 znaků, doporučeno 64: `openssl rand -hex 32`),
  použije se a soubor `data/session.key` se **vůbec nezakládá**. Na produkci to
  je preferovaný způsob, ať klíč neleží v datové složce sdílené s Unity/chatbotem.
- Když nastavený **není**, server hlásí varování a spadne zpět na
  `data/session.key` (vytvoří ho sám). Server běží dál.
- Když je nastavený, ale **kratší než 16 znaků**, server **záměrně nenastartuje**
  s jasnou hláškou, slabý klíč by šel podvrhnout.

Platnost přihlášení řídí `SESSION_TTL_HOURS` (výchozí 12), **strop je 12 hodin**
i při vyšší hodnotě. Cookie zůstává `httpOnly`, `SameSite=Lax` a **bez `Secure`**
(provoz běží po HTTP v LAN pavilonu).

### Vývojový režim (volitelné, dva procesy s hot-reloadem)

```bash
npm run dev        # server na :3000 + Vite na :5173 (proxy /api a /data)
```

V dev režimu otevři **http://127.0.0.1:5173**.

## Kde je složka /data (sem přetahuj soubory)

```
/Users/tomasadamcik/JENOVA/zoo-cms/data
```

Struktura (přesně takhle, kvůli budoucí Unity integraci):

```
data/displeje/<cislo>/meta.json                 {"druh","stav","posledniZmena","slidy"}
data/displeje/<cislo>/kb.md                     znalostní báze chatbota (není slide)
data/displeje/<cislo>/cs/<n>_info/text.txt      Infopanel: řádky "Klic: Hodnota" + fotky, mapa.png, volitelné mp4
data/displeje/<cislo>/cs/<n>_ai/                AI otázky (prázdná složka)
data/displeje/<cislo>/cs/<n>_3d/001.png…        3D model: sekvence snímků (i varianta <n>_mod)
data/displeje/<cislo>/cs/<n>_vid/01.jpg, 02.mp4… Galerie: fotky i videa, číslovaná s vodící nulou
data/displeje/<cislo>/cs/<n>_gal/text.txt       Informace: "ObecnyText:", "Zajimavosti:", "Taxonomie:" + jedna fotka
data/displeje/<cislo>/cs/<n>_txt/text.txt       Obecné informace (pozůstalý typ, nový nejde založit)
data/prales.json                                nastavení displeje u deštného pralesa (není slide)
data/audit.jsonl                                append-only audit log
data/users.json                                 účty kurátorů (bcrypt hashe hesel)
data/session.key                                klíč pro podpis session cookie
```

> `users.json`, `session.key` ani `audit.jsonl` se neservírují přes HTTP,
> přes `/data/` jde ven jen složka `displeje`.

Typ slidu je **suffix** názvu složky (`_info`, `_ai`, `_3d` i `_mod`, `_vid`, `_gal`, `_txt`),
pořadí **číselný prefix**. Přehled drží i pole `slidy` v `meta.json`, zdrojem pravdy
jsou ale složky na disku. Soubor ručně přetažený do složky slidu se objeví v CMS
i na tabletu. Podrobně v `docs/provoz-a-udrzba.md`, kapitoly 5 až 7.

> **Pozor na dva suffixy, jejichž název neodpovídá obsahu.** Zůstaly kvůli tomu,
> že je tak čte Unity: **`_gal` není galerie**, ale textový slide (dva texty,
> zařazení druhu a jedna fotka), a **`_vid` není jen video**, ale galerie fotek
> i videí dohromady. Položky galerie se ukládají sekvenčně s vodící nulou
> (`01.jpg`, `02.mp4`, `03.png`), protože je Unity řadí abecedně; po přidání
> i smazání se celá řada přečísluje, aby měly všechny stejný počet cifer.

**Těžká média jsou vždycky jen v `cs/`.** Fotky, videa i 3D sekvence se ukládají
výhradně do české složky, Unity si je odtud „vypůjčí" i pro `en` a `pl`. Ve
složkách `en/` a `pl/` je jen `text.txt` s překladem. CMS média do překladů
nekopíruje.

## Dva toky, které lze předvést

**(a) Úprava ve webu zapíše na disk a projeví se na tabletu**
1. Otevři displej (např. #1 Axolotl), uprav text/nadpis, klikni **Uložit**.
2. Soubor `data/displeje/1/cs/1_info/text.txt` se reálně přepíše.
3. Otevři **Náhled tabletu** (tlačítko v detailu, nebo `/tablet/1`), zobrazí novou verzi.

**(b) Ruční přetažení souboru do složky se objeví na tabletu**
1. Přetáhni obrázek do `data/displeje/1/cs/1_info/`.
2. V náhledu tabletu klikni na ikonu **obnovit** (vpravo nahoře), fotka se objeví.

> Tablet i CMS čtou stejné API nad stejnými soubory, takže obojí je vždy v souladu.

## API endpointy

| Metoda | Cesta | Popis |
|--------|-------|-------|
| POST | `/api/login` | přihlášení proti `data/users.json` (bcrypt), podepsaná session cookie, audit |
| GET | `/api/displays` | seznam displejů |
| GET | `/api/displays/:id` | meta + slidy displeje |
| PUT | `/api/displays/:id/slides/:n` | zápis polí info panelu (audit „úprava info panelu“) |
| PUT | `/api/displays/:id/slides/:n/text` | texty a zařazení druhu (slide `_gal`; taxonomii skládá server) |
| PUT | `/api/displays/:id/slides/:n/txt` | oba texty obecných informací (slide `_txt`, audit „úprava obecných informací“) |
| POST | `/api/displays/:id/slides/:n/image` | multipart upload fotky (audit „upload“) |
| DELETE | `/api/displays/:id/slides/:n/images/:nazev` | smazání jedné fotky, v galerii i videa |
| POST | `/api/displays/:id/slides/:n/video` | multipart upload videa (mp4); v galerii přibude jako další položka |
| DELETE | `/api/displays/:id/slides/:n/video` | smazání videa info panelu (galerie se maže po položkách) |
| POST | `/api/displays/:id/slides` | přidání nového slidu |
| DELETE | `/api/displays/:id/slides/:n` | odebrání slidu |
| PUT | `/api/displays/:id/slides/reorder` | změna pořadí slidů (`{poradi:[...]}`) |
| POST | `/api/displays/:id/refresh` | mock odeslání na displej (audit) |
| GET | `/api/videomapping` | instalace videomappingu a co jsme jim naposledy poslali |
| POST | `/api/videomapping/:id/:povel` | OSC povel instalaci (`start`/`stop`), audit; 502 když se nepodaří odeslat |
| GET | `/api/audit` | audit log |
| GET | `/api/analytics/questions` | dotazy návštěvníků z chatbota (proxy, `since`/`limit`/`answered`) |
| GET | `/api/analytics/summary` | souhrn dotazů z chatbota (proxy, `since`) |
| GET | `/api/prales` | **veřejný**, data pro displej u deštného pralesa (čte Unity každých 5 s) |
| GET | `/api/prales/nastaveni` | nastavení pralesa + náhled odpovědi + stav venkovní teploty |
| PUT | `/api/prales/nastaveni` | uložení nastavení pralesa (audit „úprava nastavení deštného pralesa") |
| GET | `/data/...` | servírování souborů (fotky, video) |

## Poznámky

- `data/audit.jsonl` je runtime artefakt (v `.gitignore`).
- Pro reset demo dat: `rm -rf data/displeje data/audit.jsonl && npm run seed`.
- Datový root lze přepsat proměnnou `DATA_ROOT`, port proměnnou `PORT`.
- **Displej u deštného pralesa** je samostatná věc pro jeden displej: místo
  obsahu druhu posílá prostředí pavilonu a odpočet do bouřky z videomappingu.
  Nastavuje se na stránce „Deštný prales", data drží `data/prales.json`,
  struktury `data/displeje` se to netýká. Venkovní teplota se stahuje
  z open-meteo.com (souřadnice v `POCASI_LAT` / `POCASI_LON`), nejvýš jednou za
  deset minut, s pádem zpět na poslední známou hodnotu a pak na zálohu od
  kurátora. Podrobně v `docs/provoz-a-udrzba.md`, kapitola 11.
- **Videomapping** (stránka „Videomapping") zapíná a vypíná dvě instalace
  v pavilonu OSC zprávou přes UDP (`/start`, `/stop`). Adresy jsou
  v proměnných `VIDEOMAPPING_*`, ne v kódu. **UDP doručení nepotvrzuje**,
  takže CMS hlásí jen „povel odeslán" a čas, nikdy „zapnuto"; skutečný stav
  instalace nezná. Podrobně v `docs/provoz-a-udrzba.md`, kapitola 12.
- Dashboard („Přehled provozu") čte dotazy návštěvníků z analytiky chatbota.
  Adresa se nastavuje proměnnou `ANALYTICS_URL` (default `http://127.0.0.1:8000`).
  Když backend neběží, dashboard to napíše a funguje dál, viz
  `docs/provoz-a-udrzba.md`, kapitola 10.
