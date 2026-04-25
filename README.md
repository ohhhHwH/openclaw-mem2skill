# openclaw 插件


```bash
# 安装依赖
npm install
# 类型检查
npx tsc --noEmit
# 打包为 tgz
npm pack
# 列出已安装插件
openclaw plugins list
# 安装本地插件（目录或 tgz 均可）
openclaw plugins install ./myorg-openclaw-mem2skill-1.0.0.tgz
# 重启 Gateway 网关
openclaw gateway restart
# 卸载插件
openclaw plugins uninstall memory2skill
```