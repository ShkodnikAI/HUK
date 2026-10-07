import next from "eslint-config-next";

const nextConfig = Array.isArray(next) ? next : [next];

// H-109 (S8): AST-level ban on every spelling of a direct environment read
// outside the sanctioned reader src/server/env.ts and the single marked line
// in src/instrumentation.ts (marker H-107-EXCEPTION, disabled inline below
// the rule name). Catches what a text grep cannot: computed members,
// destructuring, aliasing, runtimes like Bun/Deno and import.meta.
// The text-level CI guard scripts/ci/check-no-process-env.mjs keeps counting
// the markers (the exception must stay single) and ignores comments/strings.
const envReadMessage =
  "S8: read the environment through loadEnv() from src/server/env.ts — direct environment reads are banned outside it (H-107/H-109).";

const noEnvReadSelectors = [
  {
    // process.env and process?.env
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message: envReadMessage,
  },
  {
    // process["env"] and process?.["env"]
    selector:
      "MemberExpression[object.name='process'][computed=true][property.type='Literal'][property.value='env']",
    message: envReadMessage,
  },
  {
    // globalThis.process (any further .env chain is covered by this)
    selector: "MemberExpression[object.name='globalThis'][property.name='process']",
    message: envReadMessage,
  },
  {
    // globalThis["process"]
    selector:
      "MemberExpression[object.name='globalThis'][computed=true][property.type='Literal'][property.value='process']",
    message: envReadMessage,
  },
  {
    // const { env } = process  (destructuring)
    selector: "VariableDeclarator[init.name='process'][id.type='ObjectPattern']",
    message: envReadMessage,
  },
  {
    // ({ env } = process)  (destructuring assignment)
    selector:
      "AssignmentExpression[operator='='][right.name='process'][left.type='ObjectPattern']",
    message: envReadMessage,
  },
  {
    // const p = process  (aliasing)
    selector: "VariableDeclarator[init.name='process']:not([id.type='ObjectPattern'])",
    message: envReadMessage,
  },
  {
    // p = process  (aliasing assignment)
    selector:
      "AssignmentExpression[operator='='][right.name='process']:not([left.type='ObjectPattern'])",
    message: envReadMessage,
  },
  {
    // Bun.env and Bun["env"]
    selector: "MemberExpression[object.name='Bun'][property.name='env']",
    message: envReadMessage,
  },
  {
    selector:
      "MemberExpression[object.name='Bun'][computed=true][property.type='Literal'][property.value='env']",
    message: envReadMessage,
  },
  {
    // Deno.env and Deno["env"]
    selector: "MemberExpression[object.name='Deno'][property.name='env']",
    message: envReadMessage,
  },
  {
    selector:
      "MemberExpression[object.name='Deno'][computed=true][property.type='Literal'][property.value='env']",
    message: envReadMessage,
  },
  {
    // import.meta.env (Vite-style) and import.meta["env"]
    selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
    message: envReadMessage,
  },
  {
    selector:
      "MemberExpression[object.type='MetaProperty'][computed=true][property.type='Literal'][property.value='env']",
    message: envReadMessage,
  },
];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "legacy/**",
      "scripts/**",
      "prisma/migrations/**",
    ],
  },
  ...nextConfig,
  {
    files: ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": ["error", ...noEnvReadSelectors],
    },
  },
  {
    // H-105: UI strings must go through next-intl message catalogs. A small
    // local no-restricted-syntax selector (chosen over a third-party plugin —
    // no dependency, exact semantics): any JSXText containing non-whitespace
    // is an error, so visible literals cannot sneak into components.
    files: ["src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noEnvReadSelectors,
        {
          selector: "JSXText[value=/\\S/]",
          message:
            "i18n: UI strings must come from the message catalogs via useTranslations/getTranslations (H-105).",
        },
      ],
    },
  },
  {
    // The sanctioned reader: every spelling is allowed here (H-107/H-109).
    files: ["src/server/env.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];

export default config;
