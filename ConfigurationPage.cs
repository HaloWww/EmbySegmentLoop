using System.Text;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class ConfigurationPage : IPluginConfigurationPage
{
    public string Name => "segmentloop";

    public ConfigurationPageType ConfigurationPageType => ConfigurationPageType.PluginConfiguration;

    public IPlugin Plugin => global::Emby.Plugins.SegmentLoop.Plugin.Instance!;

    public Stream GetHtmlStream()
    {
        return new MemoryStream(Encoding.UTF8.GetBytes(Html));
    }

    private const string Html = @"<div data-role=""page"" class=""page type-interior pluginConfigurationPage segmentLoopConfigurationPage"" data-require=""emby-input,emby-button"">
    <style>
        .segmentLoopConfigurationPage .fieldDescription { color:#666; margin-top:.3rem; font-size:.88rem }
        .segmentLoopConfigurationPage .segmentLoopSave { background:#43a047; color:#fff; border:0; border-radius:.25rem; padding:.75rem 1.6rem; cursor:pointer; font:inherit; font-weight:600; font-size:1rem }
        .segmentLoopConfigurationPage .segmentLoopSave:hover { background:#388e3c }
    </style>
    <div data-role=""content"">
        <div class=""content-primary"">
            <form class=""segmentLoopConfigurationForm"">
                <h1>Segment Loop</h1>
                <div class=""inputContainer"">
                    <input is=""emby-input"" id=""slStart"" class=""txtStartKey"" value=""["" label=""片段开始快捷键"" onfocus=""EmbySegLoad()"" />
                    <div class=""fieldDescription"">默认是 [。填写 KeyboardEvent.key 的值。</div>
                </div>
                <div class=""inputContainer"">
                    <input is=""emby-input"" id=""slEnd"" class=""txtEndKey"" value=""]"" label=""片段结束快捷键"" onfocus=""EmbySegLoad()"" />
                    <div class=""fieldDescription"">默认是 ]。保存后刷新 Web 客户端生效。</div>
                </div>
                <div class=""inputContainer"">
                    <input is=""emby-input"" id=""slPath"" class=""txtStoragePath"" placeholder=""留空使用 Emby 元数据目录"" label=""片段数据库文件"" onfocus=""EmbySegLoad()"" />
                    <div class=""fieldDescription"">留空时保存到 programdata/metadata/segmentloop/segments.db。</div>
                </div>
                <button is=""emby-button"" type=""button"" class=""segmentLoopSave raised"" onclick=""EmbySegSave()""><span>保存</span></button>
            </form>
        </div>
    </div>
    <script>
        var EmbySegPid='8c1e7ca2-3f07-4b62-a4d1-929f07509367';
        window.EmbySegLoad=function(){var s=document.getElementById('slStart'),e=document.getElementById('slEnd'),p=document.getElementById('slPath');ApiClient.getPluginConfiguration(EmbySegPid).then(function(c){if(s&&c.StartKey)s.value=c.StartKey;if(e&&c.EndKey)e.value=c.EndKey;if(p&&c.StoragePath!=null)p.value=c.StoragePath})};
        window.EmbySegSave=function(){var s=document.getElementById('slStart'),e=document.getElementById('slEnd'),p=document.getElementById('slPath'),sk=s?s.value||'[':'[',ek=e?e.value||']':']',pt=p?p.value||'':'';ApiClient.getPluginConfiguration(EmbySegPid).then(function(c){c.StartKey=sk;c.EndKey=ek;c.StoragePath=pt;return ApiClient.updatePluginConfiguration(EmbySegPid,c)}).then(function(){if(typeof Dashboard!='undefined'&&Dashboard.alert)Dashboard.alert('\u5df2\u4fdd\u5b58\u3002\u8bf7\u5237\u65b0 Emby Web \u9875\u9762\u8ba9\u5feb\u6377\u952e\u914d\u7f6e\u751f\u6548\u3002')})};
        EmbySegLoad();
    </script>
</div>";
}
