# Color Contrast Audit

Task 76.0 verifies the locked TokensRank dark theme colors against WCAG AA contrast requirements for the accent and neutral text tokens.

## Source Tokens

| Token | Hex | Source | Usage |
| --- | --- | --- | --- |
| `tr.bg` | `#0A0A0A` | `apps/web/tailwind.config.js` | Page background |
| `tr.accent` | `#B6FF3C` | `apps/web/tailwind.config.js` | Accent text, primary CTA fill, verified avatar pip, positive deltas |
| `accent-lime` | `#B6FF3C` | `apps/web/tailwind.config.js` | Legacy accent utility alias |
| `tr.secondary` | `#848E9C` | `apps/web/tailwind.config.js` | Secondary and neutral normal text |

The planning task references `apps/web/tailwind.config.ts`, but this worktree currently uses `apps/web/tailwind.config.js`.

## Contrast Results

Contrast ratios were calculated with the WCAG relative luminance formula and verified against the WebAIM Contrast Checker API on 2026-04-29.

| Foreground | Background | Calculated ratio | WebAIM ratio | Required threshold | Status |
| --- | --- | ---: | ---: | ---: | --- |
| `#B6FF3C` | `#0A0A0A` | `16.36:1` | `16.3:1` | `3:1` for large text and graphical UI | Pass |
| `#848E9C` | `#0A0A0A` | `5.97:1` | `5.96:1` | `4.5:1` for normal text | Pass |

PRD NFR-28 and NFR-29 reference `#0B0E11` as the dark background. The implementation and binding design canon use `#0A0A0A`; both pairs pass the relevant thresholds:

| Foreground | Background | Calculated ratio | Status |
| --- | --- | ---: | --- |
| `#B6FF3C` | `#0B0E11` | `16.00:1` | Pass |
| `#848E9C` | `#0B0E11` | `5.83:1` | Pass |

## WebAIM Verification

- Accent: `https://webaim.org/resources/contrastchecker/?fcolor=B6FF3C&bcolor=0A0A0A&api` returned `AA: pass`, `AALarge: pass`, `AAA: pass`, `AAALarge: pass`.
- Neutral: `https://webaim.org/resources/contrastchecker/?fcolor=848E9C&bcolor=0A0A0A&api` returned `AA: pass`, `AALarge: pass`, `AAA: fail`, `AAALarge: pass`.

No color token adjustment is required for WCAG AA compliance.
