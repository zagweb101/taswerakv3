import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ====================================================================
// ESLint config — gradual re-enablement of important rules
//
// Phase 1 (this commit): re-enable rules that are safe to enforce.
// Phase 2 (next): re-enable as warnings to surface tech debt.
// Phase 3 (final): promote warnings to errors after cleanup.
// ====================================================================

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // ---------- Phase 1: ERRORS (real bugs that should never ship) ----------
    "no-debugger": "error",
    "no-unreachable": "error",
    "no-useless-escape": "error",
    "no-fallthrough": "error",
    "prefer-const": "error",
    "@typescript-eslint/prefer-as-const": "error",

    // ---------- Phase 2: WARNINGS (surface tech debt, don't break CI) ----------
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-empty": "warn",
    "no-case-declarations": "warn",
    "@typescript-eslint/ban-ts-comment": "warn",
    "no-irregular-whitespace": "warn",
    "no-mixed-spaces-and-tabs": "warn",
    "no-redeclare": "warn",

    // ---------- Still disabled (too many violations to fix now) ----------
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-undef": "off", // TypeScript handles this better than ESLint

    // React rules — keep off for now
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
  },
}, {
  ignores: [
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "skills",
    "mockups/**",
    "mini-services/**",
    "tailwind.config.ts", // has pre-existing mixed indentation
  ],
}];

export default eslintConfig;
