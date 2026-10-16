#!/usr/bin/env bash
# check_prompt_back.sh — every interactive prompt must let the operator answer 0 to go back (or to say no).
#
# Usage: bash docs/tools/check_prompt_back.sh [FILE ...]
#        (default: Script 01 — scripts/01_build_new_grin_node.sh and scripts/lib/01_lib_*.sh)
# Exit 0 clean, 1 findings.
#
# For each `read` it finds the prompt text (the nearest `echo -ne` / `read -rp` above it) and classifies it:
#   PAUSE  "Press Enter" / "Enter = back"        nothing to check
#   TOKEN  "Type X to ..."                         anything but X cancels, 0 included
#   YN-NO  "[y/N]"                                 anything but y is no, 0 included
#   YN-YES "[Y/n]"                                 Enter is yes, so 0 must be named in the next lines
#   CHOICE everything else (menus, free text)      0 must be named in the next lines
# "Named" means a `"0"`, `0)` or `0|` in code within the 15 lines after the read, inside the same function.
# A prompt that legitimately does something else carries `# prompt-back: <reason>` on the read line or the line
# above it. Limit: it proves 0 is HANDLED, not what it means — a zone list where 0 meant "Auto" passed.
#
# Why it exists: Script 01 grew from a linear wizard into a menu, and prompts written for the wizard kept
# treating 0 as an ordinary answer — a git ref named "0", a zone called Auto, a yes on [Y/n]. Each was found
# one at a time on a VPS.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

files=("$@")
if (( ${#files[@]} == 0 )); then
    files=(scripts/01_build_new_grin_node.sh scripts/lib/01_lib_*.sh)
fi

bad=0
for f in "${files[@]}"; do
    mapfile -t lines < "$f"
    prompt=""
    for i in "${!lines[@]}"; do
        l="${lines[$i]}"
        if [[ "$l" =~ echo\ -ne|read\ -rp ]]; then prompt="$l"; fi
        [[ "$l" =~ (^|[^a-z_])read\ -r[\ p] ]] || continue
        [[ "$l" =~ \<\<\<|while\ IFS|-t\ [0-9] ]] && continue
        prev="${lines[$((i > 0 ? i - 1 : 0))]}"
        [[ "$l$prev" == *"# prompt-back:"* ]] && continue
        case "$prompt" in
            *"Press Enter"*|*"Enter = back"*) continue ;;
            *"Type "*" to "*)                 continue ;;
            *"[y/N]"*)                        continue ;;
        esac
        # _gsb_confirm prints "[Y/n]" or "[y/N]" itself and maps every non-y answer to no.
        [[ "$prompt" == *'${prompt} ['* ]] && continue
        # The window ends at the function's closing brace and skips comments, so a "0)" in the next
        # function's header can not pass this prompt.
        window=""
        for (( j = i; j < i + 16 && j < ${#lines[@]}; j++ )); do
            [[ "${lines[$j]}" == "}" ]] && break
            [[ "${lines[$j]}" =~ ^[[:space:]]*# ]] && continue
            window+="${lines[$j]}"$'\n'
        done
        if [[ "$window" == *'"0"'* || "$window" =~ (^|[^0-9A-Za-z_])0[\)\|] ]]; then continue; fi
        kind=CHOICE; [[ "$prompt" == *"[Y/n]"* ]] && kind=YN-YES
        printf '%s:%d  %-6s  0 is not handled\n    prompt: %s\n' "$f" "$((i + 1))" "$kind" \
            "$(sed -E 's/^[[:space:]]+//; s/\$\{[A-Z_]+\}//g' <<<"$prompt" | cut -c1-110)"
        bad=1
    done
done

if (( bad == 0 )); then echo "check_prompt_back: every prompt handles 0 (${#files[@]} files)."; fi
exit "$bad"
