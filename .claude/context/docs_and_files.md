# Docs, comments, temp files, local test processes

> Split out of `.claude/CLAUDE.md` (which points here). Read on demand — keep the
> always-loaded CLAUDE.md lean; add new detail HERE, not there.

## Comments (code and docs-in-code)
 A comment states what is true NOW and why; git holds
  history. Checked mechanically by `docs/tools/check_comments.js scan` (→ `docs/tools/README.md`).
  1. **No plan tags** — no `Part N`, `R1-2`, `delta #N`, `S3 packet`. Cite the durable doc § or
     state the fact. Design-decision ids that live in a design doc (`D21`) are fine if they resolve.
  2. **No diary** — no "was X, now Y" / "used to". One clause is allowed only where it prevents
     a regression ("3334 was planned and dropped — do not move it back").
  3. **A date is evidence only** — "verified live 2026-08-09 against grin 5.5" stays; "added
     2026-09-27" goes.
  4. **Pointers resolve** — paths exist; `§N` resolves, naming its doc unless it is the
     product's own design doc.
  5. **No commented-out code** unless the line above says why it is kept.
  6. **Header = what the file is + its contract + its traps.** History already in a doc → a 2–4
     line summary + pointer. A trap never leaves the code. Add a comment only for a provable trap.
  7. A comment-only change must pass `check_comments.js diffgate`; a comment inside a heredoc is
     file CONTENT written onto the VPS, i.e. behaviour — not a comment edit. Never touch
     `web/052_accio/vendor/` or an `ACCIO PATCH` marker.

## Generated & Temporary Files
ALL generated docs go to `docs/reference/` — never scatter into `web/` etc. The old
`flowcharts/` dir was merged into `docs/reference/` (2026-07-09); don't recreate it.
**`docs/reference/README.md` is the index** — read it to find a doc, and add a row to it when
you add a file. (The folder name is historical: nothing in it is machine-generated.)

**Doc shape.** `design` = what + why + contract. `implementation` = as-built + runbook, in this
order: *What shipped* (by SUBJECT, never by date) · *Runbook* · *Build notes — obstacles &
lessons* · *Open items*. A Build note is `### <title>` + **Symptom · Cause · Fix · Lesson**
(≤ 8 lines, fixing commit hash where known, no hostnames/IPs/secrets), grouped by subject.
A section carries one `**Status:**` line (designed · built, not VPS-tested · VPS-accepted
<date>), not a dated heading, and no plan vocabulary (`Part N`, deltas, review-round ids).
**A new feature folds into its SUBJECT section; obstacles go to Build notes; never append a
dated section or a session log.** `§N` numbers are permanent IDs (code and memory cite them) —
reorder freely, never renumber. Moving text: use a script, don't retype; diff the non-blank
lines old vs new so nothing is lost.

**Every doc in `docs/reference/` carries a freshness header** directly under its title — a
blockquote naming three things: **Covers code as of** (when the doc was last written against
the code), **Last verified** (when someone actually checked the doc *against* the code and
said so), and **Product code last changed** (the last real commit to that product's own files).
The gap between the first and the third is the whole point: it tells a reader how much to trust
the page. Two rules keep it honest:
- **Never write a date in `Last verified` you did not verify.** A false freshness stamp is
  worse than none — it converts an unknown into a wrong known. For almost every doc the true
  value is `never systematically verified`; write that. A date is allowed only when it is a
  *real* check, and it must carry its scope (`2026-06-08, PARTIAL — §2 and §8.4 only`) and say
  where it came from. Reporting the doc's own recorded claim, attributed, is fine; inventing one
  is not. A test suite passing verifies the **code**, not the document.
- **When you materially change a doc, update its `Last verified`. When you change code a doc
  describes, either update the doc or move its `Covers code as of` back to honest** — and bump
  `Product code last changed`. Git dates cannot answer this on their own: a bulk rename or a
  comment-only sweep touches dozens of files without changing a word of substance, which is
  exactly how 15 docs came to look uniformly fresh in 2026-08. Read the commit, don't trust the
  timestamp.

**⚠ `docs/reference/` is the DURABLE REFERENCE LIBRARY — design, architecture, flows — for
other people to read. Session scaffolding does NOT go in it and is NOT committed.** A
per-session build plan, prompt series, review checklist or batch tracker is a handoff between
chat sessions: it dies once every part has been run. Write it to **`D:/tmp/grin-toolkit-plans/`**
(outside the repo, not version-controlled — see that dir's `README.md`), never to
`docs/reference/`, and never to a scratchpad that is wiped between sessions.
- **Cross-link ONE way.** The design doc may say "broken into nine sessions, plan kept outside
  the repo"; it must never link a `D:/tmp/...` path — that is a dead link for anyone who clones.
  The plan links *into* the repo docs freely.
- **On completion: fold, then delete.** The durable outcome (what was decided, what shipped,
  what is still open) goes into that product's `script##_design.md` or
  `script##_implementation.md`; the plan file is deleted. A finished plan is not reference.
- **Why:** on 2026-09-06 five such files held ~164 KB in `docs/reference/`, three of them long
  finished, and they were the single biggest reason the folder read as a dump. One of them
  (`script07_reference_audit_session_plan.md`) had also become the *only* home of live state —
  the §J open-findings tracker — which is now the **Status roll-up** at the top of
  `script07_security_audit.md`. Fold before deleting; check for exactly that trap.

**Naming:** `script<XX>_<type>_<optional_service>_<optional_date>.md`
- `script<XX>` — REQUIRED prefix, ONE script per file (never `script01-03_`); `type` — one of
  `design` / `implementation` / `security_audit` / `analysis` / `reference` / `report` and
  nothing else; `date` — `YYYY-MM-DD` only when multiple versions exist.
- **Three CORE files per script**, each unqualified: `script##_design.md` /
  `script##_implementation.md` / `script##_security_audit.md`. A new doc goes in one of those
  unless it genuinely is not one of them.
- Anything beyond the core three MUST carry a `<service>` qualifier so it can never be mistaken
  for a core file — `script05_design_goblin.md`, `script01_reference_flowchart.md`. A qualifier
  is not a licence to add files: check first whether it belongs in the core doc.
- A doc about work that spans scripts, or about the repo rather than a script, takes the
  `script00_` prefix — `script00_report_deferred_work.md`.

✅ `script07_security_audit_pool_2026-05-15.md`  ❌ `SECURITY_FIXES.md` (missing prefix)
❌ `script059_planning.md` (`planning` is not a type — it is `design`)
❌ `script06b_gotchas.md` (`gotchas` is not a type — as-built notes are `implementation`)

Before creating any `.md`, check if it should merge into an existing `script##_[type].md`.

## Local Test Processes — Kill Everything You Start
The dev machine is the user's **single Windows workstation**, not a disposable CI box. Every
process started locally to test/verify (python `http.server`, `node <server>.js`, jsdom
harnesses, headless browsers, watchers) MUST be killed **in the same session that started it**.
- **Prefer a process that exits on its own** — one-shot `curl`/`Invoke-WebRequest`, `bash -n`,
  `node -e`, a jsdom script. Only start a server when nothing one-shot can do the job.
- **If a server is unavoidable:** bind localhost explicitly (`python -m http.server PORT
  --bind 127.0.0.1`), capture the PID, `Stop-Process -Force` it as soon as the check is done.
- **Kill the whole tree.** Windows `python.exe` from `WindowsApps` is a launcher stub that
  spawns a second real `pythoncore-*\python.exe`, and Bash-tool launches sit under 2–3
  `bash.exe` wrappers — killing one PID leaves the listener alive.
- **Background tasks count too** — a `run_in_background` command or a spawned agent left
  running is the same problem.
- **End-of-session sweep**, alongside the `git status --short` temp-file check:
  ```powershell
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'Temp[\\/]claude[\\/]|claude[\\/]shell-snapshots|http\.server' }
  ```
  Never match or kill `msedge`/`chrome`/`Code` — those are the user's own apps.

**Why it compounds:** an orphan squats its port, so the next run picks a *new* port instead of
failing loudly. On 2026-07-26 a sweep found **35 orphans from 7/23–7/25 holding 11 ports**
(8479, 8791–8799, 8801), two bound to `::` (all interfaces — LAN-reachable, not just
localhost). Nothing had autostart persistence; they simply survived **10 days of uptime**
because the box hadn't rebooted. A reboot clears them — that is luck, not a cleanup strategy.

