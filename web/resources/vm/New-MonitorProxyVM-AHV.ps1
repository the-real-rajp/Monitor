#Requires -Version 7.0
<#
.SYNOPSIS
    Creates a Monitor proxy VM on Nutanix AHV through Prism Central.

.DESCRIPTION
    Downloads the Ubuntu Server cloud image (once, cached on this computer),
    uploads it to the Prism Central image service if it is not there yet, then
    creates and powers on a VM that configures itself from the first-boot file
    you downloaded from the Monitor dashboard (Proxies > Add a proxy > Or run
    it as a VM > Download user-data.yaml).

    Nothing is installed on this computer. It talks to Prism Central's v3 REST
    API on port 9440.

.EXAMPLE
    ./New-MonitorProxyVM-AHV.ps1 -PrismCentral pc.example.com -UserDataPath ./office-user-data.yaml -Cluster PROD-01 -Subnet VLAN20

.EXAMPLE
    # Let Prism Central fetch the image itself instead of uploading it from here.
    ./New-MonitorProxyVM-AHV.ps1 -PrismCentral pc.example.com -UserDataPath ./office-user-data.yaml -Subnet VLAN20 -PrismDownloadsImage
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    # Prism Central host name or IP address.
    [Parameter(Mandatory)] [string] $PrismCentral,

    # The user-data.yaml downloaded from the Monitor dashboard.
    [Parameter(Mandatory)] [string] $UserDataPath,

    # Subnet (network) name the VM connects to. It must reach the monitored devices.
    [Parameter(Mandatory)] [string] $Subnet,

    # Cluster name. Optional when Prism Central manages a single cluster, or
    # when the subnet name exists on only one.
    [string] $Cluster,

    # VM name. Defaults to the hostname in the first-boot file.
    [string] $VMName,

    # Prism Central login. You are prompted when omitted.
    [pscredential] $Credential,

    [int] $Cpu = 1,
    [int] $MemoryGB = 1,
    [int] $DiskGB = 10,

    # Name of the image in Prism Central. Reused when it already exists.
    [string] $ImageName = 'ubuntu-24.04-server-cloudimg',

    [string] $ImageUrl = 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',

    # Where the downloaded image is kept on this computer.
    [string] $CacheDir = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.monitor-proxy'),

    # Have Prism Central download the image from $ImageUrl itself. Needs
    # internet access from the cluster; skips the download and upload here.
    [switch] $PrismDownloadsImage,

    # Accept Prism Central's self-signed certificate.
    [switch] $SkipCertificateCheck,

    # Create the VM but leave it powered off.
    [switch] $NoPowerOn
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far faster without the progress bar

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# --- First-boot file -------------------------------------------------------

$userData = Get-Content -LiteralPath $UserDataPath -Raw
if ($userData -notmatch '^#cloud-config') {
    throw "$UserDataPath does not start with '#cloud-config'. Use the file from the dashboard's 'Download user-data.yaml' button."
}
$userDataB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($userData))
if (-not $VMName) {
    $VMName = if ($userData -match '(?m)^hostname:\s*(\S+)') { $Matches[1] } else { 'monitor-proxy' }
}

# --- Prism Central API -----------------------------------------------------

if (-not $Credential) { $Credential = Get-Credential -Message "Prism Central login for $PrismCentral" }
$base = "https://${PrismCentral}:9440/api/nutanix/v3"

function Invoke-Prism {
    param([string] $Method, [string] $Path, $Body, [string] $InFile)
    $p = @{
        Method               = $Method
        Uri                  = "$base/$Path"
        Credential           = $Credential
        Authentication       = 'Basic'
        SkipCertificateCheck = [bool] $SkipCertificateCheck
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
        if ($_.Exception.Message -match 'certificate|SSL|TLS' -and -not $SkipCertificateCheck) {
            throw "Could not verify Prism Central's certificate. If it is self-signed, run again with -SkipCertificateCheck. ($($_.Exception.Message))"
        }
        throw "Prism Central $Method $Path failed: $($_.Exception.Message) $detail"
    }
}

function Get-Prop($Object, [string] $Name) {
    # Property access that tolerates fields a Prism version leaves out.
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.$Name }
}

function Get-PrismList([string] $Kind, [string] $Filter) {
    $body = @{ kind = $Kind; length = 500 }
    if ($Filter) { $body.filter = $Filter }
    $r = Invoke-Prism POST "${Kind}s/list" $body
    @(Get-Prop $r 'entities')
}

function Get-TaskUuid($Response) {
    # execution_context.task_uuid is a string on some versions and a list on others.
    @(Get-Prop (Get-Prop $Response.status 'execution_context') 'task_uuid')[0]
}

function Wait-PrismTask([string] $TaskUuid, [string] $What, [int] $TimeoutMinutes = 30) {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $t = Invoke-Prism GET "tasks/$TaskUuid"
        switch ($t.status) {
            'SUCCEEDED' { return }
            'FAILED' { throw "$What failed: $($t | ConvertTo-Json -Depth 6 -Compress)" }
            'ABORTED' { throw "$What was aborted." }
        }
        if ((Get-Date) -gt $deadline) { throw "$What did not finish within $TimeoutMinutes minutes (task $TaskUuid)." }
        Start-Sleep -Seconds 3
    }
}

Write-Step "Connecting to Prism Central $PrismCentral"

# Clusters registered to this Prism Central (it lists itself too; skip that).
$clusters = @(Get-PrismList cluster | Where-Object {
        @(Get-Prop (Get-Prop $_.status.resources 'config') 'service_list') -notcontains 'PRISM_CENTRAL' })
if (-not $clusters) { throw 'Prism Central reports no registered clusters.' }

$subnets = @(Get-PrismList subnet "name==$Subnet" | Where-Object { $_.status.name -eq $Subnet })
if (-not $subnets) {
    $known = (Get-PrismList subnet | ForEach-Object { $_.status.name } | Sort-Object -Unique) -join ', '
    throw "No subnet named '$Subnet'. Subnets found: $known"
}

function Get-SubnetClusterUuid($S) { Get-Prop (Get-Prop $S.status 'cluster_reference') 'uuid' }

if ($Cluster) {
    $target = @($clusters | Where-Object { $_.status.name -eq $Cluster })
    if (-not $target) { throw "No cluster named '$Cluster'. Clusters found: $(($clusters.status.name) -join ', ')" }
    $clusterEntity = $target[0]
    $onCluster = @($subnets | Where-Object { (Get-SubnetClusterUuid $_) -in @($null, $clusterEntity.metadata.uuid) })
    if (-not $onCluster) { throw "Subnet '$Subnet' does not exist on cluster '$Cluster'." }
    $subnetEntity = $onCluster[0]
}
elseif ($subnets.Count -eq 1 -and (Get-SubnetClusterUuid $subnets[0])) {
    $subnetEntity = $subnets[0]
    $clusterEntity = $clusters | Where-Object { $_.metadata.uuid -eq (Get-SubnetClusterUuid $subnetEntity) } | Select-Object -First 1
    if (-not $clusterEntity) { throw "Could not find the cluster that owns subnet '$Subnet'. Pass -Cluster." }
}
elseif ($clusters.Count -eq 1) {
    $clusterEntity = $clusters[0]
    $subnetEntity = $subnets[0]
}
else {
    throw "Subnet '$Subnet' exists on more than one cluster. Pass -Cluster. Clusters found: $(($clusters.status.name) -join ', ')"
}
$clusterUuid = $clusterEntity.metadata.uuid
Write-Host "    cluster: $($clusterEntity.status.name)   subnet: $Subnet   VM: $VMName"

if (@(Get-PrismList vm "vm_name==$VMName" | Where-Object { $_.status.name -eq $VMName })) {
    throw "A VM named '$VMName' already exists. Pass a different -VMName, or delete the old VM first."
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
    Invoke-WebRequest -Uri $Url -OutFile "$file.part"
    if ((Get-FileHash "$file.part" -Algorithm SHA256).Hash -ine $expected) {
        Remove-Item "$file.part" -Force
        throw 'The downloaded image does not match the published checksum. Run again to retry.'
    }
    Move-Item "$file.part" $file -Force
    $file
}

$image = Get-PrismList image "name==$ImageName" | Where-Object { $_.status.name -eq $ImageName -and (Get-Prop $_.status 'state') -eq 'COMPLETE' } | Select-Object -First 1
if ($image) {
    Write-Step "Image '$ImageName' is already in Prism Central"
    $imageUuid = $image.metadata.uuid
}
elseif ($PSCmdlet.ShouldProcess($ImageName, 'Add image to Prism Central')) {
    $resources = @{
        image_type                 = 'DISK_IMAGE'
        initial_placement_ref_list = @(@{ kind = 'cluster'; uuid = $clusterUuid })
    }
    if ($PrismDownloadsImage) {
        Write-Step "Asking Prism Central to download '$ImageName'"
        $resources.source_uri = $ImageUrl
    }
    else {
        $localImage = Get-UbuntuImage $ImageUrl $CacheDir
    }
    $created = Invoke-Prism POST 'images' @{
        api_version = '3.1.0'
        metadata    = @{ kind = 'image' }
        spec        = @{ name = $ImageName; description = "Ubuntu Server cloud image for Monitor proxies ($ImageUrl)"; resources = $resources }
    }
    $imageUuid = $created.metadata.uuid
    Wait-PrismTask (Get-TaskUuid $created) 'Creating the image'
    if (-not $PrismDownloadsImage) {
        Write-Step "Uploading the image to Prism Central (this can take several minutes)"
        Invoke-Prism PUT "images/$imageUuid/file" -InFile $localImage | Out-Null
    }
    $deadline = (Get-Date).AddMinutes(30)
    while ((Get-Prop (Invoke-Prism GET "images/$imageUuid").status 'state') -ne 'COMPLETE') {
        if ((Get-Date) -gt $deadline) { throw "Image '$ImageName' was not ready after 30 minutes. Check Prism Central's tasks." }
        Start-Sleep -Seconds 5
    }
}

# --- The VM ----------------------------------------------------------------

if (-not $PSCmdlet.ShouldProcess($VMName, "Create VM on $($clusterEntity.status.name)")) { return }

Write-Step "Creating VM '$VMName'"
$vm = Invoke-Prism POST 'vms' @{
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
            disk_list            = @(@{
                    device_properties     = @{ device_type = 'DISK'; disk_address = @{ adapter_type = 'SCSI'; device_index = 0 } }
                    data_source_reference = @{ kind = 'image'; uuid = $imageUuid }
                    disk_size_mib         = $DiskGB * 1024
                })
            nic_list             = @(@{ subnet_reference = @{ kind = 'subnet'; uuid = $subnetEntity.metadata.uuid }; is_connected = $true })
            # Ubuntu cloud images log to a serial console and can stall at boot without one.
            serial_port_list     = @(@{ index = 0; is_connected = $true })
            guest_customization  = @{ cloud_init = @{ user_data = $userDataB64 } }
        }
    }
}
$vmUuid = $vm.metadata.uuid
Wait-PrismTask (Get-TaskUuid $vm) "Creating VM '$VMName'" 10

if ($NoPowerOn) {
    Write-Host "VM '$VMName' created and left powered off." -ForegroundColor Green
    return
}

Write-Step 'VM is powered on. Waiting up to 3 minutes for Prism to learn its IP address'
$ip = $null
$deadline = (Get-Date).AddMinutes(3)
while (-not $ip -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $nics = @(Get-Prop (Invoke-Prism GET "vms/$vmUuid").status.resources 'nic_list')
    $ip = $nics | ForEach-Object { Get-Prop $_ 'ip_endpoint_list' } |
        ForEach-Object { Get-Prop $_ 'ip' } | Where-Object { $_ } | Select-Object -First 1
}

Write-Host ''
Write-Host "VM '$VMName' is running$(if ($ip) { " at $ip" })." -ForegroundColor Green
if (-not $ip) { Write-Host 'Prism has not reported an IP address yet (normal on networks without IPAM); the proxy does not need you to know it.' }
Write-Host 'It installs the proxy on first boot. Within a few minutes it should show as online on the Proxies page of the Monitor dashboard.'
