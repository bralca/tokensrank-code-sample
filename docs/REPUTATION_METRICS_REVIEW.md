# Reputation and repeat value — September 14, 2026

The local dashboard should be worth using without publishing. It helps a builder understand their tool/model mix, reused context, and estimated API value. Public profiles let builders opt into recognition backed by identifiable, inspectable evidence. A usage ranking should not claim to measure skill.

## Metric decisions

| Signal | What it establishes | Recommendation with current data |
| --- | --- | --- |
| Total tokens | Recorded usage intensity, including cached input | Keep the existing usage ranking and category boards. Explain the components. Do not describe it as productivity or quality. |
| Output tokens | Recorded model output, sometimes including reasoning | Display beside totals. It avoids cached-input dominance but is still not useful code, accepted answers, or quality. Do not add reasoning again. |
| API-equivalent value | Estimated usage valued at API rates | Useful privately for understanding model mix. Display publicly as context; do not reward higher spending. Share cards now use the actual profile estimate. |
| Cache reuse | Proportion of recorded tokens reused as context | Show privately alongside fresh input and output. It describes workload/cache behavior, not a skill score. Only show a partition when component totals reconcile. |
| Model/tool breadth | Which tools and models a builder has used | Useful as profile context and discoverable category rankings. Do not award extra skill points just for trying more models. Preserve exact model identifiers and dated variants. |
| Recorded active dates/weeks | Distinct UTC dates/calendar weeks with positive recorded token counters | Implemented for sources declaring event-date totals. Gaps do not establish inactivity. Session-summary imports do not receive these participation measures. No streak badges or ranking weights. |
| Duration/parallelism | Would require a defensible activity measure | Not offered as reputation metrics. Observed session endpoints are recovered locally where available, but cannot establish active work or idle periods. No duration heuristics or AI inference. |
| GitHub identity | Connection to a specific account | Show the public GitHub avatar, using the verified immutable ID; preserve custom photos. This does not verify token consumption. |
| GitHub branch contributions | Remote commits/code changes associated with selected branches | Useful separate evidence when opted in. It establishes branch activity, not deployment, usefulness, or authorship by AI. End-to-end optional-code acceptance remains necessary. |
| Direct AI/commit links | A commit identifier appeared in a local AI session | Show counts of sessions with explicit matched commit references, privately by default and publicly only with code opt-in. Missing evidence is not no work. New receipts exclude model-to-code and token-to-commit allocations. |
| Lines of code / tokens per line | A narrow size/count ratio | Do not make this a general builder-quality metric. Maintenance, deletions, tests, design and research have different outputs. Lines and token counts can both be manipulated. |

Recommended reputation model: category-specific usage standing, an identifiable profile, transparent data coverage, and separately labeled optional code evidence. Keep those visible dimensions rather than inventing a universal “good builder” score. No new scoring weights were introduced in this pass. The existing token ranking and trust policy still apply.

## What the reputation experience can become

A public profile can credibly establish “this person has used these tools and models extensively” and, with optional GitHub evidence, “these recorded contributions accompany their usage.” It cannot yet establish “this person builds better products.” More tokens, more output, more models, and more changed lines all have legitimate counterexamples and can reward waste if treated as quality.

The evidence panel now separates: category position, output alongside total tokens, which sources and periods are represented, and what a verification mark actually checks. GitHub identity, remotely checked commits, and user-submitted usage should have distinct labels. None authenticates the others automatically.

Daily token totals now follow the reader’s UTC event dates. Distinct positive dates and Monday-based calendar weeks add a participation dimension from the reviewed daily aggregates. Compare the same period and tool/model category; do not reward one long session being split into many, or treat an unobserved period as inactivity. Any quality claim would require additional evidence about outcomes, adoption, review, or usefulness that the present usage records do not contain.

## Evidence from the current local snapshot

Before this repair, Claude and Codex summary rows had equal start/end timestamps despite raw sessions crossing dates. Native daily reports now retain actual token dates; the local snapshot contains about 8,643 sessions and usage on 168 UTC dates across 37 calendar weeks. About 95% of tokens are reused-context counters. One historical OpenCode day has a mismatch between its reported total and components. The reported total is retained; the combined composition is unavailable unless its components reconcile exactly. The live dataset continues to update; these numbers are not product defaults.

The existing composite formula multiplies logarithmic usage and shipped-code terms with consistency. Logs dampen inflation; they do not prevent it when both inputs are positive. The formula remains historical analytics, not the current public ranking.

## Structured public data

Migration `0040_public_usage_explorer.sql` adds aggregate-only facts and model/tool/provider dimensions over approved public usage. It uses modern publications in preference to legacy imports, excludes ineligible/hidden and future-dated usage, and keeps raw IDs distinct. No local paths, prompts, repository contents or private session records enter this read model.

Directory totals cover all eligible builders, not a first-page sample or each builder's favorite model. A builder may appear under multiple categories; distinct-builder counts must not be summed. Output totals are unavailable if their underlying records lack the breakdown. Unknown providers remain unknown.

Canonical directories: `/models`, `/tools`, `/providers`. Each observed dimension has a detail page with a paginated builder ranking, totals, output context, related categories and methodology. The same API can serve future structured pages. Model slugs retain a readable prefix plus an ID-derived suffix to distinguish colliding names. No geography, occupation, company, project type, skill, or quality is inferred from the available publications.

Pages use server-rendered content, canonical URLs, breadcrumb/collection structured data and internal links. Filter permutations are not added to the sitemap. Category pages with fewer than three participating builders, unspecified IDs, and filtered/paginated variants are noindex; the three-builder threshold is an editorial choice, not a promise of search eligibility. It currently prevents a one-account dataset from generating dozens of indexable rankings.

This follows Google's guidance to [control faceted navigation](https://developers.google.com/crawling/docs/faceted-navigation) and give generated pages [original value](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content). No SEO outcome is guaranteed.

## Deferred deliberately

New reputation weights, consistency/concurrency badges, billing ROI, inferred occupations or locations, and automatic public sharing are outside this pass. Daily event allocation is implemented; active-work duration is deliberately unavailable because timestamps alone cannot establish it. Production hosting, public package distribution, and optional-code browser acceptance remain separate release work.

## Metric data contract

Every new reputation signal is deterministic. No model classifies users, evaluates work, or fills missing evidence.

| Display | Required input and calculation | Missing-data behavior |
| --- | --- | --- |
| Tokens/model/tool share | Recorded counters grouped by exact model ID and tool; share = category tokens / period tokens | Unknown IDs stay unknown; no guessed model split |
| Output | Sum recorded output counters; reasoning is a subset and is not added again | No claim about useful output or code quality |
| Token composition | Fresh input + output + cache reads + cache creation must reconcile with the total | The composition is unavailable if counters overlap or are missing |
| Daily activity | Native daily counters in UTC; OpenCode model/day rows must reconcile exactly against its native daily total | Failed reads preserve the last successful whole-source snapshot; older session-date records are labeled |
| Active dates/weeks | Count distinct positive dates and their Monday-based UTC weeks | Unavailable without event-date provenance; missing dates do not prove inactivity |
| API value | Recorded per-model reader estimate, or exact provider/model reference rates × compatible counters / 1,000,000 | No related-model fallback or proportional allocation; partial/unavailable pricing is shown explicitly |
| Category position | Approved eligible token totals in the same period and category, under the existing trust policy | Population shown alongside position; no skill score |
| Identity/freshness | Connected GitHub identity and successful publication/source read timestamps | Missing evidence is shown as unavailable, not verified |
| Optional contribution evidence | Remote selected-branch commit/repository counts, plus count of sessions with explicit matched commit references | Only the reviewed counts are shared; no inferred authorship, deployment or productivity |

Session counts are counts of recorded sessions. Their daily series counts each session once on its last observed UTC day; it is separate from token event dates. Individual IDs and timelines stay local. Session endpoints are not propagated to every model as if each model ran throughout the session.

Evidence metadata is stored atomically with the successful publication in migration `0041_profile_evidence.sql`. Failed/retried publications preserve the previously approved record. New receipts send no derived model-code allocations, inferred AI-written line counts, session IDs or raw history. Legacy calculation fields remain for compatibility and are not used by the new reputation UI.

## Validation of this pass

- Core suite: 757 passing tests; web suite: 116 passing tests.
- Disposable PostgreSQL/HTTP suite: 17 passing tests, including real usage-only and optional-code aggregate exports in separate runs. GitHub verification responses are fixtures in that suite; the optional-code live browser publication has not been performed.
- Workspace type checking, production builds and frontend secret scan passed. Lint has no errors and retains seven existing warnings.
- Existing Supabase migration/setup check passed without removing the real account or reference prices. No operational fixtures were added there.
- Browser checks cover local daily charts, activity counts, pricing availability by period, expandable evidence, category positions and matching category links, GitHub photos, receipt privacy/consent, and desktop/mobile layout.
- Public profiles now expose every recorded model to the expandable table, rather than only the cached top ten. The real-export test reconciles all model totals against the receipt.
- A fresh live Supabase publication is awaiting the user’s receipt confirmation. The existing public profile retains the last approved totals; automatic local refresh does not publish them.
