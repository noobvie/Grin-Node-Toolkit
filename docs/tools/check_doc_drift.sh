#!/usr/bin/env bash
#
# check_doc_drift.sh — find repo file paths named in docs/generated/*.md that no
# longer exist (or never existed).
#
# The failure mode this catches: a doc names scripts/lib/07_lib_satellite.sh in a
# "built" status table with a green tick. The file was deleted in f2ebade on
# 2026-06-22. The prose still reads correctly, so nobody notices, and the table
# reads as verified fact.
#
# Not in scripts/ — that namespace is the numbered VPS toolkit and every file
# there maps to a script number. Not in docs/generated/ — that is the reference
# library, prose only. This is a repo tool, so it lives in docs/tools/.
#
# Usage:
#   docs/tools/check_doc_drift.sh [--verbose] [DOC ...]
#
# Exit: 0 = no unexplained miss, 1 = at least one genuine miss, 2 = tool error.

set -uo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root from this script's own location (docs/tools/ -> ../..).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/doc_drift_allowlist.txt"
cd "$REPO_ROOT" || { echo "cannot cd to repo root" >&2; exit 2; }

VERBOSE=0
DOCS=()
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *)  DOCS+=("$arg") ;;
  esac
done
FULL_RUN=0
if [[ ${#DOCS[@]} -eq 0 ]]; then
  FULL_RUN=1
  while IFS= read -r d; do DOCS+=("$d"); done < <(ls docs/generated/*.md 2>/dev/null | sort)
fi
[[ ${#DOCS[@]} -gt 0 ]] || { echo "no docs to check" >&2; exit 2; }

# Extensions we treat as "this names a file in the repo".
# Deliberately excludes .toml/.conf/.service/.timer/.log: in this repo those are
# almost always VPS artifacts (grin-server.toml, grin-drop.service), not repo files.
#
# The \b after the group is load-bearing. Without it, "package.json" matches the
# "js" alternative and yields a spurious "package.js" — the extension has to be
# anchored at a word boundary, not merely present.
EXT='sh|js|mjs|cjs|py|php|html|css|md|json|sql|svg'
# A leading "." or "*" is part of the token: without it ".claude/CLAUDE.md" is
# extracted as "claude/CLAUDE.md" and ".min.js" as "min.js", and both then
# resolve nowhere and read as drift.
CAND_RE="[*.]?[A-Za-z0-9_][A-Za-z0-9_.*-]*(/[A-Za-z0-9_.*-]+)*\.($EXT)\b"

# Top-level dirs that make a path repo-root-relative.
ROOT_DIRS='web|scripts|docs|extensions'

# ---------------------------------------------------------------------------
# 1. Index every tracked file, and every segment-aligned suffix of its path.
#    The suffix index is what resolves a bare "lib/db.js" back to
#    web/07_mining_pool_public/back-end-pool/lib/db.js.
# ---------------------------------------------------------------------------
declare -A EXIST=()      # full repo-relative path -> 1
declare -A SUFFIX=()     # path suffix -> newline-joined list of full paths

FILE_LIST="$(git ls-files 2>/dev/null)"
if [[ -z "$FILE_LIST" ]]; then
  FILE_LIST="$(find . -type f -not -path './.git/*' | sed 's#^\./##')"
fi
[[ -n "$FILE_LIST" ]] || { echo "could not enumerate repo files" >&2; exit 2; }

while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  EXIST["$f"]=1
done <<< "$FILE_LIST"

while IFS=$'\t' read -r suf full; do
  [[ -n "$suf" ]] || continue
  if [[ -n "${SUFFIX[$suf]:-}" ]]; then
    SUFFIX["$suf"]="${SUFFIX[$suf]}"$'\n'"$full"
  else
    SUFFIX["$suf"]="$full"
  fi
done < <(printf '%s\n' "$FILE_LIST" | awk -F/ '{
    for (i = 1; i <= NF; i++) {
      s = "";
      for (j = i; j <= NF; j++) s = (s == "" ? $j : s "/" $j);
      print s "\t" $0;
    }
  }')

# ---------------------------------------------------------------------------
# 2. Allowlist. Format, one entry per line:
#       <path-or-glob> | <category> | <reason>
#    Categories: planned | not-a-path | external | deleted
#    A reason is MANDATORY — a bare allowlist rots as silently as the docs do.
# ---------------------------------------------------------------------------
declare -A AL_CAT=() AL_REASON=() AL_USED=()
AL_ORDER=()
if [[ -f "$ALLOWLIST" ]]; then
  al_lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    al_lineno=$((al_lineno + 1))
    line="${line%%$'\r'}"
    [[ -n "${line// /}" ]] || continue
    [[ "${line#\#}" == "$line" ]] || continue
    IFS='|' read -r al_path al_cat al_reason <<< "$line"
    al_path="$(printf '%s' "${al_path:-}"     | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    al_cat="$(printf '%s'  "${al_cat:-}"      | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    al_reason="$(printf '%s' "${al_reason:-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ -z "$al_path" || -z "$al_cat" || -z "$al_reason" ]]; then
      echo "allowlist:$al_lineno: need '<path> | <category> | <reason>' — got: $line" >&2
      exit 2
    fi
    case "$al_cat" in
      planned|not-a-path|external|deleted) ;;
      *) echo "allowlist:$al_lineno: unknown category '$al_cat'" >&2; exit 2 ;;
    esac
    AL_CAT["$al_path"]="$al_cat"
    AL_REASON["$al_path"]="$al_reason"
    AL_ORDER+=("$al_path")
  done < "$ALLOWLIST"
fi

# Does $1 match an allowlist entry (exact, or the entry is a glob)? Sets AL_HIT.
AL_HIT=""
allow_match() {
  local cand="$1" pat
  AL_HIT=""
  if [[ -n "${AL_CAT[$cand]:-}" ]]; then AL_HIT="$cand"; return 0; fi
  for pat in "${AL_ORDER[@]:-}"; do
    [[ -n "$pat" ]] || continue
    # a glob entry needs *, ? or a [..] class — [Cc]hart.js has none of the first two
    case "$pat" in *[*?[]*) ;; *) continue ;; esac
    # shellcheck disable=SC2053
    if [[ "$cand" == $pat ]]; then AL_HIT="$pat"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# 3. Which product trees does a doc talk about?
#    script07_*.md  -> web/07_mining_pool_public, web/07_mining_pool_solo
#    script052_*.md -> web/052_accio  (which is why "scripts/language.js", an
#                      UPSTREAM path inside the vendored wallet, resolves)
#    script00_*.md  -> the whole repo (it is the cross-script prefix)
# ---------------------------------------------------------------------------
WEB_DIRS=()
while IFS= read -r d; do WEB_DIRS+=("${d%/}"); done < <(ls -d web/*/ 2>/dev/null)

doc_bases() {
  # echoes one base dir per line
  local doc num dir dirnum
  doc="$(basename "$1")"
  num="$(printf '%s' "$doc" | sed -nE 's/^script([0-9]+[a-z]?)_.*/\1/p')"
  echo "docs"
  echo "scripts"
  echo "extensions"
  if [[ -z "$num" || "$num" == "00" ]]; then
    printf '%s\n' "${WEB_DIRS[@]}"
    return
  fi
  for dir in "${WEB_DIRS[@]}"; do
    dirnum="$(basename "$dir" | sed -nE 's/^([0-9]+[a-z]?)_.*/\1/p')"
    [[ -n "$dirnum" ]] || continue
    # Either is a prefix of the other: script05 docs cover 051/052/059,
    # script051 docs cover 051_fidelius and 051_xp_wallet.
    if [[ "$dirnum" == "$num"* || "$num" == "$dirnum"* ]]; then
      echo "$dir"
    fi
  done
}

# ---------------------------------------------------------------------------
# 4. Walk the docs.
# ---------------------------------------------------------------------------
MISS_LINES=()     # doc<TAB>line<TAB>path
LOOSE_LINES=()    # doc<TAB>line<TAB>path<TAB>resolved-to
PLANNED_LINES=()  # doc<TAB>line<TAB>path<TAB>allowlist-pattern
n_cand=0; n_exact=0; n_scoped=0; n_loose=0; n_planned=0; n_miss=0

for doc in "${DOCS[@]}"; do
  [[ -f "$doc" ]] || { echo "no such doc: $doc" >&2; exit 2; }

  bases=()
  while IFS= read -r b; do bases+=("$b"); done < <(doc_bases "$doc")

  declare -A seen=()
  while IFS= read -r hit; do
    lineno="${hit%%:*}"
    cand="${hit#*:}"
    [[ -n "$cand" ]] || continue
    # "script##_design.md" in prose leaves the fragment "_design.md" behind once
    # the ## is dropped. A real path never starts with an underscore.
    [[ "$cand" != _* ]] || continue
    # .json here is overwhelmingly VPS runtime state (grin_pubpool.json,
    # peers.json, listen-state.json) or an express.json() / res.json() call —
    # none of them repo files. Only judge a .json path written repo-root-
    # relative, where the intent is unambiguous. Known narrowing: a deleted
    # .json referred to by a bare name is not caught.
    if [[ "$cand" == *.json ]] && ! [[ "$cand" =~ ^($ROOT_DIRS)/ ]]; then continue; fi
    [[ -z "${seen[$cand]:-}" ]] || continue
    seen["$cand"]=1
    n_cand=$((n_cand + 1))

    # (1) repo-root-relative, resolves directly. The high-signal case.
    if [[ -n "${EXIST[$cand]:-}" ]]; then n_exact=$((n_exact + 1)); continue; fi
    # globs: scripts/lib/092_lib_*.sh, web/052_accio/patches/*.js
    if [[ "$cand" == *"*"* ]] && compgen -G "$cand" > /dev/null 2>&1; then
      n_exact=$((n_exact + 1)); continue
    fi

    # (2)+(3) bare relative path — resolve against the product trees this doc
    # is about, not the repo root.
    resolved=""; scoped=0
    if [[ "$cand" == *"*"* ]]; then
      # glob: scan the file list, preferring a match inside a base dir
      while IFS= read -r full; do
        [[ "$full" == $cand || "$full" == */$cand ]] || continue
        [[ -n "$resolved" ]] || resolved="$full"
        for b in "${bases[@]}"; do
          if [[ "$full" == "$b/"* ]]; then resolved="$full"; scoped=1; break; fi
        done
        [[ $scoped -eq 0 ]] || break
      done <<< "$FILE_LIST"
    elif [[ -n "${SUFFIX[$cand]:-}" ]]; then
      while IFS= read -r full; do
        for b in "${bases[@]}"; do
          if [[ "$full" == "$b/"* ]]; then resolved="$full"; scoped=1; break; fi
        done
        [[ -z "$resolved" ]] || break
      done <<< "${SUFFIX[$cand]}"
      if [[ -z "$resolved" ]]; then
        resolved="$(head -n1 <<< "${SUFFIX[$cand]}")"
      fi
    fi
    if [[ -n "$resolved" ]]; then
      if [[ $scoped -eq 1 ]]; then
        n_scoped=$((n_scoped + 1))
      else
        n_loose=$((n_loose + 1))
        LOOSE_LINES+=("$doc"$'\t'"$lineno"$'\t'"$cand"$'\t'"$resolved")
      fi
      continue
    fi

    # (4) deliberately-unbuilt, prose-only, or external — allowlisted with a reason.
    if allow_match "$cand"; then
      AL_USED["$AL_HIT"]=1
      n_planned=$((n_planned + 1))
      PLANNED_LINES+=("$doc"$'\t'"$lineno"$'\t'"$cand"$'\t'"$AL_HIT")
      continue
    fi

    n_miss=$((n_miss + 1))
    MISS_LINES+=("$doc"$'\t'"$lineno"$'\t'"$cand")
  done < <(
    sed -E \
      -e 's#https?://[^[:space:])`"<>]*# #g' \
      -e 's#node_modules/[A-Za-z0-9_./*@-]*# #g' \
      -e 's#\*\*([^/])#\1#g' \
      -e 's#[$]\{[A-Za-z_][A-Za-z0-9_]*\}?# #g' \
      -e 's#[$][A-Za-z_][A-Za-z0-9_]*# #g' \
      -e "s#(^|[^A-Za-z0-9_.~-])/[A-Za-z0-9_./*~-]+#\1 #g" \
      "$doc" | grep -noE "$CAND_RE"
  )
  unset seen
done

# ---------------------------------------------------------------------------
# 5. Report.
# ---------------------------------------------------------------------------
printf '\n'
printf 'Documentation drift check — %s docs, %s distinct path mentions\n' "${#DOCS[@]}" "$n_cand"
printf '%s\n' '-------------------------------------------------------------'
printf '  %5s  resolved at repo root (or by glob)\n'            "$n_exact"
printf '  %5s  resolved inside the doc product tree\n'          "$n_scoped"
if [[ $VERBOSE -eq 1 ]]; then
  printf '  %5s  resolved elsewhere in the repo (loose)\n'      "$n_loose"
else
  printf '  %5s  resolved elsewhere in the repo (loose — --verbose to list)\n' "$n_loose"
fi
printf '  %5s  allowlisted (planned / not-a-path / external / deleted)\n' "$n_planned"
printf '  %5s  GENUINE MISSES\n'                                "$n_miss"
printf '\n'

if [[ $n_miss -gt 0 ]]; then
  printf '=== GENUINE MISSES — named in a doc, absent from the repo ===\n\n'
  last=""
  for row in "${MISS_LINES[@]}"; do
    IFS=$'\t' read -r d l p <<< "$row"
    if [[ "$d" != "$last" ]]; then printf '%s\n' "$d"; last="$d"; fi
    printf '    %6s  %s\n' "L$l" "$p"
  done
  printf '\n'
fi

if [[ $n_planned -gt 0 ]]; then
  printf '=== ALLOWLISTED — expected to be absent ===\n\n'
  # Group every mention under its own path first. Printing as we walk the rows
  # files each location under whichever path was last seen, which silently
  # credits one entry with another's mentions.
  declare -A AL_PAT=() AL_LOCS=()
  AL_PATHS=()
  for row in "${PLANNED_LINES[@]}"; do
    IFS=$'\t' read -r d l p pat <<< "$row"
    if [[ -z "${AL_PAT[$p]:-}" ]]; then AL_PAT["$p"]="$pat"; AL_PATHS+=("$p"); fi
    AL_LOCS["$p"]="${AL_LOCS[$p]:-}${AL_LOCS[$p]:+ }$d:$l"
  done
  for p in "${AL_PATHS[@]}"; do
    pat="${AL_PAT[$p]}"
    printf '    [%s] %s\n' "${AL_CAT[$pat]}" "$p"
    printf '          %s\n' "${AL_REASON[$pat]}"
    for loc in ${AL_LOCS[$p]}; do printf '          - %s\n' "$loc"; done
  done
  printf '\n'
fi

if [[ $VERBOSE -eq 1 && $n_loose -gt 0 ]]; then
  printf '=== LOOSE — resolved, but outside the product tree the doc is about ===\n\n'
  for row in "${LOOSE_LINES[@]}"; do
    IFS=$'\t' read -r d l p r <<< "$row"
    printf '    %s:%s  %s  ->  %s\n' "$d" "$l" "$p" "$r"
  done
  printf '\n'
fi

# Allowlist hygiene: an entry nothing references, or one whose file now exists,
# is itself drift. Only meaningful over the whole doc set — on a single-doc run
# every entry the other docs use would look unreferenced.
stale=0
for pat in "${AL_ORDER[@]:-}"; do
  [[ -n "$pat" ]] || continue
  if [[ $FULL_RUN -eq 1 && -z "${AL_USED[$pat]:-}" ]]; then
    printf 'allowlist warning: no doc references %s — remove the entry\n' "$pat"
    stale=1
  fi
  if [[ -n "${EXIST[$pat]:-}" ]]; then
    printf 'allowlist warning: %s now EXISTS — it is built, remove the entry\n' "$pat"
    stale=1
  fi
done
[[ $stale -eq 0 ]] || printf '\n'

if [[ $n_miss -gt 0 ]]; then
  printf 'FAIL — %s path(s) named in docs/generated/ do not exist.\n' "$n_miss"
  exit 1
fi
printf 'OK — every path named in docs/generated/ resolves or is explained.\n'
exit 0
