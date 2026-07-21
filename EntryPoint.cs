using MediaBrowser.Controller.Plugins;

namespace Emby.Plugins.SegmentLoop;

public sealed class EntryPoint : IServerEntryPoint, IDisposable
{
    public void Run()
    {
        try { SegmentRepository.Instance.EnsureCreated(); } catch { }
    }

    public void Dispose() { }
}
