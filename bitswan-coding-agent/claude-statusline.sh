#!/bin/bash
# Status line for Claude Code sessions inside the coding-agent container.
#
# Claude Code pipes a JSON payload on stdin on every render and displays
# this script's stdout (ANSI colors supported) under the input box. Wired
# into each user's Claude settings by agent-session-wrapper; installed at
# /usr/local/bin/claude-statusline by the Dockerfile.
export LC_ALL=C
input=$(cat)

cwd=$(echo "$input" | jq -r '.cwd // empty')
# Bailey users think in copy/BP terms, so render the location relative to
# /workspace/copies (e.g. "default/my-bp/src" instead of the full path).
cwd_display="${cwd#/workspace/copies/}"
[ "$cwd_display" = "/workspace/copies" ] && cwd_display="copies"

line1=""
line2=""

# --- copy/BP location (bold blue) ---
line1+=$(printf "\033[01;34m%s\033[00m" "$cwd_display")

# --- git branch (cyan); detached HEAD falls back to the short hash ---
git_branch=""
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
    git_branch=$(git --no-optional-locks -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
    if [ -z "$git_branch" ]; then
        git_branch=$(git --no-optional-locks -C "$cwd" rev-parse --short HEAD 2>/dev/null)
    fi
fi
if [ -n "$git_branch" ]; then
    line1+=$(printf " \033[00m|\033[00m \033[00;36m(%s)\033[00m" "$git_branch")
fi

# --- model display name (bold yellow) ---
model=$(echo "$input" | jq -r '.model.display_name // empty')
if [ -n "$model" ]; then
    line1+=$(printf " \033[00m|\033[00m \033[01;33m%s\033[00m" "$model")
fi

# --- session cost (magenta) ---
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
if [ -n "$cost" ]; then
    line2+=$(printf "\033[00;35m\$%.2f\033[00m" "$cost")
fi

# --- context window usage: e.g. "ctx:144k/1M 14%" (bold magenta) ---
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
ctx_used=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$ctx_size" ] && [ "$ctx_size" -gt 0 ] 2>/dev/null; then
    ctx_label=$(awk -v used="${ctx_used:-0}" -v size="$ctx_size" -v pct="${ctx_pct:-}" '
        function fmt(n) {
            if (n >= 1000000) return sprintf("%.1fM", n/1000000)
            else if (n >= 10000) return sprintf("%dk", int(n/1000 + 0.5))
            else return sprintf("%.1fk", n/1000)
        }
        BEGIN {
            label = "ctx:" fmt(used) "/" fmt(size)
            if (pct != "") label = label " " sprintf("%.0f%%", pct)
            sub(/\.0M/, "M", label)
            print label
        }')
    sep2=""; [ -n "$line2" ] && sep2=$' \033[00m|\033[00m '
    line2+=$(printf "%s\033[01;35m%s\033[00m" "$sep2" "$ctx_label")
fi

# Helper: convert a Unix epoch into a human countdown. Returns "Xd YYh" when
# >=24h remain, otherwise "Xh YYm". Returns "" if already past.
time_until() {
    local resets_at="$1"
    local now diff
    now=$(date +%s)
    diff=$(( resets_at - now ))
    if [ "$diff" -le 0 ]; then
        echo ""
    elif [ "$diff" -ge 86400 ]; then
        printf "%dd%02dh" "$(( diff / 86400 ))" "$(( (diff % 86400) / 3600 ))"
    else
        printf "%dh%02dm" "$(( diff / 3600 ))" "$(( (diff % 3600) / 60 ))"
    fi
}

# Helper: append a rate-limit section ("5h:42% 3h47m") to line2. Yellow
# normally, bold red once usage crosses 80% so the user sees it coming
# before Claude locks them out mid-session.
rate_limit_section() {
    local name="$1" pct="$2" resets_at="$3"
    local color label countdown
    [ -n "$pct" ] || return 0
    if [ "$(echo "$pct" | awk '{print ($1 >= 80) ? 1 : 0}')" = "1" ]; then
        color="01;31"
    else
        color="00;33"
    fi
    label=$(printf "%s:%.0f%%" "$name" "$pct")
    if [ -n "$resets_at" ]; then
        countdown=$(time_until "$resets_at")
        [ -n "$countdown" ] && label+=" ${countdown}"
    fi
    sep2=""; [ -n "$line2" ] && sep2=$' \033[00m|\033[00m '
    line2+=$(printf "%s\033[%sm%s\033[00m" "$sep2" "$color" "$label")
}

rate_limit_section "5h" \
    "$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')" \
    "$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')"
rate_limit_section "7d" \
    "$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')" \
    "$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')"

if [ -n "$line2" ]; then
    printf '%s\n%s' "$line1" "$line2"
else
    printf '%s' "$line1"
fi
