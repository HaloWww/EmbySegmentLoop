$ErrorActionPreference = 'Stop'

$dotnet = 'T:\dotnet-sdk-8.0.422-win-x64\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) {
    $dotnet = 'dotnet'
}

& $dotnet publish "$PSScriptRoot\EmbySegmentLoop.csproj" -c Release -o "$PSScriptRoot\publish"

$release = Join-Path $PSScriptRoot 'release'
if (Test-Path -LiteralPath $release) {
    Remove-Item -LiteralPath $release -Recurse -Force
}
New-Item -ItemType Directory -Path $release | Out-Null

Copy-Item -LiteralPath "$PSScriptRoot\publish\Emby.Plugins.SegmentLoop.dll" -Destination $release

[xml]$project = Get-Content -LiteralPath "$PSScriptRoot\EmbySegmentLoop.csproj"
$version = [string]$project.Project.PropertyGroup.Version
$packageVersion = $version -replace '\.0$', ''

Compress-Archive `
    -LiteralPath "$release\Emby.Plugins.SegmentLoop.dll" `
    -DestinationPath "$PSScriptRoot\Emby.Plugins.SegmentLoop-$packageVersion.zip" `
    -Force

Set-Content -LiteralPath "$release\VERSION" -Value $version -NoNewline
