#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const COMPANION_DATA_DIR = '/vol1/1000/docker/ai-companion-kit/packages/companion/data';
const MEMORY_REPO_DIR = '/dsh/my-ai-memory';
const TARGET_BACKUP_DIR = path.join(MEMORY_REPO_DIR, 'memory/companion/data');

function run(cmd, cwd = process.cwd()) {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function verifyRepoPrivate() {
  console.log('[sync-memory] 正在校验远端仓库隐私状态...');
  try {
    const raw = run('gh repo view fansID512/my-ai-memory --json isPrivate,visibility', MEMORY_REPO_DIR);
    const parsed = JSON.parse(raw);
    if (!parsed.isPrivate && parsed.visibility !== 'PRIVATE') {
      throw new Error(`仓库非 private 状态: ${raw}`);
    }
    console.log(`[sync-memory] 远端仓库可见性检查通过: isPrivate=${parsed.isPrivate}, visibility=${parsed.visibility}`);
  } catch (err) {
    console.error('[sync-memory] 隐私检查失败，拒绝推送:', err.message);
    throw err;
  }
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  console.log('[sync-memory] 开始执行鲸鲸记忆快照归档...');

  // 1. 检查远端仓库可见性
  verifyRepoPrivate();

  // 2. 确保目标目录存在
  fs.mkdirSync(TARGET_BACKUP_DIR, { recursive: true });

  // 3. 同步关键持久化数据
  const itemsToSync = [
    { src: path.join(COMPANION_DATA_DIR, 'people.json'), dest: path.join(TARGET_BACKUP_DIR, 'people.json') },
    { src: path.join(COMPANION_DATA_DIR, 'self_state.json'), dest: path.join(TARGET_BACKUP_DIR, 'self_state.json') },
    { src: path.join(COMPANION_DATA_DIR, 'diary'), dest: path.join(TARGET_BACKUP_DIR, 'diary') }
  ];

  for (const { src, dest } of itemsToSync) {
    if (fs.existsSync(src)) {
      console.log(`[sync-memory] 同步: ${src} -> ${dest}`);
      copyRecursive(src, dest);
    } else {
      console.log(`[sync-memory] 源路径不存在，跳过: ${src}`);
    }
  }

  // 4. Git 状态检查与提交
  run('git add memory/companion/data', MEMORY_REPO_DIR);
  const status = run('git status --porcelain memory/companion/data', MEMORY_REPO_DIR);
  if (!status) {
    console.log('[sync-memory] 没有发生变动的记忆数据，工作区整洁，跳过提交。');
    return;
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const commitMsg = `backup(companion): 同步鲸鲸伴生记忆快照 [${timeStr}]`;

  console.log(`[sync-memory] 提交更新: ${commitMsg}`);
  run(`git commit -m "${commitMsg}"`, MEMORY_REPO_DIR);

  // 再次确保隐私再 push
  verifyRepoPrivate();

  console.log('[sync-memory] 正在推送到 GitHub 私密仓库...');
  run('git push origin main', MEMORY_REPO_DIR);
  console.log('[sync-memory] 推送完成！');
}

main().catch((err) => {
  console.error('[sync-memory] 发生致命错误:', err);
  process.exit(1);
});
