using System.Reflection;
using MediaBrowser.Controller.Api;
using MediaBrowser.Model.Services;
using MediaBrowser.Controller.Net;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Entities;
using System.Globalization;

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
    public string? ExpectedRevision { get; set; }
}

[Route("/SegmentLoop/State/{ItemId}", "GET")]
[Authenticated]
public sealed class GetSegmentLoopState
{
    public string ItemId { get; set; } = string.Empty;
}

public sealed class SegmentSnapshot
{
    public List<SegmentRecord> Segments { get; set; } = new();
    public string Revision { get; set; } = string.Empty;
}

[Route("/SegmentLoop/ClientScript", "GET")]
public sealed class GetSegmentLoopScript
{
}

[Route("/SegmentLoop/ClientConfiguration", "GET")]
[Authenticated]
public sealed class GetSegmentLoopClientConfiguration { }

[Route("/SegmentLoop/Highlights", "GET")]
[Authenticated]
public sealed class GetSegmentLoopHighlights
{
    public string ItemIds { get; set; } = string.Empty;
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
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IAuthorizationContext _authorizationContext;

    public SegmentLoopService(ILibraryManager libraryManager, IUserManager userManager,
        IAuthorizationContext authorizationContext)
    {
        _libraryManager = libraryManager;
        _userManager = userManager;
        _authorizationContext = authorizationContext;
    }

    private bool CheckItemAccess(string itemId)
    {
        BaseItem? item = null;
        if (long.TryParse(itemId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
            item = _libraryManager.GetItemById(id);
        else if (Guid.TryParse(itemId, out var guid))
            item = _libraryManager.GetItemById(guid);
        if (item == null || item.MediaType != "Video")
        {
            Request.Response.StatusCode = 400;
            return false;
        }
        var authorization = _authorizationContext.GetAuthorizationInfo(Request);
        // Server API keys have no user; authenticated user requests follow library visibility.
        if (authorization.UserId > 0)
        {
            var user = _userManager.GetUserById(authorization.UserId);
            if (user == null || !item.IsVisible(user))
            {
                Request.Response.StatusCode = 403;
                return false;
            }
        }
        return true;
    }

    public object Get(GetSegmentLoopSegments request)
    {
        if (!CheckItemAccess(request.ItemId)) return new { Error = "Video not found or access denied." };
        return SegmentRepository.Instance.Get(request.ItemId);
    }

    public object Post(SaveSegmentLoopSegments request)
    {
        if (!CheckItemAccess(request.ItemId)) return new { Error = "Video not found or access denied." };
        try
        {
            var revision = SegmentRepository.Instance.Replace(request.ItemId, request.Segments ?? new(), request.ExpectedRevision);
            return new { Success = true, Revision = revision };
        }
        catch (SegmentConflictException error)
        {
            Request.Response.StatusCode = 409;
            return new { Error = error.Message };
        }
        catch (ArgumentException error)
        {
            Request.Response.StatusCode = 400;
            return new { Error = error.Message };
        }
    }

    public object Get(GetSegmentLoopState request)
    {
        if (!CheckItemAccess(request.ItemId)) return new { Error = "Video not found or access denied." };
        return SegmentRepository.Instance.GetSnapshot(request.ItemId);
    }

    public object Get(GetSegmentLoopClientConfiguration request)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        return new
        {
            StartKey = config.StartKey,
            EndKey = config.EndKey,
            CaptureKey = config.CaptureKey,
            CardHighlightMode = config.CardHighlightMode
        };
    }

    public object Get(GetSegmentLoopHighlights request)
    {
        var ids = request.ItemIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal).ToArray();
        if (ids.Length > 100)
        {
            Request.Response.StatusCode = 400;
            return new { Error = "At most 100 item IDs are allowed." };
        }
        var authorization = _authorizationContext.GetAuthorizationInfo(Request);
        var user = authorization.UserId > 0 ? _userManager.GetUserById(authorization.UserId) : null;
        var allowed = new List<string>();
        foreach (var itemId in ids)
        {
            BaseItem? item = null;
            if (long.TryParse(itemId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
                item = _libraryManager.GetItemById(id);
            else if (Guid.TryParse(itemId, out var guid))
                item = _libraryManager.GetItemById(guid);
            if (item?.MediaType == "Video" && (authorization.UserId <= 0 || (user != null && item.IsVisible(user))))
                allowed.Add(itemId);
        }
        return new { ItemIds = SegmentRepository.Instance.GetItemIdsWithSegments(allowed) };
    }

    public object Get(GetSegmentLoopScript request)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("segmentloop.js", StringComparison.OrdinalIgnoreCase));
        if (resourceName == null) return string.Empty;
        using var stream = assembly.GetManifestResourceStream(resourceName);
        using var reader = new StreamReader(stream!);
        var js = reader.ReadToEnd();
        Request.Response.ContentType = "text/javascript; charset=utf-8";
        return js;
    }
}
