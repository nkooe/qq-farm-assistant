#!/bin/sh
# Build-time installation into a disposable Docker image. No account data.
set -eu
NAPCAT_VERSION=4.18.41
QQ_VERSION=3.2.34-53644
QQ_ARCH="$(dpkg --print-architecture)"
case "$QQ_ARCH" in amd64|arm64) ;; *) echo 'QQ scan supports amd64/arm64 Linux images only' >&2; exit 1;; esac
QQ_URL="${QQ_LOGIN_DEB_URL:-https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_${QQ_VERSION}_${QQ_ARCH}.deb}"
NAPCAT_URL="${QQ_LOGIN_NAPCAT_URL:-https://github.com/NapNeko/NapCatQQ/releases/download/v${NAPCAT_VERSION}/NapCat.Shell.zip}"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
curl --fail --location --retry 3 --connect-timeout 25 --max-time 600 "$QQ_URL" -o "$work/qq.deb"
curl --fail --location --retry 3 --connect-timeout 25 --max-time 600 "$NAPCAT_URL" -o "$work/napcat.zip"
NAPCAT_SHA="${QQ_LOGIN_NAPCAT_SHA256:-6801f93e533846cea05f4f531874a0e84371ab2331c5585b57cd7e3b869cf96b}"
printf '%s  %s\n' "$NAPCAT_SHA" "$work/napcat.zip" | sha256sum -c -
if [ -n "${QQ_LOGIN_DEB_SHA256:-}" ]; then printf '%s  %s\n' "$QQ_LOGIN_DEB_SHA256" "$work/qq.deb" | sha256sum -c -; fi
# The amd64 official package was checked during integration. ARM64 can provide
# its own checksum via the same build argument.
if [ "$QQ_ARCH" = amd64 ] && [ -z "${QQ_LOGIN_DEB_SHA256:-}" ]; then
  printf '%s  %s\n' '436c65e1dd28422e128a21cbddb5fe4e2e6c079d7f27fec2541e014d38cc336e' "$work/qq.deb" | sha256sum -c -
fi
# dpkg package dependencies provide the matching native runtime libraries.
apt-get update
apt-get install -y --no-install-recommends "$work/qq.deb"
unzip -q "$work/napcat.zip" -d "$work/napcat"
entry="$(find "$work/napcat" -name napcat.mjs -print -quit)"
test -n "$entry"
source_dir="$(dirname "$entry")"
mkdir -p /opt/qq-login/napcat
cp -a "$source_dir/." /opt/qq-login/napcat/
node /app/core/qq-login/patch-napcat.cjs "$entry" /opt/qq-login/napcat/napcat.mjs
node --check /opt/qq-login/napcat/napcat.mjs
cp /opt/QQ/resources/app/package.json /opt/qq-login/package.json
cp /opt/QQ/resources/app/wrapper.node /opt/qq-login/wrapper.node
# QQ's native shared libraries stay beside its original executable/addon.
node - <<'JS'
const fs=require('node:fs');
const p='/opt/QQ/resources/app/package.json';const pkg=JSON.parse(fs.readFileSync(p));
fs.writeFileSync('/opt/qq-login/config.json',JSON.stringify({curVersion:pkg.version,baseVersion:pkg.version,prevVersion:'',onErrorVersions:[]}));
pkg.main='./farm-login.cjs';fs.writeFileSync(p,JSON.stringify(pkg));
fs.copyFileSync('/app/core/qq-login/electron-launcher.cjs','/opt/QQ/resources/app/farm-login.cjs');
JS
cp /app/core/qq-login/licenses/NapCat-LICENSE.txt /opt/qq-login/NapCat-LICENSE.txt
cp /app/core/qq-login/licenses/Node-LICENSE.txt /opt/qq-login/Node-LICENSE.txt
sha256sum "$work/qq.deb" "$work/napcat.zip" > /opt/qq-login/download-checksums.txt
find /opt/qq-login -type f -name '*.log' -delete
