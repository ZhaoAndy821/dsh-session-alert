# 人工验收清单（dsh-session-alert）

前置：`node scripts/push.mjs` 已执行；页面已刷新过一次（让 `dsh-hot-plugin-host` 的修复生效）。所有步骤都在你自己的 GUI（http://127.0.0.1:4115）里做，不需要重启 `dsh web`。

## 1. 主链：非当前会话跑完

1. 打开一个**不是你正在看**的会话（或者新建一个），让它跑一段会长一点的任务（例：`先 sleep 30 秒再回答 OK`）。
2. 立刻切回你现在这个会话（让跑任务的那个不是主视图）。
3. 预期：任务结束时约 1 秒内
   - 屏幕顶部中央出现细横幅：「会话「xxx」已完成 · 点击查看」，约 6 秒后淡出；
   - 左侧侧边栏底部（「设置」上方）出现一张卡片：会话名 + 「已完成 · 刚刚」；
   - 同一行会话在侧边栏里的原生绿色圆点也在（本插件不替代它）。
4. 点卡片或横幅 → 切到该会话，卡片与横幅消失（原生事实被清除）。

## 2. 当前会话不打扰

在当前正在看的会话里跑一轮 → 结束时**不应**出现卡片/横幅（与原生行为一致）。

## 3. 系统通知

1. 卡片区出现「开启系统通知」按钮时点一次（浏览器只允许用户手势授权）。
2. 把页面切到别的标签或最小化，再让某个会话跑完。
3. 预期：收到系统通知；点击它 → 窗口回到前台并打开该会话。

## 4. 等待你操作（琥珀色）

让某个非当前会话停在审批 / 计划确认 / 提问上 → 预期出现**琥珀色**卡片与横幅，文案指出在等什么（审批 / 计划确认 / 提问）。回答或取消后，卡片自动消失。

## 5. 收尾聚合

让一个会话在跑完之后还有子代理（或后台任务）在跑 → 预期卡片先显示「收尾中 · N 个子代理 / M 个后台任务」，**横幅与系统通知推迟**到它们全部结束才出现（15 分钟兜底）。

## 6. 刷新不轰炸

直接刷新页面 → 预期没有任何历史通知补发（第一份快照只播种）。

## 7. 关闭与重开

- 卡片右上「×」→ 卡片隐藏；该会话再次完成时会重新出现。
- 点了卡片跳过去 → 卡片消失（因为你要看它了）。

## 8. 卸载

```powershell
node scripts/push.mjs --rm
```

预期：约 1.5 秒内卡片/横幅/样式全部消失，页面其余部分不受影响；`node scripts/push.mjs --status` 里 `known` 不再包含 `dsh-session-alert`。


## 9. 桌面提醒（原生弹窗 / Windows 通知）

前置：`node desktop/cli.mjs install` 已执行、`node desktop/cli.mjs start` 在跑（`status` 里 `pages` 应为 1）。

1. `node desktop/cli.mjs test` → 预期主屏右下角弹出一张置顶卡片（不抢焦点），约 9 秒后自动淡出；鼠标悬停时暂停计时；点右上「×」立即关闭。
2. `node desktop/cli.mjs test --surface toast` → 预期出现署名 **DeepSeek Harness** 的 Windows 通知（带应用图标），并留在操作中心。
3. **原地跳转**：`node desktop/cli.mjs test --session <另一个会话id> --url http://127.0.0.1:4115/ --window-title "DeepSeek Harness"` → 点卡片，预期**当前标签页原地切到该会话**（不新开窗口），并把浏览器窗口提到前台；`node desktop/cli.mjs logs` 里能看到 `card click ... pages=1 delivered=true` 紧跟 `page ack open session=...`。
4. **只在不在前台时弹**：保持在 DSH 页面内（页面有焦点）让某个会话跑完 → 预期不弹桌面卡片；切到别的应用再让另一个会话跑完 → 预期弹出。
5. **服务未启动时的降级**：`node desktop/cli.mjs stop` 后刷新页面 → 侧边栏出现一行「桌面提醒服务未启动（…）」，页面内卡片与横幅不受影响；再 `start` 后约 30 秒内该行消失（或刷新页面）。

## 10. 卸载桌面提醒

```powershell
node desktop/cli.mjs uninstall     # 停服务 + 删自启 + 删 ~/.dsh/desktop-alert
```

预期：`~/.dsh/desktop-alert` 消失、开始菜单「启动」里不再有 `DSH Desktop Alert.lnk`、`http://127.0.0.1:41411/health` 不再响应。

## 回归（DSH 升级后）

```powershell
cd dsh-session-alert
node scripts/build.mjs && node test/smoke.mjs
node test/browser-check.mjs
node test/desktop-alert.mjs
node test/bridge.mjs
```
