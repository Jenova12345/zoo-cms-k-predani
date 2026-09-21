// Limity nahrávaných souborů, jak je vidí kurátor.
//
// ZDROJ PRAVDY je server: `limits.fileSize` u registrace @fastify/multipart
// v server/src/index.ts. Tady je ta hodnota jen zopakovaná pro UI (a pro
// kontrolu ještě před odesláním, ať kurátor nečeká na upload, který stejně
// spadne). Když se limit změní na serveru, změň ho i tady, je to jediné
// místo ve webu, kde se limit píše.
export const NAHRAVANI_MAX_MB = 200;
export const NAHRAVANI_MAX_B = NAHRAVANI_MAX_MB * 1024 * 1024;

// Velikost souboru pro hlášku ("243,7 MB").
export function vMB(bajtu: number): string {
  const mb = bajtu / (1024 * 1024);
  return `${mb.toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} MB`;
}
