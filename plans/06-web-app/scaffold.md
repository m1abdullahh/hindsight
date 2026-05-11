# Web App — Scaffold

The scaffold lands the build tooling, dependency tree, and the empty entry points that every later step in this plan plugs into. Goal: at the end of this file, `pnpm --filter @hindsight/web dev` serves an empty Tailwind page with TanStack Router rendering a placeholder.

## Dependencies

Run from the repo root, scoped to the web workspace:

```sh
pnpm --filter @hindsight/web add \
  react@18 react-dom@18 \
  @tanstack/react-router @tanstack/router-devtools \
  @tanstack/react-query @tanstack/react-query-devtools \
  zustand \
  react-hook-form @hookform/resolvers zod \
  date-fns \
  recharts \
  lucide-react \
  class-variance-authority clsx tailwind-merge

pnpm --filter @hindsight/web add -D \
  vite @vitejs/plugin-react \
  typescript@~5.4 \
  @tanstack/router-plugin \
  tailwindcss postcss autoprefixer \
  @types/react @types/react-dom \
  vitest jsdom @testing-library/react @testing-library/user-event \
  msw
```

Pin major versions in `package.json` after install — `react@18`, `tanstack/react-router@^1`, `vitest@^1`. These are stable lines; we don't auto-bump majors.

## `apps/web/package.json`

Replace the placeholder file with:

```json
{
  "name": "@hindsight/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "preview": "vite preview --port 4173",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hindsight/shared": "workspace:*"
  }
}
```

(The full dependency block is whatever pnpm wrote in step 1 — keep `@hindsight/shared` as a workspace dep at the top of the list for greppability.)

## `apps/web/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "paths": {
      "@/*": ["./src/*"],
      "@hindsight/shared": ["../../packages/shared/src/index.ts"],
      "@hindsight/shared/*": ["../../packages/shared/src/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
```

The `@/*` path alias is a Vite + shadcn convention. Tailwind's content scan and shadcn's component generator both expect it.

## `apps/web/vite.config.ts`

```ts
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

The dev-server proxies `/api/*` to the API so the browser sees a same-origin URL. In production the SPA is served from a different host than the API; `VITE_API_BASE_URL` (see env vars below) takes over.

## Tailwind + shadcn

```sh
pnpm --filter @hindsight/web exec tailwindcss init -p
pnpm --filter @hindsight/web exec shadcn@latest init
```

`tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};
export default config;
```

`shadcn` writes a `components.json`. Set:

- `style: "new-york"` (preference; both styles work)
- `tailwind.cssVariables: true` (we want themability via CSS vars)
- `aliases.components: "@/components"`
- `aliases.utils: "@/lib/utils"`

`src/lib/utils.ts` (shadcn's helper) ends up exporting `cn(...inputs)` — used by every shadcn component.

## Entry points

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hindsight</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:

```ts
import './globals.css';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { queryClient } from '@/lib/query';
import { routeTree } from './routeTree.gen';

const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
```

`routeTree.gen.ts` is auto-generated by `@tanstack/router-plugin`; it watches the `src/routes/` tree. Don't hand-edit. Add it to `.gitignore` (the file regenerates on `pnpm dev` and `pnpm build`).

`src/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --radius: 0.5rem;
  }
}
```

Default shadcn HSL token values, light theme. Dark-mode tokens added later.

## Environment variables

`apps/web/.env.example`:

```
# The API origin the SPA talks to in production builds.
# Dev uses the Vite proxy so this is unset (or http://localhost:3000).
VITE_API_BASE_URL=

# Optional override for the dev proxy target. Most devs leave this unset.
VITE_API_PROXY_TARGET=
```

Vite only exposes vars prefixed with `VITE_` to the client bundle — other env vars are inert. Add `apps/web/.env.example` to the workspace root .env.example reference in [docs/03-tech-stack.md](../../docs/03-tech-stack.md) when this plan merges.

## Scripts that should pass after this step

- `pnpm --filter @hindsight/web typecheck` — green (no source files yet beyond `main.tsx` + a placeholder root route).
- `pnpm --filter @hindsight/web dev` — Vite boots; navigating to `http://localhost:5173/` renders the placeholder root route.
- `pnpm --filter @hindsight/web build` — produces `apps/web/dist/index.html` + a small JS chunk.

The next file ([api-client.md](./api-client.md)) layers the fetch wrapper, query client, and session store on top of this skeleton.
