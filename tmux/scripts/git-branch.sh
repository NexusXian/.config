#!/bin/zsh
pane_path="$1"
[[ -z "$pane_path" ]] && exit 0
branch=$(git -C "$pane_path" symbolic-ref --short HEAD 2>/dev/null)
[[ -z "$branch" ]] && branch=$(git -C "$pane_path" rev-parse --abbrev-ref HEAD 2>/dev/null)
[[ -z "$branch" || "$branch" = "HEAD" ]] && exit 0
git_status=""
if command -v starship >/dev/null 2>&1; then
  git_status=$(STARSHIP_LOG=error STARSHIP_CONFIG="${STARSHIP_TMUX_CONFIG:-$HOME/.config/starship-tmux.toml}" \
    starship module git_status --path "$pane_path" 2>/dev/null | perl -pe 's/\e\[[\d;]*[[:alpha:]]//g' | tr -d '\n')
fi
segment_style=$(tmux display-message -p '#[fg=#{@git_bg},bg=#{@directory_bg}]#{@sep_l}#[fg=#{@git_fg},bg=#{@git_bg},bold]')
printf '%s  %s%s #[nobold]' "$segment_style" "${branch//\#/##}" "${git_status//\#/##}"
