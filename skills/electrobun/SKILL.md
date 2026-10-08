---
name: electrobun
description: Use when building, editing, or debugging an Electrobun desktop app, including Hutch commands, hutch.config.ts, electrobun.config.ts, a Cottontail or Bun main process, BrowserWindow, BrowserView, electrobun-webview, typed RPC, views:// assets, CEF, bundling, updates, migrating a 1.x app to 2.x, or Electron habits in Electrobun code.
---

# Electrobun

Written for Electrobun 2.0. An app is a main process that owns windows and native state, system webviews that render the UI, and typed RPC between them. **Hutch** is the build and workspace CLI. **Cottontail** is the default main-process runtime, built on JavaScriptCore with Node.js and Bun compatibility. Electron APIs have no equivalent here; the SDKs below replace them.

## Source of truth

- `.hutch/devkit/api/` holds the TypeScript SDK source and config types for the pinned release. Read it for exact signatures. Hutch generates it (`hutch electrobun prepare`); keep it gitignored and unedited.
- `hutch.config.ts` holds the project's scripts, an optional exact `electrobun.version` pin, and `packageManager`. Run scripts with `hutch run <name>`; `package.json` scripts are ignored.
- `electrobun.config.ts` holds app identity and the build. Reference: <https://framework.blackboard.sh/electrobun/apis/cli/build-configuration/>

## Quick reference

| Task | Use |
| --- | --- |
| New project | `hutch electrobun init my-app --template=hello-world`; `npx electrobun init` bootstraps Hutch |
| Install deps | `hutch run install` |
| Run, rebuild on change | `hutch run dev` (runs `hutch electrobun dev --watch`) |
| Release build | `hutch electrobun build --env=canary` or `--env=stable`; the channels are independent |
| Project-local binary | `hutch pm exec -- vite build` |
| Upgrade the Electrobun pin | `hutch electrobun update` |
| Main-process SDK | `BrowserWindow`, `BrowserView`, `Tray`, `ApplicationMenu`, `ContextMenu`, `Utils`, `Updater`, `PATHS`, `BuildConfig`, `type RPCSchema` from `"electrobun/main"` |
| Browser SDK | `Electroview`, `type RPCSchema` from `"electrobun/view"`; importing it registers `<electrobun-webview>` |
| Local UI | `url: "views://mainview/index.html"`; `build.views` bundles scripts, `build.copy` copies HTML, CSS, and assets |
| RPC | `rpc.request.name(params)` awaits a response; `rpc.send.name(payload)` is one-way |
| Remote content | `<electrobun-webview sandbox>` plus `setNavigationRules()` |

## Config

```ts
// electrobun.config.ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: { name: "My App", identifier: "dev.example.my-app", version: "0.1.0" },
  runtime: { exitOnLastWindowClosed: false }, // tray apps
  build: {
    mainProcess: "cottontail", // "bun" only when the app needs the real Bun runtime
    cottontail: { entrypoint: "src/bun/index.ts" },
    views: { mainview: { entrypoint: "src/mainview/index.ts" } },
    copy: { "src/mainview/index.html": "views/mainview/index.html" },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
    win: { bundleCEF: false },
    linux: { bundleCEF: false },
  },
  release: { baseUrl: "https://example.com/releases" },
} satisfies ElectrobunConfig;
```

- `tsconfig.json` extends `./.hutch/devkit/tsconfig.json`.
- Vite: build to `dist/`, copy `dist/index.html` and `dist/assets` into `views/mainview/`, and alias the SDK with `electrobunViteAliases` from `./.hutch/devkit/api/config/electrobun-vite`. Scripts run `hutch electrobun prepare` before `vite build`.
- Cottontail ships optional standard-library modules (`bun:sqlite`, `node:zlib`, `Bun.SQL`) as capabilities and includes the ones a static scan of the bundle finds. List computed or dynamic imports in `build.cottontail.capabilities`; a missing one at runtime names itself.

## Typed RPC

```ts
// src/shared/rpc.ts: types only, imported by both sides
import type { RPCSchema } from "electrobun/main";

export type AppRPC = {
  bun: RPCSchema<{
    requests: { readStatus: { params: {}; response: string } };
    messages: { log: { line: string } };
  }>;
  webview: RPCSchema<{
    requests: { getTitle: { params: {}; response: string } };
    messages: {};
  }>;
};

// src/bun/index.ts
import { BrowserView, BrowserWindow } from "electrobun/main";
import type { AppRPC } from "../shared/rpc";

const rpc = BrowserView.defineRPC<AppRPC>({
  handlers: {
    requests: { readStatus: () => "ready" },
    messages: { log: ({ line }) => console.log(line) },
  },
});
const win = new BrowserWindow({ title: "My App", url: "views://mainview/index.html", rpc });
const title = await rpc.request.getTitle({});

// src/mainview/index.ts
import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc";

const rpc = Electroview.defineRPC<AppRPC>({
  handlers: { requests: { getTitle: () => document.title }, messages: {} },
});
new Electroview({ rpc });
const status = await rpc.request.readStatus({});
rpc.send.log({ line: "renderer ready" });
```

`executeJavascript()` is fire-and-forget; a `webview` request is how the main process reads a value from the page. Views talk to each other through the main process.

## Security

- `sandbox: true` on a window or view, or `<electrobun-webview sandbox>`, turns off RPC and keeps navigation and events. Use it for every page you do not own.
- `setNavigationRules([...])`: `*` wildcards, `^` blocks, the last match wins, an empty array allows all. Block first, then allow: `["^*", "https://trusted.example/*"]`.
- `partition` names a persistent storage profile; omit it for throwaway sessions.
- `allowedProtocols` defaults to `{ views: true, appData: false }`. Enable `appData` only where trusted content must read `appdata://` files from `userData`.
- A sandboxed page can still emit `host-message` through `window.__electrobunSendToHost(...)` in its preload; validate the payload in the host.

## Platforms

- Renderers: WKWebView on macOS, WebView2 on Windows, WebKitGTK 4.1 on Linux. `bundleCEF: true` plus `renderer: "cef"` pins Chromium per window or view; Linux cannot reliably mix the two.
- Hutch builds for the host OS and architecture only; build each platform on its own runner.
- Application and context menus exist on macOS and Windows; on Linux put those actions in the UI or a tray menu.
- Custom URL schemes register on macOS only, after the built app is installed.
- Windows packaged apps hide the console; set `ELECTROBUN_CONSOLE=1` to see output. Linux needs GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, and librsvg at runtime, even with CEF.

## Common mistakes

| Mistake | Fix |
| --- | --- |
| Importing `electron`, `ipcMain`, `ipcRenderer` | `electrobun/main`, `electrobun/view`, typed RPC |
| Loading `file://` or relative HTML paths | Add the file to `build.copy` or `build.views`; load `views://...` |
| `bun run dev` or `package.json` scripts | Scripts live in `hutch.config.ts`; `hutch run dev` |
| `electrobun` in `package.json` dependencies, or resolving `node_modules/electrobun` | The SDK is `.hutch/devkit`; Vite uses `electrobunViteAliases` |
| RPC wiring just to drag a frameless window | `titleBarStyle: "hidden"`, `-webkit-app-region: drag` CSS, `no-drag` on controls; RPC only for close, minimize, and maximize buttons |
| Missing-capability error at startup in Cottontail | Add the reported name to `build.cottontail.capabilities` |
| Third-party page embedded with RPC on | `sandbox`, a `partition`, HTTPS-only rules, validated `host-message` |

## Migrating from 1.x

Guide: <https://framework.blackboard.sh/electrobun/guides/migrating-to-v2/>

| 1.x | 2.x |
| --- | --- |
| `electrobun/bun` imports | `electrobun/main` (the old path still resolves) |
| `build.bun.entrypoint` | `build.mainProcess: "cottontail"` plus `build.cottontail.entrypoint`; keep `"bun"` for a low-risk first release |
| `build.targets`, `useAsar`, `asarUnpack`, `cefVersion`, `wgpuVersion`, `bunVersion`, `bunnyBun`, `locales` | Deleted; the validator names any that remain |
| `package.json` scripts, `--env production` | `hutch.config.ts` scripts, `--env=stable` |
| `bun.lock`; SDK resolved from `node_modules/electrobun` | `hutch.lock` (unless `packageManager` is set); `tsconfig` extends `./.hutch/devkit/tsconfig.json`; Vite uses `electrobunViteAliases` |

Keep `app.name`, `app.identifier`, and `release.baseUrl` unchanged so installs on 1.18.1 or later update in place.

## Verify

1. `hutch run dev` opens the window and one RPC request round-trips.
2. `hutch pm exec -- tsc --noEmit` passes when `typescript` is a devDependency.
3. `hutch electrobun build --env=canary` writes `artifacts/` before you test installers or updates.

## Docs

- Hutch: <https://framework.blackboard.sh/electrobun/guides/hutch/> and <https://framework.blackboard.sh/electrobun/apis/cli/cli-args/>
- Cottontail: <https://framework.blackboard.sh/electrobun/guides/cottontail/>
- APIs: <https://framework.blackboard.sh/electrobun/apis/browser-window/>, <https://framework.blackboard.sh/electrobun/apis/browser-view/>, <https://framework.blackboard.sh/electrobun/apis/browser/electrobun-webview-tag/>, <https://framework.blackboard.sh/electrobun/apis/browser/electroview-class/>
- Distribution and updates: <https://framework.blackboard.sh/electrobun/guides/bundling-and-distribution/>
- Beyond the webview (WGPU views, three.js and Babylon adapters, Warren UI, Zig/Rust/Go/Odin main processes): <https://framework.blackboard.sh/electrobun/guides/native-main-process/>, <https://framework.blackboard.sh/electrobun/apis/webgpu/>, <https://framework.blackboard.sh/electrobun/apis/ui/overview/>
- Changelog: <https://framework.blackboard.sh/electrobun/guides/changelog/>
- GitHub: <https://github.com/blackboardsh/electrobun>
