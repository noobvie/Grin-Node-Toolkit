Perform a code quality check on shell scripts. Check the file(s) specified as $ARGUMENTS, or all scripts if none given.

## Steps

1. **Syntax** — run `bash -n` on each file, report any failures immediately.

2. **Structure order** — each executable script should follow this order:
   - `#!/bin/bash` shebang
   - Header comment block (script name, purpose, menu overview)
   - `set -euo pipefail`
   - `SCRIPT_DIR` / `TOOLKIT_ROOT` path setup
   - Variable declarations (GITHUB URLs, ports, dirs)
   - Colors block (`RED`, `GREEN`, `YELLOW`, `CYAN`, `BOLD`, `DIM`, `RESET`)
   - Logging functions (`log`, `info`, `success`, `warn`, `error`, `die`, `pause`)
   - Helper/utility functions
   - Feature functions (grouped by menu option)
   - Main menu / entry point at the bottom
   Lib files (scripts/lib/) are sourced — no shebang, no `set -euo pipefail`, just functions.

3. **Indentation** — must be 4 spaces consistently. Flag any tabs or mixed indentation.

4. **Section headers** — sections should use the Unicode box-drawing style:
   `# ─── Section Name ──────────────────────────────────────────────────────────`
   Flag plain `# ---` or `# ===` headers that should be converted.

5. **Variable quoting** — flag unquoted variable expansions in risky contexts
   (e.g. `rm $VAR`, `cd $DIR`, paths used as command arguments).

6. **Function naming** — functions must be `snake_case`. Executable scripts with a
   numeric prefix (052, etc.) should have functions prefixed accordingly
   (e.g. `drop_`, `node_`, `wallet_`).

7. **Unused variables** — flag variables declared but never referenced.

8. **Long lines** — flag lines over 100 characters (except heredocs and comments).

Report findings grouped by category with file:line references. Suggest fixes inline.
At the end, give a short summary: X issues found across Y files.
