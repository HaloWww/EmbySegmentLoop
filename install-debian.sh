#!/bin/bash
set -e

# =============================================================================
# Emby Segment Loop – Debian installation script
# =============================================================================
# Usage:  sudo bash install-debian.sh
#
# This script downloads the plugin DLL, removes stale files from previous
# installations, injects the loader tag into Emby's index.html, and restarts
# the Emby Server service.
# =============================================================================

PLUGIN_ID="8c1e7ca2-3f07-4b62-a4d1-929f07509367"
RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
DLL_URL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"

SYSTEM_DIR="/opt/emby-server/system"
DASHBOARD_DIR="${SYSTEM_DIR}/dashboard-ui"
PLUGINS_DIR="/var/lib/emby/plugins"
INDEX_HTML="${DASHBOARD_DIR}/index.html"
OLD_JS_DIR="${DASHBOARD_DIR}/modules/segmentloop"
SCRIPT_TAG='    <script src="emby/SegmentLoop/ClientScript" defer></script>'

echo "==> Stopping Emby Server..."
systemctl stop emby-server || true

echo "==> Downloading latest plugin DLL..."
mkdir -p "${PLUGINS_DIR}"
wget -q -O "${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll" "${DLL_URL}"
echo "    DLL saved to ${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll"

# ---------------------------------------------------------------------------
# Clean up any stale files from previous installation methods
# ---------------------------------------------------------------------------
if [ -d "${OLD_JS_DIR}" ]; then
    echo "==> Removing old static JS files..."
    rm -rf "${OLD_JS_DIR}"
fi

# ---------------------------------------------------------------------------
# Inject the script-loader tag into Emby's index.html.
# This is the ONLY file-system modification required.  The actual JavaScript
# is served from the plugin DLL via an in-memory API endpoint.
# ---------------------------------------------------------------------------
if [ -f "${INDEX_HTML}" ]; then

    # Remove any previous loader lines we may have written
    sed -i '/SegmentLoop\/ClientScript/d' "${INDEX_HTML}" 2>/dev/null || true
    sed -i '/modules\/segmentloop/d'        "${INDEX_HTML}" 2>/dev/null || true

    # Insert our tag right before </body>
    if ! grep -q 'SegmentLoop/ClientScript' "${INDEX_HTML}"; then
        sed -i "s|</body>|${SCRIPT_TAG}\n</body>|" "${INDEX_HTML}"
        echo "==> Loader tag injected into index.html"
    else
        echo "==> Loader tag already present in index.html"
    fi

    chmod 644 "${INDEX_HTML}" 2>/dev/null || true
else
    echo "!! WARNING: index.html not found at ${INDEX_HTML}"
fi

echo "==> Starting Emby Server..."
systemctl start emby-server

sleep 3
echo ""
echo "============================================"
echo "  Segment Loop installed successfully."
echo "  Open Emby Web, Ctrl+F5 refresh, then go"
echo "  to Settings to find 'Segment Loop'."
echo "============================================"
