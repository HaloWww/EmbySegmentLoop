#!/bin/bash
set -e

# =============================================================================
# Emby Segment Loop v1.1.2.1 – Debian installation script
# =============================================================================
# Usage:  sudo bash install-debian.sh

RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
PLUGIN_DLL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"
SEGLOOP_JS="${RAW_BASE}/segmentloop.js?t=$(date +%s)"

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
        python3 -c "
html = open('${INDEX_HTML}').read()
js   = open('${TMP_JS}').read()
inj  = '${MARKER}\n<script>\nwindow.EmbySegmentLoopConfig={startKey:\"[\",endKey:\"]\",captureKey:\"P\"};\n' + js + '\n</script>\n'
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

# Inject static segment container into Emby's item (detail page) template.
# This ensures the container exists in every detail page view (fresh or cached).
ITEM_HTML="${DASHBOARD_DIR}/item/item.html"
if [ -f "${ITEM_HTML}" ]; then
    # Always re-inject – clean up previous versions first
    python3 -c "
import re
html = open('${ITEM_HTML}').read()
html = re.sub(r'<div\s+class=\"embySegmentDetailList[^>]*>.*?</div>\s*', '', html, flags=re.DOTALL)
idx = html.find('mainDetailButtons')
if idx > 0:
    closeDiv = html.find('</div>', idx)
    if closeDiv > 0:
        insert = '\n<div class=\"embySegmentDetailList verticalFieldItem detail-lineItem hide\"><div class=\"embySegmentTitle\">循环片段</div></div>'
        html = html[:closeDiv+6] + insert + html[closeDiv+6:]
        open('${ITEM_HTML}','w').write(html)
        print('==> Segment container injected into item.html')
"

rm -f "${TMP_JS}"
echo "==> Starting Emby Server..."
systemctl start emby-server

sleep 3
DLL_VER=$(wget -q -O - "${RAW_BASE}/release/VERSION" 2>/dev/null || echo "unknown")
GIT_TIME=$(wget -q -O - "https://api.github.com/repos/HaloWww/EmbySegmentLoop/commits/main" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['commit']['committer']['date'][:19].replace('T',' '))" 2>/dev/null || echo "unknown")
echo ""
echo "============================================"
echo "  Segment Loop installed successfully."
echo "  Version: ${DLL_VER}   Released: ${GIT_TIME}"
echo "  Ctrl+F5 refresh Emby Web to activate."
echo "============================================"
