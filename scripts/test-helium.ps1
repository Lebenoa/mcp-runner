param([string]$BrowserPath = 'C:/Program Files/imput/Helium/Application/chrome.exe')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BrowserPath -PathType Leaf)) {
    throw "Helium browser not found: $BrowserPath"
}
$env:MCP_TEST_BROWSER = $BrowserPath
& deno test -A tests/browser_test.ts
exit $LASTEXITCODE
