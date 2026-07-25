using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Tasks;

namespace Emby.Plugins.SegmentLoop;

public sealed class EntryPoint : IServerEntryPoint, IDisposable
{
    private readonly IApplicationPaths _applicationPaths;
    private readonly ILibraryManager _libraryManager;
    private readonly ITaskManager _taskManager;
    private readonly ILogger _logger;
    private bool _subscribed;
    private static EntryPoint? _instance;

    public EntryPoint(
        IApplicationPaths applicationPaths,
        ILibraryManager libraryManager,
        ITaskManager taskManager,
        ILogger logger)
    {
        _applicationPaths = applicationPaths;
        _libraryManager = libraryManager;
        _taskManager = taskManager;
        _logger = logger;
    }

    public void Run()
    {
        try { SegmentRepository.Instance.EnsureCreated(); } catch { }
        _instance = this;
        _libraryManager.ItemRemoved += OnItemRemoved;
        _subscribed = true;
        ApplyCleanupSchedule();
        if (OperatingSystem.IsWindows())
        {
            WriteClientConfiguration(
                _applicationPaths,
                Plugin.Instance?.Configuration ?? new PluginConfiguration());
            InjectItemJsHook();
        }
    }

    public void Dispose()
    {
        if (_subscribed)
        {
            _libraryManager.ItemRemoved -= OnItemRemoved;
            _subscribed = false;
        }
        if (ReferenceEquals(_instance, this)) _instance = null;
    }

    public static void UpdateCleanupSchedule()
    {
        _instance?.ApplyCleanupSchedule();
    }

    private void ApplyCleanupSchedule()
    {
        try
        {
            var worker = _taskManager.ScheduledTasks.FirstOrDefault(
                value => string.Equals(
                    value.ScheduledTask.Key,
                    SegmentCleanupTask.TaskKey,
                    StringComparison.Ordinal));
            if (worker == null)
            {
                _logger.Warn("Segment Loop cleanup scheduled task was not found.");
                return;
            }

            var hours = Plugin.Instance?.Configuration.CleanupIntervalHours ?? 24;
            worker.Triggers = hours <= 0
                ? Array.Empty<TaskTriggerInfo>()
                : new[]
                {
                    new TaskTriggerInfo
                    {
                        Type = TaskTriggerInfo.TriggerInterval,
                        IntervalTicks = TimeSpan.FromHours(hours).Ticks
                    }
                };
            worker.ReloadTriggerEvents();
            _logger.Info(
                hours <= 0
                    ? "Segment Loop automatic orphan cleanup is disabled."
                    : "Segment Loop orphan cleanup interval set to {0} hours.",
                hours);
        }
        catch (Exception error)
        {
            _logger.ErrorException("Failed to update Segment Loop cleanup schedule.", error);
        }
    }

    private void OnItemRemoved(object? sender, ItemChangeEventArgs eventArgs)
    {
        try
        {
            var item = eventArgs.Item;
            if (item == null) return;
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                item.InternalId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                item.Id.ToString("D"),
                item.Id.ToString("N")
            };
            if (!string.IsNullOrWhiteSpace(item.IdString)) ids.Add(item.IdString);
            SegmentRepository.Instance.DeleteItemIds(ids);
            _logger.Debug("Segment Loop removed segment records for deleted item {0}.", item.InternalId);
        }
        catch (Exception error)
        {
            _logger.ErrorException("Failed to remove Segment Loop records for a deleted item.", error);
        }
    }

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
        }
        catch { }
    }

    private static string ReadEmbeddedScript()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var name = assembly.GetManifestResourceNames()
            .FirstOrDefault(value => value.EndsWith("segmentloop.js", StringComparison.OrdinalIgnoreCase));
        if (name == null) return "";
        using var stream = assembly.GetManifestResourceStream(name);
        if (stream == null) return "";
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
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
