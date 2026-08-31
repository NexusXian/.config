#!/usr/bin/env bash
set -euo pipefail

# 灰黑强调色，可用 TMUX_THEME_COLOR 覆盖
theme="${TMUX_THEME_COLOR:-#c8c8c8}"

tmux set -g @theme_color "$theme"
tmux set -g pane-active-border-style "fg=$theme"

exit 0
