#Requires -Version 7.0
<#
.SYNOPSIS
    Creates a Monitor proxy VM on VMware vSphere through vCenter.

.DESCRIPTION
    Run it with no arguments and it asks for everything, offering numbered
    choices read from vCenter: cluster or host, datastore, network, how the
    VM gets its IP address, folder, name and size. It then downloads the
    Ubuntu Server cloud image as an OVA (once, cached on this computer),
    deploys it with the first-boot file from the Monitor dashboard (Proxies >
    Add a proxy > Or run it as a VM > Download user-data.yaml) and powers it
    on.

    Any answer can be given up front as a parameter, which skips that
    question. With every answer given it runs unattended (add -Yes).

    Needs VMware PowerCLI. If it is missing the script offers to install it
    for the current user.

.EXAMPLE
    ./New-MonitorProxyVM-VMware.ps1

.EXAMPLE
    ./New-MonitorProxyVM-VMware.ps1 -VCenter vcenter.example.com -UserDataPath ./office-user-data.yaml -Cluster Prod -Datastore vsanDatastore -Network 'VM Network' -IPAddress dhcp -Folder none -Cpu 1 -MemoryGB 1 -DiskGB 10 -Yes
#>
[CmdletBinding()]
param(
    # vCenter host name or IP address.
    [string] $VCenter,

    # vCenter login.
    [pscredential] $Credential,

    # The user-data.yaml downloaded from the Monitor dashboard.
    [string] $UserDataPath,

    # Cluster to deploy to. Give this or -VMHost.
    [string] $Cluster,

    # ESXi host to deploy to. Give this or -Cluster.
    [string] $VMHost,

    # Datastore for the VM's disk.
    [string] $Datastore,

    # Port group (network) name. It must reach the monitored devices.
    [string] $Network,

    # 'dhcp', or a fixed address with its prefix length, e.g. 192.168.1.50/24,
    # plus -Gateway.
    [string] $IPAddress,
    [string] $Gateway,
    [string[]] $Dns,

    # VM folder name, or 'none' for the top level.
    [string] $Folder,

    # VM name. Defaults to the hostname in the first-boot file.
    [string] $VMName,

    [int] $Cpu,
    [int] $MemoryGB,
    [int] $DiskGB,

    [string] $OvaUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.ova',

    # Where the downloaded OVA is kept on this computer.
    [string] $CacheDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.monitor-proxy'),

    # Install VMware PowerCLI without asking if it is missing.
    [switch] $InstallPowerCLI,

    # Verify vCenter's certificate. By default it is not checked, because
    # vCenter usually has a self-signed one.
    [switch] $VerifyCertificate,

    # Create the VM but leave it powered off.
    [switch] $NoPowerOn,

    # Do not ask for confirmation before creating the VM.
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'

# --- Asking questions ------------------------------------------------------

$script:stepNumber = 0
function Write-Step([string] $Title) {
    $script:stepNumber++
    Write-Host ''
    Write-Host "Step $($script:stepNumber): $Title" -ForegroundColor Cyan
}

function Write-Info([string] $Message) { Write-Host "  $Message" }

function Write-Problem([string] $Message) { Write-Host "  $Message" -ForegroundColor Yellow }

function Read-Answer([string] $Prompt, [string] $Default) {
    # Returns the trimmed answer, or the default when Enter is pressed.
    $suffix = if ($Default) { " [$Default]" } else { '' }
    $answer = Read-Host "  $Prompt$suffix"
    if ($null -eq $answer) { $answer = '' }
    $answer = $answer.Trim()
    if ($answer) { $answer } else { $Default }
}

function Read-YesNo([string] $Prompt, [bool] $Default = $true) {
    while ($true) {
        $answer = Read-Answer "$Prompt (y/n)" $(if ($Default) { 'y' } else { 'n' })
        if ($answer -match '^(y|yes)$') { return $true }
        if ($answer -match '^(n|no)$') { return $false }
        Write-Problem 'Please answer y or n.'
    }
}

function Select-FromMenu {
    # Prints a numbered list and returns the chosen item.
    param([object[]] $Items, [scriptblock] $Label, [int] $Default = 0)
    for ($i = 0; $i -lt $Items.Count; $i++) {
        Write-Host ('  {0,2}. {1}' -f ($i + 1), (& $Label $Items[$i]))
    }
    if ($Items.Count -eq 1) {
        Write-Info 'Only one choice, using it.'
        return $Items[0]
    }
    while ($true) {
        $answer = Read-Answer "Type a number, 1 to $($Items.Count)" $(if ($Default -gt 0) { "$Default" } else { '' })
        $n = 0
        if ([int]::TryParse($answer, [ref] $n) -and $n -ge 1 -and $n -le $Items.Count) { return $Items[$n - 1] }
        Write-Problem "Please type a number from 1 to $($Items.Count)."
    }
}

function Read-Number([string] $Prompt, [int] $Default, [int] $Min, [int] $Max) {
    while ($true) {
        $n = 0
        if ([int]::TryParse((Read-Answer $Prompt "$Default"), [ref] $n) -and $n -ge $Min -and $n -le $Max) { return $n }
        Write-Problem "Please type a number from $Min to $Max."
    }
}

function Test-IPv4([string] $Text) {
    $parsed = $null
    ($Text -match '^\d{1,3}(\.\d{1,3}){3}$') -and [ipaddress]::TryParse($Text, [ref] $parsed)
}

# --- First-boot file and image helpers -------------------------------------

function Add-StaticNetwork([string] $UserData, [string] $Cidr, [string] $GatewayIp, [string[]] $DnsServers) {
    # vSphere does not hand out addresses itself, so a fixed address goes into
    # the first-boot file as a netplan configuration.
    $netplan = @(
        'network:'
        '  version: 2'
        '  ethernets:'
        '    primary:'
        '      match:'
        '        name: "e*"'
        '      dhcp4: false'
        '      dhcp6: false'
        "      addresses: [$Cidr]"
        '      routes:'
        '        - to: default'
        "          via: $GatewayIp"
        '      nameservers:'
        "        addresses: [$($DnsServers -join ', ')]"
    )
    $files = @(
        '  - path: /etc/netplan/60-monitor-static.yaml'
        '    permissions: "0600"'
        '    content: |'
    ) + ($netplan | ForEach-Object { "      $_" }) + @(
        '  - path: /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg'
        '    content: |'
        '      network: {config: disabled}'
    )
    $commands = @(
        '  - [rm, -f, /etc/netplan/50-cloud-init.yaml]'
        '  - [netplan, apply]'
    )
    $addedFiles = $false
    $addedCommands = $false
    $out = @()
    foreach ($line in (($UserData -replace "`r`n", "`n") -split "`n")) {
        $out += $line
        if (-not $addedFiles -and $line -match '^write_files:\s*$') { $out += $files; $addedFiles = $true }
        elseif (-not $addedCommands -and $line -match '^runcmd:\s*$') { $out += $commands; $addedCommands = $true }
    }
    if (-not $addedFiles) { $out += @('', 'write_files:') + $files }
    if (-not $addedCommands) { $out += @('', 'runcmd:') + $commands }
    $out -join "`n"
}

function Show-TransferProgress([string] $Activity, [long] $Done, [long] $Total, [datetime] $Started) {
    $seconds = [Math]::Max(((Get-Date) - $Started).TotalSeconds, 0.001)
    $rate = $Done / $seconds
    if ($Total -gt 0) {
        $status = '{0:N0} MB of {1:N0} MB  ({2:N1} MB/s)' -f ($Done / 1MB), ($Total / 1MB), ($rate / 1MB)
        $percent = [int] [Math]::Min(100, [Math]::Floor(100 * $Done / $Total))
        $remaining = if ($rate -gt 0) { [int] (($Total - $Done) / $rate) } else { -1 }
        Write-Progress -Activity $Activity -Status $status -PercentComplete $percent -SecondsRemaining $remaining
    }
    else {
        Write-Progress -Activity $Activity -Status ('{0:N0} MB  ({1:N1} MB/s)' -f ($Done / 1MB), ($rate / 1MB))
    }
}

function Save-UrlWithProgress([string] $Url, [string] $OutFile, [string] $Activity) {
    # Downloads a large file with a progress bar.
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void] $response.EnsureSuccessStatusCode()
        $total = [long] ($response.Content.Headers.ContentLength ?? 0)
        $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $target = [System.IO.File]::Create($OutFile)
        try {
            $buffer = [byte[]]::new(1MB)
            $done = [long] 0
            $started = Get-Date
            $shown = $started
            while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $target.Write($buffer, 0, $read)
                $done += $read
                if (((Get-Date) - $shown).TotalMilliseconds -ge 500) {
                    Show-TransferProgress $Activity $done $total $started
                    $shown = Get-Date
                }
            }
        }
        finally { $target.Dispose(); $source.Dispose() }
    }
    finally {
        $client.Dispose()
        Write-Progress -Activity $Activity -Completed
    }
}

function Get-UbuntuImage([string] $Url, [string] $Dir) {
    # Downloads the image once and checks it against Ubuntu's published SHA-256.
    $Dir = (New-Item -ItemType Directory -Force -Path $Dir).FullName   # absolute, for the .NET file calls
    $name = Split-Path $Url -Leaf
    $file = Join-Path $Dir $name
    $sums = (Invoke-WebRequest -Uri (($Url -replace '[^/]+$', '') + 'SHA256SUMS')).Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
    $expected = $null
    foreach ($line in ($sums -split "`n")) {
        if ($line -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))\s*$") { $expected = $Matches[1]; break }
    }
    if (-not $expected) { throw "Ubuntu's SHA256SUMS has no entry for $name." }
    if ((Test-Path $file) -and (Get-FileHash $file -Algorithm SHA256).Hash -ieq $expected) {
        Write-Info "Using the copy already downloaded to $file"
        return $file
    }
    Write-Info "Downloading $name (about 600 MB) to $Dir ..."
    Save-UrlWithProgress $Url "$file.part" "Downloading $name"
    Write-Info "Checking the download against Ubuntu's published checksum ..."
    if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash -ine $expected) {
        Remove-Item "$file.part" -Force
        throw 'The downloaded image does not match the published checksum. Run again to retry.'
    }
    Move-Item "$file.part" $file -Force
    $file
}

# ===========================================================================

Write-Host ''
Write-Host 'Monitor proxy VM for VMware vSphere' -ForegroundColor Green
Write-Host 'Answer the questions; press Enter to accept a value shown in [brackets].'

# --- PowerCLI --------------------------------------------------------------

Write-Step 'VMware PowerCLI'
if (-not (Get-Module -ListAvailable -Name VMware.VimAutomation.Core | Select-Object -First 1)) {
    Write-Info 'PowerCLI is VMware''s PowerShell module; this script needs it to talk to vCenter.'
    if (-not $InstallPowerCLI -and -not (Read-YesNo 'It is not installed. Install it now for your user account? (a few minutes)' $true)) {
        Write-Host 'Nothing was created. To install it yourself: Install-Module VMware.PowerCLI -Scope CurrentUser'
        return
    }
    Write-Info 'Installing VMware PowerCLI ...'
    Install-Module VMware.PowerCLI -Scope CurrentUser -Force -AllowClobber
}
Import-Module VMware.VimAutomation.Core
if (-not $VerifyCertificate) {
    Set-PowerCLIConfiguration -InvalidCertificateAction Ignore -Scope Session -Confirm:$false | Out-Null
}
Write-Info 'PowerCLI is ready.'

# --- vCenter ---------------------------------------------------------------

Write-Step 'Connect to vCenter'
while (-not $VCenter) { $VCenter = Read-Answer 'vCenter address (name or IP)' '' }
$VCenter = $VCenter -replace '^https?://', '' -replace '[:/].*$', ''

$server = $null
for ($attempt = 1; $null -eq $server; $attempt++) {
    if (-not $Credential) { $Credential = Get-Credential -Message "vCenter login for $VCenter" }
    try { $server = Connect-VIServer -Server $VCenter -Credential $Credential -ErrorAction Stop }
    catch {
        if ("$_" -match 'incorrect user name or password|InvalidLogin|Cannot complete login' -and $attempt -lt 3) {
            Write-Problem 'That user name or password was not accepted. Try again.'
            $Credential = $null
        }
        else { throw }
    }
}
Write-Info "Connected to $VCenter."

try {
    # --- First-boot file ---------------------------------------------------

    Write-Step 'First-boot file from the Monitor dashboard'
    while ($true) {
        if (-not $UserDataPath) {
            $here = @(Get-ChildItem -Path . -File -Filter '*user-data*.y*ml' -ErrorAction SilentlyContinue)
            if ($here.Count -gt 0) {
                $choices = @($here | ForEach-Object { $_.FullName }) + 'Type a different path'
                $picked = Select-FromMenu -Items $choices -Label { param($x) $x } -Default 1
                if ($picked -ne 'Type a different path') { $UserDataPath = $picked }
            }
            if (-not $UserDataPath) {
                Write-Info 'In the dashboard: Proxies > Add a proxy > Or run it as a VM > Download user-data.yaml'
                $UserDataPath = (Read-Answer 'Path to the user-data.yaml file' '').Trim('"', "'")
            }
        }
        if ($UserDataPath -and (Test-Path -LiteralPath $UserDataPath -PathType Leaf)) {
            $userData = Get-Content -LiteralPath $UserDataPath -Raw
            if ($userData -match '^#cloud-config') { break }
            Write-Problem "That file does not start with '#cloud-config'. Use the one from 'Download user-data.yaml'."
        }
        elseif ($UserDataPath) { Write-Problem "No file at $UserDataPath" }
        $UserDataPath = ''
    }
    Write-Info "Using $UserDataPath"
    $defaultName = if ($userData -match '(?m)^hostname:\s*(\S+)') { $Matches[1] } else { 'monitor-proxy' }

    # --- Cluster or host ---------------------------------------------------

    Write-Step 'Cluster or host'
    $target = $null   # an object with Kind ('Cluster' or 'Host'), Name and Object
    if ($Cluster) {
        $found = Get-Cluster -Name $Cluster -Server $server -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $target = [pscustomobject]@{ Kind = 'Cluster'; Name = $found.Name; Object = $found } }
        else { Write-Problem "No cluster named '$Cluster'. Choose one:" }
    }
    elseif ($VMHost) {
        $found = Get-VMHost -Name $VMHost -Server $server -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $target = [pscustomobject]@{ Kind = 'Host'; Name = $found.Name; Object = $found } }
        else { Write-Problem "No host named '$VMHost'. Choose one:" }
    }
    if (-not $target) {
        $places = @()
        foreach ($c in @(Get-Cluster -Server $server | Sort-Object Name)) {
            $places += [pscustomobject]@{ Kind = 'Cluster'; Name = $c.Name; Object = $c }
        }
        # Hosts that are not part of a cluster.
        foreach ($h in @(Get-VMHost -Server $server | Sort-Object Name)) {
            if ($h.ExtensionData.Parent.Type -ne 'ClusterComputeResource') {
                $places += [pscustomobject]@{ Kind = 'Host'; Name = $h.Name; Object = $h }
            }
        }
        if ($places.Count -eq 0) { throw 'vCenter reports no clusters or hosts.' }
        $target = Select-FromMenu -Items $places -Label {
            param($p)
            if ($p.Kind -eq 'Cluster') { "Cluster: $($p.Name)" } else { "Host: $($p.Name) (not in a cluster)" }
        }
    }
    if ($target.Kind -eq 'Cluster') {
        # Deploy through the connected host with the most free memory.
        $targetHost = Get-VMHost -Location $target.Object -Server $server | Where-Object { $_.ConnectionState -eq 'Connected' } |
            Sort-Object { $_.MemoryTotalGB - $_.MemoryUsageGB } -Descending | Select-Object -First 1
        if (-not $targetHost) { throw "Cluster '$($target.Name)' has no connected hosts that are out of maintenance mode." }
        Write-Info "Cluster: $($target.Name) (deploying through host $($targetHost.Name))"
    }
    else {
        $targetHost = $target.Object
        Write-Info "Host: $($targetHost.Name)"
    }

    # --- Datastore ---------------------------------------------------------

    Write-Step 'Datastore for the VM disk'
    $datastores = @(Get-Datastore -RelatedObject $targetHost -Server $server | Where-Object { $_.State -eq 'Available' } |
            Sort-Object FreeSpaceGB -Descending)
    if ($datastores.Count -eq 0) { throw "Host $($targetHost.Name) has no available datastores." }
    $datastoreObj = $null
    if ($Datastore) {
        $datastoreObj = $datastores | Where-Object { $_.Name -eq $Datastore } | Select-Object -First 1
        if (-not $datastoreObj) { Write-Problem "No datastore named '$Datastore' on this host. Choose one:" }
    }
    if (-not $datastoreObj) {
        $datastoreObj = Select-FromMenu -Items $datastores -Label {
            param($d) '{0}  ({1:N0} GB free of {2:N0} GB)' -f $d.Name, $d.FreeSpaceGB, $d.CapacityGB
        }
    }
    Write-Info "Datastore: $($datastoreObj.Name)"

    # --- Network -----------------------------------------------------------

    Write-Step 'Network (port group)'
    # Standard and distributed port groups the host can use, without the
    # distributed switches' uplink port groups.
    $networkNames = @()
    $networkRefs = @($targetHost.ExtensionData.Network)
    if ($networkRefs.Count -gt 0) {
        $networkNames = @(Get-View -Id $networkRefs -Property Name, Tag -Server $server |
                Where-Object { -not (@($_.Tag) | Where-Object { $_ -and $_.Key -eq 'SYSTEM/DVS.UPLINKPG' }) } |
                ForEach-Object { $_.Name } | Sort-Object -Unique)
    }
    if ($networkNames.Count -eq 0) { throw "Host $($targetHost.Name) has no networks. Create a port group first." }
    if ($Network -and $networkNames -notcontains $Network) {
        Write-Problem "No network named '$Network' on this host. Choose one:"
        $Network = ''
    }
    if (-not $Network) { $Network = Select-FromMenu -Items $networkNames -Label { param($x) $x } }
    Write-Info "Network: $Network"

    # --- IP address --------------------------------------------------------

    Write-Step 'IP address'
    $staticCidr = $null
    if (-not $IPAddress) {
        $automatic = 'Automatic: DHCP from your network'
        $picked = Select-FromMenu -Items @($automatic, 'Static: A fixed address that I type in') -Label { param($x) $x } -Default 1
        $IPAddress = if ($picked -eq $automatic) { 'dhcp' } else { '?' }
    }
    if ($IPAddress -ne 'dhcp') {
        $candidate = $IPAddress
        while ($true) {
            if ($candidate -match '^(.+)/(\d{1,2})$') {
                $address = $Matches[1]
                $prefix = [int] $Matches[2]
                if ((Test-IPv4 $address) -and $prefix -ge 1 -and $prefix -le 32) { break }
            }
            if ($candidate -and $candidate -ne '?') { Write-Problem "'$candidate' needs the form address/prefix, e.g. 192.168.1.50/24." }
            $candidate = Read-Answer 'IP address with prefix length, e.g. 192.168.1.50/24' ''
        }
        $staticCidr = $candidate
        while (-not (Test-IPv4 $Gateway)) {
            if ($Gateway) { Write-Problem "'$Gateway' is not an IPv4 address." }
            $Gateway = Read-Answer 'Gateway (router) address' ''
        }
        if (-not $Dns) { $Dns = @((Read-Answer 'DNS servers, separated by commas' '1.1.1.1, 8.8.8.8') -split '[,\s]+' | Where-Object { $_ }) }
        $badDns = @($Dns | Where-Object { -not (Test-IPv4 $_) })
        if ($badDns.Count -gt 0) { throw "Not an IPv4 address: $($badDns -join ', ')" }
        $userData = Add-StaticNetwork $userData $staticCidr $Gateway $Dns
    }
    $ipSummary = if ($staticCidr) { "$staticCidr, gateway $Gateway, DNS $($Dns -join ', ')" } else { 'automatic (DHCP)' }
    Write-Info "IP address: $ipSummary"

    # --- Folder ------------------------------------------------------------

    Write-Step 'VM folder'
    $folderObj = $null
    if ($Folder -ne 'none') {
        $datacenter = Get-Datacenter -VMHost $targetHost -Server $server | Select-Object -First 1
        $folders = @(Get-Folder -Type VM -Location $datacenter -Server $server |
                Where-Object { $_.Name -notin 'vm', 'vCLS', 'Discovered virtual machine' } | Sort-Object Name)
        if ($Folder) {
            $folderObj = $folders | Where-Object { $_.Name -eq $Folder } | Select-Object -First 1
            if (-not $folderObj) { Write-Problem "No VM folder named '$Folder'. Choose one:" }
        }
        if (-not $folderObj -and $folders.Count -gt 0) {
            $topLevel = 'No folder (top level of the datacenter)'
            $picked = Select-FromMenu -Items (@($topLevel) + $folders) -Label { param($f) if ($f -is [string]) { $f } else { $f.Name } } -Default 1
            if ($picked -isnot [string]) { $folderObj = $picked }
        }
    }
    $folderSummary = if ($folderObj) { $folderObj.Name } else { 'none (top level)' }
    Write-Info "Folder: $folderSummary"

    # --- Name and size -----------------------------------------------------

    Write-Step 'VM name and size'
    while ($true) {
        if (-not $VMName) { $VMName = Read-Answer 'VM name' $defaultName }
        if (-not (Get-VM -Name $VMName -Server $server -ErrorAction SilentlyContinue)) { break }
        Write-Problem "A VM named '$VMName' already exists. Choose another name."
        $VMName = ''
    }
    if (-not $Cpu -and -not $MemoryGB -and -not $DiskGB -and (Read-YesNo 'Use the recommended size: 1 vCPU, 1 GB memory, 10 GB disk?' $true)) {
        $Cpu = 1; $MemoryGB = 1; $DiskGB = 10
    }
    if (-not $Cpu) { $Cpu = Read-Number 'vCPUs' 1 1 16 }
    if (-not $MemoryGB) { $MemoryGB = Read-Number 'Memory in GB' 1 1 64 }
    if (-not $DiskGB) { $DiskGB = Read-Number 'Disk in GB (10 or more)' 10 10 500 }
    Write-Info "VM: $VMName, $Cpu vCPU, $MemoryGB GB memory, $DiskGB GB disk"

    # --- Confirm -----------------------------------------------------------

    Write-Host ''
    Write-Host 'Ready to create:' -ForegroundColor Green
    Write-Host "  vCenter     : $VCenter"
    Write-Host "  Runs on     : $($target.Kind.ToLower()) $($target.Name)"
    Write-Host "  Datastore   : $($datastoreObj.Name)"
    Write-Host "  Network     : $Network"
    Write-Host "  IP address  : $ipSummary"
    Write-Host "  Folder      : $folderSummary"
    Write-Host "  VM          : $VMName ($Cpu vCPU, $MemoryGB GB memory, $DiskGB GB disk)"
    Write-Host "  First-boot  : $UserDataPath"
    if (-not $Yes -and -not (Read-YesNo 'Create this VM now?' $true)) {
        Write-Host 'Nothing was created.'
        return
    }

    # --- Ubuntu image ------------------------------------------------------

    Write-Step 'Get the Ubuntu image'
    $ova = Get-UbuntuImage $OvaUrl $CacheDir
    Write-Info 'Image is ready.'

    # --- The VM ------------------------------------------------------------

    Write-Step "Create VM '$VMName'"
    # The OVA exposes its settings as OVF properties. Their exact key names are
    # read from the OVA rather than assumed, so a renamed property fails loudly.
    $settings = (Get-OvfConfiguration -Ovf $ova -Server $server).ToHashTable()
    function Set-OvfSetting([string] $Pattern, [string] $Value, [switch] $Required) {
        $keys = @($settings.Keys | Where-Object { $_ -match $Pattern })
        if ($keys.Count -eq 0 -and $Required) {
            throw "The OVA has no setting matching '$Pattern'. Settings found: $(($settings.Keys | Sort-Object) -join ', ')"
        }
        foreach ($k in $keys) { $settings[$k] = $Value }
    }
    Set-OvfSetting '^NetworkMapping\.' $Network -Required
    Set-OvfSetting '(^|\.)user[-_]data$' ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userData))) -Required
    Set-OvfSetting '(^|\.)hostname$' $VMName
    # A fresh instance id makes cloud-init treat every deployment as a first boot.
    Set-OvfSetting '(^|\.)instance[-_]id$' "monitor-$([guid]::NewGuid().ToString('N').Substring(0, 12))"

    Write-Info 'Uploading the image to vSphere (PowerCLI shows the progress; this can take several minutes) ...'
    $import = @{
        Source            = $ova
        OvfConfiguration  = $settings
        Name              = $VMName
        VMHost            = $targetHost
        Datastore         = $datastoreObj
        DiskStorageFormat = 'Thin'
        Server            = $server
    }
    if ($folderObj) { $import.InventoryLocation = $folderObj }
    $vm = Import-VApp @import

    Set-VM -VM $vm -NumCpu $Cpu -MemoryGB $MemoryGB -Confirm:$false | Out-Null
    $disk = Get-HardDisk -VM $vm | Select-Object -First 1
    if ($disk -and $disk.CapacityGB -lt $DiskGB) {
        Set-HardDisk -HardDisk $disk -CapacityGB $DiskGB -Confirm:$false | Out-Null   # cloud-init grows the filesystem on boot
    }
    Write-Info 'VM created.'

    if ($NoPowerOn) {
        Write-Host ''
        Write-Host "VM '$VMName' created and left powered off." -ForegroundColor Green
        return
    }

    Start-VM -VM $vm -Confirm:$false | Out-Null
    $ip = if ($staticCidr) { ($staticCidr -split '/')[0] } else { $null }
    if (-not $ip) {
        Write-Info 'VM is powered on. Waiting up to 3 minutes for its IP address ...'
        $deadline = (Get-Date).AddMinutes(3)
        while (-not $ip -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 10
            $ip = @((Get-VM -Id $vm.Id -Server $server).Guest.IPAddress) | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
        }
    }

    Write-Host ''
    Write-Host "Done. VM '$VMName' is running$(if ($ip) { " at $ip" })." -ForegroundColor Green
    if (-not $ip) { Write-Host 'vCenter has not reported an IP address yet; the proxy works without you knowing it.' }
    Write-Host 'It installs the proxy on first boot. Within a few minutes it should show as online on the Proxies page of the Monitor dashboard.'
}
finally {
    Disconnect-VIServer -Server $server -Confirm:$false -ErrorAction SilentlyContinue
}
