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
        try { SegmentRepository.Instance.EnsureCreated(); } catch { }
        InjectScript();
    }

    public void Dispose() { }

    private void InjectScript()
    {
        try
        {
            var indexPath = Path.Combine(_applicationPaths.ProgramSystemPath,
                "dashboard-ui", "index.html");
            if (!File.Exists(indexPath)) return;

            var html = File.ReadAllText(indexPath);
            var marker = "<!-- SegmentLoop -->";

            if (html.Contains(marker)) return;
            if (!html.Contains("</body>")) return;

            var js = ReadEmbeddedScript();
            if (string.IsNullOrWhiteSpace(js)) return;

            var injection = marker + Environment.NewLine +
                "<script>" + Environment.NewLine +
                "window.EmbySegmentLoopConfig = { startKey: '[', endKey: ']' };" + Environment.NewLine +
                js + Environment.NewLine +
                "</script>" + Environment.NewLine;

            html = html.Replace("</body>", injection + "</body>");
            File.WriteAllText(indexPath, html);

            if (!OperatingSystem.IsWindows())
                try { Process.Start("chmod", $"644 \"{indexPath}\"")?.WaitForExit(3000); } catch { }
        }
        catch { }
    }

    private static string ReadEmbeddedScript()
    {
        var a = Assembly.GetExecutingAssembly();
        var name = a.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith("segmentloop.js", StringComparison.OrdinalIgnoreCase));
        if (name == null) return "";
        using var s = a.GetManifestResourceStream(name);
        if (s == null) return "";
        using var r = new StreamReader(s);
        return r.ReadToEnd();
    }
}
