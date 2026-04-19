Research before implementing the topic or feature in $ARGUMENTS.
Do NOT write any code — research and summarise only.

## 1. Existing patterns in this codebase

- Search `scripts/lib/` for functions that already do something similar
- Check if a config key for this already exists in `web/052_drop/server/config.js` DEFAULTS
- Check `scripts/052_grin_drop.sh` and the relevant lib file for prior art
- `git log --oneline -20` for recent context
- `git log --all --oneline -- <relevant-file>` for history of a specific file

## 2. Grin wallet API

- **Tutorial + examples**: https://github.com/grincc/grin-wallet-api-tutorial
- **Rust API docs**: https://docs.rs/grin_wallet_api/latest/grin_wallet_api/

Key facts to recall:
- Owner API v3: ECDH session — `init_secure_api` → `open_wallet` → AES-256-GCM encrypted calls
- Foreign API v2: `receive_tx`, `build_coinbase` — Basic Auth + secret file, no ECDH
- Foreign port: 3415 (mainnet) / 13415 (testnet)
- Owner port: 3420 (mainnet) / 13420 (testnet)
- Secret files: `.foreign_api_secret` (foreign), `.owner_api_secret` (owner) — both in `$WALLET_DIR/`, created by `grin-wallet init -h`

## 3. Grin ecosystem repos

- **grin-wallet**: https://github.com/mimblewimble/grin-wallet — binary releases + source
- **grin node**: https://github.com/mimblewimble/grin — node config, node API
- **Official docs**: https://docs.grin.mw — slatepack spec, transaction lifecycle

## 4. Network rules (never mix these)

| | Mainnet | Testnet |
|---|---|---|
| CLI flag | *(none)* | `--testnet` |
| Currency label | `GRIN` | `tGRIN` |
| Node API | `https://api.grin.money` | `https://testapi.grin.money` |
| Wallet dir | `/opt/grin/drop-main/` | `/opt/grin/drop-test/` |

`--floonet` is obsolete — never use it.

## 5. Output format

Return:
1. What already exists in the codebase that's relevant
2. What the Grin API / docs say about this area
3. Gaps that need to be filled
4. Recommended approach (no code)
