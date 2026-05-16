# Mining Pool Documentation Structure

**Last Updated:** 2026-05-15  
**Purpose:** Standard organization for Script 07 (Mining Pool) documentation

---

## 📋 File Organization Standard

All mining pool documentation files follow a consistent naming convention:

```
flowcharts/
├── README.md                              ⭐ Index & navigation (all docs)
│
├── Core Implementation Docs (READ FIRST)
│   ├── script07_design_specification.md       Design & architecture
│   ├── script07_implementation_guide.md       Code & implementation
│   └── script07_deployment_guide.md           Testing & deployment
│
├── Reference Docs (OPTIONAL)
│   ├── script07_implementation_guides.md      Detailed walkthroughs
│   ├── script07_testnet_quickstart.md         Testnet solo mining
│   └── script07_flow_refactor.txt             Code structure notes
│
├── Audit & Process Docs (REFERENCE)
│   ├── script07_security_audit_2026-05-15.md  Security findings & fixes
│   ├── script07_consolidation_summary.md      Documentation consolidation process
│   └── script07_audit_2026-05-15.md           Earlier compliance audit
│
└── Archives (BACKUP)
    ├── script07_admin_backend_design_backup.md
    ├── script07_config_schema_backup.md
    └── script07_health_api_security_backup.md
```

---

## 🏷️ Naming Convention Rules

**All mining pool docs must follow:**

```
script07_<purpose>_<optional-date>.md
```

### Examples:
- ✅ `script07_design_specification.md` — Core architecture
- ✅ `script07_security_audit_2026-05-15.md` — Timestamped audit
- ✅ `script07_consolidation_summary.md` — One-time process doc
- ❌ `SECURITY_AUDIT_FIXES.md` — Missing prefix ❌
- ❌ `Consolidation_Summary.md` — Wrong case ❌

### Date Format:
- Use `YYYY-MM-DD` format when timestamping
- Only add date if multiple versions exist for same doc
- Example: `script07_security_audit_2026-05-15.md`

---

## 📚 Current File Inventory

| File | Purpose | Audience | Status |
|------|---------|----------|--------|
| **README.md** | Navigation & overview | Everyone | ✅ Current |
| **script07_design_specification.md** | System architecture (16 KB) | Architects, DevOps | ✅ Current |
| **script07_implementation_guide.md** | Code examples (17 KB) | Developers | ✅ Current |
| **script07_deployment_guide.md** | Testing & deployment (18 KB) | DevOps, QA | ✅ Current |
| **script07_implementation_guides.md** | Detailed patterns (21 KB) | Developers | ✅ Reference |
| **script07_testnet_quickstart.md** | Testnet setup (8 KB) | Testers | ✅ Reference |
| **script07_security_audit_2026-05-15.md** | Security findings (12 KB) | Security, DevOps | ✅ Current |
| **script07_consolidation_summary.md** | Doc consolidation (8 KB) | Maintainers | ✅ Reference |
| **script07_audit_2026-05-15.md** | Compliance audit (9 KB) | Auditors | ✅ Archive |
| **script07_flow_refactor.txt** | Code structure (2 KB) | Developers | ✅ Reference |
| **script07_*_backup.md** (3 files) | Archived content (47 KB) | Historical | ✅ Archive |

**Total:** 10 active files + 3 backups (150 KB)

---

## 📖 How to Use

### For New Developers
1. Start with **README.md** (overview)
2. Read **script07_design_specification.md** (understand architecture)
3. Read **script07_implementation_guide.md** (see code examples)

### For DevOps/Deployment
1. Read **script07_deployment_guide.md** (complete testing + deployment)
2. Reference **script07_design_specification.md** for architecture details

### For Security Review
1. Read **script07_design_specification.md** (design security section)
2. Review **script07_security_audit_2026-05-15.md** (all fixes applied)
3. Check **script07_consolidation_summary.md** (process documentation)

### For Testing
1. Use **script07_deployment_guide.md** (5-phase testing checklist)
2. Reference **script07_testnet_quickstart.md** (testnet solo mining)

---

## ✏️ Adding New Documentation

When creating new docs:

1. **Use the `script07_` prefix:**
   ```
   script07_feature_name.md
   ```

2. **Use lowercase with underscores:**
   ```
   ✅ script07_withdrawal_system.md
   ❌ script07_WithdrawalSystem.md
   ❌ script07_withdrawalSystem.md
   ```

3. **Add date only if versioning:**
   ```
   ✅ script07_security_audit_2026-05-15.md (first version)
   ✅ script07_security_audit_2026-05-20.md (update with new date)
   ❌ script07_security_audit.md (no version = ambiguous)
   ❌ script07_security_audit_v2.md (use date, not v2)
   ```

4. **Place in flowcharts directory:**
   ```
   d:/Git_noob/Grin-Node-Toolkit/flowcharts/script07_*.md
   ```

5. **Update README.md** to add reference if user-facing

---

## 🗑️ Removing/Archiving Docs

When consolidating or removing docs:

1. **Don't delete — backup first:**
   ```
   script07_old_feature.md → script07_old_feature_backup.md
   ```

2. **Update README.md** to note the consolidation

3. **Update git history** with consolidation notes in commit message

4. **Keep backups** in flowcharts/ for reference

---

## 🔍 Filtering by Purpose

All mining pool docs can be filtered using prefix:

```bash
# List all mining pool docs
ls flowcharts/script07_*.md

# List only design docs
grep script07_design flowcharts/*

# List only implementation docs
grep script07_impl flowcharts/*

# Count total docs
ls flowcharts/script07_*.md | wc -l
```

---

## 📊 Document Categories

### Core (Must Read)
- `design_specification` — Architecture
- `implementation_guide` — Code
- `deployment_guide` — Testing & ops

### Reference (Optional)
- `implementation_guides` — Detailed patterns
- `testnet_quickstart` — Quick setup
- `flow_refactor` — Code notes

### Audit (Historical)
- `security_audit_*` — Security findings
- `consolidation_summary` — Process docs
- `audit_*` — Compliance audits
- `*_backup` — Archived content

---

## ✅ Maintenance Checklist

When maintaining documentation:

- [ ] All files use `script07_` prefix
- [ ] No spaces in filenames (use underscores)
- [ ] Date format is `YYYY-MM-DD` when used
- [ ] README.md includes all current docs
- [ ] Backup files have `_backup` suffix
- [ ] No duplicate content across files
- [ ] Single source of truth for each topic
- [ ] File sizes reasonable (< 50 KB per file)
- [ ] All links in README.md are valid

---

## 🔗 Related Files

- **README.md** — Master index
- **CLAUDE.md** — Project instructions (root)
- **MEMORY.md** — User memory (home directory)

---

**Last Updated:** 2026-05-15  
**Author:** Claude Code  
**Status:** Active — Use this structure for all future mining pool documentation
