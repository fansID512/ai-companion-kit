# 这份仓库怎么用（本地 fork 约定）

本仓库是 [`pinganbbOvO/ai-companion-kit`](https://github.com/pinganbbOvO/ai-companion-kit) 的 fork，
用来在跟上游的同时保留自己的改动。

## 远端

| 名字 | 指向 | 用途 |
| :--- | :--- | :--- |
| `origin` | `fansID512/ai-companion-kit` | 自己的 fork，日常推这里 |
| `upstream` | `pinganbbOvO/ai-companion-kit` | 上游，**只读**（push URL 已禁用，防止误推） |

## 分支

- `main` —— 跟上游保持一致的干净分支，不要在上面提交自己的东西。
- `fans/local` —— 自己的改动都在这里。

## 跟上游同步

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main   # main 永远快进，不改写
git checkout fans/local
git merge main                                            # 把上游更新合进来
# 有冲突就解冲突，解完跑一遍 node --check 和实机验证
```

推自己的改动：

```bash
git checkout fans/local
git add -A && git commit -m "feat(companion): ..."
git push origin fans/local
```

## 不会进仓库的东西

`.gitignore` 已经挡住，**这些一律不要提交**：

- `config.json`（含 apiKey、OneBot 两个 token）
- `role.md` / `role.md.v1`（角色卡，私人设定）
- `data/`（`people.json` 长期记忆、`turns.jsonl` 对话、`diary/` 日记、日志）
- `*.bak*`、`*.log`

备份文件请放到仓库外，例如 `/vol1/1000/docker/ai-companion-backups/`。

## 本地相对上游加了什么

见 `git log --oneline cf7f8eb..fans/local`。大致是：拟人分条发送、主动陪伴（含 SKIP 四级与
follow-up）、拍一拍/点赞/撤回/换头像/表情包、收图（image_url + data URL）、
深夜双轨反思、联网工具、发送闸门（熔断+限流）。

## 改动前先读

- 上游 `README.md` 是用法说明，本文件只讲 fork 协作。
- 改 `src/` 后至少跑 `node --check src/*.js`；重启服务前先备份到仓库外。
