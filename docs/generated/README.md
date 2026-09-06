# Grin Node Toolkit — documentation index

The durable reference library for this toolkit: **design, architecture and flows.** If you
want to understand how a product works, or why it was built the way it is, start here.

Two things this folder is **not**:

- **Not machine-generated.** Everything here is hand-written prose. The folder name is
  historical; treat it as `docs/reference/`.
- **Not a scratchpad.** Build plans, per-session prompts, review checklists and batch trackers
  are *scaffolding* — they die once every part has been run. They are kept **outside the repo**
  (`D:/tmp/grin-toolkit-plans/`, see its `README.md`). See **Session plans** at the bottom.

---

## Naming

`script<XX>_<type>[_<qualifier>][_<date>].md` — one script per file, never a range.

`<type>` is one of exactly six: `design`, `implementation`, `security_audit`, `analysis`,
`reference`, `report`. **Three of them are core** and stay unqualified — `script##_design.md`,
`script##_implementation.md`, `script##_security_audit.md`. Anything else must carry a
`<qualifier>` so it can never be mistaken for a core file. Work spanning scripts, or about the
repo rather than a script, takes the `script00_` prefix.

Before creating any `.md` here, check whether it belongs inside an existing core file instead.

---

## Nodes, chain data & APIs (Scripts 01–04)

| Doc | What it covers |
|---|---|
| [script01_design_ipv6.md](script01_design_ipv6.md) | IPv6 support for the node builder |
| [script01_reference_flowchart.md](script01_reference_flowchart.md) | Node build flow — chain sync, binary install |
| [script02_reference_flowchart.md](script02_reference_flowchart.md) | Nginx file-server manager flow |
| [script03_design.md](script03_design.md) | Chain-data sharing: mirrors, landing page, remote pull |
| [script03_reference_flowchart.md](script03_reference_flowchart.md) | Chain-data sharing flow |
| [script04_reference_flowchart.md](script04_reference_flowchart.md) | Node Foreign API + stats collector flow |
| [script04_security_audit.md](script04_security_audit.md) | Public node API exposure |

## Wallets & payments (Script 05 band)

| Doc | What it covers |
|---|---|
| [script05_design.md](script05_design.md) | Hub-level designs for products with no number yet (a stub/pointer by design) |
| [script05_design_goblin.md](script05_design_goblin.md) | Goblin-ecosystem overlap analysis |
| [script05_implementation.md](script05_implementation.md) | Hub 05: fixed-slot menu keys, numbering rules |
| [script051_design.md](script051_design.md) · [_implementation](script051_implementation.md) · [_security_audit](script051_security_audit.md) | **Fidelius** — personal web wallet, keys held **server-side** |
| [script052_design.md](script052_design.md) · [_implementation](script052_implementation.md) · [_security_audit](script052_security_audit.md) | **Accio** — public web wallet, **self-custodial**, vendored upstream. ⚠ Complete but **never run on a VPS** |
| [script053_design.md](script053_design.md) · [_security_audit](script053_security_audit.md) | WooCommerce payment gateway |
| [script059_design.md](script059_design.md) · [_implementation](script059_implementation.md) · [_security_audit](script059_security_audit.md) | **Grin Drop** — giveaway + donation portal |

## Health, stats & explorers (Script 06 band)

| Doc | What it covers |
|---|---|
| [script06_design.md](script06_design.md) | Global health + price collector, peer map, self-hosted basemap, **06d Tiny Explorer + tools hub** |
| [script06_security_audit.md](script06_security_audit.md) | Collector and public stats exposure |
| [script06b_design.md](script06b_design.md) · [_implementation](script06b_implementation.md) | **GrinScan** explorer — pruned vs archive behaviour |

## Mining (Script 07)

| Doc | What it covers |
|---|---|
| [script07_design.md](script07_design.md) | Public mining pool architecture — PPLNS, address-as-identity, hub/satellite |
| [script07_implementation.md](script07_implementation.md) | Pool deploy + runbook |
| [script07_security_audit.md](script07_security_audit.md) | Pool security record, §A–§J17. **Start at the Status roll-up** — 14 k lines, and the roll-up is the whole of it in one table |

## Admin & host (Script 08 band)

| Doc | What it covers |
|---|---|
| [script082_design.md](script082_design.md) | Provider Access Watch — VPS host-tamper detection |
| [script083_design.md](script083_design.md) | Host Optimization advisor (read-only) |

## Connectivity (Script 09)

| Doc | What it covers |
|---|---|
| [script09_design.md](script09_design.md) | Connectivity hub — 091 Floonet relay, 092 mwixnet (reserved), 093 Transporter, GoblinPay (PART C) |
| [script09_implementation.md](script09_implementation.md) · [_security_audit](script09_security_audit.md) | As-built + audit for the 09 band |

## Cross-script (`script00_`)

| Doc | What it covers |
|---|---|
| [script00_report_deferred_work.md](script00_report_deferred_work.md) | Scripts 01/03/04/08 still carry private copies of the shared node libs — deferred DRY migration |

---

## Known gaps

Honest list of what a reader will look for and not find, so nobody re-derives it:

- **Hub 08 has no design doc.** Seven scripts (`08`, `081`, `084`, `085`, `089`, `08del`, plus
  `08_grin_node_admin.sh` itself) are covered only by `082`/`083`. Biggest hole here.
- **06d Tiny Explorer** and **07 solo mining** have no doc of their own; both live inside a
  larger file (`script06_design.md`, memory `project_testnet_solo_mining`).
- **Scripts 01, 02, 04 have a flowchart but no `design`.** The flowcharts describe *what runs*,
  not *why it was built that way*.
- **`051x` (XP-themed Fidelius variant)** is undocumented.

## Deep detail lives in local memory

This folder holds what generalises. Product internals that only matter while working on that
product (pool admin panel rules, GrinScan archive behaviour, solo block-finder attribution,
Accio patch policy) live in local memory, indexed in `MEMORY.md`, and are pointed at from the
design docs above. `.claude/CLAUDE.md` holds general Grin architecture and toolkit-wide
conventions only.

## Session plans

Multi-session build and review plans are **not kept here.** They go to
`D:/tmp/grin-toolkit-plans/` — outside the repo, not version-controlled. The rule, and why, is
in that directory's `README.md` and in `.claude/commands/research.md` §5.

Short version: a plan is a handoff between chat sessions. When every part has been run, its
durable outcome is folded into the product's `design`/`implementation` doc here, and the plan
file is deleted. A finished plan is not reference material — on 2026-09-06 five of them held
~164 KB in this folder, three long finished, and they were the single biggest reason it read as
a dump.
