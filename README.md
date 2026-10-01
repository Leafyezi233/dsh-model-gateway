# 模型中转站 (@leaf233/dsh-model-gateway)

> 本仓库是 [qilin-zhu/dsh-model-gateway](https://github.com/qilin-zhu/dsh-model-gateway) 的 fork，包名 `@leaf233/dsh-model-gateway`。上游 npm 包 `dsh-model-gateway`（0.1.1）与本 fork 无关、也不兼容 `0.1.2-rc.1`，见下文「安装」。

给 DeepSeek Harness 挂一个 OpenAI 兼容的 `/v1` 接口，把 harness 里已注册的大模型（比如 `@tnnevol/dsh-codebuddy` 里的 CodeBuddy 模型）反代出去，其他项目用标准 OpenAI 客户端就能调用。

在 **设置 → 模型中转站** 里可以看到所有接口地址、分组、创建和管理 API 密钥、开关鉴权、查看可用模型。

## 为什么不是"再登一次"

这个插件**不碰任何凭据**。它自己不会读写token等，而是把请求交给 DSH 的 `llm` 服务转发——也就是直接复用已注册的 provider 适配器。

这是因为一些事实性存在的问题：CodeBuddy 的 refresh token 会轮换，而且 `@tnnevol/dsh-codebuddy` 内部用**单飞（single-flight）** 保证并发刷新只发生一次。如果本插件自己再建一个 session，两次刷新会互相作废，结果是 Web 界面里的登录被踢掉。走 `ctx.llm` 就不可能出现这种情况。

由此还顺带复用了上游插件的账号故障转移、额度感知、图片序列化和模型目录。

## DSH 版本支持

![DSH 0.1.2-rc.1](https://img.shields.io/badge/DSH-0.1.2--rc.1-brightgreen.svg)
![DSH 0.1.5-rc.2+](https://img.shields.io/badge/DSH-0.1.5--rc.2%2B-brightgreen.svg)
![DSH 0.1.6-alpha.1+](https://img.shields.io/badge/DSH-0.1.6--alpha.1%2B-brightgreen.svg)
![DSH 0.1.7-alpha.1+](https://img.shields.io/badge/DSH-0.1.7--alpha.1%2B-brightgreen.svg)

> `0.1.2-rc.1` 与 `0.1.7-alpha.1+` 为本 fork 新增的支持范围，`0.1.2-rc.1` 需要下面三处修复；`0.1.1` 及更早不在声明范围内

本仓库的 `package.json` 声明：

```json
"engines": { "dsh": "0.1.2-rc.1 || ^0.1.5-rc.2 || ^0.1.6-alpha.1" }
```

六个 `@deepseek-ai/*` peer 依赖同样带上 `0.1.2-rc.1 ||` 分支。

三种写法的实际匹配结果：

### 0.1.2-rc.1 上必须的三处修复

上游 0.1.1 的代码在 `0.1.2-rc.1` 上**装得上但跑不起来**，本 fork 修的正是这三处：

1. **系统提示词**：`0.1.2-rc.1` 的 `@deepseek-ai/dsh-llm` 不再导出 `createSystemMessage`，`MessageSourceMap` 里也没有 `system`。原代码的顶层命名导入会直接抛 `SyntaxError`，插件**完全加载不了**。正确形状是请求级的 `options.system`（`GenerateOptions.system`），适配器会把它映射到 provider 自己的 system slot。
2. **`Tag` 组件**：`dsh-client-ui-primitives` 在 `0.1.2-rc.1` 里不导出 `Tag`，`primitives.Tag` 是 `undefined`，渲染设置页时抛错、整个区块挂不上。改用实际存在的 `Pill`（注意它接的是 `active`，不是 `tone`）。
3. **`connection` patch**：见上文「配置」里的说明，已删除。

`compatibility.json` 里的 `dshPluginApi.version` 也改了，但那是**惰性元数据**——DSH 运行时不读这个字段，真正起作用的是 `package.json` 的 `engines.dsh` 和 peer 范围。

## 安装

命令行安装：

```sh
# 从 npm 安装
dsh plugin --profile web add @leaf233/dsh-model-gateway

# 本地开发（file: 链接）
dsh plugin --profile web add /绝对路径/relay-upstream
```

装完重启 Web profile，服务地址是：

```
http://127.0.0.1:3080/v1
```

> **这个 fork 用 `@leaf233` 作用域名，不是上游的 `dsh-model-gateway`。**
>
> npm 上那个**不带 scope 的 `dsh-model-gateway` 属于上游作者**（maintainer `jarvistop`，仓库 `qilin-zhu/dsh-model-gateway`），本 fork 无权发布它，而且它在 `0.1.2-rc.1` 上会直接崩（详见下文「DSH 版本支持」）。
>
> 所以如果需要版本支持或上游不一样的功能，需要使用 **`@leaf233/dsh-model-gateway`**（本 fork）。
>
> **注意区分三个名字**
>
> | 名字 | 值 | 用途 |
> |---|---|---|
> | 包名 | `@leaf233/dsh-model-gateway` | npm 安装、`bundles` 列表 |
> | patch 行的 `id` | `dsh-model-gateway` | 你在自己 profile 里覆盖配置时的锚点 |
> | provider id | `dsh-model-gateway` | DSH 模型选择器里的分组命名空间（`<provider>_<模型>`） |
>
> 只有**包名**带 scope。`id` 和 provider id 保持不带 scope，所以已有的配置覆盖和分组名不受影响。

## 用法

任意 OpenAI 客户端都可以，`base_url` 指向上面的地址。

**鉴权是可选的**：还没创建密钥、也没在配置里写固定密钥时，接口对所有人开放（随便填一个 `sk-xxx` 或留空都行）。创建第一个密钥后自动开始校验。

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3080/v1", api_key="sk-dshgw-...")

resp = client.chat.completions.create(
    model="codebuddy_deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

```sh
curl http://127.0.0.1:3080/v1/models

curl http://127.0.0.1:3080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"codebuddy_deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}]}'
```

支持的接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/models` | 列出所有已注册 provider 的模型，以及你的模型分组 |
| `POST` | `/v1/chat/completions` | 对话，支持 `stream: true` |

请求体与 OpenAI Chat Completions 一致：`model`、`messages`、`stream`、`tools`、`tool_choice`、`temperature`、`max_tokens`、`stop`、`reasoning_effort`。支持 `role: "tool"` 的工具结果回传、assistant 的 `tool_calls` 回放、以及 `image_url` 图片输入（data URL 或远程 URL）。

流式响应是标准 SSE，以 `data: [DONE]` 结束。

## 模型分组

**分组 = 一组模型的候选列表 + 一套调度方式。** 给这组模型起个名字，之后用这个名字调用，网关按调度方式决定先试谁，**第一个能应答的就被采用**。

默认就是"按顺序逐个尝试"，也就是"额度轮换"最直接的用法：把同一个模型在不同供应商上的实例排成一组，一个用不了了自动落到下一个。

```python
# 直接调用分组名
resp = client.chat.completions.create(
    model="fast-chat",
    messages=[{"role": "user", "content": "你好"}],
)
```

在 **设置 → 模型中转站 → 模型分组** 里创建和管理，用 ↑ ↓ 调候选顺序。

### 调度方式

设置页提供四个预设：

| 预设 | 行为 |
| --- | --- |
| **顺序**（默认） | 按候选列表从上到下依次尝试，遇到不可用就顺延。 |
| **均衡** | 每次请求轮换起点，把负载摊到所有候选上。 |
| **随机** | 每次请求打乱顺序。 |
| **顺序 + 限流重试** | 按顺序尝试；某条腿遇到限流（429）时**在同一条腿上重试若干次**，再顺延到下一个。 |

**存储上其实是两个正交的字段**：`strategy`（`sequential` / `round-robin` / `random`）决定顺序，`retry429`（0–3）决定同一条腿重试几次。上面四个预设是这两者里**最常用的四个组合**，不是全部——存储本身能表达 12 种，比如"均衡 + 重试"（`round-robin` + `retry429: 1`）可以直接写进 `model-relay-groups.json`，只是设置页暂时没有对应的按钮。分成两个字段而不是一个枚举，就是为了让这些组合不必为每种顺序各复制一份重试逻辑。

**均衡和随机都是完整排列，不是子集。** 被排到后面的候选仍然是回退链的一部分，所以任何调度方式都不会缩短分组的兜底能力。

> ⚠️ **均衡和随机会牺牲会话粘性。** 顺序模式下同一个会话始终落在同一条腿上，上游的 prompt cache 因此命中；换成均衡或随机后，多轮对话会在供应商之间跳，**prompt cache 基本失效**，成本和首字延迟都会上升。另外不同供应商的 tokenizer 不同，同一段文本的 token 计数会漂移，`usage` 对账会对不上。并非bug。

### 在 DSH 本体里也能用

本插件会**把自己注册成一个名为 `dsh-model-gateway` 的 DSH provider**，它的"模型目录"就是你的分组列表。打开 **设置 → 模型**，在 `dsh-model-gateway` 下面就能像选普通模型一样选到分组名。

分组名同样出现在 `/v1/models` 里，所以外部客户端和 DSH 两边都能用。

> DSH 的模型选择器是全局的——注册之后，**所有**会话都能选到这些分组。
>
> 底层模型仍然可以直接调用（`codebuddy_deepseek-v4-flash` 这种全名照常可用）。想让外部**只**看到分组，把 `providers` 配成 `[dsh-model-gateway]` 即可——但那是**对外**的过滤，不影响 DSH 界面里能看到什么。

### 回退只在"还没有任何输出"之前发生

唯一需要理解的行为约束：

- 上游**还没吐出任何内容**就失败（连不上、凭证失效、上游报错）→ **自动换下一个候选**，客户端完全察觉不到。
- 上游**已经吐出内容**之后再断 → **不换**，流被截断。

第二条不是bug：已经吐出去的内容客户端已经收到了，此时换腿会造成重复输出。所以分组能兜住"这个供应商现在用不了"，但兜不住"响应写到一半断了"。

"吐出内容"的判定见上面的排查小节——只有 `usage` 分片不算。

### 限流重试（`retry429`）

开启后，某条腿遇到限流会在**同一条腿上**重试，而不是立刻换下一条腿。三条约束：

- **只重试限流。** 判据是失败码 `RATE_LIMIT`，**不是** HTTP 状态。因为 `statusForCode` 把 `RATE_LIMIT`、`QUOTA`、`QUOTA_EXCEEDED` 全都映射成 429，但**额度用尽重试也没用**——再问一次还是同一个答案，只是白花调用方的时间。
- **已经吐出内容就不再重试。** 和换腿是同一条规矩：重放调用方已经收到过的内容会造成重复输出。
- **每条腿有等待预算（2 秒）。** 上游给的 `Retry-After` 优先于本地退避（本地是 250ms 起、翻倍、封顶 1 秒），但如果那个提示超过预算，就**直接换下一条腿**而不是干等——否则一条死腿会让本来能立刻应答的下一条腿陪着一起等。

> ⚠️ **两条路径的重试会相乘。** `/v1` 绕过了代理循环，**没有**外层重试；而 DSH 本体调用还有 `dsh-llm-retry`（对 `RATE_LIMIT` 最多重试 5 次）。所以在 DSH 本体路径上，`retry429 = 2` 的最坏情况是 3 × 6 = 18 次上游调用。建议本体路径上把 `retry429` 控制在 1。

### 分组内每条腿的成功率

设置页的**模型分组**卡片里，每个候选后面会跟一个百分比，说明**这条腿最近答上来的比例**。

```
hinds                                    [均衡]        [刷新统计] [新建分组]
  [codebuddy_gpt-5  98%]  [codebuddy_claude 41%]  [xxx_gemini  0%]
```

颜色分三档：**≥90% 绿**、**50–89% 黄**、**<50% 红**；从没被调用过的显示灰色、**不带百分比**。
鼠标悬停能看到完整数字：尝试次数、已应答 / 未应答、限流重试次数、累计应答率、最近一次失败的失败码和时间。

#### 两个刻意的口径，值得先知道

**一、统计的是「有没有应答」，不是「有没有成功」。**

上游**已经吐出内容之后**才断掉的调用，会被算进「已应答」。这不是漏了，而是两条调用路径的可观测性本来就不同：

| 路径 | 能否看见「应答后中途死」 |
| --- | --- |
| DSH 本体（`streamGroup`） | 能 |
| `/v1`（`openStream`） | **不能**——提交后的那次尝试已经交给 `resume(...)`，失败发生在里面 |

要让两条路径口径一致、又不去包装流式热路径，就只能统一问「答没答上来」。所以计数器叫 `answered` / `refused`，不叫「成功 / 失败」。

**二、不是这条腿的错的失败，不算它的。**

下面这些失败换任何一条腿都是同样的结果，记到当时排在第一位的那条腿上只会冤枉一个健康的模型：

| 失败码 | 为什么不记 |
| --- | --- |
| `CONTEXT_WINDOW_EXCEEDED` | 请求本身太大 |
| `INVALID_REQUEST` / `INVALID_PREPARED_CALL` | 请求本身有问题 |
| `UNSUPPORTED_CONTENT` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_REASONING_EFFORT` | 请求不被支持 |
| `ABORTED` | 调用方自己取消的 |

这些计入 `ignored`，**不进分母**，所以不会拉低成功率。悬停提示里会单独列出它们。

#### 其他要知道的

- **只统计分组。** 直接调用某个底层模型（不走分组）不产生任何统计。
- **按「最近 20 次」算，不是按历史累计。** 悬停里的「累计应答率」才是历史值。这是有意的：一条腿早上坏了、现在好了，累计比率永远追不回来，而近期比率能立刻反映恢复。
- **两条线：实时徽章在内存，历史图表落盘。** 徽章/悬停的计分板仍是纯内存（同一条纪律：统计不能影响路由）；从 0.5.0 起，**按天聚合的历史**会异步落盘到 `~/.dsh/model-relay-stats.json`（可用 `statsPersist: false` 关掉），重启后图表不清零。明细请求列表**不落盘**——落盘的只有聚合计数。
- **不会自动刷新。** 点**刷新统计**按钮才更新；这个页面没有后台轮询。
- **徽章带样本量。** 百分比旁边就是尝试次数（如 `98% · 124`）；样本不足 20 次时悬停会明确提示。近期比率远好于累计比率时，徽章转为「恢复中」琥珀色，累计值在悬停里。
- **组合分组的成员可以点开。** 点成员徽章展开内层分组自己的计分板——组合分组自身的数字对同一次调用在两层各计一次，展开后看到的是内层的独立口径。

---

### 候选全挂了之后：失败码必须活着走出边界

所有候选都失败时，网关抛出一个 `GatewayError`。这个异常要穿过 `dsh-llm` 的适配器边界，而边界上的 `normalizeLlmFailure` **只认 `HarnessError` 的 `code`**；其它 Error 一律被压成 `UNKNOWN`。

这件事要命的地方在于：`dsh-base` 里挂着 `dsh-llm-retry`，它的重试判据是

```js
policy.retryableCodes.includes(failure.code)
```

默认集合是 `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`。所以一个 `code` 被压成 `UNKNOWN` 的失败**不会被重试**——整个分组会把一次瞬时 429 变成一次死掉的回合，而且不报错，只是"没反应"。

修法是给异常挂一个自己的 `failure` 数据属性（`{message, code, status}`）。这是**外部适配器**跨越该边界的正规做法，也是 `LlmError` 内部做的事；快照里的 `code` 必须和异常自身的 `code` 一致，否则边界会丢弃它。

`test/failure-code.test.mjs` 钉住这条：它把真插件挂到真 `LlmService` 上，读**代理循环真正会看到的那个终止分片**。用 mock 的 `llm` 永远看不见这个 bug——假的 `llm` 不跑真边界。

### 各种失败分别会怎样

下表的 `/v1` 列是实测值（真插件挂真 `LlmService`，`hinds` 只有一个成员且它失败）：

| 上游失败码 | `/v1` 状态 | `Retry-After` | DSH 会重试吗 |
|---|---|---|---|
| `RATE_LIMIT` | 429 | 有则输出 | **会** |
| `SERVER` | 502 | 有则输出 | **会** |
| `TIMEOUT` | 502 | — | **会** |
| `TRANSPORT` | 502 | — | **会** |
| `EMPTY_RESPONSE` | 502 | — | **会** |
| `QUOTA` | 429 | 有则输出 | 不会 |
| `AUTH` | 401 | — | 不会 |
| `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | 401 | — | 不会 |
| `UNSUPPORTED_REASONING_EFFORT` | 400 | — | 不会 |
| `CONTEXT_WINDOW_EXCEEDED` | 400 | — | 不会 |
| `INVALID_REQUEST` | 400 | — | 不会 |
| `ABORTED` | 499 | — | 不会 |
| 其它 / 未知 | 502 | — | 不会 |

三列读法：

- **`/v1` 状态**：走 `statusForFailure`——**优先用上游自己报的 HTTP 状态**（`dsh-llm-deepseek` 会带上 `status: response.status`），没有才回退到按码分类。因为码比状态粗：`AUTH` 同时覆盖 401 和 403，而像 402 这种状态根本没有对应码。回退分类见 `statusForCode`。
- **`Retry-After`**：只在**响应头还没发出去**时能给（非流式、或流式但第一个分片之前就失败）。SSE 一旦写出第一个分片就已经是 200 了，`Retry-After` 在协议上不可能再加；而且客户端已经收到半个流，重试这个响应也没意义。毫秒**向上取整**到秒，最小 1 秒——向下取整会变成"立刻重试"，正好是这个头要防的事。
- **DSH 会重试吗**：判据是 `dsh-llm-retry` 的 `retryableCodes` 默认集合（`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）。**`QUOTA` 不在里面**：额度用尽重试也没用，直接报错更快。注意 `/v1` 路径**没有外层重试**——它绕过了代理循环，`dsh-llm-retry` 只作用于 DSH 本体调用。分组自己的 `retry429` 是另一回事，那条在两条路径上都生效（见上文"限流重试"）。

`ABORTED` 是特例：它被报成 `kind: 'aborted'` 而不是 `error`，所以网关**不会换腿**，`dsh-llm-retry` 也不会重试。这是对的——取消是调用方放弃，不是供应商失败，换腿等于复活一个刚被取消的请求。

### 长会话自动压缩

分组对外声明的上下文窗口是**所有候选里最小的那个**。DSH 的自动压缩按这个数算阈值，取最小值才能保证"快满了"在**任何**一条腿上都成立；取大的话，会话可能撑爆实际应答的那条腿。

任何一条候选的窗口读不出来 → 整个窗口字段不输出。这不是保守：DSH 读不到窗口时只是警告一次然后继续跑（长会话最终可能撞上 `CONTEXT_WINDOW_EXCEEDED`），而**报一个错的数**会让每次压缩都算错，静默得多。

**组合分组的窗口几乎必然是空的。** 因为"任一成员读不出来就整个不输出"这条规则会**逐层累加**：组合分组要问内层，内层要问它自己的每个成员，两层里只要有一个未知，最外层就是 `undefined`。这是诚实的结果（分组确实无法承诺一个确定的容量），代价是 **DSH 对组合分组的自动压缩会静默关闭**。推理档位同理：交集会因为同样原因退化成空，档位选择器不出现。

两个事实（窗口、档位交集）在**同一次成员遍历**里取到，结果按分组缓存 30 秒；分组在设置页被增删改时缓存立即清空。

### 分组名不能用下划线

只能用字母、数字、`-` 和 `.`，且首字符必须是字母或数字。

因为每个模型的对外名都是 `<供应商>_<模型>`，**下划线就是那个分隔符**。禁止分组名使用下划线，两个命名空间就天然不冲突，不需要任何优先级规则。

分组名优先于模型名解析——但你不用记这条，符合规则的命名本来就撞不上。

### 两种分组：普通分组与组合分组

每个分组有一个**类型**（`kind`），类型决定它的成员能放什么。

| 类型 | 成员 | 说明 |
| --- | --- | --- |
| **普通分组**（默认） | 只能是具体模型 | 现有分组全都是这一种，行为一字未变 |
| **组合分组** | 只能是一个**已存在的普通分组**，写成 `dsh-model-gateway_<分组名>` | 用来复用别的分组 |

**组合分组不能包含组合分组。** 这不是一条单独的限制，而是类型规则的推论：组合分组的成员类型是"普通分组"，而组合分组自己不是普通分组。所以"深度最多一层"是自动成立的，不需要额外记。

**成员必须写成 `dsh-model-gateway_<分组名>`，不能写裸名。** 这不是美观问题：裸名会被解析成"那个分组的**第一条腿**"，内层剩下的候选和内层的调度方式会**全部丢掉**。带前缀的写法才会把内层当成一个整体交给 DSH 派发，从而让内层按**它自己的**顺序/轮询/重试设置运行。设置页的候选下拉框只会给出正确的那种写法。

**类型创建后不可改。** 想把一个普通分组变成组合分组，请新建一个。

#### 三种递归路径都有守卫

分组图可以递归，而且有**三条互不相干**的路径，各自有自己的深度上限和错误码：

| 路径 | 什么时候走 | 错误码 |
| --- | --- | --- |
| **解析期** | 分组成员指向分组时，在派发之前 | `group_cycle` |
| **派发期** | 组合分组的成员真正被交给 DSH 之后 | `group_cycle` |
| **能力期** | **构建模型目录时**（打开"模型"设置页就会走） | `group_capability_cycle` |

能力期那条尤其要注意：它**不需要任何人调用这个分组**，光是打开设置页就会触发。

**正常情况下你碰不到这些错误码**，因为设置页在保存时就会拒绝会形成环的成员。它们挡的是**手改 `model-relay-groups.json`** 的情况。

#### 被引用的分组被删/改名之后

**允许**删除或改名一个被组合分组引用的普通分组（否则内层分组就变成不可删了）。这时引用它的组合分组会**失效**：

- 设置页会在那个分组上显示"有 N 个成员已失效"。
- 运行时会跳过这些成员（和"这条腿解析不了"一样处理），并在日志里写出是哪几个组合分组受了影响。

修正方式是编辑那个组合分组，把失效的成员删掉或换成有效的。

### 推理强度（reasoning effort）

分组对外声明的档位是**所有候选的交集**，并且**不设默认档**。

交集，不是并集。并集会带来一个很隐蔽的故障：某一档只有部分候选支持，DSH 校验通过、放行，然后请求被转发给**不支持它的那条腿**，在请求中途以 `UNSUPPORTED_REASONING_EFFORT` 失败。改成交集后，DSH 自己就挡住了——调用方根本选不出没有任何一条腿能兑现的档位。

**不设默认档**是必须的，不是保守。DSH 里的 `defaultEffort` 不是"提示"，而是**物化**：只要声明了它，每一个没有指定档位的请求都会被补上这个值（`dsh-llm` 的 `resolveCallWithInfo`）。这个值随后被原样转发给最终应答的那条腿——于是**调用方什么都没选，却收到了"不支持该档位"的报错**。分组横跨多个供应商，没有哪一档能代表所有成员，所以正确的做法是不替调用方做决定，让每条腿用它自己的默认值。

具体表现：

- 所有候选都声明了推理档位 → 取交集，聊天里出现档位选择器。
- **任一候选没有声明推理档位**（该模型根本不接受这个参数）、或能力读不出来 → 交集为空 → **整个 `reasoning` 字段不输出**，选择器不出现。这是诚实的答案：分组无法承诺任何选择，就不该假装能。

空交集时不能输出空的 `efforts` 数组——DSH 会以 `INVALID_MODEL_REASONING` 拒绝，而 `buildModelCatalog` 把"某个模型抛错"当成"整个 provider 失败"，结果是**整个 `dsh-model-gateway` 从聊天选择器里消失**。

`/v1` 那条路径是另一回事：**调用分组**时，显式传的 `reasoning_effort` 如果目标腿不支持，会被**丢弃并写警告**，而不是报 400。调用方指定的是分组，具体哪条腿应答由路由器决定，调用方无从校验，所以不该让它因此失败；档位是偏好，让上游用它自己的默认值继续跑，比整条请求失败要好，警告保证这件事不会被悄悄咽掉。

**直接指定具体模型时不做这个处理**——模型和档位都是调用方自己选的，这时明确报错比悄悄丢掉它的指令更诚实。

### 排查

- 响应头 `x-relay-group`（分组名）和 `x-relay-model`（实际命中的那一条腿）直接告诉你走了谁。
- 每次分组回退都会写日志，包括"换了下一个"和"这条腿解析不了"。
- 所有候选都失败时，返回的是**最后一次失败的原始错误**，不是笼统的 503——这样上游的真实原因不会丢。
- 如果某条腿不支持调用方指定的 `reasoning_effort`，日志里会有 `does not accept reasoning effort ...; dropping it`，请求本身继续。

**什么算"可以换下一条腿"**：只有当这条腿**还没有吐出任何内容**时才算失败。一旦已经转发过 `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`，响应就已经提交，再换腿会把调用方已经看到的内容重放一遍，所以此时失败就是最终结果。只有 `usage` 分片不算提交——它不携带任何模型输出。`aborted`（调用方自己取消）永远不触发换腿，否则会把刚被取消的工作重新拉起来。

### 一个排查提示：设置页看得到，聊天里选不到

这两处是**两条不同的路径**：

| 位置 | 数据来源 |
| --- | --- |
| **设置 → 模型** | `llm.listProviders()` × `llm.listConfigurableProviders()`，按 settingsNs 拼装。**不碰适配器。** |
| **聊天模型选择器** | `session.modelCatalog()` → `llm.listModels()` + `llm.resolveModelInfo()`。**会调适配器。** |

所以如果**卡片在、但聊天里选不到**，几乎可以断定是**适配器抛错了**（返回给 DSH 的结构不合法）。这时去看 DSH 启动日志里 `dsh-model-gateway 加载失败：...` 那条，它会直接给出原因。

## 模型名怎么写

**推荐用 `供应商_模型`，例如 `codebuddy_deepseek-v4-flash`。**

不同供应商的模型 id 会重名。实测这套组合里 `deepseek-v4-flash` 和 `deepseek-v4-pro` **同时**存在于 `deepseek-official` 和 `codebuddy`。所以每个模型都按 `<供应商>_<模型id>` 命名，`/v1/models` 返回的 `id` 就是这个形式。

用下划线而不是斜杠，是为了让模型名对客户端保持**单个不透明 token**：有些 OpenAI 兼容工具会把 `/` 当作路径分隔符，而且斜杠会和下面这种旧写法混淆。

三种写法都接受，优先级从高到低：

| 写法 | 例子 | 说明 |
| --- | --- | --- |
| `供应商_模型` | `codebuddy_deepseek-v4-flash` | 推荐，唯一无歧义 |
| `供应商/模型` | `codebuddy/deepseek-v4-flash` | 旧写法，仍兼容 |
| 裸模型名 | `glm-5.2` | 先查 `defaultProvider`，再找目录里的唯一匹配，都没有时若只注册了一个供应商就用它 |

裸名在多个供应商上都存在时返回 400，并在错误信息里给出全部可选的全名，例如：

```
model "deepseek-v4-flash" is served by several providers;
use a namespaced id such as codebuddy_deepseek-v4-flash, deepseek-official_deepseek-v4-flash
```

响应里的 `model` 字段回显你请求时用的全名，方便对照日志。

模型目录是**建议性**的：适配器接受未列出的 id。目录会缓存 30 秒。

## 设置页

装好后打开 **设置 → 模型中转站**，页面上有：

- **模型分组**（页面最上）：创建分组、增删候选模型、调整顺序、选择调度方式，以及每条候选的**应答率**和**刷新统计**按钮
- **接口地址**：Base URL、两个端点、一段可直接复制的 Python 示例
- **API 密钥**：创建（带备注名）、删除、以及开启/关闭鉴权
- **可用模型**：当前暴露的模型清单

### 分组是怎么存的

- 存在 `~/.dsh/model-relay-groups.json`，和密钥**分开两个文件**。
- 密钥文件那套"权限被放宽就当作不存在"的规则**不适用于分组**：那个规则是为凭据设计的，分组只是路由偏好，把它当成敌意文件会让功能无谓地失效。
- 同样是原子替换 + 串行化队列。
- 文件损坏或某条记录不可用时，**该条被丢弃而不是修复**——编一个名字或空候选列表只会造出一个永远无法服务的分组，那比它不存在更糟。
- 每条记录带 `strategy` 和 `retry429`。**取不到或非法的调度值会退回到默认值（顺序、不重试），而不是丢弃整条记录**——候选列表才是值钱的部分，一个偏好不值得拿整个分组去换。旧版本写的文件（没有这两个字段）照常加载。
- `version` 字段从 1 提到 2，但它**只是描述性的**：读取时从不校验，所以旧插件读新文件只是忽略多出来的字段。

### 统计是怎么存的

**分两层。**

**实时层（内存）**：每条候选的调用统计（尝试、已应答、未应答、限流重试、最近 20 次结局、token/TTFT 累计）只活在内存里。这是徽章和悬停的数据源

**历史层（落盘，0.5.0 起）**：按天聚合的计数异步写到独立文件 `~/.dsh/model-relay-stats.json`：

- **记什么**：分组名、候选模型名、每日/每小时的请求量与调用次数、已应答/未应答、token 数、TTFT 累计。
- **不记什么**：prompt 正文、响应正文、密钥——一个都没有。
- **保留 90 天**（`statsRetentionDays` 可调，1–365），到期自动修剪。
- **小时桶只存全局**：24 小时窗口是全局口径，**分组没有小时级历史**——按分组存小时桶会把文件放大几十倍，图表上会明说这一点，而不是显示一个空的分组 24h 图。
- **写入是去抖的**（约 2 秒）：进程被强杀时最多丢最后约 2 秒的计数；退出/重载时会先落一次盘。
- **每次成功写盘前，上一版文档会轮换到 `model-relay-stats.json.bak`**——任何意外覆写删掉 `.bak` 即可回滚。
- **空状态绝不覆写已有文件**：启动时读不到（或解析不了）文件只记一条告警、以空状态运行，原文件原样保留，直到有真实数据进来才重建；`rename` 遇 Windows 文件锁会按 100/200ms 短重试，不丢落盘、不留临时文件。
- **权限 0600**；这一切都绝不阻断启动。

### 密钥是怎么处理的

- 服务端只保存 **SHA-256 哈希**，明文只在创建弹窗里显示一次，关掉就再也拿不回来——丢了就删掉重建。
- 列表里显示的是 `sk-dshgw-abcd…wxyz` 这种可辨认的掩码，不能用来调用。
- 密钥文件默认在 `~/.dsh/model-relay-keys.json`，权限 `0600`；**权限被放宽的文件会被当作不存在**，不会被信任。
- 写入是原子替换 + 串行化队列，连续创建多个密钥不会互相覆盖。

### 一个安全限制

**删掉最后一个密钥，接口仍然保持锁定**，必须显式点"关闭鉴权"才会重新开放。

这不是偷懒：如果删除密钥会自动放开接口，那么"清理一个不再使用的密钥"这个日常动作就会静默地把接口暴露给所有人。权限只应由明确的操作放开，而不是由清理动作的副作用放开。页面上有对应的提示文案。

## 反向代理（飞牛统一网关等）

**调用模型请用端口地址，不要走反向代理。**

页面上显示的 Base URL 是 `http://<host>:<port>/v1`，其中 port 是 DSH 实际监听的端口（从 `ctx.webServer.port` 读取，不是页面地址）。这样做的原因：

- 反向代理会**重写路径**。飞牛网关把应用挂在 `/app/fn-deepseek-harness` 下，转发前剥掉这个前缀，并按自己的白名单给页面资源加前缀。SSE 流式响应和这个网关的路径改写叠加起来很容易出问题。
- 直接打端口就绕开了所有这些不确定性。

页面上会提示当前是"只监听本机"还是"监听所有网卡"，据此判断其他机器能否调用。

## 局域网访问

想让同一网络的其他设备（手机、笔记本、另一台服务器）也能调用，开一个**独立监听端口**：

```yaml
- id: dsh-model-gateway
  inject:
    - llm
    - webServer
  config:
    lanPort: 3081
```

然后其他设备用：

```
http://<这台机器的局域网IP>:3081/v1
```

设置页的"局域网访问"卡片会直接列出可用的 IP 地址，每个都能一键复制。

**只列出真正的局域网地址。** 装了 Docker/libvirt 的机器通常会有十几个 `172.x`/`br-*` 虚拟网桥地址，局域网设备根本连不上。这些会被过滤掉（`docker`、`br-`、`veth`、`virbr`、`vmnet`、`wg`、`tailscale` 等前缀），默认路由所在网卡的地址排在最前。被隐藏的数量会在卡片下方注明，方便排查——万一你的可用地址恰好落在某个网桥上，能看出是过滤导致的，而不是"没有地址"。

### 必须配密钥

**开启局域网监听前请先创建一个 API 密钥。** 没有密钥时，这个端口对同网络的**任何设备**开放。启动时如果发现没配密钥，日志会打一条警告，设置页上也会显示红色提示。

密钥校验在两条监听上是同一套：本机调用和局域网调用都认同一份密钥。

### 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `lanPort` | `false` | `false` 关闭；端口号开启独立监听；`0` 让系统分配一个空闲端口 |
| `lanHost` | `0.0.0.0` | 监听地址。只想给某一个网卡用时填该网卡的 IP |

`lanPort` 是整数（0–65535）或 `false`，其他值会在加载时直接报错，而不是等到运行时才发现。

### 防火墙

如果局域网连不上，先确认主机防火墙放行了这个端口。以飞牛/群晖这类 NAS 为例，通常需要在系统防火墙里额外放行 TCP 3081。

### 设置页自身是怎么在网关下工作的

设置页需要在网关下也能用，所以它的请求走了一个专门的约定：

- **端点挂在 `/api/model-relay`**，而不是插件私有的通道名。`/api` 是每个部署（包括飞牛网关的白名单）都一定会转发的唯一前缀；插件私有通道名不在白名单里，请求根本到不了 DSH——这正是早先设置页报 `transport failure ... HTTP 404` 的原因。
- **客户端用相对路径** `api/model-relay` 并对着 `document.baseURI` 解析。网关会把 `<base>` 设成带前缀的地址，相对路径因此自动带上前缀；写成根绝对路径 `/api/...` 会以 origin 为基准解析，前缀就丢了。
- 该端点复用 Connection 的信任校验与浏览器鉴权，所以只有已登录的 DSH 页面能管理密钥，`/v1` 自身不提供任何密钥管理入口。

## 配置（可选）

在 `profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-model-gateway
  inject:
    - llm
    - webServer
  config:
    # 挂载点，默认 /v1
    path: /v1
    # 固定密钥：配了就校验，没配就放行。支持 Authorization: Bearer 和 x-api-key。
    # 与设置页创建的密钥同时生效；配置里存在固定密钥时，设置页无法关闭鉴权。
    apiKeys:
      - sk-your-key
    # 只暴露这些 provider，默认全部
    # 填 [dsh-model-gateway] 可以让外部只看到分组、看不到底层模型。
    # 这是「对外」的过滤，不影响 DSH 自己能看到什么。
    providers:
      - codebuddy
    # 裸模型名的优先 provider
    defaultProvider: codebuddy
    # 跨域响应头，默认 true
    cors: true
    # 密钥存储路径，默认 <DSH_HOME>/model-relay-keys.json
    keysFile: /path/to/keys.json
    # 分组存储路径，默认 <DSH_HOME>/model-relay-groups.json
    groupsFile: /path/to/groups.json
    # 局域网独立监听端口（详见上文"局域网访问"）；false 或不写即关闭
    lanPort: 3081
    # 监听地址，默认 0.0.0.0
    lanHost: 0.0.0.0
    # 统计持久化，默认 true；false 恢复 0.4.x 的纯内存行为
    statsPersist: true
    # 统计存储路径，默认 <DSH_HOME>/model-relay-stats.json
    # statsFile: /path/to/stats.json
    # 天级统计保留天数，默认 90（可设 1–365）
    # statsRetentionDays: 90
```

> **本插件不 patch `connection` 那一行。**
>
> 早期版本曾用 bundle patch 复写 `connection` 的 `inject`，想把它补成 `webRuntime` + `webServer`。这个做法是错的：loader patch 是**整值替换**（`dsh-app-boot` 的 `applyEntryPatches` 做的是 `target[key] = value`），不合并，所以它不是"补充"而是"覆盖掉别人写的所有内容"。
>
> 在真实组合里那一行还带着其他层的要求：`dsh-webgate` 会加上 `lanAccessHosts` 和从 `ctx.lanAccessHosts` 读的 `trustedHosts`；`connection` 自己声明 `inject: ["webServer", "credentials"]` 并直接读 `ctx.credentials` 构造 BrowserAuth。覆盖它会同时丢掉 `lanAccessHosts` 和 `credentials`，导致 Connection 起不来——**整个 `/api` 通道连同 Web 界面一起挂掉**，不只是本插件的设置页。
>
> 结论：`connection` 由 bundle 栈组合，插件只消费它的服务，不去定义它的依赖。需要 connection RPC 的插件各自声明 `inject` 即可，不需要（也不应该）由本插件代为维护那个并集。

## 边界

- **默认只监听本机**。DSH Web 默认绑 `127.0.0.1`；局域网访问要用 `lanPort` 开独立端口，并且**一定要先配密钥**。
- **密钥管理只走设置页**。管理端点挂在 DSH 已鉴权的 connection carrier 上（`/api/model-relay`），`/v1` 自身不提供任何密钥管理接口。
- **没有 `/v1/embeddings`、`/v1/images`** 等接口。这个网关只做对话和模型列表；DSH 的 `llm` 服务没有 embedding 能力，所以这里不会假装有。
- **图片输入依赖附件服务**。`ctx.attachments` 没挂载时，带图请求会被明确拒绝（400），而不是静默丢图。
- **分组回退只在首字节前有效**（见上文"模型分组"）。
- **组合分组只能包含普通分组**（深度最多一层），且成员必须写成 `dsh-model-gateway_<分组名>`。
- **DSH 本体的会话不会经过 `/v1`**。它走的是 DSH 自己的 provider 通道；本插件注册 `dsh-model-gateway` provider 是为了让分组出现在模型选择器里，不是为了把 DSH 的请求绕回自己的 HTTP 端口。所以给 `/v1` 开鉴权**不会**影响 DSH 本体。
- 请求体上限 32 MiB，超出返回 413。

## 开发

```sh
npm run check                # 语法检查（含 groups.js / adapter.js / host-compat.js）
npm test                     # 全部测试
```

单独跑：

```sh
npm test                         # 跑全部 16 个套件，任一失败不影响其余
node test/gateway.test.mjs       # 协议翻译 + 路由 + 分组回退 + 设置端点 + 状态码/Retry-After
node test/keys.test.mjs          # 密钥存储：哈希、权限、并发、锁定语义
node test/groups.test.mjs        # 分组存储：校验、并发、损坏降级、kind、失效引用
node test/nesting.test.mjs       # 组合分组 + 三条递归路径的守卫 —— 见下
node test/adapter.test.mjs       # 适配器单元测试（用 mock llm）
node test/adapter-real.test.mjs  # 适配器对真实 dsh-llm 服务 —— 见下
node test/registration.test.mjs  # provider 注册的三件套 + 档位交集是否正确接上
node test/failure-code.test.mjs  # 失败码/重试提示能不能活着走到代理循环 —— 见下
node test/verify-table.mjs       # 把上面那张失败表重新实测一遍，防止文档和行为漂移
```

`nesting.test.mjs` 值得单独说一句：它**注册真实的 relay 适配器**，并让 `resolveModelInfo`
对 relay 路由的回答也由那个适配器给出 —— 这正是 DSH 的做法，也正是"能力期"那条递归路径
能成立的原因。用一个"relay provider 返回空列表"的假 llm 是**测不出**环的：它根本不会重现
那次往返。这是本仓库 mock-blindspot 规则的一个具体案例。

`npm test` 走 `test/run.mjs`，每个套件独立进程、各自输出重定向到临时文件（Windows 上管道是命名管道，某些沙箱不允许创建）。**故意不用 `&&` 串联**：那样一个失败会静默吃掉后面所有套件，而 Windows 上恰好有一个必失败用例，于是 6 个套件里只有 1 个真的跑了。

**`adapter-real.test.mjs` 不能用 mock 替代。** 它驱动真实的 `LlmService` 实例，让 DSH 自己的校验器当裁判。

原因是踩过一次：`reasoning.efforts` 写成了字符串数组 `['low','medium','high']`，而 DSH 期望 `{id, name}` 对象数组。用 mock 测完全绿——mock 把坏值原样吐回来。真实服务立刻抛 `INVALID_MODEL_REASONING`，整个 provider 从聊天选择器里消失（但设置页仍显示卡片，因为那条路径不碰适配器）。

**同一个盲区后来咬过两次，形状各不相同。** 第一次：mock 让适配器**抛异常**来表示失败，但真实 `dsh-llm` 不会让适配器异常逃出去——它在自己的边界捕获，转成一个 `{type:'finish', reason:{kind:'error'}}` **分片**（`adapterStream` / `adapterFailureChunk`）。回退循环只看 `next.done`，于是把这个错误分片当成正常结果直接透传，`started` 也被置为 true——**真实运行时的分组回退从来没生效过**，而所有 mock 测试全绿。现在 `test/gateway.test.mjs` 两种形状都测。

第二次：**失败码**。所有候选都挂掉后网关抛出的 `GatewayError` 要穿过 DSH 边界，而边界只认 `HarnessError` 的 `code`，其余压成 `UNKNOWN`。`dsh-llm-retry` 按 `failure.code` 决定重不重试，于是分组整体失败时**一次都不会被重试**——但没有任何测试看得见。见 `test/failure-code.test.mjs`。

**规则**：任何交给 DSH 消费的结构（`listModels` / `resolveModel` 的返回值），都必须用真实服务实例验证。mock 只能证明"我传了我以为对的东西"，证明不了"对方接受它"。同理，**mock 的失败方式也必须和真实运行时一致**——失败是抛出来的还是当值返回的，会决定一整条控制流走不走得到；**而失败携带的 `code` 会被边界重写**，所以"错误信息对了"不等于"错误码还在"。

测试用假的 `llm` 服务和真实的 `node:http` 服务器驱动路由，验证 OpenAI 协议翻译的往返形状；存储测试跑在真实临时目录上。都不需要登录账号，也不发外部请求。

**三个已知的 Windows 上会失败的用例**（与本次改动无关，改动前就是这个结果）：`gateway.test.mjs` 的局域网地址过滤（依赖 Linux 的 `/proc/net/route`）、`keys.test.mjs` 的两个 POSIX 文件权限用例（Windows 没有 POSIX mode，`keys.js` 在 win32 上直接跳过检查）。

> **改了代码后确认一下安装副本。** pnpm 对 `file:` 依赖用的是**硬链接**（不是拷贝，也不是软链）：源文件和 `node_modules` 里的副本是同一个 inode。
>
> 这带来一个反直觉的坑：
>
> - **原地写入**（`echo >> file`、`sed -i` 之外的直接写）会同步到两边——因为本来就是同一份内容。
> - **先写临时文件再 rename**（`write`/`edit` 这类工具、多数编辑器保存时都是这么做的）会**悄悄断开硬链接**。源文件更新了，副本还是旧内容，而且没有任何报错。
>
> 所以改完源码后如果行为没变，别怀疑代码——先对一下内容：
>
> ```sh
> diff -r lib/ /绝对路径/profiles/web/node_modules/@leaf233/dsh-model-gateway/lib/
> ```
>
> 不一致就重新执行 `dsh plugin --profile web add file:/绝对路径/relay-upstream`。注意 pnpm 可能报 "Already up to date" 而不重新链接，这种情况先 `remove` 再 `add`。
>
> 想让改动彻底自动生效，可以把依赖换成 `link:`。

## License

Apache-2.0
