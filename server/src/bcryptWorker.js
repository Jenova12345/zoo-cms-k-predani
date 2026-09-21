// Vlákno, ve kterém se počítá bcrypt. Schválně obyčejný JavaScript, ne
// TypeScript: worker si Node načítá sám a nemá projít přes tsx loader.
//
// Protokol je minimální: { id, op: "hash" | "over", heslo, hash, cost }
// dovnitř, { id, vysledek } nebo { id, chyba } ven.
import { parentPort } from "node:worker_threads";
import { compare, hash } from "bcryptjs";

parentPort.on("message", async (zprava) => {
  const { id, op } = zprava;
  try {
    const vysledek =
      op === "hash"
        ? await hash(zprava.heslo, zprava.cost)
        : await compare(zprava.heslo, zprava.hash);
    parentPort.postMessage({ id, vysledek });
  } catch (err) {
    parentPort.postMessage({ id, chyba: err instanceof Error ? err.message : String(err) });
  }
});
