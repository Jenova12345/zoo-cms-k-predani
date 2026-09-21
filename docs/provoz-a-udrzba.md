# Provoz a údržba. CMS Amphibiárium

Technická dokumentace k provozu CMS pavilonu Amphibiárium (ZOO Ostrava).
Popisuje **skutečný stav kódu na větvi `dev`**, ne stav popsaný v `README.md`
(ten je v části API a struktury dat zastaralý, mluví ještě o `slide-1..6`,
`text.md` a endpointu pro pořadí fotek, který v kódu není).

Uživatelskou část najdete v [prirucka-zamestnanci.md](prirucka-zamestnanci.md).

---

## Obsah

1. [Architektura v kostce](#1-architektura-v-kostce)
2. [Spuštění](#2-spuštění)
3. [Proměnné prostředí](#3-proměnné-prostředí)
4. [Účty a přihlašování](#4-účty-a-přihlašování)
5. [Data na disku](#5-data-na-disku)
6. [Formáty souborů](#6-formáty-souborů)
7. [Struktura pro Unity](#7-struktura-pro-unity)
8. [Audit log](#8-audit-log)
9. [Reingest signál pro chatbota](#9-reingest-signál-pro-chatbota)
10. [Tep tabletů (heartbeat)](#10-tep-tabletů-heartbeat)
11. [Analytika návštěvnosti](#11-analytika-návštěvnosti)
12. [Analytika chatbota v dashboardu](#12-analytika-chatbota-v-dashboardu)
13. [Displej u deštného pralesa](#13-displej-u-deštného-pralesa)
14. [Videomapping](#14-videomapping)
15. [Díry v zemi](#15-díry-v-zemi)
16. [API a ochrana endpointů](#16-api-a-ochrana-endpointů)
17. [Údržbové skripty](#17-údržbové-skripty)
18. [Zálohování a obnova](#18-zálohování-a-obnova)
19. [Řešení potíží](#19-řešení-potíží)
20. [Známá omezení](#20-známá-omezení)

---

## 1. Architektura v kostce

| Část | Technologie | Poznámka |
|---|---|---|
| `server/` | Fastify 5 + TypeScript, běží přes `tsx` | Reálné file I/O nad datovou složkou. **Žádná databáze.** |
| `web/` | React 18 + Vite 6 + TypeScript + Tailwind | SPA, buildí se do `web/dist`. |
| datová složka | soubory a složky na disku | Zdroj pravdy pro CMS, tablet i Unity. |

V produkčním režimu běží **jeden proces**: Fastify servíruje API, statické
soubory displejů i buildnutý web.

Server se **nekompiluje**, `npm run start` spouští TypeScript přímo přes
`tsx`. Buildí se jen web. Vyžaduje Node.js 20 LTS nebo novější (ověřeno na
Node 26); `sharp` se instaluje jako předkompilovaná binárka pro danou platformu.

---

## 2. Spuštění

### Produkční (demo) režim, jeden proces

```bash
npm install     # nainstaluje server i web (npm workspaces)
npm run seed    # POZOR: přepíše data/displeje, jen při prvním rozjezdu
npm run build   # tsc + vite build → web/dist
npm run start   # Fastify: API + statická data + web
```

Pak otevřít **http://127.0.0.1:3000** (respektive `HOST:PORT`, viz níž).

Pořadí je podstatné: `start` čte buildnutý web z `web/dist`. Když složka
neexistuje, server nastartuje, ale do logu napíše varování a na `/` vrátí 404,
API i `/data/displeje/...` fungují dál.

> `npm run seed` maže a znovu generuje `data/displeje/<id>` pro všech 37 displejů.
> **Na ostrých datech ho nikdy nespouštějte.** Účtů v `users.json` se nedotýká.

### Vývojový režim, dva procesy s hot-reloadem

```bash
npm run dev     # Fastify (tsx watch) na :3000 + Vite na :5173
```

V dev režimu se pracuje na **http://127.0.0.1:5173**. Vite proxuje `/api`
a `/data` na `http://127.0.0.1:3000` (viz `web/vite.config.ts`), takže
`SESSION_TTL_HOURS`, `DATA_ROOT` a spol. platí stejně.

Jednotlivé části se dají spustit i zvlášť: `npm run dev:server`, `npm run dev:web`.

---

## 3. Proměnné prostředí

Všechny se čtou při startu procesu; konfigurační soubor systém nemá.

| Proměnná | Výchozí | Význam |
|---|---|---|
| `DATA_ROOT` | `<repo>/data` | Kořen datové složky. Cesta se převádí na absolutní (`path.resolve`). |
| `HOST` | `127.0.0.1` | Adresa, na které Fastify poslouchá. **Pro přístup z jiného počítače je potřeba `0.0.0.0`**, výchozí `127.0.0.1` pustí dovnitř jen lokální stroj. |
| `PORT` | `3000` | Port HTTP serveru. |
| `SESSION_SECRET` | není | Klíč pro podpis session cookie. Musí mít **aspoň 16 znaků**; kratší hodnota server **nenastartuje** (radši spadnout než tiše podepisovat slabým tajemstvím). Když proměnná není nastavená vůbec, sáhne se po `<DATA_ROOT>/session.key` a do logu jde varování. |
| `SESSION_TTL_HOURS` | `12` | Absolutní strop platnosti přihlášení v hodinách. Musí být kladné číslo, **a zároveň se shora zaráží na 12 h** (`MAX_TTL_HODIN`), takže delší hodnota session neprodlouží. Nezávisle na tom běží okno nečinnosti 60 min, viz [kapitola 4](#4-účty-a-přihlašování). |
| `REINGEST_ENABLED` | `false` | Řetězec `"true"` zapne odesílání reingest signálu chatbotovi. |
| `REINGEST_URL` |, | Cílová URL reingest webhooku. Bez ní se nic neodesílá ani při `REINGEST_ENABLED=true`. |
| `REINGEST_TOKEN` | prázdný | Posílá se v hlavičce `X-Reingest-Token`. |
| `ANALYTICS_URL` | `http://127.0.0.1:8000` | Adresa analytického backendu chatbota (Daniel). **Tohle je ta jedna proměnná, která se nastaví, až bude adresa známá.** Koncové lomítko se ořeže. |
| `ANALYTICS_TIMEOUT_MS` | `4000` | Kolik milisekund se čeká na odpověď analytiky. Neplatná nebo nekladná hodnota = výchozí. |
| `POCASI_LAT` | `49.8265` | Zeměpisná šířka pro venkovní teplotu (ZOO Ostrava), viz [kapitola 13](#13-displej-u-deštného-pralesa). Neplatná hodnota = výchozí + varování v logu. |
| `POCASI_LON` | `18.3242` | Zeměpisná délka pro venkovní teplotu. |
| `POCASI_TIMEOUT_MS` | `5000` | Kolik milisekund se čeká na open-meteo.com. Stahuje se na pozadí, takže timeout nezdrží odpověď tabletům. |
| `VIDEOMAPPING_WATERSENSE_HOST` | `10.10.10.51` | Adresa počítače instalace WaterSense, viz [kapitola 14](#14-videomapping). Neplatná hodnota = výchozí + varování v logu. |
| `VIDEOMAPPING_WATERSENSE_PORT` | `7000` | Port, na kterém WaterSense poslouchá OSC. |
| `VIDEOMAPPING_LES_HOST` | `10.10.10.52` | Adresa počítače instalace Les. |
| `VIDEOMAPPING_LES_PORT` | `7000` | Port, na kterém Les poslouchá OSC. |
| `OSC_TIMEOUT_MS` | `3000` | Strop pro dokončení odeslání UDP datagramu. Pojistka pro zaseknutý překlad DNS, zápis do socketu je jinak okamžitý. |

Příklad nasazení na síť s daty mimo repozitář:

```bash
DATA_ROOT=/srv/amphibiarium/data \
HOST=0.0.0.0 \
PORT=3000 \
SESSION_SECRET="$(openssl rand -hex 32)" \
SESSION_TTL_HOURS=12 \
npm run start
```

**Pozor na dvě věci:**

- `DATA_ROOT` platí i pro CLI skripty (`useradd`, `userlist`, `seed`, `migrate`,
  `backfill`). Když se účet zakládá bez `DATA_ROOT`, zapíše se do `<repo>/data`
  a server běžící nad jinou složkou o něm nebude vědět. Skripty proto vždycky
  vypisují, se kterou datovou složkou pracují.
- `DATA_ROOT` **neovlivňuje** umístění buildnutého webu. `web/dist` se hledá
  vždy relativně k repozitáři.

---

## 4. Účty a přihlašování

### Správa účtů z příkazové řádky

```bash
npm run useradd -- <jmeno> <heslo>                  # nový účet
npm run useradd -- <jmeno> <heslo> --zmenit-heslo   # změna hesla
npm run useradd -- --smazat <jmeno>                 # zrušení účtu
npm run userlist                                    # výpis účtů
npm run useradd -- --help                           # nápověda
```

Pravidla, která vynucuje `server/src/users.ts`:

- **Jméno:** 2 až 32 znaků, povolena písmena (včetně diakritiky), číslice, tečka,
  pomlčka a podtržítko. Porovnává se **bez ohledu na velikost písmen**
  (`Spravce` == `spravce`), ukládá se ale ve tvaru, jak ho zadal správce.
- **Heslo:** minimálně 8 znaků. Neořezává se, mezera na kraji je jeho součástí
  (stejně při zakládání i při přihlášení).
- **Poslední účet nejde smazat**, systém by se stal nepřístupným.
- Heslo se ukládá výhradně jako **bcrypt hash (cost 12)**, nikdy otevřeně.

> Heslo zadané na příkazové řádce zůstává v historii shellu a v seznamu
> procesů. Po založení účtu je vhodné historii vyčistit.

### Výchozí účet

`npm run seed` založí účet `spravce` / `Amphibiarium2026`, ale **jen když je
`users.json` prázdný nebo neexistuje**. Existující účty se nikdy nepřepisují.
Po prvním přihlášení heslo změňte:

```bash
npm run useradd -- spravce <noveheslo> --zmenit-heslo
```

Když v `users.json` není žádný účet, server při startu zapíše varování do logu
a do CMS se nedá přihlásit.

### Reset zapomenutého hesla

Hesla se ukládají jako bcrypt hash, **původní heslo se tedy zjistit nedá** ani
ze souboru, ani z logu. Zapomenuté heslo se neobnovuje, nastavuje se nové —
z konzole na serveru, pod účtem, který má přístup k `DATA_ROOT`:

```bash
npm run userlist                                     # jak se účet přesně jmenuje
npm run useradd -- <jmeno> <noveheslo> --zmenit-heslo
```

Když se `--zmenit-heslo` vynechá, skript existující účet **nepřepíše**, skončí
chybou „účet už existuje". Je to pojistka proti přepsání cizího účtu překlepem.

Na co dát pozor:

- **`DATA_ROOT` musí sedět s tím, nad kterým běží server.** Skript vypisuje,
  se kterou datovou složkou pracuje; když se liší, heslo se změní v jiném
  souboru a přihlášení dál nepůjde. Na produkčním Windows serveru je to
  typicky `DATA_ROOT=C:\ZZ_CMS_Data`.
- **Změna hesla okamžitě odhlásí všechny relace toho účtu** (serial `v`
  v session cookie, viz níž). U sdíleného účtu ZOO to znamená, že se odhlásí
  všichni, kdo pod ním zrovna pracují — rozepsané neuložené změny se ztratí.
  Dělejte to proto mimo provoz, nebo o tom dejte vědět dopředu.
- Heslo musí mít **aspoň 8 znaků** a neořezává se, mezera na kraji je jeho
  součástí.
- Heslo zadané na příkazové řádce **zůstává v historii shellu** a v seznamu
  procesů. Po resetu historii vyčistěte (`history -c`, resp. smazat řádek
  v `~/.zsh_history`), nebo příkaz napište s mezerou na začátku.
- Server **není potřeba restartovat**, `users.json` se čte při každém
  přihlášení.

Když se ztratí přístup ke všem účtům najednou, zakládá se nový:

```bash
npm run useradd -- spravce2 <heslo>      # přidá další účet, stávající nechá být
```

Poslední účet nejde smazat, takže systém nemůže zůstat bez přístupu.

### Výběr jména po přihlášení

ZOO jede na **jednom sdíleném účtu** (login + heslo zná celý pavilon), ale
sedí pod ním víc lidí. Samotný účet by v auditu neřekl, kdo co udělal, takže
přihlášení má **dva kroky**: účet a pak výběr jména ze seznamu.

- Seznam je v **`<DATA_ROOT>/jmena.json`** (`server/src/jmena.ts`), schválně
  mimo `users.json`: ten má jiný životní cyklus (bcrypt hashe, práva 0600,
  pojistka proti úbytku účtů) a jména nejsou účty. Míchat obojí by znamenalo,
  že běžný kurátor zapisuje do souboru s hesly.

  ```json
  {
    "verze": 1,
    "jmena": [
      { "jmeno": "Franta", "pridano": "2026-09-18T07:12:04.918Z", "pridalUcet": "zoo" }
    ]
  }
  ```

- **Jméno smí mít 1 až 40 znaků**: písmena (s diakritikou), číslice, mezera,
  tečka, pomlčka, apostrof. Řídicí znaky a lomítka ne — v auditu se vypisuje
  jako „účet / jméno" a lomítko by tam mátlo. Porovnává se bez ohledu na
  velikost písmen a okolní mezery, takže v seznamu neskončí „Franta"
  i „franta " jako dvě položky.
- **Seznam smí číst i měnit kdokoli přihlášený**, i před výběrem jména —
  jinak by se nově příchozí nedostal dovnitř, protože jeho jméno v seznamu
  ještě není. Zvláštní admin role v CMS neexistuje.
- Smazání jména ze seznamu **nepřepisuje historii** (audit je append-only)
  a nikoho nevyhazuje ven; kdo pod tím jménem pracuje, dopracuje.
- Server přijme jen jméno, které v seznamu **je**, a zapíše do cookie jeho
  podobu ze seznamu (klient pošle „franta", v auditu stojí „Franta").
- Jméno se **nepamatuje mezi přihlášeními**. Kdyby se pamatovalo, podepsalo
  by kolegu, který si k počítači sedne po předchozím.
- Dokud jméno vybrané není, vrací chráněné endpointy
  `403 {"chyba":"Nejdřív vyberte jméno.","kod":"jmeno"}` — schválně 403, ne
  401, aby klient uživatele poslal jen o krok zpět na výběr jména, ne na
  přihlášení. Výjimkou je množina `BEZ_JMENA`, viz
  [kapitola 16](#16-api-a-ochrana-endpointů).
- Do auditu se jméno zapisuje jako samostatné pole `jmeno` vedle účtu, viz
  [kapitola 8](#8-audit-log).

### Jak funguje session

- Po úspěšném přihlášení se nastaví cookie **`amph_session`**: `httpOnly`,
  `sameSite=lax`, **podepsaná** (HMAC přes `@fastify/cookie`), `maxAge` podle
  `SESSION_TTL_HOURS`.
- Obsah cookie je base64url JSON se čtyřmi až pěti klíči:

  | Klíč | Význam |
  |---|---|
  | `u` | přihlašovací účet |
  | `j` | **vybrané jméno člověka** (chybí, dokud si ho uživatel nevybral) |
  | `exp` | absolutní vypršení session |
  | `akt` | čas poslední interakce člověka, z něj se počítá okno nečinnosti |
  | `v` | serial účtu (`zmeneno` nebo `vytvoreno` z `users.json`) |

  Platnost se ověřuje **na serveru**, ne jen přes `maxAge` v prohlížeči.
  Podvržená, vypršelá i cookie bez `v` (vydaná starší verzí) se bere jako
  nepřihlášený uživatel.
- **Vybrané jméno je schválně uvnitř podepsané cookie.** V `localStorage` by
  si ho kdokoli přepsal v devtools na cizí a audit by ztratil smysl; v mapě
  v paměti serveru by se ztratilo při restartu a odhlásilo by všechny
  uprostřed práce.
- **Změna hesla zneplatní všechny session daného účtu.** Serial `v` se bere
  z `zmeneno`/`vytvoreno` v `users.json`, takže po `--zmenit-heslo` se cookie
  vydané před změnou přestanou uznávat.
- Podpisový klíč: `SESSION_SECRET` (≥ 16 znaků), jinak `<DATA_ROOT>/session.key`.
  Soubor se při prvním startu vygeneruje (32 náhodných bajtů, práva `0600`) a
  díky němu přežije přihlášení restart serveru. **Smazání `session.key` odhlásí
  všechny.**
- Neúspěšné přihlášení vrací jednu společnou hlášku (nejde poznat, jestli
  selhalo jméno, nebo heslo) a zapisuje se do audit logu **včetně IP adresy**.
  Neexistující jméno se porovnává proti slepému hashi, aby doba odpovědi
  neprozradila existenci účtu.
- **Rate limit na přihlašování: 5 pokusů za 15 minut** na kombinaci IP +
  přihlašovací jméno (`@fastify/rate-limit`). Šestý pokus dostane `429`
  s hláškou „Příliš mnoho pokusů o přihlášení, zkuste to za pár minut.".
  Je to brzda proti hádání hesel i proti DoS — bcrypt blokuje event loop,
  takže by se dal server zahltit samotnými pokusy. **Limit je jen na
  `/api/login`, ne globálně**: tablety pollují veřejné čtení a globální limit
  by je odstřihl.
- Cookie **nemá příznak `secure`**, funguje tedy i na čistém HTTP v pavilonové
  síti. Při vystavení do internetu patří server za reverzní proxy s HTTPS.

#### Okno nečinnosti (60 minut)

Kromě absolutního stropu (`SESSION_TTL_HOURS`, nejvýš 12 h) běží druhý,
kratší limit: **60 minut od poslední interakce člověka** (`NECINNOST_MS`
v `server/src/session.ts`). Sdílený účet znamená, že u počítače může sedět
někdo jiný, než kdo se přihlásil; po hodině bez dotyku proto session padá,
ať audit nepíše jméno člověka, který odešel před třemi hodinami.

- Okno posouvá **výhradně `POST /api/session/tep`** s tělem `{aktivita: true}`,
  které web pošle, jen když od minula proběhl klik, klávesa, kolečko nebo
  dotyk. Ostatní požadavky okno pouze kontrolují. Kdyby ho posouval každý
  požadavek, vlastní pollery CMS (deštný prales po 5 s, dashboard po minutě)
  by otevřenou záložku držely přihlášenou donekonečna.
- Web se na tep ptá i při nečinnosti (bez `aktivita`), aby se dozvěděl
  `zbyvaMs` a **minutu předem upozornil** na blížící se odhlášení.
- Cookie se přepodepisuje nejvýš jednou za minutu (`TEP_THROTTLE_MS`), okno je
  tím přesné na minutu a nevzniká `Set-Cookie` na každý tep.
- `maxAge` cookie je schválně o dvě minuty delší než okno (`COOKIE_REZERVA_S`).
  Kdyby obojí končilo naráz, prohlížeč by cookie zahodil dřív, než se server
  stihne vyjádřit, a místo „odhlášeno pro nečinnost" by uživatel dostal holé
  „přihlaste se" a v auditu by po něm nezůstal záznam.
- Vypršení se zapisuje do auditu jako `odhlášení pro nečinnost` a odpověď je
  `401 {"chyba":"Odhlášeno po hodině nečinnosti.","kod":"necinnost"}`.

---

## 5. Data na disku

Vše je pod `DATA_ROOT` (výchozí `<repo>/data`):

```
<DATA_ROOT>/
  displeje/
    <n>/                        n = číslo displeje, jen číselné názvy
      meta.json                 metadata displeje
      kb.md                     znalostní báze pro chatbota (NENÍ slide)
      cs/                       čeština, povinná větev (média leží tady)
        1_info/                 Infopanel
          text.txt              pole "Klic: Hodnota"
          mapa.png              volitelná mapa výskytu (přesně tento název)
          foto-*.png            ostatní fotky info panelu
          foto-*.png.orig       originál před oříznutím, jen pro CMS
          .vyrezy.json          souřadnice výřezů, jen pro CMS
          <nazev>.mp4           volitelné video (řadí se před fotky)
        2_ai/                   prázdná složka = AI otázky
        3_3d/                   3D model (i varianta 3_mod)
          001.png, 002.png, …   sekvence snímků, číslovaná od 001
        4_gal/                  Informace (NE galerie!)
          text.txt              "ObecnyText:", "Zajimavosti:", "Taxonomie:"
          foto-*.png            jedna fotka (na zařízení vpravo)
        5_vid/                  GALERIE fotek i videí (NE jen video!)
          01.png, 02.mp4, …     jedna číslovaná řada, Unity ji řadí abecedně
        6_txt/                  Obecné informace (pozůstalý typ, nový nejde založit)
          text.txt              "ObecnyText: …" a "Zajimavosti: …"
      en/                       angličtina, jen text.txt (média se neduplikují)
      pl/                       polština, dtto
  udalosti/
    unity/                      události z tabletů, zapisuje je Unity
      <displej>/RRRR-MM-DD.jsonl
      RRRR-MM-DD.jsonl          starší plochá varianta, čte se taky
  analytika/
    RRRR-MM.json                předpočítané denní souhrny, jen zrychlení
  Cervori/<cokoli>.mp4          „díra v zemi" č. 1, viz kapitola 15
  Paleonaleziste/<cokoli>.mp4   „díra v zemi" č. 2
  audit.jsonl                   append-only audit log
  prales.json                   nastavení displeje u deštného pralesa
  jmena.json                    seznam jmen lidí u sdíleného účtu
  users.json                    účty kurátorů (bcrypt hashe), práva 0600
  session.key                   klíč pro podpis session cookie, práva 0600
```

**Jazykové větve.** Na disku jsou tři: `cs/`, `en/`, `pl/`. Struktura složek
slidů je v nich stejná, ale **média leží jen v `cs/`** — fotky, videa i 3D
sekvence jsou společné pro všechny jazyky a nahrávají se jednou. V `en/`
a `pl/` je tedy jen `text.txt`. Na infopanelu se navíc `Sekce` a `Latinsky`
berou z češtiny a v ostatních jazycích se needitují.

**Kolik displejů je vidět.** Na disku je složek **37** (`DISPLAY_COUNT`, tolik
jich zakládá `seed`), ale do přehledu se berou jen ty **do čísla 31**
(`POSLEDNI_DISPLEJ` v `server/src/paths.ts`) — tolik jich v pavilonu fyzicky
je. Složky 32 až 37 zbyly po generování dat, server je v `listDisplays()`
přeskakuje. `DISPLAY_COUNT` se schválně nesnižuje: kdyby se změnil, `seed` by
přestal zakládat složky, které na disku pořád jsou.

**Servírování přes HTTP** je zúžené na `displeje/`: `@fastify/static` má root
`<DATA_ROOT>/displeje` a prefix `/data/displeje/`. `users.json`, `session.key`,
`jmena.json`, `audit.jsonl`, `udalosti/` ani `analytika/` proto přes `/data/...`
stáhnout nejdou.

Uvnitř `displeje/` se servíruje všechno včetně `*.png.orig` a `.vyrezy.json`.
Tyhle dva soubory jsou pomocné (viz [kapitola 6](#6-formáty-souborů)), pro
Unity jsou neviditelné, protože se řídí přesnou příponou, ale kdo zná cestu,
stáhne si je. Nic citlivého v nich není.

`audit.jsonl`, `users.json`, `jmena.json`, `session.key`, `udalosti/`
a `analytika/` jsou v `.gitignore`, do repozitáře nepatří.

### Ruční zásah do složek

Soubor přetažený přímo do složky slidu se objeví v CMS i na tabletu bez
restartu. API čte disk při každém požadavku. Musí ale splňovat konvenci:
fotky `.png` (jiné přípony se ignorují; v galerii `_vid` se zobrazí i `.jpg`
nahrané starším CMS, nové se ukládají jako PNG), video `.mp4`, název složky
slidu `<číslo>_<typ>`.

Ručně přidaná fotka **nemá výřez ani originál** (`*.png.orig`), takže ji CMS
ukáže s odznakem „neoříznuto" a Unity si ji ořízne po svém. Stačí v editoru
jednou nastavit výřez, viz [kapitola 6](#6-formáty-souborů).

V galerii `_vid` navíc platí, že položky mají být číslované s vodící nulou
a **se stejným počtem cifer** (`01`, `02`, … nebo `001`, `002`, …). Ručně
přidaný soubor s jiným názvem se zobrazí, ale zařadí se až za očíslované;
srovná se sám, jakmile do slidu kurátor v CMS něco přidá nebo z něj smaže.

---

## 6. Formáty souborů

### `text.txt`, pole info panelu

Řádky ve tvaru `Klic: Hodnota`, kódování UTF-8. Zapisují se v pevném pořadí a
**prázdná pole se nezapisují vůbec**:

```
Sekce: Neotenie — původ moderních obojživelníků
Nazev: Axolotl mexický
Latinsky: Ambystoma mexicanum
Strava: vodní bezobratlí, larvy hmyzu, drobní korýši
Velikost: 25 až 30 cm
DobaLihnuti: 14 až 21 dní
Ohrozeni: kriticky ohrožený
DelkaZivota: 10 až 15 let
```

- Povolené klíče (jiné parser zahodí): `Sekce`, `Nazev`, `Latinsky`, `Strava`,
  `Velikost`, `DobaLihnuti`, `Ohrozeni`, `DelkaZivota`. Klíče jsou bez
  diakritiky a case-sensitive.
- **Povinné:** `Sekce` a `Nazev`. Validuje server i editor; `Sekce` musí být
  jedna z **jedenácti** hodnot podle oficiální tabule v pavilonu (definováno
  v `SEKCE_TEMATA` v `server/src/displays.ts` a v `web/src/lib/types.ts`,
  seznamy je nutné držet shodné):

  1. Červoři — záhadní obojživelníci
  2. Rozmanitost žab
  3. Pralesničky — jedovaté krásky
  4. Šesté vymírání
  5. Historie obojživelníků — přechod obratlovců z vody na souš
  6. Lezci — novodobí „obojživelníci"
  7. Madagaskar — žabí ráj
  8. Listovnice — královny noci
  9. Caudata — obojživelníci s ocasem
  10. Neotenie — původ moderních obojživelníků
  11. Obojživelníci České republiky

  Porovnává se **tolerantně k oddělovači**: čárka, em dash, en dash i
  spojovník jsou zaměnitelné, takže `Neotenie, původ moderních obojživelníků`
  i `Neotenie — původ moderních obojživelníků` projdou jako táž sekce. Do
  souboru se zapisuje kanonický tvar s em dashem. Krátké názvy z doby před
  srovnáním s tabulí (`Caudata`, `Neotenie`, …) dál projdou přes `SEKCE_STARE`.
- Parser toleruje CRLF i mezery kolem hodnoty; při zápisu se hodnoty ořezávají.
- `Latinsky` se před zápisem **kanonizuje** (`server/src/latin.ts`): pryč
  uvozovky a koncová tečka, kolaps mezer, první písmeno velké, zbytek malými.
  `dendrobates tinctorius "azureus".` → `Dendrobates tinctorius azureus`.
  API vrací `{ latin, latinCorrected }`, aby editor mohl na úpravu upozornit.

### `meta.json`

```json
{
  "druh": "Axolotl mexický",
  "stav": "online",
  "posledniZmena": "2026-07-08T09:11:15.267Z",
  "slidy": [
    { "slozka": "1_info", "typ": "info" },
    { "slozka": "2_ai",   "typ": "ai"   },
    { "slozka": "3_3d",   "typ": "3d"   },
    { "slozka": "4_gal",  "typ": "gal"  },
    { "slozka": "5_vid",  "typ": "vid"  },
    { "slozka": "6_txt",  "typ": "txt"  }
  ],
  "name": "Axolotl mexický",
  "latin_name": "Ambystoma mexicanum",
  "category": "Neotenie — původ moderních obojživelníků",
  "section": "Ambystomatidae"
}
```

| Pole | Význam |
|---|---|
| `druh` | Interní název pro přehled CMS. Hodnota `Nepřiřazeno` = prázdný displej. Při uložení info panelu se přepíše hodnotou `Nazev`. |
| `stav` | `online` / `offline`. **Zapisuje ho jen `seed` a `migrate`**, za běhu se neaktualizuje, není to živý monitoring. |
| `posledniZmena` | ISO datum, posouvá ho každá změna obsahu. |
| `slidy` | Doplňkový přehled složek. Přepisuje se podle skutečného stavu disku; Unity ho nepotřebuje. |
| `name` | = `Nazev`, identifikace pro chatbota. |
| `latin_name` | Kanonizované latinské jméno; chatbot podle něj páruje druh. |
| `category` | = `Sekce` (zóna expozice). |
| `section` | Taxonomická čeleď latinsky (např. `Dendrobatidae`). Existuje **jen v `meta.json`**, do `text.txt` se nezapisuje a na tabletu se nezobrazuje: je to identifikace pro chatbota. Zařazení druhu, které vidí návštěvník, je jinde, viz `Taxonomie:` u slidu `_gal`. |

Displej bez čitelného `meta.json` se v seznamu `GET /api/displays` vůbec
neobjeví, soubor je tedy povinný.

### `text.txt`, textový slide (slide `_gal`)

Pozor: **`_gal` není galerie.** Je to textový slide: dva dlouhé texty,
zařazení druhu a jedna fotka. Suffix zůstal, protože ho tak čte Unity.

```
ObecnyText: Axolotl mexický je ocasatý obojživelník, který si po celý život
zachovává larvální podobu včetně vnějších keříčkovitých žaber.
Zajimavosti: Dokáže regenerovat končetiny, ocas i části srdce.
Taxonomie: Třída: Obojživelníci | Řád: Mloci | Čeleď: Axolotlovití
```

- **Klíče jsou `ObecnyText`, `Zajimavosti` a `Taxonomie`**, bez diakritiky
  (ASCII) a case-sensitive. `ObecnyText` a `Zajimavosti` čte Unity DataLoader
  beze změny, jsou to tytéž klíče jako u pozůstalého `_txt`.
- **Hodnota obou textů smí pokračovat na dalších řádcích.** Blok končí až
  dalším klíčem nebo koncem souboru. Důsledek: řádek uvnitř textu, který sám
  začíná `Zajimavosti:`, by se přečetl jako začátek druhého bloku.
- **`Taxonomie` je jeden řádek**, který skládá server ze tří polí editoru
  (Třída, Řád, Čeleď). Oddělovač je ` | `, nevyplněná část se vynechá i s
  popiskem, všechny tři prázdné = řádek se nezapíše vůbec.
- **Popisky uvnitř `Taxonomie` se překládají**, klíč `Taxonomie:` zůstává ve
  všech jazycích stejný, aby ho Unity našlo:

  | Jazyk | Tvar hodnoty |
  |---|---|
  | cs | `Třída: … \| Řád: … \| Čeleď: …` |
  | en | `Class: … \| Order: … \| Family: …` |
  | pl | `Gromada: … \| Rząd: … \| Rodzina: …` |

  Při čtení je parser tolerantní: rozpozná popisky ve všech třech jazycích,
  bez ohledu na diakritiku a velikost písmen. Co rozpozná nedokáže, nezahodí
  tiše, ale ukáže kurátorovi v editoru s poznámkou, že to uložení přepíše.
- **Zpětná kompatibilita:** soubory z doby, kdy `_gal` byla „zajímavost"
  s jediným odstavcem pod klíčem `Popis:` (nebo `Text:`), se dál načtou,
  obsah spadne do `ObecnyText`. Prvním uložením přejde soubor do nového tvaru.
- Soubor **bez klíče** (ruční zásah) se přečte celý jako `ObecnyText`.
- **Nevyplněné pole se nezapisuje.** Prázdný slide = prázdný soubor.
- **Všechno se překládá**, sdílené s češtinou tu není nic (na rozdíl od info
  panelu, kde se sekce a latinské jméno doplňují z češtiny). Fotka je naopak
  společná, leží v `cs/`.
- Píše se přes `PUT /api/displays/:id/slides/:n/text` (tělo `{pole, jazyk}`,
  kde `pole` nese `ObecnyText`, `Zajimavosti`, `Trida`, `Rad`, `Celed`).
  Do jednoho řádku `Taxonomie:` je složí **až server**, aby tvar, který čte
  Unity, vznikal na jednom místě.
- Text se na displeji **neroluje**, doporučený limit je 250 slov na pole,
  editor průběžně počítá slova.

### `text.txt`, obecné informace (slide `_txt`, pozůstalý typ)

**Nový slide tohoto typu už nejde založit**: v cílové struktuře od Michala
není, chybí proto v nabídce „Přidat slide" i v serverové validaci
(`SLIDE_TYPY_NABIDKA`). Existující složky se dál čtou i editují, aby se
nikomu neztratil rozepsaný obsah. Nástupcem je slide `_gal`, který má tytéž
dva klíče a k nim zařazení druhu a fotku.

Dva dlouhé texty o druhu, každý pod svým klíčem, ve stejném tvaru
`Klic: Hodnota` jako info panel:

```
ObecnyText: Axolotl mexický je ocasatý obojživelník, který si po celý život
zachovává larvální podobu včetně vnějších keříčkovitých žaber.
Zajimavosti: Dokáže regenerovat končetiny, ocas i části srdce.
```

- **Klíče jsou `ObecnyText` a `Zajimavosti`**, bez diakritiky (ASCII), aby
  soubor přečetlo Unity i skripty. Zapisují se vždy v tomhle tvaru, při čtení
  je server tolerantní k velikosti písmen.
- **Hodnota smí pokračovat na dalších řádcích** (dlouhý text, odstavce). Blok
  končí až dalším klíčem nebo koncem souboru, stejná úmluva jako u `_gal`.
  Důsledek: řádek uvnitř textu, který sám začíná `Zajimavosti:`, by se přečetl
  jako začátek druhého bloku.
- Soubor **bez klíče** (ruční zásah) se přečte celý jako `ObecnyText`, ať se
  obsah neztratí.
- **Nevyplněné pole se nezapisuje.** Prázdný slide = prázdný soubor, podle toho
  se pozná, že ještě není hotový.
- **Oba texty se překládají**, sdílené s češtinou tu není nic (na rozdíl od
  info panelu, kde se sekce a latinské jméno doplňují z češtiny).
- Píše se přes `PUT /api/displays/:id/slides/:n/txt` (tělo `{pole, jazyk}`).
- Slide **nemá žádná média**: fotku, video ani mapu server odmítne.

### Sekvence 3D modelu (slide `_3d`)

- Snímky se ukládají jako **`001.png`, `002.png`, …** (tři a víc číslic),
  Unity je řadí podle čísla.
- Pořadí = pořadí nahrání. Když se nahraje víc souborů najednou, seřadí se
  podle názvu (snímky z renderu bývají `frame_001…`).
- Po smazání snímku se zbytek **přečísluje** na souvislou řadu (dvoufázově,
  přes `.tmp-*`).
- Soubor s jiným názvem než `NNN.png` se do sekvence nepočítá a ignoruje se.

### `kb.md`, znalostní báze

Markdown v **kořeni složky displeje**, ne ve slidu. Čte ho chatbot, CMS ho jen
edituje. Při zápisu se normalizují konce řádků na `\n` a doplňuje se koncový
nový řádek. Výchozí šablonu (`server/src/kbTemplate.ts`) nabízí editor přes
`GET /api/kb-template`, když je `kb.md` prázdný; vyplněný soubor se nikdy
nepřepisuje automaticky.

### Fotky

- Každý upload projde přes `sharp` (`.rotate()` srovná orientaci podle EXIF,
  strop 40 Mpx na vstupu, zmenšení na 4096 px, SVG se odmítá). Když zpracování
  selže, API vrátí 400 a nic se neuloží.
- **Výstupem je vždy PNG, i v galerii.** Dřív si galerie příponu držela
  (JPG zůstal JPG), ale Michal potvrdil, že Unity čte fotky jen jako PNG —
  JPG by na tabletu vůbec nenaskočil. Videa se tudy nepouštějí, ta si příponu
  `.mp4` drží.
- Název je vždy unikátní: `foto-<base36 čas>-<6 hex znaků>.png`. (Safari
  pojmenovává přetažené obrázky `Unknown.jpeg`, bez unikátního jména by se
  soubory přepisovaly.)
- **Mapa výskytu** se ukládá přesně jako `mapa.png`. Označení mapy soubor
  přejmenuje; předchozí `mapa.png` se vrátí mezi běžné fotky pod novým názvem.
  Mapa je jen na slidu typu `info`.
- Fotky se čtou jen s příponou `.png`, řazené abecedně podle názvu souboru.
  V galerii projdou při čtení i `.jpg`/`.jpeg` nahrané starším CMS, viz níž.
- Ke každé fotce může vedle ležet **originál `*.png.orig`** a ve složce
  **`.vyrezy.json`**; jsou to podklady pro ořez, viz níž.
- **Textový slide (`_gal`) má právě jednu fotku**, nová nahraná předchozí smaže.
- **3D model (`_3d`)** má místo unikátních názvů číslovanou sekvenci, viz výš.
- **Galerie (`_vid`)** má taky číslovanou sekvenci, viz níž.

### Výřezy fotek (ořez)

Tablet ukazuje fotky v **pevném poměru stran**. Kurátor proto u každé fotky
navolí, co z ní bude vidět („jako profilovka"), a server ji doopravdy ořízne.
Modul je `server/src/vyrez.ts`.

```
foto-abc.png        oříznutá fotka — TOHLE čte Unity
foto-abc.png.orig   originál před oříznutím, jen pro CMS
.vyrezy.json        souřadnice výřezů, jen pro CMS
```

- **Ořezává se na poměr stran, ne na pevné rozlišení.** Fotka si nechá plné
  rozlišení, jaké z ořezu vyjde.

  | Typ slidu | Poměr | Kde se projeví |
  |---|---|---|
  | `info` | 772 : 800 | infopanel, skoro čtverec na výšku |
  | `gal` | 3 : 2 | slide „Informace" |
  | `vid` | 16 : 10 | galerie (1280 × 800) |
  | `3d` | 16 : 10 | sekvence 3D modelu |

- **Nová fotka se ořízne sama, na střed.** Hned po nahrání je použitelná;
  ruční zásah je potřeba, jen když kurátorovi střed nevyhovuje.
- **Originál se nikdy nepřepisuje.** Každé další oříznutí se počítá znovu
  z `*.orig`, takže se opakovaným ořezáváním kvalita nezhoršuje a výřez jde
  kdykoli posunout zpátky.
- Souřadnice ve `.vyrezy.json` jsou **relativní k originálu** (`x`, `y`, `w`,
  `h` v rozsahu 0–1), takže nezávisí na rozlišení.
- **Mapa výskytu (`mapa.png`) se neořezává vůbec** — je to schéma a ořez by
  ukousl kus areálu. Editor u ní ikonu ořezu vůbec nenabídne.
- **Video se neořezává** (muselo by se překódovat), v galerii se přeskočí.
  Ořezatelné přípony jsou `.png`, `.jpg`, `.jpeg`.
- Fotka bez záznamu ve `.vyrezy.json` (nahraná starším CMS nebo ručně) se
  v editoru označí odznakem **„neoříznuto"**. Žádná dávková migrace se nekoná,
  srovná se to při prvním nastavení výřezu.
- Originál si CMS servíruje přes
  `GET /api/displays/:id/slides/:n/images/:nazev/original`; typ obsahu se bere
  **z obsahu souboru, ne z přípony** (originál oříznutého JPG se jmenuje
  `01.png.orig`, ale uvnitř je pořád JPEG).

#### Hromadný ořez sekvence 3D modelu

U 3D modelu se nastavuje **jeden výřez pro celou otáčku**, ne pro každý snímek
zvlášť — jinak by model při otáčení poskakoval.

- Start je `POST /api/displays/:id/slides/:n/vyrez-sekvence`, který se vrátí
  **hned** a úlohu pustí na pozadí. 36 snímků se ořezává desítky sekund
  a požadavek by mezitím spadl na timeout.
- Editor se pak ptá `GET .../vyrez-sekvence` na průběh: `{stav: {bezi, hotovo,
  celkem, chyba}}`. `bezi: false` s `chyba: null` znamená hotovo, `stav: null`
  že se pro tenhle slide od startu serveru žádný ořez nepouštěl (průběh se
  drží v paměti procesu).
- **Buď se ořízne celá série, nebo nic.** Když něco selže, snímky zůstanou
  v původním stavu.
- Do auditu jde `hromadný ořez sekvence 360` **při startu úlohy**, ne po
  dokončení: kdyby ořez spadl, má být v logu vidět, že ho někdo pustil.
- Snímek přidaný do už oříznuté sekvence se ořízne stejným výřezem.

### Video

- Přijímá se **jen MP4** (kontroluje se MIME `video/mp4` nebo přípona `.mp4`),
  konverze se nedělá.
- Video patří do galerie **`_vid`** a volitelně na **`_info`** (Michal ho na
  zařízení řadí na začátek galerie fotek info panelu).
- **Na info panelu je vždy jedno** video, starší `.mp4` se před zápisem smažou.
  Název souboru se očistí (ponechá písmena včetně české diakritiky, číslice,
  tečku, pomlčku, podtržítko a mezeru) a přípona se vynutí na `.mp4`.
- **V galerii jich může být víc**, nové se přidá na konec řady a dostane
  pořadové číslo; původní název souboru se zahazuje, viz níž.
- Limit uploadu je **200 MB** (`@fastify/multipart`).

### Galerie (slide `_vid`)

Pozor: **`_vid` není jen video.** Je to galerie fotek a videí dohromady,
v jedné číslované řadě. Suffix zůstal, protože ho tak čte Unity.

- Položky se ukládají jako **`01.png`, `02.mp4`, `03.png`, …**: pořadové číslo
  s vodící nulou. Fotky se převádějí na PNG (Unity jiný formát nepřečte),
  videa si drží `.mp4`. **Unity řadí abecedně**, ne číselně.
- Proto mají všechny položky **stejný počet cifer**. Šířka se počítá z počtu
  položek, takže při přechodu přes stovku se celá řada přečísluje z `01`
  na `001` (jinak by se `100` abecedně zařadilo před `99`).
- Pořadí = pořadí nahrání. Když se nahraje víc souborů najednou, seřadí se
  podle názvu.
- Po přidání i smazání se řada **přečísluje** na souvislou (dvoufázově, přes
  `.tmp-*`), takže v ní nezůstane díra.
- Maže se **po jedné položce** přes `DELETE .../slides/:n/images/:nazev`
  (v galerii projde i `.mp4`). `DELETE .../slides/:n/video` je jen pro info
  panel, v galerii by smazal všechna videa najednou.
- Soubor s neočíslovaným názvem (obsah nahraný starším CMS) se **nezahazuje**:
  zobrazí se a zařadí se za očíslované, kam ho zařadí i Unity. Do konvence se
  dostane při první změně ve slidu. **Žádná dávková migrace se nekoná.**
- `.jpg`/`.jpeg` z dřívějška se dál čtou a zobrazují, ať se obsah neztratí;
  nově nahraná fotka je ale vždy PNG.

---

## 7. Struktura pro Unity

Fáze A (kompatibilita s Unity) je hotová a ověřená naživo. Unity načte
strukturu bez ručního zásahu. Kontrakt je:

**Zdrojem pravdy jsou složky a názvy souborů, ne `meta.json`.**

```
cs/<pořadí>_<typ>/
```

- **Typ slidu** = suffix názvu složky. Finální struktura od Michala měla pevných
  **pět typů**, `_txt` je pozůstatek (nový už nejde založit):

  | Suffix | Typ v CMS | Obsah složky |
  |---|---|---|
  | `_info` | Infopanel | `text.txt` (Klic: Hodnota), fotky `.png`, volitelně `mapa.png` a jedno `.mp4` |
  | `_ai` | AI otázky | prázdná složka |
  | `_3d` (i `_mod`) | 3D model | sekvence `001.png`, `002.png`, … |
  | `_vid` | Galerie | fotky i videa v jedné řadě: `01.jpg`, `02.mp4`, `03.png`, … |
  | `_gal` | Informace | `text.txt` (`ObecnyText:`, `Zajimavosti:`, `Taxonomie:`) + jedna `.png` |
  | `_txt` | Obecné informace | `text.txt` (`ObecnyText: …`, `Zajimavosti: …`), **žádná média** |

- **Pořadí** = číselný prefix. Složka musí odpovídat regulárnímu výrazu
  `^(\d+)_(info|vid|gal|ai|3d|mod|txt)$`, jinak ji server ignoruje.
- **Dva suffixy neodpovídají svému obsahu.** Zůstaly kvůli tomu, že je tak čte
  Unity: **`_gal` není galerie**, ale textový slide (dva texty, zařazení druhu
  a jedna fotka), a **`_vid` není jen video**, ale galerie fotek i videí.
- **`_3d` i `_mod`** znamenají 3D model. Nově zakládaný slide dostane `_3d`;
  existující `_mod` se zachová i při změně pořadí (nepřejmenovává se).
- **AI slide** je prázdná složka `<n>_ai`, její existence říká tabletu, že se
  na tomto místě má zobrazit AI průvodce. Žádný obsah nemá.
- **`_txt` je jen text.** Fotku, video ani mapu na něj server nepřijme
  (vrátí 400), takže ve složce nikdy nebude nic než `text.txt`. Nový slide
  tohoto typu už nejde založit, viz kapitola 6.
- **`kb.md` a `meta.json`** jsou v kořeni displeje, mimo `cs/`.

Operace se slidy:

| Operace | Co se stane na disku |
|---|---|
| přidání | vznikne `cs/<max+1>_<typ>/`; ostatní se nepřečíslují |
| odebrání | složka se smaže i s obsahem, zbytek se přečísluje na souvislou řadu 1..k |
| změna pořadí | složky se přejmenují na novou souvislou řadu |

Přečíslování je **dvoufázové**, nejdřív na dočasné názvy `.tmp-<n>_<typ>`, pak
na cílové, aby se názvy nesrazily. Když proces spadne mezi fázemi, zůstanou na
disku složky s prefixem `.tmp-`; server je ignoruje (neodpovídají regexu) a je
potřeba je přejmenovat ručně.

Protože se čísla slidů po každé strukturální změně mění, klient si po přidání,
odebrání i přesunu načítá detail displeje znovu.

---

## 8. Audit log

- Soubor: `<DATA_ROOT>/audit.jsonl`, formát **JSONL** (jeden JSON objekt na
  řádek), append-only.
- Záznam:
  `{"cas": ISO, "uzivatel": účet, "jmeno": člověk, "akce": string, "cil": string}`.
- **`jmeno` je jméno vybrané po přihlášení** (viz
  [kapitola 4](#4-účty-a-přihlašování)). U sdíleného účtu je to jediné, co
  řekne, kdo akci udělal. Klíč **chybí** u záznamů zapsaných dřív, než se
  jména zavedla, a u akcí bez vybraného jména (neúspěšné přihlášení). Skládá
  ho `zapisAudit()`, aby se na jméno nedalo v žádném handleru zapomenout.
- `GET /api/audit` vrací záznamy **od nejnovějšího** a přeskakuje nečitelné
  řádky. Umí **stránkovat**: `limit` (výchozí 100, strop 500), `before`
  (ISO čas, jen starší záznamy) a `preskoc`. Tvar odpovědi je
  `{ entries: [...] }`.
- **Čte se od konce souboru**, jen tolik řádků, kolik se opravdu vypisuje.
  Celý log se do paměti nenatahuje (po roce provozu je to desítky MB — každý
  upload fotky je řádek).
- **Rotace podle velikosti.** Jakmile `audit.jsonl` přeroste **5 MB**, odloží
  se stranou jako `audit-<ISO čas>.jsonl` v témže adresáři a začne se nový.
  Archivů se drží **nejvýš 12** (~60 MB historie), nejstarší se zahazuje.
  Čtení přes API archivy prochází taky, takže stránkování na starší záznamy
  na hranici rotace nenarazí.
- Archivy se dají kdykoli odnést stranou (jsou to obyčejné soubory), zálohu
  ale dělejte **před** tím, než jich bude víc než 12.

Zaznamenávané akce (řetězce, na které se váže i obarvení v UI):

| Akce | `cil` |
|---|---|
| `přihlášení`, `odhlášení` | `systém, IP <adresa>` (u odhlášení jen `systém`) |
| `neúspěšné přihlášení` | `systém, IP <adresa>`, `uzivatel` = zadané jméno (ořezáno na 64 znaků) |
| `úprava info panelu` | `displej <id>, slide <n>` |
| `úprava textového slidu` | `displej <id>, slide <n> (<jazyk>)` |
| `úprava obecných informací` | `displej <id>, slide <n> (<jazyk>)` |
| `úprava znalostní báze` | `displej <id>` |
| `upload`, `smazání souboru` | `displej <id>, slide <n>: <soubor>` |
| `označení mapy výskytu`, `zrušení mapy výskytu` | `displej <id>, slide <n>` |
| `upload videa`, `smazání videa` | `displej <id>, slide <n>` |
| `přidání slidu`, `odebrání slidu`, `pořadí slidů` | `displej <id>` |
| `úprava výřezu fotky` | `displej <id>, slide <n>: <soubor>` |
| `hromadný ořez sekvence 360` | `displej <id>, slide <n>` (zapisuje se při startu úlohy) |
| `odesláno na displej` | `displej <id>` |
| `výběr jména` | `systém, IP <adresa>` |
| `přidáno jméno do seznamu`, `smazáno jméno ze seznamu` | jméno |
| `odhlášení pro nečinnost` | `systém, 60 min bez aktivity` |
| `potvrzení revize AI textů` | `displej <id> (<druh>)` |
| `úprava nastavení deštného pralesa` | co se změnilo z čeho na co |
| `hromadný import` | souhrn importu, viz [kapitola 17](#17-údržbové-skripty) |
| `odeslán povel videomappingu` | `<instalace> (<host>:<port>): <povel> (/<osc>)` |
| `povel videomappingu selhal` | totéž a za pomlčkou důvod |

Účet i jméno bere server z platné session; na chráněných cestách jsou vždy
vyplněné (fallback `neznámý` se uplatní jen u veřejných cest).

**Co se do auditu schválně nezapisuje:** tep tabletů
(`POST /api/displays/:id/heartbeat`) ani tep relace
(`POST /api/session/tep`). 31 tabletů po minutě je 45 tisíc řádků denně
a audit je na to, co udělal člověk, ne na provozní telemetrii.

---

## 9. Reingest signál pro chatbota

Po uložení obsahu, který chatbot čte, dá CMS chatbotovi vědět, že si má obsah
displeje načíst znovu (`server/src/reingest.ts`).

**Ve výchozím stavu je vypnutý.** Dokud není synchronizace s chatbotem
domluvená, běží na sucho: nikam se nevolá, jen se do konzole zaloguje, co by se
odeslalo:

```
[reingest] VYPNUTO, poslal bych POST na '(nenastavená URL)' s tělem {"displej":1,"soubor":"displeje/1/kb.md"}
```

### Zapnutí

```bash
REINGEST_ENABLED=true
REINGEST_URL=https://chatbot.example/reingest
REINGEST_TOKEN=<tajný token>
```

Zapne se, jen když je `REINGEST_ENABLED` přesně `"true"` **a zároveň** je
vyplněná `REINGEST_URL`.

### Chování

- **Metoda:** `POST`, `Content-Type: application/json`, hlavička
  `X-Reingest-Token: <REINGEST_TOKEN>`.
- **Tělo:** `{ "displej": <číslo>, "soubor": "displeje/<id>/<cesta>" }`,
  cesta je relativní k datové složce.
- **Timeout:** 5 sekund (`AbortSignal.timeout`).
- **Fire-and-forget:** volá se přes `void`, uložení obsahu na odpověď nečeká.
  Selhání se jen zaloguje varováním, nikdy neshodí server ani nezruší zápis.

### Kdy se signál posílá

| Akce | Odeslané soubory |
|---|---|
| uložení polí info panelu | `cs/<n>_info/text.txt` **a** `meta.json` (dva samostatné požadavky) |
| uložení znalostní báze | `kb.md` |

Upload fotek, videí ani změny struktury slidů reingest **nespouštějí**, pro
chatbota jsou relevantní jen fakta a identifikace druhu.

---

## 10. Tep tabletů (heartbeat)

Tablet u expozice se jednou za minutu ozve na
`POST /api/displays/:id/heartbeat` a CMS si zapamatuje, kdy to bylo. Z toho se
v přehledu displejů i na dashboardu kreslí, který tablet doopravdy žije
(`server/src/tep.ts`).

Do té doby se stav zařízení bral z pole `stav` v `meta.json`. To bylo od
začátku demo: zapsalo se při zakládání dat a nikdy ho nic nepřepsalo, takže
tři displeje byly navěky „offline" a zbytek navěky „online".

### Co tablet posílá

```
POST /api/displays/:id/heartbeat     veřejný, bez přihlášení
{ "verze": "1.4.2", "obsahZ": "2026-09-21T08:12:00Z", "poznamka": "…" }
```

**Tělo je celé nepovinné**, je jen pro diagnostiku; podstatná informace je
samotný fakt, že požadavek dorazil. Endpoint je veřejný ze stejného důvodu
jako čtení obsahu pro tablet: tablet se nemá jak přihlásit a jede po LAN
pavilonu. Cokoli z tabletu je cizí vstup, berou se jen řetězce a krátí se na
100 znaků, ať se do paměti serveru nedá poslat megabajtová „verze".

**Čas si razítkuje server vlastními hodinami.** Tablet žádný čas neposílá,
takže rozjeté hodiny na tabletu nemůžou stav rozhodit.

### Stavy a prahy

Tablet posílá tep každých 60 s (plus náhodných 0–10 s rozptylu, ať 31 tabletů
netrefí server ve stejnou sekundu). Prahy jsou násobky toho intervalu:

| Stav | Kdy | Co to znamená |
|---|---|---|
| `online` | do 3 min (`ONLINE_DO_MS`) | chybí nejvýš dva tepy, běžné zaškobrtnutí wi-fi |
| `vypadava` | do 15 min (`VYPADAVA_DO_MS`) | chybí jich víc; pořád to bývá síť, ne tablet |
| `offline` | nad 15 min | patnáct zmeškaných tepů po sobě, bereme za vypnutý |
| `neznamy` | server běží krátce a tablet se ještě neozval | **nevíme**, ne poplach |

Rozdíl mezi `neznamy` a `offline` je v době běhu procesu: po restartu je
tabulka prázdná a tablet, který normálně žije, se ozve až do minuty. Dokud
proces neběží aspoň `VYPADAVA_DO_MS`, hlásí se proto `neznamy`. Pak už je
mlčení samo o sobě odpověď.

Kdyby Michal interval tepu změnil, mění se **ty dvě konstanty**, nic jiného.

### Drží se to jen v paměti

Tepy jsou v `Map` v paměti procesu, schválně:

- je to **okamžitý stav, ne historie**; po restartu serveru nemáme právo
  tvrdit, že tablet žije, protože o tom nic nevíme,
- zápis na disk jednou za minutu ze 31 tabletů by jen mlel diskem ve sdílené
  složce, ze které si Unity tahá obsah.

Mapa je klíčovaná číslem displeje, takže je shora omezená počtem displejů
a nemůže růst donekonečna.

**Restart serveru tedy vynuluje stavy** a přehled chvíli ukazuje „zatím se
neozval". To je správně, ne chyba.

---

## 11. Analytika návštěvnosti

Sekce **Analytika** v CMS ukazuje, jak návštěvníci tablety doopravdy používají:
kolik relací, jak dlouho u displeje stojí, co si pouštějí. **Data nepočítáme
my** — zapisuje je Michalovo Unity přímo na disk a CMS je jen čte
(`server/src/udalosti.ts`, `server/src/analytika.ts`).

Nezaměňovat s [analytikou chatbota](#12-analytika-chatbota-v-dashboardu), to je
jiný zdroj (Danielův backend) a jiná stránka.

### Co Unity zapisuje

```
<DATA_ROOT>/udalosti/unity/<displej>/RRRR-MM-DD.jsonl    nová struktura
<DATA_ROOT>/udalosti/unity/RRRR-MM-DD.jsonl              starší plochá
```

Jeden JSON na řádek, append-only. **Obě struktury se čtou.** U nové je zdrojem
pravdy **název složky, ne pole `displej` uvnitř řádku**: tablet se dá přehodit
na jiný displej a v logu pak zůstane staré číslo. Podsložky s nečíselným
názvem (`7-zaloha`) se ignorují.

```json
{"cas":"2026-09-20T14:03:11Z","displej":2,"relace":"a1b2","akce":"zobrazen_slide",
 "typ":"Info","cislo":1,"trvani_s":26}
```

| Akce | Význam |
|---|---|
| `relace_start` | někdo přišel k displeji a začal ho používat |
| `zobrazen_slide` | zobrazil se slide; `typ`, `cislo` a `trvani_s` |
| `otevren_chat` | někdo se opravdu zeptal AI |

**Čtení je schválně tolerantní.** Je to cizí formát, který se ještě může
měnit, a data z provozu bývají špinavá:

- poškozený řádek se **přeskočí a spočítá**,
- neznámý typ slidu se **nezahazuje**, projde dál tak, jak přišel
  (`typSurovy`), a stránka ho ukáže,
- nesmyslné trvání (delší než celá relace = zbytek stopek z minulé) se
  **nezapočítá do průměrů**.

Co všechno se přeskočilo, hlásí CMS **oranžovým pruhem nad čísly**, ať se na
tichou chybu nepřijde až za půl roku. Unity čísluje slidy od nuly, CMS je
přečísluje na řadu od jedné, aby seděly s tím, co vidí kurátor.

### Proč denní souhrny

Na rozdíl od dashboardu, který kouká na pár posledních dnů, se tady běžně
chodí s ročním rozsahem. Naměřeno na roce syntetických dat (31 displejů ×
365 dnů, 11 315 souborů, 11 M řádků, 1,4 GB):

| Přístup | Čas | Paměť |
|---|---|---|
| číst pokaždé všechny události | 47 s | 3 GB haldy |
| přes denní souhrny, studený start | 6,2 s | 18 MB |
| přes denní souhrny, z paměti | 119 ms | 18 MB |

Proto se z každé dvojice (den, displej) udělá **denní souhrn** — hrstka čísel
místo tisíců událostí. Soubor minulého dne se už nikdy nezmění, takže se
počítá právě jednou. Dotaz na libovolný rozsah je pak jen sečtení souhrnů.

Souhrny se ukládají do **`<DATA_ROOT>/analytika/RRRR-MM.json`** (jeden soubor
na měsíc, 2,5 MB za celý rok), aby restart serveru neznamenal šestisekundové
čekání na první otevření stránky.

> **`analytika/` je JEN zrychlení, ne zdroj pravdy.** Složku lze kdykoli
> smazat; dopočítá se z logů v `udalosti/`. Poškozený měsíční soubor si server
> přepočítá sám a napíše to do logu. Do Michalovy složky `udalosti/` přitom
> nikdy nezapisujeme.

Doby se v souhrnech drží jako **součet a počet**, ne jako průměr: průměrovat
denní průměry by dalo tichému čtvrtku stejnou váhu jako narvané sobotě.
Relace se počítají jako počet událostí `relace_start`, ne jako počet
unikátních ID — relace přes půlnoc má začátek právě v jednom dni, takže se
nedá započítat dvakrát.

### Endpointy

| Metoda | Cesta | Parametry |
|---|---|---|
| GET | `/api/analytika` | `od`, `do` (`RRRR-MM-DD`), `granularita` (`den`/`tyden`/`mesic`), `porovnat` (`1`) |
| GET | `/api/udalosti/prehled` | `dny`, `displej` — posledních pár dnů pro dashboard |

- Výchozí okno je **posledních 30 dnů**, ať stránka po otevření něco ukáže.
- Rozsah smí mít nejvýš **400 dnů** (rok s rezervou), jinak `400`.
- `porovnat=1` dopočítá stejně dlouhé předchozí období, z něj jsou zelená
  a červená procenta u čísel.
- Do žebříčku se berou názvy druhů z `meta.json`. Displej bez druhu se ukáže
  jako „Displej 19", ne jako deset řádků „Nepřiřazeno".

---

## 12. Analytika chatbota v dashboardu

Dashboard („Přehled provozu") ukazuje reálné dotazy návštěvníků na AI. Data
nepočítáme my, dodává je **analytický backend chatbota (Daniel)**, který běží
na stejném serveru. Naše strana je jen čtení (`server/src/analytics.ts`).

### Adresa a zapnutí

Nic se nezapíná, stačí adresa:

```bash
ANALYTICS_URL=http://127.0.0.1:8000   # výchozí, chatbot na stejném stroji
```

Výchozí hodnota počítá s tím, že chatbot poslouchá na portu 8000 lokálně. Když
poběží jinde, nastaví se celá adresa včetně portu (např.
`ANALYTICS_URL=http://192.168.1.50:8000`).

### Kontrakt, který čteme

| Metoda | Cesta na straně chatbota | Parametry |
|---|---|---|
| GET | `/analytics/questions` | `since` (ISO, volitelný, default 24 h), `limit` (default 500, max 2000), `answered` (`true`/`false`) |
| GET | `/analytics/summary` | `since` (ISO, volitelný) |

Bez autentizace. `questions` vrací `{questions[], total, since}`, `summary`
vrací `{since, total_questions, answered, unanswered, per_species[]}`.

**`display_id` může být `null`.** Druh se proto páruje primárně přes
`species_latin` proti `latin_name` v našich `meta.json` (obě strany se
kanonizují stejnými pravidly, viz [kapitola 6](#6-formáty-souborů)), a
`display_id` je až záložní klíč. Druh, který se nepodaří napárovat na žádný
displej, dashboard nezamlčí, napíše ho pod heat mapou, ať se dá opravit
latinský název v info panelu.

### Proxy na naší straně

Prohlížeč cizí službu nevolá. Náš server má vlastní endpointy
`GET /api/analytics/questions` a `GET /api/analytics/summary`, které jsou
**chráněné přihlášením** jako ostatní `/api`, a navíc:

- ověří vstupní parametry (nesmyslné `since`, `limit`, `answered` → `400`),
- srazí `limit` na strop 2000 z kontraktu,
- ohlídají timeout (`ANALYTICS_TIMEOUT_MS`),
- očistí odpověď, aby chybějící pole na straně chatbota neshodilo dashboard.

### Když chatbot neběží

Odpověď je **vždy `HTTP 200`** s obálkou, ne chyba:

```json
{ "dostupne": true, "data": { … } }
{ "dostupne": false, "duvod": "Analytika chatbota není dostupná na http://127.0.0.1:8000." }
```

Dashboard z toho vykreslí hlášku „Analytika chatbota zatím není připojená" i s
důvodem a jinak funguje dál, stránka se normálně otevře, heat mapa ukáže
displeje z CMS bez intenzity, KPI karty se nezobrazí (radši nic než vymyšlené
číslo). Do konzole serveru se zapíše `[analytika] … selhalo: …`.

Prázdná odpověď (chatbot běží, ale za období nejsou dotazy) se hlásí jako
„Zatím žádné dotazy.", ne jako nula bez kontextu.

### Heat mapa nad půdorysem pavilonu

Mapa dotazů kreslí body na **oficiální půdorys pavilonu od ZOO**:
`web/public/pavilon-pudorys.png` (kopie `podklady/Amphibiarium_mapa 1.png`,
6459 × 6434 px, verze s čísly displejů). Obrázek se servíruje jako statický soubor z `web/dist`, mapa
i body drží poměr stran a škálují se se šířkou okna (souřadnice jsou v %).

**Souřadnice displejů jsou v `web/src/pages/Dashboard.tsx` v poli
`PUDORYS_BODY`**, jeden řádek na displej:

```ts
{ displej: 8, x: 13.5, y: 77.7 },
```

`x`, `y` = procenta šířky a výšky obrázku (levý horní roh = 0, 0). Ruční
doladění je otázka změny čísla, nic dalšího se nepřepočítává. Skupiny jsou
v komentářích označené barvou a číslem sekce z plánku, jen pro orientaci.

#### Jak souřadnice vznikly

Aktuální plánek (od 17. 8. 2026) má **u každé vitríny natištěné číslo
displeje 1 až 31**, takže se nic nedohaduje:

1. Detekcí barevných ploch v obrázku se našly středy všech obdélníčků (spojité
   komponenty jedné barvy; vyřazená kolečka sekcí, tenké linky a obrysy).
2. Z výřezů kolem každého středu se přečetlo natištěné číslo a přiřadilo se
   k souřadnici. Každé číslo 1 až 31 padlo právě jednou, nic nechybí a nic
   nepřebývá.
3. Kontrola: body se s čísly vykreslily zpět na plánek a porovnaly s natištěnými
   čísly (i naživo v prohlížeči nad neztlumeným plánkem).

**Kolečka s čísly 1 až 11 jsou sekce** (skupiny displejů), ne displeje, body
nemají. Bez čísla jsou na plánku tři tvary, které tedy displeje nejsou:
kruhová nádrž u sekce 1, tenký zelený pruh u stěny a **prostřední box
fialového trojbloku** u sekce 8.

> Starší verze plánku čísla neměla a pozice se odhadovaly z pořadí sekcí. Tahle
> verze ten odhad ruší, pokud se v mapě někdy objeví bod mimo vitrínu, je to
> chyba souřadnice, ne domněnky.

#### Vzhled mapy

- Plánek je na pozadí **odbarvený a ztlumený** (`grayscale(1)`, `opacity 0.35`),
  aby jeho barevné zóny nepřebíjely body návštěvnosti. Ladí se u `<img>`
  v sekci mapy.
- Body mají bílý okraj a velikost podle počtu dotazů (2,2 % až 5 % šířky mapy),
  barvu podle intenzity: **nízká zelená → vysoká červená** (`heatColor`,
  legendu drží stejné zastávky v `HEAT_GRADIENT`).

#### Intenzita a stavy

- Intenzita (barva i velikost bodu) jde ze stejného zdroje jako dřív:
  `per_species.count` z `/analytics/summary`, napárováno na displeje.
- Bez dat z chatbota se body kreslí **neutrálně**, žádná vymyšlená intenzita.
- Displeje, které v CMS jsou, ale na plánku nejsou (v CMS je 37 složek, plánek
  má 31), dashboard vypíše pod mapou. Stejně tak obráceně.

### Stav tabletů v dashboardu

Dashboard **stav tabletů ukazuje** (blok „Provoz tabletů u expozice“): kolik
jich je online, kolik vypadává, kolik je offline a které se 24 hodin neozvaly.
Zdrojem je tep tabletů, viz [kapitola 10](#10-tep-tabletů-heartbeat), ne
`meta.json`.

> **`stav` v `meta.json` není živý stav zařízení.** Je to pozůstatek z doby
> před tepem: zapisuje ho jen `seed`/`migrate` a nic ho za běhu nepřepisuje.
> Pro monitoring se nepoužívá a v přehledu displejů se neukazuje.

---

## 13. Displej u deštného pralesa

Jeden displej v pavilonu neukazuje obsah druhu ze složek `data/displeje`, ale
**prostředí pavilonu a odpočet do bouřky z videomappingu**. Je to samostatná
věc: vlastní modul (`server/src/prales.ts`), vlastní soubor
(`<DATA_ROOT>/prales.json`), vlastní endpoint a vlastní stránka v CMS.
**Struktury `data/displeje` ani ostatních displejů se nijak netýká.**

### Endpoint pro Unity

```
GET /api/prales        veřejný, bez přihlášení
```

```json
{
  "countdown_seconds": 724,
  "temperature_internal": 20,
  "humidity_text": "80-100%",
  "temperature_external": 23,
  "current_date": "12.8.26",
  "alert_flashing_lights": true,
  "alert_water_effects": false
}
```

Veřejný je proto, že ho čtou tablety u expozice stejně jako
`GET /api/displays/:id` (viz `VEREJNE_API` v `server/src/index.ts`). Unity si ho
tahá **každých pět sekund z 31 tabletů**, tedy zhruba šest požadavků za sekundu
nepřetržitě.

**Odpověď proto nikdy nesahá na disk ani na síť.** Nastavení i venkovní teplota
jsou v paměti procesu; požadavek je jen výpočet odpočtu a poskládání objektu
(naměřeno pod 1 ms). Z disku se čte při startu a při změně souboru, z internetu
nejvýš jednou za deset minut na pozadí.

| Pole | Odkud se bere |
|---|---|
| `countdown_seconds` | dopočítává se z intervalu, viz níž; `0` = odpočet vypnutý |
| `temperature_internal` | nastavuje kurátor v CMS |
| `humidity_text` | nastavuje kurátor v CMS, **text** (smí být rozsah „80-100%") |
| `temperature_external` | open-meteo.com, viz níž |
| `current_date` | systémový čas serveru, formát `D.M.RR` bez vedoucích nul |
| `alert_flashing_lights` | přepínač v CMS |
| `alert_water_effects` | přepínač v CMS |

### Odpočet do bouřky

Kurátor zadá **interval opakování v minutách**; server z něj počítá, kolik
sekund zbývá do další bouřky, a cyklus se pořád opakuje.

Odpočet je odvozený od **půlnoci** (lokální čas serveru), ne od startu procesu:

```
zbývá = interval − ((teď − dnešní půlnoc) mod interval)
```

Při intervalu 15 min padnou bouřky na 0:15, 0:30, 0:45, 1:00 a tak dál. To je
podstatné pro provoz: **po restartu serveru odpočet naváže tam, kde má být**, a
nerozejde se s videomappingem. Kdyby se počítalo od startu procesu, každý
restart by rastr posunul.

Zaokrouhluje se **nahoru**, takže zapnutý odpočet nikdy nepošle `0` (nejmenší
hodnota je 1). Nula je vyhrazená pro „kurátor odpočet vypnul".

Interval, který se do dne nevejde beze zbytku (například 7 min), má poslední
cyklus před půlnocí kratší. Pavilon je v tu dobu zavřený.

### Venkovní teplota

Zdroj je **open-meteo.com**, veřejné API bez klíče a bez registrace:

```
GET https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&current=temperature_2m
```

Souřadnice jsou v konfiguraci (`POCASI_LAT`, `POCASI_LON`, výchozí ZOO
Ostrava), ne natvrdo v kódu. Timeout přes `POCASI_TIMEOUT_MS`.

- Stahuje se **časovačem na pozadí, nejvýš jednou za deset minut** (interval je
  konstanta, schválně se nedá zkrátit konfigurací).
- Hodnota se zaokrouhluje na celé stupně, protože displej ukazuje celé stupně.
- **Když stažení selže, použije se poslední známá hodnota z paměti.**
- Když žádná není (třeba po restartu serveru bez internetu), použije se
  **záloha, kterou nastavil kurátor v CMS**.
- Selhání se nikdy nevyhazuje jako výjimka a nikdy nezdrží odpověď tabletu.
  Cizí služba nesmí shodit ani zpomalit náš server, stejný přístup jako
  u analytiky chatbota ([kapitola 12](#12-analytika-chatbota-v-dashboardu)).

Poslední známá hodnota **nevyprší**; displej ji ukazuje dál, dokud se nepodaří
stáhnout novou. V CMS se ale po hodině označí jako zastaralá, ať je poznat, že
internet delší dobu nejede.

### Nastavení v CMS

Stránka **Deštný prales** v levém menu (`/prales`). Nastavuje se vnitřní
teplota, vlhkost, záložní venkovní teplota, interval bouřky včetně vypnutí a
dva přepínače varování. U každého pole je napsané, kde se na displeji projeví a
jak se jmenuje v odpovědi endpointu.

Vpravo je **náhled toho, co endpoint posílá teď**, obnovovaný každých pět
sekund (stejný rytmus jako Unity), včetně toho, jestli venkovní teplota přišla
z internetu, nebo je to záloha, a kdy naposledy. Náhled ukazuje **uložený**
stav, ne rozepsané změny ve formuláři.

Změny se zapisují do audit logu jako všechno ostatní, akce
`úprava nastavení deštného pralesa`, cíl vyjmenovává, co se změnilo z čeho na
co. Uložení beze změny se do logu nepíše.

### `prales.json`

```json
{
  "teplotaVnitrni": 20,
  "vlhkost": "80-100%",
  "teplotaVenkovniZaloha": 20,
  "bourkaZapnuta": true,
  "bourkaIntervalMin": 15,
  "varovaniBlikaniSvetel": false,
  "varovaniVodniEfekty": false
}
```

Zapisuje se atomicky (tmp + rename) jako `meta.json`. Soubor se dá editovat
i ručně: server sleduje složku `DATA_ROOT` a změnu převezme do sekundy, bez
restartu. Ruční editace ale **neprojde přes audit log** ani přes validaci
formuláře, takže se hodí spíš pro ladění.

Tolerance k rozbitému souboru:

- **Chybí** (první spuštění): použijí se výchozí hodnoty z tabulky výše.
- **Není platný JSON za běhu**: server **nechá to, co má v paměti**, a zapíše
  varování do logu. Displej jede dál na posledních dobrých hodnotách.
- **Jednotlivá hodnota je nesmysl** (text místo čísla, interval 0): spadne na
  výchozí, ostatní se převezmou. Přes CMS se takový vstup neuloží, formulář
  i server ho odmítnou hláškou.

Meze validace: teplota −50 až 60 °C, vlhkost nejvýš 40 znaků na jednom řádku,
interval celé číslo 1 až 1440 minut.

---

## 14. Videomapping

V pavilonu jsou dvě instalace videomappingu od firmy, která je dodala. Kurátor
je zapíná a vypíná ze stránky **Videomapping** (`/videomapping`).

### Jak se to ovládá

Instalace poslouchají **OSC přes UDP**, každá na svém počítači. Stačí poslat
jednu zprávu bez argumentů, zbytek si řídí samy:

| Instalace | Výchozí adresa | Zprávy |
|---|---|---|
| WaterSense | `10.10.10.51:7000` | `/start`, `/stop` |
| Les | `10.10.10.52:7000` | `/start`, `/stop` |

Adresy a porty jsou v proměnných prostředí (`VIDEOMAPPING_*`, viz
[kapitola 3](#3-proměnné-prostředí)), **ne v kódu**. Když je firma změní, stačí
přepsat proměnnou a restartovat službu; aplikace se kvůli tomu nepřekládá.
Nesmyslná hodnota (prázdno, port mimo rozsah) se nepoužije, spadne se na
výchozí a do logu jde varování, aby se tiše nemačkala tlačítka naprázdno.

### Co CMS neví a proč to tak zůstane

**UDP je jednosměrné a nikdo ho nepotvrzuje.** Odeslání datagramu neříká nic
o tom, jestli dorazil, jestli ho instalace přečetla ani jestli se rozeběhla.
Zpráva poslaná na vypnutý počítač nebo na špatnou IP odejde úplně stejně
úspěšně jako ta správná.

Z toho plyne, jak se systém chová:

- CMS **nikde neukazuje stav instalace** a nikdy nenapíše „zapnuto“. Píše
  „odeslán povel k zapnutí“ a čas odeslání.
- **Chyba se zobrazí jen tehdy, když selže naše strana**: neplatná nebo
  nepřeložitelná adresa, síť je dole, socket nešel otevřít. Endpoint na to
  vrací `502` a hlášku, kterou CMS ukáže u příslušné instalace.
- Přehled „naposledy odesláno z CMS“ drží server **v paměti** a jen za svůj
  běh. Není to stav mappingu, je to poslední povel, který odsud odešel. Po
  restartu je prázdný, celá historie zůstává v audit logu.

Jestli mapping opravdu běží, se pozná **jen pohledem do pavilonu**. Kdyby bylo
potřeba skutečný stav zobrazovat, musela by firma poslat zpátky zprávu (OSC
odpověď nebo jiný kanál), a to zatím není domluvené.

### Kódování OSC zprávy

Kvůli dvěma zprávám bez argumentů se netahá knihovna, zpráva má dvanáct bajtů
(`server/src/osc.ts`). OSC string je text + aspoň jedna nula + doplnění nulami
na násobek čtyř; typový řetězec (samotná čárka) je povinný i bez argumentů:

```
/start  2f 73 74 61 72 74 00 00   "/start" + 2 nuly (6+1 → 8)
        2c 00 00 00               ","      + 3 nuly (1+1 → 4)

/stop   2f 73 74 6f 70 00 00 00   "/stop"  + 3 nuly (5+1 → 8)
        2c 00 00 00               ","      + 3 nuly
```

Odesílá se přes `node:dgram` (`udp4`), socket se otevře a zavře pro každý povel
zvlášť. Do adresy se nikdy nedostane nic jiného než `/start` a `/stop`; kontrola
platnosti OSC adresy je v `jePlatnaOscAdresa`.

### Audit

Do audit logu jde **každý** pokus, i neúspěšný:

| Akce | Cíl |
|---|---|
| `odeslán povel videomappingu` | `WaterSense (10.10.10.51:7000): zapnout (/start)` |
| `povel videomappingu selhal` | totéž + důvod selhání |

---

## 15. Díry v zemi

Dva zapuštěné expoziční prvky, které **nejsou displeje**: `server/src/diry.ts`.

Michalův externí přehrávač si video čte přímo z disku a bere cokoli s příponou
`.mp4`, co ve složce najde. Naše jediná úloha je dostat do té složky **právě
jeden soubor**. Žádné `meta.json`, žádné slidy, žádný typ slidu — se strukturou
`data/displeje` to nemá nic společného, proto vlastní modul a vlastní složky
přímo v datovém kořeni (stejně jako `prales.json`).

```
<DATA_ROOT>/Cervori/<cokoli>.mp4
<DATA_ROOT>/Paleonaleziste/<cokoli>.mp4
```

| `id` v URL | Název pro obsluhu | Složka na disku |
|---|---|---|
| `cervori` | Červoři | `Cervori` |
| `paleonaleziste` | Paleonaleziště | `Paleonaleziste` |

Názvy složek jsou schválně **bez diakritiky**, stejně jako klíče v `text.txt`:
cestu čte cizí přehrávač a nemusí mít rozumné kódování. Kurátorovi se v CMS
ukazuje název s diakritikou. Na produkčním Windows serveru s
`DATA_ROOT=C:\ZZ_CMS_Data` vyjdou cesty na `C:\ZZ_CMS_Data\Cervori\`
a `C:\ZZ_CMS_Data\Paleonaleziste\`.

- `GET /api/diry` vrátí stav obou (jestli tam video je, jak se jmenuje, jak je
  velké a kdy se nahrálo).
- `POST /api/diry/:id/video` nahraje nové; **starší `.mp4` ve složce se před
  zápisem smažou**, ať přehrávač nemá na výběr. Název se očistí a přípona se
  vynutí na `.mp4`.
- Platí stejné limity jako u ostatních videí: jen MP4, nejvýš 200 MB.

---

## 16. API a ochrana endpointů

Hook `onRequest` se vztahuje **jen na cesty začínající `/api`**. Ve výchozím
stavu je vše zamčené; veřejné je pouze to, co je vyjmenované v množině
`VEREJNE_API` v `server/src/index.ts`. Nový endpoint je tedy chráněný
automaticky, dokud ho někdo vědomě nepřidá do seznamu.

**Veřejné (bez přihlášení):**

- `POST /api/login`, `POST /api/logout`, `GET /api/me`
- `GET /api/displays/:id`, data pro náhled tabletu u expozice
- `GET /api/prales`, data pro displej u deštného pralesa, viz [kapitola 13](#13-displej-u-deštného-pralesa)
- `POST /api/displays/:id/heartbeat`, tep tabletu (Unity, každou minutu), viz
  [kapitola 10](#10-tep-tabletů-heartbeat)
- `/data/displeje/...` (statické soubory) a SPA včetně `/tablet/:id`, hookem
  neprocházejí vůbec

**Stačí přihlášení, jméno ještě vybrané být nemusí** (množina `BEZ_JMENA`):
`GET|POST /api/jmena`, `DELETE /api/jmena/:jmeno`, `POST /api/session/jmeno`
a `POST /api/session/tep`. Je to přesně to, co potřebuje obrazovka výběru
jména; kdo přišel poprvé, musí si své jméno umět přidat dřív, než se do CMS
dostane. Ostatní chráněné cesty bez vybraného jména vracejí
`403 {"chyba":"Nejdřív vyberte jméno.","kod":"jmeno"}`.

**Namapovaná routa rozhoduje o ochraně**, ne syrové `req.url`: jinak by šlo
autorizaci obejít procentním kódováním (`/%61pi/...`), zdvojeným lomítkem
nebo velkými písmeny.

**Chráněné (bez platné session vrací `401 {"chyba":"Přihlaste se prosím."}`):**

| Metoda | Cesta | Popis |
|---|---|---|
| GET | `/api/displays` | seznam displejů (id, druh, `latin_name`, stav, poslední změna, náhledová fotka) |
| PUT | `/api/displays/:id/slides/:n` | uložení polí info panelu, tělo `{pole, section}`, vrací `{ok, latin, latinCorrected}` |
| PUT | `/api/displays/:id/kb` | zápis `kb.md`, tělo `{text}` |
| PUT | `/api/displays/:id/slides/:n/text` | texty a zařazení druhu (`_gal`), tělo `{pole, jazyk}` s klíči `ObecnyText`, `Zajimavosti`, `Trida`, `Rad`, `Celed`; řádek `Taxonomie:` skládá server |
| PUT | `/api/displays/:id/slides/:n/txt` | obecné informace (`_txt`), tělo `{pole, jazyk}` s klíči `ObecnyText` a `Zajimavosti` |
| POST | `/api/displays/:id/slides/:n/image` | multipart upload fotky; `_gal` nahradí jedinou fotku, `_3d` přidá snímek na konec sekvence, `_vid` položku na konec galerie (tam se drží přípona, jinde konverze na PNG) |
| DELETE | `/api/displays/:id/slides/:n/images/:nazev` | smazání jedné položky (v galerii i `.mp4`) |
| PUT | `/api/displays/:id/slides/:n/images/mapa` | označení mapy, tělo `{nazev}`, `null` značení zruší |
| POST | `/api/displays/:id/slides/:n/video` | multipart upload MP4; v galerii `_vid` přibude jako další položka, na `_info` nahradí to jediné |
| DELETE | `/api/displays/:id/slides/:n/video` | smazání videa info panelu (galerie se maže po položkách) |
| POST | `/api/displays/:id/slides` | přidání slidu, tělo `{typ}` (`info`/`ai`/`3d`/`vid`/`gal`; `txt` už ne) |
| DELETE | `/api/displays/:id/slides/:n` | odebrání slidu |
| PUT | `/api/displays/:id/slides/reorder` | změna pořadí, tělo `{poradi: [n, …]}` |
| POST | `/api/displays/:id/refresh` | odeslání na displej |
| GET | `/api/videomapping` | instalace videomappingu + poslední odeslaný povel (z paměti serveru) |
| POST | `/api/videomapping/:id/:povel` | OSC povel instalaci; `:id` = `watersense`/`les`, `:povel` = `start`/`stop`. `200 {ok, odeslano}` = předáno systému, **ne** potvrzení doručení; `502` = odeslání selhalo u nás |
| GET | `/api/audit` | audit log; `limit`, `before` (ISO), `preskoc` pro stránkování |
| GET | `/api/kb-template` | výchozí šablona `kb.md` |
| GET | `/api/jmena` | seznam jmen lidí u sdíleného účtu |
| POST | `/api/jmena` | přidání jména, tělo `{jmeno}`; `409` když už v seznamu je |
| DELETE | `/api/jmena/:jmeno` | smazání jména ze seznamu (historii v auditu nemění) |
| POST | `/api/session/jmeno` | výběr jména pro tuhle session, tělo `{jmeno}`; jméno musí být v seznamu |
| POST | `/api/session/tep` | tep od člověka u klávesnice, tělo `{aktivita}`; vrací `{ok, zbyvaMs}` |
| GET | `/api/displays/:id/slides/:n/images/:nazev/original` | originál fotky před oříznutím (typ obsahu podle obsahu, ne přípony) |
| PUT | `/api/displays/:id/slides/:n/vyrez` | uložení výřezu jedné fotky, tělo `{soubor, vyrez:{x,y,w,h}}` (0–1 vůči originálu) |
| POST | `/api/displays/:id/slides/:n/vyrez-sekvence` | start hromadného ořezu 3D sekvence; vrací hned `{ok, celkem}` |
| GET | `/api/displays/:id/slides/:n/vyrez-sekvence` | průběh ořezu: `{stav:{bezi, hotovo, celkem, chyba}}`, `null` = nikdy neběžel |
| POST | `/api/displays/:id/revize` | potvrzení revize AI textů (`cekaNaRevizi` v `meta.json`); `400`, když displej na revizi nečeká |
| GET | `/api/analytika` | návštěvnost z událostí Unity, `od`, `do`, `granularita`, `porovnat`, viz [kapitola 11](#11-analytika-návštěvnosti) |
| GET | `/api/udalosti/prehled` | posledních pár dnů událostí pro dashboard, `dny`, `displej` |
| GET | `/api/diry` | stav obou „děr v zemi", viz [kapitola 15](#15-díry-v-zemi) |
| POST | `/api/diry/:id/video` | výměna videa v díře (starší `.mp4` se smažou) |
| GET | `/api/analytics/questions` | dotazy návštěvníků z chatbota, `since`, `limit`, `answered`, viz [kapitola 12](#12-analytika-chatbota-v-dashboardu) |
| GET | `/api/analytics/summary` | souhrn dotazů z chatbota, `since` |
| GET | `/api/prales/nastaveni` | nastavení deštného pralesa + náhled odpovědi + stav stahování venkovní teploty |
| PUT | `/api/prales/nastaveni` | uložení nastavení deštného pralesa, vrací stejný tvar jako GET |

Chyby se vrací jako JSON `{"chyba": "..."}`; frontend tuto hlášku zobrazuje
uživateli. Na `401` klient smaže lokální stav a přesměruje na `/login` (kromě
veřejného náhledu tabletu).

**`POST /api/displays/:id/refresh` je zatím mock**, zapíše jen záznam do audit
logu (`odesláno na displej`). Skutečné vypuzení obsahu na tablet přijde s Unity
integrací. Fyzicky je obsah na disku už ve chvíli uložení, takže tablet ho
načte při dalším čtení tak jako tak.

**SPA fallback:** cokoliv mimo `/api` a `/data` vrací `index.html` (aby fungovaly
adresy typu `/displeje/12`). Nenalezené cesty pod `/api` a `/data` vrací
`404 {"chyba":"Nenalezeno."}`.

---

## 17. Údržbové skripty

Spouštějí se z kořene repozitáře a **respektují `DATA_ROOT`**.

| Příkaz | Co dělá |
|---|---|
| `npm run seed` | **Destruktivní.** Smaže a znovu vygeneruje `data/displeje/1..37`. Displeje 1 až 3 dostanou obsah (`1_info`, `2_vid` prázdná galerie, `3_gal` s texty a fotkou, `4_ai`, `kb.md`), 4 až 37 jsou `Nepřiřazeno` bez slidů. Displeje s číslem dělitelným 11 dostanou `stav: "offline"`. Zakládá výchozí účet, pokud žádný neexistuje. |
| `npm run migrate` | Jednorázová migrace staré struktury (`cs/slide-1..6`, `text.md`, `kb.md` uvnitř slidu) na formát pro Unity. Zachová média (obrázky se převedou na PNG, první MP4 jde do `2_vid`), texty starých slidů připojí do `kb.md`. **Idempotentní**, displej bez složek `slide-*` přeskočí. |
| `npm run backfill --workspace server` | Doplní do existujících `meta.json` identifikaci pro chatbota (`name`, `druh`, `latin_name`, `category`) z `text.txt`. Idempotentní, médií ani textů se nedotýká. `section` (čeleď) nezná, tu doplní kurátor v UI. V kořenovém `package.json` zkratka není. |
| `npm run prevod-obsahu -- <vstup.txt> <vystup>` | Převede blokový textový soubor (`=== ČESKY === / === ENGLISH === / === POLSKI ===`, uvnitř číslo displeje a řádky `Klic: Hodnota` nebo `Klic - Hodnota`) na zdrojovou strukturu pro import plus `mapovani.json`. **Na datovou složku CMS nesahá.** Umí infopanel i textový slide a typ pozná podle klíčů v každém bloku (`--typ=info\|gal` to vynutí). Výchozí je nanečisto, zapíše se až s `--zapsat`. |
| `npm run prevod-kb -- <vstup.txt> <vystup>` | Převede blokový textový soubor se **znalostními bázemi** (blok začíná `=== DISPLEJ 27 ===`, zbytek je doslovný Markdown) na zdrojovou strukturu pro import plus `mapovani.json`. **Na datovou složku CMS nesahá.** Obsah bloku se NIJAK neparsuje, jinak by se rozsekaly řádky typu `- Velikost: 25 cm`. Jen čeština (`kb.md`). Výchozí je nanečisto, zapíše se až s `--zapsat`. |
| `npm run import-obsahu -- <zdroj> <mapovani.json>` | Hromadný import infopanelu, textového slidu a `kb.md` do CMS. Infopanel a textový slide ve všech třech jazycích, znalostní báze jen česky (`kb.en.md`/`kb.pl.md` import neřeší). Zdroj smí nést i **jen `kb.md`** — pak se páruje názvem složky a slidů se vůbec nedotkne. Výchozí je **nanečisto**, zapíše se až s `--zapsat`; displej, který už obsah daného typu má, se přeskočí, pokud se nepřidá `--prepsat`. Zapisuje výhradně přes `writeInfoPole()`/`writeGalPole()`/`writeKb()`, takže projde validací, kanonizací latiny, atomickým zápisem i auditem. Viz varování níž. |
| `npm run kb-check` | Kontrola strukturované znalostní báze, **jen čte**. Ověří, že seznam sekcí na serveru (`kbTemplate.ts`) je shodný s tím, podle kterého parsuje editor (`web/src/lib/kbSekce.ts`), že soubor v dohodnutém tvaru projde editorem bajt po bajtu, a že u **každého** `kb.md` v datech rozdělení do polí a složení zpátky neztratí řádek ani se s opakovaným uložením nenabaluje. |
| `npm run kb-ukazka -- <číslo>` | Vypíše, co strukturovaný editor udělá s konkrétním `kb.md`: co se objeví v polích, co nahlásí kurátorovi a co se uloží zpátky. Nic nezapisuje. |
| `npm run useradd -- …` / `npm run userlist` | Správa účtů, viz [kapitola 4](#4-účty-a-přihlašování). |

Reset demo dat:

```bash
rm -rf data/displeje data/audit.jsonl && npm run seed
```
### Formát zdrojové složky

```
zdroj/07-testus-testus/
  meta.json                 name, latin_name, section (LATINSKÁ čeleď)
  kb.md                     VOLITELNÉ, viz níž
  cs/1_info/text.txt        infopanel
  cs/1_gal/text.txt         textový slide „Informace"
  en/1_gal/text.txt         překlady, cs je povinná, en/pl volitelné
  pl/1_gal/text.txt
```

Číslo ve složce (`1_info`, `1_gal`) je **jen štítek**. Cílový slide se na
displeji hledá **podle typu**, ne podle čísla: existující `_info`/`_gal` se
přepíše, chybějící se založí na konci. Když má displej textových slidů víc
(na disku třeba `3_gal` i `4_gal`), zapíše se do prvního a plán to hlásí.

Zdrojová složka nemusí mít všechno. **Zdroj jen s textovým slidem, nebo jen
se znalostní bází, nepotřebuje latinské jméno ani sekci** a `writeInfoPole()`
se u něj vůbec nezavolá, takže se identita druhu v `meta.json` nemá jak
změnit; na displej se páruje názvem složky (importér ho bere jako druhý
párovací klíč vedle latinského jména).

Zdroj **jen se znalostní bází** vypadá takhle a vyrábí ho `npm run prevod-kb`:

```
zdroj/07-kb/
  meta.json                 prázdné {}, importér ho jen vyžaduje
  kb.md                     znalostní báze, česky
```

Sáhne se **jen na `kb.md` v kořeni displeje**. Infopanel, slidy, fotky, videa
ani identita druhu v `meta.json` se nezmění (jediné, co `writeKb()` do
`meta.json` zapíše, je `posledniZmena` a přerovnaný seznam slidů podle disku,
přesně jako při uložení z CMS). Displej s nedotčenou výchozí kostrou se za
„už má znalostní bázi" **nepovažuje**, takže se na něj zapíše bez `--prepsat`.

**Pozor na klíč `Celed`, který je v obou sadách a znamená pokaždé něco jiného:**

| Kde | Význam | Kam na disku |
|---|---|---|
| infopanel | **latinská** čeleď pro chatbota (`Ambystomatidae`) | `meta.json`, pole `section` |
| textový slide | **česká** čeleď pro návštěvníka (`Rosničkovití`) | řádek `Taxonomie:` v `text.txt` |

Blok, ve kterém je `Celed` sám a žádný jiný klíč, se nedá zařadit; převodník
ho odmítne a vyzve k `--typ`. Nikdy netipuje.

### Co import PŘEPÍŠE a co ne

Ověřeno na kopii dat. `--prepsat` **nemaže** galerie, videa, fotky, 3D sekvence
ani ostatní slidy: importér nikde nevolá `removeSlide()`, `deleteMedia()` ani
`deleteVideo()`, jen odemyká zámek „displej už má obsah, přeskakuji".

Zámek je **typově citlivý**: ptá se jen na typy obsahu, které zdroj opravdu
nese. Přidat textový slide na displej, který má vyplněný infopanel, proto
`--prepsat` nevyžaduje — nic se nepřepisuje. Kurátor tak nemusí odemykat
přepis všeho jen kvůli tomu, aby doplnil jeden typ obsahu.

Přepisuje se tohle, a je to potřeba vědět dopředu:

1. **`<jazyk>/<n>_info/text.txt` se přepíše CELÝ, nemerguje se.** Pole, které
   ve zdroji chybí, na displeji zmizí. Zdroj proto musí nést všech osm polí,
   i ta, která se nemění. Totéž platí pro `<n>_gal/text.txt`.
2. **`meta.section` se SMAŽE**, když zdrojový `meta.json` nemá `section`
   (`writeInfoPole()` prázdnou hodnotu maže). Tiše, bez hlášky. Vždycky proto
   `section` do zdroje dejte, i beze změny. **Zdroje jen s textovým slidem se
   to netýká**, ty `writeInfoPole()` nevolají.
3. **`kb.md` se přepíše**, ale jen když zdrojová složka má neprázdné `kb.md`.
   Když ho ve zdroji vynecháte, znalostní báze na disku zůstane nedotčená.

Fotka textového slidu, galerie ani video se nepřepisují nikdy: import řeší
jen texty. Plán u každého displeje vypisuje řádek `nedotčeno zůstane: …`.

Importér nemá přepínač „jen displej N": jede přes všechny podsložky zdroje.
Rozsah se omezuje tím, co ve zdrojové složce je.


---

## 18. Zálohování a obnova

Celý stav systému je **jedna složka**, `DATA_ROOT`. Záloha je tedy prosté
zkopírování:

```bash
tar czf amphibiarium-$(date +%F).tar.gz -C /srv/amphibiarium data
```

Zálohovat je vhodné se zastaveným serverem, nebo aspoň počítat s tím, že
souběžný upload může skončit v záloze rozepsaný.

Ve složce jsou i **citlivé soubory**, `users.json` (bcrypt hashe hesel) a
`session.key`. Zálohu je proto potřeba držet stejně chráněnou jako produkci.

Obnova = nakopírovat složku zpět a nastavit `DATA_ROOT`. Pokud se obnovuje
i `session.key`, zůstanou platné i dosud vydané session cookies; bez něj se
všichni odhlásí.

---

## 19. Řešení potíží

**`Web build nenalezen (…/web/dist). Spusť 'npm run build'.`**
Chybí buildnutý web. API běží, ale `/` vrátí 404. Řešení: `npm run build`
a restart (respektive v dev režimu pracovat na portu 5173).

**`Datová složka nenalezena (…/displeje).`**
`DATA_ROOT` ukazuje jinam, než kde data jsou, nebo se ještě neseedovalo.
Zkontrolujte hodnotu, kterou server vypíše při startu (`Datová složka: …`).

**`Žádné účty v data/users.json, do CMS se nedá přihlásit.`**
Založte účet: `npm run useradd -- <jmeno> <heslo>`. Pozor na shodný `DATA_ROOT`
mezi skriptem a serverem.

**Nejde se přihlásit, přestože heslo je správné.**
Ověřte `npm run userlist`, že účet je v té datové složce, nad kterou běží
server. Zkontrolujte také, jestli se v hesle neztratila mezera na kraji,
neořezává se.

**Všichni se najednou odhlásili.**
Změnil se podpisový klíč: buď se nastavil/odebral `SESSION_SECRET`, nebo se
smazal `session.key`. Původní cookies se tím zneplatní.

**Server nejde otevřít z jiného počítače.**
Výchozí `HOST=127.0.0.1` poslouchá jen lokálně. Nastavte `HOST=0.0.0.0`
a povolte port ve firewallu.

**`EADDRINUSE` při startu.**
Port 3000 už někdo drží (typicky předchozí instance). Ukončete ji, nebo nastavte
jiný `PORT`.

**Fotka se nenahraje, API vrací „Obrázek se nepodařilo převést do PNG."**
`sharp` daný formát nepřečetl. Typicky HEIC z iPhonu, ověření, jestli HEIC
projde, je na seznamu otevřených bodů (viz `handoff.md`). Řešení pro provoz:
převést na JPG před nahráním.

**Video se nenahraje.**
Přijímá se jen MP4 a maximálně 200 MB.

**Na disku zůstaly složky `.tmp-<n>_<typ>`.**
Proces spadl uprostřed přečíslování slidů. Server je ignoruje. Přejmenujte je
ručně na správné `<n>_<typ>` (nebo smažte, pokud jde o kopii).

**Slide se v CMS nezobrazuje.**
Název složky musí přesně odpovídat `<číslo>_<info|vid|gal|ai>`. Cokoliv jiného
(překlep, mezera, jiný typ) server přeskočí.

**Displej v seznamu chybí.**
Chybí nebo je poškozený `meta.json`, případně složka nemá čistě číselný název.

**`403 {"kod":"jmeno"}` u každého požadavku.**
Session je platná, ale není vybrané jméno (typicky se mezitím přihlásil někdo
jiný v jiné záložce). Klient na to reaguje návratem na obrazovku výběru jména;
ručně stačí jméno vybrat znovu.

**„Odhlášeno po hodině nečinnosti."**
Vypršelo okno nečinnosti (60 min od poslední interakce člověka). Není to chyba,
viz [kapitola 4](#4-účty-a-přihlašování). Když k tomu dochází uprostřed práce,
zkontrolujte, jestli prohlížeči nic neblokuje `POST /api/session/tep`.

**„Příliš mnoho pokusů o přihlášení" (429).**
Rate limit, 5 pokusů za 15 minut na IP + jméno. Počká se, nebo se heslo
resetuje z konzole, viz [kapitola 4](#4-účty-a-přihlašování). Restart serveru
počítadlo vynuluje (drží se v paměti).

**Všechny tablety hlásí „zatím se neozval".**
Server běží krátce (méně než 15 min) a tepy ještě nedorazily, nebo Unity na
`POST /api/displays/:id/heartbeat` neposílá. Viz
[kapitola 10](#10-tep-tabletů-heartbeat).

**Analytika je prázdná, přitom tablety běží.**
Ve složce `udalosti/unity/` nic není, nebo jsou v ní jen nečitelné řádky.
Oranžový pruh nad čísly říká, kolik displejů posílá čitelná data. Zapisuje to
Unity, ne CMS.

**Analytika ukazuje jiná čísla než včera za stejné období.**
Denní souhrny v `analytika/` jsou poškozené nebo se přepočítaly z neúplného
logu. Složku lze **smazat**, dopočítá se z `udalosti/`. Data se tím neztratí.

**Fotka má odznak „neoříznuto".**
Nemá záznam ve `.vyrezy.json` (nahraná starším CMS nebo ručně do složky).
Stačí v editoru jednou nastavit výřez, viz
[kapitola 6](#6-formáty-souborů).

**Ořez sekvence 3D modelu se „zasekl".**
Průběh se drží v paměti procesu; po restartu serveru vrací `GET .../vyrez-sekvence`
`stav: null`, i když ořez předtím doběhl. Stačí se podívat, jestli mají snímky
odznak „neoříznuto", a případně ořez pustit znovu.

**Video v díře v zemi se nepřehrává.**
Ve složce `Cervori`/`Paleonaleziste` musí být **právě jeden** `.mp4`. Upload
starší soubory maže sám; když se tam něco doplnilo ručně, přehrávač si vybere
sám a nemusí to být to nové.

---

## 20. Známá omezení

Stav k **21. 9. 2026**, otevřené body jsou i v `handoff.md`.

- **Odeslání na displej je mock**, `/api/displays/:id/refresh` jen zapíše audit.
  Fyzicky je obsah na disku už ve chvíli uložení, takže si ho tablet načte při
  dalším čtení tak jako tak.
- **Reingest chatbota je vypnutý**, dokud se nedomluví rozhraní s chatbotem.
- **Analytika chatbota závisí na cizím backendu.** Dokud Danielova služba
  neběží, stránka to napíše a zbytek CMS funguje bez omezení, viz
  [kapitola 12](#12-analytika-chatbota-v-dashboardu). Vlastní analytika
  návštěvnosti z událostí Unity je na tom nezávislá.
- **Správa účtů je jen z příkazové řádky**, v UI zatím není. (Seznam **jmen**
  lidí se v UI edituje, to je něco jiného, viz
  [kapitola 4](#4-účty-a-přihlašování).)
- **Server nedělá HTTPS** a session cookie nemá příznak `secure`. Pro provoz
  mimo důvěryhodnou síť patří za reverzní proxy s TLS.
- **Tepy tabletů se nikam neukládají.** Po restartu serveru je přehled stavů
  prázdný a plní se až došlými tepy; historii dostupnosti tedy CMS nemá, viz
  [kapitola 10](#10-tep-tabletů-heartbeat).
- **Formát událostí z Unity není verzovaný.** Čtení je tolerantní a poškozené
  řádky hlásí, ale kdyby Michal změnil názvy polí, poznáme to až podle
  oranžového pruhu v Analytice.
- **`stav` v `meta.json` je pozůstatek** z doby před tepem. Zapisuje ho jen
  `seed`/`migrate`, nikde se nevyhodnocuje a čeká na smazání.
- **Seznam sekcí je zdvojený** v `server/src/displays.ts` a `web/src/lib/types.ts`
  — při změně je nutné upravit obě místa, jinak editor nabídne hodnotu, kterou
  server odmítne.
- **Slide typu `_txt` je pozůstalý.** Nový nejde založit, existující se dál
  čtou a editují.

### Co už omezení NENÍ

Tyhle body tu stály dřív a dnes už neplatí; nechávám je vypsané, aby se
nepředávaly dál z poznámek nebo ze staršího `README.md`:

| Dřívější omezení | Stav dnes |
|---|---|
| „Stav tabletů není živý, dashboard ho neukazuje" | Ukazuje. Tep tabletů, čtyři stavy, viz [kapitola 10](#10-tep-tabletů-heartbeat). |
| „Vícejazyčnost není hotová, na disku je jen `cs/`" | Na disku jsou `cs/`, `en/`, `pl/`, editor mezi nimi přepíná a hlídá, co v kterém jazyce chybí. Média zůstávají společná v `cs/`. |
| „Náhled tabletu není v poměru 3:2" | Je. `web/src/pages/Tablet.tsx` jede na fixním rámu 1200 × 800. |
| „Přihlašování nemá rate limiting" | Má: 5 pokusů za 15 minut na IP + jméno. |
| „Audit log nemá rotaci a načítá se celý" | Rotuje po 5 MB (12 archivů) a čte se od konce po stránkách. |
| „Fotky v galerii si drží příponu" | Všechny fotky se ukládají jako PNG, Unity jiný formát nepřečte. |
| „Fotky se neořezávají" | Ořez je hotový včetně hromadného ořezu 3D sekvence, viz [kapitola 6](#6-formáty-souborů). |
| „V CMS není analytika návštěvnosti" | Je, z událostí Unity, viz [kapitola 11](#11-analytika-návštěvnosti). |
