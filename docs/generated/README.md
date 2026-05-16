# Generated Files — Central Repository

**Purpose:** All generated documentation, audit reports, analysis, and temporary documentation files are stored here with clear naming conventions and dates.

## Files

| File | Purpose | Date | Status |
|------|---------|------|--------|
| [security_pool_audit_2026-05-15.md](security_pool_audit_2026-05-15.md) | Mining pool security audit & fixes | 2026-05-15 | Complete |
| [reference_mining_pool_documentation_standard_2026-05-15.md](reference_mining_pool_documentation_standard_2026-05-15.md) | Mining pool docs organization guide | 2026-05-15 | Reference |

## Naming Convention

All files follow this pattern:

```
<type>_<service>_<optional_date>.md
```

- `<type>`: `security`, `audit`, `analysis`, `reference`, `flowchart`, etc.
- `<service>`: What component/service this relates to (e.g., `pool`, `node`, `wallet`)
- `<optional_date>`: `YYYY-MM-DD` format, only if multiple versions exist

### Examples
- ✅ `security_pool_audit_2026-05-15.md` — Security audit for mining pool
- ✅ `audit_node_2026-05-10.md` — Node compliance audit
- ✅ `analysis_performance_2026-05-15.md` — Performance analysis
- ✅ `reference_pool_architecture.md` — Reference documentation (no date)
- ❌ `SECURITY_FIXES.md` — No prefix or date ❌
- ❌ `PoolAudit.md` — Wrong case ❌

## Rules

1. **Never scatter files** — all generated/temporary docs go here
2. **Always use prefixes** — type_service_date format
3. **Use YYYY-MM-DD dates** — for version tracking when needed
4. **Update this README** — when adding new files
5. **Archive old versions** — rename with `_archive` suffix, don't delete

## When to Promote

Files in this directory can be promoted to permanent documentation:

- Move to `docs/<service>/` and remove date/prefix
- Update README.md in target directory
- Update this README to mark as archived/promoted

---

**Last Updated:** 2026-05-15
