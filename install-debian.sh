#!/bin/bash
set -e
# =============================================================================
# Emby Segment Loop – Debian all-in-one installation script
# =============================================================================
# Usage:  sudo bash install-debian.sh [/path/to/emby-server-deb_4.9.5.0_amd64.deb]
#
# If the DEB path is provided, the script installs/upgrades Emby first,
# then applies the linux patches, then installs the Segment Loop plugin.
# If no DEB path is given, only the plugin is installed.
# =============================================================================

RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
PLUGIN_DLL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"
SEGLOOP_JS="${RAW_BASE}/segmentloop.js"
LINUX_FILES="${RAW_BASE}/linux-files"

SYSTEM_DIR="/opt/emby-server/system"
DASHBOARD_DIR="${SYSTEM_DIR}/dashboard-ui"
PLUGINS_DIR="/var/lib/emby/plugins"
INDEX_HTML="${DASHBOARD_DIR}/index.html"
MARKER="<!-- SegmentLoop -->"

DEB_PATH="${1}"

# ---- Step 1: Install/upgrade Emby if DEB provided ----
if [ -n "${DEB_PATH}" ] && [ -f "${DEB_PATH}" ]; then
    echo "==> Installing/upgrading Emby from ${DEB_PATH}..."
    dpkg -i "${DEB_PATH}" || apt-get install -f -y
fi

# ---- Step 2: Apply linux patches ----
if [ -d "${SYSTEM_DIR}" ]; then
    echo "==> Applying linux system patches..."
    TMP_LINUX=$(mktemp -d)

    for f in Emby.Server.Implementations.dll Emby.Web.dll; do
        wget -q -O "${TMP_LINUX}/${f}" "${LINUX_FILES}/${f}"
        cp "${TMP_LINUX}/${f}" "${SYSTEM_DIR}/${f}"
        echo "    Updated ${f}"
    done

    wget -q -O "${TMP_LINUX}/embypremiere.js" "${LINUX_FILES}/dashboard-ui/embypremiere/embypremiere.js"
    mkdir -p "${DASHBOARD_DIR}/embypremiere"
    cp "${TMP_LINUX}/embypremiere.js" "${DASHBOARD_DIR}/embypremiere/embypremiere.js"
    echo "    Updated embypremiere.js"

    wget -q -O "${TMP_LINUX}/connectionmanager.js" "${LINUX_FILES}/dashboard-ui/modules/emby-apiclient/connectionmanager.js"
    mkdir -p "${DASHBOARD_DIR}/modules/emby-apiclient"
    cp "${TMP_LINUX}/connectionmanager.js" "${DASHBOARD_DIR}/modules/emby-apiclient/connectionmanager.js"
    echo "    Updated connectionmanager.js"

    wget -q -O "${TMP_LINUX}/Emby.CustomCssJS.dll" "${LINUX_FILES}/plugins/Emby.CustomCssJS.dll"
    cp "${TMP_LINUX}/Emby.CustomCssJS.dll" "${PLUGINS_DIR}/Emby.CustomCssJS.dll"
    echo "    Updated CustomCssJS"

    rm -rf "${TMP_LINUX}"
fi

# ---- Step 3: Stop Emby and install plugin ----
echo "==> Stopping Emby Server..."
systemctl stop emby-server || true

echo "==> Downloading plugin DLL..."
wget -q -O "${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll" "${PLUGIN_DLL}"

echo "==> Downloading segmentloop.js..."
TMP_JS=$(mktemp)
wget -q -O "${TMP_JS}" "${SEGLOOP_JS}"

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
