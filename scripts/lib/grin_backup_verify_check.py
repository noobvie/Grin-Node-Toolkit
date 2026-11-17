# lib/grin_backup_verify_check.py — data checks for lib/grin_backup_verify.sh.
#
# Run as `python3 -I <this file> <mode> …` from / (isolated: nothing in an extracted
# tree can shadow a module). Prints "<OK|BAD|WARN|INFO|META>\t<text>" lines; the shell
# side turns them into the ✓/✗/⚠ report. Never prints the CONTENT of a seed, key or
# password file — only names, sizes and whether the shape fits.
#
# Modes
#   tree  <root>                    profile members + every DB/JSON/TOML/key/seed under root
#                                   (env GBV_REQ, GBV_OPT, GBV_FORBID, GBV_MANIFEST)
#   sqlite <db> <label>             integrity, tables, rows, newest timestamp
#   sql   <file>                    SQLite / MySQL / PostgreSQL dump checks
#   zip   <file> <dest> <budget>    safe extract (no symlinks, no escape, size budget)
#
# Trap: the SQLite-dump loader executes operator-supplied SQL as root. It runs only in
# ":memory:", behind an authorizer that refuses ATTACH/DETACH, every PRAGMA outside a
# short allow-list and file-touching functions, and after a text scan that refuses
# ATTACH / VACUUM / load_extension outright. Extension loading is never enabled.

import calendar
import fnmatch
import json
import os
import re
import sqlite3
import stat
import sys
import time
import zipfile

CTRL = re.compile(r"[\x00-\x1f\x7f]")


def out(st, msg):
    sys.stdout.write(st + "\t" + CTRL.sub("?", str(msg)) + "\n")


def utc(e):
    return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(e))


def to_epoch(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        if x > 1e12:
            x /= 1000.0
        return x if x > 1e8 else None
    if isinstance(v, str):
        s = v.strip()
        if re.fullmatch(r"\d{9,13}(\.\d+)?", s):
            return to_epoch(float(s))
        m = re.match(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?", s)
        if m:
            try:
                return calendar.timegm(time.strptime(
                    m.group(1) + " " + m.group(2) + (m.group(3) or ":00"), "%Y-%m-%d %H:%M:%S"))
            except Exception:
                return None
    return None


def q(name):
    return '"' + name.replace('"', '""') + '"'


TS_COLS = ("created_at", "found_at", "timestamp", "ts", "time", "updated_at")
RESERVED = ("pool_fee", "prize_pool")   # pool ledger buckets (back-end-pool lib/incentives.js)


# ─── SQLite ──────────────────────────────────────────────────────────────────
def sqlite_report_con(con, label):
    """Report on an open connection. Returns True when integrity is ok."""
    try:
        ic = [str(r[0]) for r in con.execute("PRAGMA integrity_check(5)")]
        tables = [r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    except Exception as e:
        out("BAD", "%s: not a readable SQLite database (%s)" % (label, e))
        return False
    bad = ic != ["ok"]
    if bad:
        out("BAD", "%s: integrity_check FAILED — %s" % (label, "; ".join(ic)[:240]))
    counts, total, newest, where = {}, 0, None, ""
    for t in tables:
        try:
            n = con.execute("SELECT COUNT(*) FROM " + q(t)).fetchone()[0]
        except Exception as e:
            out("BAD", "%s: table %s unreadable (%s)" % (label, t, e))
            bad = True
            continue
        counts[t] = n
        total += n
        try:
            cols = [r[1] for r in con.execute("PRAGMA table_info(" + q(t) + ")")]
        except Exception:
            cols = []
        for c in TS_COLS:
            if c in cols:
                try:
                    v = con.execute("SELECT MAX(%s) FROM %s" % (q(c), q(t))).fetchone()[0]
                except Exception:
                    v = None
                e = to_epoch(v)
                if e is not None and (newest is None or e > newest):
                    newest, where = e, "%s.%s" % (t, c)
                break
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:4]
    msg = "%s: %s · %d tables · %d rows" % (label, "integrity FAILED" if bad else "integrity ok", len(tables), total)
    if top:
        msg += " · biggest: " + ", ".join("%s %d" % kv for kv in top)
    if newest:
        msg += " · newest row %s (%s)" % (utc(newest), where)
    out("INFO" if bad else "OK", msg)
    if not tables:
        out("WARN", "%s: holds no tables" % label)
    # Public pool ledger (back-end-pool lib/db.js: miner_accounts, shares, blocks).
    if "miner_accounts" in counts and not bad:
        try:
            ph = ",".join("?" * len(RESERVED))
            m, bal = con.execute(
                "SELECT COUNT(*), COALESCE(SUM(balance + balance_locked), 0) FROM miner_accounts "
                "WHERE grin_address NOT IN (%s)" % ph, RESERVED).fetchone()
            rb = con.execute(
                "SELECT COALESCE(SUM(balance + balance_locked), 0) FROM miner_accounts "
                "WHERE grin_address IN (%s)" % ph, RESERVED).fetchone()[0]
            sh = con.execute("SELECT MAX(created_at) FROM shares").fetchone()[0] if "shares" in counts else None
            she = to_epoch(sh)
            out("OK", "%s: pool ledger — %d miner accounts · balances held %.9f GRIN (incl. locked; "
                "pool_fee/prize_pool buckets %.9f) · newest share %s · %s blocks"
                % (label, m, bal, rb, utc(she) if she else "none", counts.get("blocks", "?")))
        except Exception as e:
            out("WARN", "%s: pool ledger summary failed (%s)" % (label, e))
    return not bad


def sqlite_report(path, label):
    """Open a sandbox copy and report. Returns True when it opens and integrity is ok."""
    try:
        con = sqlite3.connect(path, timeout=5)
        con.execute("PRAGMA query_only = 1")
    except Exception as e:
        out("BAD", "%s: not a readable SQLite database (%s)" % (label, e))
        return False
    try:
        return sqlite_report_con(con, label)
    finally:
        con.close()


def is_sqlite(path):
    try:
        with open(path, "rb") as f:
            return f.read(16) == b"SQLite format 3\x00"
    except Exception:
        return False


# ─── TOML ────────────────────────────────────────────────────────────────────
def toml_loader():
    """(name, load(bytes)) of the best TOML parser available, or (None, None)."""
    try:
        import tomllib
        return "tomllib", lambda b: tomllib.loads(b.decode("utf-8"))
    except Exception:
        pass
    try:
        import tomli
        return "tomli", lambda b: tomli.loads(b.decode("utf-8"))
    except Exception:
        pass
    try:
        import toml
        return "toml", lambda b: toml.loads(b.decode("utf-8"))
    except Exception:
        pass
    return None, None


TOML_KEY = r'(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|\'[^\']*\')'
TOML_KEYPATH = re.compile(r"^\s*" + TOML_KEY + r"(?:\s*\.\s*" + TOML_KEY + r")*\s*=\s*(.*)$")
TOML_TABLE = re.compile(r"^\s*\[\[?\s*" + TOML_KEY + r"(?:\s*\.\s*" + TOML_KEY + r")*\s*\]\]?\s*(#.*)?$")


def toml_basic(data):
    """Line-level TOML syntax check for pythons with no TOML parser. Returns an error or None."""
    text = data.decode("utf-8")
    depth = 0          # open [ / { across lines (multi-line arrays)
    in_ml = None       # open triple-quoted string delimiter
    for no, line in enumerate(text.splitlines(), 1):
        if in_ml:
            if in_ml in line:
                in_ml = None
            continue
        s = line.strip()
        if depth == 0:
            if not s or s.startswith("#"):
                continue
            if s.startswith("["):
                if not TOML_TABLE.match(s):
                    return "line %d: malformed table header" % no
                continue
            m = TOML_KEYPATH.match(line)
            if not m:
                return "line %d: not a key = value line" % no
            s = m.group(1)
        i, quote = 0, None
        while i < len(s):
            c = s[i]
            if quote:
                if quote == '"' and c == "\\":
                    i += 2
                    continue
                if c == quote:
                    quote = None
            else:
                if s.startswith('"""', i) or s.startswith("'''", i):
                    d = s[i:i + 3]
                    end = s.find(d, i + 3)
                    if end < 0:
                        in_ml = d
                        break
                    i = end + 3
                    continue
                if c in "\"'":
                    quote = c
                elif c == "#":
                    break
                elif c in "[{":
                    depth += 1
                elif c in "]}":
                    depth -= 1
                    if depth < 0:
                        return "line %d: unbalanced bracket" % no
            i += 1
        if quote:
            return "line %d: unterminated string" % no
    if in_ml:
        return "unterminated multi-line string"
    if depth:
        return "unbalanced brackets at end of file"
    return None


# ─── tree ────────────────────────────────────────────────────────────────────
ONION = re.compile(r"^[a-z2-7]{56}\.onion\s*$")
B64KEY = re.compile(r"^[A-Za-z0-9+/]{43}=$")

# MANIFEST.txt lines (089_backup_restore.sh run_backup) whose path must be in the archive.
MANIFEST_KEYS = ("conf", "wallet", "fidelius-wallet", "database")


def manifest_items(root):
    p = os.path.join(root, "MANIFEST.txt")
    if not os.path.isfile(p) or os.path.islink(p):
        return []
    items = []
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.match(r"^\s+([a-z-]+):\s+(/\S+)", line)
            if m and m.group(1) in MANIFEST_KEYS:
                items.append((m.group(1), m.group(2).lstrip("/").rstrip("/")))
    return items


def tree(root):
    def items(var):
        return [i for i in os.environ.get(var, "").split() if i]
    req_raw, opt, forbid = items("GBV_REQ"), items("GBV_OPT"), items("GBV_FORBID")
    entries = []          # every relative path, dirs included
    files = []            # (abs, rel) of non-symlink regular files
    for dp, dns, fns in os.walk(root):
        for d in dns:
            entries.append(os.path.relpath(os.path.join(dp, d), root))
        for f in fns:
            p = os.path.join(dp, f)
            r = os.path.relpath(p, root)
            entries.append(r)
            if not os.path.islink(p) and os.path.isfile(p):
                files.append((p, r))

    def present(prefix):
        return any(e == prefix or e.startswith(prefix + "/") for e in entries)

    # "<trigger>=><member>": the member is required only when the trigger dir is in the
    # archive (a network's dir present → that network's seed/config required).
    req = []
    for i in req_raw:
        if "=>" in i:
            trig, member = i.split("=>", 1)
            if present(trig):
                req.append(member)
        else:
            req.append(i)
    if os.environ.get("GBV_MANIFEST") == "1":
        mi = manifest_items(root)
        for _k, path in mi:
            req.append(path)
        if mi:
            out("INFO", "MANIFEST.txt lists %d conf/wallet/database member(s) — each is required" % len(mi))

    def valid(rel):
        """A required member must be a real dir or a regular non-empty file, not a symlink."""
        p = os.path.join(root, rel)
        if os.path.islink(p):
            return "is a symlink"
        if os.path.isdir(p):
            return None
        if not os.path.isfile(p):
            return "is not a regular file"
        if os.path.getsize(p) == 0:
            return "is EMPTY"
        return None

    required_files = set()
    missing = 0
    for item in req:
        alts = item.split("|")
        hits = [e for e in entries if any(fnmatch.fnmatchcase(e, a) for a in alts)]
        if not hits:
            missing += 1
            out("BAD", "required member missing: " + " or ".join(alts))
            continue
        good = [h for h in hits if valid(h) is None]
        if not good:
            missing += 1
            out("BAD", "required member %s %s" % (hits[0], valid(hits[0])))
            continue
        required_files.update(h for h in good if os.path.isfile(os.path.join(root, h)))
    if req and not missing:
        out("OK", "required members present (%d/%d)" % (len(req), len(req)))

    def first(alts):
        for e in entries:
            for a in alts:
                if fnmatch.fnmatchcase(e, a):
                    return e
        return None
    if opt:
        have = [i for i in opt if first(i.split("|"))]
        lack = [i for i in opt if i not in have]
        out("INFO", "optional members present: %s%s" % (", ".join(have) or "none",
            ("; absent: " + ", ".join(lack)) if lack else ""))
    for item in forbid:
        hit = first(item.split("|"))
        if hit:
            out("WARN", "%s is inside the archive — the personal key / offsite target must never travel in a backup" % hit)

    crit = [a for i in req + opt for a in i.split("|") if a.endswith((".json", ".toml"))]
    tname, tload = toml_loader()
    nj = nt = 0
    for p, r in sorted(files, key=lambda x: x[1]):
        name = os.path.basename(r)
        low = name.lower()
        size = os.path.getsize(p)
        is_crit = r in required_files or any(fnmatch.fnmatchcase(r, c) for c in crit)
        if low.endswith((".db", ".sqlite", ".sqlite3")):
            if is_sqlite(p):
                sqlite_report(p, r)
            elif size == 0:
                out("BAD" if is_crit else "WARN", "%s: empty file" % r)
            else:
                out("BAD" if is_crit else "WARN", "%s: named like a database but is not SQLite" % r)
        elif low.endswith(".json"):
            if size > 50 * 1024 * 1024:
                out("INFO", "%s: %d bytes — too big to parse here, skipped" % (r, size))
                continue
            try:
                with open(p, "rb") as f:
                    json.loads(f.read().decode("utf-8"))
                nj += 1
            except Exception as e:
                out("BAD" if is_crit else "WARN", "%s: JSON does not parse (%s)" % (r, str(e)[:120]))
        elif low.endswith(".toml"):
            try:
                with open(p, "rb") as f:
                    data = f.read(8 * 1024 * 1024)
                if tload:
                    tload(data)
                else:
                    err = toml_basic(data)
                    if err:
                        raise ValueError(err)
                nt += 1
            except Exception as e:
                out("BAD" if is_crit else "WARN", "%s: TOML does not parse (%s)" % (r, str(e)[:120]))
        elif name == "wallet.seed":
            if size <= 0:
                out("BAD", "%s: wallet seed file is EMPTY" % r)
                continue
            shape = None
            try:
                with open(p, "rb") as f:
                    j = json.loads(f.read().decode("utf-8"))
                if isinstance(j, dict) and "encrypted_seed" in j:
                    shape = "encrypted-seed format"
            except Exception:
                pass
            out("OK" if shape else "WARN",
                "%s: wallet seed present (%d bytes, %s; content not read out)" % (r, size, shape or "unrecognised format"))
        elif name == "hs_ed25519_secret_key":
            with open(p, "rb") as f:
                d = f.read(200)
            good = len(d) == 96 and d.startswith(b"== ed25519v1-secret: type0 ==")
            out("OK" if good else "BAD", "%s: Tor onion secret key %s" % (
                r, "has the expected 96-byte ed25519v1 format" if good else "is NOT a valid ed25519v1 secret key file"))
        elif name == "hs_ed25519_public_key":
            with open(p, "rb") as f:
                d = f.read(200)
            good = len(d) == 64 and d.startswith(b"== ed25519v1-public: type0 ==")
            out("OK" if good else "WARN", "%s: Tor onion public key %s" % (r, "format ok" if good else "has an unexpected format"))
        elif name == "hostname" and os.path.exists(os.path.join(os.path.dirname(p), "hs_ed25519_secret_key")):
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                hn = f.read(200)
            good = bool(ONION.match(hn))
            out("OK" if good else "WARN", "%s: %s" % (r, ("onion address " + hn.strip()) if good else "not a v3 .onion address"))
        elif low.endswith(".key") and (re.search(r"(^|/)wg[^/]*/", r) or r.startswith("etc/wireguard/")):
            with open(p, "r", encoding="ascii", errors="replace") as f:
                k = f.read(200).strip()
            good = bool(B64KEY.match(k))
            out("OK" if good else "BAD", "%s: WireGuard key %s" % (r, "is a 32-byte base64 key" if good else "is NOT a valid WireGuard key"))
        elif r.startswith("etc/wireguard/") and low.endswith(".conf"):
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                t = f.read(1 << 20)
            m = re.search(r"^\s*PrivateKey\s*=\s*(\S+)\s*$", t, re.M)
            good = "[Interface]" in t and m is not None and bool(B64KEY.match(m.group(1)))
            out("OK" if good else "BAD", "%s: WireGuard config %s" % (
                r, "has [Interface] + a valid PrivateKey" if good else "lacks [Interface] or a valid PrivateKey"))
    if nj:
        out("OK", "JSON: %d file(s) parse" % nj)
    if nt:
        if tname:
            out("OK", "TOML: %d file(s) parse (%s)" % (nt, tname))
        else:
            out("OK", "TOML: %d file(s) pass a basic TOML syntax check (python %d.%d has no TOML parser)"
                % (nt, sys.version_info[0], sys.version_info[1]))


# ─── SQL dumps ───────────────────────────────────────────────────────────────
# Pragmas a sqlite3 .dump / iterdump emits; every other one is refused while loading.
SAFE_PRAGMAS = {"foreign_keys", "defer_foreign_keys", "writable_schema", "user_version", "application_id"}
DENY_FUNCS = {"load_extension", "readfile", "writefile", "edit", "fts3_tokenizer"}
DUMP_DANGER = re.compile(r"(?:^|;)\s*(?:ATTACH|DETACH|VACUUM)\b|load_extension\s*\(", re.I | re.M)


def _authorizer(action, a1, a2, db, src):
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and (a1 or "").lower() not in SAFE_PRAGMAS:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (a2 or "").lower() in DENY_FUNCS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def sqlfile(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head = f.read(8192)
        f.seek(max(0, size - 8192))
        tail = f.read()
    if head.startswith(b"PGDMP"):
        out("META", "pgcustom")
        return
    h = head.decode("utf-8", "replace")
    t = tail.decode("utf-8", "replace")
    if "-- MySQL dump" in h or "-- MariaDB dump" in h:
        cre, ins = {}, {}
        rc = re.compile(r"^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`")
        ri = re.compile(r"^(?:INSERT|REPLACE) (?:IGNORE )?INTO `([^`]+)`")
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                c = line[:1]
                if c == "C":
                    m = rc.match(line)
                    if m:
                        cre[m.group(1)] = cre.get(m.group(1), 0) + 1
                elif c in ("I", "R"):
                    m = ri.match(line)
                    if m:
                        ins[m.group(1)] = ins.get(m.group(1), 0) + 1
        flavour = "MariaDB" if "-- MariaDB dump" in h else "MySQL"
        if "-- Dump completed" in t:
            out("OK", "%s dump: header and the closing \"-- Dump completed\" line are both present" % flavour)
        else:
            out("BAD", "%s dump has NO closing \"-- Dump completed\" line — truncated or cut short" % flavour)
        out("OK" if cre else "WARN", "%d CREATE TABLE · %d INSERT statements" % (len(cre), sum(ins.values())))
        if ins:
            top = sorted(ins.items(), key=lambda kv: -kv[1])[:8]
            out("INFO", "INSERT statements per table: " + ", ".join("%s %d" % kv for kv in top) + (" …" if len(ins) > 8 else ""))
        empty = [n for n in cre if n not in ins]
        if empty:
            out("INFO", "tables with no INSERT (empty or schema-only): " + ", ".join(sorted(empty)[:12]) + (" …" if len(empty) > 12 else ""))
        orphan = [n for n in ins if n not in cre]
        if orphan:
            out("WARN", "INSERT into tables never created in this dump: " + ", ".join(sorted(orphan)[:12]))
        out("INFO", "text check only — a real restore test of a %s dump belongs on a spare box" % flavour)
        return
    if "PostgreSQL database dump" in h:
        nc = ncopy = nins = 0
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("CREATE TABLE"):
                    nc += 1
                elif line.startswith("COPY ") and line.rstrip().endswith("FROM stdin;"):
                    ncopy += 1
                elif line.startswith("INSERT INTO"):
                    nins += 1
        if "PostgreSQL database dump complete" in t:
            out("OK", "PostgreSQL text dump: header and the closing \"dump complete\" line are both present")
        else:
            out("BAD", "PostgreSQL text dump has NO closing \"dump complete\" line — truncated or cut short")
        out("OK" if nc else "WARN", "%d CREATE TABLE · %d COPY blocks · %d INSERT statements" % (nc, ncopy, nins))
        return
    if re.search(r"PRAGMA foreign_keys|BEGIN TRANSACTION|CREATE TABLE", h):
        if "COMMIT;" not in t:
            out("BAD", "SQLite dump has no closing COMMIT; — truncated or cut short")
            return
        if size > (1 << 30):
            out("WARN", "SQLite dump is over 1 GiB — not test-loaded; header/footer checked only")
            return
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        if DUMP_DANGER.search(text):
            out("BAD", "dump tries to touch another database/file (ATTACH / VACUUM / load_extension) — not loaded")
            return
        con = sqlite3.connect(":memory:")
        try:
            con.set_authorizer(_authorizer)
            con.executescript(text)
            con.commit()
            con.set_authorizer(None)
        except Exception as e:
            con.close()
            out("BAD", "SQLite dump does not load into an in-memory database (%s)" % str(e)[:160])
            return
        out("OK", "SQLite dump loads into an in-memory database")
        sqlite_report_con(con, os.path.basename(path) + " (as loaded)")
        con.close()
        return
    out("WARN", "SQL text of an unrecognised dialect — readable, nothing more could be checked")


# ─── zip ─────────────────────────────────────────────────────────────────────
def unzip_safe(path, dest, budget):
    """Extract with zipfile only. Refuses symlink entries, absolute paths, '..', anything
    resolving outside dest, and more than `budget` bytes (counted while writing)."""
    budget = int(budget)
    try:
        z = zipfile.ZipFile(path)
    except Exception as e:
        out("BAD", "not a readable zip archive (%s)" % str(e)[:160])
        return
    with z:
        infos = z.infolist()
        declared = sum(i.file_size for i in infos)
        if declared > budget:
            out("BAD", "zip declares %d bytes uncompressed — more than the %d bytes this disk can spare; not extracted" % (declared, budget))
            return
        bad = z.testzip()
        if bad is not None:
            out("BAD", "zip: CRC check fails (%s)" % bad)
            return
        out("OK", "zip: every entry's CRC checks · %d entries · %d bytes uncompressed" % (len(infos), declared))
        real = os.path.realpath(dest)
        for i in infos:
            n = i.filename
            mode = (i.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                out("BAD", "zip entry %s is a symlink — not extracted" % n)
                return
            parts = n.replace("\\", "/").split("/")
            if n.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", n) or ".." in parts:
                out("BAD", "zip entry %s escapes the extract dir — not extracted" % n)
                return
            target = os.path.realpath(os.path.join(real, *[p for p in parts if p]))
            if target != real and not target.startswith(real + os.sep):
                out("BAD", "zip entry %s resolves outside the extract dir — not extracted" % n)
                return
        written = 0
        for i in infos:
            parts = [p for p in i.filename.replace("\\", "/").split("/") if p]
            target = os.path.join(real, *parts) if parts else real
            if i.is_dir():
                os.makedirs(target, mode=0o700, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            with z.open(i) as src, open(target, "xb") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > budget:
                        out("BAD", "zip expands past its declared size and the disk budget — extract stopped")
                        return
                    dst.write(chunk)
            os.chmod(target, 0o600)
        out("OK", "extracted every entry into the sandbox (python zipfile; symlinks and escaping paths refused)")
        out("META", "extracted")


def main():
    mode = sys.argv[1]
    if mode == "tree":
        tree(sys.argv[2])
    elif mode == "sqlite":
        sqlite_report(sys.argv[2], sys.argv[3])
    elif mode == "sql":
        sqlfile(sys.argv[2])
    elif mode == "zip":
        unzip_safe(sys.argv[2], sys.argv[3], sys.argv[4])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        out("BAD", "data check crashed (%s: %s)" % (type(e).__name__, str(e)[:160]))
