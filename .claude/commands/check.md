Run a bash syntax check on all shell scripts in the project.

```bash
for f in scripts/*.sh scripts/lib/*.sh; do
  bash -n "$f" && echo "OK: $f" || echo "FAIL: $f"
done
```

Report any failures clearly with the filename and error. If all pass, confirm with a summary count.
