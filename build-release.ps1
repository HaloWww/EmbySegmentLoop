param(
    [string]$EmbySystemPath = 'T:\embyserver-win-x64-4.9.5.0\system',
    [string]$DebPath = 'T:\emby-server-deb_4.9.5.0_amd64.deb'
)
$ErrorActionPreference = 'Stop'

$dotnet = 'T:\dotnet-sdk-8.0.422-win-x64\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) {
    $dotnet = 'dotnet'
}

$deb = $DebPath
$linuxDashboard = Join-Path $PSScriptRoot 'linux-dashboard\4.9.5.0'
if (Test-Path -LiteralPath $deb) {
    & python "$PSScriptRoot\build_linux_dashboard.py" $deb --output $linuxDashboard
} else {
    & python "$PSScriptRoot\build_linux_dashboard.py" --from-original --output $linuxDashboard
}
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to generate Linux dashboard files from the original DEB.'
}

& $dotnet publish "$PSScriptRoot\EmbySegmentLoop.csproj" -c Release -o "$PSScriptRoot\publish" "-p:EmbySystemPath=$EmbySystemPath"
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed; release files have not been replaced.' }

$release = Join-Path $PSScriptRoot 'release'
if (Test-Path -LiteralPath $release) {
    if ([IO.Path]::GetFullPath($release) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'release'))) {
        throw 'Release path is outside the expected workspace directory.'
    }
    Remove-Item -LiteralPath $release -Recurse -Force
}
New-Item -ItemType Directory -Path $release | Out-Null

Copy-Item -LiteralPath "$PSScriptRoot\publish\Emby.Plugins.SegmentLoop.dll" -Destination $release

$injectedDashboard = Join-Path $linuxDashboard 'injected\dashboard-ui'
Copy-Item -LiteralPath $injectedDashboard -Destination $release -Recurse

[xml]$project = Get-Content -LiteralPath "$PSScriptRoot\EmbySegmentLoop.csproj"
$version = [string]$project.Project.PropertyGroup.Version
$packageVersion = $version -replace '\.0$', ''

Set-Content -LiteralPath "$release\VERSION" -Value $version -NoNewline

$manifestPath = Join-Path $linuxDashboard 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$dllPath = Join-Path $release 'Emby.Plugins.SegmentLoop.dll'
$manifest.files | Add-Member -NotePropertyName 'release/Emby.Plugins.SegmentLoop.dll' -NotePropertyValue @{
    size = (Get-Item -LiteralPath $dllPath).Length
    sha256 = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash
}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Copy-Item -LiteralPath $manifestPath -Destination $release

Compress-Archive `
    -Path "$release\*" `
    -DestinationPath "$PSScriptRoot\Emby.Plugins.SegmentLoop-$packageVersion.zip" `
    -Force
