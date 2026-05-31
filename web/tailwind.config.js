/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0f172a",
        muted: "#64748b",
        line: "#e7ebf0",
        surface: "#f8fafc",
        paper: "#fbfaf8",
        accent: "#2563eb",
        "accent-soft": "#eff4ff",
        safe: "#16a34a",
        warn: "#d97706",
        danger: "#dc2626",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.04), 0 4px 16px rgba(15,23,42,0.06)",
      },
    },
  },
  plugins: [],
};
