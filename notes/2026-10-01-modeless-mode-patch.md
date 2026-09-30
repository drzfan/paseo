# 2026-10-01 modeless provider 的 stale mode 补丁（上游 #5377 server 侧）

## 病症

手机 App 给 pi 型 provider（antigravity=extends pi）建 agent 必报：
`Invalid mode 'default' for provider 'antigravity'. Available modes: (none)`

## 网上找到的根源（上游 issue 链）

- App create-form 的 **per-provider 偏好里存 stale modeId**（曾选过/全局默认）
- modeless provider（getAvailableModes() → []）不渲染 mode picker → **UI 清不掉**
- 每次创建带着 stale mode 提交 → daemon 校验 [] 拒绝 → 死锁
- 上游：#4326 已修 App 侧一部分；#4747 open bug（其它入口还漏）；
  **#5377 open PR**（server 侧防御）——本补丁即抄其 server 部分

## 补丁内容（commit fac5b52e3，paseo-test 打样 → 主树 cherry-pick -x）

1. create-agent-mode.ts：`availableModes?.length === 0` 时忽略显式 stale mode
   （返回 undefined，不再 throw）
2. provider-snapshot-manager.ts：`availableModes: entry.modes ?? []` → `entry.modes`
   （保留 undefined=未知/[]=显式无 的语义区分——未知时仍放行不校验）
3. 测试：create-agent-mode.test.ts +1 用例（17/17 过）
   注：provider-snapshot-manager.test.ts 的 21 个 vi.\* fail 在未打补丁基线同样存在
   （bun test 跑 vitest 风格的兼容噪音，须 vitest 才真跑）

## 验证矩阵

- 6768：antigravity/pi + modeId:'default' → create OK
- prod：antigravity（extension 路）+ antigravity-acp（.par 路）双通道 → OK
- 负向：modes 未知的 provider 显式 mode 仍透传（语义未伤）

## 顺带修好的 6768 病

"agent 加载层全挂"实为 quota 报错误判（agent 一直能建）；真病是
structured generation 全空：DEFAULT 名单（haiku/gpt-5.4-mini/…）在 6768
无 provider 可配 → config 一行：`agents.metadataGeneration.providers =
[{provider:"pi", model:"zai-coding-cn/glm-5.3-flash"}]`（zai 是 pi 内部模型
而非 daemon provider——metadataGeneration 要指 pi）

## 升级注意

上游 #5377 若合入，rebase 时与 fac5b52e3 冲突 → 直接奔上游版本弃本地补丁
