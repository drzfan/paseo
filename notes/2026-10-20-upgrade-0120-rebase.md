# 2026-10-20 升级 0.11.1 → 0.12.0 rebase 复盘（paseo-0120-upgrade 战役）

prod 0.11.1+31补丁（571b9f14d）→ v0.12.0（3acd61204，= 31 补丁重放 + 2 chore）。
锚分支 `prod-0.11.1`@571b9f14d；fork 推送见文末。治理账：`.scratch/paseo-0120-upgrade/`（board/reports/journal/pitfalls）。

## 冲突解法（4 文件，rebase 实停 3 次）

| 文件 | 解法 | 新 hash |
|---|---|---|
| `session.ts` | 手解两语义合并：保上游新增 `sourceAgentId` 字段 + 咱 `activeTurnBehavior ?? "steer"` 默认；另一路 sendPromptToAgent 无冲突干净落 | 7ca3aa741 |
| `agent-prompt.test.ts` | 手解：保上游 parseAgentMessage 结构化断言 + 脚注文本拼进 text 字段 | （64b465df2 重放） |
| `package-lock.json` / `.github/workflows/ci.yml` | `git checkout --ours` 整取上游（rebase 中 ours=新基座） | — |

## desktop-drop（1d04752b0）瘦身

18 文件 +26/−3936 → **仅 package.json 5 行删**（workspaces 去 desktop / scripts 去 dev:desktop 三条 / devDeps 去 electron），其余 17 文件全上游原样 → **9c568f6e8**。此后 package-lock 与 ci.yml 对该补丁永零冲突。

## rebase 伴生伤（git 层静默、build 才暴露）

- `isSystemInjectedEnvelope` 被上游搬进 `agent-messages/index.ts`：import 改路径 amend 进本尊 9d86f6b75→**e1557ac8a**
- mailbox-seam.test.ts 断言过时于上游 c364b16d4（完成判定移 `turn_completed` 流事件）：测试假件补 `emitTurnCompleted()` amend 进 P7-M3 本尊 0759e4c1f→**9d56ad0a5**

## bun 三步实录 + 主树两个新坑（本次最大教训）

worktree（全新装）一切顺利；**主树（npm 存量布局 bun 增量）两个坑**：

1. `node scripts/postinstall-patches.mjs` 直跑 ENOENT——node 无 node_modules/.bin PATH；必须 `npm run postinstall` 或 PATH 注入
2. **sdk hoist 布局致 daemon patch 静默跳过**：脚本 `existsSync('packages/server/node_modules/@opencode-ai/sdk')` 在主树落空（npm 存量全 hoist 到根，bun 增量保留），@opencode-ai/sdk patch 未应用且无报错。处置：root 位置 `PATH=… patch-package` 应用 + grep 实文件验证（`.catch(() => {` 计数）+ 重跑 server build 重打包 bridge
   - **教训：patch 应用状态必须 grep 实文件验证，不信脚本回执（脚本静默跳过不报错）；worktree 验证过 ≠ 主树验证过**
3. 主树 bun install 重生 bun.lock 与 worktree 版有实质差异（workspace 内部依赖 0.10.0→0.12.0 与实况对齐），单独 chore 落 prod：**8318b9047**

## 验收结果（指针）

- 6768 矩阵 8 绿 + 四套件 371/371（F1 修复后）：`.scratch/paseo-0120-upgrade/reports/02-acceptance.md`、`reports/01-f1-testfix.md`
- 手解运行时验证：steer 同 turnId 零打断、sourceAgentId 活到 provider 侧、完成通知链活体过
- pdsh 副产：票 05 opencode 伪 target（b25d742）、票 06 短 id resolve 四命令（b7a233d）

### 02/06 验收补录（2026-10-20 prod 0.12.0 活体）

- 票 06 后置项闭环：`pdsh prod mail --to 7d08`（短 id）→ resolve 打印全 id → `mailbox.push` 回实体 id 无 fallback → 收件人信箱收信原文复现——**短 id 黑洞（F2 主案）在 prod 实测封死**
- serverId 已换 `srv_t32IlmFvEtwn`——手机连接异常重连一次即恢复

## 编排重启插曲

首次 restart 600s 超时：idle agent 的陈留活终端（pbash-01a14a63…-82，/root/developer）堵静默判据（idle agent 不进暂停名单但其 pty 挂着）。处置：kill 该残留终端后重发，静默过、重启成。

## 遗留 / followup

- F4：pi 沙箱源树 `azure.json` 生成数据缺失的应急复制（同版本 dist）——真修 `bun run hydrate-model-data`（需网络），非战役票
- pdsh 短 id 竞态（取列表-发请求间毫秒级归档/删除）与 clean --to/canary/resume 未接 resolve——不立票
- 上游 issue：daemon `mailbox.push` 短 id 静默 `fallback:true` 属产品缺陷——总管战役后报 getpaseo/paseo
- track 完成契约缺「部署型完成」一等豁免（本战役 report-only+硬证据临时口径）——跨战役提案候补
- `postinstall-patches.mjs` 对 patch-package spawn 失败不显式 exit 非 0——小修候补
- APK 不在本战役（用户拍板），app 源码已随 rebase 升级，APK 构建另立战役

## 终态

- prod = **8318b9047**（= upgrade/0.12.0 3acd61204 + bun.lock 对齐 chore）；daemon 0.12.0 running（srv_t32IlmFvEtwn）
- 锚 `prod-0.11.1` = 571b9f14d（本地+fork 双保险）
- 6768 stopped（设施保留）；worktree paseo-test detached @3acd61204
