# VPS Tunnel Deployment

This guide exposes a Mac-local Vera gateway to any network via a VPS relay. The gateway stays on the Mac so CLI accounts (Codex / Claude Code / OpenCode) keep running against the Mac's filesystem; the VPS only forwards HTTPS traffic.

```
Phone (any network) -> VPS:443 (HTTPS, auth) -> tunnel -> Mac:3000 (Vera gateway) -> local CLIs
```

## Prerequisites

- A VPS with a public IP (any small box works; 1 vCPU / 512 MB is enough since it only proxies).
- A domain name you control, with DNS editable.
- The Mac running the Vera gateway (`npm run gateway:start`) and your CLI accounts installed locally.
- Mac stays awake while you expect remote access. Connect it to power and disable automatic sleep (`pmset -a sleep 0` or set "Prevent automatic sleep on power adapter" in System Settings).

## Option A: Cloudflare Tunnel (recommended)

The Mac runs `cloudflared`, which dials out to Cloudflare and exposes `https://vera.example.com` -> `http://127.0.0.1:3000`. No VPS port, no TLS certificate management, auto-reconnect, built-in auth via Cloudflare Access.

### 1. Install cloudflared on the Mac

```sh
brew install cloudflared
cloudflared tunnel login
```

Follow the browser prompt to authorize the domain.

### 2. Create the tunnel

```sh
cloudflared tunnel create vera
```

Note the tunnel UUID and the credentials file path printed (`~/.cloudflared/<UUID>.json`).

### 3. Add a DNS record

```sh
cloudflared tunnel route dns vera vera.example.com
```

### 4. Configure the tunnel

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/you/.cloudflared/<UUID>.json

ingress:
  - hostname: vera.example.com
    service: http://127.0.0.1:3000
    originRequest:
      noTLSVerify: true
      http2Origin: false
      disableChunkedEncoding: false
      connectTimeout: 30s
      keepAliveTimeout: 30s
      keepAliveConnections: 10
      tcpKeepAlive: 30s
  - service: http_status:404
```

`disableChunkedEncoding: false` keeps SSE streaming intact for `agent.activity` and `message.delta` events.

### 5. Protect the endpoint with Cloudflare Access

In the Cloudflare Zero Trust dashboard:

- Access -> Applications -> Add an application -> Self-hosted.
- Application domain: `vera.example.com`.
- Policy: email OTP to your address (or Google/GitHub identity).
- Session duration: e.g. 24 hours.

The phone browser hits `https://vera.example.com`, gets redirected to a Cloudflare login page once per session, then passes through to the Mac gateway.

### 6. Run the tunnel as a Mac service

```sh
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

Logs: `/Library/Logs/com.cloudflare.cloudflared/`.

Logs Rotate. If the tunnel drops it reconnects automatically; the Mac 内 network failure does not require a phone-side change.

### 7. Build the APK against the HTTPS URL

```sh
VITE_GATEWAY_URL=https://vera.example.com npm run build:web
npm run build:apk:debug
cp android/app/build/outputs/apk/debug/app-debug.apk Vera-debug.apk
```

The app's `Setting -> Gateway` still lets you override the URL at runtime if needed, but with the tunnel you should not need to.

## Option B: frp + nginx on the VPS

Use this when you do not want Cloudflare and already control the VPS. The Mac runs `frpc` and dials the VPS; nginx on the VPS terminates TLS and reverse-proxies to the frp tunnel port.

### 1. VPS: install frps

```sh
# Download from https://github.com/fatedier/frp/releases
tar xzf frp_0.61.0_linux_amd64.tar.gz
sudo mv frps /usr/local/bin/
```

`/etc/frp/frps.toml`:

```toml
bindAddr = "127.0.0.1"
bindPort = 7000
auth.token = "long-random-secret"
```

Run with systemd:

```
# /etc/systemd/system/frps.service
[Unit]
Description=frp server
After=network.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now frps
```

### 2. VPS: nginx reverse proxy with TLS

Install nginx and certbot. Get a cert for `vera.example.com`.

`/etc/nginx/sites-available/vera`:

```nginx
server {
    listen 443 ssl http2;
    server_name vera.example.com;

    ssl_certificate /etc/letsencrypt/live/vera.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/vera.example.com/privkey.pem;

    # SSE: do not buffer streaming endpoints.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    # Basic auth in front of the public Vera gateway.
    # Generate with: sudo htpasswd -c /etc/nginx/.htpasswd you
    auth_basic "Vera";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:7001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

Enable, reload, and request the cert:

```sh
sudo ln -s /etc/nginx/sites-available/vera /etc/nginx/sites-enabled/vera
sudo certbot --nginx -d vera.example.com
sudo nginx -t && sudo systemctl reload nginx
```

### 3. Mac: install and run frpc

```sh
brew install frp
```

`~/.frp/frpc.toml`:

```toml
serverAddr = "your-vps-ip"
serverPort = 7000
auth.token = "long-random-secret"

[[proxies]]
name = "vera"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3000
remotePort = 7001
```

Run as a launch agent so it survives logout:

```sh
# ~/Library/LaunchAgents/com.vera.frpc.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vera.frpc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/frpc</string>
    <string>-c</string>
    <string>/Users/you/.frp/frpc.toml</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/frpc.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/frpc.err</string>
</dict>
</plist>
```

```sh
launchctl load -w ~/Library/LaunchAgents/com.vera.frpc.plist
```

### 4. Build the APK

Same as Option A step 7:

```sh
VITE_GATEWAY_URL=https://vera.example.com npm run build:web
npm run build:apk:debug
cp android/app/build/outputs/apk/debug/app-debug.apk Vera-debug.apk
```

## Verify

From the phone on cellular data, or from any machine outside the Mac's LAN, open `https://vera.example.com/api/health`. It should return:

```json
{ "app": "vera", "ok": true, "capabilities": ["bootstrap", "system-status", ...] }
```

Then open `https://vera.example.com` in a browser (or in the APK) and confirm the chat UI loads and a CLI account run produces output.

## Choosing Between Options

- **Cloudflare Tunnel (Option A)**: no TLS to manage, no open VPS ports, no VPS CPU usage, built-in auth. The VPS is only needed if you want to route DNS through it; for a personal tunnel you can skip the VPS entirely and just install cloudflared on the Mac. Best when you want minimum ops overhead.
- **frp + nginx (Option B)**: more control, no third-party in the path, but you manage TLS, auth, and a public VPS endpoint. Best when Cloudflare is blocked or you want all traffic to stay on infrastructure you own.

## Security Notes

- The Vera gateway itself has no request-level auth; it only enforces route permissions internally (see `src/route-policy.js`). Always put TLS + auth (Cloudflare Access, nginx Basic Auth, or an IP allowlist) in front of the public entry point.
- `npm run gateway:verify` only checks the local gateway and static shell; it does not validate the tunnel. Verify the tunnel remotely.
- API keys for API-type accounts live in `~/.vera/secrets.json` on the Mac, not the VPS. No secrets are exposed to or stored on the VPS in either option.

## Troubleshooting

- **Phone cannot connect, but Mac local `curl 127.0.0.1:3000/api/health` works**: tunnel down. On Mac, check `cloudflared` / `frpc` logs and that the process is running. On frp, verify `frps` on the VPS shows the `vera` proxy as online.
- **Connection opens but chat hangs**: nginx buffering still on, or `proxy_read_timeout` too short. Confirm `proxy_buffering off` and increase `proxy_read_timeout`.
- **Activity log appears in big chunks instead of streaming**: same cause; `disableChunkedEncoding` must be `false` (Cloudflare) or nginx buffering off (Option B).
- **Works on WiFi but not cellular**: Cloudflare Access may have a device posture rule, or the carrier intercepts the hostname (rare). Test with `curl -v https://vera.example.com/api/health` from the phone via Termux or a browser dev tool.
- **Mac sleeping kills the tunnel**: `pmset -g assertions` should show `PreventUserIdleSystemSleep`. If not, run `caffeinate -s` alongside the gateway, or set "Prevent automatic sleep on power adapter" in System Settings.