/**
 * dsh-functions ---- 客户端半边：「功能」标签 + 功能注册接口。
 *
 * 它做两件事：
 *   1) 在客户端顶端挂一个自己的「功能」标签（Windows 桌面下贴着原生「应用 / 编辑」
 *      菜单右边），点开是一个下拉面板，列出所有插件注册进来的功能。
 *   2) 通过 ctx.provide('functions', api) 暴露注册接口：别的插件写
 *      `export const inject = ['functions']` + `ctx.functions.register({...})` 就能往里加功能。
 *      接口同时提供 confirm / alert / toast，插件不必自带弹窗。
 *
 * 约束（别改）：
 *   - 本文件是浏览器里的普通脚本，不是 ES module：不能出现 import / export。
 *     它只通过 window.__ModuleLoader__.load 注册 factory，导出面靠 module.exports。
 *   - 不 require 任何 Harness Client 包（它们的接口会变），只用纯 DOM + 主题令牌 --dsw-*。
 *     升级后最坏是外观退化，不会白屏。
 *   - 渲染一律「软失败」：拿不到原生菜单栏就退回自己的位置，绝不把异常抛到外面。
 *
 * 2026-10-17（创造模式审查后）的改动：
 *   - 顶端定位加固：只有 html[data-windows-titlebar]（Windows 桌面壳）才按标题栏处理，
 *     高度/起点读 --dsh-windows-titlebar-height / --dsh-windows-menu-start，删掉了
 *     永远读不到的 --dsh-frame-leading-clearance 死路径；非桌面环境维持原 best-effort。
 *     锚点 [data-windows-menu] 仍是桌面壳 preload 的私有 DOM（当前 DSH 没有标题栏 slot），
 *     升级 DSH 后要重新核对。
 *   - 文案优先走 Client locale 服务（ctx.inject(['locale']) + register/bind），本地词典只做兜底。
 *   - 位置更新从 400ms 轮询改成事件驱动（html 属性变化 / body 子节点变化 / resize +
 *     启动期最多 3 秒的有限重试）。
 *   - 会话 id 增加显式读法 uiSession.adapter.current.getSnapshot().key，原候选探测保留兜底。
 *   - 三条 /api 路径按 document.baseURI 解析，兼容子路径 mount。
 *   - 弹层去掉「border + elevation 自带 stroke」叠出来的双描边。
 */

window.__ModuleLoader__.load({
  id: 'dsh-functions',
  factory(require) {
    'use strict';

    // ----------------------------------------------------------- 文案

    const zh = {
      tab: '功能',
      panelTitle: '功能',
      panelSubtitle: '插件在这里挂上自己的一键功能',
      empty: '还没有插件注册功能',
      emptyHint: '插件用 ctx.functions.register({ id, title, run }) 往这里加。',
      hostUnreachable: '宿主清单拉不到（不是「没有功能」）',
      groupDefault: '通用',
      failed: '执行失败',
      cancel: '取消',
      confirm: '确定',
      footer: '「功能」由 dsh-functions 提供',
    };

    const en = {
      tab: 'Functions',
      panelTitle: 'Functions',
      panelSubtitle: 'One-click actions contributed by plugins',
      empty: 'No functions registered yet',
      emptyHint: 'Plugins add them with ctx.functions.register({ id, title, run }).',
      hostUnreachable: 'Host function list is unreachable (this is not "no functions")',
      groupDefault: 'General',
      failed: 'Failed',
      cancel: 'Cancel',
      confirm: 'OK',
      footer: 'Provided by dsh-functions',
    };

    /**
     * 当前界面语言。
     *
     * 优先走 Client locale 服务（apply 里注册 dsh-functions 命名空间，由它给译文）；
     * 服务不在（老版本 / 被裁掉 / 还没挂上）就退回下面的本地词典。
     * 本地词典按 <html lang> 选：桌面端由外壳写入，浏览器端退回 navigator。
     */
    let serviceTranslate = null;

    const pickDictionary = () => {
      let tag = '';
      try {
        tag = document.documentElement.getAttribute('lang') || navigator.language || '';
      } catch (error) {
        tag = '';
      }
      return String(tag).toLowerCase().startsWith('zh') ? zh : en;
    };

    let dictionary = pickDictionary();
    const t = (key) => {
      if (serviceTranslate !== null) {
        try {
          const translated = serviceTranslate(key);
          if (typeof translated === 'string' && translated !== key) return translated;
        } catch (error) {
          /* 退回本地词典 */
        }
      }
      return Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : key;
    };
    const refreshDictionary = () => {
      dictionary = pickDictionary();
    };

    // ------------------------------------------------------- 小工具

    const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

    /** 把任意值收敛成一句可直接显示的错误文本。 */
    const errorText = (error) => {
      if (error === null || error === undefined) return 'unknown error';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message.length > 0) return error.message;
      try {
        return JSON.stringify(error);
      } catch (jsonError) {
        return String(error);
      }
    };

    /**
     * 请求同一来源的 Host 路由（api/...），非 2xx 与畸形响应都收敛成 throw。
     *
     * 路径按 document.baseURI 解析成相对地址：页面挂在子路径下（mount）时也能用；
     * 直接写 '/api/...' 会跑到站点根，挂载前缀会被丢掉。
     */
    const requestJson = async (path, init) => {
      const options = Object.assign({ credentials: 'same-origin' }, init || {});
      if (options.body !== undefined && options.headers === undefined) {
        options.headers = { 'content-type': 'application/json' };
      }
      let target = path;
      try {
        target = new URL(String(path).replace(/^\//, ''), document.baseURI);
      } catch (error) {
        target = path;
      }
      let response;
      try {
        response = await fetch(target, options);
      } catch (error) {
        throw new Error('无法连接 Host：' + errorText(error));
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch (parseError) {
        payload = null;
      }
      if (!response.ok) {
        const message =
          isObject(payload) && typeof payload.error === 'string' ? payload.error : 'HTTP ' + String(response.status);
        throw new Error(message);
      }
      return payload;
    };

    // ----------------------------------------------- 功能注册表（纯数据）

    let sequence = 0;

    /** 校验并冻结一条注册项；非法输入直接抛，避免半截功能混进菜单。 */
    function normalizeFunction(input) {
      if (!isObject(input)) throw new Error('dsh-functions: register() 需要一个对象');
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (id.length === 0) throw new Error('dsh-functions: 功能必须有非空 id');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title.length === 0) throw new Error('dsh-functions: 功能 ' + id + ' 必须有 title');
      const isSubmenuParent = input.submenu === true;
      if (typeof input.run !== 'function' && !isSubmenuParent) {
        throw new Error('dsh-functions: 功能 ' + id + ' 必须有 run()（二级菜单的父项可以只写 submenu: true）');
      }
      return Object.freeze({
        id,
        title,
        pinned: input.pinned === true,
        parent: typeof input.parent === 'string' ? input.parent.trim() : '',
        submenu: isSubmenuParent,
        description: typeof input.description === 'string' ? input.description : '',
        icon: typeof input.icon === 'string' ? input.icon : '',
        group: typeof input.group === 'string' && input.group.trim().length > 0 ? input.group.trim() : '',
        order: Number.isFinite(input.order) ? Number(input.order) : 100,
        keywords: Array.isArray(input.keywords) ? input.keywords.filter((item) => typeof item === 'string') : [],
        hidden: input.hidden === true,
        run: typeof input.run === 'function' ? input.run : null,
        seq: sequence++,
      });
    }

    /** 宿主侧三条路由（相对路径，由 requestJson 按 document.baseURI 解析）。 */
    const HOST_LIST_PATH = 'api/dshFunctions/list';
    const HOST_PREPARE_PATH = 'api/dshFunctions/prepare';
    const HOST_RUN_PATH = 'api/dshFunctions/run';

    /** 把宿主功能的执行结果收敛成一句能显示的话。 */
    function summarizeResult(result) {
      if (result === null || result === undefined) return '完成';
      if (isObject(result) && typeof result.message === 'string' && result.message.length > 0) return result.message;
      if (isObject(result) && typeof result.exitCode !== 'undefined' && result.exitCode !== null) {
        const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
        const err = typeof result.stderr === 'string' ? result.stderr.trim() : '';
        if (result.exitCode === 0) return out.length > 0 ? out.split('\n')[0] : '完成（退出码 0）';
        return '失败（退出码 ' + String(result.exitCode) + '）' + (err.length > 0 ? '：' + err.split('\n')[0] : '');
      }
      return '完成';
    }

    /**
     * 用户现在在看哪个会话。
     *
     * 从客户端服务 uiSession 读（它的 current 是个「绑定源」）。这个读法没有正式文档，
     * 所以**逐个候选试，拿到像样的字符串就用，拿不到就返回空串** ----
     * 空串的意思不是「没有会话」，而是「我不知道」，宿主那边会拒（不猜）。
     */
    function extractSessionId(value, depth = 0) {
      if (depth > 4 || value === null || value === undefined) return '';
      if (typeof value === 'string') return value.length > 0 && value.length < 200 ? value : '';
      if (typeof value !== 'object') return '';
      for (const key of ['sessionId', 'id', 'key']) {
        const hit = value[key];
        if (typeof hit === 'string' && hit.length > 0 && hit.length < 200) return hit;
      }
      for (const key of ['value', 'current']) {
        const nested = extractSessionId(value[key], depth + 1);
        if (nested !== '') return nested;
      }
      return '';
    }

    /** 显式读法：uiSession.adapter.current 是 BindingSource，快照上的 key 就是会话 id。 */
    function explicitUiSessionKey(service) {
      try {
        const adapter = service && service.adapter;
        const source = adapter && adapter.current;
        const snapshot = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : undefined;
        const key = snapshot && typeof snapshot.key === 'string' ? snapshot.key : '';
        if (key.length > 0 && key.length < 200) return key;
      } catch (error) {
        /* 退回下面的候选探测 */
      }
      return '';
    }

    function currentSessionId(ctx) {
      try {
        const service = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : null;
        if (!service) return '';
        const explicit = explicitUiSessionKey(service);
        if (explicit !== '') return explicit;
        const source = service.current;
        for (const reader of ['get', 'read', 'peek', 'valueOf']) {
          if (source && typeof source[reader] === 'function') {
            try {
              const hit = extractSessionId(source[reader]());
              if (hit !== '') return hit;
            } catch (error) { /* 接着试 */ }
          }
        }
        const direct = extractSessionId(source !== undefined ? source : service);
        if (direct !== '') return direct;
        const sessions = service.sessions;
        if (sessions && typeof sessions.current === 'function') {
          try {
            const hit = extractSessionId(sessions.current());
            if (hit !== '') return hit;
          } catch (error) { /* 算了 */ }
        }
      } catch (error) {
        return '';
      }
      return '';
    }

    /**
     * 宿主注册的功能在浏览器这一侧的执行方式：先拿确认计划，逐级确认，
     * 再让宿主动手。宿主只认 confirm=yes，所以确认是在这里真正生效的。
     */
    function hostRunner(id) {
      return async (job) => {
        // 一级一级地问：每一级都在上一级点完之后才向宿主取，
        // 所以「有正在进行中的任务」这种话是当场算的，不是攒下来的。
        for (let stage = 0; stage < 50; stage += 1) {
          const plan = await job.post(HOST_PREPARE_PATH, { id, stage, sessionId: job.session });
          const confirms = isObject(plan) && Array.isArray(plan.confirms) ? plan.confirms : [];
          if (confirms.length === 0) break;
          for (const spec of confirms) {
            const accepted = await job.confirm(spec);
            if (accepted !== true) return;
          }
        }
        const outcome = await job.post(HOST_RUN_PATH, { id, confirm: 'yes', sessionId: job.session });
        const result = isObject(outcome) ? outcome.result : null;
        const message = summarizeResult(result);
        job.toast(message, /失败|错误/.test(message) ? 'error' : 'success');
        // 宿主可以约一个「到点我还活着就提醒我」：真要重启/关窗口的功能，
        // 页面这会儿已经没了，这条兜底提示永远不会显示。
        if (isObject(result) && Number.isFinite(result.warnAfterMs) && result.warnAfterMs > 0 && typeof result.warnMessage === 'string') {
          setTimeout(() => {
            try {
              job.toast(result.warnMessage, 'error');
            } catch (error) {
              /* 界面可能已经没了 */
            }
          }, result.warnAfterMs);
        }
      };
    }

    /** 把宿主清单里的一条转成本地注册表的形状（run 走 hostRunner）。 */
    function fromHost(entry) {
      return Object.freeze({
        id: String(entry.id),
        title: String(entry.title),
        description: typeof entry.description === 'string' ? entry.description : '',
        icon: typeof entry.icon === 'string' ? entry.icon : '',
        group: typeof entry.group === 'string' && entry.group.trim().length > 0 ? entry.group.trim() : '',
        order: Number.isFinite(entry.order) ? Number(entry.order) : 100,
        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
        hidden: entry.hidden === true,
        pinned: entry.pinned === true,
        parent: typeof entry.parent === 'string' ? entry.parent : '',
        submenu: entry.submenu === true,
        source: 'host',
        run: hostRunner(String(entry.id)),
        seq: 1e6,
      });
    }

    function createRegistry() {
      const entries = new Map();
      /** 宿主注册的功能：由 refreshHost() 整批替换。 */
      const hostEntries = new Map();
      /** 最近一次拉宿主清单失败的原因；null = 拉通了。 */
      let hostError = null;
      const listeners = new Set();

      const merged = () => [...entries.values(), ...hostEntries.values()];

      const snapshot = () =>
        merged()
          .filter((entry) => entry.hidden !== true)
          .sort((left, right) => {
            // 置顶的（pinned）永远在最上面，其余按分组/顺序
            if ((left.pinned === true) !== (right.pinned === true)) return left.pinned === true ? -1 : 1;
            const groupLeft = left.group.length > 0 ? left.group : t('groupDefault');
            const groupRight = right.group.length > 0 ? right.group : t('groupDefault');
            if (groupLeft !== groupRight) return groupLeft.localeCompare(groupRight, 'zh-Hans-CN');
            if (left.order !== right.order) return left.order - right.order;
            return left.seq - right.seq;
          });

      const notify = () => {
        const list = snapshot();
        for (const listener of Array.from(listeners)) {
          try {
            listener(list);
          } catch (error) {
            console.error('[dsh-functions] subscribe 回调抛错：', error);
          }
        }
      };

      return {
        register(input) {
          const entry = normalizeFunction(input);
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
          return entries.get(String(id)) ?? hostEntries.get(String(id));
        },
        list: snapshot,
        /** 宿主清单整批替换（名单变了才通知，免得每次开面板都重画）。 */
        replaceHost(list) {
          const next = new Map();
          for (const item of Array.isArray(list) ? list : []) {
            if (!isObject(item) || typeof item.id !== 'string' || item.id.length === 0) continue;
            // 本地同名优先：客户端自己注册的版本更懂界面。
            if (entries.has(item.id)) continue;
            const entry = fromHost(item);
            next.set(entry.id, entry);
          }
          const same =
            next.size === hostEntries.size && [...next.keys()].every((key) => hostEntries.has(key));
          hostEntries.clear();
          for (const [key, value] of next) hostEntries.set(key, value);
          if (!same) notify();
          return next.size;
        },
        /** 拉一次宿主清单；失败不抛，只在控制台留一行 + 记下原因给面板显示。 */
        async refreshHost() {
          try {
            const payload = await requestJson(HOST_LIST_PATH, { method: 'GET' });
            const entries = isObject(payload) && Array.isArray(payload.entries) ? payload.entries : [];
            this.replaceHost(entries);
            const changed = hostError !== null;
            hostError = null;
            if (changed) notify();
            return entries.length;
          } catch (error) {
            // 这一行很重要：第一次出事故时菜单只是「空的」，看不出是没插件还是没拉通。
            hostError = errorText(error);
            console.warn('[dsh-functions] 拉宿主功能清单失败：', hostError);
            notify();
            return -1;
          }
        },
        /** 宿主清单拉不到时的原因（null = 拉通了）。 */
        get hostError() {
          return hostError;
        },
        subscribe(listener) {
          if (typeof listener !== 'function') throw new Error('dsh-functions: subscribe() 需要函数');
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        get size() {
          return merged().filter((entry) => entry.hidden !== true).length;
        },
      };
    }

    // ------------------------------------------------- 界面样式（shadow 内）

    const CSS = `
      :host { position: fixed; top: 0; left: 64px; height: var(--dsh-windows-titlebar-height, 40px); z-index: 1100;
        display: flex;
        align-items: center; font-family: var(--dsw-font-family, system-ui, -apple-system, 'Segoe UI', sans-serif);
        -webkit-app-region: no-drag; }
      .menubar { display: flex; gap: 2px; }
      button { font: inherit; }
      .tab { height: 28px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
        color: var(--dsw-alias-label-secondary, #a3a3a3); font-size: 14px; cursor: default;
        display: inline-flex; align-items: center; gap: 6px; }
      .tab:hover, .tab[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08));
        color: var(--dsw-alias-label-primary, #ececec); }
      .tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: -2px; }
      .count { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 11px; line-height: 16px;
        text-align: center; background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.12));
        color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .panel { position: absolute; top: calc(100% + 4px); left: 0; min-width: 300px; max-width: 430px;
        max-height: 62vh; overflow: auto; padding: 6px; border-radius: 10px; display: none;
        background: var(--dsw-alias-bg-layer-2, #232323); color: var(--dsw-alias-label-primary, #ececec);
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
        /* 阴影用 elevation 里不带 stroke 的两层：描边已经由 border 画了，再叠 token 的
           stroke 会出双线（2026-10-17 修）。 */
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05); }
      .panel[data-open='true'] { display: block; }
      .panelHead { padding: 6px 10px 8px; }
      .panelTitle { font-size: 13px; font-weight: 600; }
      .panelSubtitle { margin-top: 2px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .pinnedDivider { margin: 4px 10px 6px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14)); }
      .groupLabel { padding: 6px 10px 4px; font-size: 9px; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .item { width: 100%; display: flex; align-items: baseline; gap: 12px; padding: 6px 10px; border: 0;
        border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: default; }
      .item:hover, .item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); outline: none; }
      .item[disabled] { opacity: 0.55; }
      .itemTitle { flex: none; white-space: nowrap; font-size: 13px; line-height: 20px; }
      /* 说明最多两行：第一行讲做什么，第二行写它调用的插件（换行符由注册方写进 description） */
      .itemDesc { flex: 1 1 auto; min-width: 0; text-align: right; white-space: pre-line;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        font-size: 9.5px; line-height: 14px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      /* 二级菜单：照 Windows 右键菜单那套 ---- 父项带 > 箭头，悬停向右展开 */
      .itemParent { position: relative; }
      .itemArrow { flex: none; margin-left: 4px; font-size: 11px; line-height: 20px;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      /* 注意：.panel 有 overflow:auto，子元素在面板外会被裁掉 ---- 所以子菜单用 fixed，
         坐标由 JS（place()）按父项的位置算，超出视口时自动翻到左边/上边。 */
      .submenu { position: fixed; left: 0; top: 0; z-index: 5; display: none;
        min-width: 220px; max-width: 420px; padding: 6px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-2, #232323); color: var(--dsw-alias-label-primary, #ececec);
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05); }
      .item[data-open='true'] > .submenu { display: block; }
      .empty { padding: 14px 12px 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #a3a3a3); }
      .emptyHint { margin-top: 6px; font-size: 9.5px; color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .footer { margin-top: 4px; padding: 6px 10px 2px; font-size: 9px;
        border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .overlay { position: fixed; inset: 0; z-index: 1200; display: none; align-items: center;
        justify-content: center; padding: 24px; background: rgba(0,0,0,0.42); }
      .overlay[data-open='true'] { display: flex; }
      .dialog { width: 100%; max-width: 400px; padding: 20px 20px 16px; color: var(--dsw-alias-label-primary, #ececec);
        border-radius: var(--dsw-radius-panel, 14px); background: var(--dsw-alias-bg-layer-2, #232323);
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05); }
      .dialogTitle { font-size: 15px; font-weight: 600; line-height: 22px; }
      .dialogMessage { margin-top: 10px; font-size: 13.5px; line-height: 21px; white-space: pre-wrap; }
      .dialogMessage[data-danger='true'] { color: var(--dsw-alias-state-error-primary, #f06a6a); }
      .dialogDetail { margin-top: 10px; font-size: 12px; line-height: 19px; white-space: pre-wrap;
        color: var(--dsw-alias-label-tertiary, #8a8a8a); }
      .dialogActions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
      .btn { height: 36px; padding: 0 16px; border: 0; border-radius: 18px; font-size: 13.5px; cursor: pointer;
        background: var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.1)); color: var(--dsw-alias-label-primary, #ececec); }
      .btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.16)); }
      .btn[data-variant='primary'] { background: var(--dsw-alias-state-business-primary, #4d6bfe); color: #fff; }
      .btn[data-variant='danger'] { background: var(--dsw-alias-state-error-primary, #d94a4a); color: #fff; }
      .toasts { position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 1300;
        display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
      .toast { max-width: 60vw; padding: 8px 14px; border-radius: 8px; font-size: 12.5px; line-height: 18px;
        background: var(--dsw-alias-bg-layer-2, #232323); color: var(--dsw-alias-label-primary, #ececec);
        border: 0.5px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12));
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.04), 0 0 20px rgba(0, 0, 0, 0.05); }
      .toast[data-kind='error'] { color: var(--dsw-alias-state-error-primary, #f06a6a); }
      .toast[data-kind='success'] { color: var(--dsw-alias-state-success-primary, #3fbf7f); }
      /* 跟外壳原生菜单栏同一条规矩：纯鼠标操作时不画焦点圈（键盘走查仍然画）。 */
      :host-context(html[data-input-modality='pointer']) .tab:focus-visible,
      :host-context(html[data-input-modality='pointer']) .item:focus-visible,
      :host-context(html[data-input-modality='pointer']) .btn:focus-visible { outline-color: transparent; }
    `;

    // -------------------------------------------- 界面：菜单栏座与各层 DOM

    function createSurface(registry, hooks) {
      const options = isObject(hooks) ? hooks : {};
      const host = document.createElement('div');
      host.setAttribute('data-dsh-functions', '');
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = CSS;

      const menubar = document.createElement('div');
      menubar.className = 'menubar';
      menubar.setAttribute('role', 'menubar');

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.setAttribute('role', 'menuitem');
      tab.setAttribute('aria-haspopup', 'menu');
      tab.setAttribute('aria-expanded', 'false');
      tab.tabIndex = 0;
      const tabLabel = document.createElement('span');
      tabLabel.textContent = t('tab');
      const tabCount = document.createElement('span');
      tabCount.className = 'count';
      tabCount.style.display = 'none';
      tab.append(tabLabel, tabCount);
      menubar.append(tab);

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'menu');
      panel.dataset.open = 'false';

      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.dataset.open = 'false';

      const toasts = document.createElement('div');
      toasts.className = 'toasts';

      shadow.append(style, menubar, panel, overlay, toasts);

      let open = false;
      let dialogTail = Promise.resolve();
      /** 当前那个弹窗的「取消」入口；遮罩点击只挂一次监听，转交给它。 */
      let cancelCurrentDialog = null;
      overlay.addEventListener('click', (event) => {
        if (event.target !== overlay) return;
        const cancel = cancelCurrentDialog;
        cancelCurrentDialog = null;
        if (cancel !== null) cancel();
      });

      // -- 定位：贴着原生「应用 / 编辑」菜单右边 --------------------------------
      //
      // 原生菜单栏是【Windows 桌面壳 preload】注入的私有 DOM：[data-windows-menu]
      // （fixed、结构在 open shadow 里，只在 Windows + dsh-app 页面 + 外壳渲染完
      // [data-shell-overlay] 之后才存在）。当前 DSH 的 94 个 slot 里没有标题栏/
      // 菜单条的 slot，所以这个位置只能靠量它 ---- 这是私有契约，升级 DSH 后要重核。
      //
      // 加固（2026-10-17）：只有 html[data-windows-titlebar] 才当桌面壳处理，
      // 标题栏高度/菜单起点优先读外壳文档化的 --dsh-windows-titlebar-height /
      // --dsh-windows-menu-start；量不到矩形时按这两个变量停位。其它环境
      // （普通浏览器 / macOS / 老外壳）维持原来的 best-effort 位置，不做假的桌面假设。
      const NATIVE_MENUBAR = '[data-windows-menu]';

      /** 读根元素上的 CSS 变量并解析成数字；读不到返回 null。 */
      const rootNumber = (name) => {
        try {
          const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
          return Number.isFinite(value) ? value : null;
        } catch (error) {
          return null;
        }
      };

      const place = () => {
        let rect = null;
        try {
          const native = document.querySelector(NATIVE_MENUBAR);
          if (native !== null) rect = native.getBoundingClientRect();
        } catch (error) {
          rect = null;
        }
        const apply3 = (left, top, height) => {
          // 只在真的变了的时候写：重复写同样的值会让浏览器白白重算样式。
          if (host.style.left !== left) host.style.left = left;
          if (host.style.top !== top) host.style.top = top;
          if (host.style.height !== height) host.style.height = height;
        };
        if (rect !== null && rect.width > 0 && rect.height > 0) {
          apply3(String(Math.round(rect.right) + 2) + 'px', String(Math.round(rect.top)) + 'px', String(Math.round(rect.height)) + 'px');
          return true;
        }
        if (document.documentElement.hasAttribute('data-windows-titlebar')) {
          const start = rootNumber('--dsh-windows-menu-start');
          const height = rootNumber('--dsh-windows-titlebar-height');
          apply3((start !== null ? start : 48) + 'px', '0px', (height !== null ? height : 40) + 'px');
          return false;
        }
        // 非桌面环境：没有标题栏条可贴，维持原来的 best-effort 位置。
        apply3('64px', '6px', '32px');
        return false;
      };

      // -- 面板渲染 --------------------------------------------
      const renderPanel = () => {
        const list = registry.list();
        tabLabel.textContent = t('tab');
        if (list.length > 0) {
          tabCount.textContent = String(list.length);
          tabCount.style.display = '';
        } else {
          tabCount.style.display = 'none';
        }
        panel.textContent = '';

        const head = document.createElement('div');
        head.className = 'panelHead';
        const title = document.createElement('div');
        title.className = 'panelTitle';
        title.textContent = t('panelTitle');
        const subtitle = document.createElement('div');
        subtitle.className = 'panelSubtitle';
        subtitle.textContent = t('panelSubtitle');
        head.append(title, subtitle);
        panel.append(head);

        if (list.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          const failure = registry.hostError;
          if (typeof failure === 'string' && failure.length > 0) {
            // 拉不到宿主清单 != 没有功能。说清楚，别让人对着空面板猜。
            empty.textContent = t('hostUnreachable');
            const why = document.createElement('div');
            why.className = 'emptyHint';
            why.textContent = failure;
            empty.append(why);
          } else {
            empty.textContent = t('empty');
            const hint = document.createElement('div');
            hint.className = 'emptyHint';
            hint.textContent = t('emptyHint');
            empty.append(hint);
          }
          panel.append(empty);
        }

        // 分组标签默认**不画**（2026-10-13：面板太长，把分组之间的间隔去掉了）。
        // 分组仍然参与排序；想要标签把下面的开关改成 true。
        // 分组仍然参与**排序**（同一个 group 的排在一起），只是不再占一行。
        // 想要标签的话把下面这个开关改成 true 就行（CSS 里 .groupLabel 也还留着）。
        const SHOW_GROUP_LABELS = false;
        // 二级菜单（人 2026-10-13 要求，按 Windows 右键菜单的逻辑）：
        //   parent 指向某个父项 id 的条目进它的子菜单，不出现在顶层；
        //   父项右边一个 ">" 箭头，鼠标悬停向右展开，指针离开父项与子菜单一小会儿才收。
        const childrenOf = (id) => list.filter((entry) => entry.parent === id);
        const roots = list.filter((entry) => entry.parent.length === 0);

        const buildRow = (entry, kids) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'item';
          item.setAttribute('role', 'menuitem');
          item.dataset.functionId = entry.id;

          // 行排版：不画单字图标；功能名在前，说明小字靠右，同一行横排。
          // 说明可以带换行 ---- 第二行按约定写这个功能调用的插件（人 2026-10-13 要求）。
          const itemTitle = document.createElement('span');
          itemTitle.className = 'itemTitle';
          itemTitle.textContent = entry.title;
          item.append(itemTitle);
          if (entry.description.length > 0) {
            const desc = document.createElement('span');
            desc.className = 'itemDesc';
            desc.textContent = entry.description;
            item.append(desc);
            item.title = entry.title + '：' + entry.description.replace(/\n/g, ' ');
          } else {
            item.title = entry.title;
          }

          if (kids.length === 0) {
            item.addEventListener('click', () => {
              void invoke(entry, item);
            });
            return item;
          }

          // 父项：只负责展开子菜单，自己不带动作
          item.classList.add('itemParent');
          item.setAttribute('aria-haspopup', 'menu');
          item.setAttribute('aria-expanded', 'false');
          const arrow = document.createElement('span');
          arrow.className = 'itemArrow';
          arrow.textContent = '>';
          item.append(arrow);

          const submenu = document.createElement('div');
          submenu.className = 'submenu';
          submenu.setAttribute('role', 'menu');
          for (const kid of kids) submenu.append(buildRow(kid, []));
          item.append(submenu);

          let hoverTimer = null;
          let closeTimer = null;
          // 面板会滚动/裁切，fixed 的子菜单要自己算位置：贴在父项右边，越界就翻边。
          const place = () => {
            const rect = item.getBoundingClientRect();
            const width = submenu.offsetWidth;
            const height = submenu.offsetHeight;
            let left = rect.right + 4;
            if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width - 4);
            let top = rect.top - 6;
            if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
            submenu.style.left = left + 'px';
            submenu.style.top = top + 'px';
          };
          const setOpen = (open) => {
            item.dataset.open = open ? 'true' : 'false';
            item.setAttribute('aria-expanded', open ? 'true' : 'false');
            // 先让它 display:block（CSS 由 data-open 驱动），再量尺寸定位
            if (open) place();
          };
          setOpen(false);
          const openSoon = () => {
            clearTimeout(closeTimer);
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => setOpen(true), 120);
          };
          const closeSoon = () => {
            clearTimeout(hoverTimer);
            clearTimeout(closeTimer);
            closeTimer = setTimeout(() => setOpen(false), 180);
          };
          item.addEventListener('mouseenter', openSoon);
          item.addEventListener('mouseleave', closeSoon);
          submenu.addEventListener('mouseenter', () => {
            clearTimeout(closeTimer);
            clearTimeout(hoverTimer);
            setOpen(true);
          });
          submenu.addEventListener('mouseleave', closeSoon);
          // 点击也行（触屏 / 键盘）：点父项 = 展开或收起
          item.addEventListener('click', (event) => {
            event.stopPropagation();
            setOpen(item.dataset.open !== 'true');
          });
          return item;
        };

        let currentGroup = null;
        let sawPinned = false;
        let dividerDone = false;
        for (const entry of roots) {
          if (entry.pinned === true) {
            sawPinned = true;
          } else if (sawPinned && !dividerDone) {
            // 置顶的（加载功能）和其余选项之间画一条分隔线（人 2026-10-23 要求）
            const divider = document.createElement('div');
            divider.className = 'pinnedDivider';
            panel.append(divider);
            dividerDone = true;
          }
          const group = entry.group.length > 0 ? entry.group : t('groupDefault');
          if (SHOW_GROUP_LABELS && group !== currentGroup) {
            currentGroup = group;
            const label = document.createElement('div');
            label.className = 'groupLabel';
            label.textContent = group;
            panel.append(label);
          }
          panel.append(buildRow(entry, childrenOf(entry.id)));
        }

        const footer = document.createElement('div');
        footer.className = 'footer';
        footer.textContent = t('footer');
        panel.append(footer);
      };

      const setOpen = (next) => {
        open = next === true;
        panel.dataset.open = open ? 'true' : 'false';
        tab.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          // 开面板时顺手拉一次宿主清单：别的插件刚注册的功能这一下就能看见。
          // 不 await：菜单先出来，名单回来再重画（replaceHost 变了才通知）。
          if (typeof options.onOpen === 'function') {
            try {
              Promise.resolve(options.onOpen()).catch(() => undefined);
            } catch (error) {
              console.error('[dsh-functions] onOpen 抛错：', error);
            }
          }
          renderPanel();
          const first = panel.querySelector('.item');
          if (first !== null) first.focus({ preventScroll: true });
        }
      };

      // -- toast -----------------------------------------------
      const toast = (message, kind) => {
        const text = typeof message === 'string' ? message : errorText(message);
        if (text.length === 0) return;
        const node = document.createElement('div');
        node.className = 'toast';
        node.dataset.kind = kind === 'error' || kind === 'success' ? kind : 'info';
        node.setAttribute('role', 'status');
        node.textContent = text;
        toasts.append(node);
        setTimeout(() => node.remove(), 4200);
      };

      // -- 确认弹窗（可连开多级；后来的排队） ------------------
      const confirm = (options) => {
        const input = isObject(options) ? options : {};
        const run = dialogTail.then(
          () =>
            new Promise((resolve) => {
              overlay.textContent = '';
              overlay.dataset.open = 'true';

              const card = document.createElement('div');
              card.className = 'dialog';
              card.setAttribute('role', 'alertdialog');
              card.setAttribute('aria-modal', 'true');

              const title = document.createElement('div');
              title.className = 'dialogTitle';
              title.textContent = typeof input.title === 'string' && input.title.length > 0 ? input.title : t('confirm');

              const message = document.createElement('div');
              message.className = 'dialogMessage';
              message.textContent = typeof input.message === 'string' ? input.message : '';
              if (input.danger === true) message.dataset.danger = 'true';
              card.append(title, message);

              if (typeof input.detail === 'string' && input.detail.length > 0) {
                const detail = document.createElement('div');
                detail.className = 'dialogDetail';
                detail.textContent = input.detail;
                card.append(detail);
              }

              const actions = document.createElement('div');
              actions.className = 'dialogActions';
              const cancel = document.createElement('button');
              cancel.type = 'button';
              cancel.className = 'btn';
              cancel.textContent =
                typeof input.cancelText === 'string' && input.cancelText.length > 0 ? input.cancelText : t('cancel');
              const accept = document.createElement('button');
              accept.type = 'button';
              accept.className = 'btn';
              accept.dataset.variant = input.danger === true ? 'danger' : 'primary';
              accept.textContent =
                typeof input.confirmText === 'string' && input.confirmText.length > 0 ? input.confirmText : t('confirm');
              actions.append(cancel, accept);
              if (input.cancelText === '') cancel.remove();
              card.append(actions);

              const finish = (value) => {
                if (cancelCurrentDialog === cancel) cancelCurrentDialog = null;
                overlay.dataset.open = 'false';
                overlay.textContent = '';
                document.removeEventListener('keydown', onKey, true);
                resolve(value);
              };
              cancelCurrentDialog = () => finish(false);
              const onKey = (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  finish(false);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  finish(true);
                }
              };
              cancel.addEventListener('click', () => finish(false));
              accept.addEventListener('click', () => finish(true));
              card.addEventListener('click', (event) => event.stopPropagation());
              document.addEventListener('keydown', onKey, true);

              overlay.append(card);
              accept.focus({ preventScroll: true });
            }),
        );
        dialogTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      const alert = (options) => {
        const input = isObject(options) ? options : { message: String(options === undefined ? '' : options) };
        return confirm({
          title: input.title,
          message: input.message,
          detail: input.detail,
          danger: input.danger,
          confirmText: input.confirmText,
          cancelText: '',
        }).then(() => undefined);
      };

      // -- 执行一个功能 ----------------------------------------
      const invoke = async (entry, item) => {
        setOpen(false);
        if (item !== undefined) item.disabled = true;
        const runContext = {
          id: entry.id,
          /** 用户在看哪个会话：由 apply 通过 hooks.session 传进来（createSurface 这层看不到 ctx）。 */
          session: typeof hooks.session === 'function' ? hooks.session() : '',
          t,
          /** Host 路由取数：GET /api/... */
          get: (path, init) => requestJson(path, Object.assign({}, init || {}, { method: 'GET' })),
          /** Host 路由写：POST /api/... + JSON body */
          post: (path, body, init) =>
            requestJson(
              path,
              Object.assign({}, init || {}, { method: 'POST', body: JSON.stringify(body === undefined ? {} : body) }),
            ),
          confirm,
          alert,
          toast,
          close: () => setOpen(false),
        };
        try {
          await entry.run(runContext);
        } catch (error) {
          console.error('[dsh-functions] 功能 ' + entry.id + ' 执行失败：', error);
          toast(t('failed') + '：' + errorText(error), 'error');
        } finally {
          if (item !== undefined) item.disabled = false;
        }
      };

      // -- 事件接线 --------------------------------------------
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!open) renderPanel();
        setOpen(!open);
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setOpen(true);
        }
      });
      panel.addEventListener('keydown', (event) => {
        const items = Array.from(panel.querySelectorAll('.item'));
        // shadow root 里 document.activeElement 是宿主元素，得问面板自己谁被聚焦了。
        const index = items.indexOf(panel.querySelector(':focus'));
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (items.length === 0) return;
          const step = event.key === 'ArrowDown' ? 1 : -1;
          items[(index + step + items.length) % items.length].focus({ preventScroll: true });
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          tab.focus({ preventScroll: true });
        }
      });
      const onPointerDown = (event) => {
        if (!open) return;
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (path.indexOf(host) !== -1) return;
        setOpen(false);
      };
      const onWindowKey = (event) => {
        if (event.key === 'Escape' && open) setOpen(false);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onWindowKey, true);

      registry.subscribe(() => {
        if (open) renderPanel();
        else if (registry.size > 0) {
          tabCount.textContent = String(registry.size);
          tabCount.style.display = '';
        }
      });

      return {
        host,
        place,
        renderPanel,
        setOpen,
        confirm,
        alert,
        toast,
        get open() {
          return open;
        },
        dispose() {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onWindowKey, true);
          host.remove();
        },
      };
    }

    // ------------------------------------------------------ 插件体

    /**
     * 客户端插件体：起界面、建注册表、把接口 provide 成 `functions` 服务。
     * @param ctx client root context。
     */
    function apply(ctx) {
      const registry = createRegistry();
      const ui = createSurface(registry, {
        onOpen: () => registry.refreshHost(),
        // 「用户在看哪个会话」这一层知识留在 apply：createSurface 看不到 ctx
        session: () => currentSessionId(ctx),
      });

      const api = {
        /** 注册一条功能；返回注销函数。 */
        register: (input) => registry.register(input),
        unregister: (id) => registry.unregister(id),
        get: (id) => registry.get(id),
        /** 当前功能快照（已排序、已复制）。 */
        list: () => registry.list(),
        /** 订阅注册表变化；返回退订函数。 */
        subscribe: (listener) => registry.subscribe(listener),
        /** 打开 / 关闭 / 切换「功能」面板。 */
        open: () => ui.setOpen(true),
        close: () => ui.setOpen(false),
        toggle: () => ui.setOpen(!ui.open),
        /** 多级确认弹窗：resolve(true) 表示用户点了确认。 */
        confirm: (options) => ui.confirm(options),
        /** 只有一个「确定」的提示弹窗。 */
        alert: (options) => ui.alert(options),
        /** 浮出提示；kind：info | success | error。 */
        toast: (message, kind) => ui.toast(message, kind),
      };

      ctx.provide('functions', api);

      // 逃生口：没走 cordis 注入的客户端代码（皮肤、小挂件之类）也能注册。
      try {
        globalThis.__DSH_FUNCTIONS__ = api;
      } catch (error) {
        console.warn('[dsh-functions] 无法挂 __DSH_FUNCTIONS__：', error);
      }

      // 文案优先走 Client locale 服务：注册 dsh-functions 命名空间，由它按当前语言给译文。
      // 用 ctx.inject 而不是写死 inject: ['locale']：locale 对这里只是增强，
      // 服务不在（老版本/被裁掉）时继续用本地词典，整栏不该因此消失。
      try {
        ctx.inject(['locale'], (localized) => {
          try {
            localized.effect(
              () => localized.locale.register('dsh-functions', 'zh', zh),
              'dsh-functions: zh 词典',
            );
            localized.effect(
              () => localized.locale.register('dsh-functions', 'en', en),
              'dsh-functions: en 词典',
            );
            // bind 返回的翻译函数自己会跟着当前语言走，不需要每次换语言重新绑定。
            const bound = localized.locale.bind('dsh-functions');
            serviceTranslate = (key) => bound(key);
            ui.renderPanel();
          } catch (error) {
            serviceTranslate = null;
            console.warn('[dsh-functions] Client locale 服务不可用，退回本地词典：', error);
          }
        });
      } catch (error) {
        /* 老版本客户端没有 ctx.inject，保持本地词典 */
      }

      ctx.effect(() => {
        try {
          document.body.append(ui.host);
        } catch (error) {
          console.error('[dsh-functions] 无法挂载「功能」标签：', error);
          return () => undefined;
        }
        const reposition = () => ui.place();
        ui.renderPanel();
        reposition();
        // 开机先拉一次宿主清单：宿主注册的功能（例如「重启 DSH」）不该等你点开才存在。
        void registry.refreshHost();

        // 位置跟着外壳变，不轮询：
        //   - 原生菜单栏由外壳 preload 晚挂（等 [data-shell-overlay] 渲染完）；
        //   - 侧栏折叠 / 换语言 / 全屏会改 html 上的属性或内联样式；
        //   - 窗口尺寸变化。
        // 这三类时机 + 启动期有限重试已经覆盖全部会挪动锚点的情况。
        let lastLanguage = document.documentElement.getAttribute('lang') || '';
        const environmentObserver = new MutationObserver(() => {
          const language = document.documentElement.getAttribute('lang') || '';
          if (language !== lastLanguage) {
            lastLanguage = language;
            refreshDictionary();
            ui.renderPanel();
          }
          reposition();
        });
        try {
          environmentObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['lang', 'style', 'data-sidebar-collapsed', 'data-fullscreen', 'data-windows-titlebar'],
          });
        } catch (observeError) {
          /* 观察不到就只靠 resize */
        }
        const bodyObserver = new MutationObserver(() => {
          if (document.querySelector('[data-windows-menu]') !== null) reposition();
        });
        try {
          bodyObserver.observe(document.body, { childList: true });
        } catch (observeError) {
          /* 观察不到就只靠 resize */
        }
        window.addEventListener('resize', reposition);
        // 启动期有限重试：拿不到锚点就每 100ms 试一次，最多 3 秒；拿到就停。
        let bootAttempts = 0;
        const bootTimer = setInterval(() => {
          bootAttempts += 1;
          const anchorFound = document.querySelector('[data-windows-menu]') !== null;
          reposition();
          if (anchorFound || bootAttempts >= 30) clearInterval(bootTimer);
        }, 100);

        return () => {
          clearInterval(bootTimer);
          window.removeEventListener('resize', reposition);
          environmentObserver.disconnect();
          bodyObserver.disconnect();
          try {
            if (globalThis.__DSH_FUNCTIONS__ === api) delete globalThis.__DSH_FUNCTIONS__;
          } catch (error) {
            /* 删不掉就算了 */
          }
          ui.dispose();
        };
      }, 'dsh-functions: 顶端「功能」标签');
    }

    const inject = [];

    return { apply, inject };
  },
});
