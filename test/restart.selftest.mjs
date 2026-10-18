/**
 * dsh-functions 自检（内置「重启 DSH」子路径插件 part）—— 不碰真进程、不重启任何东西。
 *
 *   ELECTRON_RUN_AS_NODE=1 "J:\DSH\DeepSeek Harness.exe" test/restart.selftest.mjs
 *   （普通 node 也可以：node test/restart.selftest.mjs）
 *
 * 覆盖：
 *   1 两个 JS 文件语法；
 *   2 任务判据（对齐桌面外壳 update-tasks 口径，含查询失败时如实说不知道）；
 *   3 往「功能」注册的这条功能：形状、两级确认的分级取法、有任务/没任务两种文案；
 *   4 平台判据：Windows 桌面支持；macOS/Linux 桌面要明确说「不支持」，不许假装重启；
 *   5 助手 payload 的形状（端口从 webServer.getOrigin() 推，不再写死 19387）；
 *   6 重启助手：pid 与映像名对不上时必须「中止」而不是杀错进程；
 *   7 可移植性回归：源码里不许再出现本机路径、写死端口、房间路径。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const HELPER = join(PACKAGE_ROOT, 'restart-helper.js');
const INDEX = join(PACKAGE_ROOT, 'restart.js');
const WIN = process.platform === 'win32';

let failures = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    console.log('  ok  ' + name);
  } else {
    failures += 1;
    console.log('  XX  ' + name + (extra === '' ? '' : ' -- ' + extra));
  }
};

const makeAgents = (list) => ({ list: () => list });
const makeJobs = (byAgent) => ({ list: (agentId) => byAgent[String(agentId)] ?? [] });

/** 假的宿主上下文：get() 给服务，functions.register 收注册项。 */
function fakeCtx({ agents, jobs, server, registered } = {}) {
  const ctx = {
    get(name) {
      if (name === 'agents') return agents;
      if (name === 'jobs') return jobs;
      if (name === 'webServer') return server;
      return undefined;
    },
    functions: {
      register(entry) {
        registered.push(entry);
        return () => undefined;
      },
    },
  };
  return ctx;
}

async function testSyntax() {
  console.log('1 语法');
  for (const file of [INDEX, HELPER]) {
    let ok = true;
    let message = '';
    const source = readFileSync(file, 'utf8');
    try {
      const stripped = source
        .replace(/^import\s[\s\S]*?from\s+'[^']*';?$/gm, '')
        .replace(/^export default\s+/gm, 'const __default__ = ')
        .replace(/^export\s+/gm, '')
        .replace(/import\.meta\.url/g, "'file:///selftest-dummy.js'");
      new Script('(async () => {' + stripped + '})()', { filename: file });
    } catch (error) {
      ok = false;
      message = String(error && error.message);
    }
    check(file.slice(PACKAGE_ROOT.length + 1) + ' 语法通过', ok, message);
  }
}

async function testActiveWork(mod) {
  console.log('2 任务判据');
  const { inspectActiveWork } = mod;
  const busyAgent = { id: 'sess-1', title: '正在问问题', status: 'running', inbox: { nextTurn: [], nextStep: [] } };
  const idleAgent = { id: 'sess-2', title: '闲着', status: 'idle', inbox: { nextTurn: [], nextStep: [] } };
  const queuedAgent = { id: 'sess-3', title: '压着待办', status: 'idle', inbox: { nextTurn: [{ id: 'm1' }], nextStep: [] } };

  check('没有任务时 active=false', inspectActiveWork(fakeCtx({ agents: makeAgents([idleAgent]), jobs: makeJobs({}) })).active === false);
  check('会话 running 时 active=true', inspectActiveWork(fakeCtx({ agents: makeAgents([busyAgent]), jobs: makeJobs({}) })).active === true);
  check('收件箱还有待办时 active=true', inspectActiveWork(fakeCtx({ agents: makeAgents([queuedAgent]), jobs: makeJobs({}) })).active === true);
  check(
    '后台任务 running 时 active=true',
    inspectActiveWork(fakeCtx({ agents: makeAgents([idleAgent]), jobs: makeJobs({ undefined: [{ id: 'job-1', status: 'running' }] }) })).active === true,
  );
  const missing = inspectActiveWork({ get: () => undefined });
  check('缺服务时 available=false（不谎报没有任务）', missing.available === false && missing.active === false);
  const failingJobs = inspectActiveWork(fakeCtx({ agents: makeAgents([idleAgent]), jobs: { list: () => { throw new Error('jobs 挂了'); } } }));
  check('jobs 查询抛错时 available=false', failingJobs.available === false && failingJobs.active === false);
}

async function testRegistration(mod) {
  console.log('3 注册到「功能」里的这一条');
  const { apply, inject } = mod;
  check("inject 里有 'functions'", Array.isArray(inject) && inject.includes('functions'), JSON.stringify(inject));

  const registered = [];
  const ctx = fakeCtx({
    agents: makeAgents([{ id: 'sess-1', title: '跑着的会话', status: 'running', inbox: { nextTurn: [], nextStep: [] } }]),
    jobs: makeJobs({}),
    server: { getOrigin: () => 'http://127.0.0.1:53256' },
    registered,
  });
  apply(ctx, { dryRun: true });

  check('注册了恰好一条功能', registered.length === 1, String(registered.length));
  const entry = registered[0];
  if (entry === undefined) return;
  check('id = restart-dsh', entry.id === 'restart-dsh', String(entry.id));
  check('title = 重启 DSH（Windows）', WIN ? entry.title === '重启 DSH' : typeof entry.title === 'string', String(entry.title));
  check('分组 = 系统', entry.group === '系统', String(entry.group));
  check('说明第二行写了这是内置功能', String(entry.description).includes('dsh-functions（内置）'), String(entry.description));
  check('有 run()', typeof entry.run === 'function');
  check('有 prepare()', typeof entry.prepare === 'function');

  if (WIN) {
    const stage0 = entry.prepare(0);
    check('第 1 级：只交代后果，不吓人', stage0.danger !== true && stage0.confirmText === '继续', JSON.stringify(stage0));
    check('第 1 级：标题是「重启 DSH」', stage0.title === '重启 DSH', String(stage0.title));

    const stage1Busy = entry.prepare(1);
    check(
      '第 2 级：有任务时就是那句原话',
      stage1Busy.message === '有正在进行中的任务，确定要重启DSH吗？',
      String(stage1Busy.message),
    );
    check('第 2 级：有任务时是危险色 + 「仍要重启」', stage1Busy.danger === true && stage1Busy.confirmText === '仍要重启');
    check('第 2 级：把在跑的东西列出来', stage1Busy.detail.includes('跑着的会话'), String(stage1Busy.detail));

    check('第 3 级：没有更多确认了', entry.prepare(2) === null);

    // 干净环境：第 2 级换成常规问法
    const cleanRegistered = [];
    apply(fakeCtx({
      agents: makeAgents([{ id: 'sess-2', title: '闲着', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }]),
      jobs: makeJobs({}),
      registered: cleanRegistered,
    }), {});
    const cleanStage1 = cleanRegistered[0].prepare(1);
    check('第 2 级：没任务时问「确定要重启 DSH 吗？」', cleanStage1.message === '确定要重启 DSH 吗？', String(cleanStage1.message));
    check('第 2 级：没任务时不标红', cleanStage1.danger !== true && cleanStage1.confirmText === '重启');

    // 服务缺失：不许假装没有任务
    const blindRegistered = [];
    apply({ get: () => undefined, functions: { register: (item) => { blindRegistered.push(item); return () => undefined; } } }, {});
    const blindStage1 = blindRegistered[0].prepare(1);
    check('第 2 级：查不到任务时如实说「无法确认」', blindStage1.detail.includes('无法确认'), String(blindStage1.detail));
    check('第 2 级：查不到任务时不标红、也不说「没有任务」', blindStage1.danger !== true && !blindStage1.detail.includes('现在没有检测到'));
  } else {
    const stage0 = entry.prepare(0);
    check('非 Windows 桌面：明说「只支持 Windows」', String(stage0.message).includes('只支持 Windows'), String(stage0.message));
    check('非 Windows 桌面：只有一个「知道了」按钮', stage0.cancelText === '' && state0ButtonsOk(stage0), JSON.stringify(stage0));
  }

  const outcome = await entry.run();
  check('dryRun 下 run 只回计划、不动手', typeof outcome.message === 'string' && outcome.message.startsWith('dryRun'), JSON.stringify(outcome));
}

/** 小工具：非 Windows 的 stage0 只应该有一个确认按钮。 */
function state0ButtonsOk(spec) {
  return typeof spec.confirmText === 'string' && spec.confirmText.length > 0;
}

function testPlatformHelpers(mod) {
  console.log('4 平台判据');
  const { isDesktopRestartSupported } = mod;
  check('Windows 桌面：支持', isDesktopRestartSupported('win32') === true);
  check('macOS 桌面：不支持（要明说）', isDesktopRestartSupported('darwin') === false);
  check('Linux 桌面：不支持（要明说）', isDesktopRestartSupported('linux') === false);

  // 真模拟一次非 Windows 桌面：临时改 process.platform + 让 argv 里出现桌面入口。
  const savedPlatform = process.platform;
  const savedArgv = process.argv;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.argv = [...savedArgv, '--dsh-desktop-host'];
    const mode = mod.detectMode();
    check('非 Windows 桌面 -> mode=unsupported（不是 cli，不许假装能重启）', mode.mode === 'unsupported', String(mode.mode));
    const registered = [];
    mod.apply({ get: () => undefined, functions: { register: (item) => { registered.push(item); return () => undefined; } } }, {});
    check('非 Windows 桌面：注册项的标题会标出「仅 Windows 桌面版」', String(registered[0]?.title).includes('仅 Windows 桌面版'), String(registered[0]?.title));
    const stage0 = registered[0]?.prepare(0);
    check('非 Windows 桌面：第 1 级明说「只支持 Windows」', String(stage0?.message).includes('只支持 Windows'), String(stage0?.message));
  } finally {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    process.argv = savedArgv;
  }
}

function testPayload(mod) {
  console.log('5 助手 payload 的形状');
  const { buildRestartPayload, webPortOf, helperLogPath } = mod;

  const desktopPayload = buildRestartPayload(
    { get: (name) => (name === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:4321' } : undefined) },
    {},
    { mode: 'desktop', pid: 21728, ppid: 20568, execPath: 'J:\\DSH\\DeepSeek Harness.exe' },
  );
  check('desktop：appPid 取父进程', desktopPayload.appPid === 20568, String(desktopPayload.appPid));
  check('desktop：appExec 是可执行文件本身', desktopPayload.appExec === 'J:\\DSH\\DeepSeek Harness.exe');
  check('desktop：port 从 webServer.getOrigin() 解析', desktopPayload.port === 4321, String(desktopPayload.port));
  check('desktop：带上安全网延时', Number(desktopPayload.guardDelayMs) > 0, String(desktopPayload.guardDelayMs));
  check('desktop：不会把本进程当成应用', desktopPayload.appPid !== 21728);
  check('desktop：默认要把窗口叫到前台', desktopPayload.focusNudge === true, String(desktopPayload.focusNudge));
  check('desktop：叫窗口前会等端口（带上超时）', Number(desktopPayload.focusWaitMs) > 0, String(desktopPayload.focusWaitMs));

  const legacyPayload = buildRestartPayload({ get: () => ({ port: 19387 }) }, {}, { mode: 'desktop', pid: 1, ppid: 2, execPath: 'app.exe' });
  check('desktop：老面板只有 port 字段时也能取到', legacyPayload.port === 19387, String(legacyPayload.port));

  const noPortCtx = { get: (name) => (name === 'webServer' ? { getOrigin: () => { throw new Error('还没监听'); } } : undefined) };
  check('拿不到端口时返回 0（助手会跳过端口探测，不再写死 19387）', webPortOf(noPortCtx) === 0, String(webPortOf(noPortCtx)));

  const cliPayload = buildRestartPayload({ get: () => undefined }, {}, { mode: 'cli', pid: 4242, ppid: 1, execPath: 'node' });
  check('cli：pid 是本进程', cliPayload.pid === 4242 && cliPayload.mode === 'cli');
  check('cli：argv 记住原命令', Array.isArray(cliPayload.argv) && cliPayload.argv.length > 0);

  const logPath = helperLogPath({});
  const expectedDefault =
    (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0)
      ? join(process.env.DSH_HOME, 'dsh-functions-restart.log')
      : (typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE.length > 0)
        ? join(process.env.USERPROFILE, '.dsh', 'dsh-functions-restart.log')
        : join(tmpdir(), 'dsh-functions-restart.log');
  check('默认日志路径由环境变量推出来（源码里没有写死路径）', logPath === expectedDefault, logPath + ' vs ' + expectedDefault);
  check('config.logPath 覆盖仍然生效', helperLogPath({ logPath: 'C:\\temp\\x.log' }) === 'C:\\temp\\x.log');
}

async function testHelperRefusesWrongPid() {
  console.log('6 重启助手：杀错人之前先核对');
  if (!WIN) {
    console.log('  --  非 Windows，跳过（桌面整树关闭只在 Windows 上实现）');
    return;
  }
  const scratch = join(PACKAGE_ROOT, '.selftest');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const logPath = join(scratch, 'helper.log');

  const probe = spawnSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', 'IMAGENAME eq explorer.exe'], { encoding: 'utf8', windowsHide: true });
  const match = /"explorer\.exe","(\d+)"/i.exec(probe.stdout ?? '');
  if (match === null) {
    console.log('  --  找不到 explorer.exe，跳过这条');
    rmSync(scratch, { recursive: true, force: true });
    return;
  }
  const explorerPid = Number(match[1]);
  const payload = {
    mode: 'desktop',
    appPid: explorerPid,
    appExec: process.execPath,
    port: 65533,
    initialDelayMs: 100,
    graceMs: 200,
    pollMs: 100,
    waitExitMs: 500,
    waitPortMs: 300,
    guardDelayMs: 2500,
    logPath,
  };
  const outer = spawnSync(process.execPath, [HELPER, '--outer', JSON.stringify(payload)], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  check('外层助手能启动', outer.status === 0, String(outer.stderr ?? '').slice(0, 200));

  let text = '';
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (existsSync(logPath)) {
      text = readFileSync(logPath, 'utf8');
      if (text.includes('中止')) break;
    }
  }
  check('写下了日志', text.length > 0);
  check('pid 对不上时中止，不杀进程', text.includes('中止'), text.split('\n').slice(-3).join(' | '));
  const alive = spawnSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', 'PID eq ' + String(explorerPid)], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  check('explorer 还活着', alive.includes('explorer.exe'));
  // 等安全网（guardDelayMs 2.5s）也退出，再清理，免得它把日志目录写回来。
  await new Promise((resolve) => setTimeout(resolve, 3200));
  rmSync(scratch, { recursive: true, force: true });
}

function testPortability() {
  console.log('7 可移植性回归');
  const jsOnly = readFileSync(INDEX, 'utf8') + '\n' + readFileSync(HELPER, 'utf8');
  const pkgText = readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgText);
  const patchText = readFileSync(join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
  // 房间源码版允许在【自己的】cordis.patch.yml 里带房间日志路径（硬要求 1）；
  // 公开版（author 不是 Chinese_room）必须连补丁一起干净。运行时 JS 两边都不许有本机路径。
  const isPublicCopy = pkg.author !== 'Chinese_room';
  const combined = isPublicCopy ? jsOnly + '\n' + patchText : jsOnly;
  check('运行文件里没有本机 profile 路径', !combined.includes('.dsh\profiles\desktop') && !combined.includes('.dsh/profiles/desktop'));
  check('运行文件里没有 D:/Documents 这类本机绝对路径', !/D:[\\/]Documents/i.test(combined));
  check('运行文件里没有写死用户名 Administrator', !combined.includes('Administrator'));
  check('运行文件里没有写死 19387 端口', !combined.includes('19387'));
  check('运行文件里没有写死可执行文件名（DeepSeek Harness.exe）', !combined.includes('DeepSeek Harness.exe'));

  check('package.json 声明了子路径插件 dsh-functions/restart 的导出', String(pkg.exports?.['./restart'] ?? '') === './restart.js');
  check('package.json 导出子路径展示元数据（./restart/icon 与 locale）',
    typeof pkg.exports?.['./restart/icon'] === 'string' && typeof pkg.exports?.['./restart/locale/*.json'] === 'string');
  check('files 里带上了 restart.js / restart-helper.js / restart 资源',
    Array.isArray(pkg.files) && pkg.files.includes('restart.js') && pkg.files.includes('restart-helper.js') && pkg.files.includes('restart/icon.svg'));
  check('cordis.patch.yml 同时插了功能栏行与内置重启行',
    patchText.includes('id: functions-menu') && patchText.includes('name: dsh-functions/restart'));
}

async function main() {
  console.log('dsh-functions 内置重启自检\n');
  const mod = await import(pathToFileURL(INDEX).href);
  await testSyntax();
  await testActiveWork(mod);
  await testRegistration(mod);
  testPlatformHelpers(mod);
  testPayload(mod);
  await testHelperRefusesWrongPid();
  testPortability();
  console.log('\n' + (failures === 0 ? '全部通过' : '失败 ' + String(failures) + ' 项'));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('自检自身出错：', error);
  process.exitCode = 2;
});
