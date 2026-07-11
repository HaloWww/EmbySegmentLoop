using System.Reflection;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class EntryPoint : IServerEntryPoint, IDisposable
{
    private readonly IConfigurationManager _configurationManager;

    public EntryPoint(IConfigurationManager configurationManager)
    {
        _configurationManager = configurationManager;
    }

    public void Run()
    {
        try { SegmentRepository.Instance.EnsureCreated(); } catch { /* best effort */ }

        // Inject our script tag via Emby's built-in CustomJavascript mechanism.
        // This requires ZERO file-system writes to the system directory – Emby
        // reads the configuration and injects the <script> tag into every page.
        InjectCustomJavascript();
    }

    public void Dispose() { }

    private void InjectCustomJavascript()
    {
        try
        {
            var config = _configurationManager.CommonConfiguration;
            var ui = config.UICustomization ??= new MediaBrowser.Model.Configuration.UICustomization();
            var ver = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "";

            var tag = "<script src=\"emby/SegmentLoop/ClientScript?v=" + ver + "\" defer></script>";

            // Only add if not already present
            if (ui.CustomJavascript == null || !ui.CustomJavascript.Contains("SegmentLoop/ClientScript"))
            {
                ui.CustomJavascript = (ui.CustomJavascript ?? "") + "\n" + tag;
                _configurationManager.SaveConfiguration();
            }
        }
        catch { /* best effort */ }
    }
}
