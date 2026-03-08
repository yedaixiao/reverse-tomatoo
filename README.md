# reverse-tomato
设计哲学：
番茄钟的倒计时总会让我不舒服，我们要管理的是精力，而非强制自己在一定时间段内必须做什么什么，我们要做的是记录，而非像工作一样强制要求你做什么事情。
一个用于 Obsidian 的侧栏计时插件：

- 在侧栏中显示时钟与计时控制
- 支持亮色 / 暗色 / 跟随系统主题切换
- 开始计时时自动向当日日记追加开始时间
- 结束计时时自动向当日日记追加结束时间
- 统计当日总时长与各事件耗时
- 支持按四象限分类法，管理事务
- 类似todolist的零散事务添加和分配


Design Philosophy
The Pomodoro countdown always makes me feel uncomfortable. What we should manage is energy, not force ourselves to do specific tasks within a fixed time block. What we want is logging/recording, not a work-like system that rigidly demands you do something.

An Obsidian sidebar timer plugin:

Display a clock and timer controls in the sidebar
Support Light / Dark / Follow system theme switching
When a timer starts, automatically append the start time to today’s daily note
When a timer ends, automatically append the end time to today’s daily note
Track total time for the day and time spent per event/task
Support the Eisenhower Matrix (four quadrants) for task management
Support adding “loose”/ad-hoc tasks like a todo list, and assigning/distributing them into categories/tasks

## 安装

### 手动安装

1. 打开本仓库的 Releases 页面。
2. 下载 `main.js`、`manifest.json`、`styles.css`。
3. 在你的 Obsidian vault 中进入 `.obsidian/plugins/reverse-tomato/`。
4. 将上述文件复制进去。
5. 在 Obsidian 的社区插件页面启用 `reverse-tomato`。

## 功能概览

- 侧栏时钟与专注计时
- 自动记录到当日日记
- 事件统计与可视化分析
- 支持补录事件
- 收集箱任务收集、分配与整理
- 四象限任务分类
- 适配较小空间的紧凑侧栏界面

## 发布信息

- 插件 ID：`reverse-tomato`
- 最低 Obsidian 版本：`1.5.0`
- 当前版本：`1.0.1`

## 开发

安装依赖后可使用：

- `npm run dev`：监听构建
- `npm run build`：生产构建

将生成的 `manifest.json`、`main.js`、`styles.css` 复制到你的 Obsidian vault 的插件目录中即可启用。
