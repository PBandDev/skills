---
name: pixi-vn
description: Use when building, editing, debugging, or reviewing Pixi VN visual novel or 2D game projects using @drincs/pixi-vn, create-pixi-vn, labels, steps, narration, choices, storage, save/load, PixiJS canvas components, sound, React/Vue/Pixi UI layers, Ink integration, or templates.
---

# Pixi VN

## Overview

Pixi VN is a TypeScript/PixiJS game-state and rendering engine for visual novels and 2D games, not a complete authoring IDE. Use Pixi VN APIs for story state, saveable canvas state, sound, history, and navigation; let the app's UI framework present that state.

Written for `@drincs/pixi-vn` 1.8.13.

## Quick Reference

| Task | Use |
| --- | --- |
| New project | `npm create pixi-vn@latest`; prefer the closest official template |
| Existing project | `npm install @drincs/pixi-vn`; inspect current wiring before adding patterns |
| Story flow | `newLabel`, labels, steps, `narration.call`, `narration.jump` |
| Dialogue/choices/input | `narration.dialogue`, `narration.choices`, `newChoiceOption`, `newCloseChoiceOption`, `narration.requestInput` |
| Persistent story state | `storage.set`, `storage.get`, `storage.setFlag`, `storage.getFlag` |
| Save/load | `Game.exportGameState()`, `Game.restoreGameState(saveData)` |
| Back/history | `stepHistory.back(...)`; test around choices and input |
| Visuals | Asset aliases/bundles plus Pixi VN-managed `canvas` components |
| Sound | `sound.addChannel`, `sound.play`, `sound.pauseAll` |
| Ink | `@drincs/pixi-vn-ink`; share Pixi VN storage/canvas where relevant |

## Project Recon

For generated or existing projects, read the generated `README.md`, `package.json`, `src/main.tsx`, `src/content`, `src/assets`, `src/routes`, router files, and any game-init helpers before editing. Use the package manager and scripts already present.

Prefer template conventions over hand-rolled setup. Practical templates are React-heavy; do not promise Vue or Angular scaffolds unless the generator state has been verified. React is not part of the core package, and Pixi VN intentionally leaves UI implementation external.

## Story State

Keep labels small and ids stable. Use `call` for returning sub-scenes and `jump` for flow transfers. Once public saves matter, label ids, character ids, storage keys, and earlier step order are compatibility surface.

Use Pixi VN storage for anything that must survive save/load or backtracking. Do not use module globals, closures, Zustand/Redux, or React `useState` for game truth.

```ts
import {
  narration,
  newChoiceOption,
  newLabel,
  storage,
  type StepLabelProps,
} from "@drincs/pixi-vn";

export const liamChoice = newLabel("liam_choice", [
  () => {
    narration.dialogue = "Liam hesitates beside the gate.";
    narration.choices = [
      newChoiceOption("Help Liam", "liam_helped", {}, { type: "jump" }),
      newChoiceOption("Leave him", "liam_left", {}, { type: "jump" }),
    ];
  },
]);

export const liamHelped = newLabel("liam_helped", [
  () => {
    storage.setFlag("helped_liam", true);
    narration.dialogue = "You step in before Liam has to ask.";
  },
  (props: StepLabelProps) => narration.jump("liam_later", props),
]);

export const liamLeft = newLabel("liam_left", [
  () => {
    storage.setFlag("helped_liam", false);
    narration.dialogue = "You let the silence answer for you.";
  },
  (props: StepLabelProps) => narration.jump("liam_later", props),
]);

export const liamLater = newLabel("liam_later", [
  () => {
    narration.dialogue = storage.getFlag("helped_liam")
      ? "Liam gives you a small nod."
      : "Liam looks away.";
  },
]);
```

Register characters with stable ids through `CharacterBaseModel` or custom stored classes and `RegisteredCharacters.add(...)`. Prefer character instances over id strings in dialogue when the project uses them.

## Assets And Canvas

Use asset aliases and bundles, not hard-coded image or sound paths in story logic. In templates, local assets usually live under `public/assets`, generated manifests under `src/assets/manifest.gen.json`, and project asset indexes merge generated and remote bundles.

For label assets, bundle by label id when the project follows that pattern. Use `Game.onLoadingLabel((_stepId, { id }) => Assets.backgroundLoadBundle(id))` or the template's equivalent preloading hook when present.

Under deadline pressure, do not bypass the existing asset pipeline by adding a second registry. If the generated manifest is blocked, put the smallest alias registration in the existing startup asset module, document it as a hotfix, and remove it once the normal manifest flow is repaired.

Use Pixi VN-managed `canvas` components for scene elements that must restore through history/save/load:

| Need | Prefer |
| --- | --- |
| Background/sprite | Existing template helpers such as `showImage` / `showImageContainer`, or `canvas.add(alias, documentedComponent)` |
| Layering | `canvas.addLayer`, `canvas.addHtmlLayer`, stable component aliases |
| Animation | `canvas.animate`, built-in transitions, tickers; use `canvas.completeTickerOnStepEnd(...)` when completion matters |
| Cleanup | `canvas.remove(alias)` or `canvas.removeAll()` intentionally |

Direct PixiJS is acceptable for custom rendering, but keep saveable scene state in Pixi VN-managed aliases/components when possible. Do not invent object config shapes for `canvas.add`; inspect the project's helpers or the official component constructors such as `Sprite`, `ImageSprite`, `ImageContainer`, `Container`, `Text`, and `VideoSprite`. Do not assume helper import paths; copy them from existing project code or official docs before importing from `@drincs/pixi-vn`. For remote assets, verify CORS, network availability, and web-play size tradeoffs.

## UI Integration

Treat UI framework state as presentation state. Keep dialogue, choices, flags, route-relevant game facts, and restoreable state in Pixi VN narration/storage/history/canvas. UI should read Pixi VN state through the template's hooks/query layer and dispatch Pixi VN actions.

In React/TanStack templates, inspect existing `useQueryDialogue`, `useQueryChoiceMenuOptions`, `useQueryCanGoNext`, router navigation, and query invalidation patterns. Invalidate or refresh UI state after `narration.continue`, `stepHistory.back`, `Game.restoreGameState`, and label transitions.

## Verification

Run the project's own checks, usually `npm run check`, `npm run lint`, `npm run build`, or the scripts in `package.json`. Then browser-test the actual game flow.

Always test the behavior touched:

| Change | Verify |
| --- | --- |
| Story branch/storage | Both branches, later conditional dialogue, save/load, backtrack and choose again |
| Input prompt | Default value, submit, save/load, and back behavior |
| Assets/canvas | No 404s, aliases registered, no duplicate components, save/load restores visuals |
| UI | Advance, back, choices, route transitions, restored saves, stale query/cache behavior |
| Sound | Channel setup, loop/pause behavior, step history/save restoration |
| Distribution | Target-specific docs and generated template assumptions before changing build output |

Use browser devtools for console, network, and PixiJS DevTools when configured. For mobile or responsive work, test mobile Chrome-sized viewports.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Starting from raw PixiJS/Vite instead of the generator | Use `npm create pixi-vn@latest` unless an app already exists |
| Storing branch state in ordinary JS or React state | Use Pixi VN `storage` or flags |
| Hard-coding asset paths in labels | Register aliases/bundles and use the template asset index |
| Adding a second emergency asset registry | Add aliases through the existing asset startup module, or mark the smallest workaround as a hotfix |
| Passing invented object literals to `canvas.add` | Use existing helpers or documented Pixi VN component constructors |
| Renaming labels or reordering old steps in a shipped game | Treat as save migration work; preserve stable ids or add compatibility handling |
| Assuming HTML UI state is saved | Store restoreable game truth in Pixi VN state, then derive UI from it |
| Using deprecated restore navigation overloads by default | Prefer `Game.init({ navigate })` / `Game.onNavigate(...)`, then `Game.restoreGameState(saveData)` |
| Trusting nested percent layout or mobile canvas scaling without testing | Verify nested align/percent layouts and mobile Chrome behavior |

## Resources

- Official docs: <https://pixi-vn.com/>
- LLM route map: <https://pixi-vn.com/llms.txt>
- Core repo: <https://github.com/DRincs-Productions/pixi-vn>
- Generator repo: <https://github.com/DRincs-Productions/create-pixi-vn>
