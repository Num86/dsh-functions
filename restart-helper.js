/**
 * restart-helper.js —— 脱离应用进程树的重启助手（dsh-functions 内置子路径插件用）。
 *
 * 2026-10-18 从独立包 dsh-function-restart 合并进 dsh-functions；相对路径不变，
 * 但去掉了「端口写死 / 只有 Windows 才能用」的假设：
 *   - 端口从插件传进来；拿不到（0）就跳过端口探测，只靠进程名判断；
 *   - 桌面端的整树关闭只在 Windows 上进入（插件侧已经判过，这里再兜一层）。
 *
 * 为什么要有这么一个「跳出进程树」的助手：
 *   桌面端 DSH 是 Electron 主进程 fork 出来的 Host 子进程。用 taskkill /T 关掉应用时，
 *   它会照着「父进程号」这张表递归杀 —— 只要助手还挂在应用这棵树上，就会被一起带走，
 *   于是「关了没人拉起来」。所以助手分两层：
 *
 *     外层(--outer)：由 Host 用 detached 起，立刻再起一个 detached 的内层后自杀。
 *     内层(默认)   ：父进程已经没了 → 不在 taskkill /T 的树里 → 活下来把应用重新拉起。
 *
 *   （2026-10-05 实测：A 起 B、B 起 C 后 B 退出，taskkill /PID A /T /F 只杀掉 A，
 *     C 继续存活 —— 这一层就是这么用的。）
 *
 * 用法（由 restart.js 调用，不要手改参数形状）：
 *   <node|electron-as-node> restart-helper.js --outer '<payloadJson>'
 *   <node|electron-as-node> restart-helper.js '<payloadJson>'
 *   <node|electron-as-node> restart-helper.js --guard '<payloadJson>'   安全网（只在 desktop 用）
 *
 * payload：
 *   desktop: { mode, appPid, appExec, port, initialDelayMs, graceMs, pollMs, waitExitMs, waitPortMs, guardDelayMs, logPath }
 *   guard:   同 desktop，另加 innerPid（由外层 --outer 填，用来判断内层助手是否还活着）
 *   cli:     { mode, pid, execPath, argv, cwd, initialDelayMs, pollMs, waitExitMs, logPath }
 */

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件自己的绝对路径（拉起下一层用）。 */
const SELF = fileURLToPath(import.meta.url);

/** 端口是否可用（0 / 非法 = 不探测端口）。 */
function usablePort(port) {
  return Number.isSafeInteger(port) && port > 0 && port < 65536;
}

/** 记一行日志；日志写不进去也绝不抛。 */
function log(logPath, line) {
	const text = '[' + new Date().toISOString() + '] ' + line + String.fromCharCode(10);
	try {
		rotateLogIfNeeded(logPath);
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, text, 'utf8');
	} catch {
		/* 日志写不了也不能影响重启主流程 */
	}
}

/** 日志超过 5 MB 就地轮转：x.log -> x.log.1 -> ... -> x.log.7（最老的丢）；失败不再抛。 */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 7;
function rotateLogIfNeeded(file) {
	try {
		if (statSync(file).size < LOG_MAX_BYTES) return;
	} catch {
		return;
	}
	try {
		for (let i = LOG_KEEP - 1; i >= 1; i -= 1) {
			const from = file + '.' + i;
			const to = file + '.' + (i + 1);
			if (!existsSync(from)) continue;
			try { rmSync(to, { force: true }); } catch { /* 删不掉就算了 */ }
			try { renameSync(from, to); } catch { /* 挪不动就算了 */ }
		}
		try { renameSync(file, file + '.1'); } catch { /* 挪不动就算了 */ }
	} catch {
		/* 轮转失败不影响主流程 */
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程还在不在（Windows 上 process.kill(pid,0) 对已退出进程抛 ESRCH）。 */
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * 系统 taskkill 的绝对路径；**拿不到就返回空**（不回退到 PATH 上的同名文件 ——
 * 那等于让 PATH 劫持决定我们去杀谁）。调用方见到空串就当作「这条不做」。
 */
function taskkill() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = join(root, 'System32', 'taskkill.exe');
  return existsSync(absolute) ? absolute : '';
}

/**
 * 温柔关一次：taskkill 不带 /F 会向该进程的顶层窗口发 WM_CLOSE。
 *
 * 注意桌面端这条**通常无效**：外壳会在主窗口的 close 事件里 preventDefault 并缩进托盘
 * （见 app.asar/lib/main.js 的窗口 close 处理），before-quit 根本到不了。留着它是为了
 * 万一用户把「关闭即退出」配开了，以及给强制关一个短暂的缓冲。
 */
function requestClose(pid) {
  const executable = taskkill();
  if (executable === '') return false;
  try {
    spawnSync(executable, ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    return false;
  }
}

/** 连锅端：/T 杀整棵进程树，/F 强制。拿不到 taskkill 就什么都不做（返回 false）。 */
function forceKillTree(pid) {
  const executable = taskkill();
  if (executable === '') return false;
  try {
    const result = spawnSync(executable, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return result.status === 0 || result.status === 128;
  } catch (error) {
    return false;
  }
}

/** 某个 pid 的进程映像名（拿不到返回 null）。用于「动手之前先确认杀的是对的人」。 */
function imageNameOf(pid) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const executable = join(systemRoot, 'System32', 'tasklist.exe');
  let result;
  try {
    result = spawnSync(executable, ['/NH', '/FO', 'CSV', '/FI', 'PID eq ' + String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (error) {
    return null;
  }
  const output = typeof result.stdout === 'string' ? result.stdout : '';
  const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (first === undefined) return null;
  const match = /^"([^"]+)"/.exec(first.trim());
  return match === null ? null : match[1];
}

/** 端口在不在监听（连得上就是有人占着）。端口非法时直接返回 false。 */
function portListening(port) {
  return new Promise((resolve) => {
    if (!usablePort(port)) {
      resolve(false);
      return;
    }
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(600);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 等进程退出；返回是否在超时前退出了。 */
async function waitForExit(pid, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(pollMs);
  }
  return !alive(pid);
}

/** 等端口开始监听（= 应用真的起来了）。 */
async function waitPortListening(port, timeoutMs, pollMs) {
  if (!usablePort(port)) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await sleep(pollMs);
  }
  return portListening(port);
}

/**
 * 拉起应用 + 把窗口叫到前台。
 *
 * 为什么后面那一下「再启动一次」：外壳抢了 Electron 的 single-instance 锁
 * （main.js: claimDesktopSingleInstance），第二次启动会被已经跑着的那个收到
 * second-instance 事件，回调里就是 focusPrimaryWindow() —— 显示、还原、置顶。
 * 也就是说：**用户现在手工点托盘那一下，可以由助手代劳**，而第二次启动自己会立刻退出。
 *
 * 端口在这里只当「早点叫窗口」的快路径：0.2.1-rc.2 的桌面 Host 用 `--port 0` 动态端口，
 * 新实例的端口跟旧端口不一样，所以「等旧端口重新监听」通常等不到（2026-10-18 审查发现）。
 * 等不到就按固定延时叫窗口 —— 第二次启动即使应用已经开着，也只是把它叫到前台，不多开实例。
 */
async function launchAppAndFocus(payload, logPath) {
  const appExec = payload.appExec;
  const cwd = dirname(appExec);
  const env = desktopEnvironment();
  const launched = launch(appExec, [], { cwd, env, windowsHide: false }, logPath);
  if (launched === null) return null;

  if (payload.focusNudge === false) {
    log(logPath, '（按配置不叫窗口）');
    return launched;
  }
  const waitMs = Number.isFinite(payload.focusWaitMs) ? payload.focusWaitMs : 45000;
  const pollMs = Number.isFinite(payload.pollMs) && payload.pollMs > 0 ? payload.pollMs : 250;

  let ready = false;
  if (usablePort(payload.port)) {
    // 老版本若用固定端口，旧端口会重新监听，可以早一点叫窗口。
    ready = await waitPortListening(payload.port, Math.min(waitMs, 6000), pollMs);
    log(logPath, '旧端口重新监听=' + String(ready));
  }
  const delay = ready ? 800 : Math.min(waitMs, 8000);
  log(logPath, '等 ' + String(delay) + 'ms 后叫窗口');
  await sleep(delay);

  const nudge = launch(appExec, [], { cwd, env, windowsHide: false }, logPath);
  log(logPath, nudge === null ? '叫窗口失败（第二次启动没起来）' : '已请求把窗口叫到前台（第二次启动，它会自己退出）');
  return launched;
}

/** 等端口放开（旧 Host 释放监听）。端口未知就直接认为已经放开。 */
async function waitForPortFree(port, timeoutMs, pollMs) {
  if (!usablePort(port)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true;
    await sleep(pollMs);
  }
  return !(await portListening(port));
}

/**
 * 拉起一个新进程；返回 pid 或 null。
 *
 * windowsHide 默认 true（给无窗口的辅助进程用）；**拉起 GUI 应用时必须传 false**：
 * 那个选项会写进 STARTUPINFO 的 wShowWindow，Chromium 起第一个窗口时会看它，
 * 结果是应用起来了但窗口不显示 —— 2026-10-06 用户遇到的就是这个（还得去点托盘）。
 */
function launch(execPath, args, options, logPath) {
  try {
    const child = spawn(execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: options.windowsHide !== false,
      cwd: options.cwd,
      env: options.env,
    });
    // spawn 的失败（ENOENT/EPERM：可移动盘被拔掉、安装目录被删等）是【异步】的
    // 'error' 事件；不挂监听会变成未捕获异常，把助手自己带崩（2026-10-18 审查发现）。
    child.on('error', (error) => log(logPath, '拉起后报错 ' + execPath + '：' + String(error && error.message)));
    child.unref();
    log(logPath, '已拉起 ' + execPath + ' pid=' + String(child.pid));
    return child.pid;
  } catch (error) {
    log(logPath, '拉起失败 ' + execPath + '：' + String(error && error.message));
    return null;
  }
}

/** 桌面端要拉起的是 GUI 应用：去掉 node 模式与本次会话专用的环境变量。 */
function desktopEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DSH_SESSION_ID;
  delete env.DSH_SHELL;
  delete env.DSH_WEB_URL;
  return env;
}

/** cli 形态：等旧进程退出后，用完全相同的命令重新拉起一份。 */
async function runCli(payload, logPath) {
  log(logPath, 'cli 模式：等待旧进程 ' + String(payload.pid) + ' 退出');
  const exited = await waitForExit(payload.pid, payload.waitExitMs, payload.pollMs);
  log(logPath, '旧进程已退出=' + String(exited));
  if (!exited) {
    // 旧进程还活着就再拉一份，只会多一个绑不上端口的僵尸实例。
    log(logPath, '中止：旧进程没能在 ' + String(payload.waitExitMs) + 'ms 内退出，不拉起第二份');
    return;
  }
  await sleep(payload.initialDelayMs);
  launch(payload.execPath, payload.argv, { cwd: payload.cwd, env: process.env }, logPath);
}

/** 桌面端：先确认杀的是对的人，再关应用、等端口放开、重新拉起。 */
async function runDesktop(payload, logPath) {
  const appExec = payload.appExec;
  const appImage = basename(appExec);
  log(logPath, 'desktop 模式：appPid=' + String(payload.appPid) + ' app=' + appExec + ' port=' + String(payload.port));
  await sleep(payload.initialDelayMs);

  if (alive(payload.appPid)) {
    // 动手之前先核对进程名：万一把 pid 搞错了，宁可什么都不做。
    const image = imageNameOf(payload.appPid);
    if (image === null || image.toLowerCase() !== appImage.toLowerCase()) {
      log(logPath, '中止：pid ' + String(payload.appPid) + ' 的进程名是 ' + String(image) + '，与 ' + appImage + ' 不符');
      return;
    }
    log(logPath, '先试一次温柔关（桌面端主窗口会被拦截并缩进托盘，通常无效）');
    const graceful = requestClose(payload.appPid);
    if (!graceful) log(logPath, '找不到 taskkill，跳过温柔关');
    if (!(await waitForExit(payload.appPid, payload.graceMs, payload.pollMs))) {
      // 关窗口这段时间里 pid 可能已经退出并被系统回收给别的进程：
      // 动手强杀之前**再核对一次**映像名，对不上就宁可什么都不做。
      const recheck = imageNameOf(payload.appPid);
      if (recheck === null || recheck.toLowerCase() !== appImage.toLowerCase()) {
        log(logPath, '中止：强杀前复查发现 pid ' + String(payload.appPid) + ' 现在是 ' + String(recheck) + '，不是 ' + appImage);
        return;
      }
      log(logPath, '温柔关没关掉，升级为强杀整棵树');
      if (!forceKillTree(payload.appPid)) log(logPath, '强杀没能执行（taskkill 不可用？）');
    }
    const exited = await waitForExit(payload.appPid, payload.waitExitMs, payload.pollMs);
    log(logPath, '应用主进程已退出=' + String(exited));
    if (!exited) {
      log(logPath, '中止：应用没能在 ' + String(payload.waitExitMs) + 'ms 内退出，不再拉起第二个实例');
      return;
    }
  } else {
    log(logPath, '应用主进程已经不在，直接进入拉起流程');
  }

  let free = await waitForPortFree(payload.port, payload.waitPortMs, payload.pollMs);
  if (!free) {
    // 端口还被占着（别的进程占着，或者上一次的监听没释放干净）：再等一轮。
    log(logPath, '端口 ' + String(payload.port) + ' 仍被占用，再等一轮');
    free = await waitForPortFree(payload.port, payload.waitPortMs, payload.pollMs);
  }
  if (!free) {
    // 这里仍然拉 —— 应用关着是更坏的结果（TIME_WAIT 一般不挡 bind，真被别的进程
    // 占了的话新实例自己会报「端口被占用」，用户至少能看到一个窗口而不是什么都没有）。
    log(logPath, '端口 ' + String(payload.port) + ' 仍未放开，仍尝试拉起（新实例可能启动失败）');
  } else {
    log(logPath, '端口 ' + String(payload.port) + ' 已放开=true');
  }

  await launchAppAndFocus(payload, logPath);
}

/**
 * 安全网：主助手万一没活下来，这里兜底把应用拉起来。
 *
 * 2026-10-18 审查发现并修掉：旧实现用 `anyProcessNamed(appImage)` 判断「应用是否已回来」，
 * 但安全网自己也是用桌面 exe + ELECTRON_RUN_AS_NODE 起的，映像名和桌面主程序一样
 * （本机还有多个 Node 模式子进程同名），于是它永远「看到应用」、
 * 永远直接退出 —— 安全网实际从不兜底。现在改成看**内层助手的 pid**：
 *   内层还活着 -> 交给它，安全网退出；
 *   内层不在了 -> 无法判断应用是被内层拉起来了还是内层中途死了，直接再拉起一次：
 *                 应用已经开着时，Electron 的 single-instance 只会把它叫到前台，
 *                 第二次启动自己退出，不会多开实例。
 */
async function runGuard(payload, logPath) {
  log(logPath, 'guard 模式：先等 ' + String(payload.guardDelayMs) + 'ms，再盯内层助手到它退出为止');
  await sleep(payload.guardDelayMs);
  const innerPid = Number(payload.innerPid);

  // 内层助手可能还在慢慢干活（慢机器上最坏可到一分多钟）：盯到它退出，
  // 期间绝不插手；它退出后再兜底拉一次（应用已开着的话只会被叫到前台）。
  if (Number.isSafeInteger(innerPid) && innerPid > 0) {
    const maxWaitMs = 180000;
    const startedAt = Date.now();
    while (alive(innerPid) && Date.now() - startedAt < maxWaitMs) {
      await sleep(500);
    }
    if (alive(innerPid)) {
      log(logPath, 'guard：内层助手还在跑（pid=' + String(innerPid) + '），按超时退出，不插手');
      return;
    }
    log(logPath, 'guard：内层助手已退出（pid=' + String(innerPid) + '）');
  }

  log(logPath, 'guard：兜底拉起一次（已经开着的话会被叫到前台）');
  await launchAppAndFocus(payload, logPath);
}

/** 入口。 */
async function main() {
  const args = process.argv.slice(2);
  const flag = args[0] === '--outer' || args[0] === '--guard' ? args[0] : '';
  const raw = flag === '' ? args[0] : args[1];

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error('[restart-helper] payload 解析失败：', error);
    process.exit(2);
  }

  // 缺省值兜一层：助手要能在被手工调用（排障）时也干活。
  payload = {
    initialDelayMs: 900,
    graceMs: 800,
    pollMs: 250,
    waitExitMs: 30000,
    waitPortMs: 15000,
    guardDelayMs: 70000,
    focusNudge: true,
    focusWaitMs: 45000,
    ...payload,
  };

  let logPath = typeof payload.logPath === 'string' && payload.logPath.length > 0 ? payload.logPath : '';
  if (logPath === '') {
    if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
      logPath = join(process.env.DSH_HOME, 'dsh-functions-restart.log');
    } else {
      try {
        logPath = join(tmpdir(), 'dsh-functions-restart.log');
      } catch (error) {
        logPath = join(dirname(SELF), 'dsh-functions-restart.log');
      }
    }
  }

  // 防御：桌面端的整树关闭逻辑只有 Windows 有；macOS/Linux 的宿主（如果被手工调用）
  // 不假装重启 —— 记一行日志直接退出。
  if (payload.mode === 'desktop' && process.platform !== 'win32') {
    log(logPath, '跳过：desktop 模式只支持 Windows（当前 ' + process.platform + '）');
    process.exit(4);
  }

  // 外层：再起一个脱离父子关系的内层（以及安全网），然后立刻自杀。
  if (flag === '--outer') {
    log(logPath, 'outer：起内层');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const options = { detached: true, stdio: 'ignore', windowsHide: true, env, cwd: dirname(SELF) };
    // 注意：可执行文件是 process.execPath（Node 或 Electron-as-node），SELF 是它的脚本参数。
    const inner = spawn(process.execPath, [SELF, raw], options);
    inner.unref();

    // 等内层「真的起来了」再退：调用方（插件）就是靠这里的退出码判断
    // 「排期成功了」还是「根本没跑起来」。以前不管三七二十一 exit(0)，
    // 于是 spawn 失败时用户只会看到「已经排好一次重启了」而什么都没发生。
    const innerStarted = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      inner.once('spawn', () => done(true));
      inner.once('error', (error) => {
        log(logPath, 'outer：内层启动失败 ' + String(error && error.message));
        done(false);
      });
      setTimeout(() => done(inner.pid !== undefined), 2000);
    });

    if (payload.mode === 'desktop') {
      // 安全网要盯着内层的 pid 判断它是否还活着（映像名判断不可靠，2026-10-18 审查）。
      const guardPayload = { ...payload, innerPid: inner.pid };
      const guard = spawn(process.execPath, [SELF, '--guard', JSON.stringify(guardPayload)], options);
      guard.on('error', (error) => log(logPath, 'outer：安全网启动失败 ' + String(error && error.message)));
      guard.unref();
      log(logPath, 'outer：内层 pid=' + String(inner.pid) + ' 安全网 pid=' + String(guard.pid) + ' 启用=' + String(innerStarted));
    } else {
      log(logPath, 'outer：内层 pid=' + String(inner.pid) + ' 启用=' + String(innerStarted));
    }
    process.exit(innerStarted ? 0 : 3);
  }

  try {
    if (flag === '--guard') await runGuard(payload, logPath);
    else if (payload.mode === 'desktop') await runDesktop(payload, logPath);
    else await runCli(payload, logPath);
  } catch (error) {
    log(logPath, '助手异常：' + String(error && error.stack ? error.stack : error));
  }
  process.exit(0);
}

// 没有 node:module 的 Electron-as-node 也能跑：这里不做任何 import.meta.main 判断，
// 本文件只会被当作脚本入口执行。
main();
