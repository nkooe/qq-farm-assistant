# syntax=docker/dockerfile:1

# ===== Node 构建阶段（安装全量依赖 + 构建前端）=====
FROM node:24-bookworm-slim AS builder

WORKDIR /app

RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json ./core/
COPY web/package.json ./web/

RUN pnpm config set registry https://registry.npmmirror.com/ \
    && pnpm install --frozen-lockfile

COPY core ./core
COPY web ./web
COPY scripts ./scripts
COPY UPDATE_README.md /app/UPDATE_README.md

RUN pnpm build:web

# ===== 应用宝 Go 服务（yyb-go）编译阶段 =====
FROM golang:1.23-alpine AS yyb-builder

WORKDIR /src

# yyb-go 源码已预置到构建上下文根目录的 yyb-go/（服务器无法直连 github.com，故不走 git clone）。
# 保留 ARG 声明以避免 docker-compose 传入 GITHUB_TOKEN 时构建报 "build-arg not defined"。
ARG GITHUB_TOKEN=
COPY yyb-go /src

# 纯 Go 实现（modernc sqlite，无需 CGO），静态编译；使用国内 goproxy 加速依赖拉取
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /src/cmd/yyb-go
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/yyb-go .

# 复制运行时需要的 resource 目录（avatars/qr/templates）
RUN mkdir -p /out/resource && cp -r /src/resource/. /out/resource/

# ===== 运行阶段 =====
FROM node:24-bookworm-slim AS runner

WORKDIR /app/core

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV QQ_LOGIN_ENABLED=1 \
    QQ_LOGIN_COMPONENT_DIR=/app/core/qq-login \
    QQ_LOGIN_RUNTIME_DIR=/opt/qq-login \
    QQ_LOGIN_EXECUTABLE=/opt/QQ/qq \
    QQ_LOGIN_ELECTRON=1 \
    LD_LIBRARY_PATH=/opt/QQ/resources/app/sharp-lib:/opt/QQ/resources/app:/opt/QQ

ARG QQ_LOGIN_DEB_URL=
ARG QQ_LOGIN_DEB_SHA256=
ARG QQ_LOGIN_NAPCAT_URL=
ARG QQ_LOGIN_NAPCAT_SHA256=6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata tini ca-certificates curl unzip xvfb xauth x11-utils \
    libglib2.0-0 libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libx11-xcb1 libxcb-dri3-0 libdrm2 libxkbcommon0 libgbm1 libasound2 \
    libxcomposite1 libxdamage1 libxrandr2 libgtk-3-0 libsecret-1-0 \
    fonts-wqy-zenhei && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# 直接拷贝 builder 全量（含 node_modules），避免 pnpm symlink / 多阶段覆盖坑
COPY --from=builder /app /app

# Install only program files into the image; login profiles are created per scan.
RUN sh /app/core/qq-login/install-linux.sh && \
    rm -rf /var/lib/apt/lists/*

# 应用宝 Go 服务：二进制 + 运行时资源
COPY --from=yyb-builder /out/yyb-go /usr/local/bin/yyb-go
COPY --from=yyb-builder /out/resource /usr/local/share/yyb-go/resource

RUN mkdir -p /usr/local/share/yyb-go/resource/db /app/core/data/logs && \
    chmod -R 755 /usr/local/share/yyb-go /app/core/data

# 单镜像启动脚本（tini 托管）
COPY --from=builder /app/core/docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

VOLUME ["/app/core/data"]
VOLUME ["/usr/local/share/yyb-go/resource/db"]

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node /app/core/docker/healthcheck.js

# tini 作为 PID1 正确转发信号；start.sh 先起 yyb-go（容器内 8450），再起 node（对外 3007）
ENTRYPOINT ["tini", "-s", "--"]
CMD ["/usr/local/bin/start.sh"]
