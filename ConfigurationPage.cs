using System.Reflection;
using System.Text;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class ConfigurationPage : IPluginConfigurationPage
{
    public string Name => "segmentloop";
    public ConfigurationPageType ConfigurationPageType => ConfigurationPageType.PluginConfiguration;
    public IPlugin Plugin => Emby.Plugins.SegmentLoop.Plugin.Instance!;

    public Stream GetHtmlStream()
    {
        try
        {
            var a = Assembly.GetExecutingAssembly();
            var name = a.GetManifestResourceNames()
                .FirstOrDefault(n => n.EndsWith("config.html", StringComparison.OrdinalIgnoreCase));
            if (name == null) return Stream.Null;
            var html = a.GetManifestResourceStream(name);
            if (html == null) return Stream.Null;
            using var r = new StreamReader(html);
            return new MemoryStream(Encoding.UTF8.GetBytes(r.ReadToEnd()));
        }
        catch { return Stream.Null; }
    }
}
