#!/bin/bash
set -e

# =============================================================================
# Emby Segment Loop – Debian installation script
# =============================================================================
# Usage:  sudo bash install-debian.sh
#
# Downloads the plugin DLL and injects the segment-loop JavaScript inline into
# Emby's index.html – no external file dependencies, no API routes needed.
# =============================================================================

RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
PLUGIN_DLL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"
SEGLOOP_JS="${RAW_BASE}/segmentloop.js"

SYSTEM_DIR="/opt/emby-server/system"
DASHBOARD_DIR="${SYSTEM_DIR}/dashboard-ui"
PLUGINS_DIR="/var/lib/emby/plugins"
INDEX_HTML="${DASHBOARD_DIR}/index.html"

echo "==> Stopping Emby Server..."
systemctl stop emby-server || true

echo "==> Downloading plugin DLL..."
wget -q -O "${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll" "${PLUGIN_DLL}"
echo "    Done."

echo "==> Downloading segmentloop.js source..."
JS_CONTENT=$(wget -q -O - "${SEGLOOP_JS}")
if [ -z "${JS_CONTENT}" ]; then
    echo "    FAILED to download segmentloop.js"
    exit 1
fi
echo "    Done (${#JS_CONTENT} bytes)."

# Clean up any stale files from previous installations
rm -rf "${DASHBOARD_DIR}/modules/segmentloop" 2>/dev/null || true

# Inject inline script into index.html
if [ -f "${INDEX_HTML}" ]; then
    # Remove any previous references
    sed -i '/SegmentLoop\/ClientScript/d' "${INDEX_HTML}" 2>/dev/null || true
    sed -i '/modules\/segmentloop/d'        "${INDEX_HTML}" 2>/dev/null || true
    sed -i '/<!-- SegmentLoop -->/,/\/script>/d' "${INDEX_HTML}" 2>/dev/null || true

    MARKER="<!-- SegmentLoop -->"
    if ! grep -q "${MARKER}" "${INDEX_HTML}"; then
        INJECT="${MARKER}
<script>
window.EmbySegmentLoopConfig={startKey:'[',endKey:']'};
${JS_CONTENT}
</script>"
        sed -i "s|</body>|${INJECT}\n</body>|" "${INDEX_HTML}"
        echo "==> Script injected inline into index.html"
    else
        echo "==> Script already injected"
    fi

    chmod 644 "${INDEX_HTML}" 2>/dev/null || true
else
    echo "!! index.html not found at ${INDEX_HTML}"
    exit 1
fi

echo "==> Starting Emby Server..."
systemctl start emby-server

sleep 3
echo ""
echo "============================================"
echo "  Segment Loop installed successfully."
echo "  Open Emby Web, Ctrl+F5 refresh."
echo "============================================"
