# 截下来 · Ubuntu 部署

适用于独立的 Ubuntu 24.04 服务器。包内已有编译好的网页，服务器只需 Docker Engine、Compose 插件、curl 和外网连接。首次启动会从镜像仓库拉取 Python、Caddy，并从 PyPI 安装后端依赖。网页、截图提取和规划助手共用一个网址。

## 1. 准备服务器

登录服务器后检查 Docker。

```bash
sudo docker version
sudo docker compose version
```

如尚未安装，按[Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)的 apt 仓库步骤安装 Docker Engine 和 `docker-compose-plugin`。本包使用 Compose v2 的 `up --wait`。保留现有 SSH 登录端口。公网域名模式还需放通 TCP 80、443；API 的 8000 端口只在容器网络内使用。

## 2. 上传并解包

在 Windows 的项目目录运行下面的命令。将 `user@SERVER` 换成实际的 SSH 用户和服务器地址。如果云平台使用密钥登录，可在 scp、ssh 中添加 `-i 私钥路径`。

```powershell
scp .\output\releases\jiexialai-linux.tar.gz .\output\releases\jiexialai-linux.tar.gz.sha256 user@SERVER:~/
ssh user@SERVER
```

登录 Ubuntu 后运行以下命令。校验应显示 `OK`。

```bash
cd ~
sha256sum -c jiexialai-linux.tar.gz.sha256 &&
  mkdir -p ~/jiexialai &&
  tar -xzf jiexialai-linux.tar.gz -C ~/jiexialai
cd ~/jiexialai
```

## 3. 选一种启动方式

**只有公网 IP，先自己试用。** 在服务器运行：

```bash
sudo bash start.sh local
```

随后在 Windows 新开一个 PowerShell 窗口，保持 SSH 隧道运行。

```powershell
ssh -N -L 18080:127.0.0.1:18080 user@SERVER
```

在本机浏览器打开 `http://127.0.0.1:18080`。这个地址可测试“连接千问”，服务器无需放通 18080。如果本机端口已占用，可把 `-L` 后第一个 18080 改为 18081，然后打开本机 18081。

**有域名，要对外开放。** 将实际子域名的 A 记录指向这台服务器的公网 IPv4，确认 80、443 空闲且公网可达。如果设置了 AAAA 记录，也应指向可达的 IPv6 服务。下面的示例域名需要替换。

```bash
sudo bash start.sh plan.example.com
```

打开 `https://plan.example.com`。Caddy 自动申请和续期证书，证书保存在 Docker 命名卷中。如果服务器端口已由宝塔或其他网站占用，需先协调现有网关，再执行域名模式。若已用 local 自测，可直接在同一目录运行上述域名命令。[Caddy 自动 HTTPS 说明](https://caddyserver.com/docs/automatic-https)

## 4. 验收

1. 运行 `sudo docker compose ps`，确认 api 健康且 web 正在运行。
2. 在浏览器打开同一地址下的 `/api/healthz`，确认返回 JSON。它只验证应用与网关可达，千问 Key 需在页面单独验证。
3. 在个人空间点击「连接千问」，输入北京地域百炼 API Key。用一小段虚构文字测试「提取资料」和「生成方案」。业务调用使用该 Key 的额度。
4. 刷新后检查任务仍在，千问连接应恢复为未连接。个人资料与任务保存在当前浏览器的同一网站地址下；从本机预览、隧道地址或旧域名迁移时，在原地址用「数据管理」导出备份，再在新地址恢复。

网关仅向公网转发健康检查和三个个人千问接口。脚本首次生成独立的网关令牌并保存在服务器 `.env`。真实百炼 Key 由每位用户在页面输入。后端使用单个工作进程，默认最多同时处理两条模型请求。网关的容器 IP 是后端唯一信任的转发来源。

## 更新和排查

- 查看日志用 `sudo docker compose logs --tail=60 api web`。域名刚上线时，可从 web 日志确认 DNS 或证书申请情况。
- 暂停用 `sudo docker compose stop`，恢复用 `sudo docker compose start`。
- 更新时，在 Windows 的项目根目录运行 `python deploy/linux/package.py` 重新生成发布包。首次在新检出目录打包，先运行 `npm --prefix frontend ci`。在服务器新建发布目录解包，复制上一版的 `.env` 到新目录，再运行相同的启动命令。保留旧目录即可用其启动命令回退；Compose 项目名固定，证书卷可复用。
- 若 Docker 报网段重叠，可改用服务器上空闲的私有子网。例如 `sudo env APP_SUBNET=172.29.91.0/28 GATEWAY_IP=172.29.91.2 API_IP=172.29.91.3 bash start.sh local`。之后运行 Compose 时也应使用同样的环境设置。
- 发布包不含 Docker 基础镜像和 Python 安装包。若拉取超时，先检查服务器访问 Docker Hub、PyPI 的网络。千问调用还需要服务器能连接 `dashscope.aliyuncs.com:443`。

本包适合服务器独立预览或托管。按此前提供的参赛要求，正式提交需提供 Qoder Sites 公开作品链接。服务器自测通过后，还应从最终的 Sites 地址单独走通千问验证、资料提取与计划生成。
