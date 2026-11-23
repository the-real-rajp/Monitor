#Requires -Version 7.0
<#
.SYNOPSIS
    Creates a Monitor proxy VM on Nutanix AHV through Prism Central.

.DESCRIPTION
    Run it with no arguments and it asks for everything, offering numbered
    choices read from Prism Central: cluster, storage container, subnet, how
    the VM gets its IP address, name and size. It then puts the Ubuntu Server
    cloud image in Prism Central (once), creates the VM with the first-boot
    file from the Monitor dashboard (Proxies > Add a proxy > Or run it as a
    VM > Download user-data.yaml) and powers it on.

    Any answer can be given up front as a parameter, which skips that
    question. With every answer given it runs unattended (add -Yes).

    Nothing is installed on this computer. It talks to Prism Central's REST
    API on port 9440.

.EXAMPLE
    ./New-MonitorProxyVM-AHV.ps1

.EXAMPLE
    ./New-MonitorProxyVM-AHV.ps1 -PrismCentral pc.example.com -UserDataPath ./office-user-data.yaml -Cluster PROD-01 -Subnet VLAN20 -IPAddress dhcp -Yes
#>
[CmdletBinding()]
param(
    # Prism Central host name or IP address.
    [string] $PrismCentral,

    # Prism Central login.
    [pscredential] $Credential,

    # The user-data.yaml downloaded from the Monitor dashboard.
    [string] $UserDataPath,

    # Cluster name.
    [string] $Cluster,

    # Storage container name for the VM's disk, or 'default' to let Prism decide.
    [string] $StorageContainer,

    # Subnet (network) name. It must reach the monitored devices.
    [string] $Subnet,

    # 'dhcp', or a fixed address. On a subnet without Nutanix IP management
    # give it with the prefix length, e.g. 192.168.1.50/24, plus -Gateway.
    [string] $IPAddress,
    [string] $Gateway,
    [string[]] $Dns,

    # VM name. Defaults to the hostname in the first-boot file.
    [string] $VMName,

    [int] $Cpu,
    [int] $MemoryGB,
    [int] $DiskGB,

    # Name of the image in Prism Central. Reused when it already exists.
    [string] $ImageName = 'ubuntu-24.04-server-cloudimg',

    [string] $ImageUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',

    # 'upload' downloads the image to this computer and uploads it;
    # 'prism' has Prism Central download it from $ImageUrl itself.
    [ValidateSet('', 'upload', 'prism')] [string] $ImageSource = '',

    # Where the downloaded image is kept on this computer.
    [string] $CacheDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.monitor-proxy'),

    # Verify Prism Central's certificate. By default it is not checked,
    # because Prism Central usually has a self-signed one.
    [switch] $VerifyCertificate,

    # Create the VM but leave it powered off.
    [switch] $NoPowerOn,

    # Do not ask for confirmation before creating the VM.
    [switch] $Yes
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar

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

function Test-IPv4([string] $Text) {
    $parsed = $null
    ($Text -match '^\d{1,3}(\.\d{1,3}){3}$') -and [ipaddress]::TryParse($Text, [ref] $parsed)
}

function Format-GB($Bytes) { if ($Bytes) { '{0:N0} GB' -f ([double] $Bytes / 1GB) } else { '' } }

# --- Prism Central API -----------------------------------------------------

function Get-Prop($Object, [string] $Name) {
    # Property access that tolerates fields a Prism version leaves out.
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name }
}

function Invoke-Prism {
    # $Path is relative to the v3 API unless it starts with a slash.
    param([string] $Method, [string] $Path, $Body, [string] $InFile)
    $uri = if ($Path.StartsWith('/')) { "https://${PrismCentral}:9440$Path" } else { "https://${PrismCentral}:9440/api/nutanix/v3/$Path" }
    $p = @{
        Method               = $Method
        Uri                  = $uri
        Credential           = $Credential
        Authentication       = 'Basic'
        SkipCertificateCheck = (-not $VerifyCertificate)
    }
    if ($InFile) {
        $p.InFile = $InFile
        $p.ContentType = 'application/octet-stream'
    }
    elseif ($null -ne $Body) {
        $p.Body = $Body | ConvertTo-Json -Depth 20
        $p.ContentType = 'application/json'
    }
    try { Invoke-RestMethod @p }
    catch {
        $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { '' }
        throw "Prism Central $Method $Path failed: $($_.Exception.Message) $detail"
    }
}

function Get-PrismList([string] $Kind, [string] $Filter) {
    # Lists every entity of a kind, following pages of 250.
    $all = @()
    $offset = 0
    while ($true) {
        $body = @{ kind = $Kind; length = 250; offset = $offset }
        if ($Filter) { $body.filter = $Filter }
        $page = @(Get-Prop (Invoke-Prism POST "${Kind}s/list" $body) 'entities' | Where-Object { $null -ne $_ })
        $all += $page
        if ($page.Count -lt 250) { break }
        $offset += 250
    }
    $all
}

function Wait-PrismTask([string] $TaskUuid, [string] $What, [int] $TimeoutMinutes = 30) {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $t = Invoke-Prism GET "tasks/$TaskUuid"
        if ($t.status -eq 'SUCCEEDED') { return }
        if ($t.status -in 'FAILED', 'ABORTED') {
            $why = Get-Prop $t 'error_detail'
            if (-not $why) { $why = $t | ConvertTo-Json -Depth 6 -Compress }
            throw "$What failed: $why"
        }
        if ((Get-Date) -gt $deadline) { throw "$What did not finish within $TimeoutMinutes minutes (task $TaskUuid)." }
        Start-Sleep -Seconds 3
    }
}

function Get-TaskUuid($Response) {
    # execution_context.task_uuid is a string on some versions and a list on others.
    @(Get-Prop (Get-Prop $Response.status 'execution_context') 'task_uuid')[0]
}

function Get-StorageContainers([string] $ClusterUuid) {
    # Storage containers are not in the v3 API. Try the v4 API (recent Prism
    # Central), then the "groups" API older versions use. Returns objects with
    # Name, Uuid and FreeBytes; an empty list when neither works.
    $found = @()
    try {
        $r = Invoke-Prism GET '/api/clustermgmt/v4.0/config/storage-containers?$limit=100'
        foreach ($c in @(Get-Prop $r 'data')) {
            if ((Get-Prop $c 'clusterExtId') -eq $ClusterUuid) {
                $found += [pscustomobject]@{ Name = $c.name; Uuid = $c.containerExtId; FreeBytes = $null }
            }
        }
    }
    catch { $found = @() }
    if ($found.Count -gt 0) { return $found }

    try {
        $r = Invoke-Prism POST 'groups' @{
            entity_type             = 'storage_container'
            group_member_count      = 500
            group_member_attributes = @(
                @{ attribute = 'container_name' }, @{ attribute = 'cluster' }, @{ attribute = 'storage.user_free_bytes' })
        }
        foreach ($group in @(Get-Prop $r 'group_results')) {
            foreach ($e in @(Get-Prop $group 'entity_results')) {
                $attrs = @{}
                foreach ($d in @(Get-Prop $e 'data')) {
                    $first = @(Get-Prop $d 'values')[0]
                    $attrs[$d.name] = @(Get-Prop $first 'values')[0]
                }
                if ($attrs['container_name'] -and (-not $attrs['cluster'] -or $attrs['cluster'] -eq $ClusterUuid)) {
                    $found += [pscustomobject]@{ Name = $attrs['container_name']; Uuid = $e.entity_id; FreeBytes = $attrs['storage.user_free_bytes'] }
                }
            }
        }
    }
    catch { $found = @() }
    $found
}

# --- First-boot file helpers -----------------------------------------------

function Add-StaticNetwork([string] $UserData, [string] $Cidr, [string] $GatewayIp, [string[]] $DnsServers) {
    # A subnet without Nutanix IP management cannot hand the VM an address, so
    # the address goes into the first-boot file as a netplan configuration.
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

function Get-UbuntuImage([string] $Url, [string] $Dir) {
    # Downloads the image once and checks it against Ubuntu's published SHA-256.
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
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
    Invoke-WebRequest -Uri $Url -OutFile "$file.part"
    if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash -ine $expected) {
        Remove-Item "$file.part" -Force
        throw 'The downloaded image does not match the published checksum. Run again to retry.'
    }
    Move-Item "$file.part" $file -Force
    $file
}

# ===========================================================================

Write-Host ''
Write-Host 'Monitor proxy VM for Nutanix AHV' -ForegroundColor Green
Write-Host 'Answer the questions; press Enter to accept a value shown in [brackets].'

# --- Prism Central ---------------------------------------------------------

Write-Step 'Connect to Prism Central'
while (-not $PrismCentral) { $PrismCentral = Read-Answer 'Prism Central address (name or IP)' '' }
$PrismCentral = $PrismCentral -replace '^https?://', '' -replace '[:/].*$', ''

$clusters = $null
for ($attempt = 1; $null -eq $clusters; $attempt++) {
    if (-not $Credential) { $Credential = Get-Credential -Message "Prism Central login for $PrismCentral" }
    try {
        # Prism Central lists itself as a cluster too; leave that one out.
        $clusters = @(Get-PrismList cluster | Where-Object {
                @(Get-Prop (Get-Prop $_.status.resources 'config') 'service_list') -notcontains 'PRISM_CENTRAL' })
    }
    catch {
        if ("$_" -match '401|Unauthorized|AUTHENTICATION' -and $attempt -lt 3) {
            Write-Problem 'That user name or password was not accepted. Try again.'
            $Credential = $null
        }
        else { throw }
    }
}
if ($clusters.Count -eq 0) { throw 'Prism Central reports no registered clusters.' }
Write-Info "Connected. $($clusters.Count) cluster(s) found."

# --- First-boot file -------------------------------------------------------

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

# --- Cluster ---------------------------------------------------------------

Write-Step 'Cluster'
$clusters = @($clusters | Sort-Object { $_.status.name })
$clusterEntity = $null
if ($Cluster) {
    $clusterEntity = $clusters | Where-Object { $_.status.name -eq $Cluster } | Select-Object -First 1
    if (-not $clusterEntity) { Write-Problem "No cluster named '$Cluster'. Choose one:" }
}
if (-not $clusterEntity) { $clusterEntity = Select-FromMenu -Items $clusters -Label { param($c) $c.status.name } }
$clusterUuid = $clusterEntity.metadata.uuid
Write-Info "Cluster: $($clusterEntity.status.name)"

# --- Storage container -----------------------------------------------------

Write-Step 'Storage container for the VM disk'
$containerChoice = $null   # $null means let Prism decide
if ($StorageContainer -ne 'default') {
    $containers = @(Get-StorageContainers $clusterUuid | Where-Object { $_.Name -ne 'NutanixManagementShare' } | Sort-Object Name)
    if ($containers.Count -eq 0) {
        Write-Problem 'Could not read the list of storage containers from this Prism Central version.'
        Write-Info 'Prism will place the disk on its default container.'
    }
    else {
        if ($StorageContainer) {
            $containerChoice = $containers | Where-Object { $_.Name -eq $StorageContainer } | Select-Object -First 1
            if (-not $containerChoice) { Write-Problem "No storage container named '$StorageContainer'. Choose one:" }
        }
        if (-not $containerChoice) {
            $letPrism = [pscustomobject]@{ Name = 'Let Prism decide'; Uuid = $null; FreeBytes = $null }
            $picked = Select-FromMenu -Items (@($containers) + $letPrism) -Label {
                param($c)
                $free = Format-GB $c.FreeBytes
                if ($free) { "$($c.Name)  ($free free)" } else { $c.Name }
            }
            if ($picked.Uuid) { $containerChoice = $picked }
        }
    }
}
Write-Info "Storage container: $(if ($containerChoice) { $containerChoice.Name } else { 'decided by Prism' })"

# --- Subnet ----------------------------------------------------------------

Write-Step 'Subnet (network)'
function Get-SubnetClusterUuid($S) { Get-Prop (Get-Prop $S.status 'cluster_reference') 'uuid' }
function Get-SubnetIpConfig($S) { Get-Prop $S.status.resources 'ip_config' }
function Format-Subnet($S) {
    $parts = @()
    $vlan = Get-Prop $S.status.resources 'vlan_id'
    if ($null -ne $vlan) { $parts += "VLAN $vlan" }
    $cfg = Get-SubnetIpConfig $S
    if ($cfg) { $parts += "Nutanix-managed IPs $($cfg.subnet_ip)/$($cfg.prefix_length)" } else { $parts += 'no Nutanix IP management' }
    "$($S.status.name)  ($($parts -join ', '))"
}
# Subnets on the chosen cluster, plus overlay subnets that belong to no single cluster.
$subnets = @(Get-PrismList subnet | Where-Object { (Get-SubnetClusterUuid $_) -in @($null, $clusterUuid) } | Sort-Object { $_.status.name })
if ($subnets.Count -eq 0) { throw "Cluster '$($clusterEntity.status.name)' has no subnets. Create one in Prism first." }
$subnetEntity = $null
if ($Subnet) {
    $subnetEntity = $subnets | Where-Object { $_.status.name -eq $Subnet } | Select-Object -First 1
    if (-not $subnetEntity) { Write-Problem "No subnet named '$Subnet' on this cluster. Choose one:" }
}
if (-not $subnetEntity) { $subnetEntity = Select-FromMenu -Items $subnets -Label { param($s) Format-Subnet $s } }
$ipConfig = Get-SubnetIpConfig $subnetEntity
Write-Info "Subnet: $($subnetEntity.status.name)"

# --- IP address ------------------------------------------------------------

Write-Step 'IP address'
$staticIp = $null      # address for the NIC on a Nutanix-managed subnet
$staticCidr = $null    # address/prefix written into the VM on an unmanaged subnet
if (-not $IPAddress) {
    $automatic = if ($ipConfig) { 'Automatic: Nutanix picks a free address from the subnet' } else { 'Automatic: DHCP from your network' }
    $picked = Select-FromMenu -Items @($automatic, 'A fixed address that I type in') -Label { param($x) $x } -Default 1
    $IPAddress = if ($picked -eq $automatic) { 'dhcp' } else { '?' }
}
if ($IPAddress -ne 'dhcp') {
    if ($ipConfig) {
        $candidate = $IPAddress
        while (-not (Test-IPv4 $candidate)) {
            if ($candidate -and $candidate -ne '?') { Write-Problem "'$candidate' is not an IPv4 address." }
            $candidate = Read-Answer "IP address in $($ipConfig.subnet_ip)/$($ipConfig.prefix_length)" ''
        }
        $staticIp = $candidate
    }
    else {
        Write-Info 'This subnet has no Nutanix IP management, so the address is written into the VM.'
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
}
Write-Info "IP address: $(if ($staticIp) { $staticIp } elseif ($staticCidr) { "$staticCidr via $Gateway, DNS $($Dns -join ', ')" } else { 'automatic' })"

# --- Name and size ---------------------------------------------------------

Write-Step 'VM name and size'
while ($true) {
    if (-not $VMName) { $VMName = Read-Answer 'VM name' $defaultName }
    $clash = @(Get-PrismList vm "vm_name==$VMName" | Where-Object { $_.status.name -eq $VMName })
    if ($clash.Count -eq 0) { break }
    Write-Problem "A VM named '$VMName' already exists. Choose another name."
    $VMName = ''
}
function Read-Number([string] $Prompt, [int] $Default, [int] $Min, [int] $Max) {
    while ($true) {
        $n = 0
        if ([int]::TryParse((Read-Answer $Prompt "$Default"), [ref] $n) -and $n -ge $Min -and $n -le $Max) { return $n }
        Write-Problem "Please type a number from $Min to $Max."
    }
}
if (-not $Cpu -and -not $MemoryGB -and -not $DiskGB -and (Read-YesNo 'Use the recommended size: 1 vCPU, 1 GB memory, 10 GB disk?' $true)) {
    $Cpu = 1; $MemoryGB = 1; $DiskGB = 10
}
if (-not $Cpu) { $Cpu = Read-Number 'vCPUs' 1 1 16 }
if (-not $MemoryGB) { $MemoryGB = Read-Number 'Memory in GB' 1 1 64 }
if (-not $DiskGB) { $DiskGB = Read-Number 'Disk in GB (4 or more)' 10 4 500 }
Write-Info "VM: $VMName, $Cpu vCPU, $MemoryGB GB memory, $DiskGB GB disk"

# --- Ubuntu image ----------------------------------------------------------

Write-Step 'Ubuntu image'
$image = Get-PrismList image "name==$ImageName" |
    Where-Object { $_.status.name -eq $ImageName -and (Get-Prop $_.status 'state') -eq 'COMPLETE' } | Select-Object -First 1
if ($image) {
    Write-Info "'$ImageName' is already in Prism Central; it will be reused."
}
elseif (-not $ImageSource) {
    Write-Info "'$ImageName' is not in Prism Central yet. How should it get there?"
    $upload = 'This computer downloads it (about 600 MB) and uploads it to Prism Central'
    $direct = 'Prism Central downloads it from Ubuntu itself (the cluster needs internet access)'
    $ImageSource = if ((Select-FromMenu -Items @($upload, $direct) -Label { param($x) $x } -Default 1) -eq $upload) { 'upload' } else { 'prism' }
}

# --- Confirm ---------------------------------------------------------------

Write-Host ''
Write-Host 'Ready to create:' -ForegroundColor Green
Write-Host "  Prism Central : $PrismCentral"
Write-Host "  Cluster       : $($clusterEntity.status.name)"
Write-Host "  Container     : $(if ($containerChoice) { $containerChoice.Name } else { 'decided by Prism' })"
Write-Host "  Subnet        : $($subnetEntity.status.name)"
Write-Host "  IP address    : $(if ($staticIp) { $staticIp } elseif ($staticCidr) { "$staticCidr, gateway $Gateway, DNS $($Dns -join ', ')" } else { 'automatic' })"
Write-Host "  VM            : $VMName ($Cpu vCPU, $MemoryGB GB memory, $DiskGB GB disk)"
Write-Host "  Image         : $ImageName$(if (-not $image) { " (will be added: $(if ($ImageSource -eq 'prism') { 'Prism Central downloads it' } else { 'uploaded from this computer' }))" })"
Write-Host "  First-boot    : $UserDataPath"
if (-not $Yes -and -not (Read-YesNo 'Create this VM now?' $true)) {
    Write-Host 'Nothing was created.'
    return
}

# --- Image -----------------------------------------------------------------

if ($image) { $imageUuid = $image.metadata.uuid }
else {
    Write-Step 'Add the Ubuntu image to Prism Central'
    $resources = @{
        image_type                 = 'DISK_IMAGE'
        initial_placement_ref_list = @(@{ kind = 'cluster'; uuid = $clusterUuid })
    }
    if ($ImageSource -eq 'prism') { $resources.source_uri = $ImageUrl }
    else { $localImage = Get-UbuntuImage $ImageUrl $CacheDir }
    $created = Invoke-Prism POST 'images' @{
        api_version = '3.1.0'
        metadata    = @{ kind = 'image' }
        spec        = @{ name = $ImageName; description = "Ubuntu Server cloud image for Monitor proxies ($ImageUrl)"; resources = $resources }
    }
    $imageUuid = $created.metadata.uuid
    Wait-PrismTask (Get-TaskUuid $created) 'Creating the image'
    if ($ImageSource -eq 'prism') { Write-Info 'Prism Central is downloading the image ...' }
    else {
        Write-Info 'Uploading the image to Prism Central (this can take several minutes) ...'
        Invoke-Prism PUT "images/$imageUuid/file" -InFile $localImage | Out-Null
    }
    $deadline = (Get-Date).AddMinutes(30)
    while ((Get-Prop (Invoke-Prism GET "images/$imageUuid").status 'state') -ne 'COMPLETE') {
        if ((Get-Date) -gt $deadline) { throw "Image '$ImageName' was not ready after 30 minutes. Check the tasks in Prism Central." }
        Start-Sleep -Seconds 5
    }
    Write-Info 'Image is ready.'
}

# --- The VM ----------------------------------------------------------------

function New-ProxyVm($Container) {
    $disk = @{
        device_properties     = @{ device_type = 'DISK'; disk_address = @{ adapter_type = 'SCSI'; device_index = 0 } }
        data_source_reference = @{ kind = 'image'; uuid = $imageUuid }
        disk_size_mib         = $DiskGB * 1024
    }
    if ($Container) {
        $disk.storage_config = @{ storage_container_reference = @{ kind = 'storage_container'; uuid = $Container.Uuid } }
    }
    $nic = @{ subnet_reference = @{ kind = 'subnet'; uuid = $subnetEntity.metadata.uuid }; is_connected = $true }
    if ($staticIp) { $nic.ip_endpoint_list = @(@{ ip = $staticIp; type = 'ASSIGNED' }) }

    $response = Invoke-Prism POST 'vms' @{
        api_version = '3.1.0'
        metadata    = @{ kind = 'vm' }
        spec        = @{
            name              = $VMName
            description       = 'Monitor proxy: pings local devices and reports to the Monitor website.'
            cluster_reference = @{ kind = 'cluster'; uuid = $clusterUuid }
            resources         = @{
                num_sockets          = $Cpu
                num_vcpus_per_socket = 1
                memory_size_mib      = $MemoryGB * 1024
                power_state          = if ($NoPowerOn) { 'OFF' } else { 'ON' }
                disk_list            = @($disk)
                nic_list             = @($nic)
                # Ubuntu cloud images log to a serial console and can stall at boot without one.
                serial_port_list     = @(@{ index = 0; is_connected = $true })
                guest_customization  = @{
                    cloud_init = @{ user_data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userData)) }
                }
            }
        }
    }
    Wait-PrismTask (Get-TaskUuid $response) "Creating VM '$VMName'" 15
    $response.metadata.uuid
}

Write-Step "Create VM '$VMName'"
try { $vmUuid = New-ProxyVm $containerChoice }
catch {
    if (-not $containerChoice) { throw }
    # Some Prism versions only allow a disk cloned from an image to live where the image does.
    Write-Problem "Prism did not create the VM on container '$($containerChoice.Name)':"
    Write-Problem "$_"
    if ($Yes -or -not (Read-YesNo 'Try again and let Prism decide the container?' $true)) { throw }
    $vmUuid = New-ProxyVm $null
}

if ($NoPowerOn) {
    Write-Host ''
    Write-Host "VM '$VMName' created and left powered off." -ForegroundColor Green
    return
}

$ip = $staticIp
if ($staticCidr) { $ip = ($staticCidr -split '/')[0] }
if (-not $ip) {
    Write-Info 'VM is powered on. Waiting up to 3 minutes for Prism to learn its IP address ...'
    $deadline = (Get-Date).AddMinutes(3)
    while (-not $ip -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
        $nics = @(Get-Prop (Invoke-Prism GET "vms/$vmUuid").status.resources 'nic_list')
        $ip = $nics | ForEach-Object { Get-Prop $_ 'ip_endpoint_list' } | ForEach-Object { Get-Prop $_ 'ip' } |
            Where-Object { $_ } | Select-Object -First 1
    }
}

Write-Host ''
Write-Host "Done. VM '$VMName' is running$(if ($ip) { " at $ip" })." -ForegroundColor Green
if (-not $ip) { Write-Host 'Prism has not reported an IP address yet. That is normal on a DHCP network; the proxy works without you knowing it.' }
Write-Host 'It installs the proxy on first boot. Within a few minutes it should show as online on the Proxies page of the Monitor dashboard.'
