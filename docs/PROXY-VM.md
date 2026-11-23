# Running the proxy as a VM (Nutanix AHV or VMware)

The proxy does not need a Raspberry Pi. Any small Linux VM inside the network
will do, and the dashboard gives you a first-boot file so the VM sets itself
up: you never log in to it.

There is no Monitor-specific image to build or keep patched. You use the
stock **Ubuntu Server cloud image** and hand it a short cloud-init file
containing the website URL and the proxy's key. On first boot it downloads
the proxy from this repository's GitHub releases, installs the systemd
service and starts reporting. To deploy another proxy, repeat with another
key; the image is reused.

## What you need

| | |
|---|---|
| VM size | 1 vCPU, 1 GB RAM, the image's default disk (about 3 GB) |
| Network | A VLAN that can ping the devices to be monitored. DHCP is simplest. |
| Outbound | HTTPS to the Monitor website and to `github.com` / `objects.githubusercontent.com` (first boot only, to fetch the binary) |
| Inbound | Nothing |

## 1. Get the first-boot file

In the dashboard: **Proxies › Add a proxy**, name it, then open **Or run it as
a VM** under the key. Use **Copy for AHV**, **Copy base64 for VMware** or
**Download user-data.yaml**. It is shown once, with the key. If you lose it,
**Rotate key** on the proxy shows a fresh one.

The file contains the proxy's key. Anyone with it can post ping results as
that proxy, so treat it like a password. Rotating the key revokes it.

If you want to be able to log in to the VM for troubleshooting, edit the
file before using it and uncomment the `ssh_authorized_keys` or `password`
lines near the top. The login user is `ubuntu`.

## 2. The quick way: a PowerShell script

Two PowerShell 7 scripts in `deploy/vm/` do everything in section 3 for you:
they download the Ubuntu cloud image (once; it is cached in `~/.monitor-proxy`
and checked against Ubuntu's published checksum), put it on the platform,
create the VM with the first-boot file and power it on. Run them from any
Windows, macOS or Linux computer that can reach Prism Central or vCenter.

**Nutanix AHV, through Prism Central:**

```powershell
./New-MonitorProxyVM-AHV.ps1 -PrismCentral pc.example.com -UserDataPath ./office-user-data.yaml -Subnet VLAN20 -SkipCertificateCheck
```

Add `-Cluster NAME` when Prism Central manages several clusters. The image is
uploaded once and reused for later proxies. `-PrismDownloadsImage` makes Prism
Central fetch the image itself instead, which is quicker when the cluster has
internet access.

**VMware, through vCenter** (needs PowerCLI: `Install-Module VMware.PowerCLI -Scope CurrentUser`, or pass `-InstallPowerCLI`):

```powershell
./New-MonitorProxyVM-VMware.ps1 -VCenter vcenter.example.com -UserDataPath ./office-user-data.yaml -Cluster Prod -Datastore vsanDatastore -Network 'VM Network' -SkipCertificateCheck
```

Use `-VMHost` instead of `-Cluster` to pick a host, and `-Folder` for a VM
folder.

Both prompt for the login, default to 1 vCPU, 1 GB and a 10 GB disk
(`-Cpu`, `-MemoryGB`, `-DiskGB`), name the VM after the hostname in the
first-boot file (`-VMName` overrides), and support `-WhatIf`. Drop
`-SkipCertificateCheck` if Prism Central or vCenter has a trusted
certificate. `Get-Help ./New-MonitorProxyVM-AHV.ps1 -Full` lists every option.

Then skip to **Check it**. The manual steps below do the same by hand.

## 3a. Nutanix AHV (by hand)

Once per cluster, add the image:

1. Prism › **Settings › Image Configuration › Upload Image** (Prism Central:
   **Compute & Storage › Images › Add Image**).
2. Image type **Disk**, source URL
   `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img`,
   name `ubuntu-24.04-cloud`.

For each proxy:

1. **Create VM**: 1 vCPU, 1 GB memory.
2. **Add New Disk**: operation **Clone from Image Service**, image
   `ubuntu-24.04-cloud`.
3. **Add New NIC** on the network that reaches the monitored devices.
4. Tick **Custom Script** (Prism Central: **Guest Customization**, script
   type **Cloud-init**, **Custom Script**), choose **Type or paste script**
   and paste the text from **Copy for AHV**.
5. Save and power on.

## 3b. VMware vSphere (vCenter, by hand)

1. **Deploy OVF Template**, URL
   `https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.ova`.
2. Pick the compute, storage and the network that reaches the monitored
   devices.
3. On **Customize template**, paste the text from **Copy base64 for VMware**
   into **Encoded user-data**. Leave the other fields empty.
4. Finish, then set the VM to 1 vCPU and 1 GB if the defaults differ, and
   power on.

The OVA's properties are read through vCenter. On a standalone ESXi host
without vCenter they may not reach the guest; in that case create any Linux
VM, log in, and run the one-line install command the dashboard shows above
the VM section.

To make later proxies quicker, deploy the OVA once without powering it on and
convert it to a template; then **New VM from This Template** and fill in
**Encoded user-data** under **Customize vApp properties**.

## 4. Check it

Within two or three minutes of power-on the proxy shows **online** on the
Proxies page. Then assign devices to it on the Devices page.

If it stays at **never connected**:

- Open the VM console. Cloud-init prints progress there; look for
  `monitor proxy installed` or `monitor proxy setup: attempt N failed`. It
  retries every 30 seconds for 30 minutes, so a late DHCP lease or firewall
  change is picked up without a rebuild.
- If you enabled a login: `sudo cat /var/log/cloud-init-output.log` and
  `journalctl -u monitor-agent -n 50`. `sudo /usr/local/sbin/monitor-proxy-setup`
  re-runs the install.
- A cloud-init file only applies on a VM's first boot. If you pasted the
  wrong thing, delete the VM and create it again rather than editing it.

## Static IP addresses

With DHCP nothing more is needed. For a fixed address on AHV, use a managed
network (IPAM) and assign the address on the NIC. On vSphere, a DHCP
reservation for the VM's MAC address is the simplest route.

## Updates

The Ubuntu image applies security updates to itself (unattended-upgrades is on
by default). To move to a newer proxy release, redeploy the VM with the same
first-boot file, or log in and run `sudo /usr/local/sbin/monitor-proxy-setup`.
