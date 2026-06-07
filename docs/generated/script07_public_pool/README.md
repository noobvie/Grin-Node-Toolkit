# Script 07 — Public Pool (GRINIUM) design docs

Imported reference set for the public mining pool (`07_grin_mining_public_pool.sh`,
web app under `web/07_mining_pool_public/`). These are the original GRINIUM design
docs, copied here verbatim from the standalone Grinium repo's `flowcharts/`.

**Convention exception:** the toolkit normally allows max 3 generated docs per
script with fixed `script##_<type>` names (see CLAUDE.md → "Generated & Temporary
Files"). This folder is a deliberate exception — an as-is import kept grouped in
its own subdirectory rather than reorganized. The 270 KB `pool_flow_refactor.txt`
scratch dump was intentionally left out.

| File | Topic |
|------|-------|
| `00_overview.md`    | High-level overview |
| `architecture.md`   | System architecture |
| `backend.md`        | Backend (Express) design |
| `payments.md`       | Tor auto-payout / PPLNS rewards |
| `infrastructure.md` | Deploy / systemd / nginx |
| `security.md`       | Security model |
| `ui-ux.md`          | Frontend / admin UI |
| `build-plan.md`     | Build & implementation plan |
