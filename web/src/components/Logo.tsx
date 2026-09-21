// Značka ZOO Ostrava. Soubor leží v web/public/znacka/, servíruje se tedy
// z /znacka/logo-transparent.png. Dřív tu byla kreslená zelená kapka v SVG;
// tu nahradil skutečný znak, takže se logo nikde v kódu nekreslí.
//
// POUŽÍVEJ logo-transparent.png, ne logo.jpeg vedle něj. Ten jpeg je
// předloha od grafika: průhlednost neumí, takže je v něm pozadí vykreslené
// jako šachovnice bílá/šedá, a po kompresi má kolem kresby smítka.
//
// PNG z něj vzniklo strojově a POZADÍ SE POZNÁVÁ PODLE NEUTRÁLNOSTI
// (r = g = b), ne podle jasu. První pokus klíčoval přes max(r,g,b) a přišel
// o půlku znaku: oranžová (254,132,3) i červená (253,82,94) mají v tom
// kanálu 255 stejně jako bílé pozadí, takže se odmazaly s ním a zbyl jen
// tyrkys se zelenou. Ornament má čtyři syté barvy — tyrkys (2,150,131),
// zelenou (57,172,20), oranžovou (254,132,3) a červenou (253,82,94) —
// a každý pixel je směs jedné z nich s neutrálním pozadím. Ze směru
// odchylky od neutrální osy se pozná barva, z její délky krytí; pixel pak
// dostane čistou barvu z palety a spočítanou alfu, takže na hranách
// nezůstává přimíchaná šedá. Až přijde nová verze znaku, nejlepší je
// vyžádat si rovnou PNG nebo SVG s průhledností.
//
// Velikost se řídí VÝŠKOU, šířka dopočítá poměr stran (znak je na výšku,
// 231 × 326). Kdyby se zadávala i šířka, ornament by se roztáhl.
//
// Logo je dekorace: hned vedle něj vždycky stojí název „Amphibiárium",
// takže pro odečítač obrazovky je to duplicita — proto prázdné alt
// a aria-hidden.
export function LogoMark({ size = 36 }: { size?: number; glow?: boolean }) {
  return (
    <img
      src="/znacka/logo-transparent.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ height: size }}
      className="w-auto shrink-0 select-none"
    />
  );
}

export function Wordmark({ subtitle }: { subtitle?: string }) {
  return (
    <div className="leading-tight">
      <div className="font-display text-sm font-bold tracking-tight text-fg">Amphibiárium</div>
      {subtitle && <div className="text-[11px] font-medium text-fg-dim">{subtitle}</div>}
    </div>
  );
}
