// Focused lint gate: catch the React Rules-of-Hooks class (the #310 crash — hooks after an early return,
// in a conditional, or in a loop) at BUILD time, since this repo is deploy-only and can't render the SPA
// locally. Deliberately NOT a full style regime — only the hooks rules — so `npm run lint` fails on the
// one class that reaches prod, not on pre-existing style debt. `rules-of-hooks` is error (the crash guard);
// `exhaustive-deps` is warn for now (a stale-closure smell, not a crash) and `npm run lint` treats it as a
// hard fail via --max-warnings=0, so tighten/triage together.
import reactHooks from "eslint-plugin-react-hooks";
import tsparser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // rules-of-hooks = the #310 crash guard. exhaustive-deps promoted to error now the slate is clean
      // (stale-closure smells fail the gate); use a scoped `// eslint-disable-next-line` with a reason for
      // a genuinely-intentional omission rather than loosening this back to a warning.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
