# Hosting a Minecraft server with CloudGate

CloudGate puts a Minecraft server on the internet through [playit.gg](https://playit.gg),
without port forwarding and without a public IP. The free playit plan is enough.
Java Edition and Bedrock Edition both work.

You need:

- CloudGate v0.7.1 or newer.
- A Minecraft server that is already running on your network and that CloudGate
  can reach (for example `192.168.1.50:25565`).
- A free playit.gg account.
- Optional: a domain on Cloudflare, if players should join with your own name
  (`mc.example.com`) instead of the free playit address.

## 1. Link playit.gg (once)

1. In CloudGate, open **Playit** in the sidebar and click **Link account**.
2. Click **Connect with playit.gg**. A playit.gg page opens.
3. Log in to playit.gg if asked, and approve CloudGate.
4. Back in CloudGate, the account shows up within a few seconds.

CloudGate now starts the playit agent for this account and creates its playit
tunnel automatically. On playit.gg → Agents the agent is listed as online.

> Pasting an agent secret (**Use an agent secret instead**) still works, but the
> link is easier.

## 2. Add the Minecraft host

Open **Hosts → Add host** and fill in the form:

| Field | What to enter |
|---|---|
| **What are you hosting?** | **Minecraft (Java Edition)** or **Minecraft (Bedrock Edition)**. |
| **Tunnel** | Your playit tunnel (`playit-<account name>`). It exists as soon as the account is linked. |
| **DNS zone (optional)** | Leave empty to use the free playit address. Pick a Cloudflare zone only if players should join with your own domain (Java only; see below). |
| **Public hostname** | See [the next section](#what-goes-into-public-hostname). |
| **Internal IP / host** | Where CloudGate reaches the Minecraft server, for example `192.168.1.50`. See [the notes below](#internal-ip--host). |
| **Port** | The server's port: `25565` for Java, `19132` for Bedrock (unless you changed it in `server.properties`). |

Click **Create & deploy**. CloudGate creates a playit tunnel of type `minecraft-java` or
`minecraft-bedrock` and waits until playit assigns an address. This takes a few
seconds.

### What goes into "Public hostname"?

It depends on whether you picked a DNS zone.

**Without a DNS zone (free playit address).** The field is only a name for the host.
Players never type it. It must look like a hostname (at least one dot) and be
unique in CloudGate, for example `survival.mc.local` or `mc.myserver.net`. CloudGate
also uses it as the tunnel name on playit.gg.

**With a DNS zone (your own domain, Java Edition).** The field is the address
players type in Minecraft, for example `mc.example.com`. It must end with the
zone you picked. CloudGate creates a `_minecraft._tcp` SRV record for it on
Cloudflare, so players connect with just `mc.example.com`, without a port.

## 3. Give players the address

After the deploy, the host shows its address in the **Hosts** list (with a copy
button):

- **Java, free address:** something like `name.tun.ply.gg:20982`. Players can
  also leave out the port (`name.tun.ply.gg`), because playit publishes its own
  SRV record for Minecraft Java tunnels.
- **Java, own domain:** players use your hostname, for example `mc.example.com`.
- **Bedrock:** players enter the address and the port separately in the
  **Servers** tab (Add Server → Server Address + Port). Bedrock cannot read SRV
  records, so the port is always needed.

## Notes

### Internal IP / host

The playit agent runs inside the CloudGate container and connects from there.

- Use the **LAN IP** of the machine running the Minecraft server, for example
  `192.168.1.50`.
- `127.0.0.1` / `localhost` only work if the Minecraft server runs **inside the
  same container**, which is almost never the case. For a server on the same
  machine as CloudGate, use that machine's LAN IP.
- If the Minecraft server runs in Docker on the same Docker network as CloudGate,
  the container name (for example `minecraft`) also works; CloudGate resolves it
  to an IP before it creates the tunnel.

### Free playit plan limits

- 4 TCP and 4 UDP tunnels per account. The **Playit** page shows how many are in
  use. Java uses TCP, Bedrock uses UDP.
- The address is assigned by playit and cannot be chosen. It stays the same as
  long as the host exists.
- Custom domains on playit.gg and dedicated ports need playit Premium. A
  Cloudflare domain through CloudGate's DNS zone field does not.

### Java and Bedrock on one server (Geyser)

Add two hosts that point at the same machine: one **Minecraft (Java Edition)** on
`25565` and one **Minecraft (Bedrock Edition)** on Geyser's port (`19132` by
default).

## Troubleshooting

| Symptom | Fix |
|---|---|
| playit.gg shows the agent as **offline** | Make sure you run v0.7.1 or newer and restart CloudGate once. The agent's log is on the **Tunnels** page (**View logs** on the playit tunnel). |
| The host form says **no playit account linked** | Link one under **Playit** in the sidebar (step 1). |
| The host shows an error mentioning **requires premium** | The free tunnel slots are used up, or the setting needs playit Premium. Delete unused hosts or check the quota on the **Playit** page. |
| The host shows **still assigning an address** | playit was slow to allocate. Click **Retry deploy** on the host after a minute. |
| Players get "Connection refused" or a timeout | Check **Internal IP / host** and **Port**: CloudGate must be able to reach the server at that address from inside its container. |
