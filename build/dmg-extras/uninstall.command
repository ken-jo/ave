#!/bin/bash
# Ave macOS uninstall helper.
# Removes /Applications/Ave.app and, only when the user explicitly chooses it,
# local Ave data such as ~/.ave and Electron userData/cache files.

set -u
trap 'echo; echo "Aborted."; exit 130' INT

APP="/Applications/Ave.app"
APP_NAME="Ave"
APP_SUPPORT="$HOME/Library/Application Support/Ave"
AVE_HOME="$HOME/.ave"

DATA_PATHS=(
  "$APP_SUPPORT"
  "$AVE_HOME"
  "$HOME/Library/Caches/Ave"
  "$HOME/Library/Caches/ai.agent-connector.ave"
  "$HOME/Library/Logs/Ave"
  "$HOME/Library/Preferences/ai.agent-connector.ave.plist"
  "$HOME/Library/Saved Application State/ai.agent-connector.ave.savedState"
  "$HOME/Library/WebKit/Ave"
)

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer || true
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

remove_path() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return 0
  fi
  if rm -rf "$path" 2>/dev/null; then
    echo "Removed: $path"
    return 0
  fi
  echo "Permission required: $path"
  sudo rm -rf "$path"
  echo "Removed: $path"
}

clear
echo "================================================"
echo "  Ave macOS Uninstaller"
echo "================================================"
echo ""

if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "Requesting Ave to quit..."
  osascript -e 'tell application "Ave" to quit' >/dev/null 2>&1 || true
  sleep 2
fi

if [ -d "$APP" ]; then
  if confirm "Remove Ave.app from /Applications?"; then
    remove_path "$APP"
    if command -v /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister >/dev/null 2>&1; then
      /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$APP" >/dev/null 2>&1 || true
    fi
  else
    echo "Skipped app removal."
  fi
else
  echo "Ave.app was not found at $APP."
fi

echo ""
echo "Local data is preserved by default."
echo "This includes memories, plugins, secrets, settings, caches, and logs."
if confirm "Also remove local Ave data?"; then
  for path in "${DATA_PATHS[@]}"; do
    remove_path "$path"
  done
else
  echo "Skipped local data removal."
fi

echo ""
echo "Ave uninstall helper finished."
read -r -p "Press Enter to close..." _ || true
exit 0
