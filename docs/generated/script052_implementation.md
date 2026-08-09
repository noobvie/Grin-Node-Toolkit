# Script 052 — Accio: implementation & session log

The **handoff between build sessions is this file, never the chat.** Each packet ends by
writing its outcome here; the next session reads this file plus its own packet in
`script052_design.md` §"Build plan" — and nothing else. If a session ends with knowledge only
in a conversation, the packet is not finished.

**Standing header — paste at the top of each new session**, substituting the packet number:

```
Working on Accio (script 052), session S<n> of docs/generated/script052_design.md
§"Build plan". Read that packet's "Read first" list, do the "Do" list, verify with
"Verify", then do "Close-out". Do not read other packets. Do not run scripts locally —
this is a VPS product.
```

## Current state

| | |
|---|---|
| Packets done | **S0** |
| Next packet | **S1** — own the build (`scripts/lib/052_lib_build.sh`), no VPS |
| Deployed anywhere? | **No.** Nothing has ever run on a VPS. |
| Hub 05 key `2` | still `_slot_notice` — wired to the real script in **S7** |
| Upstream pin | `adef11daadf04e4ec259d6febcc720da3daaa6c7` (v2.8.2, MIT) |

`S6` (integrity + update check) has no dependency past S0 and needs no VPS — it is the natural
filler for a short session if S1 is not the right size for the time available.

---

## Session log

### S0 — Vendor & pin — 2026-08-09 ✅

**Outcome: `052` exists, and Accio is permanently independent.** MIT is irrevocable for the
copy we received, so that is now a licensing fact rather than something later engineering
earns. Everything after this removes *operational* dependencies only.

**Files created**

| Path | What it is |
|---|---|
| `web/052_accio/vendor/upstream-wallet/` | the pinned upstream tree, 270 files, unrenamed and unmodified |
| `web/052_accio/vendor/SHA256SUMS` | per-file pin, `sha256sum -c` clean at vendor time |
| `web/052_accio/PINNED_SHA` | shell-sourceable pin record + the exact reproduction command |
| `web/052_accio/PROVENANCE.md` | what `vendor/` is, disposition table, measurements, naming policy |
| `web/052_accio/.gitattributes` | `vendor/** -text` — stops this repo renormalising the pinned bytes |
| `web/052_accio/docs/upstream-nginx.conf.reference` | upstream's `nginx.conf`, kept as the spec S3/S4b replace |
| `web/052_accio/gateway/README.md` | the four jobs our Node service must carry (empty until S3) |
| `web/052_accio/patches/README.md` | overlay rules (empty until S5) |
| `scripts/052_grin_accio.sh` | menu skeleton, every action a stub — **this is what assigned the number** |
| `docs/generated/script052_design.md` | PART A moved out of `script05_design.md` |
| `docs/generated/script052_implementation.md` | this file |

**The pin**

```
UPSTREAM      github.com/NicolasFlamel1/mwcwallet.com
SHA           adef11daadf04e4ec259d6febcc720da3daaa6c7   ("Removed AscendEX compatibility
              from README", 2026-07-30)
VERSION       2.8.2, released 16 Jun 2026 16:02:00 UTC
LICENSE       MIT, sha256 bbc8b96cd3c66cd7d69ec75aaeae3b0d5d81d955771fadf7bc0cdc953728e32f
VENDORED      270 files / 7,443,197 bytes  (upstream ships 273)
MANIFEST      vendor/SHA256SUMS, sha256 fb43f4ef82669c8c1db42985e1285067d47f5836d8196764ca03afa8e94644f0
```

**Removed from the tree:** `fullchain.pem` + `privkey.pem` deleted (upstream's own dev cert
and **private key** — never redistribute someone else's key material), `nginx.conf` moved to
`web/052_accio/docs/upstream-nginx.conf.reference` so it can never be mistaken for config we
deploy. Nothing else was touched, including upstream's own `.gitignore`.

**Design measurements re-verified against the real tree** — all confirmed: 105 JS files, 11
PHP files, and `scripts/node.js` lines **512** / **535** do carry `https://api.grin.money` and
`https://testapi.grin.money`, i.e. this toolkit's own Script 04 endpoints ship in upstream's
stock default node list.

#### Three things the plan did not anticipate

1. **⚠ `git archive` honours `core.autocrlf`.** The first vendoring was done from a normal
   `git clone` on Windows, where `core.autocrlf=true` rewrote every text file to CRLF on
   checkout; switching to `git archive` did **not** fix it, because archive applies the same
   setting. `LICENSE` hashed `eb2c5d88…` instead of upstream's `bbc8b96c…` — a "vendored,
   pinned, byte-exact" tree that was none of those things, and the kind of error that only
   shows up years later as an unreadable upstream diff. The pin is only correct because the
   raw blob (`git cat-file blob HEAD:LICENSE`) was compared against the file on disk.
   **Always re-vendor with `git -c core.autocrlf=false -c core.eol=lf archive`**, and verify
   with `diff -r` against a fresh extraction, not by spot-checking one file.
2. **This repo would have re-broken it on the next clone.** The root `.gitattributes` sets
   `* text=auto eol=lf`, which is right for our own scripts and wrong for a checksummed
   vendor tree. `web/052_accio/.gitattributes` now sets `vendor/** -text` (verified with
   `git check-attr text`), so the pinned bytes survive commit → clone → checkout unchanged.
3. **The tree is 7.10 MiB, not the 4.7 MB in the design.** That figure was GitHub's *packed*
   repository size. Nothing is missing — `diff -r` against a fresh archive of `adef11da` is
   empty. Also, upstream ships a **fifth** WASM blob the design did not list: `SMAZ-0.0.31`
   (short-string compression, not cryptography).

#### Two files added beyond the S0 plan

- `vendor/SHA256SUMS` — S6 is specified as verifying the tree "against a committed checksum",
  and vendor time is the only honest moment to certify what we actually received. S6 now
  consumes this file rather than minting one from a tree nobody re-checked.
- `web/052_accio/.gitattributes` — forced by finding #2 above.

#### Notes for later packets

- **S1** — the 11 PHP files are `backend/{additional_text,common,language,resources}.php`,
  `errors/template.php`, and six `languages/*.php`. `public_html/.user.ini` is a php-fpm
  *runtime* config (it even hardcodes upstream's `session.save_path=/srv/mwcwallet.com/sessions`)
  — it must **not** be deployed, since PHP is build-time only.
- **S3/S4b** — `web/052_accio/docs/upstream-nginx.conf.reference` (58,454 bytes) is the
  behavioural spec for the `/tor/` regex, the request/response header allowlists and
  upstream's gateway on `:9000`. Read it; never deploy it.
- **Ports chosen** (checked free against the whole repo — 7420 Fidelius, 7456/7466/7556/7566
  Transporter, 7516/7517/7572 in use): gateway **7480** mainnet / **7490** testnet, onion
  front **7580** / **7590**. The onion deliberately gets its own local port — nginx and Tor
  both arrive on `127.0.0.1`, and a Tor client that can forge `X-Forwarded-For` would mint a
  fresh identity per request and void every per-client limit. This is 093's lesson, applied
  before the service exists rather than after.
- **Hub 05 is untouched.** Key `2` still dispatches `_slot_notice`; wiring it to
  `run_sub "052_grin_accio.sh"` is S7, and doing it earlier would advertise a menu of stubs.

**Verify — all green**

- `bash -n scripts/052_grin_accio.sh` → OK
- `vendor/upstream-wallet/LICENSE` byte-identical to upstream (`bbc8b96c…`)
- `diff -r` vendored tree vs fresh `git archive` of `adef11da` → empty, 270 files
- `sha256sum -c vendor/SHA256SUMS --quiet` → clean
- no `.git`, no `*.pem`, no `*.key` anywhere under `web/052_accio/`
- `git check-attr text` → `unset` for `vendor/**` and the nginx reference
