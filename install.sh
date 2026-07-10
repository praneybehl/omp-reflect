#!/bin/sh
# omp-reflect installer.
#
#   curl -fsSL https://raw.githubusercontent.com/praneybehl/omp-reflect/main/install.sh | sh
#
# Prefers the native plugin manager (`omp plugin install`), which installs into
# ~/.omp/plugins and auto-loads in every session. Falls back to a local clone
# loaded via --extension when `omp` is not on PATH yet.
set -eu

SPEC="github:praneybehl/omp-reflect"
REPO_URL="https://github.com/praneybehl/omp-reflect"

if command -v omp >/dev/null 2>&1; then
	echo "Installing omp-reflect via the omp plugin manager..."
	omp plugin install "$SPEC"
	echo ""
	echo "Done. omp-reflect now auto-loads in every omp session:"
	echo "  /reflect run   audit recent tasks with your active model"
	echo "  /reflect show  browse accepted findings"
	echo "  /activity      open the local Activity dashboard"
	echo ""
	echo "Upgrade later:   omp plugin upgrade omp-reflect"
	echo "Uninstall:       omp plugin uninstall omp-reflect"
	exit 0
fi

echo "omp not found on PATH; falling back to a local clone." >&2

if ! command -v bun >/dev/null 2>&1; then
	echo "error: neither 'omp' nor 'bun' is on PATH." >&2
	echo "Install oh-my-pi first: https://github.com/can1357/oh-my-pi" >&2
	exit 1
fi
if ! command -v git >/dev/null 2>&1; then
	echo "error: git is required for the clone fallback." >&2
	exit 1
fi

DEST="${OMP_REFLECT_DIR:-$HOME/.omp-reflect}"
if [ -d "$DEST/.git" ]; then
	echo "Updating existing clone at $DEST..."
	git -C "$DEST" pull --ff-only
else
	git clone "$REPO_URL" "$DEST"
fi
(cd "$DEST" && bun install --frozen-lockfile)

echo ""
echo "Installed to $DEST. Load it per session with:"
echo "  omp --extension \"$DEST\""
echo "or install it properly once omp is available:"
echo "  omp plugin install $SPEC"
