$ErrorActionPreference = 'Stop'

$dotnet = 'T:\dotnet-sdk-8.0.422-win-x64\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) {
    $dotnet = 'dotnet'
}

$deb = 'T:\emby-server-deb_4.9.5.0_amd64.deb'
$linuxDashboard = Join-Path $PSScriptRoot 'linux-dashboard\4.9.5.0'
if (-not (Test-Path -LiteralPath $deb)) {
    throw "Official Emby DEB not found: $deb"
}

& python "$PSScriptRoot\build_linux_dashboard.py" $deb --output $linuxDashboard
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to generate Linux dashboard files from the original DEB.'
}

& $dotnet publish "$PSScriptRoot\EmbySegmentLoop.csproj" -c Release -o "$PSScriptRoot\publish"

$release = Join-Path $PSScriptRoot 'release'
if (Test-Path -LiteralPath $release) {
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

Compress-Archive `
    -Path "$release\*" `
    -DestinationPath "$PSScriptRoot\Emby.Plugins.SegmentLoop-$packageVersion.zip" `
    -Force
