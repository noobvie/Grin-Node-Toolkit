# script01_tor_onion — Tor HiddenService for Grin Foreign API

## What it is

Every node built by `01_build_new_grin_node.sh` is exposed as a Tor
HiddenService (`.onion`) HTTP mirror of its Foreign API by default. Wallets
and explorers can fetch block data over Tor without revealing their IP, and
without your node revealing yours.

This document covers what the toolkit writes, how to migrate `.onion`
identities between VPS providers, and how to manually retrofit an existing
node that pre-dates this feature.

## What Script 01 writes

Per network (mainnet, testnet — whichever you build):

```
/etc/tor/torrc
  # >>> grin-toolkit:<network> >>>
  HiddenServiceDir /var/lib/tor/grin-<network>/
  HiddenServicePort 80 127.0.0.1:<api_port>
  # <<< grin-toolkit:<network> <<<
```

Where `<api_port>` is `3413` for mainnet, `13413` for testnet — the Grin node's
Foreign API port.

The marker comments mean the toolkit only touches blocks it itself wrote.
Anything else in `/etc/tor/torrc` (custom hidden services, control port,
SocksPort tweaks, transport plugins) is left alone.

On first run, tor generates an Ed25519 keypair in `/var/lib/tor/grin-<network>/`
and a `hostname` file derived from the public key. That `.onion` string is the
public address of your mirror.

On rebuild (M / T / K / re-run of the script), the toolkit checks whether the
torrc block already matches what it would write. If yes, no file change, no
tor reload — your existing `.onion` stays online without any flap.

## How to reach your mirror

From any machine with Tor (a wallet, a browser, another VPS):

```bash
# Probe the tip
curl --socks5-hostname 127.0.0.1:9050 \
     -u "grin:$(cat /opt/grin/node/mainnet-prune/.foreign_api_secret)" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","method":"get_tip","params":[],"id":1}' \
     http://<your>.onion/v2/foreign
```

For a fully public mirror, share the Foreign API secret openly so other
operators can reach you without coordination. For a private mirror, keep it
secret and share only with the wallets you trust.

## Migrating your `.onion` to another VPS

The `.onion` address is bound to a keypair, not to a server. You can keep the
same address forever, across cloud providers, as long as you preserve the
contents of `/var/lib/tor/grin-<network>/`.

The toolkit handles this for you:

1. **Script 089 → Backup** — when prompted at Step 5b, include Tor HiddenService
   keys. They go into the encrypted backup archive alongside everything else.

2. **Build the new node on the new VPS** with Script 01 as usual. It will set
   up its own `.onion` for now (you'll throw it away in the next step).

3. **Script 089 → Restore** the archive on the new VPS. The restore step stops
   tor, swaps in the original keypair with correct permissions and ownership,
   then restarts tor. Your old `.onion` address is now served from the new
   VPS.

4. **Verify** with `cat /var/lib/tor/grin-mainnet/hostname` — it should match
   the address from the old VPS.

5. **Decommission the old VPS** — `shred -u /var/lib/tor/grin-*/hs_ed25519_secret_key`
   before destroying the disk, so two daemons aren't serving the same identity.

## Manual retrofit for an existing node

If you have a node that was built before this feature was added, the toolkit
won't auto-retrofit it (by design — keeps the script idempotent and prevents
surprise behavior changes). Here's the 5-minute manual procedure:

```bash
# 1. Make sure tor is installed and running
sudo apt-get install -y tor          # or: dnf install -y tor (Rocky/Alma + EPEL)
sudo systemctl enable --now tor

# 2. Append the HiddenService stanza for whichever networks you run.
#    Use the exact markers below so a future Script 01 / 08del will treat the
#    block as toolkit-managed.
sudo tee -a /etc/tor/torrc >/dev/null <<'EOF'

# >>> grin-toolkit:mainnet >>>
HiddenServiceDir /var/lib/tor/grin-mainnet/
HiddenServicePort 80 127.0.0.1:3413
# <<< grin-toolkit:mainnet <<<
EOF

# Repeat for testnet if you run one (replace 3413 with 13413, mainnet → testnet)

# 3. Reload tor — it generates the keys + hostname automatically on first start
sudo systemctl reload tor

# 4. Wait ~10 seconds, then read your new .onion address
cat /var/lib/tor/grin-mainnet/hostname

# 5. Test from another Tor-capable machine
curl --socks5-hostname 127.0.0.1:9050 http://<your>.onion/ -I
```

That's all. From this point your existing node is reachable as a `.onion`
mirror, and a subsequent rebuild via Script 01 will recognise the marker block
and leave the existing keypair in place.

## Security notes

- The **secret key** (`hs_ed25519_secret_key`) is your `.onion` identity. Treat
  it like an SSH host key or a wallet seed. Anyone with the file can
  impersonate your service permanently.
- The **Foreign API secret** (`.foreign_api_secret`) gates JSON-RPC calls
  regardless of how clients reach you (clearnet IP or `.onion`). For a public
  mirror, publish it openly; for a private mirror, keep it private.
- The **Owner API secret** (`.api_secret`) gates node-management calls. Never
  publish this one. Even on a public mirror, anyone hitting `/v2/owner` over
  Tor will get 401.
- The **Tor SOCKS port** (`127.0.0.1:9050`) is loopback-only by default. Don't
  expose it to the network — that would create an open SOCKS proxy.
- If you ever suspect your secret key was leaked, the only fix is to
  `rm -rf /var/lib/tor/grin-<network>/` and `systemctl restart tor`. A fresh
  keypair generates a fresh `.onion` address; the old one is permanently gone.

## How to share your `.onion`

To grow the community pool of Tor-reachable Grin mirrors:

1. Post your `.onion` URL on the Grin forum (forum.grin.mw) in a dedicated
   thread.
2. Or open a PR against `scripts/lib/06_external_nodes.json` adding your URL
   under `mainnet.tor` or `testnet.tor`.

The ecosystem checker in Script 06 will then probe your mirror hourly and
contribute its uptime to the toolkit's published health page.
