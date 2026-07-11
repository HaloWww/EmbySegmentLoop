#!/bin/bash
set -e

# =============================================================================
# Emby Segment Loop v1.1.2.1 – Debian installation script
# =============================================================================
# Usage:  sudo bash install-debian.sh

RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
PLUGIN_DLL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"
SEGLOOP_JS="${RAW_BASE}/segmentloop.js"

SYSTEM_DIR="/opt/emby-server/system"
DASHBOARD_DIR="${SYSTEM_DIR}/dashboard-ui"
PLUGINS_DIR="/var/lib/emby/plugins"
INDEX_HTML="${DASHBOARD_DIR}/index.html"
MARKER="<!-- SegmentLoop -->"

echo "==> Stopping Emby Server..."
systemctl stop emby-server || true

echo "==> Downloading plugin DLL..."
wget -q -O "${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll" "${PLUGIN_DLL}"

echo "==> Downloading segmentloop.js..."
TMP_JS=$(mktemp)
wget -q -O "${TMP_JS}" "${SEGLOOP_JS}"
echo "    Done."

# Clean stale files
rm -rf "${DASHBOARD_DIR}/modules/segmentloop" 2>/dev/null || true

if [ -f "${INDEX_HTML}" ]; then
    # Remove all previous traces
    sed -i '/SegmentLoop\/ClientScript/d' "${INDEX_HTML}" 2>/dev/null || true
    sed -i '/modules\/segmentloop/d'        "${INDEX_HTML}" 2>/dev/null || true
    sed -i '/<!-- SegmentLoop -->/,/\/script>/d' "${INDEX_HTML}" 2>/dev/null || true

    if ! grep -q "${MARKER}" "${INDEX_HTML}"; then
        # We use a Python helper because the JS content contains
        # characters that break sed/awk.
        python3 -c "
html = open('${INDEX_HTML}').read()
js   = open('${TMP_JS}').read()
inj  = '${MARKER}\n<script>\nwindow.EmbySegmentLoopConfig={startKey:\"[\",endKey:\"]\"};\n' + js + '\n</script>\n'
open('${INDEX_HTML}','w').write(html.replace('</body>', inj + '</body>'))
"
        echo "==> Script injected inline into index.html"
    else
        echo "==> Script already injected"
    fi
    chmod 644 "${INDEX_HTML}" 2>/dev/null || true
else
    echo "!! index.html not found"
    exit 1
fi

rm -f "${TMP_JS}"
echo "==> Starting Emby Server..."
systemctl start emby-server

sleep 3
echo ""
echo "============================================"
echo "  Segment Loop installed successfully."
echo "  Ctrl+F5 refresh Emby Web to activate."
echo "============================================"
