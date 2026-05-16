# Generated Files — Central Repository

**Purpose:** All generated documentation, audit reports, analysis, and temporary documentation files are stored here with clear naming conventions and script prefixes.

## Script 07 — Mining Pool Files

| File | Type | Purpose | Date | Status |
|------|------|---------|------|--------|
| [script07_design_specification.md](script07_design_specification.md) | Design | System architecture & design | - | Current |
| [script07_implementation_guide.md](script07_implementation_guide.md) | Guide | Code examples & patterns | - | Current |
| [script07_implementation_guides.md](script07_implementation_guides.md) | Guide | Detailed implementation walkthroughs | - | Reference |
| [script07_deployment_guide.md](script07_deployment_guide.md) | Guide | Testing & deployment procedures | - | Current |
| [script07_testnet_quickstart.md](script07_testnet_quickstart.md) | Guide | Testnet solo mining setup | - | Reference |
| [script07_security_audit_2026-05-15.md](script07_security_audit_2026-05-15.md) | Audit | Security vulnerabilities & fixes | 2026-05-15 | Complete |
| [script07_security_pool_audit_2026-05-15.md](script07_security_pool_audit_2026-05-15.md) | Audit | Pool security audit report | 2026-05-15 | Complete |
| [script07_audit_2026-05-15.md](script07_audit_2026-05-15.md) | Audit | Compliance audit findings | 2026-05-15 | Archive |
| [script07_consolidation_summary.md](script07_consolidation_summary.md) | Summary | Documentation consolidation process | - | Reference |
| [script07_reference_documentation_standard_2026-05-15.md](script07_reference_documentation_standard_2026-05-15.md) | Reference | Mining pool docs organization guide | 2026-05-15 | Reference |
| [script07_admin_backend_design_backup.md](script07_admin_backend_design_backup.md) | Backup | Admin backend design (archived) | - | Archive |
| [script07_config_schema_backup.md](script07_config_schema_backup.md) | Backup | Pool config schema (archived) | - | Archive |
| [script07_health_api_security_backup.md](script07_health_api_security_backup.md) | Backup | Health API security (archived) | - | Archive |

## Naming Convention

All files follow this pattern:

```
script<XX>_<type>_<service>_<optional_date>.md
```

- **script<XX>**: Script number (e.g., `script07`, `script04`, `script06`) — **REQUIRED**
- **<type>**: `security`, `audit`, `analysis`, `reference`, `guide`, `summary`, `backup`, etc.
- **<service>**: Optional service/component name (e.g., `pool`, `node`, `wallet`, `api`)
- **<optional_date>**: `YYYY-MM-DD` format, only if multiple versions exist

### Examples
- ✅ `script07_security_pool_audit_2026-05-15.md` — Security audit for Script 07
- ✅ `script04_audit_foreign_api_2026-05-10.md` — API audit for Script 04
- ✅ `script06_reference_health_endpoints.md` — Reference doc for Script 06
- ✅ `script07_design_specification.md` — Design spec without date
- ❌ `security_pool_audit_2026-05-15.md` — Missing script prefix ❌
- ❌ `SECURITY_FIXES.md` — No script prefix ❌

## Rules

1. **All .md files go here** — `docs/generated/` is the central location
2. **Always include script prefix** — `script##_` is REQUIRED
3. **Use lowercase with underscores** — `script07_security_pool_audit_2026-05-15.md`
4. **Use YYYY-MM-DD dates** — for version tracking when multiple versions exist
5. **Keep this README updated** — when adding or moving files
6. **Archive old versions** — rename with `_backup` or `_archive` suffix, don't delete
7. **Only .txt files in flowcharts/** — flowcharts/ contains only .txt analysis files

## When to Promote

Files can be promoted to permanent documentation in main codebase:

- Move to `docs/<service>/` and keep script prefix if relevant
- Move to script file directory and keep script prefix
- Update this README to mark as promoted
- Keep dates only if version history matters

---

**Last Updated:** 2026-05-15
