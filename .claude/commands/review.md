Review all staged or recently changed shell scripts for:

1. Syntax errors (`bash -n`)
2. Hardcoded secrets, passwords, or absolute paths that should be variables
3. Missing `set -euo pipefail` at the top of executable scripts (not lib files)
4. Mainnet/testnet port or directory mixups
5. Use of `--floonet` flag (wrong — should be `--testnet`)
6. Functions in lib files that don't follow the `prefix_snake_case` naming convention

Run `git diff --name-only HEAD` to find changed files, then check only those.
Report issues by file and line number.
