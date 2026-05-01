# 打包目录为 zip（沙盒）

跨平台 + 沙盒示例：把指定目录压缩为 zip，整个跑在 Alpine 容器里。

## 与 host 版本 (`archive-folder`) 的关系

| 项 | host 版本 | 沙盒版本（这个）|
|---|---|---|
| 入口 | macOS `run.sh` (zip), Windows `run.ps1` (Compress-Archive) | 容器内 `run.sh`（Alpine BusyBox sh + zip） |
| 跨平台 | 靠 `platform.windows` 覆盖 | 容器统一为 Linux，host 是什么不影响 |
| 依赖 | 系统自带 | install 时 `apk add zip` |
| 输入访问 | 直接读 host fs | 容器内 ro 挂载在 `/runnerx/in/source_dir` |
| 输出 | zip 直接写到 host 路径 | 写到容器 `/runnerx/out/archive/<filename>`，runnerx 透明搬到 host 用户选的位置 |

## 为什么这个示例适合沙盒

- **输入只读**：源目录被 ro 挂载，脚本无法意外修改它——而打包逻辑本来也只读它。
- **输出可控**：声明了 `outputs[archive]`，runnerx 在 host 临时目录开 rw 挂载点，跑完搬运到用户选的路径。
- **依赖隔离**：宿主机不需要 `zip` 命令，全在 Alpine 里。

## Alpine 镜像选择

`alpine:3.20` 5MB 不到，`apk add zip` 加 200KB 左右。比 `python:slim` 那种几十 MB 的镜像启动也快。

## 注意

- Alpine 用 BusyBox 的 sh，**不是 bash**。脚本里没有 bash 数组、`[[ ]]`、`local` 等扩展语法。
- 改 `run.sh` 后要点一次"安装"重新 commit image，否则容器跑的还是旧版本。
- 卸载会弹窗问要不要同时删 `alpine:3.20` 这个 base image——选"不删"以后再装基于 alpine 的脚本会快很多。
