Perform a deep logic and security review on shell scripts. Review the file(s) specified as $ARGUMENTS, or all recently changed scripts (`git diff --name-only HEAD`) if none given.

## Steps

### 1. Logic & Flow Correctness
- Does the menu structure in the header comment match the actual `case` statement options?
- Are all menu options reachable? Flag dead branches or options that fall through without action.
- Check that `set_network` / network-selection functions correctly populate all
  `DROP_NETWORK`, `DROP_NET_FLAG`, `DROP_NET_LABEL`, `DROP_WALLET_DIR`, etc. before use.
- Verify testnet and mainnet paths/ports are never mixed within a single execution flow.

### 2. Security Issues
- **Unguarded `rm -rf`** — any `rm -rf $VAR` without `${VAR:?}` guard is dangerous.
  The safe pattern is `rm -rf "${VAR:?}"/subpath`.
- **Unquoted variables in commands** — `curl $URL`, `cd $DIR`, filenames with spaces.
- **`eval` usage** — flag every occurrence. Almost always replaceable with safer alternatives.
- **Hardcoded secrets** — passwords, API keys, tokens in plain text. Secrets must come
  from files (`cat "$secret_file"`) or `read -r -s`, never hardcoded.
- **World-writable permissions** — `chmod 777` or `chmod a+w` on sensitive files/dirs.
- **`--floonet` flag** — wrong. Must be `--testnet`.
- **curl with user-supplied input** — flag any curl where a URL is built from
  unvalidated user input (e.g. `read domain; curl "$domain"`).
- **Temp file race conditions** — `/tmp/fixed-name` files should use `mktemp` instead.

### 3. Error Handling
- Critical operations (binary download, wallet init, nginx reload, systemd enable)
  must have explicit error handling — either `|| die "message"` or checked exit codes.
- `curl` calls should use `-fsSL` (fail on HTTP errors) not just `-sL`.
- Archive extractions should verify integrity before extracting (checksum check).

### 4. Input Validation
- Domain name inputs: are they validated before being written into nginx configs?
- Port number inputs: are they checked to be numeric and in valid range?
- Wallet passphrase inputs: are they handled with `read -r -s` (no echo)?

### 5. Mainnet/Testnet Isolation
- Confirm service names, ports, and directories are fully distinct per network.
  Mainnet and testnet must never share a port, dir, or systemd unit name.
- Check that `tGRIN` label is used in all testnet-facing output, never `GRIN`.

Report by category with file:line references and a concrete fix for each issue.
End with a risk summary: critical / medium / low counts.
