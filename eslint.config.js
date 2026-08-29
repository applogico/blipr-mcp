import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        // vitest.config.ts belongs to no tsconfig; the rest resolve to src/ or test/.
        projectService: { allowDefaultProject: ["vitest.config.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      complexity: ["error", 8],
      "max-depth": ["error", 3],
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      // Status codes and timeouts read fine interpolated; the rest of the strict checks stay on.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // A `describe` block is a suite, not a function — line counts say nothing here.
      "max-lines-per-function": "off",
      // fetch mocks must hand back a promise; `async` is how they say so.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/server.ts"],
    rules: {
      // Ratchet at createServer's current size; the target is the global 60, reached by splitting it per tool.
      "max-lines-per-function": ["error", { max: 251, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // This config file is plain JS with no tsconfig behind it; nothing to type-check.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
