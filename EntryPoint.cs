using System.Diagnostics;
using System.Reflection;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class EntryPoint : IServerEntryPoint, IDisposable
{
    private readonly IApplicationPaths _applicationPaths;

    public EntryPoint(IApplicationPaths applicationPaths)
    {
        _applicationPaths = applicationPaths;
    }

    public void Run()
    {
        try { SegmentRepository.Instance.EnsureCreated(); } catch { /* best-effort */ }
        InjectLoaderTag();
    }

    public void Dispose() { }

    // Injects <script src="emby/SegmentLoop/ClientScript"> into dashboard
    // index.html. On Windows this works automatically. On Debian /opt/emby-server/
    // may be root-owned – if writing fails, the admin only needs to add ONE line
    // manually and the plugin handles everything else via the API endpoint.
    private void InjectLoaderTag()
    {
        try
        {
            var indexPath = Path.Combine(_applicationPaths.ProgramSystemPath,
                "dashboard-ui", "index.html");
            if (!File.Exists(indexPath)) return;

            var html = File.ReadAllText(indexPath);
            var tag = "    <script src=\"/emby/SegmentLoop/ClientScript\" defer></script>";

            if (html.Contains("SegmentLoop/ClientScript")) return;

            html = html.Replace("</body>", tag + Environment.NewLine + "</body>");
            File.WriteAllText(indexPath, html);

            if (!OperatingSystem.IsWindows())
            {
                try { Process.Start("chmod", $"644 \"{indexPath}\"")?.WaitForExit(3000); }
                catch { /* ok */ }
            }
        }
        catch
        {
            // index.html not writable (e.g. Debian root-owned system dir).
            // The admin should run ONCE as root:
            //   sed -i 's|</body>|    <script src="emby/SegmentLoop/ClientScript" defer></script>\n</body>|' /opt/emby-server/system/dashboard-ui/index.html
        }
    }
}
