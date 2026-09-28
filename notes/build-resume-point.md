# 端侧语音 APK 构建：进度与断点（2026-09-24 中午暂停）

## 已完成（全部就绪，只差构建）

- **代码**：fork `drzfan/paseo` 分支 `feature/on-device-voice`（commit 1632a52ba + 后续依赖修复）：
  - `packages/app/src/voice/ondevice/` 10 个模块（loader/models/pcm/sentence-buffer/speech-text/session + 单测）
  - voice-runtime/voice-context/session-context/settings 最小 diff
  - 依赖矩阵对齐：nitro 0.33.9 + unistyles 3.0.24 + @runanywhere 0.20.27（tsgo 零错误、129 测试全绿、lint 绿）
  - GitHub Actions workflow `.github/workflows/ondevice-apk.yml`（cmake 3.30.5 安装步、180min 超时、磁盘监控、minify 关闭）

## 构建战史（9 次尝试全败，死因谱系）

| # | 环境 | 死因 |
|---|---|---|
| 1-3 | GitHub Actions | cmake 3.30.5 缺失 → nitro C++ 模板错误 → 神秘 cancel（bundle 后 3 分钟） |
| 4-6 | GitHub Actions | cancel 三连（现在推断 = dex/R8 内存高峰 OOM 的 runner 侧表现） |
| v1 | VPS 本地 | OOM（skia CXX 编译，7.8G 挤爆） |
| v2 | VPS | cmake 3.30.5 本地没装（已补装） |
| v3 | VPS | daemon 重启 cgroup 级联击杀（nohup 防不了 systemd） |
| v4 | VPS（systemd scope） | 跑到 28 分 47 秒（1119 tasks，bundle 完成）→ scope OOM-kill（dex 阶段内存峰） |

## 下次继续的三个选项

1. **VPS 大 swap + 低堆**：swap 16G + gradle Xmx1536m + 增量重跑（28 分钟进度保留，预计 10-15 分钟到 dex 后重试）——最便宜，成功率中等；
2. **修 Actions**：加 `-PreactNativeArchitectures=arm64-v8a` 之外再拆 task（先 externalNativeBuild 后 assemble 限并发 dex）+ 监控内存——16G runner 大概率能过；
3. **借大机器**：任何 ≥16G 内存的机器（Mac 本地或 CI）跑同一套 workflow。

## 环境备忘

- JDK21: /opt/jdk-21.0.5+11；Android SDK: /opt/android-sdk（NDK 27.1×2 + cmake 3.30.5 齐备）
- 本地 prebuild 产物在 packages/app/android/（v5 可直接 gradle 增量）
- 构建命令模板见 learnings/2026-09-24-tmux-bash-semantics.md 追加节（systemd-run --scope 起法）

## 关联

- 集成设计：`~/research/paseo/learnings/2026-09-24-app-voice-on-device-migration.md`
- RunAnywhere 接入：`~/research/runanywhere-sdks/learnings/2026-09-24-paseo-integration.md`
