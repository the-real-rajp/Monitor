#Requires -Version 7.0
<#
.SYNOPSIS
    Creates a Monitor proxy VM on VMware vSphere through vCenter.

.DESCRIPTION
    Downloads the Ubuntu Server cloud image as an OVA (once, cached on this
    computer), deploys it through vCenter, hands it the first-boot file you
    downloaded from the Monitor dashboard (Proxies > Add a proxy > Or run it
    as a VM > Download user-data.yaml) and powers it on.

    Needs VMware PowerCLI. If it is missing the script tells you the one
    command that installs it, or pass -InstallPowerCLI to have it done for you.

.EXAMPLE
    ./New-MonitorProxyVM-VMware.ps1 -VCenter vcenter.example.com -UserDataPath ./office-user-data.yaml -Cluster Prod -Datastore vsanDatastore -Network 'VM Network'

.EXAMPLE
    # A single host instead of a cluster, in a VM folder.
    ./New-MonitorProxyVM-VMware.ps1 -VCenter vcenter.example.com -UserDataPath ./office-user-data.yaml -VMHost esx01.example.com -Datastore datastore1 -Network VLAN20 -Folder Infrastructure
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # vCenter host name or IP address.
    [Parameter(Mandatory)] [string] $VCenter,

    # The user-data.yaml downloaded from the Monitor dashboard.
    [Parameter(Mandatory)] [string] $UserDataPath,

    # Datastore for the VM's disk.
    [Parameter(Mandatory)] [string] $Datastore,

    # Port group (network) name. It must reach the monitored devices.
    [Parameter(Mandatory)] [string] $Network,

    # Cluster to deploy to. Give this or -VMHost.
    [string] $Cluster,

    # ESXi host to deploy to. Give this or -Cluster.
    [string] $VMHost,

    # VM folder name (optional).
    [string] $Folder,

    # VM name. Defaults to the hostname in the first-boot file.
    [string] $VMName,

    # vCenter login. You are prompted when omitted.
    [pscredential] $Credential,

    [int] $Cpu = 1,
    [int] $MemoryGB = 1,
    [int] $DiskGB = 10,

    [string] $OvaUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.ova',

    # Where the downloaded OVA is kept on this computer.
    [string] $CacheDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.monitor-proxy'),

    # Install VMware PowerCLI for the current user if it is missing.
    [switch] $InstallPowerCLI,

    # Accept vCenter's self-signed certificate (this session only).
    [switch] $SkipCertificateCheck,

    # Create the VM but leave it powered off.
    [switch] $NoPowerOn
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

if (-not $Cluster -and -not $VMHost) { throw 'Give -Cluster or -VMHost so the script knows where to put the VM.' }

# --- First-boot file -------------------------------------------------------

$userData = Get-Content -LiteralPath $UserDataPath -Raw
if ($userData -notmatch '^#cloud-config') {
    throw "$UserDataPath does not start with '#cloud-config'. Use the file from the dashboard's 'Download user-data.yaml' button."
}
$userDataB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userData))
if (-not $VMName) {
    $VMName = if ($userData -match '(?m)^hostname:\s*(\S+)') { $Matches[1] } else { 'monitor-proxy' }
}

# --- PowerCLI --------------------------------------------------------------

$powerCli = Get-Module -ListAvailable -Name VMware.VimAutomation.Core | Select-Object -First 1
if (-not $powerCli) {
    if (-not $InstallPowerCLI) {
        throw "VMware PowerCLI is not installed. Run this once, then run the script again:`n`n    Install-Module VMware.PowerCLI -Scope CurrentUser`n`nor add -InstallPowerCLI to have the script do it."
    }
    Write-Step 'Installing VMware PowerCLI for the current user'
    Install-Module VMware.PowerCLI -Scope CurrentUser -Force -AllowClobber
}
Import-Module VMware.VimAutomation.Core
if ($SkipCertificateCheck) {
    Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
}

# --- Ubuntu cloud image ----------------------------------------------------

function Get-UbuntuImage([string] $Url, [string] $Dir) {
    # Downloads the image once and checks it against Ubuntu's published SHA-256.
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $name = Split-Path $Url -Leaf
    $file = Join-Path $Dir $name
    $sums = (Invoke-WebRequest -Uri (($Url -replace '[^/]+$', '') + 'SHA256SUMS')).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $expected = ($sums -split "`n" | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))\s*$" } |
            ForEach-Object { $Matches[1] } | Select-Object -First 1)
    if (-not $expected) { throw "Ubuntu's SHA256SUMS has no entry for $name." }
    if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash -ieq $expected) {
        Write-Host "    using cached $file"
        return $file
    }
    Write-Step "Downloading $name (about 600 MB)"
    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower
    try { Invoke-WebRequest -Uri $Url -OutFile "$file.part" } finally { $ProgressPreference = $previous }
    if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash -ine $expected) {
        Remove-Item "$file.part" -Force
        throw 'The downloaded image does not match the published checksum. Run again to retry.'
    }
    Move-Item "$file.part" $file -Force
    $file
}

$ova = Get-UbuntuImage $OvaUrl $CacheDir

# --- vCenter ---------------------------------------------------------------

if (-not $Credential) { $Credential = Get-Credential -Message "vCenter login for $VCenter" }
Write-Step "Connecting to vCenter $VCenter"
try { $server = Connect-VIServer -Server $VCenter -Credential $Credential }
catch {
    if ($_.Exception.Message -match 'certificate|SSL|TLS' -and -not $SkipCertificateCheck) {
        throw "Could not verify vCenter's certificate. If it is self-signed, run again with -SkipCertificateCheck. ($($_.Exception.Message))"
    }
    throw
}

try {
    if ($VMHost) {
        $targetHost = Get-VMHost -Name $VMHost -Server $server
    }
    else {
        $clusterObj = Get-Cluster -Name $Cluster -Server $server
        $targetHost = $clusterObj | Get-VMHost | Where-Object { $_.ConnectionState -eq 'Connected' } |
            Sort-Object MemoryUsageGB | Select-Object -First 1
        if (-not $targetHost) { throw "Cluster '$Cluster' has no connected hosts." }
    }
    $datastoreObj = Get-Datastore -Name $Datastore -Server $server | Select-Object -First 1
    if (Get-VM -Name $VMName -Server $server -ErrorAction SilentlyContinue) {
        throw "A VM named '$VMName' already exists. Pass a different -VMName, or delete the old VM first."
    }
    Write-Host "    host: $($targetHost.Name)   datastore: $Datastore   network: $Network   VM: $VMName"

    # The OVA exposes its settings as OVF properties. Their exact key names are
    # read from the OVA rather than assumed, so a renamed property fails loudly.
    $settings = (Get-OvfConfiguration -Ovf $ova -Server $server).ToHashTable()
    function Set-OvfSetting([string] $Pattern, [string] $Value, [switch] $Required) {
        $keys = @($settings.Keys | Where-Object { $_ -match $Pattern })
        if (-not $keys -and $Required) {
            throw "The OVA has no setting matching '$Pattern'. Settings found: $(($settings.Keys | Sort-Object) -join ', ')"
        }
        foreach ($k in $keys) { $settings[$k] = $Value }
    }
    Set-OvfSetting '^NetworkMapping\.' $Network -Required
    Set-OvfSetting '(^|\.)user[-_]data$' $userDataB64 -Required
    Set-OvfSetting '(^|\.)hostname$' $VMName
    # A fresh instance id makes cloud-init treat every deployment as a first boot.
    Set-OvfSetting '(^|\.)instance[-_]id$' "monitor-$([guid]::NewGuid().ToString('N').Substring(0, 12))"

    if (-not $PSCmdlet.ShouldProcess($VMName, "Deploy VM on $($targetHost.Name)")) { return }

    Write-Step "Deploying '$VMName' (uploading the OVA; this can take several minutes)"
    $import = @{
        Source            = $ova
        OvfConfiguration  = $settings
        Name              = $VMName
        VMHost            = $targetHost
        Datastore         = $datastoreObj
        DiskStorageFormat = 'Thin'
        Server            = $server
    }
    if ($Folder) { $import.InventoryLocation = Get-Folder -Name $Folder -Type VM -Server $server | Select-Object -First 1 }
    $vm = Import-VApp @import

    Set-VM -VM $vm -NumCpu $Cpu -MemoryGB $MemoryGB -Confirm:$false | Out-Null
    $disk = Get-HardDisk -VM $vm | Select-Object -First 1
    if ($disk -and $disk.CapacityGB -lt $DiskGB) {
        Set-HardDisk -HardDisk $disk -CapacityGB $DiskGB -Confirm:$false | Out-Null   # cloud-init grows the filesystem on boot
    }

    if ($NoPowerOn) {
        Write-Host "VM '$VMName' created and left powered off." -ForegroundColor Green
        return
    }

    Start-VM -VM $vm -Confirm:$false | Out-Null
    Write-Step 'VM is powered on. Waiting up to 3 minutes for its IP address'
    $ip = $null
    $deadline = (Get-Date).AddMinutes(3)
    while (-not $ip -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
        $ip = (Get-VM -Id $vm.Id -Server $server).Guest.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    }

    Write-Host ''
    Write-Host "VM '$VMName' is running$(if ($ip) { " at $ip" })." -ForegroundColor Green
    if (-not $ip) { Write-Host 'vCenter has not reported an IP address yet; the proxy does not need you to know it.' }
    Write-Host 'It installs the proxy on first boot. Within a few minutes it should show as online on the Proxies page of the Monitor dashboard.'
}
finally {
    Disconnect-VIServer -Server $server -Confirm:$false -ErrorAction SilentlyContinue
}
