using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class EntryPoint : IServerEntryPoint, IDisposable
{
    private const string ConfigScriptTag = "    <script src=\"modules/segmentloop/segmentloop.config.js\" defer></script>";
    private const string ScriptTag = "    <script src=\"modules/segmentloop/segmentloop.js\" defer></script>";
    private readonly IApplicationPaths _applicationPaths;

    public EntryPoint(IApplicationPaths applicationPaths)
    {
        _applicationPaths = applicationPaths;
    }

    public void Run()
    {
        // SQLite init is best-effort: if the native library is missing on this platform
        // (e.g. Debian where Emby ships its own SQLite via SQLitePCLRaw), we log and
        // continue – segment storage simply won't persist across restarts but the
        // frontend features still work.
        try
        {
            SegmentRepository.Instance.EnsureCreated();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[SegmentLoop] SQLite init failed (segments will not persist): {ex.Message}");
        }

        // Always inject client assets regardless of the SQLite outcome.
        try
        {
            InstallClientAssets();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[SegmentLoop] Failed to install client assets: {ex.Message}");
        }
    }

    public void Dispose()
    {
    }

    private void InstallClientAssets()
    {
        var dashboardPath = Path.Combine(_applicationPaths.ProgramSystemPath, "dashboard-ui");
        var indexPath = Path.Combine(dashboardPath, "index.html");
        var targetScriptPath = Path.Combine(dashboardPath, "modules", "segmentloop", "segmentloop.js");
        if (!File.Exists(indexPath))
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(targetScriptPath)!);
        File.WriteAllText(targetScriptPath, ReadEmbeddedScript());
        WriteClientConfiguration(_applicationPaths, Plugin.Instance?.Configuration ?? new PluginConfiguration());

        var html = File.ReadAllText(indexPath);
        html = RemoveOwnScriptTags(html);
        html = EnsureScriptTags(html, ConfigScriptTag + Environment.NewLine + ScriptTag);
        File.WriteAllText(indexPath, html);
    }

    private static string ReadEmbeddedScript()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("segmentloop.js", StringComparison.OrdinalIgnoreCase));

        if (resourceName == null)
        {
            return string.Empty;
        }

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            return string.Empty;
        }

        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    internal static void WriteClientConfiguration(IApplicationPaths applicationPaths, PluginConfiguration configuration)
    {
        var dashboardPath = Path.Combine(applicationPaths.ProgramSystemPath, "dashboard-ui");
        var configPath = Path.Combine(dashboardPath, "modules", "segmentloop", "segmentloop.config.js");
        Directory.CreateDirectory(Path.GetDirectoryName(configPath)!);

        var payload = new
        {
            startKey = string.IsNullOrWhiteSpace(configuration.StartKey) ? "[" : configuration.StartKey,
            endKey = string.IsNullOrWhiteSpace(configuration.EndKey) ? "]" : configuration.EndKey
        };

        File.WriteAllText(configPath, "window.EmbySegmentLoopConfig = " + JsonSerializer.Serialize(payload) + ";" + Environment.NewLine);
    }

    private static string EnsureScriptTags(string html, string scriptTags)
    {
        var bodyIndex = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (bodyIndex < 0)
        {
            return html;
        }

        return html.Insert(bodyIndex, scriptTags + Environment.NewLine);
    }

    private static string RemoveOwnScriptTags(string html)
    {
        return Regex.Replace(
            html,
            """[ \t]*<script\b[^>]*\bsrc\s*=\s*(['"])(?:\.?/)?modules/segmentloop/segmentloop(?:\.config)?\.js(?:\?[^'"]*)?\1[^>]*>\s*</script>\s*""",
            string.Empty,
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
}
