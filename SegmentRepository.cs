using System.Runtime.InteropServices;

namespace Emby.Plugins.SegmentLoop;

internal sealed class SegmentRepository
{
    private const int Ok = 0;
    private const int Row = 100;
    private const int Done = 101;
    private const int OpenReadWrite = 0x00000002;
    private const int OpenCreate = 0x00000004;
    private const int OpenFullMutex = 0x00010000;
    private static readonly object Sync = new();
    private static string _databasePath = string.Empty;

    public static SegmentRepository Instance { get; } = new();

    public static void Configure(string databasePath)
    {
        lock (Sync)
        {
            _databasePath = databasePath;
        }
    }

    public void EnsureCreated()
    {
        lock (Sync)
        {
            using var db = Open();
        }
    }

    public List<SegmentRecord> Get(string itemId)
    {
        if (string.IsNullOrWhiteSpace(itemId)) return new();
        lock (Sync)
        {
            using var db = Open();
            using var statement = db.Prepare("SELECT segment_id,name,start_ms,end_ms,sort_order FROM segments WHERE item_id=? ORDER BY sort_order,segment_id");
            statement.BindText(1, itemId);
            var result = new List<SegmentRecord>();
            while (statement.Step() == Row)
            {
                result.Add(new SegmentRecord
                {
                    Id = statement.Text(0),
                    Name = statement.Text(1),
                    StartMs = statement.Int64(2),
                    EndMs = statement.Int64(3),
                    Order = checked((int)statement.Int64(4))
                });
            }
            return result;
        }
    }

    public void Replace(string itemId, IReadOnlyList<SegmentRecord> segments)
    {
        if (string.IsNullOrWhiteSpace(itemId)) throw new ArgumentException("ItemId is required.", nameof(itemId));
        lock (Sync)
        {
            using var db = Open();
            db.Exec("BEGIN IMMEDIATE");
            try
            {
                using (var delete = db.Prepare("DELETE FROM segments WHERE item_id=?"))
                {
                    delete.BindText(1, itemId);
                    delete.ExpectDone();
                }
                using var insert = db.Prepare("INSERT INTO segments(item_id,segment_id,name,start_ms,end_ms,sort_order) VALUES(?,?,?,?,?,?)");
                foreach (var segment in segments)
                {
                    insert.BindText(1, itemId);
                    insert.BindText(2, segment.Id);
                    insert.BindText(3, segment.Name);
                    insert.BindInt64(4, segment.StartMs);
                    insert.BindInt64(5, segment.EndMs);
                    insert.BindInt64(6, segment.Order);
                    insert.ExpectDone();
                    insert.Reset();
                }
                db.Exec("COMMIT");
            }
            catch
            {
                db.Exec("ROLLBACK");
                throw;
            }
        }
    }

    private static Database Open()
    {
        if (string.IsNullOrWhiteSpace(_databasePath)) throw new InvalidOperationException("Segment database path is not configured.");
        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        var db = new Database(_databasePath);
        db.Exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS segments(item_id TEXT NOT NULL,segment_id TEXT NOT NULL,name TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,sort_order INTEGER NOT NULL,PRIMARY KEY(item_id,segment_id)); CREATE INDEX IF NOT EXISTS ix_segments_item_order ON segments(item_id,sort_order);");
        return db;
    }

    private sealed class Database : IDisposable
    {
        private IntPtr _handle;
        public Database(string path)
        {
            Check(sqlite3_open_v2(path, out _handle, OpenReadWrite | OpenCreate | OpenFullMutex, null));
        }
        public Statement Prepare(string sql)
        {
            Check(sqlite3_prepare_v2(_handle, sql, -1, out var statement, IntPtr.Zero));
            return new Statement(this, statement);
        }
        public void Exec(string sql) => Check(sqlite3_exec(_handle, sql, IntPtr.Zero, IntPtr.Zero, out _));
        public void Check(int code)
        {
            if (code != Ok && code != Row && code != Done) throw new InvalidOperationException(Marshal.PtrToStringUTF8(sqlite3_errmsg(_handle)) ?? "SQLite error " + code);
        }
        public void Dispose() { if (_handle != IntPtr.Zero) { sqlite3_close_v2(_handle); _handle = IntPtr.Zero; } }
    }

    private sealed class Statement : IDisposable
    {
        private readonly Database _db;
        private IntPtr _handle;
        public Statement(Database db, IntPtr handle) { _db = db; _handle = handle; }
        public void BindText(int index, string value) => _db.Check(sqlite3_bind_text(_handle, index, value ?? string.Empty, -1, new IntPtr(-1)));
        public void BindInt64(int index, long value) => _db.Check(sqlite3_bind_int64(_handle, index, value));
        public int Step() { var result = sqlite3_step(_handle); _db.Check(result); return result; }
        public void ExpectDone() { if (Step() != Done) throw new InvalidOperationException("SQLite statement did not finish."); }
        public string Text(int index) => Marshal.PtrToStringUTF8(sqlite3_column_text(_handle, index)) ?? string.Empty;
        public long Int64(int index) => sqlite3_column_int64(_handle, index);
        public void Reset() { _db.Check(sqlite3_reset(_handle)); _db.Check(sqlite3_clear_bindings(_handle)); }
        public void Dispose() { if (_handle != IntPtr.Zero) { sqlite3_finalize(_handle); _handle = IntPtr.Zero; } }
    }

    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out IntPtr db, int flags, [MarshalAs(UnmanagedType.LPUTF8Str)] string? vfs);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_close_v2(IntPtr db);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr sqlite3_errmsg(IntPtr db);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_exec(IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, IntPtr callback, IntPtr arg, out IntPtr error);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_prepare_v2(IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int bytes, out IntPtr statement, IntPtr tail);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_bind_text(IntPtr statement, int index, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, int bytes, IntPtr destructor);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_bind_int64(IntPtr statement, int index, long value);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_step(IntPtr statement);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_reset(IntPtr statement);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_clear_bindings(IntPtr statement);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern int sqlite3_finalize(IntPtr statement);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr sqlite3_column_text(IntPtr statement, int index);
    [DllImport("sqlite3", CallingConvention = CallingConvention.Cdecl)] private static extern long sqlite3_column_int64(IntPtr statement, int index);
}
