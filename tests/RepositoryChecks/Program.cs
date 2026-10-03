using Emby.Plugins.SegmentLoop;

var directory = Path.Combine(Path.GetTempPath(), "segmentloop-checks-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
try
{
    var db = Path.Combine(directory, "segments.db");
    SegmentRepository.Configure(db);
    var repository = SegmentRepository.Instance;
    repository.EnsureCreated();
    var first = new SegmentRecord { Id = "original", Name = "中文片段", StartMs = 0, EndMs = 1000, Order = 1 };
    repository.Replace("1", new[] { first });
    var initial = repository.GetSnapshot("1");
    Check(initial.Segments.Single().Name == "中文片段", "UTF-8 read/write");
    Check(repository.GetItemIdsWithSegments(new[] { "1", "missing", "' OR 1=1--" }).SequenceEqual(new[] { "1" }),
        "batch highlight query returns only requested segment items and binds IDs safely");
    Check(repository.GetItemIdsWithSegments(Array.Empty<string>()).Count == 0, "empty highlight query");
    Throws<ArgumentException>(() => repository.Replace("1", new[] { new SegmentRecord { Id = "bad", StartMs = 3, EndMs = 2 } }));
    Throws<ArgumentException>(() => repository.Replace("1", new[] { first, first }));
    Check(repository.GetSnapshot("1").Revision == initial.Revision, "invalid replacement preserved database");
    repository.Replace("1", Array.Empty<SegmentRecord>(), initial.Revision);
    Throws<SegmentConflictException>(() => repository.Replace("1", new[] { first }, initial.Revision));
    Check(repository.Get("1").Count == 0, "stale revision cannot resurrect deleted segments");
    var revision = repository.GetSnapshot("1").Revision;
    var winners = 0;
    Parallel.For(0, 8, index =>
    {
        try
        {
            repository.Replace("1", new[] { new SegmentRecord { Id = "thread-" + index, StartMs = 0, EndMs = 1000 } }, revision);
            Interlocked.Increment(ref winners);
        }
        catch (SegmentConflictException) { }
    });
    Check(winners == 1, "exactly one concurrent writer succeeds");
    repository.DeleteItemIds(new[] { "1", "1", "" });
    Check(repository.GetItemIds().Count == 0, "cleanup removes all item records");
    var custom = Path.Combine(directory, "custom", "segments.db");
    SegmentRepository.Configure(custom);
    repository.Replace("2", new[] { first });
    SegmentRepository.Configure(db);
    Check(repository.Get("2").Count == 0, "independent configured storage paths");
    SegmentRepository.Configure(custom);
    Check(repository.Get("2").Count == 1, "configured storage survives reopening");
    Console.WriteLine("Repository checks passed.");
}
finally { Directory.Delete(directory, true); }

static void Check(bool success, string name)
{
    if (!success) throw new Exception(name);
    Console.WriteLine("PASS " + name);
}
static void Throws<T>(Action action) where T : Exception
{
    try { action(); } catch (T) { return; }
    throw new Exception("Expected " + typeof(T).Name);
}

namespace Emby.Plugins.SegmentLoop
{
    public sealed class SegmentRecord
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public long StartMs { get; set; }
        public long EndMs { get; set; }
        public int Order { get; set; }
    }
    public sealed class SegmentSnapshot
    {
        public List<SegmentRecord> Segments { get; set; } = new();
        public string Revision { get; set; } = "";
    }
}
