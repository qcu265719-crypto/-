# GitHub 仓库创建文案

> 直接复制下方内容到 GitHub 的 **Description**、**Topics** 与 README 开头即可。

---

## 1. 仓库名建议

| 推荐度 | 名称 | 说明 |
| --- | --- | --- |
| ★★★ | `signature-wall` | 直白、好记、搜索友好 |
| ★★☆ | `ink-signature-wall` | 突出水墨视觉风格 |
| ★★☆ | `shanshui-signature-wall` | 中文品牌"山水留痕"的拼音 |
| ★☆☆ | `scenic-signature-wall` | 强调景区场景 |

---

## 2. 仓库简介（GitHub Description，≤350 字符）

### 推荐（英文，国际访客友好）

```
A zero-dependency Node.js e-signature wall for scenic spots and events: touch handwriting, particle fly-in, QR mobile signing, photo keepsakes, posters, printing, moderation and export. Self-hosted, offline-LAN ready, optional one-click public tunnel.
```

### 中文版

```
面向景区与线下活动的电子签名墙：触摸手写、粒子飞入上墙、手机扫码实时同步、拍照留影、专属海报、打印留念、后台审核与数据导出。零依赖 Node.js，局域网离线可用，支持一键公网访问。
```

### 极简版（适合放 Website 旁的短描述）

英文：`Touch-to-sign wall for events — handwriting, particles, QR mobile sync, posters and admin.`

中文：`触摸即签的电子签名墙：手写上墙、手机扫码、海报打印、后台管理。`

---

## 3. 详细简介（About / README 首段）

### 中文

**山水留痕 · 电子签名墙** 是一套面向旅游景区、展会、年会与婚礼现场的**自托管电子签名墙**。观众在大屏上手写签名，墨迹会被采样成粒子飞入墙中，聚合成一张签名卡；也可以用手机扫码在手写后实时同步上墙。

它把现场需要的环节做成了一个完整闭环：待机动画与往期签名轮播、压感手写、拍照留影、文字留言、1080×1440 专属海报、A5 打印留念，以及带审核、敏感词、数据导出与一键清屏的后台。大屏提供**地球仪 / 星空 / 气泡**三种展示形态，视觉上是水墨山水与金色点缀，适配 1080P 与 4K 触摸屏。

技术上刻意保持**零第三方运行时依赖**：Node.js 原生 HTTP + 自研 RFC 6455 WebSocket、自研二维码编码器、Canvas2D 粒子与 3D 投影，不装数据库、不依赖外网，整个目录拷到现场电脑即可运行；同时提供 Windows 一键脚本（启动、全屏大屏、后台、防火墙、公网隧道）与完整的部署 / 操作 / 接口 / 测试文档。

### English

**Signature Wall** is a self-hosted electronic signature wall for scenic spots, exhibitions, annual galas and weddings. Guests sign on a touchscreen; their ink is sampled into particles that fly into the wall and settle as a signature card. They can also sign on their phone via a QR code, with the result synced to the big screen in real time.

The project covers the whole on-site loop: standby animation and past-signature carousel, pressure-sensitive handwriting, photo keepsake, text message, a 1080×1440 shareable poster, A5 printing, and an admin console with moderation, sensitive-word filtering, CSV/JSON export and one-click clear. The wall renders in three modes — globe, starfield and bubbles — over an ink-wash landscape, tuned for both 1080P and 4K touchscreens.

It is deliberately **dependency-free at runtime**: native Node.js HTTP, a hand-written RFC 6455 WebSocket server, a from-scratch QR encoder, and Canvas2D particles with 3D projection. No database, no internet required — copy the folder to the venue PC and run. Windows one-click scripts (start, kiosk display, admin, firewall, public tunnel) and full deployment / user / API / test docs are included.

---

## 4. GitHub Topics（建议 12–16 个）

```
signature-wall
digital-signature
event-tech
kiosk
touchscreen
handwriting
canvas2d
particle-effects
websocket
nodejs
zero-dependency
qrcode
poster-generator
photo-booth
self-hosted
scenic-spot
```

> 复制时每行一个，GitHub 会自动转成小写标签。

---

## 5. 仓库设置建议

| 项目 | 建议 |
| --- | --- |
| Description | 使用第 2 节的推荐文案 |
| Website | 如有演示地址填上；没有可留空 |
| Topics | 使用第 4 节列表 |
| Social preview | 上传 1280×640 图片（可用 `shots/04-wall-gallery.png` 裁剪，或单独做一张带标题的图） |
| README | 以第 3 节中文简介开头，接功能表、截图、快速开始 |
| Releases | 打 `v1.0.0` 标签，附 `dist/山水留痕-电子签名墙-v1.0.0.zip`（若仓库私有） |
| License | 先确认版权归属，见第 6 节 |

---

## 6. 发布前必读

1. **版权与许可证**
   当前 `package.json` 标注为 `UNLICENSED`，README 写明版权归需求方。若代码属于甲方或含商业交付条款，**请保持仓库 Private**，或先获得书面授权再公开；公开时建议补一个 `LICENSE`（如 MIT / Apache-2.0），并同步修改 `package.json` 的 `license` 字段。

2. **不要提交运行时数据**
   `data/`（含 `db.json`、`media/`、`exports/`、`logs/`、`secret.key`）已在 `.gitignore` 中忽略，请确认没有强制添加。`secret.key` 泄露会导致后台会话可被伪造。

3. **清理演示内容**
   截图与示例数据中的活动名称、场地、人名均为虚构；正式发布前确认没有真实客户信息、真实游客签名或留影。

4. **依赖与体积**
   `tools/cloudflared.exe`（约 53 MB）是 Cloudflare 官方程序（Apache-2.0，已附许可证）。若不想让仓库变大，可将其移出仓库、在 Release 中提供，或只保留 `启动公网访问.bat` 并在文档中给出下载地址。

5. **敏感配置**
   默认口令 `admin123` 仅用于首次登录，请在文档中明确提示修改；不要把任何真实口令写进仓库。

---

## 7. 可选的 Release 说明模板

```markdown
## 山水留痕 · 电子签名墙 v1.0.0

首个完整版本，覆盖现场签名墙的完整闭环。

### 功能
- 大屏压感手写、粒子飞入上墙，地球仪 / 星空 / 气泡三种形态
- 手机扫码 H5 签名，WebSocket 实时同步，弱网暂存补传
- 拍照留影、留言、1080×1440 海报、A5 打印留念
- 后台：审核、敏感词、活动配置、数据导出、一键清屏、系统状态
- 零第三方运行时依赖，局域网离线可用；可选一键公网隧道
- Windows 一键脚本：启动 / 大屏 / 后台 / 防火墙 / 公网访问

### 质量
- 41 个自动化测试（单元 + 接口 + WebSocket + 网络选择）
- 真实浏览器端到端冒烟，覆盖大屏 / 手机 / 后台 / 打印

### 文档
部署文档、操作手册、接口文档、测试报告、公网部署套件
```
