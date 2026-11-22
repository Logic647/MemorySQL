/**
 * NAS 侧看守的 agent 清单 —— **单一真相源**。
 * ============================================================================
 * nas-probe(升级/版本/会话)与 nas-panel(一键登录)共用这一份,
 * 免得两边各写一张表再慢慢漂移:2026-11-10 新增 copilot/droid 时只改了探针表,
 * 面板的 LOGIN_TARGETS 还停在 5 家 —— 面板上根本点不到新装的两家。
 *
 * 分工(用户 2026-11-10 定):**闭源一律装 NAS 跑探针,开源按原方法**
 * (上游源码/样本 + 本机 check)。开源几家是早期就在看守表里的,保留不动
 * (多一层覆盖不亏,它们的数据目录本来就在 NAS 上)。
 *
 * 2026-11-22 扩编:pi/omp/omo/cline 四家进看守表 —— pi v1.6.0 的
 * `extension render()` 破坏性变更(看板白盒高风险)在本机/NAS 都没有样本
 * 可以黑盒验证,而 pi 系一家改格式另外三家跟着改(family 证据),只能在
 * NAS 装 CLI + 跑最小会话补样本。注意:这四家都要 **LLM 账号/密钥** 才能
 * 出会话(面板一键登录 / SSH TUI),没登录前探针只能盯版本号,数据侧是 🟡。
 *
 * ⚠ 命令一律用**数组**形态(spawn 不经 shell),除 droid/omp 的安装脚本必须
 * 走 `sh -c`(官方只提供 curl | sh 安装器)。
 * ⚠ 这几家的 CLI 参数随版本变:改动前先在 NAS 上 `--help` 核对,别照抄。
 *   2026-11-22 已核对来源:pi packages/coding-agent/docs/cli.md(--print)、
 *   omp README(「omp -p answers a single prompt and exits」)、
 *   omo docs/reference/cli.md(run <message> / login --no-browser)、
 *   cline npm README(位置参数 one-shot / auth 子命令)。装好后仍以 NAS 实测为准。
 */

/** @typedef {{ id: string, label: string, updateCmd: string[], versionCmd: string[],
 *              sessionCmd: string[], loginCmd: string[] | null, sshFallback: string }} NasAgent */

/** @type {NasAgent[]} */
export const NAS_AGENTS = [
  {
    id: 'qoder',
    label: 'Qoder',
    updateCmd: ['npm', 'install', '-g', '@qoder-ai/qodercli@latest'],
    versionCmd: ['qoder', '--version'],
    // -p = print 模式(Claude 系 CLI 惯例):跑一轮真会话写 JSONL,成功即退出
    sessionCmd: ['qoder', '-p', 'Reply with exactly: ok'],
    loginCmd: ['qoder', 'login'],
    sshFallback: 'qoder login'
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    updateCmd: ['npm', 'install', '-g', '@tencent-ai/codebuddy-code@latest'],
    versionCmd: ['codebuddy', '--version'],
    sessionCmd: ['codebuddy', '-p', 'Reply with exactly: ok'],
    loginCmd: ['codebuddy', 'login'],
    sshFallback: 'ssh nas 后运行 codebuddy 并在 TUI 里 /login(面板一键登录对它时灵时不灵)'
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    updateCmd: ['npm', 'install', '-g', '@github/copilot@latest'],
    versionCmd: ['copilot', '--version'],
    sessionCmd: ['copilot', '-p', 'Reply with exactly: ok'],
    // `copilot login` 是真实子命令(2026-11-10 在 NAS 上 --help 核对;1.0.108)
    loginCmd: ['copilot', 'login'],
    sshFallback: 'copilot login'
  },
  {
    id: 'droid',
    label: 'Droid (Factory)',
    updateCmd: ['sh', '-c', 'curl -fsSL https://app.factory.ai/cli | sh'],
    versionCmd: ['droid', '--version'],
    sessionCmd: ['droid', 'exec', 'Reply with exactly: ok'],
    // droid **没有 login 子命令**(--help 只有 resume/exec/daemon/search/update/
    // mcp/plugin/computer/doctor):认证只能在交互式 TUI 里完成,面板管不到。
    loginCmd: null,
    sshFallback: 'ssh nas 后运行 droid 进入 TUI 登录;droid doctor 可检查认证状态'
  },
  {
    id: 'qwencode',
    label: 'Qwen Code',
    updateCmd: ['npm', 'install', '-g', '@qwen-code/qwen-code@latest'],
    versionCmd: ['qwen', '--version'],
    sessionCmd: ['qwen', '-p', 'Reply with exactly: ok'],
    loginCmd: ['qwen', 'login'],
    sshFallback: 'ssh nas 后运行 qwen 按引导认证'
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    updateCmd: ['npm', 'install', '-g', '@google/gemini-cli@latest'],
    versionCmd: ['gemini', '--version'],
    sessionCmd: ['gemini', '-p', 'Reply with exactly: ok'],
    loginCmd: ['gemini', 'login'],
    sshFallback: 'ssh nas 后运行 gemini 按引导认证'
  },
  {
    id: 'kimicli',
    label: 'Kimi Code',
    updateCmd: ['npm', 'install', '-g', '@moonshot-ai/kimi-code@latest'],
    versionCmd: ['kimi', '--version'],
    sessionCmd: ['kimi', '-p', 'Reply with exactly: ok'],
    loginCmd: ['kimi', 'login'],
    sshFallback: 'ssh nas 后运行 kimi 并在 TUI 里 /login'
  },
  // ---- pi 系(2026-11-22 扩编,黑盒样本补采样) ---------------------------
  {
    id: 'pi',
    label: 'Pi',
    // 官方 npm 安装文档带 --ignore-scripts(pi 不需要依赖生命周期脚本,照抄)
    updateCmd: ['npm', 'install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent@latest'],
    versionCmd: ['pi', '--version'],
    // docs/cli.md:--print 跑完写会话即退出(-p 同义)
    sessionCmd: ['pi', '--print', 'Reply with exactly: ok'],
    // 登录在 TUI 里 /login,或 pi auth login <provider> --no-browser ——
    // provider 是参数,面板塞不出通用的一键登录
    loginCmd: null,
    sshFallback: 'ssh nas 后 TUI 里 /login,或 pi auth login <provider> --no-browser'
  },
  {
    id: 'omp',
    label: 'omp (oh-my-pi)',
    // 预编译二进制 + SHA-256 校验的官方安装器(重跑即更新);仓库 can1357/oh-my-pi
    updateCmd: ['sh', '-c', 'curl -fsSL https://omp.sh/install | sh'],
    versionCmd: ['omp', '--version'],
    // README:「omp -p answers a single prompt and exits」
    sessionCmd: ['omp', '-p', 'Reply with exactly: ok'],
    loginCmd: null,
    sshFallback: 'ssh nas 后 TUI 里 /login(60+ provider:oauth/plan/local 任选)'
  },
  {
    id: 'omo',
    label: 'OmO',
    // npm 包是 omo-ai(npm 上 unscoped 的 omo 是别人家的,README 明说)
    updateCmd: ['npm', 'install', '-g', 'omo-ai@latest'],
    versionCmd: ['omo', '--version'],
    // docs/reference/cli.md:run <message> = 非交互会话跑完即退
    sessionCmd: ['omo', 'run', 'Reply with exactly: ok'],
    // omo login --no-browser 是设备码流程,面板能像 OAuth 按钮一样流式展示;
    // 但 OmO 账号「not open to everyone」,登录不上就只有版本监控
    loginCmd: ['omo', 'login', '--no-browser'],
    sshFallback: 'omo login --no-browser(终端出设备码,任意设备网页批准;需 OmO 账号)'
  },
  {
    id: 'cline',
    label: 'Cline CLI',
    updateCmd: ['npm', 'install', '-g', 'cline@latest'],
    versionCmd: ['cline', '--version'],
    // npm README:位置参数 one-shot(yolo 默认,跑完即退)
    sessionCmd: ['cline', 'Reply with exactly: ok'],
    loginCmd: ['cline', 'auth', 'cline'],
    sshFallback: 'ssh nas 后运行 cline auth(cline OAuth / API key 二选一)'
  }
]

/** 面板用:从同一份表派生登录目标(loginCmd 为 null 的只能走 SSH/TUI) */
export const LOGIN_TARGETS = NAS_AGENTS.map((a) => ({
  id: a.id,
  label: a.label,
  loginCmd: a.loginCmd,
  sshFallback: a.sshFallback
}))

/**
 * NAS 上的 CLI 装在两个非标准目录:
 *   ~/local/node-v22.22.1-linux-x64/bin  (npm -g 全部装到这)
 *   ~/.local/bin                         (droid/muse/devin 的官方安装器)
 * 两者都**不在默认 PATH 里** —— 实测 `copilot --version` 报 command not found,
 * 于是探针的版本探测直接失败、面板的一键登录也起不来。systemd unit 必须显式带上。
 */
export const NAS_BIN_PATH = '/home/logic/local/node-v22.22.1-linux-x64/bin:/home/logic/.local/bin'
