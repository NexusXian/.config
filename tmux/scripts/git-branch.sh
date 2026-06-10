#!/bin/zsh
path="$1"
[[ -z "$path" ]] && exit 0
branch=$(git -C "$path" symbolic-ref --short HEAD 2>/dev/null)
[[ -z "$branch" ]] && branch=$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null)
[[ -z "$branch" || "$branch" = "HEAD" ]] && exit 0
printf ' %s  ' "$branch"
