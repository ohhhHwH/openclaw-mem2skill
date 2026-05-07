# openclaw 插件 - mem2skill



## 插件安装
```bash
# 安装依赖
npm install
# 类型检查
npx tsc --noEmit
# 打包为 tgz
npm pack
# 列出已安装插件
openclaw plugins list --enabled
# 安装本地插件（目录或 tgz 均可）
openclaw plugins install ./myorg-openclaw-mem2skill-1.0.0.tgz
# 重启 Gateway 网关
openclaw gateway restart
# 卸载插件
openclaw plugins uninstall memory2skill
```

注：当前模式为DEBUG模式，需要有 历史事件链 数据才能成功检索运行。
需要关闭DEBUG模式，修改 src/processor.ts 中的 `const DEBUG = true` 为 `false`，并重新编译打包安装。
然后生成 事件链 ，关闭DEBUG模式后不会输出建图等，只会进行检索和打分，来验证 mem2skill 的效果。

## openclaw流程

用户输入-> 预处理层 -> 任务分发层 -> 插件执行层 -> 结果返回

## mem2skill流程

每段开始为原有流程，后续为 mem2skill 插件加入的流程

用户输入-> 预处理层(query检索) -> 返回 Agent 指导 Prompt -> Prompt + Query
-> Agent 规划 ->
-> Tool call + Tool output ->
-> Agent 生成最终结果 ->
-> 结果返回 -> 将 Query + Agent 规划 + Tool call + Tool output + 最终结果 保存到图谱中 -> 图谱匹配 -> 相关经验检索 -> 返回 Agent 指导 Prompt

### 接口函数描述

#### Query检索/保存
事件 "message_received" 触发, 检索历史记忆

输入: OpenClaw message_received 事件对象 (含 text/content/message, taskId, threadId)
```LOG
{"time":"2026-04-28T12:44:12.020Z","category":"user_input","message":"message_received","data":{"original":"今天的Leetcode每日一题是什么"}}
```

流程:
1. 提取用户输入文本
2. 生成文本向量 (embedding)
3. 在 LanceDB 中进行 ANN 近似搜索, 返回 top-k 相似事件链
4. 同时创建当前任务的 EventChain, 开始收集后续事件

输出: 
    最相似的事件链的 Prompt
    最相似事件链索引 - 内存中（用于检索质量评估和后续更新）

如果有对上一次回答的评价
输出: 
    调用LLM生成上一次事件链打分(准确度/速度/格式) + 用户反馈文本
    更新上一次的事件链 + 对上一次检索事件链评价
    若相似
        上一次的事件链 + 上一次检索事件链 做知识图谱的对齐操作 - 尝试提取共性生成长期记忆

返回值: 字符串 (包含历史经验的 Prompt)

#### 图谱建立/存储
事件 "reply_dispatch" 触发 (agent_plan), 新建图:

输入:
```LOG
{"time":"2026-04-28T12:44:12.022Z","category":"agent_plan","message":"reply_dispatch","data":{"content":"{\"ctx\":{\"Body\":\"今天的Leetcode每日一题是什么\",\"BodyForAgent\":\"[Tue 2026-04-28 12:44 UTC] 今天的Leetcode每日一题是什么\",\"BodyForCommands\":\"今天的Leetcode每日一题是什么\",\"RawBody\":\"今天的Leetcode每日一题是什么\",\"CommandBody\":\"今天的Leetcode每日一题是什么\",\"SessionKey\":\"agent:main:main\",\"Provider\":\"webchat\",\"Surface\":\"webchat\",\"OriginatingChannel\":\"webchat\",\"ExplicitDeliverRoute\":false,\"ChatType\":\"direct\",\"CommandAuthorized\":true,\"MessageSid\":\"8d2b196a-775e-4606-b2d3-07697e57227d\",\"SenderId\":\"openclaw-control-ui\",\"GatewayClientScopes\":[\"operator.admin\",\"operator.read\",\"operator.write\",\"operator.approvals\",\"operator.pairing\"]},\"runId\":\"8d2b196a-775e-4606-b2d3-07697e57227d\",\"sessionKey\":\"agent:main:main\",\"inboundAudio\":false,\"ttsChannel\":\"webchat\",\"suppressUserDelivery\":false,\"shouldRouteToOriginating\":false,\"originatingChannel\":\"webchat\",\"shouldSendToolSummaries\":true,\"sendPolicy\":\"allow\"}"}}
```

流程:
1. 根据 taskId 创建 EventChain

输出: 新建全局事件链对象 (EventChain) - 内存中

返回值: 无

-----

事件 "agent_end" 触发, 记录工具调用:

输入: 见 example.log
```LOG
{
    "time": "2026-05-02T15:39:50.764Z",
    "category": "agent_end",
    "message": "agent_end",
    "data": {
        ...
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": <Query>,
                    }
                ],
                ...
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": <think content>,
                        "thinkingSignature": "reasoning_content"
                    },
                    {
                        "type": "toolCall",
                        "id": <toolCall id 1>,
                        "name": <toolCall name 1>,
                        "arguments": {
                            "query": <toolCall query content>
                        }
                    }
                ],
                ...
            },
            {
                "role": "toolResult",
                "toolCallId": <toolCall id 1>,
                "toolName": <toolCall name 1>,
                "content": [
                    {
                        "type": "text",
                        "text": <toolCall result content>
                    }
                ],
                "details": {
                    "query": <toolCall query details content>,
                    "provider": "miaoda",
                    "count": 10,
                    "results": [
                        {
                            "title": <toolCall result details title 1>,
                            "url": <toolCall result details url 1>,
                            "description": <toolCall result details description 1>,
                            "siteName": <toolCall result details siteName 1>
                        },
                        ...
                    ]
                },
                "isError": false,
                "timestamp": 1777736291310
            },
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": <base on toolcall result and query , think next step>
                    },
                    {
                        "type": "toolCall",
                        "id": <toolCall id 2>,
                        "name": "web_crawl",
                        "arguments": {
                            "url": <toolCall query content 2> may from pre tool call result,
                        }
                    }
                ],
                ...
            },
            ...
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": <before pre memory, include tool call result, thinks, and query>
                    },
                    {
                        "type": "text",
                        "text": <final answer content>
                    }
                ],
                ...
            }
        ]
    }
}
```


流程
1. 根据 tool call 与 tool result 的关系通过 tool call id 来关联，将其视为一个节点
2. 如果 tool call 查询的字符串 在之前的 tool_result 中能够找到（字符串匹配），那么认为是依赖关系，建立图谱边
3. 设置事件链 outcome (success/failure/partial) - 通过 llm对thinking内容分析 进行打分

输出: 局事件链对象 (EventChain) 新增 tool_call 事件

返回值: 无

-----

事件 "llm_output" 触发, 将 最终回答 和 创建的图保存链接到问题上:

输入:
```LOG
{"time":"2026-04-28T12:48:01.992Z","category":"llm_output","message":"llm_output","data":{"content":"{\"runId\":\"8d2b196a-775e-4606-b2d3-07697e57227d\",\"sessionId\":\"f1f4095e-a2fd-4647-be93-eb17c63fa394\",\"provider\":\"miaoda\",\"model\":\"miaoda-model-auto\",\"assistantTexts\":[\"**今日 LeetCode 每日一题（2026-04-28）** 🎯\\n\\n---\\n\\n### 2160. Minimum Operations to Make a Uni-Value Grid\\n**难度：** 中等（Medium）\\n\\n---\\n\\n**题目描述：**\\n\\n给你一个大小为 `m x n` 的二维整数网格 `grid` 和一个整数 `x`。每一次操作，你可以对 `grid` 中的任一元素 **加** `x` 或 **减** `x`。\\n\\n**单值网格** 是全部元素都相等的网格。\\n\\n返回使网格化为单值网格所需的 **最小** 操作数。如果不能，返回 `-1`。\\n\\n---\\n\\n**示例：**\\n\\n```\\n输入：grid = [[2,4],[6,8]], x = 2\\n输出：4\\n解释：可以执行下述操作使所有元素都等于 4：\\n- 2 加 x 一次\\n- 6 减 x 一次\\n- 8 减 x 两次\\n共计 4 次操作\\n\\n输入：grid = [[1,5],[2,3]], x = 1\\n输出：5\\n解释：可以使所有元素都等于 3\\n\\n输入：grid = [[1,2],[3,4]], x = 2\\n输出：-1\\n解释：无法使所有元素相等\\n```\\n\\n---\\n\\n**提示：**\\n1. 两个整数 a 和 b 如果对 x 取余结果不同，能否让它们相等？\\n2. 如果可以，应该选哪个目标值才能使操作数最少？\\n3. 如果将所有元素排序会怎样？\\n\\n---\\n\\n**解题核心：** 先判断所有元素对 x 取余是否相同，余数不同直接返回 -1；相同则找出中位数作为目标值，贪心地计算每个元素到达中位数需要的操作次数之和。\\n\\n链接：[https://leetcode.cn/problems/minimum-operations-to-make-a-uni-value-grid/](https://leetc","model":"miaoda-model-auto","provider":"miaoda"}}

```

流程：
1. 设置事件链 outcome (success/failure/partial) - LLM打分
2. 生成问题向量（摘要）
3. 保存*事件链摘要*到 LanceDB (向量检索)
4. 构建知识图谱节点 (Intent → Action → Outcome) 和关系 (TRIGGERS, LEADS_TO, RESULTS_IN)
5. 保存图谱到 本地log知识图谱文件
6. 进行图匹配操作，进行知识的融合提取
7. 清理内存中的活跃事件链 - 或等下一次用户问题输入打分后

输出：<指定目录>/temporaryEventchain/<事件摘要>.md


### API(src/*.ts)

#### src/types.ts — 核心类型定义

```typescript
// 单个事件节点
interface MEvent {
  type: "user_query" | "tool_call" | "ai_response" | "error";
  content: string;
  metadata: {
    toolName?: string;      // 工具名 (tool_call 类型)
    parameters?: any;       // 工具入参
    result?: any;           // 工具返回值 (after_tool_call 回填)
    success?: boolean;      // 工具是否成功
    duration?: number;      // 工具执行耗时 ms
    timestamp: number;      // 事件时间戳
  };
}

// 事件链 — 一次完整的 Query→Plan→ToolCalls→Response 过程
interface EventChain {
  id: string;               // UUID
  taskId: string;           // 来自 event.taskId / threadId / runId
  timestamp: number;        // 链创建时间
  userIntent: string;       // 用户原始输入文本
  events: MEvent[];         // 按时间顺序的事件列表
  toolSequence: string[];   // 工具调用序列 (工具名数组)
  outcome: "success" | "failure" | "partial";
  embedding: number[];      // 向量 (用于 LanceDB ANN 检索)
}

// 知识图谱节点
type GraphNodeType = "Intent" | "Action" | "Context" | "Outcome";
interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  properties: Record<string, any>;
}

// 知识图谱关系
type GraphRelType = "TRIGGERS" | "REQUIRES" | "LEADS_TO" | "RESULTS_IN";
interface GraphRelationship {
  from: string;             // 起始节点 id
  to: string;               // 目标节点 id
  type: GraphRelType;
  properties?: Record<string, any>;
}

// 向量检索结果
interface RetrievalResult {
  chain: EventChain;        // 匹配到的历史事件链
  score: number;            // 相似度分数 (0~1, 越高越相似)
}

// 存储层配置
interface StorageConfig {
  lanceDbPath: string;      // LanceDB 数据目录
  graphLogPath: string;     // 本地log知识图谱文件路径
}
```

#### src/storage.ts — 存储层 (LanceDB + 本地log知识图谱文件)

负责事件链的向量存储/检索 (LanceDB) 和知识图谱的持久化/查询 (本地log知识图谱文件)。

```typescript
class Storage {
  constructor(config: StorageConfig)

  // 初始化: 连接 LanceDB - 向量检索, 加载 tem-mem long-mem 表数据到内存 以供检索
  init(): Promise<void>

  // 关闭所有连接
  close(): Promise<void>

  // 保存事件链到 LanceDB (表 "event_chains", 首次写入自动建表)
  // 存储字段: id, taskId, userIntent, toolSequence(JSON), outcome, timestamp, chainJson(完整序列化), vector(Float32Array)
  // 事件链 与 本地log知识图谱 数据 通过 taskId 进行关联
  saveEventChain(chain: EventChain): Promise<void>

  // 向量近似检索, 返回 top-k 相似事件链
  // score = 1 / (1 + distance), 距离越小分数越高
  searchSimilar(embedding: number[], topK?: number): Promise<RetrievalResult[]>

  // 保存知识图谱到 本地log知识图谱 文件中
  saveGraph(chainId: string, nodes: GraphNode[], rels: GraphRelationship[]): Promise<void>

  // 按意图标签模糊查询 Intent 节点 (CONTAINS 匹配)
  queryByIntent(intentLabel: string): Promise<GraphNode[]>
}
```

#### src/processor.ts — 事件链构建 + Query检索

核心处理器, 管理活跃事件链 (`activeChains: Map<taskId, EventChain>`), 对接 index.ts 中的事件处理器。

```typescript
class Processor {
  constructor(config: StorageConfig)

  // 初始化存储层
  init(): Promise<void>

  // 关闭存储层
  close(): Promise<void>

  // [Query检索] message_received 触发
  // 1. 提取文本 → 生成 embedding → LanceDB ANN 检索 top-5
  // 2. 同时创建当前 taskId 的 EventChain
  // 输入: OpenClaw message_received 事件
  // 返回: 相似事件链数组 (用于生成指导 Prompt)
  onMessageReceived(event: any): Promise<RetrievalResult[]>

  // [图谱建立] reply_dispatch 触发
  // 获取或创建 EventChain, 追加 ai_response 事件
  onReplyDispatch(event: any): void

  // [图谱建立] before_tool_call 触发
  // 追加 tool_call 事件, 更新 toolSequence
  onBeforeToolCall(event: any): void

  // [图谱建立] after_tool_call 触发
  // 回填最近一次同名 tool_call 的 result/success/duration
  onAfterToolCall(event: any): void

  // [图谱建立] agent_end 触发
  // 1. 设置 outcome → 生成 embedding → saveEventChain (LanceDB)
  // 2. 构建图谱: Intent -TRIGGERS→ Action(s) -LEADS_TO→ ... -RESULTS_IN→ Outcome
  // 3. saveGraph (本地log知识图谱文件) → 清理 activeChains
  onAgentEnd(event: any): Promise<void>
}
```

#### src/logger.ts — JSON Lines 日志

```typescript
// 追加一行 JSON 到 ~/workspace/agent/logs/myplugins.log
function log(category: string, message: string, data?: any): void
```

### 配置

## 测试

```bash
# 插件本地测试
npm test
```