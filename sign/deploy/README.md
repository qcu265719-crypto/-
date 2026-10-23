# 公网 / 跨网络访问部署说明

> 局域网地址（如 `http://10.206.118.146:8080`）**只能在同一局域网内使用**。要让手机用 4G、或甲方在异地打开二维码与后台，必须给服务一个**公网可达的入口**。本文给出三种做法。

---

## 方案一：部署到公网服务器（推荐，稳定）

前提：一台有公网 IP 的服务器（云主机）、一个域名、可申请 HTTPS 证书。

### 1. 安装运行环境

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
node -v    # 应 >= 18
```

### 2. 上传程序

把交付包解压到 `/opt/sign`，确认存在 `server/`、`public/`、`package.json`。

```bash
sudo mkdir -p /opt/sign
sudo chown -R $USER:$USER /opt/sign
cd /opt/sign
node server/index.js     # 先前台试运行，确认 http://127.0.0.1:8080/healthz 正常
```

### 3. 配置 systemd 常驻

```bash
sudo cp deploy/signature-wall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now signature-wall
sudo journalctl -u signature-wall -f
```

### 4. 配置 Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/signature-wall
sudo ln -s /etc/nginx/sites-available/signature-wall /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 申请证书（需域名已解析到本机）
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wall.example.com
```

把 `deploy/nginx.conf` 里的 `wall.example.com` 换成你的域名。

Nginx 必须转发这几个头，程序会自动识别 HTTPS 与域名（二维码、后台地址、WebSocket 都会用外部地址）：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### 5. 后台设置对外地址

打开 `https://wall.example.com/admin`（首次口令 `admin123`，立即修改）：

- 活动配置 →「对外访问地址」：选择“自定义”，填写 `https://wall.example.com`
  （也可填完整 `https://wall.example.com/mobile`，保存时会自动规范化）；
- 保存后，大屏二维码、海报二维码、后台「其他设备访问」二维码都会使用该地址。

### 6. 验证

- 手机用 4G 扫码 → 应能打开 `https://wall.example.com/mobile`；
- 手机提交签名 → 大屏（任意网络）实时上墙；
- 手机/平板打开 `https://wall.example.com/admin` → 能登录后台。

> 安全：公网暴露后务必使用强口令；建议在 Nginx 层限制后台来源：
> ```nginx
> location = /admin { allow 203.0.113.0/24; deny all; proxy_pass http://127.0.0.1:8080; }
> ```
> 或给后台加一层 Basic Auth。

---

## 方案二：内网穿透 / 隧道（无需公网服务器）

适合临时活动、演示：现场机器保持联网，运行隧道客户端，得到一个公网 HTTPS 地址。

### 本包已内置：一键公网（推荐先试这个）

交付包内已带 `tools/cloudflared.exe`，无需下载安装：

1. 双击 `启动签名墙.bat`；
2. 双击 `启动公网访问.bat`；
3. 窗口显示 `https://xxx.trycloudflare.com` 即成功，并已自动写入后台「对外访问地址」；
4. 手机 4G 扫码即可；关闭窗口自动恢复局域网模式。

程序行为：自动登录后台 → 保存原设置 → 写入公网地址 → 退出时恢复；口令若已修改会提示手动填写。
日志在 `data/cloudflared.log`。

> 请按 Ctrl+C 正常结束。若直接关闭窗口，后台可能残留失效地址（打开显示 530）；服务端会自动探测并在约 2–3 分钟后恢复局域网地址，也可在后台清空「对外访问地址」立即恢复。

> 免费快速隧道地址每次重启都会变化，且 Cloudflare 不承诺可用性；正式活动请用固定域名或方案一。

### 手动 Cloudflare Tunnel

```powershell
# 1. 下载 cloudflared.exe 后放到 tools\cloudflared.exe（交付包已含）
# 2. 确保签名墙已启动（8080 端口）
.\tools\cloudflared.exe tunnel --url http://localhost:8080 --protocol http2
```

终端会输出形如 `https://random-words.trycloudflare.com` 的地址。

把它填入后台「对外访问地址」（填域名根地址即可），保存后：
- 二维码变成 `https://random-words.trycloudflare.com/mobile`；
- 其他网络的手机扫码可直接使用；
- 后台地址为 `https://random-words.trycloudflare.com/admin`。

> 免费隧道地址**每次重启都会变化**，活动前重启后必须重新填一次。正式活动建议使用 Cloudflare Named Tunnel + 自己的域名，或方案一。

### ngrok

```powershell
ngrok http 8080
# 得到 https://xxxx.ngrok-free.app
```

同样把该地址填入后台「对外访问地址」。

### frp（自建，适合有国内服务器）

服务端 `frps.ini`：

```ini
[common]
bind_port = 7000
vhost_https_port = 443
```

客户端 `frpc.ini`（现场电脑）：

```ini
[common]
server_addr = your-server.com
server_port = 7000

[signwall]
type = https
local_port = 8080
custom_domains = wall.example.com
```

域名解析到服务器，并配置 HTTPS 证书；后台填 `https://wall.example.com`。

### 花生壳 / 其它国内内网穿透

按服务商指引把本地 `8080` 映射为 HTTPS 域名，然后在后台填写该域名。

---

## 方案三：路由器端口映射（需要宽带有公网 IP）

1. 路由器把外网端口（如 8443）映射到内网 `192.168.x.x:8080`；
2. 用 DDNS 绑定动态公网 IP；
3. 由于浏览器要求 HTTPS 才能调用手机相机，建议仍在前面加一层 Nginx + 证书，或直接使用方案一/二；
4. 后台填写 `https://你的域名`。

> 多数家庭宽带/企业网络没有独立公网 IPv4，或处于运营商 NAT 后，端口映射无效，此时只能用方案一或二。

---

## 三种方案怎么选

| 场景 | 推荐方案 |
| --- | --- |
| 长期运营、甲方有多场活动 | 方案一（公网服务器 + 域名 + HTTPS） |
| 临时活动/演示，现场有网 | 方案二（Cloudflare Tunnel / ngrok） |
| 现场有公网 IP 且能改路由 | 方案三（端口映射 + DDNS） |
| 只有局域网 | 不需要本文，直接用局域网地址 |

---

## 常见问题

**Q：隧道地址变了，二维码还是旧地址？**
A：后台「对外访问地址」重新填写新地址并保存，大屏会自动刷新二维码。

**Q：手机能打开页面，但提交失败？**
A：检查 HTTPS 证书是否有效；Nginx 是否转发了 `X-Forwarded-Proto`；请求体大小限制（`client_max_body_size 12m`）。

**Q：后台能打开但登录后立刻退出？**
A：HTTPS 下 Cookie 带 `Secure`，必须通过 https 访问，不能用 http。

**Q：WebSocket 一直重连？**
A：Nginx 必须转发 `Upgrade` / `Connection` 头，且 `proxy_read_timeout` 不小于 120s。

**Q：公网后台安全吗？**
A：必须改强口令，并建议限制来源 IP 或加 Basic Auth；不要把后台地址公开发布。
