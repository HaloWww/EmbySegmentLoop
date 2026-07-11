using System.Text;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class ConfigurationPage : IPluginConfigurationPage
{
    public string Name => "segmentloop";
    public ConfigurationPageType ConfigurationPageType => ConfigurationPageType.PluginConfiguration;
    public IPlugin Plugin => global::Emby.Plugins.SegmentLoop.Plugin.Instance!;
    public Stream GetHtmlStream() => new MemoryStream(Encoding.UTF8.GetBytes(Html));

    // Use data-role="page" so Emby navigates to this as a full page (not inline overlay).
    // No background CSS override – rely on Emby's built-in page styling to avoid caching issues.
    // Chinese text expressed as HTML entities to avoid source-file encoding corruption.
    // All interactivity via inline onfocus/onclick IIFE handlers (scripts from innerHTML don't execute).
    private const string Html =
        @"<div data-role=""page"" class=""page type-interior pluginConfigurationPage segmentLoopConfigurationPage"">" +
        @"<style>" +
        @".segmentLoopConfigurationPage .segmentLoopForm{max-width:500px}" +
        @".segmentLoopConfigurationPage .inputContainer{margin:0 0 1.2rem}" +
        @".segmentLoopConfigurationPage .inputContainer label{display:block;font-weight:600;margin:0 0 .35rem}" +
        @".segmentLoopConfigurationPage .inputContainer input[type=text]{width:100%;box-sizing:border-box;padding:.65rem .75rem;border:1px solid rgba(128,128,128,.45);border-radius:.25rem;font:inherit;background:transparent;color:inherit}" +
        @".segmentLoopConfigurationPage .inputContainer input[type=text]:focus{border-color:#43a047;outline:0}" +
        @".segmentLoopConfigurationPage .fieldDescription{color:rgba(128,128,128,.85);margin-top:.25rem;font-size:.88rem}" +
        @".segmentLoopConfigurationPage .btnSave{border:0;background:#43a047;color:#fff;border-radius:.25rem;padding:.7rem 1.5rem;cursor:pointer;font:inherit;font-weight:600}" +
        @".segmentLoopConfigurationPage .btnSave:hover{background:#388e3c}" +
        @"</style>" +
        @"<div data-role=""content""><div class=""content-primary""><form class=""segmentLoopForm"">" +
        @"<h2>Segment Loop</h2>" +

        // Start key
        @"<div class=""inputContainer"">" +
        @"<label for=""slStart"">&#x7247;&#x6BB5;&#x5F00;&#x59CB;&#x5FEB;&#x6377;&#x952E;</label>" +
        @"<input type=""text"" id=""slStart"" value=""["" " +
        @"onfocus=""(function(i){var p='8c1e7ca2-3f07-4b62-a4d1-929f07509367';" +
        @"ApiClient.getPluginConfiguration(p).then(function(c){" +
        @"if(c.StartKey)i.value=c.StartKey;" +
        @"var e=document.getElementById('slEnd');if(e&&c.EndKey)e.value=c.EndKey;" +
        @"var s=document.getElementById('slPath');if(s&&c.StoragePath!=null)s.value=c.StoragePath" +
        @"})})(this)"" />" +
        @"<div class=""fieldDescription"">&#x9ED8;&#x8BA4;&#x662F; [&#x3002;&#x586B;&#x5199; KeyboardEvent.key &#x7684;&#x503C;&#x3002;</div>" +
        @"</div>" +

        // End key
        @"<div class=""inputContainer"">" +
        @"<label for=""slEnd"">&#x7247;&#x6BB5;&#x7ED3;&#x675F;&#x5FEB;&#x6377;&#x952E;</label>" +
        @"<input type=""text"" id=""slEnd"" value=""]"" " +
        @"onfocus=""(function(i){var p='8c1e7ca2-3f07-4b62-a4d1-929f07509367';" +
        @"ApiClient.getPluginConfiguration(p).then(function(c){" +
        @"var s=document.getElementById('slStart');if(s&&c.StartKey)s.value=c.StartKey;" +
        @"if(c.EndKey)i.value=c.EndKey;" +
        @"var t=document.getElementById('slPath');if(t&&c.StoragePath!=null)t.value=c.StoragePath" +
        @"})})(this)"" />" +
        @"<div class=""fieldDescription"">&#x9ED8;&#x8BA4;&#x662F; ]&#x3002;&#x4FDD;&#x5B58;&#x540E;&#x5237;&#x65B0; Web &#x5BA2;&#x6237;&#x7AEF;&#x751F;&#x6548;&#x3002;</div>" +
        @"</div>" +

        // Storage path
        @"<div class=""inputContainer"">" +
        @"<label for=""slPath"">&#x7247;&#x6BB5;&#x6570;&#x636E;&#x5E93;&#x6587;&#x4EF6;</label>" +
        @"<input type=""text"" id=""slPath"" placeholder=""&#x7559;&#x7A7A;&#x4F7F;&#x7528; Emby &#x5143;&#x6570;&#x636E;&#x76EE;&#x5F55;"" " +
        @"onfocus=""(function(i){var p='8c1e7ca2-3f07-4b62-a4d1-929f07509367';" +
        @"ApiClient.getPluginConfiguration(p).then(function(c){" +
        @"var s=document.getElementById('slStart');if(s&&c.StartKey)s.value=c.StartKey;" +
        @"var e=document.getElementById('slEnd');if(e&&c.EndKey)e.value=c.EndKey;" +
        @"if(c.StoragePath!=null)i.value=c.StoragePath" +
        @"})})(this)"" />" +
        @"<div class=""fieldDescription"">&#x7559;&#x7A7A;&#x65F6;&#x4FDD;&#x5B58;&#x5230; programdata/metadata/segmentloop/segments.db&#x3002;</div>" +
        @"</div>" +

        // Save button
        @"<button type=""button"" class=""btnSave"" " +
        @"onclick=""(function(){var p='8c1e7ca2-3f07-4b62-a4d1-929f07509367';" +
        @"var s=document.getElementById('slStart'),e=document.getElementById('slEnd'),t=document.getElementById('slPath')," +
        @"sk=s&&s.value||'[',ek=e&&e.value||']',pt=t&&t.value||'';" +
        @"ApiClient.getPluginConfiguration(p).then(function(c){c.StartKey=sk;c.EndKey=ek;c.StoragePath=pt;" +
        @"return ApiClient.updatePluginConfiguration(p,c)}).then(function(){" +
        @"if(typeof Dashboard!='undefined'&&Dashboard.alert)" +
        @"Dashboard.alert('\u5df2\u4fdd\u5b58\u3002\u8bf7\u5237\u65b0 Emby Web \u9875\u9762\u8ba9\u5feb\u6377\u952e\u914d\u7f6e\u751f\u6548\u3002')" +
        @"})})()"">&#x4FDD;&#x5B58;</button>" +

        @"</form></div></div></div>";
}
