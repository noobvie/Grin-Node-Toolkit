# Menu keys and row labels

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

- **Menu rows show NAMES, not script numbers.** A script's number (051, 05C …) is file/doc
  identity and is printed only on that product's own screen banner (`05C) GRIN WALLET QUICK
  SETUP`) — never duplicated onto the parent hub's row, where `A) 05C ·` reads as a broken
  sequence. So never name a product to an operator by number alone: say "the CMD Wallet
  quick setup (hub 05)", not "05C". Full rationale → `05_grin_wallet_service.sh` header.
- **Menu keys: FIXED SLOTS in hub 05, NUMBER-MATCHED in hub 08, positional elsewhere.**
  Hub 05 assigns every category a contiguous block of keys ending in a spare (wallets
  1-4, payments 5-8, giveaways 9); a row owns its key permanently, and planned/spare rows
  own theirs from the start. Hub 08 instead keys each row that HAS a sub-script to that
  script's last digit — 081→`1`, 082→`2`, 083→`3`, 084→`4`, 086→`6`, 089→`9` — and fills the
  gaps (`5`,`7`,`8`) with its un-numbered inline features (085 SSH is reached from inside 083).
  With all nine digits taken, a further inline feature gets a letter (`E` = Ecosystem Page
  Entries), never `10`+, so no digit's meaning moves. Other hubs (07, 09) still assign
  the key positionally at render. **Outside hub 08 the key is NOT the script number** — in
  05, key 5 is WooCommerce (053) and key 9 is Drop (059); they coincide only by accident.
  - Hub 08's rule (adopted 2026-08-05, when Provider Access Watch sat on key 7 and Backup
    089 on key 10) works only because 08's rows *are* mostly numbered scripts — and it still
    cost one merge: Service & Port Dashboard + Chain Sync Status became `3) Node Status &
    Sync`, because 10 rows don't fit 9 digits. It does NOT generalise — in hub 05, 051 and
    05C would both want the same key. One rule per hub; never mix two in one menu.
  - Fixed slots exist because positional keys silently re-point every key below an
    insertion — that is how `2` came to mean Drop and then WooCommerce. The cost is that
    a category's spare is finite: when wallets outgrow slot 4 the next wallet cannot take
    5, so the blocks below shift in one deliberate migration.
  - A planned/spare key is LIVE and dispatches to `_slot_notice()` — one banner screen
    saying what the slot is for, "Nothing was installed or changed", Enter to return. It
    has no sub-menu and no prompts, so it can't be mistaken for the "coming soon"
    placeholder script that was deleted. A dead key would read as a broken menu, since
    fixed slots print the number and put it in the `Select [A / 1-9 / 0]` hint.
- **Retired menu key vs reassigned menu key.** A key nothing else took may live on as a
  silent alias (05 hub's `C` → CMD wallet). A key that changed hands never may — a second
  `case` arm for it is dead code (bash takes the first match) and, if reached, would open
  the wrong product with no error. The per-product banner is the mis-key safety net.
  Fixed slots are meant to end key churn, so this should now be history, not a live risk.

