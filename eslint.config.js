import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat ESLint config. TypeScript-aware (non type-checked, so it stays fast and
 * needs no parserOptions.project), with Prettier last to switch off any rules
 * that would fight the formatter. Vendored JS (addons/) and build output are
 * excluded.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "dist-game/**", "node_modules/**", "addons/**", "public/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Build/maintenance scripts run under Node, not the browser, so they legitimately reach for
    // `process`, `console`, `fetch` and timers.
    files: ["scripts/**/*.mjs", "tools/**/*.mjs", "*.config.{js,mjs,ts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // No-op lifecycle seams (reserved hooks) are intentional in this codebase.
      "@typescript-eslint/no-empty-function": "off",
      // Allow deliberately-unused args/vars when prefixed with `_` (reserved hook
      // params such as the room-service seams).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
