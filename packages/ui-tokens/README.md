# @ica/ui-tokens

Design tokens for the Ground Incident Coordination Agent cockpit: one source of truth (`src/tokens.ts`) for colour, type, spacing,
radii, elevation and motion, in two themes: **dark** (the default "ops room") and **light**.

## Rules the tokens encode

- **Neutrals plus exactly four accents**: `good`, `warning`, `critical` and `ai`. Accents appear only when a threshold
  is crossed or to label AI-drafted content. The brand pair (`brand-primary`, `brand-accent`) is identity only (the
  logo mark) and is overridden at runtime from the brand pack (`GET /config`).
- **Tabular numerals** for every figure (`.num` in the web app).
- **8-pt grid** (4 px half-steps for dense rows).
- **Motion**: 150 / 200 / 300 ms with standard, emphasised and exit easings; `prefers-reduced-motion` zeroes the
  duration variables.
- **WCAG 2.2 AA**: `src/tokens.test.ts` checks every text token (`fg`, `fg-muted`, `fg-subtle` and the four accents)
  against every background token in both themes (≥ 4.5:1), accents on their own tints, text on solid accents, and
  the control border and focus ring (≥ 3:1).

## Outputs

| File | What it is | Consumer |
|---|---|---|
| `tokens.css` | CSS custom properties: `--c-*` (RGB channels, for alpha) and `--color-*` (hex) per theme, `--text-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--duration-*`, `--ease-*`. Dark on `:root` and `[data-theme="dark"]`, light on `[data-theme="light"]` | `import '@ica/ui-tokens/tokens.css'` |
| `src/tailwind-preset.ts` | Tailwind v3 preset mapping the scales onto the CSS variables (theme switch = `data-theme` flip, no rebuild) | `presets: [icaPreset]` from `@ica/ui-tokens/tailwind` |
| `src/tokens.ts` | The TS constants object (`tokens`, `colors`, `motionEase` for Framer Motion…) | `import { tokens } from '@ica/ui-tokens'` |
| `figma-tokens.json` | Tokens Studio document: sets `global`, `dark`, `light` and two themes | Figma |

`tokens.css` and `figma-tokens.json` are generated and committed. After changing `src/tokens.ts`, run:

```bash
npm run build -w @ica/ui-tokens   # regenerates both files (Prettier-formatted)
npm test -w @ica/ui-tokens        # contrast checks + "generated files are up to date"
```

## Using the tokens in Figma (Tokens Studio)

The spec's "Figma file mirroring the tokens" is delivered as `figma-tokens.json`:

1. In Figma, install the **Tokens Studio for Figma** plugin.
2. Open the plugin → **Settings** → add a sync provider of type **Local document** (or keep the default), then
   **Tools → Load from file** and choose `packages/ui-tokens/figma-tokens.json`.
3. The sets `global`, `dark` and `light` appear. Use the **Themes** menu to switch between *Dark (ops room)* and
   *Light*; `global` holds type, spacing, radii and motion.
4. **Styles & variables → Export to Figma** creates colour, typography and spacing variables/styles that match the
   CSS variables one-to-one.

Edit tokens in `src/tokens.ts`, never in Figma: re-export the JSON with `npm run build -w @ica/ui-tokens` and reload
it in the plugin.
