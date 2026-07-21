#!/bin/bash
set -e
# =============================================================================
# Emby Segment Loop – Debian installation script (interactive)
# =============================================================================
# Usage:  sudo bash install-debian.sh
# =============================================================================

RAW_BASE="https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main"
PLUGIN_DLL="${RAW_BASE}/release/Emby.Plugins.SegmentLoop.dll"
LINUX_FILES="${RAW_BASE}/linux-files"
INJECTED_DASHBOARD="${RAW_BASE}/linux-dashboard/4.9.5.0/injected/dashboard-ui"
MANIFEST_URL="${RAW_BASE}/linux-dashboard/4.9.5.0/manifest.json"
EMBY_DEB_URL="https://github.com/MediaBrowser/Emby.Releases/releases/download/4.9.5.0/emby-server-deb_4.9.5.0_amd64.deb"

SYSTEM_DIR="/opt/emby-server/system"
DASHBOARD_DIR="${SYSTEM_DIR}/dashboard-ui"
PLUGINS_DIR="/var/lib/emby/plugins"
INDEX_HTML="${DASHBOARD_DIR}/index.html"
ITEM_JS="${DASHBOARD_DIR}/item/item.js"

ask() {
    local prompt="$1"
    local default="${2:-N}"
    while true; do
        read -p "$prompt [y/N] " yn < /dev/tty
        case "$yn" in
            [Yy]* ) return 0 ;;
            [Nn]* | "" ) return 1 ;;
            * ) echo "Please answer y or n." ;;
        esac
    done
}

# ---- Step 1: Install/upgrade Emby ----
if ask "Install/upgrade Emby Server 4.9.5.0 DEB package?"; then
    echo "==> Downloading Emby DEB..."
    TMP_DEB=$(mktemp /tmp/emby-XXXXXX.deb)
    wget -q --show-progress -O "${TMP_DEB}" "${EMBY_DEB_URL}"
    echo "==> Installing Emby..."
    dpkg -i "${TMP_DEB}" || apt-get install -f -y
    rm -f "${TMP_DEB}"
fi

# ---- Step 2: Apply linux patches ----
if ask "Apply linux system patches?"; then
    if [ -d "${SYSTEM_DIR}" ]; then
        echo "==> Downloading and applying patches..."
        TMP_LINUX=$(mktemp -d)

        wget -q -O "${TMP_LINUX}/Emby.Server.Implementations.dll" "${LINUX_FILES}/Emby.Server.Implementations.dll"
        cp "${TMP_LINUX}/Emby.Server.Implementations.dll" "${SYSTEM_DIR}/Emby.Server.Implementations.dll"
        echo "    Updated Emby.Server.Implementations.dll"

        wget -q -O "${TMP_LINUX}/Emby.Web.dll" "${LINUX_FILES}/Emby.Web.dll"
        cp "${TMP_LINUX}/Emby.Web.dll" "${SYSTEM_DIR}/Emby.Web.dll"
        echo "    Updated Emby.Web.dll"

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
    else
        echo "!! System directory not found at ${SYSTEM_DIR}"
    fi
fi

# ---- Step 3: Install Segment Loop plugin ----
if ask "Install/update Segment Loop plugin?"; then
    echo "==> Stopping Emby Server..."
    systemctl stop emby-server || true

    echo "==> Downloading generated install files..."
    TMP_SEGLOOP=$(mktemp -d)
    trap 'rm -rf "${TMP_SEGLOOP}"; systemctl start emby-server >/dev/null 2>&1 || true' EXIT
    CACHE_BUST=$(date +%s)
    wget -q -O "${TMP_SEGLOOP}/Emby.Plugins.SegmentLoop.dll" "${PLUGIN_DLL}?v=${CACHE_BUST}"
    wget -q -O "${TMP_SEGLOOP}/index.html" "${INJECTED_DASHBOARD}/index.html?v=${CACHE_BUST}"
    wget -q -O "${TMP_SEGLOOP}/item.js" "${INJECTED_DASHBOARD}/item/item.js?v=${CACHE_BUST}"
    wget -q -O "${TMP_SEGLOOP}/manifest.json" "${MANIFEST_URL}?v=${CACHE_BUST}"

    echo "==> Verifying generated dashboard files..."
    python3 - "${TMP_SEGLOOP}" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
for local_name, key in (
    ("index.html", "injected/dashboard-ui/index.html"),
    ("item.js", "injected/dashboard-ui/item/item.js"),
):
    data = (root / local_name).read_bytes()
    expected = manifest["files"][key]
    actual = hashlib.sha256(data).hexdigest().upper()
    if len(data) != expected["size"] or actual != expected["sha256"]:
        raise SystemExit(f"checksum mismatch: {local_name}")
PY

    echo "==> Directly overwriting plugin and generated dashboard files..."
    install -o emby -g emby -m 0644 "${TMP_SEGLOOP}/Emby.Plugins.SegmentLoop.dll" "${PLUGINS_DIR}/Emby.Plugins.SegmentLoop.dll"
    install -o root -g root -m 0644 "${TMP_SEGLOOP}/index.html" "${INDEX_HTML}"
    install -o root -g root -m 0644 "${TMP_SEGLOOP}/item.js" "${ITEM_JS}"
    rm -rf "${DASHBOARD_DIR}/modules/segmentloop" 2>/dev/null || true
    rm -rf "${TMP_SEGLOOP}"

    echo "==> Starting Emby Server..."
    systemctl start emby-server
    trap - EXIT
fi

sleep 3
DLL_VER=$(wget -q -O - "${RAW_BASE}/release/VERSION" 2>/dev/null || echo "unknown")
GIT_TIME=$(wget -q -O - "https://api.github.com/repos/HaloWww/EmbySegmentLoop/commits/main" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['commit']['committer']['date'][:19].replace('T',' '))" 2>/dev/null || echo "unknown")
echo ""
echo "============================================"
echo "  Segment Loop installed successfully."
echo "  Version: ${DLL_VER}   Released: ${GIT_TIME}"
echo "  Ctrl+F5 refresh Emby Web to activate."
echo "============================================"
