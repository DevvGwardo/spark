import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "out",
      "release",
      "dist-electron",
      // Generated / vendored dirs (the bare names above only match at the
      // config root; these catch nested copies and virtualenvs).
      "**/dist",
      "**/e2e-results",
      "**/playwright-report",
      "**/venv",
      "**/.venv",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": "warn",
    },
  },
  {
    // Plain JS (scripts/*.cjs, postcss.config.js, root test scripts) previously
    // matched no config block and escaped all rules.
    extends: [js.configs.recommended],
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
  },
  {
    // Electron main process: deny-by-default IPC. Every invoke handler must go
    // through trustedHandle(channel, handler) from ./index, which gates on the
    // main window's trusted sender. Bare ipcMain.handle is banned.
    files: ["electron/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='ipcMain'][callee.property.name='handle']",
          message: "use trustedHandle(channel, handler) from ./index (deny-by-default IPC)",
        },
      ],
    },
  },
);
