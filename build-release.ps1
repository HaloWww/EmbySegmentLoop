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

Compress-Archive -Path "$release\*" -DestinationPath "$PSScriptRoot\Emby.Plugins.SegmentLoop-1.1.1.zip" -Force
