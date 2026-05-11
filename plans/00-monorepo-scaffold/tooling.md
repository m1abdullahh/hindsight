# Monorepo — Tooling

## Versions (pinned)

| Tool        | Version          | Rationale                                                 |
| ----------- | ---------------- | --------------------------------------------------------- |
| Node        | 20 LTS           | [docs/03-tech-stack.md:9](../../docs/03-tech-stack.md#L9) |
| pnpm        | ^9               | Workspace + filter ergonomics                             |
| TypeScript  | ^5.5             | Strict mode default                                       |
| ESLint      | ^9 (flat config) | Modern config, no `.eslintrc`                             |
| Prettier    | ^3               |                                                           |
| husky       | ^9               | Pre-commit hooks                                          |
| lint-staged | ^15              | Run lint/format on staged files only                      |
| commitlint  | ^19              | Conventional commits enforcement                          |

## `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "paths": {
      "@hindsight/shared": ["./packages/shared/src/index.ts"],
      "@hindsight/shared/*": ["./packages/shared/src/*"]
    }
  }
}
```

Each app extends with its own DOM/Node libs and `outDir`.

## ESLint (flat config, `eslint.config.js`)

Stack:

- `@eslint/js` recommended
- `typescript-eslint` strict + stylistic
- `eslint-plugin-import` — order, no-cycle
- `eslint-config-prettier` — disables format rules

Rules to set explicitly:

- `import/order` — groups + alphabetize
- `@typescript-eslint/no-unused-vars` — error, allow `^_`
- `@typescript-eslint/consistent-type-imports` — error
- `no-console` — warn (overridden in workers / scripts)

## Prettier (`.prettierrc`)

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf"
}
```

## Husky + lint-staged

`.husky/pre-commit`:

```sh
pnpm lint-staged
```

`package.json`:

```json
"lint-staged": {
  "*.{ts,tsx,js,jsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml,css}": ["prettier --write"]
}
```

## commitlint

`commitlint.config.cjs`:

```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

Hook in `.husky/commit-msg`:

```sh
pnpm exec commitlint --edit "$1"
```

Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`, `build`. Matches [README.md:112](../../README.md#L112).

## Per-app `package.json` skeletons

All four expose the same script names so the root `pnpm -r` calls work uniformly:

```json
{
  "name": "@hindsight/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "echo \"todo: filled by plan 01\"",
    "build": "tsc -p tsconfig.json",
    "test": "echo \"no tests yet\"",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

`packages/shared/package.json` has no `dev` script, exports `./src/index.ts` as `main` + `types`.

## `.gitignore` highlights

```
node_modules
dist
.env
.env.local
*.log
coverage
.turbo
.cache

# Tauri
apps/desktop/src-tauri/target
apps/desktop/dist

# OS
.DS_Store
Thumbs.db
```

## Acceptance

- `pnpm install` succeeds clean
- `pnpm lint` and `pnpm -r typecheck` pass on the empty workspace
- `git commit -m "bad message"` is blocked by commitlint
- A staged `*.ts` with a lint error is auto-fixed (or blocks the commit if unfixable)
