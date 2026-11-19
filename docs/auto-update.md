# 定时同步稳定版与安全更新

`Sync Upstream` 每天 UTC 01:17、13:17（北京时间 09:17、21:17）检查 `aozorae/Edgechat` 默认分支；GitHub 调度可能延迟。上游主仓跳过自身，fork/源码副本更新自己的默认分支。

## 部署者首次配置

1. 先手动同步一次，确保默认分支已有 `.github/workflows/sync-upstream.yml`。
2. 在 Actions 中启用工作流。GitHub 默认禁用新 fork 的定时任务；公开仓库 60 天无活动也可能暂停定时运行，需要重新启用。
3. 推荐添加 Repository Secret `EDGECHAT_SYNC_TOKEN`：使用仅授权当前 fork 的 fine-grained PAT，授予 **Contents: Read and write**、**Workflows: Read and write**。它仅用于 checkout/推送；派发部署使用内置 `GITHUB_TOKEN` 的 Actions 写权限。Classic PAT 对应 `repo` 和 `workflow` 权限，但范围更大，不推荐。
4. 同步凭据需要能更新默认分支。重放定制提交会改变它们的 SHA，适用于默认分支的保护规则也必须允许该凭据强制推送。GitHub 拒绝推送时，同步会停止。
5. 手动运行一次 `Actions -> Sync Upstream -> Run workflow` 检查配置，之后由定时任务执行。要停用自动更新，直接 Disable workflow。

未配置同步令牌时，普通源码更新使用内置令牌；更新涉及 Actions 文件时会明确失败，要求配置上述 Secret，远端分支不变。

## 维护者如何标记提交

发布时照常更新 `package.json`、`package-lock.json` 和变更记录。发布提交在正文末尾加一个独立 Git trailer（与标题/正文之间留空行）：

```bash
# 稳定版本
git commit -m "release: stable version" -m "EdgeChat-Update: stable"
git push origin master

# 必须跟进的安全修复
git commit -m "fix: critical security vulnerability" -m "EdgeChat-Update: security"
git push origin master
```

同步脚本沿上游默认分支的第一父链查找最近的发布标记，接受小写 `stable` 和 `security`。使用 squash 或 merge 发布 PR 时，请把标记写在最终提交说明的末尾。

脚本以选中的发布提交为新基点，用 `git rebase --onto` 按顺序重放 fork 的定制提交。上游发布自带的提交历史保持原样，重放后的定制提交在 `git log --oneline` 顶部。即使某个定制补丁已经被上游采用，也会保留对应的提交记录。历史里有旧式同步合并时，脚本会校验重放后的完整文件树，避免丢失当时手工解决冲突的改动。

推送使用 `--force-with-lease=refs/heads/<branch>:<同步开始时的 SHA>`。同步期间若有人推送、变基出现冲突或文件树校验失败，脚本会停止。并发推送会在下次检查时重新纳入，内容冲突需要手动解决。

自动更新改写提交 SHA 后，可在工作区干净时用 `git pull --rebase origin master` 跟进远端。若有尚未推送的本地提交，先用 `git branch backup-before-sync` 保留当前位置；遇到冲突可用 `git rebase --abort` 返回。

## 为什么同步后仍能部署

使用 `EDGECHAT_SYNC_TOKEN` 推送时，GitHub 可以直接触发部署。脚本会短暂等待同一分支和 SHA 的部署记录出现。若仍未找到部署，脚本通过 `workflow_dispatch` 启动 `00 Deploy Worker`。使用内置 `GITHUB_TOKEN` 推送时直接检查并按需派发。生产流程会测试、构建、迁移并部署更新后的版本。

当前 SHA 已成功部署或有部署正在运行时不重复派发；派发失败、部署失败或取消后，下次检查会补派。部署记录 fork 当前 SHA，不会记录同步前的旧 SHA。请在 Actions 中分别查看 `Sync Upstream` 和 `00 Deploy Worker`，同步成功不代表后续部署已成功。

## 自动清除消息天数

Worker 环境变量 `MESSAGE_RETENTION_DAYS` 默认 `30` 天，请填写正整数（例如 `60`）。GitHub Actions 部署者在 **Settings -> Secrets and variables -> Actions -> Variables** 添加同名 Repository Variable，然后运行 `00 Deploy Worker`；每次部署都会读取它，因此上游同步不会重置该设置。它不是 Secret。

手动部署在 Wrangler 配置的 `[vars]` 中设置 `MESSAGE_RETENTION_DAYS = "60"`，再部署。Cloudflare 面板也可修改 Worker 的同名文本变量并发布，但 Actions 后续部署以 Repository Variable 为准，未配置则恢复 30 天。只在本机导出同名环境变量不会自动传入线上 Worker。

从 `2.19.1` 起，新安装和未显式配置天数的部署默认保留 30 天。已有 Repository Variable 或实际部署的 Wrangler 配置中显式填写的值（包括 `7`、`15`）继续生效；希望改为 30 天时请更新该值后部署。延长保留期不会恢复此前已删除的消息，也不需要迁移或改写消息记录。

每天约 UTC 19:00（北京时间次日 03:00）清理超过保留期的消息与关联附件，按预算分批处理，不保证一轮清完。时间按消息创建时间计算，不按最后查看时间。`0` 不是关闭开关：Worker 对无效值、非正数及小于一天的值回退 30 天；Actions 对非正整数直接报错。缩短保留期会在下一次清理删除更早消息，删除不可恢复，之后改大天数也不能找回。其他软删除数据、孤儿上传和 Telegram 通知投递记录的保留期不变。

参考：[GITHUB_TOKEN 与 dispatch 例外](https://docs.github.com/en/actions/concepts/security/github_token)、[跳过 push 工作流](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs)、[令牌权限](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。
