# Emby Linux dashboard files

`4.9.5.0/original` contains byte-for-byte files extracted from
`emby-server-deb_4.9.5.0_amd64.deb`.

`4.9.5.0/injected` contains install-ready copies made from those originals:

- `dashboard-ui/index.html` includes the Segment Loop client script once.
- `dashboard-ui/item/item.js` includes the detail-page render hook once.

Rebuild both trees from the original package:

```powershell
python .\build_linux_dashboard.py T:\emby-server-deb_4.9.5.0_amd64.deb
```

`4.9.5.0/manifest.json` records the source package hash plus every original and
injected file hash. The Linux installer overwrites Emby's dashboard files with
the injected copies instead of modifying files in place.
