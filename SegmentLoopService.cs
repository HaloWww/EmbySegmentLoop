using MediaBrowser.Controller.Api;
using MediaBrowser.Model.Services;
using MediaBrowser.Controller.Net;

namespace Emby.Plugins.SegmentLoop;

[Route("/SegmentLoop/Segments/{ItemId}", "GET")]
[Authenticated]
public sealed class GetSegmentLoopSegments
{
    public string ItemId { get; set; } = string.Empty;
}

[Route("/SegmentLoop/Segments/{ItemId}", "POST")]
[Authenticated]
public sealed class SaveSegmentLoopSegments
{
    public string ItemId { get; set; } = string.Empty;
    public List<SegmentRecord> Segments { get; set; } = new();
}

public sealed class SegmentRecord
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public long StartMs { get; set; }
    public long EndMs { get; set; }
    public int Order { get; set; }
}

public sealed class SegmentLoopService : BaseApiService
{
    public object Get(GetSegmentLoopSegments request)
    {
        return SegmentRepository.Instance.Get(request.ItemId);
    }

    public object Post(SaveSegmentLoopSegments request)
    {
        SegmentRepository.Instance.Replace(request.ItemId, request.Segments ?? new());
        return new { Success = true };
    }
}
