<#
.SYNOPSIS
    Deploy browser extension policies to Microsoft Intune via Graph API.

.DESCRIPTION
    Creates or replaces:
      - Settings Catalog policies (Windows) for Chrome/Edge ExtensionSettings
      - Custom Configuration profiles (macOS) for Chrome/Edge .mobileconfig

    On update: saves group assignments from existing policy, deletes it,
    creates new policy with same name, re-applies assignments.

.PARAMETER ConfigPath
    Folder with exported policy files. Default: current directory.

.PARAMETER PolicyPrefix
    Display name prefix in Intune. Default: "Browser Extension Policy"

.PARAMETER SkipWindows
    Skip Windows Settings Catalog deployment.

.PARAMETER SkipMacOS
    Skip macOS Custom Configuration deployment.

.EXAMPLE
    .\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export
    .\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export -WhatIf
    .\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export -SkipMacOS
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath = ".",
    [string]$PolicyPrefix = "Browser Extension Policy",
    [switch]$SkipWindows,
    [switch]$SkipMacOS
)

$ErrorActionPreference = "Stop"
$base = "https://graph.microsoft.com/beta/deviceManagement"

# ============================================================
# Connect
# ============================================================
Write-Host "`n=== Connecting to Microsoft Graph ===" -ForegroundColor Cyan
try {
    Connect-MgGraph -Scopes @(
        "DeviceManagementConfiguration.ReadWrite.All",
        "DeviceManagementManagedDevices.ReadWrite.All"
    ) -NoWelcome
    $ctx = Get-MgContext
    Write-Host "  Tenant: $($ctx.TenantId)  Account: $($ctx.Account)" -ForegroundColor Green
} catch {
    Write-Error "Install module first: Install-Module Microsoft.Graph -Scope CurrentUser"
    return
}

# ============================================================
# Helpers
# ============================================================

# Find Settings Catalog policy by name, return id or $null
function Find-SCPolicy([string]$Name) {
    $r = Invoke-MgGraphRequest -Method GET `
        -Uri "$base/configurationPolicies?`$filter=name eq '$Name'&`$select=id,name&`$top=5"
    if ($r.value.Count) { return $r.value[0].id }
    $null
}

# Find Device Configuration profile by displayName, return id or $null
function Find-DCProfile([string]$Name) {
    $r = Invoke-MgGraphRequest -Method GET `
        -Uri "$base/deviceConfigurations?`$filter=displayName eq '$Name'&`$select=id,displayName&`$top=5"
    if ($r.value.Count) { return $r.value[0].id }
    $null
}

# Save assignments from a configurationPolicy
function Get-SCAssignments([string]$PolicyId) {
    try {
        $r = Invoke-MgGraphRequest -Method GET -Uri "$base/configurationPolicies('$PolicyId')/assignments"
        return $r.value
    } catch { return @() }
}

# Save assignments from a deviceConfiguration
function Get-DCAssignments([string]$ProfileId) {
    try {
        $r = Invoke-MgGraphRequest -Method GET -Uri "$base/deviceConfigurations/$ProfileId/assignments"
        return $r.value
    } catch { return @() }
}

# Apply assignments to a configurationPolicy
function Set-SCAssignments([string]$PolicyId, $Assignments) {
    if (-not $Assignments -or $Assignments.Count -eq 0) { return }
    $body = @{ assignments = @($Assignments | ForEach-Object {
        @{ target = $_.target }
    })} | ConvertTo-Json -Depth 10
    Invoke-MgGraphRequest -Method POST `
        -Uri "$base/configurationPolicies('$PolicyId')/assign" `
        -Body $body -ContentType "application/json" | Out-Null
    Write-Host "    Restored $($Assignments.Count) assignment(s)" -ForegroundColor DarkGreen
}

# Apply assignments to a deviceConfiguration
function Set-DCAssignments([string]$ProfileId, $Assignments) {
    if (-not $Assignments -or $Assignments.Count -eq 0) { return }
    $body = @{ assignments = @($Assignments | ForEach-Object {
        @{ target = $_.target }
    })} | ConvertTo-Json -Depth 10
    Invoke-MgGraphRequest -Method POST `
        -Uri "$base/deviceConfigurations/$ProfileId/assign" `
        -Body $body -ContentType "application/json" | Out-Null
    Write-Host "    Restored $($Assignments.Count) assignment(s)" -ForegroundColor DarkGreen
}

# ============================================================
# Deploy Windows Settings Catalog
# ============================================================

function Deploy-WindowsPolicy {
    param([string]$Name, [string]$Browser, [string]$JsonContent)

    $defId = switch ($Browser) {
        "chrome" { "google_chrome~policy~extensions_extensionsettings" }
        "edge"   { "device_vendor_msft_policy_config_microsoft_edgev80diff~policy~microsoft_edge~extensions_extensionsettings" }
    }

    $body = @{
        name         = $Name
        description  = "Managed by Extension Policy Manager. Updated $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
        platforms    = "windows10"
        technologies = "mdm"
        roleScopeTagIds = @("0")
        settings     = @(@{
            "@odata.type"   = "#microsoft.graph.deviceManagementConfigurationSetting"
            settingInstance = @{
                "@odata.type"       = "#microsoft.graph.deviceManagementConfigurationSimpleSettingInstance"
                settingDefinitionId = $defId
                simpleSettingValue  = @{
                    "@odata.type" = "#microsoft.graph.deviceManagementConfigurationStringSettingValue"
                    value         = $JsonContent
                }
            }
        })
        templateReference = @{
            templateId = ""
            templateFamily = "none"
        }
    } | ConvertTo-Json -Depth 20

    $existingId = Find-SCPolicy $Name
    $savedAssignments = @()

    if ($existingId) {
        Write-Host "    Existing policy found (id=$existingId)" -ForegroundColor Yellow
        $savedAssignments = Get-SCAssignments $existingId
        if ($PSCmdlet.ShouldProcess($Name, "Delete + recreate Settings Catalog policy")) {
            Invoke-MgGraphRequest -Method DELETE -Uri "$base/configurationPolicies('$existingId')"
            Write-Host "    Deleted old policy" -ForegroundColor DarkGray
        }
    }

    if ($PSCmdlet.ShouldProcess($Name, "Create Settings Catalog policy")) {
        $result = Invoke-MgGraphRequest -Method POST `
            -Uri "$base/configurationPolicies" `
            -Body $body -ContentType "application/json"
        Write-Host "    Created (id=$($result.id))" -ForegroundColor Green
        if ($savedAssignments.Count) {
            Set-SCAssignments $result.id $savedAssignments
        }
    }
}

# ============================================================
# Deploy macOS Custom Configuration
# ============================================================

function Deploy-MacOSProfile {
    param([string]$Name, [string]$FileName, [string]$Content)

    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Content))
    $body = @{
        "@odata.type"   = "#microsoft.graph.macOSCustomConfiguration"
        displayName     = $Name
        description     = "Managed by Extension Policy Manager. Updated $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
        payloadName     = $FileName
        payloadFileName = $FileName
        payload         = $b64
    } | ConvertTo-Json -Depth 10

    $existingId = Find-DCProfile $Name

    if ($existingId) {
        Write-Host "    Existing profile found (id=$existingId)" -ForegroundColor Yellow
        if ($PSCmdlet.ShouldProcess($Name, "Update macOS custom profile payload")) {
            Invoke-MgGraphRequest -Method PATCH `
                -Uri "$base/deviceConfigurations/$existingId" `
                -Body $body -ContentType "application/json" | Out-Null
            Write-Host "    Updated in-place (assignments preserved)" -ForegroundColor Green
        }
    } else {
        if ($PSCmdlet.ShouldProcess($Name, "Create macOS custom profile")) {
            $result = Invoke-MgGraphRequest -Method POST `
                -Uri "$base/deviceConfigurations" `
                -Body $body -ContentType "application/json"
            Write-Host "    Created (id=$($result.id))" -ForegroundColor Green
        }
    }
}

# ============================================================
# Main
# ============================================================

if (-not $SkipWindows) {
    Write-Host "`n=== Windows Settings Catalog ===" -ForegroundColor Cyan
    @(
        @{ File="Windows-Allow-Chrome-Extension.json";  Browser="chrome"; Label="Allowlist Chrome" },
        @{ File="Windows-Allow-Edge-Extension.json";    Browser="edge";   Label="Allowlist Edge" },
        @{ File="Windows-Block-Chrome-Extension.json";  Browser="chrome"; Label="Blocklist Chrome" },
        @{ File="Windows-Block-Edge-Extension.json";    Browser="edge";   Label="Blocklist Edge" }
    ) | ForEach-Object {
        $path = Join-Path $ConfigPath $_.File
        $name = "$PolicyPrefix - $($_.Label)"
        if (Test-Path $path) {
            Write-Host "  $($_.Label)" -ForegroundColor White
            Deploy-WindowsPolicy -Name $name -Browser $_.Browser -JsonContent (Get-Content $path -Raw)
        } else {
            Write-Host "  SKIP $($_.File) — not found" -ForegroundColor DarkGray
        }
    }
}

if (-not $SkipMacOS) {
    Write-Host "`n=== macOS Custom Configuration ===" -ForegroundColor Cyan
    @(
        @{ File="MacOS-Allow-Chrome-Browser-Extension.mobileconfig";  Label="Allowlist Chrome" },
        @{ File="MacOS-Allow-Edge-Browser-Extension.mobileconfig";    Label="Allowlist Edge" },
        @{ File="MacOS-Block-Browser-Extension.mobileconfig";         Label="Blocklist Chrome+Edge" }
    ) | ForEach-Object {
        $path = Join-Path $ConfigPath $_.File
        $name = "$PolicyPrefix - $($_.Label)"
        if (Test-Path $path) {
            Write-Host "  $($_.Label)" -ForegroundColor White
            Deploy-MacOSProfile -Name $name -FileName $_.File -Content (Get-Content $path -Raw)
        } else {
            Write-Host "  SKIP $($_.File) — not found" -ForegroundColor DarkGray
        }
    }
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Windows policies: DELETE old + CREATE new (assignments auto-restored)"
Write-Host "macOS profiles:   PATCH in-place (assignments preserved)"
Write-Host "New policies without assignments — assign in Intune portal.`n"
