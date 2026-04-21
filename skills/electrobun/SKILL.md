---
name: electrobun
description: Use when building, editing, or debugging Electrobun desktop apps, electrobun.config.ts, BrowserWindow, BrowserView, electrobun-webview, typed RPC, views:// assets, Bun process APIs, bundling, updates, CEF/native renderers, or Electron migration mistakes.
---

# Electrobun

## Overview

Electrobun is a Bun + native system-webview desktop framework, not Electron. Use Electrobun imports, typed RPC, and `views://` assets; avoid Electron APIs.

## Quick Reference

| Task | Use |
| --- | --- |
| Create/run/build | `bunx electrobun init`, `bun install`, `bun start`, `bunx electrobun build --env canary|stable` |
| Bun/main APIs | `BrowserWindow`, `BrowserView`, `Tray`, `Utils` from `"electrobun/bun"` |
| Browser/view APIs | `Electroview` from `"electrobun/view"` |
| Local UI | `url: "views://mainview/index.html"` plus `build.copy` for HTML/assets |
| RPC | `.rpc.request.name(params)` for responses, `.rpc.send.name(payload)` for messages |
| JS result | `webview.rpc.request.evaluateJavascriptWithResponse({ script })` |
| Remote embed | `<electrobun-webview sandbox>` plus `setNavigationRules()` |

## Typed RPC Pattern

```ts
// src/shared/types.ts
import type { RPCSchema } from "electrobun/bun";

export type AppRPC = {
  bun: RPCSchema<{
    requests: { readStatus: { params: {}; response: string } };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: { getTitle: { params: {}; response: string } };
    messages: {};
  }>;
};

// Bun process
import { BrowserView, BrowserWindow } from "electrobun/bun";
import type { AppRPC } from "../shared/types";
const bunRpc = BrowserView.defineRPC<AppRPC>({
  handlers: { requests: { readStatus: () => "ready" }, messages: {} },
});

const win = new BrowserWindow({
  title: "My App",
  url: "views://mainview/index.html",
  frame: { width: 1000, height: 700, x: 100, y: 100 },
  rpc: bunRpc,
});

const title = await win.webview.rpc.request.getTitle({});

// Browser view
import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/types";
const viewRpc = Electroview.defineRPC<AppRPC>({
  handlers: { requests: { getTitle: () => document.title }, messages: {} },
});

const electroview = new Electroview({ rpc: viewRpc });
const status = await electroview.rpc.request.readStatus({});
```

## Build Config

Use `electrobun.config.ts` with `satisfies ElectrobunConfig`. `build.bun.entrypoint` targets Bun; `build.views.*.entrypoint` targets browser bundles; `build.copy` maps files into `views/...`. Vite templates copy `dist/index.html` and `dist/assets`; add `watchIgnore: ["dist/**"]`. Use `runtime.exitOnLastWindowClosed: false` for tray apps. Use `release.baseUrl`, not old `bucketUrl`.

## Security

Sandbox untrusted content. `sandbox: true` disables RPC and leaves navigation/events. For nested content, use `<electrobun-webview sandbox>` and block by default:

```js
webview.setNavigationRules([
  "^*",
  "*://trusted.example/*",
  "^http://*",
]);
```

Rules are glob-like, `^` means block, and the last match wins. Use `persist:name` partitions only when storage should survive restarts.

## Platform Notes

Native renderers: WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux. CEF is optional but recommended on Linux. Context/application menus are not supported on Linux. Page zoom is WebKit/macOS-only. Deep links are mainly macOS and require installation in Applications.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Importing `electron`, `ipcMain`, `ipcRenderer`, or Electron `BrowserWindow` | Use `electrobun/bun`, `electrobun/view`, typed RPC |
| Loading `file://` or relative HTML paths | Bundle files and load `views://mainview/index.html` |
| Creating browser-to-browser RPC | Relay between views through the Bun process |
| Expecting `executeJavascript()` to return a value | Use `evaluateJavascriptWithResponse` through RPC |
| Passing `{ html }` to `loadHTML` | Pass the HTML string directly |
| Using `-webkit-app-region` for custom chrome | Use `electrobun-webkit-app-region-drag` and `...-no-drag`; instantiate `Electroview` |
| Embedding third-party pages with RPC enabled | Use sandbox, partitions, HTTPS-only rules, validate `host-message` payloads |

## Verification

Run `bunx tsc --noEmit` for types, `bun start` or `bunx electrobun dev` for development, and `bunx electrobun build --env canary` before checking distribution/update behavior.

## Resources

- Docs: <https://blackboard.sh/electrobun/docs/>
- LLM reference: <https://blackboard.sh/electrobun/llms.txt>
- GitHub: <https://github.com/blackboardsh/electrobun>
