Debug a reported issue in the Grin Node Toolkit. The problem is described in $ARGUMENTS.

## Mindset

Work top-down through the chain of trust. Stop at the first layer that breaks —
that is the root cause. Do not skip ahead, do not theorize beyond what the evidence
shows, and do not propose a fix until the cause is confirmed.

If the output of an error is too vague to act on, the correct fix is to **improve
the error message first**, then reproduce to get a clearer signal.

---

## Debug Flow

### 1. Workflow — is the service running as expected?

Check that every process in the chain is alive and on the correct port:

```bash
# Systemd service
systemctl status <service>

# Tmux sessions (wallet listeners)
tmux ls 2>/dev/null

# Ports actually listening
ss -tlnp | grep -E '<expected ports>'

# Recent service output
journalctl -u <service> -n 50 --no-pager
```

If anything here is missing or on the wrong port — fix it before going further.

---

### 2. Logic — does the config/data match what the code expects?

Read the actual values the running service will see, not what you think they should be:

```bash
# Config file contents
cat <conf file>

# DB / state files exist?
ls -la <data dir>

# API quick probe (bypass nginx, hit the service directly)
curl -s http://127.0.0.1:<port>/api/status | python3 -m json.tool
```

Check: does the config match the code defaults? Are paths correct? Is the data
consistent with the expected state (e.g. no stale pending rows blocking progress)?

---

### 3. Syntax — is the code or config structurally valid?

```bash
# Shell scripts
bash -n <file.sh>

# TOML (grin-wallet config)
grep -A10 '^\[wallet\]' <grin-wallet.toml>

# JSON config
python3 -c "import json; json.load(open('<conf>'))" && echo OK
```

For Node.js: check if the server even started cleanly — look for syntax errors or
uncaught exceptions at the top of the journal output.

---

### 4. Authorization — do the right users own the right files?

Many failures in this project trace back to a file being `root:root` when the
`grin` service user needs to read it.

```bash
# Ownership of every file the service touches
ls -la <service dir>/
ls -la <conf file>
ls -la <secret files>

# Who is running the service?
systemctl show <service> --property=User
```

Expected ownership pattern for 052 Grin Drop (testnet):
```
grin:grin 600  /opt/grin/drop-test/grin_drop_test.conf
grin:grin 600  /opt/grin/drop-test/.owner_api_secret
grin:grin 600  /opt/grin/drop-test/.foreign_api_secret
grin:grin 644  /opt/grin/drop-test/public_html/*  (dirs: 755)
www-data:www-data 644  /var/www/grin-drop-home/*
```

---

### 5. Security — is something being actively blocked?

```bash
# Firewall rules
ufw status numbered

# Nginx rejecting at the vhost level?
tail -20 /var/log/nginx/grin-drop-<domain>-error.log

# SELinux / AppArmor denials (if applicable)
dmesg | grep -i denied | tail -10
```

---

## If the Issue Is Still Not Resolved

Before trying another fix, **improve the error output** so the next attempt gives
a clear signal:

- Add a specific log line at the exact point of failure (not just a generic catch-all)
- Log the actual values being used (file path, port, user, response code) not just "error"
- Make the error message tell the operator what to check: file path, what to run, what it should say

Only after the improved error is deployed and reproduced should you propose a code fix.
This prevents guessing and avoids patching the wrong layer.
