/**
 * dsh-model-relay — browser half.
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
 * @module dsh-model-relay/client
 */
window.__ModuleLoader__.load({
	id: "dsh-model-relay",
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
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-model-relay: copy dictionaries");
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
