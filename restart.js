/**
 * dsh-functions/restart —— 「功能」菜单里的「重启 DSH」（dsh-functions 内置子路径插件）。
 *
 * 2026-10-18 从独立包 dsh-function-restart 合并进 dsh-functions：
 *   - 一个包只装一次就同时得到「功能」栏和「重启 DSH」；
 *   - 合并时按「换一台别人的 Windows 还能不能跑」逐条审过写死项（详见包内 README）。
 *
 * 这个插件只有宿主半边：不写客户端代码，只往 ctx.functions 注册一条功能。
 * 两级确认走 prepare(stage)：第 1 级点完之后，浏览器才会来问第 2 级要写什么，
 * 所以「有没有正在进行中的任务」是【当场】查的，不是攒下来的。
 *
 * 重启手法见 restart-helper.js（脱离进程树的两层 fork + 安全网）。
 *
 * 平台：
 *   - Windows 桌面版：完整支持（taskkill /T /F 关进程树 + 重新拉起 + 安全网）。
 *   - 其它桌面平台（macOS / Linux 桌面）：没有可用的整树关闭手段，明确提示「不支持」，
 *     不执行任何操作（以前会静默中止，用户以为排好了）。
 *   - 命令行 / headless 形态：走 cli 路径（本进程退出后按同样命令重新拉起），不依赖 taskkill。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Loader 行名（行 id 由 cordis.patch.yml 决定；这个名字用于诊断）。 */
export const name = 'functions-restart';

/** 只依赖「功能」注册表；任务状态用 ctx.get('agents'/'jobs') 现取。 */
export const inject = ['functions'];

/** 脱离进程树的重启助手（与本文件同目录）。 */
const HELPER_PATH = fileURLToPath(new URL('./restart-helper.js', import.meta.url));

/** 默认参数，profile 里那一行的 config 可以覆盖。 */
const DEFAULTS = {
  /** 桌面端：助手先睡多久再动手——留给 HTTP 响应回到浏览器。 */
  initialDelayMs: 900,
  /**
   * 桌面端：先温柔关一次的宽限（taskkill 不带 /F）。
   *
   * 外壳会在主窗口的 close 事件里 preventDefault 并缩进托盘，所以这一步在桌面端
   * 基本必然无效 —— 默认给得很短，纯粹是留个缓冲，别让用户干等。
   */
  graceMs: 800,
  /** 轮询间隔。 */
  pollMs: 250,
  /** 等旧进程彻底退出的上限。 */
  waitExitMs: 30000,
  /** 等端口放开的上限（进程没了但端口还被占着时多等一会）。 */
  waitPortMs: 15000,
  /**
   * 安全网延时：先等这么久，再开始盯内层助手 / 兜底。
   *
   * 内层助手最坏耗时约 initialDelay + grace + waitExit + waitPortx2 + 拉窗
   * （0.9 + 0.8 + 30 + 30 + 约 14 秒）。安全网不再用「固定等这么久就拉起」，
   * 而是先等 guardDelayMs，然后盯内层 pid：内层还活着就等到它退出（最长 180 秒），
   * 内层退出后才兜底拉一次（已经开着时只会被叫到前台）。所以这里的值不再需要
   * 精确覆盖最坏耗时 —— 它只是「什么时候开始接管」。
   */
  guardDelayMs: 70000,
  /**
   * 拉起之后要不要把窗口叫到前台（默认要）。
   *
   * 外壳抢了 Electron 的 single-instance 锁，第二次启动会让已经在跑的那个
   * 收到 second-instance -> focusPrimaryWindow()。用户以前得自己点托盘那一下，
   * 现在助手代劳；第二次启动自己会立刻退出，不会多出实例。
   * 注意：0.2.1-rc.2 桌面 Host 用动态端口，所以叫窗口不依赖端口探测，按固定延时兜底。
   */
  focusNudge: true,
  /** 叫窗口前最多等多久（0.2.1-rc.2 下实际用固定 8 秒兜底；固定端口的旧版本可提前）。 */
  focusWaitMs: 45000,
  /** 请求返回后本进程再活多久（仅 cli 形态需要自己退出）。 */
  exitDelayMs: 300,
};

/** 读取这一行 cordis config 里的覆盖值。 */
function readConfig(config) {
  const input = typeof config === 'object' && config !== null ? config : {};
  const pick = (key) => {
    const value = Number(input[key]);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULTS[key];
  };
  return {
    initialDelayMs: pick('initialDelayMs'),
    graceMs: pick('graceMs'),
    pollMs: Math.max(50, pick('pollMs')),
    waitExitMs: pick('waitExitMs'),
    waitPortMs: pick('waitPortMs'),
    guardDelayMs: pick('guardDelayMs'),
    focusWaitMs: pick('focusWaitMs'),
    focusNudge: input.focusNudge !== false,
    exitDelayMs: pick('exitDelayMs'),
    /** 关掉「真动手」，只回一份计划——给自检 / 排障用。 */
    dryRun: input.dryRun === true,
  };
}

/** 桌面端的「整树关闭 + 重新拉起」目前只在 Windows 上实现（taskkill /T /F）。 */
export function isDesktopRestartSupported(platform = process.platform) {
  return platform === 'win32';
}

/**
 * 本进程跑在哪种形态里。
 *
 * 判据：
 *   - 桌面壳：宿主进程与 Electron 主进程之间有 IPC 通道（process.send 可用且连着），
 *     或者命令行里能看到桌面宿主入口。IPC 是硬信号，比只认 argv 可靠。
 *   - 桌面壳 + 非 Windows：mode = 'unsupported'（没有整树关闭手段）。
 *   - 其余（dsh CLI / headless / ACP）：mode = 'cli'，本进程退出后按同样命令重启。
 */
export function detectMode() {
  const argvText = process.argv.join(' ');
  const hasIpc = typeof process.send === 'function' && process.connected === true;
  const desktopEntry = argvText.includes('dsh-desktop-host');
  const desktopShell = hasIpc || desktopEntry;
  const base = {
    platform: process.platform,
    hasIpc,
    desktopEntry,
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
  };
  if (desktopShell && !isDesktopRestartSupported(process.platform)) {
    return { ...base, mode: 'unsupported', desktopEntry: true };
  }
  return { ...base, mode: desktopShell ? 'desktop' : 'cli' };
}

/**
 * 现在有没有正在进行中的任务：与桌面外壳 update-tasks 的判据保持一致。
 * @returns 只读快照；拿不到服务时 available:false（而不是 active:false 的假象）。
 */
export function inspectActiveWork(ctx) {
  const agentsService = ctx.get('agents');
  const jobsService = ctx.get('jobs');
  const busyAgents = [];
  const runningJobs = [];
  /** @type {Array<object>} */
  let roster = [];

  if (agentsService !== undefined && typeof agentsService.list === 'function') {
    try {
      roster = agentsService.list() ?? [];
    } catch (error) {
      return { available: false, reason: 'agents.list() 失败：' + String(error && error.message), active: false, busyAgents, runningJobs };
    }
  }

  if (agentsService !== undefined) {
    for (const agent of roster) {
      const inbox = agent && typeof agent.inbox === 'object' && agent.inbox !== null ? agent.inbox : {};
      const pendingTurns = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0;
      const pendingSteps = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0;
      if (agent && (agent.status === 'running' || pendingTurns > 0 || pendingSteps > 0)) {
        // 现行 Agent 只有 id（dsh-agent-loop 没有 title）：有 title 就用，没有就显示 id，
        // 不假装会话有标题。保留 title 字段只为兼容投影里带 title 的实现。
        busyAgents.push({
          id: String(agent.id ?? ''),
          title: typeof agent.title === 'string' ? agent.title : '',
          status: String(agent.status ?? ''),
          pending: pendingTurns + pendingSteps,
        });
      }
    }
  }

  /** 有一次查询失败就不再声称「没有任务」——宁可说不知道。 */
  let jobsQueryFailed = false;
  if (jobsService !== undefined && typeof jobsService.list === 'function') {
    for (const agent of [undefined, ...roster]) {
      let jobs = [];
      try {
        jobs = jobsService.list(agent === undefined ? undefined : agent.id) ?? [];
      } catch (error) {
        jobs = [];
        jobsQueryFailed = true;
      }
      for (const job of jobs) {
        // 「哪些任务算在跑」只由 status 决定（running / stopping），与显示名无关。
        if (job && (job.status === 'running' || job.status === 'stopping')) {
          // 现行 JobView 的显示字段是 label（JobSpec 也只收 label）；title / name 是旧字段，
          // 留作兜底，别的实现若还投影旧字段也不至于没名字。全都没有就退 id。
          const label =
            typeof job.label === 'string' && job.label.length > 0
              ? job.label
              : typeof job.title === 'string' && job.title.length > 0
                ? job.title
                : typeof job.name === 'string' && job.name.length > 0
                  ? job.name
                  : '';
          runningJobs.push({
            agentId: agent === undefined ? '' : String(agent.id ?? ''),
            id: String(job.id ?? job.name ?? ''),
            label,
            status: String(job.status ?? ''),
          });
        }
      }
    }
  }

  const available =
    agentsService !== undefined && typeof agentsService.list === 'function' &&
    jobsService !== undefined && typeof jobsService.list === 'function' && !jobsQueryFailed;

  return {
    available,
    reason: available ? '' : '缺少 agents / jobs 服务，无法判断任务状态',
    active: busyAgents.length > 0 || runningJobs.length > 0,
    busyAgents,
    runningJobs,
  };
}

/** 把 running 的会话与后台任务列成人能读的几行。 */
function describeBusy(work) {
  const lines = [];
  for (const agent of work.busyAgents.slice(0, 4)) {
    // Agent 没有 title，显示 id。
    const name = agent.title.length > 0 ? agent.title : agent.id;
    const pending = Number(agent.pending) > 0 ? '（还压着 ' + String(agent.pending) + ' 条待办）' : '';
    lines.push('- 会话 ' + name + '：' + agent.status + pending);
  }
  if (work.busyAgents.length > 4) lines.push('- 还有 ' + String(work.busyAgents.length - 4) + ' 个会话在跑');
  for (const job of work.runningJobs.slice(0, 4)) {
    // 后台任务名优先现行 JobView.label（旧字段 title / name 已在收集时兜底），再退 id。
    const name = job.label.length > 0 ? job.label : job.id;
    lines.push('- 后台任务 ' + name + '：' + job.status);
  }
  if (work.runningJobs.length > 4) lines.push('- 还有 ' + String(work.runningJobs.length - 4) + ' 个后台任务在跑');
  return lines.length > 0 ? lines.join('\n') : '（任务清单为空）';
}

/**
 * 助手日志落在哪。
 *
 * 顺序：这一行的 config.logPath -> DSH_HOME -> 用户目录下的 .dsh -> 空串（交给助手自己挑 tmpdir）。
 * 合并进公开包之后**不再带本机绝对路径**：默认值全部由运行环境推出来。
 */
export function helperLogPath(config) {
  const input = typeof config === 'object' && config !== null ? config : {};
  if (typeof input.logPath === 'string' && input.logPath.trim().length > 0) return input.logPath.trim();
  const env = process.env;
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return join(env.DSH_HOME, 'dsh-functions-restart.log');
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE.length > 0) {
    return join(env.USERPROFILE, '.dsh', 'dsh-functions-restart.log');
  }
  try {
    return join(tmpdir(), 'dsh-functions-restart.log');
  } catch (error) {
    return '';
  }
}

/**
 * 当前 Web 端口：从 webServer 服务推出来，**不再写死任何端口**。
 *
 * 现行契约是 getOrigin()（例如 http://127.0.0.1:53256）；老一点的面板可能只有 port 字段。
 * 都拿不到就返回 0 —— 助手会把端口只当「早点叫窗口」的快路径；0.2.1-rc.2 桌面是动态端口，
 * 新实例端口跟旧的不会一样，所以助手本来就有固定延时兜底（2026-10-18 审查结论）。
 */
export function webPortOf(ctx) {
  try {
    const server = ctx.get('webServer');
    if (server === undefined || server === null) return 0;
    if (typeof server.getOrigin === 'function') {
      const origin = String(server.getOrigin());
      const parsed = new URL(origin);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      if (Number.isSafeInteger(port) && port > 0 && port < 65536) return port;
    }
    const raw = Number(server.port);
    if (Number.isSafeInteger(raw) && raw > 0 && raw < 65536) return raw;
  } catch (error) {
    return 0;
  }
  return 0;
}

/** 助手要的 payload。单独导出是为了自检能验形状（不用真起助手）。 */
export function buildRestartPayload(ctx, config, mode) {
  const settings = readConfig(config);
  return mode.mode === 'desktop'
    ? {
        mode: 'desktop',
        appPid: mode.ppid,
        appExec: mode.execPath,
        port: webPortOf(ctx),
        initialDelayMs: settings.initialDelayMs,
        graceMs: settings.graceMs,
        pollMs: settings.pollMs,
        waitExitMs: settings.waitExitMs,
        waitPortMs: settings.waitPortMs,
        guardDelayMs: settings.guardDelayMs,
        focusNudge: settings.focusNudge,
        focusWaitMs: settings.focusWaitMs,
        logPath: helperLogPath(config),
      }
    : {
        mode: 'cli',
        pid: mode.pid,
        execPath: mode.execPath,
        argv: process.argv.slice(1),
        cwd: process.cwd(),
        initialDelayMs: settings.initialDelayMs,
        pollMs: settings.pollMs,
        waitExitMs: settings.waitExitMs,
        logPath: helperLogPath(config),
      };
}

/**
 * 起一个脱离应用进程树的重启助手。
 *
 * 助手分两层：外层由本进程 spawn（detached），它立刻再 spawn 一个内层后自杀。
 * 这样内层的父进程已经没了 —— 桌面端随后用 taskkill /T /F 关掉整棵应用进程树时，
 * 内层不在那棵树里，才活得下来把应用重新拉起来。
 */
export async function scheduleRestart(ctx, config, mode) {
  const settings = readConfig(config);
  const payload = buildRestartPayload(ctx, config, mode);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const outer = spawn(process.execPath, [HELPER_PATH, '--outer', JSON.stringify(payload)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: process.cwd(),
    env,
  });
  outer.unref();

  // 等一小会：外层起完内层就会退，退出码 0 = 内层真的起来了。
  // spawn 的失败是【异步】报的（'error' 事件），不等就会变成
  // 「提示已排定重启，然后什么都没发生」—— 2026-10-06 用户就是这么撞上的。
  const started = await new Promise((resolve) => {
    let settled = false;
    const done = (value, why) => {
      if (settled) return;
      settled = true;
      if (why !== undefined) console.error('[dsh-functions/restart] 重启助手没能启动：' + why);
      resolve(value);
    };
    outer.once('error', (error) => done(false, String(error && error.message)));
    outer.once('exit', (code) => done(code === 0, '外层助手退出码 ' + String(code)));
    setTimeout(() => done(true, undefined), 3000);
  });

  return { payload, settings, started };
}

/**
 * 插件体：往「功能」里注册一条「重启 DSH」。
 * @param ctx cordis 上下文
 * @param config 本行 cordis config
 */
export function apply(ctx, config = {}) {
  const settings = readConfig(config);
  /** 同时只允许排一次重启。 */
  let scheduled = false;
  const initialMode = detectMode();
  const supported = initialMode.mode !== 'unsupported';

  ctx.functions.register({
    id: 'restart-dsh',
    title: supported ? '重启 DSH' : '重启 DSH（仅 Windows 桌面版）',
    description:
      '重启 DSH，让插件与设置改动生效\n' +
      (supported ? 'dsh-functions（内置）' : '当前系统没有整树关闭手段，点击只说明原因'),
    icon: '重',
    group: '系统',
    order: 10,
    keywords: ['restart', '重启', 'relaunch'],

    /**
     * 一级一级给确认窗。第 1 级点完之后浏览器才会来问第 2 级，
     * 所以下面这次 inspectActiveWork 是【当场】跑的。
     */
    prepare(stage) {
      const mode = detectMode();
      if (mode.mode === 'unsupported') {
        if (stage !== 0) return null;
        return {
          title: '重启 DSH（当前系统不支持）',
          message: '一键重启目前只支持 Windows 桌面版。',
          detail:
            '当前系统：' + mode.platform + '。\n' +
            'macOS / Linux 的桌面版没有可用的「整树关闭」手段，插件不会执行任何操作，也不会假装重启。\n' +
            '命令行版（dsh CLI）不经过这里，它走自己的重启路径。',
          confirmText: '知道了',
          cancelText: '',
        };
      }
      if (stage === 0) {
        return {
          title: '重启 DSH',
          message: '重启会关闭当前的 DSH 进程，并在几秒后自动重新打开。',
          detail:
            mode.mode === 'desktop'
              ? '桌面端：应用会被关闭后重新启动，随后自动打开；应用带起来的子进程（终端、后台任务等）也会一起结束。'
              : '服务端：会用同样的命令重新拉起 DSH，本页面会自动重连。',
          confirmText: '继续',
          cancelText: '取消',
        };
      }
      if (stage !== 1) return null;

      const work = inspectActiveWork(ctx);
      const active = work.active === true;
      const known = work.available === true;
      const parts = [];
      if (active) {
        parts.push(describeBusy(work));
        parts.push('重启是强制关闭，这些任务会被打断，且不会等它们收尾。');
      } else if (known) {
        parts.push('现在没有检测到正在进行中的任务。');
        parts.push('（应用带起来的终端等子进程仍会随应用一起结束。）');
      } else if (work.reason.length > 0) {
        parts.push('无法确认是否有正在进行中的任务：' + work.reason);
      } else {
        parts.push('无法确认是否有正在进行中的任务（状态接口没应答）。');
      }
      return {
        title: '确认重启',
        message: active ? '有正在进行中的任务，确定要重启DSH吗？' : '确定要重启 DSH 吗？',
        detail: parts.join('\n'),
        danger: active,
        confirmText: active ? '仍要重启' : '重启',
        cancelText: '取消',
      };
    },

    async run() {
      if (scheduled) throw new Error('已经排好一次重启了');
      const mode = detectMode();
      if (mode.mode === 'unsupported') {
        return { message: '未执行：一键重启目前只支持 Windows 桌面版（当前平台：' + mode.platform + '）。' };
      }
      const work = inspectActiveWork(ctx);
      if (settings.dryRun) {
        return { message: 'dryRun：模式=' + mode.mode + '，有任务=' + String(work.active) + '（没有真的重启）' };
      }
      const { payload, started } = await scheduleRestart(ctx, config, mode);
      if (started !== true) {
        // 没起来就【不落标志】：用户再点一次仍然可以重试，而不是被告知「已经排好了」。
        throw new Error('重启助手没能启动，重启没有发生。日志：' + String(payload.logPath || '(未指定路径)'));
      }
      // 只有助手真的起出来了才落这个标志。
      scheduled = true;
      console.log(
        '[dsh-functions/restart] 已排定重启：mode=' + mode.mode +
          ' pid=' + String(mode.pid) +
          ' activeTasks=' + String(work.active),
      );

      // cli 形态没人替我们关进程：回完响应自己退出，助手在原地把同一份命令重新拉起。
      // desktop 形态反过来 —— 保持活着别动，让助手按计划关掉整个应用（自己退出反而会
      // 让主进程先弹一次「应用已意外停止」的失败界面）。
      if (mode.mode === 'cli') {
        const timer = setTimeout(() => process.exit(0), settings.exitDelayMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      return {
        message: mode.mode === 'desktop' ? '已排定重启，窗口马上会关闭' : '已排定重启，本页面会自动重连',
        scheduled: true,
        mode: mode.mode,
        active: work.active,
        restartAfterMs: payload.initialDelayMs,
        // 给界面一个兜底提示：真要重启的话页面已经没了，这条永远不会显示。
        warnAfterMs: 20000,
        warnMessage: '重启没有发生：应用还活着。看助手日志：' + String(payload.logPath || '(未指定路径)'),
      };
    },
  });
}
