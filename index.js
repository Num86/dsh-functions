/**
 * dsh-functions —— Host 半边：功能注册表 + 三条路由。
 *
 * 为什么要这一半（2026-10-05 人反馈「接口有点问题，我后面不大好放插件」）：
 *   第一版的「功能」只认【客户端注册】：要往菜单里加一条，得写一个
 *   window.__ModuleLoader__.load({...}) 的客户端 bundle。那对绝大多数插件是反的 ——
 *   DSH 插件的活基本都在 Host 半边（敲门、端菜、合并记忆、换会话都是宿主在干）。
 *
 * 现在两条路都通，而且【宿主这条路不需要写任何客户端代码】：
 *
 *   宿主插件（推荐）：ctx.functions.register({ id, title, run })
 *     本插件把入口经 /api/dshFunctions/list 递给浏览器；用户点一下，浏览器先问
 *     /prepare 拿确认窗内容，再 POST /run 让宿主干活。
 *
 *   客户端插件（只有界面相关的功能才需要）：
 *     inject: ['functions'] -> ctx.functions.register({ id, title, run })
 *     或直接 globalThis.__DSH_FUNCTIONS__.register(...)
 *
 * 三条路由（路径必须 /api 开头，否则 assertFetchRoute 直接拒）：
 *   GET  /api/dshFunctions/list     列出所有【宿主】注册的功能（不含 run/prepare）
 *   POST /api/dshFunctions/prepare  要确认计划：{ id } -> { confirms: [...] }
 *   POST /api/dshFunctions/run      动手：{ id, confirm: 'yes' }
 *
 * 确认窗只能【声明】。文案可以是动态算出来的（prepare 是函数），但必须是 JSON ——
 * 客户端要照着画弹窗，函数过不了链路。
 *
 * 不 import 任何 Harness 包（junction 进来的包按真实路径解析，解析不到 profile 的
 * node_modules）。只用 node: 内置 + ctx 上的服务。
 */

import { spawn } from 'node:child_process';

/** Loader 行名。 */
export const name = 'functions-menu';

/** 需要 connection 服务来开 HTTP 路由。 */
export const inject = ['connection'];

/** 列出宿主注册的功能。 */
const LIST_PATH = '/api/dshFunctions/list';
/** 取一条功能的确认计划。 */
const PREPARE_PATH = '/api/dshFunctions/prepare';
/** 真正执行一条功能。 */
const RUN_PATH = '/api/dshFunctions/run';

/** shell 形态默认超时。 */
const DEFAULT_SHELL_TIMEOUT_MS = 120000;
/** shell 回传文本上限：太长会把界面上的提示撑爆。 */
const SHELL_OUTPUT_LIMIT = 4000;

/** 统一的 JSON 响应。 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 把任意值收敛成能 JSON 化的东西（函数、循环引用都过不了链路）。 */
function jsonSafe(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return { note: '结果无法 JSON 化，已丢弃', text: String(value) };
  }
}

/**
 * 把「确认窗」的几种写法收敛成一串：
 *   confirms: [..]              多级
 *   confirm: {..}               一级
 *   { title, message, ... }     直接把确认窗本身当返回值（prepare 最常见的写法）
 */
function normalizeConfirms(input) {
  if (Array.isArray(input.confirms)) return input.confirms;
  if (typeof input.confirm === 'object' && input.confirm !== null) return [input.confirm];
  // 注意：**不能只看 title**。每条注册项都有 title（功能名），
  // 只看它等于「所有没写确认窗的功能都默认带一个空确认框」——
  // 2026-10-16 在独立自检里抓到过这个（{id:'c.none',title:'D'} 竟然返回了 [{title:'D'}]）。
  // 要有 message，或者明确写了按钮文案 / detail，才算「把确认窗本身当返回值」。
  if (typeof input.message === 'string' || typeof input.detail === 'string'
    || typeof input.confirmText === 'string' || typeof input.cancelText === 'string') return [input];
  return [];
}

/** 一条注册项收敛成内部形状；run 与 shell 至少要有一个。 */
function normalizeEntry(input) {
  if (typeof input !== 'object' || input === null) throw new Error('register() 需要一个对象');
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (id.length === 0) throw new Error('功能必须有非空 id');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) throw new Error('功能 ' + id + ' 必须有 title');
  const shell = typeof input.shell === 'object' && input.shell !== null ? input.shell : null;
  // 二级菜单的父项（容器）自己没有动作：声明 submenu: true 即可不带 run。
  const isSubmenuParent = input.submenu === true;
  if (typeof input.run !== 'function' && shell === null && !isSubmenuParent) {
    throw new Error('功能 ' + id + ' 必须有 run() 或 shell（二级菜单的父项可以只写 submenu: true）');
  }
  return Object.freeze({
    id,
    title,
    pinned: input.pinned === true,
    parent: typeof input.parent === 'string' ? input.parent.trim() : '',
    submenu: isSubmenuParent,
    description: typeof input.description === 'string' ? input.description : '',
    icon: typeof input.icon === 'string' ? input.icon : '',
    group: typeof input.group === 'string' ? input.group : '',
    order: Number.isFinite(input.order) ? Number(input.order) : 100,
    keywords: Array.isArray(input.keywords) ? input.keywords.filter((item) => typeof item === 'string') : [],
    hidden: input.hidden === true,
    prepare: typeof input.prepare === 'function' ? input.prepare : null,
    staticConfirms: normalizeConfirms(input),
    run: typeof input.run === 'function' ? input.run : null,
    shell,
  });
}

/** 确认窗字段收敛：只留客户端认识的键。 */
function normalizeConfirmSpec(spec) {
  const input = typeof spec === 'object' && spec !== null ? spec : {};
  const out = {};
  for (const key of ['title', 'message', 'detail', 'confirmText', 'cancelText']) {
    if (typeof input[key] === 'string') out[key] = input[key];
  }
  if (input.danger === true) out.danger = true;
  return out;
}

/** 跑一条 shell 功能：返回 { exitCode, stdout, stderr }。 */
function runShell(shell, cwdFallback) {
  return new Promise((resolve) => {
    const command = typeof shell.command === 'string' ? shell.command : '';
    if (command.length === 0) {
      resolve({ exitCode: null, stdout: '', stderr: 'shell.command 是空的' });
      return;
    }
    const args = Array.isArray(shell.args) ? shell.args.map((item) => String(item)) : [];
    const timeoutMs = Number.isFinite(shell.timeoutMs) ? Number(shell.timeoutMs) : DEFAULT_SHELL_TIMEOUT_MS;
    let child;
    try {
      child = spawn(command, args, {
        cwd: typeof shell.cwd === 'string' && shell.cwd.length > 0 ? shell.cwd : cwdFallback,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '启动失败：' + String(error && error.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (error) {
        /* 已经退了 */
      }
      finish({ exitCode: null, stdout, stderr: '超时（' + String(timeoutMs) + 'ms），已请求结束' });
    }, timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-SHELL_OUTPUT_LIMIT); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-SHELL_OUTPUT_LIMIT); });
    child.once('error', (error) => finish({ exitCode: null, stdout, stderr: String(error && error.message) }));
    child.once('close', (code) => finish({ exitCode: code, stdout, stderr }));
  });
}

/** 建一个注册表。 */
export function createRegistry(ctx) {
  const entries = new Map();
  const listeners = new Set();
  let sequence = 0;

  const snapshot = () =>
    [...entries.values()].sort((left, right) => (left.order !== right.order ? left.order - right.order : left.seq - right.seq));

  const notify = () => {
    const ids = snapshot().map((entry) => entry.id);
    for (const listener of [...listeners]) {
      try {
        listener(ids);
      } catch (error) {
        console.error('[dsh-functions] 订阅者抛错：', error);
      }
    }
  };

  return {
    /** 注册一条功能；返回注销函数。 */
    register(input) {
      // 注意：normalizeEntry 返回的是【冻结】过的对象。冻了之后再 Object.assign 加字段，
      // 在 ESM（永远是严格模式）里会直接抛 TypeError —— 2026-10-06 凌晨就是这么把
      // 「重启 DSH」弄没的：register 抛 -> 插件 apply 抛 -> 整条功能没注册上，菜单空的。
      // 所以顺序必须是：先补 seq，再冻结。
      const entry = Object.freeze({ ...normalizeEntry(input), seq: sequence++ });
      entries.set(entry.id, entry);
      notify();
      return () => {
        if (entries.get(entry.id) === entry) {
          entries.delete(entry.id);
          notify();
        }
      };
    },
    unregister(id) {
      const removed = entries.delete(String(id));
      if (removed) notify();
      return removed;
    },
    get(id) {
      return entries.get(String(id));
    },
    /** 给浏览器的清单：不带 run/prepare（函数过不了链路）。 */
    list() {
      return snapshot().map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        icon: entry.icon,
        group: entry.group,
        order: entry.order,
        hidden: entry.hidden,
        keywords: entry.keywords,
        pinned: entry.pinned,
        parent: entry.parent,
        submenu: entry.submenu,
        source: 'host',
        needsConfirm: entry.prepare !== null || entry.staticConfirms.length > 0,
        hasShell: entry.shell !== null,
      }));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('subscribe() 需要函数');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * 取第 stage 级确认计划；null = 没这条功能，[] = 没有更多确认了。
     *
     * 分级而不是一次给全，是为了让「下一级要问什么」能在上一级点完之后才算 ——
     * 「有没有正在进行中的任务」这种话，隔一次确认就可能过期。
     * 静态 confirm/confirms 只有第 0 级。
     */
    async prepare(id, stage = 0, context = {}) {
      const entry = entries.get(String(id));
      if (entry === undefined) return null;
      const index = Number.isSafeInteger(stage) && stage >= 0 ? stage : 0;
      if (entry.prepare === null) {
        return index === 0 ? entry.staticConfirms.map(normalizeConfirmSpec) : [];
      }
      const raw = await entry.prepare(index, context);
      if (raw === null || raw === undefined) return [];
      const list = Array.isArray(raw) ? raw : normalizeConfirms(raw);
      return list.map(normalizeConfirmSpec);
    },
    /** 执行一条功能：{ ok, result | error, status }。 */
    async execute(id, context = {}) {
      const entry = entries.get(String(id));
      if (entry === undefined) return { ok: false, error: '没有这条功能：' + String(id), status: 404 };
      try {
        if (entry.run !== null) {
          const result = await entry.run({
            id: entry.id,
            ctx,
            log: (message) => console.log('[dsh-functions] ' + entry.id + '：' + String(message)),
            // 浏览器那边报上来的「用户正在看哪个会话」。有了它，需要往会话里送东西的功能
            // （例如「加载功能」）就不用去猜，也不必依赖别的插件提供的 roomFrontSession 服务。
            session: typeof context.sessionId === 'string' ? context.sessionId : '',
          });
          return { ok: true, result: jsonSafe(result) };
        }
        return { ok: true, result: jsonSafe(await runShell(entry.shell, process.cwd())) };
      } catch (error) {
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
        console.error('[dsh-functions] 功能 ' + entry.id + ' 执行失败：', error);
        return { ok: false, error: message, status: 500 };
      }
    },
  };
}

// ---------------------------------------------------------------- 内置功能：加载功能
//
// 人 2026-10-16 的要求：在功能栏最上面置顶一条「加载功能」。
// dsh 没有「在工作区新开会话」的能力，所以这条功能走「把一段指令当成用户消息送进当前会话」这个路子：
// **把一段指令当成用户消息送进当前会话**，由会话里的 dsh 去干活（找插件、列编号、读 README、接进来）。

/** 这条功能要送进会话的指令。会话里的 dsh 按它干活。 */
const LOAD_INSTRUCTION = [
  '【功能栏 - 加载功能】请把「功能」栏里还没接上的插件功能找出来，列成编号清单让我挑，然后按你读到的 README 接进去。',
  '',
  '背景：「功能」栏是插件 dsh-functions 提供的，它列出别的插件注册进来的一键动作。一条功能的两种加法：',
  '  1) 宿主半边（首选）：插件 inject [\'functions\']，apply 里 ctx.functions.register({ id, title, run })；',
  '     要确认窗加 prepare(stage)；要跑外部命令用 shell: { command }；',
  '     二级菜单：父项写 submenu: true，子项写 parent: \'<父项 id>\'；要置顶写 pinned: true。',
  '  2) 客户端半边：客户端注册，用来打开界面（打开设置里某一节、打开某个面板、渲染某个组件）。',
  '能落到宿主半边的就不落客户端；只有这个功能本质上是「打开某个界面」时才用客户端。',
  '',
  '按下面四步做。第一步到第三步之间**不要改任何文件**：',
  '',
  '一、找出装了什么（非官方）',
  '  手上有 plugin_manager 工具（创造模式）就直接用它列 bundles，比读文件准；没有就自己找当前 profile：',
  '    - 环境变量 DSH_PROFILE_DIR 就是 profile 目录；没有它时，Windows 一般在',
  '      %USERPROFILE%\\.dsh\\profiles\\<profile 名>，macOS/Linux 在 ~/.dsh/profiles/<profile 名>（桌面版通常是 desktop）。',
  '    - 读那个目录下的 package.json（dependencies 与 dsh.profile.bundles），再核对 node_modules 里实际存在的目录。',
  '  列出**非官方**插件（官方 = @deepseek-ai/*），带版本，并标出它有没有 dsh.bundle / dsh.client 声明。',
  '  一个非官方插件都没有时，照实说「没有可加载的」，不要编；可以建议我先把要接的插件装上。',
  '',
  '二、逐个查它们对外提供什么（怎么用 / 触发 / 进入 / 设置）',
  '  对每个插件按这个顺序找证据，**找不到就写「没找到」，不要编**：',
  '    1. 它自己的 README / README.zh.md（最权威）',
  '    2. cordis.patch.yml、package.json 的 dsh 段（bundle / client / inject）',
  '    3. 源码注册现场：slots.inject / slots.register、ctx.provide、ctx.layout.selectPanel、',
  '       commands、shortcuts、settings.section、connection.fetch.register（HTTP 路由）',
  '    4. 它导出给外部用的东西（exports.*、服务名、关键词、路由路径）',
  '  每条记成一行：插件 / 能给「功能」栏提供什么动作 / 触发方式 / 证据（文件:行）。',
  '',
  '三、列编号清单，然后**停下来等我回数字**',
  '  用 1 2 3 ... 编号；每条写：插件名 + 一句话 + 你建议接成哪一条功能（宿主还是客户端）+ 证据。',
  '  已经在「功能」栏里的标「已在」，别重复列。列完就停，**不要自己动手改文件**。',
  '',
  '四、等我回数字之后',
  '  1. 读那个插件的 README，确认它允许/建议怎么被外部调用；接口形式必须**严谨推断** ——',
  '     严禁按名字猜、按别的插件套、按截图猜（见 dsh-functions 的 README「严谨猜测插件接口形式」一节）。',
  '     它确实没有对外接口时，照实说明「只能走 X」，并把 X 当接口用，写清证据。',
  '  2. 按「功能」插件的注册方式接进去（宿主半边优先）。新插件的源码放到**你自己工作区里的新目录**',
  '     （例如当前工作目录下的 dsh-plugins/<插件名>，或我指定的目录）；不要放进 DSH 安装目录（升级会覆盖），',
  '     也不要放进 profile 目录本身。插件目录的绝对路径按这台机器的实际情况取，别照抄文档里的示例路径。',
  '     装法按这个顺序挑：',
  '       1) 有 plugin_manager 工具（创造模式）：用 install_bundle，target 给插件目录的绝对路径；',
  '          不要手改 profile 的 package.json / cordis.patch.yml —— 安装器会写。',
  '       2) 没有 plugin_manager：用 DSH 的插件页「添加插件」填插件目录的绝对路径（官方入口，最稳）；',
  '          没有界面入口时，才用 profile 的 link: 依赖 + dsh.profile.bundles 一行 + node_modules 里的 Junction 手动装。',
  '     新插件若将来要公开，按创造模式交付清单补 locale/en.json、locale/zh.json（meta.title/description）',
  '     和 icon.svg，并在 package.json 里声明 dsh.bundle / dsh.client、exports 的 ./locale/*.json 与 icon；',
  '     不补也能跑，只是插件管理器里没有标题和图标。',
  '     客户端半边的条目要跟着 slots 账本实时上下线（对方不在就不注册）。',
  '  3. 每个新插件配一份最小自检（能跑、能证明注册成功即可；没有现成例子就写个 smoke test），跑过才算完。',
  '  4. 装完宿主半边要重启 DSH 才生效（有 HMR 的除外）；客户端半边刷新页面即可。',
  '  5. 记账按你所在项目自己的规矩；没有规定就写清改了哪个文件、怎么验的、还差什么。',
  '',
  '（这条指令是「功能」栏里的「加载功能」发出来的，等价于你自己敲了上面这段话。）',
].join('\n');

/**
 * 目标会话从哪来：优先**浏览器报上来的**（功能客户端从 uiSession 读的），
 * 其次是别的插件开放的 roomFrontSession 服务（可选依赖）。都没有就拒 —— 绝不按「最近动过」猜。
 */
function resolveSession(ctx, reported) {
  if (typeof reported === 'string' && reported.length > 0) return { id: reported, how: '界面报的会话' };
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('roomFrontSession') : null;
    if (service && typeof service.current === 'function') {
      const now = service.current();
      if (now && typeof now.id === 'string' && now.id.length > 0) return { id: now.id, how: 'roomFrontSession 服务' };
    }
  } catch (error) { /* 没有就算了 */ }
  return { id: '', how: '' };
}

/** 会话在忙什么；空串 = 空闲。与其它「往会话里送东西」的功能同一套判据。 */
function busyWhy(ctx, sessionId) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null;
    if (!agents || typeof agents.list !== 'function') return '';
    const hit = agents.list().find((item) => String(item.id) === String(sessionId));
    if (!hit) return '';
    const inbox = hit.inbox ?? {};
    const pending = (Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0) + (Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0);
    if (hit.status === 'running') return '状态 running';
    if (pending > 0) return '收件箱还有 ' + String(pending) + ' 条待办';
    return '';
  } catch (error) {
    return '';
  }
}

/** 往会话里送一条用户消息（source 必须是 user，否则送不进去）。 */
function sendToSession(ctx, sessionId, text, idPrefix) {
  let agents = null;
  try { agents = typeof ctx.get === 'function' ? ctx.get('agents') : null; } catch (error) { agents = null; }
  if (!agents || typeof agents.get !== 'function') return { ok: false, why: '拿不到 agents 服务' };
  let handle;
  try { handle = agents.get(String(sessionId)); } catch (error) { return { ok: false, why: 'agents.get 抛错：' + ((error && error.message) || String(error)) }; }
  if (!handle) return { ok: false, why: '会话不在活跃列表（窗口没开？）' };
  const agent = handle.agent ?? handle;
  if (typeof agent.followup !== 'function') return { ok: false, why: 'agent 上没有 followup' };
  try {
    agent.followup({
      id: (idPrefix || 'functions-load') + '-' + Date.now(),
      role: 'user',
      content: [{ type: 'text', text: String(text || '') }],
      source: { kind: 'user' },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, why: 'followup 抛错：' + ((error && error.message) || String(error)) };
  }
}

/** 置顶那条「加载功能」。 */
function makeLoaderFunction(ctx) {
  return {
    id: 'functions.load',
    title: '加载功能',
    description: '让会话去插件库里找非官方插件，列编号供你挑，再按 README 接进「功能」栏\n会话里的 dsh 执行',
    pinned: true,
    group: '功能',
    order: 0,
    keywords: ['加载', '插件', '功能', 'load', '接入', 'market'],
    prepare: (stage) => {
      if (stage > 0) return [];
      return [{
        title: '加载功能',
        message: '往当前会话发一条指令：让会话里的 dsh 找出插件库里的非官方插件、列出编号给你挑，再按 README 接进「功能」栏。',
        detail: 'dsh 没有「在工作区新开会话」的能力，所以走这条路：把指令当成你说的话发进当前会话。\n发完由会话里的 dsh 接手 —— 它会先列清单，停下来等你回数字。',
        confirmText: '发指令',
        cancelText: '取消',
      }];
    },
    run: async (job) => {
      const target = resolveSession(ctx, job.session);
      if (target.id === '') {
        throw new Error('不知道发到哪个会话：功能这边没拿到「你在看哪个会话」（客户端没报会话）。这条指令发错窗口代价太大，所以不猜。');
      }
      const busy = busyWhy(ctx, target.id);
      const sent = sendToSession(ctx, target.id, LOAD_INSTRUCTION, 'functions-load');
      if (sent.ok !== true) throw new Error('发不出去：' + sent.why);
      return {
        message: '已把「加载功能」的指令发进当前会话（' + target.how
          + (busy === '' ? '' : '；会话在忙：' + busy + '，指令排在它后面') + '）。接下来它会列编号清单，你回数字就行。',
        session: target.id,
        instructionChars: LOAD_INSTRUCTION.length,
        warnAfterMs: 30000,
        warnMessage: '会话那边没动静？看它是不是在跑别的任务（指令会排队），或者你自己把这段话再说一遍。',
      };
    },
  };
}

/**
 * 插件体。
 * @param ctx cordis 上下文
 * @param config 本行 config；可用 functions: [...] 直接声明功能（不写代码也能加）
 */
export function apply(ctx, config = {}) {
  const api = createRegistry(ctx);

  if (Array.isArray(config.functions)) {
    for (const item of config.functions) {
      try {
        api.register(item);
      } catch (error) {
        console.error('[dsh-functions] config.functions 里有一条挂了：', error);
      }
    }
  }

  // 别的宿主插件 inject: ['functions'] 之后就能 ctx.functions.register(...)
  ctx.provide('functions', api);

  // 内置的置顶功能：加载功能（自己也是「功能」插件的一部分，人要求它自己也适配这条）
  try {
    api.register(makeLoaderFunction(ctx));
  } catch (error) {
    console.error('[dsh-functions] 内置「加载功能」注册失败：', error);
  }

  const guard = (label, handler) => async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
      console.error('[dsh-functions] ' + label + ' 出错：', error);
      return json({ ok: false, error: label + ' 失败：' + message }, 500);
    }
  };

  const readBody = async (request) => {
    try {
      const body = await request.json();
      return typeof body === 'object' && body !== null ? body : {};
    } catch (error) {
      return {};
    }
  };

  ctx.connection.fetch.register({
    path: LIST_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: guard('列功能', async () => json({ ok: true, entries: api.list() })),
  });

  ctx.connection.fetch.register({
    path: PREPARE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guard('取确认计划', async (request) => {
      const body = await readBody(request);
      const confirms = await api.prepare(body.id, Number.isSafeInteger(body.stage) ? body.stage : 0, {
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      });
      if (confirms === null) return json({ ok: false, error: '没有这条功能：' + String(body.id) }, 404);
      return json({ ok: true, confirms });
    }),
  });

  ctx.connection.fetch.register({
    path: RUN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guard('执行功能', async (request) => {
      const body = await readBody(request);
      if (body.confirm !== 'yes') {
        return json({ ok: false, error: '缺少 confirm=yes：功能必须由确认窗之后发起' }, 400);
      }
      const outcome = await api.execute(body.id, {
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      });
      if (outcome.ok) return json({ ok: true, result: outcome.result });
      return json({ ok: false, error: outcome.error }, Number.isFinite(outcome.status) ? outcome.status : 500);
    }),
  });
}
