import { DATA_ROOT } from "./paths.js";
import {
  MIN_DELKA_HESLA,
  USERS_FILE,
  pridejUzivatele,
  readUsers,
  smazUzivatele,
  zmenHeslo,
} from "./users.js";

// Správa účtů kurátorů z příkazové řádky. Účty se zapisují do
// data/users.json (heslo vždy jen jako bcrypt hash).
//
//   npm run useradd -- jmeno heslo               založí nový účet
//   npm run useradd -- jmeno noveheslo --zmenit-heslo   změní heslo
//   npm run useradd -- --smazat jmeno            smaže účet
//   npm run userlist                             vypíše účty
//
// Pozn.: heslo zadané na příkazové řádce zůstává v historii shellu. Po
// založení účtu je dobré historii vyčistit, nebo heslo hned změnit v klidu.

const NAPOVEDA = `
Správa účtů CMS Amphibiárium (data/users.json)

  npm run useradd -- <jmeno> <heslo>                  založí nový účet
  npm run useradd -- <jmeno> <heslo> --zmenit-heslo   změní heslo existujícího účtu
  npm run useradd -- --smazat <jmeno>                 smaže účet
  npm run userlist                                    vypíše existující účty

Jméno: 2 až 32 znaků (písmena, číslice, tečka, pomlčka, podtržítko).
Heslo: aspoň ${MIN_DELKA_HESLA} znaků.
`;

async function vypisSeznam(): Promise<void> {
  const uzivatele = await readUsers();
  if (uzivatele.length === 0) {
    console.log(`Zatím žádné účty (${USERS_FILE}).`);
    console.log('Založte první: npm run useradd -- spravce "silne-heslo"');
    return;
  }
  console.log(`Účty v ${USERS_FILE}:`);
  for (const u of uzivatele) {
    const zmeneno = u.zmeneno ? `, heslo změněno ${u.zmeneno}` : "";
    console.log(`  ${u.jmeno}  (založeno ${u.vytvoreno}${zmeneno})`);
  }
  console.log(`Celkem: ${uzivatele.length}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(NAPOVEDA.trim());
    return;
  }
  if (argv.includes("--seznam")) {
    await vypisSeznam();
    return;
  }

  const zmenit = argv.includes("--zmenit-heslo");
  const smazat = argv.includes("--smazat");
  const pozicni = argv.filter((a) => !a.startsWith("--"));

  console.log(`Datová složka: ${DATA_ROOT}`);

  if (smazat) {
    const [jmeno] = pozicni;
    if (!jmeno) {
      console.error("Chybí jméno. Použití: npm run useradd -- --smazat <jmeno>");
      process.exit(1);
    }
    const res = await smazUzivatele(jmeno);
    if (!res.ok) {
      console.error(`Chyba: ${res.chyba}`);
      process.exit(1);
    }
    console.log(`Účet "${jmeno}" smazán.`);
    return;
  }

  const [jmeno, heslo] = pozicni;
  if (!jmeno || !heslo) {
    console.error(NAPOVEDA.trim());
    process.exit(1);
  }

  const res = zmenit ? await zmenHeslo(jmeno, heslo) : await pridejUzivatele(jmeno, heslo);
  if (!res.ok) {
    console.error(`Chyba: ${res.chyba}`);
    if (!zmenit && res.chyba?.includes("už existuje")) {
      console.error(`Heslo změníte: npm run useradd -- ${jmeno} <noveheslo> --zmenit-heslo`);
    }
    process.exit(1);
  }

  console.log(
    zmenit ? `Heslo účtu "${jmeno}" změněno.` : `Účet "${jmeno}" založen (heslo uloženo jako bcrypt hash).`,
  );
  console.log(`Soubor: ${USERS_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
