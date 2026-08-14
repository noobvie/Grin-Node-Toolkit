# Script 05 hub — designs for planned wallet/payment products

Designs for products the Script 05 hub will launch **once they are built**. They live under
the hub's number `05` on purpose: an unbuilt product has **no number of its own**, and naming
a design doc `script055_*` would reserve `055` — the habit that scrambled the hub menu in the
first place. A product gets its own number the day its first file is created (see the "Menu
ordering rule" block in `scripts/05_grin_wallet_service.sh`), and its design moves to
`script<num>_design.md` then. Same pattern as GoblinPay living in `script09_design.md` PART C.

Contents:

- **PART A — Accio, the public web wallet — MOVED.** It is being built, so it took its number:
  the design now lives in **`docs/generated/script052_design.md`** (moved 2026-08-09 by build
  packet S0, which created `scripts/052_grin_accio.sh` and vendored the pinned upstream into
  `web/052_accio/`). This is the rule working as intended, not an exception to it.
- PART B — Payment Pro: not designed yet; the feature sketch is in the hub script header.

Nothing is left in this file for Accio. If you are looking for the vendoring policy, the
gateway design, the naming policy or the S0–S9 build plan, they are all in
`script052_design.md`; the session-by-session record is `script052_implementation.md`.
