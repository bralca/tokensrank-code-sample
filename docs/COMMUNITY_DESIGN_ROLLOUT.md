# Community design rollout

Reference approved September 14, 2026: the warm, light TokensRank ranked-list preview, based on the user's outbid.lol reference. This replaces the previous Cobalt/table design and the earlier dark/lime design.

## Design contract

- DM Sans, warm white, charcoal text, vivid orange actions, darker orange for readable text.
- A compact project header, GitHub source link, rounded controls, spacious profile rows, and subtle emphasis on the top three.
- Real people, model names, and usage totals lead. Extra metrics live in details and dedicated views.
- Plain labels and factual copy. No marketing introduction or slogans.
- Preserve comfortable large-screen proportions. Reflow rankings on phones without horizontal scrolling; detailed numeric tables may scroll inside their containers.
- Local usage stays local. Publishing, authentication, scheduled updates, and existing APIs retain their behavior.

## Work

- [x] Shared fonts, colors, navigation, controls, and footer.
- [x] Public leaderboard, model view, profiles, and all empty/loading/error states.
- [x] Local overview, model breakdown, activity, setup, publishing, and settings.
- [x] Account, imports, profile editing, GitHub/email authentication, repository onboarding, and waiting states.
- [x] Type checks, relevant tests, production build, and browser checks at desktop/mobile sizes.

No private usage is to be published as part of visual QA. Existing connection settings and local data are preserved.


## Validation — September 14, 2026

- Web production build passed, including the frontend secret audit. Built into an isolated output directory so the running local/public previews stayed available.
- Web TypeScript checks passed. All 98 web unit/integration tests passed. ESLint: no errors; seven existing warnings about hook dependencies and default exports.
- Browser checks covered leaderboard filtering, row details, public profiles, model rankings, empty results, profile-not-found, account, imports, profile editing, onboarding, repositories, waiting, sign-up, and password reset screens.
- GitHub OAuth completed in the real browser and returned to the account dashboard. Repository setup loaded 51 repositories. No repository selections were saved.
- Local Overview, Models, Activity, Publishing, Settings, and Setup were checked. The onboarding Local dashboard choice navigated to the running local app.
- Manual refresh completed successfully. The interface showed local-file reading, usage numbers becoming current, background code attribution, and then the updated completion timestamp.
- All main pages fit a 320 px viewport after fixing refresh-controls and publishing-grid overflow. Also reviewed 390, 1440, and 2560 px layouts. At 3840 px, the local content spans 2640 px with 18 px base type and 41.4 px headings; public content spans 3000 px.
- No private usage was published and no credentials, connection settings, or refresh schedules were changed. Password forms were inspected without requesting or changing a password.

## Model rankings

The model directory and sidebar count each published builder's most-used model. They do not claim to measure community-wide token market share. The directory explicitly discloses its coverage (up to the top 50 builders); the sidebar covers the displayed page. Existing ranking order and API behavior remain unchanged.

## Test scope

The browser walkthrough above and the web test/build checks were run for this rollout. The older Playwright suite includes historical dark-theme/four-column screenshot and selector contracts and was not run or re-baselined as part of this design pass.
