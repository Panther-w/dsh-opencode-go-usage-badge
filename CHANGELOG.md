# Changelog

## 0.4.1 — 2026-11-09

- Fix: opening the expanded card for a DeepSeek official conversation threw `ReferenceError` because the balance view referenced `totalBalance` outside its scope. The card now renders total/recharge/bonus correctly.
- Add a real render test for both the DeepSeek balance card and the OpenCode quota card.
- README: remove the provenance section; correct "two routes" to three; align the "tightest window" wording with multi-select; clarify colour thresholds (≤20% yellow, ≤5% red).

## 0.4.0 — 2026-11-09

- First public release as `dsh-opencode-go-usage-badge`.
- OpenCode Go quota: 5-hour / weekly / monthly windows, multi-selectable (default 5h); the status color always follows the tightest of the three.
- Low-quota colors: above 20% green, 6–20% yellow, 5% and below red; normal numbers stay in the theme text color. A hidden window that is tighter adds a `!` warning.
- DeepSeek official balance: DSH account sign-in and `DEEPSEEK_API_KEY` are separate sources.
- Read-only loopback routes, per-source caches, wake-up refresh, and source switching that follows the conversation.
- Error boundary: a render failure shows a message in the sidebar instead of silently disappearing.
- Bilingual README (`README.md` Chinese, `README.en.md` English), DSH plugin-card locale metadata, MIT license, fictional-data preview images.
- 30 automated tests; GitHub-source install and isolated Desktop-profile installation verified.
