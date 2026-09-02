# Memoria connection guard for terminal LLM launches.
# Sourced from ~/.zshrc. It does no work for ordinary commands.

autoload -Uz add-zsh-hook

_memoria_llm_launch_guard() {
  [[ -n "$MEMORIA_CONNECTION_GUARD_DISABLE" ]] && return 0
  [[ -o interactive && -t 0 && -t 1 ]] || return 0
  local command_line="$1"
  local -a words
  words=(${(z)command_line})
  (( ${#words} )) || return 0

  local index=1 token command_name
  while (( index <= ${#words} )); do
    token="${words[$index]}"
    case "$token" in
      env|command|builtin|noglob) (( index++ )); continue ;;
      -*) (( index++ )); continue ;;
    esac
    if [[ "${token%%=*}" != "$token" && -n "${token%%=*}" ]]; then
      (( index++ ))
      continue
    fi
    command_name="${token:t}"
    break
  done
  [[ -n "$command_name" ]] || return 0

  if (( $+aliases[$command_name] )); then
    local -a alias_words
    alias_words=(${(z)aliases[$command_name]})
    [[ ${#alias_words} -gt 0 ]] && command_name="${alias_words[1]:t}"
  fi
  case "$command_name" in
    codex|claude|kimi|herdr)
      /opt/homebrew/bin/node /Users/kota2m/memoria-kota2/llm-connection.mjs prompt "$command_name" >/dev/null 2>&1
      ;;
  esac
}

add-zsh-hook -d preexec _memoria_llm_launch_guard 2>/dev/null || true
add-zsh-hook preexec _memoria_llm_launch_guard
