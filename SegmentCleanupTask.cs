using System.Globalization;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Tasks;

namespace Emby.Plugins.SegmentLoop;

public sealed class SegmentCleanupTask : IScheduledTask, IConfigurableScheduledTask
{
    public const string TaskKey = "SegmentLoopCleanupInvalidItems";

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger _logger;

    public SegmentCleanupTask(ILibraryManager libraryManager, ILogger logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public string Name => "清理无效视频片段";
    public string Key => TaskKey;
    public string Description => "删除已不存在于 Emby 媒体库中的 Segment Loop 片段记录。";
    public string Category => "Segment Loop";
    public bool IsHidden => false;
    public bool IsEnabled => true;
    public bool IsLogged => true;

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        var hours = Plugin.Instance?.Configuration.CleanupIntervalHours ?? 24;
        if (hours <= 0) return Array.Empty<TaskTriggerInfo>();
        return new[]
        {
            new TaskTriggerInfo
            {
                Type = TaskTriggerInfo.TriggerInterval,
                IntervalTicks = TimeSpan.FromHours(hours).Ticks
            }
        };
    }

    public Task Execute(CancellationToken cancellationToken, IProgress<double> progress)
    {
        var itemIds = SegmentRepository.Instance.GetItemIds();
        if (itemIds.Count == 0)
        {
            progress.Report(100);
            return Task.CompletedTask;
        }

        var orphaned = new List<string>();
        for (var index = 0; index < itemIds.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var itemId = itemIds[index];
            if (!ItemExists(itemId)) orphaned.Add(itemId);
            progress.Report((index + 1) * 100.0 / itemIds.Count);
        }

        SegmentRepository.Instance.DeleteItemIds(orphaned);
        _logger.Info(
            "Segment Loop cleanup checked {0} item ids and removed {1} orphaned item records.",
            itemIds.Count,
            orphaned.Count);
        return Task.CompletedTask;
    }

    private bool ItemExists(string itemId)
    {
        if (long.TryParse(itemId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var internalId))
        {
            return _libraryManager.GetItemById(internalId) != null;
        }
        if (Guid.TryParse(itemId, out var guid))
        {
            return _libraryManager.GetItemById(guid) != null;
        }
        return false;
    }
}
