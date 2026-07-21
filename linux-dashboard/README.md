# Linux dashboard files

`4.9.5.0/original` contains byte-for-byte files extracted from the official
`emby-server-deb_4.9.5.0_amd64.deb` package.

`4.9.5.0/injected` contains the corresponding generated files with only the
Segment Loop client script and item-page render hook added. These files are
installed by direct overwrite; the NAS does not modify minified Emby files.

Regenerate both trees with:

```powershell
python .\build_linux_dashboard.py T:\emby-server-deb_4.9.5.0_amd64.deb --output .\linux-dashboard\4.9.5.0
```

`manifest.json` records the source package and generated-file SHA-256 values.
