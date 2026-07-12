using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Emby.Plugins.SegmentLoop;

public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginId = Guid.Parse("8c1e7ca2-3f07-4b62-a4d1-929f07509367");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        var metadataPath = applicationPaths is IServerApplicationPaths serverPaths
            ? serverPaths.InternalMetadataPath
            : Path.Combine(applicationPaths.ProgramDataPath, "metadata");
        SegmentRepository.Configure(Path.Combine(metadataPath, "segmentloop", "segments.db"));
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }
    public override string Name => "Segment Loop";
    public override string Description => "Video segment capture and loop playback.";
    public override Guid Id => PluginId;

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        base.UpdateConfiguration(configuration);
        ConfigureRepository(Configuration);
    }

    private void ConfigureRepository(PluginConfiguration configuration)
    {
        var metadataPath = ApplicationPaths is IServerApplicationPaths serverPaths
            ? serverPaths.InternalMetadataPath
            : Path.Combine(ApplicationPaths.ProgramDataPath, "metadata");
        var path = string.IsNullOrWhiteSpace(configuration.StoragePath)
            ? Path.Combine(metadataPath, "segmentloop", "segments.db")
            : Environment.ExpandEnvironmentVariables(configuration.StoragePath.Trim());
        SegmentRepository.Configure(Path.GetFullPath(path));
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "segmentloop",
                EmbeddedResourcePath = GetType().Namespace + ".config.html",
                EnableInMainMenu = false,
                DisplayName = "Segment Loop"
            }
        };
    }
}

public sealed class PluginConfiguration : BasePluginConfiguration
{
    public string StartKey { get; set; } = "[";
    public string EndKey { get; set; } = "]";
    public string CaptureKey { get; set; } = "P";
    public string StoragePath { get; set; } = string.Empty;
}
