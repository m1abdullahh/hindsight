# Desktop MVP — Scaffold

The scaffold lands the Tauri 2 build tooling, Rust crates, and the empty React shell that the rest of the plan plugs into. End state: `pnpm --filter @hindsight/desktop tauri:dev` opens an empty Tauri window with a single "Hindsight" placeholder.

## Tauri 2 init

Tauri 2 uses a `src-tauri/` directory next to the JS code. We adapt the standard layout to fit our monorepo:

```
apps/desktop/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/                    # React UI
│   ├── main.tsx
│   ├── App.tsx
│   └── components/
└── src-tauri/              # Rust side
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    ├── icons/
    ├── migrations/
    │   └── 001_outbox.sql
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── capture.rs
        ├── activity.rs
        ├── auth.rs
        ├── db.rs
        ├── scheduler.rs
        └── uploader.rs
```

Initial scaffold via the official template, then adapted:

```sh
pnpm --filter @hindsight/desktop add -D \
  @tauri-apps/cli@^2 \
  vite@^5 \
  @vitejs/plugin-react@^4 \
  typescript@~5.7 \
  @types/react @types/react-dom

pnpm --filter @hindsight/desktop add \
  @tauri-apps/api@^2 \
  @tauri-apps/plugin-shell@^2 \
  @tauri-apps/plugin-os@^2 \
  react@18 react-dom@18 \
  zustand@^4 zod@^3 \
  date-fns@^3 \
  lucide-react@latest \
  clsx tailwind-merge

# Tailwind for UI parity with the web app
pnpm --filter @hindsight/desktop add -D \
  tailwindcss@^3 postcss autoprefixer
```

Run the Tauri scaffolder once to produce a baseline `src-tauri/`:

```sh
pnpm --filter @hindsight/desktop exec tauri init \
  --app-name "Hindsight" \
  --window-title "Hindsight" \
  --frontend-dist "../dist" \
  --dev-url "http://localhost:1420" \
  --before-dev-command "pnpm dev:vite" \
  --before-build-command "pnpm build:vite"
```

(Then commit `src-tauri/` and edit it directly going forward — don't re-run `tauri init`.)

## `apps/desktop/package.json`

```json
{
  "name": "@hindsight/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:vite": "vite",
    "build:vite": "tsc -p tsconfig.json --noEmit && vite build",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "preview": "vite preview --port 1420",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@hindsight/shared": "workspace:*"
  }
}
```

(The full deps list ends up matching `pnpm add` outputs above. Keep `@hindsight/shared` first for greppability.)

## `apps/desktop/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "moduleResolution": "Bundler",
    "module": "ESNext",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["vite/client"],
    "paths": {
      "@/*": ["./src/*"],
      "@hindsight/shared": ["../../packages/shared/src/index.ts"],
      "@hindsight/shared/*": ["../../packages/shared/src/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
```

Same `paths` shape as the web app so DTO imports work identically.

## `apps/desktop/vite.config.ts`

```ts
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const apiBaseUrl = process.env['VITE_API_BASE_URL'] ?? 'http://localhost:3001';
const appVersion = process.env['npm_package_version'] ?? '0.0.0';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@hindsight/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@hindsight/shared/dto': fileURLToPath(
        new URL('../../packages/shared/src/dto.ts', import.meta.url),
      ),
    },
  },
  define: {
    __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // Tauri uses a fixed dev port to wire its window to.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
```

Notes:

- **Port 1420** is the Tauri convention. Don't change it.
- API base URL defaults to `http://localhost:3001` for dev; production builds inject the real origin via `VITE_API_BASE_URL=https://api.hindsight.app pnpm tauri:build`.
- We _don't_ use a Vite proxy because the packaged app makes real HTTPS calls — keeping dev and prod paths the same avoids "works in dev, breaks in prod" surprises.

## `src-tauri/Cargo.toml`

```toml
[package]
name = "hindsight"
version = "0.1.0"
description = "Hindsight desktop tracker"
edition = "2021"
rust-version = "1.77"

[lib]
name = "hindsight_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-os = "2"

# Capture + image encoding
screenshots = "0.8"
image = { version = "0.25", default-features = false, features = ["jpeg"] }

# Local outbox + upload
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite", "macros", "chrono"] }
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }

# Idle detection (cross-platform; uses GetLastInputInfo on Windows)
user-idle = "0.6"

# Credential Manager for the device token
keyring = "3"

# Logging + JSON
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# Errors, IDs, time
thiserror = "1"
ulid = "1"
chrono = { version = "0.4", features = ["serde"] }
parking_lot = "0.12"
rand = "0.8"

[target.'cfg(target_os = "windows")'.dependencies]
# Low-level keyboard + mouse hooks for activity counting on Windows.
windows = { version = "0.58", features = [
  "Win32_Foundation",
  "Win32_UI_WindowsAndMessaging",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_System_Threading",
  "Win32_System_LibraryLoader",
] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

Notes on choices:

- **`screenshots` crate** for capture — abstracts DXGI Desktop Duplication on Windows and CoreGraphics on macOS, so the Plan 09 macOS port is mostly cargo-feature work.
- **`sqlx` + sqlite** rather than `tauri-plugin-sql`. The plugin is fine for trivial CRUD from JS; the upload worker runs in Rust and `sqlx` gives us compile-time-checked queries.
- **`reqwest` with rustls-tls** to avoid a system-OpenSSL dependency at build time.
- **`keyring`** crate is the standard for cross-platform secret storage. Windows uses Credential Manager (Wincred); macOS uses Keychain. Same Rust API.
- **`windows` crate** (the official Microsoft Rust bindings) for the low-level hooks. Pinned to 0.58 — newer minor versions are usually drop-in but warrant a quick review on upgrade.
- **No `objc2` or other macOS deps** — those land in the Plan 09 Mac port behind a `#[cfg(target_os = "macos")]` block.

## `src-tauri/tauri.conf.json`

Edited from the `tauri init` baseline:

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/config.schema.json",
  "productName": "Hindsight",
  "version": "0.1.0",
  "identifier": "app.hindsight.desktop",
  "build": {
    "beforeDevCommand": "pnpm dev:vite",
    "beforeBuildCommand": "pnpm build:vite",
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420"
  },
  "app": {
    "windows": [
      {
        "title": "Hindsight",
        "width": 480,
        "height": 720,
        "resizable": true,
        "fullscreen": false,
        "minWidth": 380,
        "minHeight": 560
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' data: blob: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:3001 https://*.hindsight.app https://*.r2.cloudflarestorage.com"
    },
    "trayIcon": {
      "iconPath": "icons/tray.ico"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/icon.ico"],
    "windows": {
      "wix": {
        "language": "en-US"
      },
      "nsis": {
        "installMode": "perUser"
      }
    }
  }
}
```

Notes:

- **Bundle targets `["msi", "nsis"]`** — produces both a Wix-built `.msi` and an NSIS `.exe` installer. NSIS is generally friendlier to users; MSI is friendlier to IT admins. We ship both.
- **`installMode: "perUser"`** — installs to `%LOCALAPPDATA%\Programs\Hindsight\` per the user, not Program Files. No UAC elevation prompt at install time. Matches our "no admin needed" posture.
- **CSP `connect-src`** explicitly allows the API origin (`*.hindsight.app`) and R2 (`*.r2.cloudflarestorage.com`) for direct uploads. Localhost API for dev.
- **`icons/icon.ico`** is the Windows-required ICO format. Tauri's icon command can generate one from a 1024×1024 PNG: `pnpm tauri icon path/to/source.png`.
- **`icons/tray.ico`** is the system-tray icon — same ICO format, recommended 32×32 with transparent background.
- **No code-signing config** in v0.5. EV cert wiring is Plan 09 / v0.9.

## `src-tauri/src/main.rs`

```rust
fn main() {
    hindsight_lib::run();
}
```

## `src-tauri/src/lib.rs`

The skeleton — commands and tasks fill in over subsequent plan steps.

```rust
use tauri::Manager;

mod activity;
mod auth;
mod capture;
mod db;
mod scheduler;
mod uploader;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "hindsight_lib=info,warn".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            // Filled in by capture.md, outbox.md, etc.
        ])
        .setup(|app| {
            let _ = app.handle();
            // Capture loop, upload worker, activity hooks bootstrap here.
            // See subsequent plan files.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hindsight");
}
```

## React entry points

`apps/desktop/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hindsight</title>
  </head>
  <body class="bg-background text-foreground antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx`:

```tsx
import './globals.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`src/App.tsx`:

```tsx
export function App() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-2xl font-semibold">Hindsight</h1>
        <p className="mt-2 text-sm text-muted-foreground">Desktop scaffold ready.</p>
      </div>
    </div>
  );
}
```

`src/globals.css` mirrors the web app's globals — copy the file from `apps/web/src/globals.css` exactly.

## Tailwind config

Copy `apps/web/tailwind.config.ts` and `postcss.config.js` into `apps/desktop/`. Update `content` to point at the desktop's source:

```ts
content: ['./index.html', './src/**/*.{ts,tsx}'],
```

Tokens (`--background`, `--primary`, etc.) are identical to the web app — same look and feel.

## Prerequisites on the dev machine

To build Tauri on Windows you need:

- **Rust** (`rustup-init.exe` from rust-lang.org, then `rustup default stable`)
- **MSVC C++ build tools** — install via Visual Studio 2022 Community → "Desktop development with C++" workload, OR standalone Build Tools for Visual Studio 2022. The Tauri scaffold won't link without these.
- **WebView2 Runtime** — preinstalled on Windows 11; older Windows 10 may need it from [Microsoft's evergreen download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). The Tauri installer bundles it by default in production builds.

The Tauri docs have an excellent [Windows prerequisites checklist](https://tauri.app/start/prerequisites/#windows) — follow it before you run `tauri:dev` for the first time.

## End-of-scaffold smoke test

After this file's worth of changes:

1. `pnpm install` — adds the workspace deps.
2. `pnpm --filter @hindsight/desktop typecheck` — green.
3. `pnpm --filter @hindsight/desktop tauri:dev` — opens a Tauri window titled "Hindsight" showing the placeholder. Close to quit. **First run is slow** — Cargo compiles ~400 crates. Subsequent runs use the build cache and start in seconds.
4. `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` — green standalone (Tauri also runs this for you on `tauri:dev`).

Subsequent plan files add capture, hooks, outbox, UI on top of this skeleton.
