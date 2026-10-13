# TokensRank Color System

The TokensRank web app is dark-only. These colors are locked by the design canon and Tailwind configuration.

## Locked Palette

| Token | Hex | Tailwind utility | Usage | WCAG status |
| --- | --- | --- | --- | --- |
| Background | `#0A0A0A` | `bg-tr-bg` | Page background, avatar pip backing | Reference background |
| Elevated background | `#111111` | `bg-tr-bg-soft` | Cards, table headers, controls | Use with primary or secondary text |
| Row background | `#161616` | `bg-tr-bg-row` | Hover and inset rows | Use with primary or secondary text |
| Primary text | `#E8E8E8` | `text-tr-text` | Body copy, rank, token usage | Passes AA on dark surfaces |
| Secondary text | `#848E9C` | `text-tr-secondary` | Handles, captions, table headers, labels | Passes AA for normal text |
| Dim text | `#5A6272` | `text-tr-dim` | Placeholders and tertiary text | Do not use for required body copy |
| Border | `#1F1F1F` | `border-tr-border` | Default hairline borders | Non-text decoration |
| Border high | `#2A2A2A` | `border-tr-border-hi` | Hover and focus-adjacent borders | Non-text decoration |
| Accent lime | `#B6FF3C` | `text-tr-accent`, `bg-tr-accent`, `text-accent-lime` | Wordmark brackets, CTA fill, avatar verified pip, rank-up deltas, links | Passes AA/AAA on `#0A0A0A` |
| Error | `#FF5A5A` | `text-tr-error` | Negative deltas and errors | Use with text plus non-color indicator |
| Warning | `#FFB020` | `text-tr-warning` | Stale and degraded states | Use with text plus status copy |
| Success | `#00D084` | `text-tr-success` | Positive status indicators | Use with text plus status copy |

## WCAG Contrast Results

Ratios were calculated with the WCAG relative luminance formula and verified with WebAIM Contrast Checker on 2026-04-29.

| Foreground | Background | Ratio | Requirement | Status |
| --- | --- | ---: | --- | --- |
| Accent lime `#B6FF3C` | Background `#0A0A0A` | `16.36:1` calculated, `16.3:1` WebAIM | `>= 3:1` for large text and graphical UI | Pass |
| Secondary text `#848E9C` | Background `#0A0A0A` | `5.97:1` calculated, `5.96:1` WebAIM | `>= 4.5:1` for normal text | Pass |
| Accent lime `#B6FF3C` | PRD background `#0B0E11` | `16.00:1` calculated | `>= 3:1` for large text and graphical UI | Pass |
| Secondary text `#848E9C` | PRD background `#0B0E11` | `5.83:1` calculated | `>= 4.5:1` for normal text | Pass |

## Token Usage

| UI element | Token | Requirement |
| --- | --- | --- |
| Verified avatar pip | `#B6FF3C` on `#0A0A0A` | Treat as a 25px graphical UI element; minimum `3:1` |
| Profile rank display | `text-tr-text` on `bg-tr-bg` | Large display text; minimum `3:1` |
| Leaderboard handles | `text-tr-secondary` on dark row surfaces | Normal text; minimum `4.5:1` |
| Table headers | `text-tr-secondary` on `bg-tr-bg-soft` | Normal text; minimum `4.5:1` |
| Table body | `text-tr-text` or `text-tr-secondary` on dark row surfaces | Normal text; minimum `4.5:1` |
| Links | `text-tr-accent` or `text-tr-text` with underline/focus style | Must not rely on color alone |

## Regression Tests

- `apps/web/e2e/accessibility/contrast.spec.ts` runs axe-core `color-contrast` checks on the homepage, profile page, sign-up page, and filtered leaderboard state.
- The same spec includes computed-style contrast checks for the avatar pip, profile rank display, leaderboard handles, table header/body text, and profile links.
- `.github/workflows/ci.yml` runs `pnpm --filter @tokensrank/web test:e2e`, so the contrast spec is included in CI E2E coverage.

The detailed audit record is in `apps/web/docs/color-contrast-audit.md`.
