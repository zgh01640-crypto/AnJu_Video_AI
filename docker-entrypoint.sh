#!/bin/sh
# 启动时将环境变量注入到 /usr/share/nginx/html/env-config.js
cat <<EOF > /usr/share/nginx/html/env-config.js
window._ENV_ = {
  OSS_REGION: "${OSS_REGION}",
  OSS_BUCKET: "${OSS_BUCKET}",
  OSS_ACCESS_KEY_ID: "${OSS_ACCESS_KEY_ID}",
  OSS_ACCESS_KEY_SECRET: "${OSS_ACCESS_KEY_SECRET}",
  QWEN_API_KEY: "${QWEN_API_KEY}"
};
EOF
exec nginx -g "daemon off;"
