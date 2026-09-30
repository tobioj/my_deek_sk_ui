#!/bin/zsh
# One-time setup for macOS. Run from the app folder:
#   zsh scripts/mac/install.sh
# It adds the `deepseek-chat` command and a "DeepSeek Chat" app (Spotlight, Launchpad, Dock).
# Nothing else on your Mac is changed. Run it again any time; it's safe.
set -e
HERE="${0:A:h}"
BIN="$HOME/.local/bin"
APP="$HOME/Applications/DeepSeek Chat.app"

# 1. The `deepseek-chat` command: a link to the script in this folder, so `git pull` keeps it up to date.
mkdir -p "$BIN"
chmod +x "$HERE/deepseek-chat"
if [[ -e "$BIN/deepseek-chat" && ! -L "$BIN/deepseek-chat" ]]; then
  mv "$BIN/deepseek-chat" "$BIN/deepseek-chat.backup"
  echo "Kept your previous deepseek-chat as $BIN/deepseek-chat.backup"
fi
ln -sfn "$HERE/deepseek-chat" "$BIN/deepseek-chat"
echo "Added the command: $BIN/deepseek-chat"

# 2. Make sure new terminals can find it.
if [[ ":$PATH:" != *":$BIN:"* ]] && ! grep -qs '\.local/bin' "$HOME/.zshrc" "$HOME/.zprofile"; then
  printf '\n# deepseek-chat\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.zshrc"
  echo "Added ~/.local/bin to your PATH (in ~/.zshrc). Open a new terminal to use: deepseek-chat"
fi

# 3. The app, so you can open it from Spotlight, Launchpad or the Dock. It just runs deepseek-chat.
mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" 2> >(grep -v "replacing existing signature" >&2) -e '
try
	do shell script "$HOME/.local/bin/deepseek-chat"
on error errMsg
	display dialog "DeepSeek Chat couldn’t start:" & return & return & errMsg buttons {"OK"} default button 1 with icon caution
end try'
cp "$HERE/deepseek.icns" "$APP/Contents/Resources/applet.icns"
plutil -replace CFBundleIdentifier -string com.local.deepseek-chat "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
mdimport "$APP" >/dev/null 2>&1 || true
echo "Added the app: $APP"

echo ""
echo "Done. Open DeepSeek Chat from Spotlight (⌘ Space), or run: deepseek-chat"
