/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Rustica je firemní font pavilonu, @font-face je v src/index.css.
        // Náhradní řada je schválně dlouhá: kdyby se otf nenačetlo, má web
        // spadnout na systémový font stroje (Segoe UI na Windows, kde CMS
        // běží), ne na patkový výchozí font prohlížeče.
        //
        // Rustica má jen dva řezy, 400 a 700. Tailwind ale používá i 500
        // a 600 — prohlížeč je podle pravidel CSS napáruje na nejbližší
        // dostupný, takže font-medium vyjde jako Regular a font-semibold
        // jako Bold. Je to očekávané, ne chyba vykreslení.
        sans: ["Rustica", "system-ui", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
        display: ["Rustica", "system-ui", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
      },
      colors: {
        // Editorial: čistá bílá plocha, struktura jen vlasovými linkami.
        bg: "#FFFFFF", // plocha
        surface: "#FFFFFF", // popovery, toasty
        elevated: "#FFFFFF",
        canvas: "#FAFBFA", // jemný off-white pro výjimečné odlišení
        line: "#E6E9E7", // vlasové linky
        lineSoft: "#F0F2F1",

        // Primární značková zelená (klidná, ne neonová).
        accent: {
          DEFAULT: "#0F766E", // teal-green 700
          hi: "#0B5E58",
          dim: "#5FA39A",
          soft: "#E6F2F0", // světlá výplň
        },
        // Sekundární akcent (upozornění).
        amber: {
          DEFAULT: "#C2740C", // ikony a linky (grafika, stačí 3:1)
          // Tentýž odstín ztmavený pro TEXT: #C2740C má na bílé jen 3,6:1,
          // což je pod WCAG AA pro běžný text. Tenhle má 6,4:1.
          deep: "#8A5208",
          soft: "#FBF1E2",
        },
        danger: {
          DEFAULT: "#DC2626",
          soft: "#FCEBEA",
        },

        // Text.
        fg: {
          DEFAULT: "#16302B", // tmavě slate-green, primární
          muted: "#586B66", // sekundární
          dim: "#8A9994", // tlumený
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,40,34,0.04), 0 1px 3px rgba(16,40,34,0.05)",
        cardHover: "0 8px 24px -8px rgba(16,40,34,0.14), 0 2px 6px rgba(16,40,34,0.06)",
        focus: "0 0 0 3px rgba(15,118,110,0.14)",
        // Decentní zvýraznění místo neonového glow (zachování názvů tříd).
        glowSm: "0 1px 3px rgba(15,118,110,0.22)",
        glow: "0 0 0 3px rgba(15,118,110,0.12)",
        glowAmber: "0 1px 3px rgba(194,116,12,0.22)",
        inset: "inset 0 1px 0 rgba(255,255,255,0.6)",
      },
      borderRadius: {
        "2xl": "1rem",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        fadeIn: "fadeIn 0.18s ease-out",
      },
    },
  },
  plugins: [],
};
