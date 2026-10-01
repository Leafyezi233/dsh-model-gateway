/**
 * dsh-model-gateway — browser half.
 *
 * Adds one page to the Settings panel that shows the gateway's OpenAI-compatible
 * endpoints and manages API keys. The page talks to the host half over the
 * existing Connection RPC channel (`/model-relay`), so it is reachable only
 * from an authenticated DSH page and never through the `/v1` API itself.
 *
 * A freshly created key's plaintext rides exactly one RPC response and lives
 * only in this component's memory until the dialog closes: the host stores a
 * SHA-256 hash, so the value cannot be recovered afterwards by design.
 *
 * @module dsh-model-gateway/client
 */
window.__ModuleLoader__.load({
	/**
	 * MUST equal this package's name.
	 *
	 * `dsh-client-modules` derives the graph row id from the package name and
	 * then asserts the loaded bundle registered that exact id:
	 *
	 *   if (!this.factories.has(id)) throw new Error(
	 *     `client-modules: bundle ${url} loaded without registering "${id}" ...`)
	 *
	 * So the browser half cannot keep an unscoped id once package.json is
	 * scoped — the bundle loads, registers a different key, and the whole
	 * plugin fails to import with "loaded without registering".
	 */
	id: "@leaf233/dsh-model-gateway",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const Fragment = jsxRuntime.Fragment;

		/** Settings namespace owning this page's copy. */
		const NS = "settings.model-relay";
		/**
		 * Settings endpoint, relative on purpose.
		 *
		 * Resolving a RELATIVE URL against `document.baseURI` keeps whatever
		 * path prefix the deployment serves the app under. A root-absolute
		 * `/api/...` would resolve against the origin and drop that prefix,
		 * which is exactly how a reverse-proxied deployment returns 404.
		 */
		const SETTINGS_ROUTE = "api/model-relay";
		/** Marker attribute keeping the injected stylesheet single-instance across HMR. */
		const STYLE_MARKER = "dshOpenaiGatewayStyles";
		/**
		 * Sample-size threshold below which a badge is marked unproven.
		 *
		 * Mirrors the server's `RECENT_WINDOW` (lib/stats.js) on purpose: a recent
		 * ratio only becomes meaningful once the recent window has filled, and the
		 * client must not import server internals (the bundle has no relative
		 * require), so the value is restated here with a test pinning the pair.
		 */
		const SAMPLE_THRESHOLD = 20;

		const css = `
.dsh-gw-root{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xs-13,13px);line-height:1.6}
.dsh-gw-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.dsh-gw-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-gw-card-title{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-gw-desc{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13,13px)}
.dsh-gw-muted{color:var(--dsw-alias-label-tertiary)}
.dsh-gw-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsh-gw-row:first-of-type{border-top:none}
.dsh-gw-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-gw-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;word-break:break-all}
.dsh-gw-key-label{font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-gw-empty{padding:14px 0;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dsh-gw-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-gw-field{display:flex;flex-direction:column;gap:6px}
.dsh-gw-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xs-13,13px);outline:none}
.dsh-gw-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-gw-reveal{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-layer-2)}
.dsh-gw-reveal-head{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-state-warn-label);font-weight:600}
.dsh-gw-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-gw-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsh-gw-error{color:var(--dsw-alias-state-error-primary)}
.dsh-gw-paths{display:flex;flex-direction:column;gap:6px}
.dsh-gw-path{display:flex;align-items:baseline;gap:8px}
.dsh-gw-method{font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:34px}
.dsh-gw-stat{display:inline-flex;align-items:center;gap:5px}
.dsh-gw-stat-num{font-variant-numeric:tabular-nums}
.dsh-gw-stat-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-gw-stat-warn{color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsh-gw-stat-recovering{color:var(--dsw-alias-state-warning-primary,#d97706)}
.dsh-gw-heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:2px}
.dsh-gw-heat-cell{width:10px;height:10px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,#e5e7eb);outline:1px solid var(--dsw-alias-border-l2,#d1d5db);outline-offset:-1px}
.dsh-gw-heat-empty{background:transparent;outline:1px dashed var(--dsw-alias-border-l2,#9ca3af)}
.dsh-gw-heat-pad{width:10px;height:10px}
.dsh-gw-heat-l1{background:var(--dsw-alias-state-success-primary,#16a34a);opacity:0.35}
.dsh-gw-heat-l2{background:var(--dsw-alias-state-success-primary,#16a34a);opacity:0.55}
.dsh-gw-heat-l3{background:var(--dsw-alias-state-success-primary,#16a34a);opacity:0.75}
.dsh-gw-heat-l4{background:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-gw-trend{width:100%;height:60px}
.dsh-gw-heat-legend{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-gw-heat-legend-swatch{display:inline-block}
.dsh-gw-heat-toggle{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:none;padding:2px 10px;cursor:pointer}
.dsh-gw-stat-bad{color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-gw-stat-none{color:var(--dsw-alias-label-tertiary)}
`;
		// The factory runs once per materialization; the marker keeps HMR
		// re-materialization from stacking duplicate stylesheets.
		if (document.querySelector(`style[data-${STYLE_MARKER}]`) === null) {
			const style = document.createElement("style");
			style.dataset[STYLE_MARKER] = "1";
			style.textContent = css;
			document.head.appendChild(style);
		}

		const zh = {
			nav: "模型中转站",
			title: "模型中转站",
			subtitle: "把 DSH 里已注册的模型，以标准 OpenAI 接口提供给其他项目使用。",
			endpointTitle: "接口地址",
			endpointDesc: "其他项目把 base_url 指向下面的地址即可。这里用的是 DSH 实际监听的端口，不经过反向代理。",
			baseUrl: "Base URL",
			pathModels: "模型列表",
			pathChat: "对话补全",
			keysTitle: "API 密钥",
			keysDesc: "密钥以 SHA-256 哈希保存，明文只在创建时显示一次。",
			keyLabel: "备注名（可选）",
			keyLabelPlaceholder: "例如：我的笔记本",
			createKey: "创建密钥",
			revoke: "删除",
			createTitle: "创建 API 密钥",
			createDesc: "为这个密钥起个便于辨认的备注名，便于日后在列表里区分。",
			createdTitle: "密钥已创建",
			createdWarn: "请立刻复制保存。关闭后无法再次查看——服务端只保存哈希值。",
			done: "完成",
			cancel: "取消",
			confirm: "创建",
			revokeTitle: "删除密钥",
			revokeDesc: "删除后，使用这个密钥的项目会立即失去访问权限。此操作不可撤销。",
			revokeConfirm: "确认删除",
			noKeys: "还没有密钥。当前接口对所有调用方开放——创建密钥即可开启校验。",
			staticKeys: "另有 {n} 个由 profile 配置固定的密钥。",
			authOff: "未启用鉴权，任何人都可以调用。",
			authOn: "已启用鉴权，调用方必须携带密钥。",
			authToggleOff: "开启鉴权",
			authToggleOn: "关闭鉴权",
			authLockedHint: "删除最后一个密钥后仍保持锁定，必须显式关闭才会重新开放。",
			authOpenHint: "当前任何人都可以调用这个接口。",
			authFixedHint: "profile 配置里还有固定密钥，无法在此关闭鉴权。",
			loading: "加载中…",
			failed: "加载失败",
			retry: "重试",
			createdAt: "创建于",
			modelsTitle: "可用模型",
			modelsDesc: "共 {n} 个模型，来自 {p} 个供应商。模型名以「供应商_模型」命名，避免不同供应商重名。",
			modelsEmpty: "没有可用模型。",
			keysFile: "密钥存储位置",
			groupsTitle: "模型分组",
			groupsDesc: "给一组模型起个名字。调用这个名字时，按下面的顺序依次尝试，第一个能应答的就被采用。分组也会出现在 DSH 自己的模型选择器里，以及 /v1/models 列表里。",
			groupsEmpty: "还没有分组。",
			noGroups: "还没有分组。创建一个之后就能用它的名字直接调用。",
			groupsFile: "分组存储位置",
			createGroup: "新建分组",
			createGroupTitle: "新建分组",
			editGroupTitle: "编辑分组",
			deleteGroupTitle: "删除分组",
			groupDialogDesc: "候选模型按顺序回退：第一个失败会尝试下一个。只有在还没有任何输出之前失败，才会换下一个。",
			groupName: "分组名",
			groupNamePlaceholder: "例如 fast-chat",
			groupNameHint: "只能用字母、数字、- 和 .，不能用下划线（下划线是模型名里供应商和模型的分隔符）。",
			groupModels: "候选模型（从上到下依次尝试）",
			groupAddModel: "添加候选模型…",
			groupKind: "分组类型",
			kindModel: "普通分组（只放模型）",
			kindComposite: "组合分组（可以包含其他分组）",
			kindModelHint: "成员只能是具体模型。",
			kindCompositeHint: "成员只能是一个已存在的普通分组，写成 dsh-model-gateway_<分组名>。被引用的分组会保留它自己的调度方式，不会被摊平。组合分组不能包含组合分组。",
			groupDangling: "有 {n} 个成员已失效",
			groupDanglingHint: "被引用的分组已被删除、改名或改成了组合分组。请编辑这个分组修正。",
			groupKindBadge: "组合",
			groupDisabled: "（已停用）",
			groupScheduling: "调度方式",
			presetSequential: "顺序（默认）",
			presetSequentialDesc: "按上面的顺序依次尝试，遇到不可用就顺延到下一个。",
			presetBalanced: "均衡",
			presetBalancedDesc: "每次请求轮换起点，分摊到所有候选。同一会话可能落到不同供应商上。",
			presetRandom: "随机",
			presetRandomDesc: "每次请求打乱顺序。同一会话可能落到不同供应商上。",
			presetRetry: "顺序 + 限流重试",
			presetRetryDesc: "按顺序尝试；遇到限流（429）时在同一条腿上重试若干次，再顺延。",
			retryTimes: "限流重试次数",
			retryHint: "只对「限流」重试。额度用尽、凭证失效等重试也没用，直接换下一条腿。",
			strategySequential: "顺序",
			strategyRoundRobin: "均衡",
			strategyRandom: "随机",
			strategyRetryBadge: "重试 {n} 次",
			refreshStats: "刷新统计",
			refreshStatsHint: "统计只在你点这个按钮时更新，页面不会自动轮询。",
			statNeverCalled: "还没有被调用过。",
			statAttempts: "尝试 {n} 次",
			statAnswered: "已应答 {n}",
			statRefused: "未应答 {n}",
			statRetried: "因限流重试 {n} 次",
			statIgnored: "{n} 次与候选无关，未计入",
			statLifetime: "累计应答率 {n}",
			statLastFailure: "最近失败 {code}（{ago}）",
			statRecovering: "近期已恢复；累计应答率仍低，见下方累计值",
			statSampleSmall: "样本量 {n}，不足 {threshold}，仅供参考",
			chartsTitle: "使用图表",
			chartsByCalls: "按调用次数",
			chartsByTokens: "按 token 量",
			chartsSpan: "最近 {n} 天",
			chartsHint: "从插件安装或升级后开始记录；绿色为已应答、红色为未应答。分组没有小时级历史（小时桶只存全局）。",
			chartsLegendScale: "少 → 多",
			chartsLegendCalls: "调用次数",
			chartsLegendTokens: "token 量",
			chartsTipCalls: "调用 {n} · 应答 {a} · 未应答 {r}",
			chartsTipTokens: "输入 {in} tok · 输出 {out} tok",
			chartsTipEmpty: "无数据",
			statSecondsAgo: "{n} 秒前",
			statMinutesAgo: "{n} 分钟前",
			statHoursAgo: "{n} 小时前",
			statDaysAgo: "{n} 天前",
			edit: "编辑",
			loopbackHint: "DSH 只监听本机，所以只有这台机器上的程序能调用。",
			lanHint: "DSH 监听所有网卡，同一网络的其他机器也能调用这个地址。",
			lanTitle: "局域网访问",
			lanDesc: "额外开的独立监听端口，只提供模型接口，不会暴露 DSH 界面。下面的地址给同一网络的其他设备用。",
			lanAuthOk: "已启用鉴权，其他设备需要携带密钥才能调用。",
			lanAuthWarn: "警告：当前没有密钥，同一网络的任何设备都能调用这个接口。建议先创建一个密钥。",
			lanNoAddress: "没有检测到可用的局域网地址。",
			lanHidden: "已隐藏 {n} 个虚拟网卡（Docker/网桥等）地址。",
			usageHint: "示例",
			copyLabel: "复制",
			copiedLabel: "已复制",
			createFailed: "创建失败",
			revokeFailed: "删除失败",
		};
		const en = {
			nav: "Model Relay",
			title: "Model Relay",
			subtitle: "Serve models registered in DSH over a standard OpenAI API for other projects.",
			endpointTitle: "Endpoints",
			endpointDesc: "Point another project's base_url at the address below. These use the port DSH listens on directly, bypassing any reverse proxy.",
			baseUrl: "Base URL",
			pathModels: "Model list",
			pathChat: "Chat completions",
			keysTitle: "API keys",
			keysDesc: "Keys are stored as SHA-256 hashes; the plaintext is shown once at creation.",
			keyLabel: "Label (optional)",
			keyLabelPlaceholder: "e.g. my laptop",
			createKey: "Create key",
			revoke: "Delete",
			createTitle: "Create an API key",
			createDesc: "Give the key a recognizable label so it is easy to tell apart later.",
			createdTitle: "Key created",
			createdWarn: "Copy it now. It cannot be shown again — only its hash is stored.",
			done: "Done",
			cancel: "Cancel",
			confirm: "Create",
			revokeTitle: "Delete key",
			revokeDesc: "Projects using this key lose access immediately. This cannot be undone.",
			revokeConfirm: "Delete",
			noKeys: "No keys yet. The endpoint is open to everyone — create a key to turn authentication on.",
			staticKeys: "Plus {n} fixed key(s) from the profile configuration.",
			authOff: "Authentication is off; anyone can call this endpoint.",
			authOn: "Authentication is on; callers must present a key.",
			authToggleOff: "Require a key",
			authToggleOn: "Stop requiring a key",
			authLockedHint: "Deleting the last key keeps the endpoint locked; turn it off explicitly to reopen it.",
			authOpenHint: "Anyone can currently call this endpoint.",
			authFixedHint: "A fixed key from the profile configuration keeps authentication on.",
			loading: "Loading…",
			failed: "Failed to load",
			retry: "Retry",
			createdAt: "Created",
			modelsTitle: "Available models",
			modelsDesc: "{n} models across {p} providers. Names are prefixed with the provider to keep them unique.",
			modelsEmpty: "No models available.",
			keysFile: "Key store",
			groupsTitle: "Model groups",
			groupsDesc: "Give a set of models one name. Calling that name tries the candidates below in order and uses the first that answers. A group also appears in DSH's own model picker and in the /v1/models listing.",
			groupsEmpty: "No groups yet.",
			noGroups: "No groups yet. Create one and you can call it by name directly.",
			groupsFile: "Group store",
			createGroup: "New group",
			createGroupTitle: "New group",
			editGroupTitle: "Edit group",
			deleteGroupTitle: "Delete group",
			groupDialogDesc: "Candidates fail over in order: when one fails, the next is tried. This only happens before any output has been produced.",
			groupName: "Group name",
			groupNamePlaceholder: "e.g. fast-chat",
			groupNameHint: "Letters, digits, - and . only. No underscore: that is the separator between provider and model in a model name.",
			groupModels: "Candidates (tried top to bottom)",
			groupAddModel: "Add a candidate model…",
			groupKind: "Group kind",
			kindModel: "Plain group (models only)",
			kindComposite: "Composite group (may contain other groups)",
			kindModelHint: "Members must be concrete models.",
			kindCompositeHint: "Members must be existing plain groups, written as dsh-model-gateway_<group>. The referenced group keeps its own scheduling instead of being flattened. A composite may not contain another composite.",
			groupDangling: "{n} member(s) no longer resolve",
			groupDanglingHint: "A referenced group was deleted, renamed, or turned into a composite. Edit this group to fix it.",
			groupKindBadge: "composite",
			groupDisabled: "(disabled)",
			groupScheduling: "Scheduling",
			presetSequential: "Sequential (default)",
			presetSequentialDesc: "Try the list in order, moving on when one is unavailable.",
			presetBalanced: "Balanced",
			presetBalancedDesc: "Rotate the starting point per request so the load is shared. A session may land on different providers.",
			presetRandom: "Random",
			presetRandomDesc: "Shuffle per request. A session may land on different providers.",
			presetRetry: "Sequential + rate-limit retry",
			presetRetryDesc: "Try in order; on a rate limit (429) retry the same candidate a few times before moving on.",
			retryTimes: "Rate-limit retries",
			retryHint: "Only rate limits are retried. An exhausted quota or a bad credential answers the same on the second ask, so the next candidate is tried instead.",
			strategySequential: "Sequential",
			strategyRoundRobin: "Balanced",
			strategyRandom: "Random",
			strategyRetryBadge: "retry x{n}",
			refreshStats: "Refresh stats",
			refreshStatsHint: "Statistics only update when you press this; the page never polls.",
			statNeverCalled: "Never called yet.",
			statAttempts: "{n} attempts",
			statAnswered: "{n} answered",
			statRefused: "{n} refused",
			statRetried: "{n} rate-limit retries",
			statIgnored: "{n} not this candidate's fault, not counted",
			statLifetime: "{n} lifetime answer rate",
			statLastFailure: "last failure {code} ({ago})",
			statRecovering: "Recovered recently; lifetime rate still low — see the lifetime figure below",
			statSampleSmall: "sample size {n}, below {threshold}, indicative only",
			chartsTitle: "Usage charts",
			chartsByCalls: "by calls",
			chartsByTokens: "by tokens",
			chartsSpan: "last {n} days",
			chartsHint: "Recorded from install or upgrade onward; green is answered, red is refused. Groups have no hourly history (hourly buckets are global only).",
			chartsLegendScale: "less → more",
			chartsLegendCalls: "calls",
			chartsLegendTokens: "tokens",
			chartsTipCalls: "calls {n} · answered {a} · refused {r}",
			chartsTipTokens: "in {in} tok · out {out} tok",
			chartsTipEmpty: "no data",
			statSecondsAgo: "{n}s ago",
			statMinutesAgo: "{n}m ago",
			statHoursAgo: "{n}h ago",
			statDaysAgo: "{n}d ago",
			edit: "Edit",
			loopbackHint: "DSH binds loopback only, so only programs on this machine can call it.",
			lanHint: "DSH binds all interfaces, so other machines on this network can call it too.",
			lanTitle: "LAN access",
			lanDesc: "A separate listener that serves only the model API — it never exposes the DSH UI. Use these addresses from other devices on the same network.",
			lanAuthOk: "Authentication is on, so other devices must present a key.",
			lanAuthWarn: "Warning: no key is configured, so any device on this network can call this endpoint. Create a key first.",
			lanNoAddress: "No LAN address was detected.",
			lanHidden: "{n} virtual interface (Docker/bridge) addresses are hidden.",
			usageHint: "Example",
			copyLabel: "Copy",
			copiedLabel: "Copied",
			createFailed: "Could not create the key",
			revokeFailed: "Could not delete the key",
		};

		/** Interpolate the `{name}` placeholders a dictionary value may carry. */
		function fill(text, values) {
			return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
		}

		/** Format an epoch millisecond value as a short local date-time. */
		function formatTime(value) {
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (n) => String(n).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/**
		 * The four scheduling presets the dialog offers.
		 *
		 * Presets, not storage: a group stores two orthogonal fields
		 * (`strategy` and `retry429`), and these are the combinations worth
		 * naming. The distinction matters because it makes "balanced, plus
		 * retry" expressible without a fifth preset, and because the backend
		 * never has to interpret a combined enum.
		 */
		const PRESETS = [
			{ id: "sequential", strategy: "sequential", retry429: 0, label: "presetSequential", desc: "presetSequentialDesc" },
			{ id: "balanced", strategy: "round-robin", retry429: 0, label: "presetBalanced", desc: "presetBalancedDesc" },
			{ id: "random", strategy: "random", retry429: 0, label: "presetRandom", desc: "presetRandomDesc" },
			{ id: "retry", strategy: "sequential", retry429: 1, label: "presetRetry", desc: "presetRetryDesc" },
		];

		/**
		 * The preset id matching a stored pair, or the closest representable one.
		 *
		 * The retry-free presets are matched by strategy alone. Matching the pair
		 * exactly instead would send `{ strategy: 'random' }` to Sequential,
		 * because Random's preset carries `retry429: 0` and a stored document need
		 * not spell that field out — so confirming an untouched dialog would
		 * silently rewrite the group's scheduling. Only a retry count forces the
		 * sequential+retry preset, since that is the one combination the four
		 * presets can express.
		 */
		function presetOf(strategy, retry429) {
			if ((retry429 ?? 0) > 0) return "retry";
			return PRESETS.find((preset) => preset.strategy === strategy && preset.retry429 === 0)?.id ?? "sequential";
		}

		/**
		 * The scoreboard row for one candidate, or undefined when it was never called.
		 *
		 * Read from the listing payload rather than cached in React state: the numbers
		 * change on every request, so a cache would only ever serve stale ones.
		 */
		function statRowOf(stats, groupName, model) {
			return stats?.[groupName]?.candidates?.[model];
		}

		/**
		 * Whether a candidate spelling names another group of this gateway.
		 *
		 * A composite's members are `dsh-model-gateway_<group>`; a plain group's
		 * candidates are concrete `<provider>_<model>` pairs. The prefix is the
		 * gateway's own exposure namespace (see the composite docs in
		 * `lib/index.js`), so the check is a pure string test.
		 */
		function isCompositeMember(model) {
			return typeof model === "string" && model.startsWith("dsh-model-gateway_");
		}

		/**
		 * The expanded scoreboard rows under one toggled composite member.
		 *
		 * The inner group's name is the member spelling minus the prefix; its rows
		 * are the same candidate pills the inner group's own card would show. The
		 * inner group has no card of its own on this page (only composites are
		 * listed), so this drill-in is the only place its per-candidate health is
		 * visible — which is the whole point of F3.
		 */
		/**
		 * Assemble the last N local dates (oldest → newest) from the history
		 * snapshot. Missing days are zero days — the heatmap started recording
		 * when the plugin was upgraded, not before, and the chart must say
		 * "no data" through emptiness without inventing numbers.
		 */
		function buildDaySeries(history, span) {
			const out = [];
			const days = history?.days ?? {};
			for (let at = span - 1; at >= 0; at -= 1) {
				const d = new Date(Date.now() - at * 86400000);
				const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
				out.push({ key, day: days[key] });
			}
			return out;
		}

		/**
		 * The 90-day usage heatmap: one column per week, one row per weekday,
		 * Sunday first — the same shape as the reference heatmap but spanning
		 * exactly the retention window, so no cell is structurally empty.
		 * Values are calls (answered + refused); tokens switch via `metric`.
		 * Pure CSS grid, no chart library (the shell offers none).
		 */
		function Heatmap({ t, history, span, metric }) {
			const series = buildDaySeries(history, span);
			// Pad the front so the first day lands on its weekday row.
			const first = new Date(series[0].key + "T00:00:00");
			const lead = first.getDay();
			const cells = [];
			for (let at = 0; at < lead; at += 1) cells.push(null);
			for (const entry of series) {
				const day = entry.day;
				const value = day === undefined ? 0
					: metric === "tokens" ? (day.inputTokens ?? 0) + (day.outputTokens ?? 0)
					: (day.answered ?? 0) + (day.refused ?? 0);
				cells.push({ value, key: entry.key, empty: day === undefined, day });
			}
			const peak = cells.reduce((n, c) => Math.max(n, c?.value ?? 0), 0);
			return jsx("div", {
				className: "dsh-gw-heat",
				role: "img",
				"aria-label": "heatmap",
				children: cells.map((cell, at) => jsx("span", {
					className: cell === null ? "dsh-gw-heat-pad"
						: "dsh-gw-heat-cell" + (cell.empty && cell.value === 0 ? " dsh-gw-heat-empty" : "")
							+ (cell.value === 0 ? "" : " " + heatLevel(cell.value, peak)),
					// Hover shows the day's full usage, not just the date: calls,
					// answer split, and tokens. Display-only; the day row already
					// carries every field.
					title: heatCellTitle(t, cell, metric),
				}, at)),
			});
		}

		/**
		 * The hover text for one heatmap day: date, calls, and token usage.
		 *
		 * The day row already carries every field (snapshot: requests/calls/
		 * answered/refused/inputTokens/outputTokens), so this is display-only.
		 * Numbers are locale-formatted; an absent day says so instead of showing
		 * zeros that would read as "recorded, all zero".
		 */
		function heatCellTitle(t, cell, metric) {
			if (cell === undefined || cell === null) return "";
			if (cell.empty) return cell.key + "\n" + t("chartsTipEmpty");
			const day = cell.day;
			const n = (v) => (typeof v === "number" ? v.toLocaleString() : "0");
			const lines = [cell.key];
			if (metric === "tokens") {
				lines.push(fill(t("chartsTipTokens"), { in: n(day?.inputTokens), out: n(day?.outputTokens) }));
			}
			lines.push(fill(t("chartsTipCalls"), {
				n: n(day?.calls), a: n(day?.answered), r: n(day?.refused),
			}));
			if (metric !== "tokens" && (day?.inputTokens > 0 || day?.outputTokens > 0)) {
				lines.push(fill(t("chartsTipTokens"), { in: n(day?.inputTokens), out: n(day?.outputTokens) }));
			}
			return lines.join("\n");
		}

		/** Four-level intensity, same idea as the reference implementation. */
		function heatLevel(value, peak) {
			if (peak <= 0) return "";
			const ratio = value / peak;
			if (ratio > 0.75) return "dsh-gw-heat-l4";
			if (ratio > 0.5) return "dsh-gw-heat-l3";
			if (ratio > 0.25) return "dsh-gw-heat-l2";
			return "dsh-gw-heat-l1";
		}

		/**
		 * The answered/refused trend: a hand-drawn SVG polyline pair over the
		 * same span. `non-scaling-stroke` keeps the lines from fattening under
		 * the non-uniform preserveAspectRatio stretch.
		 */
		function TrendChart({ history, span }) {
			const series = buildDaySeries(history, span);
			const answered = series.map((entry) => entry.day?.answered ?? 0);
			const refused = series.map((entry) => entry.day?.refused ?? 0);
			const peak = Math.max(1, ...answered, ...refused);
			const width = span - 1;
			const toPoints = (values) => values
				.map((v, at) => `${at},${30 - (v / peak) * 28}`)
				.join(" ");
			return jsx("svg", {
				className: "dsh-gw-trend",
				viewBox: `0 0 ${width} 30`,
				preserveAspectRatio: "none",
				children: [
					jsx("polyline", {
						points: toPoints(answered),
						fill: "none",
						stroke: "var(--dsw-alias-state-success-primary,#16a34a)",
						strokeWidth: 1,
						vectorEffect: "non-scaling-stroke",
					}, "answered"),
					jsx("polyline", {
						points: toPoints(refused),
						fill: "none",
						stroke: "var(--dsw-alias-state-error-primary,#dc2626)",
						strokeWidth: 1,
						vectorEffect: "non-scaling-stroke",
					}, "refused"),
				],
			});
		}

		/** The charts card: one heatmap (metric toggle) plus the trend. */
		function ChartsCard({ t, history }) {
			const [metric, setMetric] = react.useState("calls");
			const span = (history?.keepDays ?? 90);
			return jsxs("div", {
				className: "dsh-gw-card",
				children: [
					jsxs("div", { className: "dsh-gw-card-title", children: [t("chartsTitle")] }),
					jsx("div", {
						className: "dsh-gw-inline",
						children: [
							jsx("button", {
								className: "dsh-gw-heat-toggle",
								onClick: () => setMetric(metric === "calls" ? "tokens" : "calls"),
								children: metric === "calls" ? t("chartsByCalls") : t("chartsByTokens"),
							}, "metric"),
							jsx("span", { className: "dsh-gw-muted", children: t("chartsSpan").replace("{n}", String(span)) }, "span"),
						],
					}),
					jsx(Heatmap, { t, history, span, metric }),
					// Legend: the four intensity cells reuse the heat classes
					// themselves, so legend and grid can never drift apart on
					// color. The leading hollow cell is the no-data sample.
					jsx("div", {
						className: "dsh-gw-heat-legend",
						children: [
							jsx("span", { className: "dsh-gw-heat-cell dsh-gw-heat-empty dsh-gw-heat-legend-swatch", title: t("chartsTipEmpty") }, "lg-none"),
							jsx("span", { className: "dsh-gw-heat-cell dsh-gw-heat-l1 dsh-gw-heat-legend-swatch" }, "lg-1"),
							jsx("span", { className: "dsh-gw-heat-cell dsh-gw-heat-l2 dsh-gw-heat-legend-swatch" }, "lg-2"),
							jsx("span", { className: "dsh-gw-heat-cell dsh-gw-heat-l3 dsh-gw-heat-legend-swatch" }, "lg-3"),
							jsx("span", { className: "dsh-gw-heat-cell dsh-gw-heat-l4 dsh-gw-heat-legend-swatch" }, "lg-4"),
							jsx("span", {
								className: "dsh-gw-muted",
								children: metric === "tokens"
									? `${t("chartsLegendScale")} · ${t("chartsLegendTokens")}`
									: `${t("chartsLegendScale")} · ${t("chartsLegendCalls")}`,
							}, "lg-text"),
						],
					}),
					jsx(TrendChart, { history, span }),
					jsx("div", { className: "dsh-gw-muted", children: t("chartsHint") }),
				],
			});
		}

		function renderMemberRows(t, group, model, stats) {
			const inner = model.slice("dsh-model-gateway_".length);
			const innerStats = stats?.[inner];
			const rows = Object.keys(innerStats?.candidates ?? {});
			return [jsx("div", {
				className: "dsh-gw-member-rows",
				style: { paddingLeft: 18 },
				key: `${group.name}/${model}/rows`,
				children: jsxs(Fragment, {
					children: [
						jsx("div", { className: "dsh-gw-muted", children: `${inner}` }),
						rows.length === 0
							? jsx("div", { className: "dsh-gw-muted", children: t("statNeverCalled") })
							: jsx("div", {
								className: "dsh-gw-chips",
								children: rows.map((candidate) => {
									const row = innerStats.candidates[candidate];
									return jsx("span", {
										className: "dsh-gw-stat dsh-gw-stat-" + statTone(row),
										title: statTooltip(t, row),
										children: jsx(primitives.Pill, {
											children: jsxs(Fragment, {
												children: [
													candidate,
													jsx("span", {
														className: "dsh-gw-stat-num",
														children: " " + statPercent(row.recentRatio ?? row.ratio) + " · " + row.attempts,
													}),
												],
											}),
										}),
									}, candidate);
								}),
							}),
					],
				}),
			})];
		}

		/**
		 * A ratio as a percentage, or an em dash when nothing was counted.
		 *
		 * An absent ratio must not render as 0%: a candidate that has never been
		 * called is not one that always fails, and 0% would say the opposite.
		 */
		function statPercent(ratio) {
			if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
			return Math.round(ratio * 100) + "%";
		}

		/**
		 * The colour band for a candidate: ok / warn / bad / none.
		 *
		 * Prefers the RECENT ratio so a candidate that was broken earlier and is fine
		 * now stops looking broken. The lifetime ratio is still in the tooltip, where
		 * a permanent scar is the honest thing to show.
		 */
		function statTone(row) {
			const recent = row?.recentRatio;
			const lifetime = row?.ratio;
			const shown = recent ?? lifetime;
			if (typeof shown !== "number" || !Number.isFinite(shown)) return "none";
			// F2: the recent window alone must not paint the badge green while the
			// lifetime rate says otherwise — a candidate that was broken all along
			// and merely answered the last few calls is "recovering", its own state,
			// not "healthy". A deteriorating candidate keeps the existing tiers: the
			// recent ratio already drags it toward warn/bad honestly.
			if (typeof recent === "number" && Number.isFinite(recent)
				&& typeof lifetime === "number" && Number.isFinite(lifetime)
				&& recent >= 0.9 && lifetime < 0.9) return "recovering";
			if (shown >= 0.9) return "ok";
			if (shown >= 0.5) return "warn";
			return "bad";
		}

		/** How long ago a timestamp was, in the compact form the tooltip uses. */
		function statAgo(ts, t) {
			if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
			const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
			if (seconds < 60) return fill(t("statSecondsAgo"), { n: seconds });
			if (seconds < 3600) return fill(t("statMinutesAgo"), { n: Math.floor(seconds / 60) });
			if (seconds < 86400) return fill(t("statHoursAgo"), { n: Math.floor(seconds / 3600) });
			return fill(t("statDaysAgo"), { n: Math.floor(seconds / 86400) });
		}

		/**
		 * The hover text for one candidate's statistics.
		 *
		 * Spells out the lifetime figures even when the badge shows the recent ones, so
		 * the two never have to be reconciled from memory. `ignored` is named whenever
		 * it is non-zero: without it, a candidate whose only failures were excused
		 * would look like it had none at all.
		 */
		function statTooltip(t, row) {
			if (row === undefined) return t("statNeverCalled");
			const lines = [fill(t("statAttempts"), { n: row.attempts })];
			lines.push(fill(t("statAnswered"), { n: row.answered }) + " · " + fill(t("statRefused"), { n: row.refused }));
			if (row.retry429 > 0) lines.push(fill(t("statRetried"), { n: row.retry429 }));
			if (row.ignored > 0) lines.push(fill(t("statIgnored"), { n: row.ignored }));
			if (typeof row.ratio === "number") lines.push(fill(t("statLifetime"), { n: statPercent(row.ratio) }));
			if (row.lastCode !== undefined) {
				lines.push(fill(t("statLastFailure"), { code: row.lastCode, ago: statAgo(row.lastAt, t) }));
			}
			// F2: when the recent and lifetime stories disagree, say so outright —
			// the badge alone cannot carry both truths.
			if (statTone(row) === "recovering") lines.push(t("statRecovering"));
			// F1: name the threshold when the sample is too small to trust.
			if (row.attempts < SAMPLE_THRESHOLD) lines.push(fill(t("statSampleSmall"), { n: row.attempts, threshold: SAMPLE_THRESHOLD }));
			return lines.join("\n");
		}

		/** The badge text for a stored pair, so a group's behavior is visible. */
		function strategyBadge(t, strategy, retry429) {
			if (strategy === "round-robin") return t("strategyRoundRobin");
			if (strategy === "random") return t("strategyRandom");
			if ((retry429 ?? 0) > 0) return `${t("strategySequential")} · ${fill(t("strategyRetryBadge"), { n: retry429 })}`;
			return t("strategySequential");
		}

		/** Render the OpenAI SDK example for the current origin. */
		function exampleSnippet(origin, basePath) {
			return [
				"from openai import OpenAI",
				"",
				`client = OpenAI(base_url="${origin}${basePath}", api_key="<your-key>")`,
				"",
				"client.chat.completions.create(",
				'    model="<model-id>",',
				'    messages=[{"role": "user", "content": "hello"}],',
				")",
			].join("\n");
		}

		/**
		 * Call the plugin's settings endpoint.
		 *
		 * The URL is deliberately relative so it resolves against
		 * `document.baseURI`; see {@link SETTINGS_ROUTE}. The response envelope
		 * mirrors the Connection RPC shape so call sites stay uniform.
		 * @param action - endpoint action name.
		 * @param payload - action payload.
		 * @returns the decoded result envelope.
		 */
		async function callSettings(action, payload) {
			const rpcId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			let response;
			try {
				response = await fetch(new URL(SETTINGS_ROUTE, document.baseURI), {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ type: "client-request", rpcId, payload: { action, ...payload } }),
				});
			} catch (cause) {
				return { ok: false, error: { code: "TRANSPORT", message: String(cause?.message ?? cause), details: {} } };
			}
			if (!response.ok) {
				return { ok: false, error: { code: "TRANSPORT", message: `HTTP ${response.status}`, details: {} } };
			}
			try {
				const envelope = await response.json();
				return envelope?.result ?? { ok: false, error: { code: "MALFORMED", message: "malformed settings response", details: {} } };
			} catch (cause) {
				return { ok: false, error: { code: "MALFORMED", message: String(cause?.message ?? cause), details: {} } };
			}
		}

		/** One endpoint row: method, full URL, and a copy affordance. */
		function EndpointRow({ method, url, copyLabel, copiedLabel, t }) {
			return jsx("div", {
				className: "dsh-gw-path",
				children: [
					jsx("span", { className: "dsh-gw-method", children: method }),
					jsx("div", {
						style: { flex: 1, minWidth: 0 },
						children: jsx(primitives.CodeBlock, {
							code: url,
							lang: "text",
							copyLabel: copyLabel,
							copiedLabel: copiedLabel,
						}),
					}),
				],
			});
		}

		/** The settings page body. */
		function GatewaySection({ t }) {
			const [phase, setPhase] = react.useState("loading");
			const [status, setStatus] = react.useState(undefined);
			const [error, setError] = react.useState(undefined);
			const [creating, setCreating] = react.useState(false);
			const [label, setLabel] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [created, setCreated] = react.useState(undefined);
			const [createError, setCreateError] = react.useState(undefined);
			const [revokeTarget, setRevokeTarget] = react.useState(undefined);
			const [revokeError, setRevokeError] = react.useState(undefined);
			/** Model groups: the ordered candidate lists a caller can name directly. */
			const [groups, setGroups] = react.useState([]);
			const [groupModels, setGroupModels] = react.useState([]);
			/**
			 * Per-candidate counters, keyed by group name then model.
			 *
			 * Loaded with the group listing and refreshed on demand rather than polled:
			 * the page has no background timer by design, and a scoreboard is read when
			 * someone is looking at it.
			 */
			const [stats, setStats] = react.useState({});
			const [groupDialog, setGroupDialog] = react.useState(undefined);
			const [groupDeleteTarget, setGroupDeleteTarget] = react.useState(undefined);
			const [groupBusy, setGroupBusy] = react.useState(false);
			const [groupError, setGroupError] = react.useState(undefined);
			/**
			 * F3: which composite groups are expanded to show their members' own
			 * scoreboards. Keyed by group name; a plain group never appears here.
			 * Appended last on purpose — see the hook-order note in the bundle test.
			 */
			const [expandedGroups, setExpandedGroups] = react.useState(() => new Set());
			/** 90-day persisted history from the stats store, for the charts. */
			const [statsHistory, setStatsHistory] = react.useState(undefined);

			/** Reload groups and the candidate list the picker offers. */
			const refreshGroups = react.useCallback(async () => {
				const result = await callSettings("listGroups", {});
				if (!result.ok) return;
				setGroups(result.value.groups ?? []);
				setGroupModels(result.value.models ?? []);
				setStats(result.value.stats ?? {});
				setStatsHistory(result.value.statsHistory);
			}, []);

			/** Open the dialog for a brand-new group. */
			const openCreateGroup = react.useCallback(() => {
				setGroupError(undefined);
				setGroupDialog({ mode: "create", name: "", models: [], kind: "model", preset: "sequential", retry429: 0 });
			}, []);

			/** Open the dialog seeded from an existing group. */
			const openEditGroup = react.useCallback((group) => {
				setGroupError(undefined);
				setGroupDialog({
					mode: "edit",
					id: group.name,
					name: group.name,
					// Carried so the picker offers the right half of the catalog.
					// It is NOT editable: the store ignores a kind on update, so a
					// switch here would silently do nothing.
					kind: group.kind ?? "model",
					models: [...group.models],
					// A stored pair that matches no preset still opens on the
					// closest one, so a hand-edited file is editable in the UI
					// rather than silently reset.
					preset: presetOf(group.strategy, group.retry429),
					retry429: group.retry429 ?? 0,
				});
			}, []);

			const closeGroupDialog = react.useCallback(() => {
				setGroupDialog(undefined);
				setGroupError(undefined);
				setGroupBusy(false);
			}, []);

			/** Append a candidate. Order is the routing order, so appending is the default. */
			const addGroupModel = react.useCallback((model) => {
				if (typeof model !== "string" || model === "") return;
				setGroupDialog((current) => current === undefined ? current : { ...current, models: [...current.models, model] });
			}, []);

			const removeGroupModel = react.useCallback((index) => {
				setGroupDialog((current) => current === undefined
					? current
					: { ...current, models: current.models.filter((_, at) => at !== index) });
			}, []);

			/** Reorder a candidate; the position in this list is the failover order. */
			const moveGroupModel = react.useCallback((index, delta) => {
				setGroupDialog((current) => {
					if (current === undefined) return current;
					const next = [...current.models];
					const target = index + delta;
					if (target < 0 || target >= next.length) return current;
					const [moved] = next.splice(index, 1);
					next.splice(target, 0, moved);
					return { ...current, models: next };
				});
			}, []);

			const submitGroup = react.useCallback(async () => {
				if (groupDialog === undefined) return;
				setGroupBusy(true);
				setGroupError(undefined);
				// The preset decides the pair; the retry count only rides along
				// for the preset that uses one.
				const preset = PRESETS.find((entry) => entry.id === groupDialog.preset) ?? PRESETS[0];
				const strategy = preset.strategy;
				const retry429 = preset.retry429 === 0
					? 0
					: Math.max(1, Math.min(3, Number(groupDialog.retry429) || 1));
				// The kind is only ever sent on create: the store normalizes it from
				// what is already stored on update, so sending it would imply an
				// edit that does not happen.
				const result = groupDialog.mode === "edit"
					? await callSettings("updateGroup", { id: groupDialog.id, name: groupDialog.name, models: groupDialog.models, strategy, retry429 })
					: await callSettings("createGroup", { name: groupDialog.name, models: groupDialog.models, kind: groupDialog.kind ?? "model", strategy, retry429 });
				setGroupBusy(false);
				if (!result.ok) {
					setGroupError(result.error?.message ?? t("failed"));
					return;
				}
				setGroupDialog(undefined);
				await refreshGroups();
			}, [groupDialog, refreshGroups, t]);

			const refresh = react.useCallback(async () => {
				const result = await callSettings("status", {});
				if (result.ok) {
					setStatus(result.value);
					setError(undefined);
					setPhase("idle");
					return;
				}
				setError(result.error?.message ?? t("failed"));
				setPhase("error");
			}, [t]);

			react.useEffect(() => {
				let cancelled = false;
				(async () => {
					const result = await callSettings("status", {});
					if (cancelled) return;
					if (result.ok) {
						setStatus(result.value);
						setPhase("idle");
					} else {
						setError(result.error?.message ?? "failed");
						setPhase("error");
					}
					// Groups load separately: the status read does not carry them,
					// because the candidate list depends on live provider models.
					await refreshGroups().catch(() => {});
				})().catch((cause) => {
					if (cancelled) return;
					setError(String(cause?.message ?? cause));
					setPhase("error");
				});
				return () => {
					cancelled = true;
				};
			}, []);

			/** Close the create dialog, discarding any unrevealed plaintext. */
			const closeCreate = react.useCallback(() => {
				setCreating(false);
				setLabel("");
				setCreated(undefined);
				setCreateError(undefined);
				setBusy(false);
			}, []);

			const submitCreate = react.useCallback(async () => {
				setBusy(true);
				setCreateError(undefined);
				const result = await callSettings("createKey", { label });
				setBusy(false);
				if (!result.ok) {
					setCreateError(result.error?.message ?? t("createFailed"));
					return;
				}
				setCreated(result.value);
				setLabel("");
				await refresh();
			}, [label, refresh, t]);

			/** Flip whether the gateway demands a key; never happens as a side effect of deleting one. */
			const toggleAuth = react.useCallback(async () => {
				setBusy(true);
				const result = await callSettings("setAuth", { locked: !status?.authRequired });
				setBusy(false);
				if (!result.ok) {
					setError(result.error?.message ?? t("failed"));
					return;
				}
				await refresh();
			}, [status, refresh, t]);

			const confirmRevoke = react.useCallback(async () => {
				if (revokeTarget === undefined) return;
				setBusy(true);
				setRevokeError(undefined);
				const result = await callSettings("revokeKey", { id: revokeTarget.id });
				setBusy(false);
				if (!result.ok) {
					setRevokeError(result.error?.message ?? t("revokeFailed"));
					return;
				}
				setRevokeTarget(undefined);
				await refresh();
			}, [revokeTarget, refresh, t]);

			if (phase === "loading") {
				return jsx("div", { className: "dsh-gw-root", children: jsx("div", { className: "dsh-gw-empty", children: t("loading") }) });
			}

			if (phase === "error") {
				return jsx("div", {
					className: "dsh-gw-root",
					children: jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsx("div", { className: "dsh-gw-card-title", children: t("failed") }),
							jsx("div", { className: "dsh-gw-error", children: error }),
							jsx("div", {
								className: "dsh-gw-actions",
								children: jsx(primitives.Button, {
									variant: "outline",
									size: "sm",
									onClick: () => {
										setPhase("loading");
										refresh();
									},
									children: t("retry"),
								}),
							}),
						],
					}),
				});
			}

			const basePath = status.path;
			const keys = status.keys ?? [];
			const models = status.models ?? [];
			const providers = status.providers ?? [];
			/**
			 * Endpoint origin for other projects to call.
			 *
			 * Built from the port the harness actually listens on rather than the
			 * page origin: behind a reverse proxy the page origin is the gateway,
			 * whose path rewriting would break streaming clients. A loopback bind
			 * is shown as 127.0.0.1 because no other address can reach it; an
			 * all-interfaces bind is shown under the hostname the page was opened
			 * with, which is the address a peer on the same network can use.
			 */
			const origin = status.port === undefined
				? (typeof window === "undefined" ? "" : window.location.origin)
				: `http://${status.bindHost === "0.0.0.0" ? (typeof window === "undefined" ? "127.0.0.1" : window.location.hostname) : (status.bindHost ?? "127.0.0.1")}:${status.port}`;
			const loopbackOnly = status.bindHost !== "0.0.0.0";

			return jsxs("div", {
				className: "dsh-gw-root",
				children: [
					// Model groups lead the page: creating and reordering them is
					// the recurring task here, while the endpoint details and the
					// key list are read once and then rarely touched.
					jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsxs("div", {
								className: "dsh-gw-card-head",
								children: [
									jsx("div", { className: "dsh-gw-card-title", children: t("groupsTitle") }),
									jsxs("div", {
										className: "dsh-gw-inline",
										children: [
											// The scoreboard only moves when it is read, so there has to be
											// a way to read it. A button rather than a timer: this page
											// deliberately has no background polling.
											jsx(primitives.Button, {
												variant: "ghost",
												size: "sm",
												title: t("refreshStatsHint"),
												onClick: () => {
													refreshGroups().catch(() => {});
												},
												children: t("refreshStats"),
											}),
											jsx(primitives.Button, {
												variant: "primary",
												size: "sm",
												onClick: () => openCreateGroup(),
												children: jsxs(Fragment, {
													children: [
														jsx(primitives.IconPlusOutline16, { size: 14 }),
														t("createGroup"),
													],
												}),
											}),
										],
									}),
								],
							}),
							jsx("div", { className: "dsh-gw-desc", children: t("groupsDesc") }),
							groups.length === 0
								? jsx("div", { className: "dsh-gw-empty", children: t("noGroups") })
								: jsx("div", {
									children: groups.map((group) => jsxs("div", {
										className: "dsh-gw-row",
										children: [
											jsxs("div", {
												className: "dsh-gw-row-main",
												children: [
													jsxs("div", {
														className: "dsh-gw-inline",
														children: [
															jsx("span", { className: "dsh-gw-key-label", children: group.name }),
															jsx(primitives.Pill, {
																children: strategyBadge(t, group.strategy, group.retry429),
															}),
															group.enabled
																? null
																: jsx("span", { className: "dsh-gw-muted", children: t("groupDisabled") }),
													group.kind === "composite"
														? jsx(primitives.Pill, { children: t("groupKindBadge") })
														: null,
													// A composite whose targets were deleted, renamed, or turned into
													// composites still routes; it just quietly skips those members. Saying so
													// here is the difference between the user fixing it and the user wondering
													// why a group got worse.
													(group.dangling?.length ?? 0) > 0
														? jsx("span", {
															className: "dsh-gw-stat dsh-gw-stat-bad",
															title: t("groupDanglingHint"),
															children: jsx(primitives.Pill, { children: fill(t("groupDangling"), { n: group.dangling.length }) }),
														})
														: null,
														],
													}),
													jsx("div", {
														className: "dsh-gw-chips",
														children: group.models.map((model) => {
															// One pill per candidate, carrying its scoreboard. The
															// percentage is the RECENT one when available, because
															// a member that recovered should stop looking broken;
															// the lifetime figure is in the tooltip.
															const row = statRowOf(stats, group.name, model);
															const tone = statTone(row);
															const member = isCompositeMember(model);
															return jsx("span", {
																className: "dsh-gw-stat dsh-gw-stat-" + tone,
																title: statTooltip(t, row),
																children: jsx(primitives.Pill, {
																	// F3: a composite's member pill toggles the expansion
																	// that shows the inner group's own scoreboard row. The
																	// composite's own number double-counts (one logical
																	// call is scored at both layers), so the member pill is
																	// the drill-in affordance, not another number.
																	onClick: member
																		? () => setExpandedGroups((current) => {
																			const next = new Set(current);
																			if (next.has(model)) next.delete(model);
																			else next.add(model);
																			return next;
																		})
																		: undefined,
																	children: jsxs(Fragment, {
																		children: [
																			model,
																			row === undefined
																				? null
																				: jsx("span", {
																					className: "dsh-gw-stat-num",
																					// F1: the sample size travels with the percentage, so a
																					// "100%" on 6 attempts reads as unproven at a glance.
																					children: " " + statPercent(row.recentRatio ?? row.ratio) + " · " + row.attempts,
																				}),
																		],
																	}),
																}),
															}, `${group.name}/${model}`);
														}),
													}),
													// F3: the expanded member rows, one per toggled composite member.
													(group.kind === "composite" && (group.dangling ?? []).length === 0
														? group.models.filter((model) => isCompositeMember(model) && expandedGroups.has(model))
															.flatMap((model) => renderMemberRows(t, group, model, stats))
														: []),
												],
											}),
											jsxs("div", {
												className: "dsh-gw-inline",
												children: [
													jsx(primitives.Button, {
														variant: "ghost",
														size: "sm",
														onClick: () => openEditGroup(group),
														children: t("edit"),
													}),
													jsx(primitives.Button, {
														variant: "ghost",
														size: "sm",
														onClick: () => {
															setGroupError(undefined);
															setGroupDeleteTarget(group);
														},
														children: jsxs(Fragment, {
															children: [
																jsx(primitives.IconTrashOutline16, { size: 14 }),
																t("revoke"),
															],
														}),
													}),
												],
											}),
										],
									}, group.name)),
								}),
							jsxs(ChartsCard, { t, history: statsHistory }),
							jsxs("div", {
								className: "dsh-gw-muted",
								children: [`${t("groupsFile")}: `, jsx("span", { className: "dsh-gw-mono", children: status.groupsFile })],
							}),
						],
					}),
					jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsxs("div", {
								className: "dsh-gw-card-head",
								children: [
									jsx("div", { className: "dsh-gw-card-title", children: t("title") }),
									jsx(primitives.Pill, {
										active: status.authRequired,
										children: status.authRequired ? t("authOn") : t("authOff"),
									}),
								],
							}),
							jsx("div", { className: "dsh-gw-desc", children: t("subtitle") }),
							jsxs("div", {
								className: "dsh-gw-inline",
								children: [
									jsx(primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: busy || (status.staticKeyCount > 0 && status.authRequired),
										onClick: toggleAuth,
										children: status.authRequired ? t("authToggleOn") : t("authToggleOff"),
									}),
									jsx("span", {
										className: "dsh-gw-muted",
										children: status.staticKeyCount > 0
											? t("authFixedHint")
											: status.authRequired
												? t("authLockedHint")
												: t("authOpenHint"),
									}),
								],
							}),
						],
					}),

					jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsx("div", { className: "dsh-gw-card-title", children: t("endpointTitle") }),
							jsx("div", { className: "dsh-gw-desc", children: t("endpointDesc") }),
							loopbackOnly
								? jsx("div", { className: "dsh-gw-muted", children: t("loopbackHint") })
								: jsx("div", { className: "dsh-gw-muted", children: t("lanHint") }),
							jsxs("div", {
								className: "dsh-gw-field",
								children: [
									jsx("div", { className: "dsh-gw-muted", children: t("baseUrl") }),
									jsx(primitives.CodeBlock, {
										code: `${origin}${basePath}`,
										lang: "text",
										copyLabel: t("copyLabel"),
										copiedLabel: t("copiedLabel"),
									}),
								],
							}),
							jsxs("div", {
								className: "dsh-gw-paths",
								children: [
									jsx(EndpointRow, { method: "GET", url: `${origin}${status.modelsPath}`, copyLabel: t("copyLabel"), copiedLabel: t("copiedLabel"), t }),
									jsx(EndpointRow, { method: "POST", url: `${origin}${status.completionsPath}`, copyLabel: t("copyLabel"), copiedLabel: t("copiedLabel"), t }),
								],
							}),
							jsxs("div", {
								className: "dsh-gw-field",
								children: [
									jsx("div", { className: "dsh-gw-muted", children: t("usageHint") }),
									jsx(primitives.CodeBlock, {
										code: exampleSnippet(origin, basePath),
										lang: "python",
										copyLabel: t("copyLabel"),
										copiedLabel: t("copiedLabel"),
									}),
								],
							}),
						],
					}),

					status.lan === null || status.lan === undefined
						? null
						: jsxs("div", {
							className: "dsh-gw-card",
							children: [
								jsx("div", { className: "dsh-gw-card-title", children: t("lanTitle") }),
								jsx("div", { className: "dsh-gw-desc", children: t("lanDesc") }),
								status.lan.addresses.length > 0
									? jsx("div", {
										className: "dsh-gw-paths",
										children: status.lan.addresses.map((entry) => jsxs("div", {
											className: "dsh-gw-path",
											children: [
												jsx("span", { className: "dsh-gw-method", children: "LAN" }),
												jsx("div", {
													style: { flex: 1, minWidth: 0 },
													children: jsx(primitives.CodeBlock, {
														code: `http://${entry.address}:${status.lan.port}${basePath}`,
														lang: "text",
														copyLabel: t("copyLabel"),
														copiedLabel: t("copiedLabel"),
													}),
												}),
											],
										}, entry.address)),
									})
									: jsx("div", { className: "dsh-gw-empty", children: t("lanNoAddress") }),
								// Say how many addresses were filtered out, so a machine whose
								// only reachable address is on a bridge is diagnosable rather
								// than just showing an empty list.
								status.lan.hiddenCount > 0
									? jsx("div", { className: "dsh-gw-muted", children: fill(t("lanHidden"), { n: status.lan.hiddenCount }) })
									: null,
								status.authRequired
									? jsx("div", { className: "dsh-gw-muted", children: t("lanAuthOk") })
									: jsx("div", { className: "dsh-gw-error", children: t("lanAuthWarn") }),
							],
						}),

					jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsxs("div", {
								className: "dsh-gw-card-head",
								children: [
									jsx("div", { className: "dsh-gw-card-title", children: t("keysTitle") }),
									jsx(primitives.Button, {
										variant: "primary",
										size: "sm",
										onClick: () => setCreating(true),
										children: jsxs(Fragment, {
											children: [
												jsx(primitives.IconPlusOutline16, { size: 14 }),
												t("createKey"),
											],
										}),
									}),
								],
							}),
							jsx("div", { className: "dsh-gw-desc", children: t("keysDesc") }),
							keys.length === 0
								? jsx("div", { className: "dsh-gw-empty", children: status.staticKeyCount > 0 ? fill(t("staticKeys"), { n: status.staticKeyCount }) : t("noKeys") })
								: jsx("div", {
									children: [
										...keys.map((entry) => jsxs("div", {
											className: "dsh-gw-row",
											children: [
												jsxs("div", {
													className: "dsh-gw-row-main",
													children: [
														jsxs("div", {
															className: "dsh-gw-inline",
															children: [
																jsx("span", { className: "dsh-gw-key-label", children: entry.label }),
																jsx("span", { className: "dsh-gw-mono dsh-gw-muted", children: entry.masked }),
															],
														}),
														jsx("span", {
															className: "dsh-gw-muted",
															children: `${t("createdAt")} ${formatTime(entry.createdAt)}`,
														}),
													],
												}),
												jsx(primitives.Button, {
													variant: "ghost",
													size: "sm",
													onClick: () => {
														setRevokeError(undefined);
														setRevokeTarget(entry);
													},
													children: jsxs(Fragment, {
														children: [
															jsx(primitives.IconTrashOutline16, { size: 14 }),
															t("revoke"),
														],
													}),
												}),
											],
										}, entry.id)),
										status.staticKeyCount > 0
											? jsx("div", { className: "dsh-gw-muted", children: fill(t("staticKeys"), { n: status.staticKeyCount }) })
											: null,
									],
								}),
							jsxs("div", {
								className: "dsh-gw-muted",
								children: [`${t("keysFile")}: `, jsx("span", { className: "dsh-gw-mono", children: status.keysFile })],
							}),
						],
					}),

					jsxs("div", {
						className: "dsh-gw-card",
						children: [
							jsx("div", { className: "dsh-gw-card-title", children: t("modelsTitle") }),
							jsx("div", {
								className: "dsh-gw-desc",
								children: models.length === 0
									? t("modelsEmpty")
									: fill(t("modelsDesc"), { n: models.length, p: providers.length }),
							}),
							jsx("div", {
								className: "dsh-gw-chips",
								children: models.map((model) => jsx(primitives.Pill, {
									children: `${model.id}`,
								}, `${model.provider}/${model.id}`)),
							}),
						],
					}),

					jsx(primitives.Modal, {
						open: groupDialog !== undefined,
						onClose: closeGroupDialog,
						title: groupDialog?.mode === "edit" ? t("editGroupTitle") : t("createGroupTitle"),
						description: t("groupDialogDesc"),
						closeLabel: t("cancel"),
						footer: jsxs(Fragment, {
							children: [
								jsx(primitives.Button, { variant: "outline", onClick: closeGroupDialog, disabled: groupBusy, children: t("cancel") }),
								jsx(primitives.Button, { variant: "primary", onClick: submitGroup, disabled: groupBusy, children: t("confirm") }),
							],
						}),
						children: jsxs("div", {
							className: "dsh-gw-field",
							children: [
								jsx("label", { className: "dsh-gw-muted", htmlFor: "dsh-gw-group-name", children: t("groupName") }),
								jsx("input", {
									id: "dsh-gw-group-name",
									className: "dsh-gw-input",
									type: "text",
									autoComplete: "off",
									placeholder: t("groupNamePlaceholder"),
									value: groupDialog?.name ?? "",
									disabled: groupBusy,
									onChange: (event) => setGroupDialog((current) => current === undefined ? current : { ...current, name: event.target.value }),
								}),
								jsx("div", { className: "dsh-gw-muted", children: t("groupNameHint") }),
								jsx("label", { className: "dsh-gw-muted", htmlFor: "dsh-gw-group-kind", children: t("groupKind") }),
								jsx("select", {
									id: "dsh-gw-group-kind",
									className: "dsh-gw-input",
									// Locked once the group exists: the store does not accept a
									// kind on update, so offering the control would be a lie.
									disabled: groupBusy || groupDialog?.mode === "edit",
									value: groupDialog?.kind ?? "model",
									onChange: (event) => setGroupDialog((current) => current === undefined
										? current
										// Switching the kind invalidates the member list: a
										// composite's members are group references and a model
										// group's are concrete models, so carrying them across
										// would produce a list the save is guaranteed to refuse.
										: { ...current, kind: event.target.value, models: [] }),
									children: [
										jsx("option", { value: "model", children: t("kindModel") }, "model"),
										jsx("option", { value: "composite", children: t("kindComposite") }, "composite"),
									],
								}),
								jsx("div", {
									className: "dsh-gw-muted",
									children: (groupDialog?.kind ?? "model") === "composite" ? t("kindCompositeHint") : t("kindModelHint"),
								}),
								jsx("label", { className: "dsh-gw-muted", children: t("groupModels") }),
								jsx("div", {
									className: "dsh-gw-chips",
									children: (groupDialog?.models ?? []).map((model, index) => jsxs("span", {
										className: "dsh-gw-inline",
										children: [
											jsx(primitives.Pill, { children: model }),
											index === 0
												? null
												: jsx(primitives.Button, {
													variant: "ghost",
													size: "sm",
													onClick: () => moveGroupModel(index, -1),
													children: "↑",
												}),
											index === (groupDialog?.models.length ?? 0) - 1
												? null
												: jsx(primitives.Button, {
													variant: "ghost",
													size: "sm",
													onClick: () => moveGroupModel(index, 1),
													children: "↓",
												}),
											jsx(primitives.Button, {
												variant: "ghost",
												size: "sm",
												onClick: () => removeGroupModel(index),
												children: "×",
											}),
										],
									}, `${model}-${index}`)),
								}),
								jsx("select", {
									className: "dsh-gw-input",
									value: "",
									disabled: groupBusy,
									onChange: (event) => addGroupModel(event.target.value),
									children: [
										jsx("option", { value: "", children: t("groupAddModel") }),
										...groupModels
											// A model group may only hold concrete models; a composite
											// may only hold prefixed group references. Filtering by
											// what the entry is selectable FOR means the picker cannot
											// offer a member the save would refuse — in particular it
											// never offers a bare group name, which would flatten.
											.filter((model) => (groupDialog?.kind ?? "model") === "composite"
												? model.selectable === "composite-member"
												: model.selectable === "model")
											.filter((model) => !(groupDialog?.models ?? []).includes(model.id))
											.map((model) => jsx("option", { value: model.id, children: model.id }, model.id)),
									],
								}),
								jsx("label", { className: "dsh-gw-muted", htmlFor: "dsh-gw-group-preset", children: t("groupScheduling") }),
								jsx("select", {
									id: "dsh-gw-group-preset",
									className: "dsh-gw-input",
									value: groupDialog?.preset ?? "sequential",
									disabled: groupBusy,
									onChange: (event) => setGroupDialog((current) => current === undefined
										? current
										: { ...current, preset: event.target.value }),
									children: PRESETS.map((preset) => jsx("option", {
										value: preset.id,
										children: t(preset.label),
									}, preset.id)),
								}),
								jsx("div", {
									className: "dsh-gw-muted",
									children: t(PRESETS.find((entry) => entry.id === (groupDialog?.preset ?? "sequential"))?.desc ?? "presetSequentialDesc"),
								}),
								// The retry count only means anything for the preset that
								// retries, so it is asked for only then.
								(groupDialog?.preset ?? "") !== "retry"
									? null
									: jsxs(Fragment, {
										children: [
											jsx("label", { className: "dsh-gw-muted", htmlFor: "dsh-gw-group-retry", children: t("retryTimes") }),
											jsx("input", {
												id: "dsh-gw-group-retry",
												className: "dsh-gw-input",
												type: "number",
												min: 1,
												max: 3,
												step: 1,
												value: groupDialog?.retry429 ?? 1,
												disabled: groupBusy,
												onChange: (event) => setGroupDialog((current) => current === undefined
													? current
													: { ...current, retry429: event.target.value }),
											}),
											jsx("div", { className: "dsh-gw-muted", children: t("retryHint") }),
										],
									}),
								groupError === undefined ? null : jsx("div", { className: "dsh-gw-error", children: groupError }),
							],
						}),
					}),

					jsx(primitives.Modal, {
						open: groupDeleteTarget !== undefined,
						onClose: () => setGroupDeleteTarget(undefined),
						title: t("deleteGroupTitle"),
						closeLabel: t("cancel"),
						footer: jsxs(Fragment, {
							children: [
								jsx(primitives.Button, { variant: "outline", onClick: () => setGroupDeleteTarget(undefined), disabled: groupBusy, children: t("cancel") }),
								jsx(primitives.Button, {
									variant: "primary",
									onClick: async () => {
										setGroupBusy(true);
										setGroupError(undefined);
										const result = await callSettings("removeGroup", { id: groupDeleteTarget.name });
										setGroupBusy(false);
										if (!result.ok) {
											setGroupError(result.error?.message ?? t("failed"));
											return;
										}
										setGroupDeleteTarget(undefined);
										await refreshGroups();
									},
									disabled: groupBusy,
									children: t("confirm"),
								}),
							],
						}),
						children: jsxs("div", {
							className: "dsh-gw-field",
							children: [
								jsx("div", { className: "dsh-gw-desc", children: groupDeleteTarget?.name }),
								groupError === undefined ? null : jsx("div", { className: "dsh-gw-error", children: groupError }),
							],
						}),
					}),

					jsx(primitives.Modal, {
						open: creating,
						onClose: closeCreate,
						title: created === undefined ? t("createTitle") : t("createdTitle"),
						description: created === undefined ? t("createDesc") : undefined,
						closeLabel: t("cancel"),
						footer: created === undefined
							? jsxs(Fragment, {
								children: [
									jsx(primitives.Button, { variant: "outline", onClick: closeCreate, disabled: busy, children: t("cancel") }),
									jsx(primitives.Button, { variant: "primary", onClick: submitCreate, disabled: busy, children: t("confirm") }),
								],
							})
							: jsx(primitives.Button, { variant: "primary", onClick: closeCreate, children: t("done") }),
						children: created === undefined
							? jsxs("div", {
								className: "dsh-gw-field",
								children: [
									jsx("label", { className: "dsh-gw-muted", htmlFor: "dsh-gw-key-label", children: t("keyLabel") }),
									jsx("input", {
										id: "dsh-gw-key-label",
										className: "dsh-gw-input",
										type: "text",
										autoComplete: "off",
										placeholder: t("keyLabelPlaceholder"),
										value: label,
										disabled: busy,
										onChange: (event) => setLabel(event.target.value),
										onKeyDown: (event) => {
											if (event.key === "Enter" && !busy) submitCreate();
										},
									}),
									createError === undefined ? null : jsx("div", { className: "dsh-gw-error", children: createError }),
								],
							})
							: jsxs("div", {
								className: "dsh-gw-reveal",
								children: [
									jsxs("div", {
										className: "dsh-gw-reveal-head",
										children: [
											jsx(primitives.IconWarningOutline16, { size: 14 }),
											t("createdTitle"),
										],
									}),
									jsx("div", { className: "dsh-gw-desc", children: t("createdWarn") }),
									jsx(primitives.CodeBlock, {
										code: created.key,
										lang: "text",
										copyLabel: t("copyLabel"),
										copiedLabel: t("copiedLabel"),
									}),
								],
							}),
					}),

					jsx(primitives.Modal, {
						open: revokeTarget !== undefined,
						onClose: () => {
							if (busy) return;
							setRevokeTarget(undefined);
							setRevokeError(undefined);
						},
						title: t("revokeTitle"),
						description: t("revokeDesc"),
						closeLabel: t("cancel"),
						footer: jsxs(Fragment, {
							children: [
								jsx(primitives.Button, {
									variant: "outline",
									disabled: busy,
									onClick: () => {
										setRevokeTarget(undefined);
										setRevokeError(undefined);
									},
									children: t("cancel"),
								}),
								jsx(primitives.Button, { variant: "primary", disabled: busy, onClick: confirmRevoke, children: t("revokeConfirm") }),
							],
						}),
						children: jsxs("div", {
							children: [
								jsx("div", { className: "dsh-gw-key-label", children: revokeTarget?.label }),
								jsx("div", { className: "dsh-gw-mono dsh-gw-muted", children: revokeTarget?.masked }),
								revokeError === undefined ? null : jsx("div", { className: "dsh-gw-error", children: revokeError }),
							],
						}),
					}),
				],
			});
		}

		/**
		 * Required client services.
		 *
		 * `connection` is kept deliberately even though this page reaches its
		 * settings endpoint with plain `fetch`: waiting on it guarantees the
		 * client transport (and therefore the `/api` carrier) is initialized
		 * before the page can call that endpoint.
		 */
		const inject = ["slots", "locale", "connection"];

		/**
		 * Register the model-relay settings page and its dictionaries.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-model-gateway: copy dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "model-relay",
				order: 30,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t }),
			}, GatewaySection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
