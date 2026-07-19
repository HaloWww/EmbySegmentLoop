using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
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
        WriteClientConfiguration(
            _applicationPaths,
            Plugin.Instance?.Configuration ?? new PluginConfiguration());
        InjectItemJsHook();
    }

    public void Dispose() { }

    public static void WriteClientConfiguration(
        IApplicationPaths applicationPaths,
        PluginConfiguration configuration)
    {
        try
        {
            var indexPath = Path.Combine(applicationPaths.ProgramSystemPath,
                "dashboard-ui", "index.html");
            if (!File.Exists(indexPath)) return;

            var html = File.ReadAllText(indexPath);
            if (!html.Contains("</body>")) return;

            var js = ReadEmbeddedScript();
            if (string.IsNullOrWhiteSpace(js)) return;

            const string startMarker = "<!-- SegmentLoop:start -->";
            const string endMarker = "<!-- SegmentLoop:end -->";
            html = Regex.Replace(
                html,
                @"\s*<!-- SegmentLoop:start -->[\s\S]*?<!-- SegmentLoop:end -->\s*",
                Environment.NewLine,
                RegexOptions.IgnoreCase);
            html = Regex.Replace(
                html,
                @"\s*<!-- SegmentLoop -->\s*<script>[\s\S]*?</script>\s*",
                Environment.NewLine,
                RegexOptions.IgnoreCase);

            var injection = startMarker + Environment.NewLine +
                "<script>" + Environment.NewLine +
                "window.EmbySegmentLoopConfig = " +
                JsonSerializer.Serialize(new
                {
                    startKey = string.IsNullOrWhiteSpace(configuration.StartKey) ? "[" : configuration.StartKey,
                    endKey = string.IsNullOrWhiteSpace(configuration.EndKey) ? "]" : configuration.EndKey,
                    captureKey = string.IsNullOrWhiteSpace(configuration.CaptureKey) ? "P" : configuration.CaptureKey
                }) + ";" + Environment.NewLine +
                js + Environment.NewLine +
                "</script>" + Environment.NewLine +
                endMarker + Environment.NewLine;

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

    private void InjectItemJsHook()
    {
        try
        {
            var path = Path.Combine(_applicationPaths.ProgramSystemPath,
                "dashboard-ui", "item", "item.js");
            if (!File.Exists(path)) return;
            var js = File.ReadAllText(path);
            var hook = ";if(window.EmbySegLoop)setTimeout(function(){window.EmbySegLoop.render()},500);";
            if (js.Contains("EmbySegLoop")) return;
            File.WriteAllText(path, js + hook);
        }
        catch { }
    }
}
