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

#### 图谱建立
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

事件 "before_tool_call" / "after_tool_call" 触发, 记录工具调用:

输入:
```LOG
{"time":"2026-04-28T12:43:49.510Z","category":"tool_call","message":"before_tool_call: feishu_search_doc_wiki","data":{"toolName":"feishu_search_doc_wiki","parameters":"{\"action\":\"search\",\"query\":\"每日一题\"}"}}
{"time":"2026-04-28T12:43:50.180Z","category":"tool_result","message":"after_tool_call: feishu_search_doc_wiki","data":{"toolName":"feishu_search_doc_wiki","result":"{\"content\":[{\"type\":\"text\",\"text\":\"{\\n  \\\"error\\\": \\\"need_user_authorization\\\"\\n}\"}],\"details\":{\"error\":\"need_user_authorization\"}}"}}

TODO : 日志中如何区分是哪个agent_plan的工具调用？如果有同步的tool call如何区分
```

流程
1. before: 追加 tool_call 事件 (工具名, 参数), 更新 toolSequence
2. after: 追加 tool_call 事件 (工具名, 参数), 更新 toolSequence，链接在上一个 before_tool_call 事件后

输出: 局事件链对象 (EventChain) 新增 tool_call 事件

返回值: 无

-----

事件 "llm_output" 触发, 将创建的图保存链接到问题上:

输入:
```LOG
{"time":"2026-04-28T12:48:01.992Z","category":"llm_output","message":"llm_output","data":{"content":"{\"runId\":\"8d2b196a-775e-4606-b2d3-07697e57227d\",\"sessionId\":\"f1f4095e-a2fd-4647-be93-eb17c63fa394\",\"provider\":\"miaoda\",\"model\":\"miaoda-model-auto\",\"assistantTexts\":[\"**今日 LeetCode 每日一题（2026-04-28）** 🎯\\n\\n---\\n\\n### 2160. Minimum Operations to Make a Uni-Value Grid\\n**难度：** 中等（Medium）\\n\\n---\\n\\n**题目描述：**\\n\\n给你一个大小为 `m x n` 的二维整数网格 `grid` 和一个整数 `x`。每一次操作，你可以对 `grid` 中的任一元素 **加** `x` 或 **减** `x`。\\n\\n**单值网格** 是全部元素都相等的网格。\\n\\n返回使网格化为单值网格所需的 **最小** 操作数。如果不能，返回 `-1`。\\n\\n---\\n\\n**示例：**\\n\\n```\\n输入：grid = [[2,4],[6,8]], x = 2\\n输出：4\\n解释：可以执行下述操作使所有元素都等于 4：\\n- 2 加 x 一次\\n- 6 减 x 一次\\n- 8 减 x 两次\\n共计 4 次操作\\n\\n输入：grid = [[1,5],[2,3]], x = 1\\n输出：5\\n解释：可以使所有元素都等于 3\\n\\n输入：grid = [[1,2],[3,4]], x = 2\\n输出：-1\\n解释：无法使所有元素相等\\n```\\n\\n---\\n\\n**提示：**\\n1. 两个整数 a 和 b 如果对 x 取余结果不同，能否让它们相等？\\n2. 如果可以，应该选哪个目标值才能使操作数最少？\\n3. 如果将所有元素排序会怎样？\\n\\n---\\n\\n**解题核心：** 先判断所有元素对 x 取余是否相同，余数不同直接返回 -1；相同则找出中位数作为目标值，贪心地计算每个元素到达中位数需要的操作次数之和。\\n\\n链接：[https://leetcode.cn/problems/minimum-operations-to-make-a-uni-value-grid/](https://leetc","model":"miaoda-model-auto","provider":"miaoda"}}

```

流程：
1. 设置事件链 outcome (success/failure/partial) - 暂定用户下一次的query中包含对上一次回答的评价/打分 OR LLM打分
2. 生成整体向量 (userIntent + toolSequence + outcome) - ？必要性
3. 保存*事件链摘要*到 LanceDB (向量检索)
4. 构建知识图谱节点 (Intent → Action → Outcome) 和关系 (TRIGGERS, LEADS_TO, RESULTS_IN)
5. 保存图谱到 Neo4j
6. 进行图匹配操作，进行知识的融合提取
7. 清理内存中的活跃事件链 - 或等下一次用户问题输入打分后

输出：<指定目录>/temporaryEventchain/<事件摘要>.md


### API(src/*.ts)

#### src/types.ts — 核心类型定义
| 类型 | 说明 |
|------|------|
| `MEvent` | 单个事件 (user_query / tool_call / ai_response / error) |
| `EventChain` | 事件链: id, taskId, userIntent, events[], toolSequence[], outcome, embedding[] |
| `GraphNode` | 图谱节点: id, type(Intent/Action/Context/Outcome), label, properties |
| `GraphRelationship` | 图谱关系: from, to, type(TRIGGERS/REQUIRES/LEADS_TO/RESULTS_IN) |
| `RetrievalResult` | 检索结果: chain + score |
| `StorageConfig` | 存储配置: lanceDbPath, neo4jUri, neo4jUser, neo4jPassword |

#### src/storage.ts — 存储层 (LanceDB + Neo4j)
```typescript
class Storage {
  constructor(config: StorageConfig)
  init(): Promise<void>                    // 连接 LanceDB 和 Neo4j
  close(): Promise<void>                   // 关闭连接
  saveEventChain(chain: EventChain): Promise<void>           // 保存到 LanceDB
  searchSimilar(embedding: number[], topK?: number): Promise<RetrievalResult[]>  // 向量检索
  saveGraph(chainId: string, nodes: GraphNode[], rels: GraphRelationship[]): Promise<void>  // 保存到 Neo4j
  queryByIntent(intentLabel: string): Promise<GraphNode[]>   // 按意图查询图谱
}
```
- Neo4j 不可用时自动降级为仅向量模式
- LanceDB 表 "event_chains" 首次写入时自动创建

#### src/processor.ts — 事件链构建 + Query检索
```typescript
class Processor {
  constructor(config: StorageConfig)
  init(): Promise<void>                                      // 初始化存储
  close(): Promise<void>                                     // 关闭
  onMessageReceived(event: any): Promise<RetrievalResult[]>  // 检索相似事件链
  onReplyDispatch(event: any): void                          // 新建/更新事件链
  onBeforeToolCall(event: any): void                         // 记录工具调用
  onAfterToolCall(event: any): void                          // 回填工具结果
  onAgentEnd(event: any): Promise<void>                      // 持久化 + 建图
}
```

#### src/logger.ts — 日志 (已有)
```typescript
function log(category: string, message: string, data?: any): void
```

### 配置

环境变量:
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j 连接地址 |
| `NEO4J_USER` | `neo4j` | Neo4j 用户名 |
| `NEO4J_PASSWORD` | `password` | Neo4j 密码 |

LanceDB 数据目录: `~/.openclaw/memory/vectors/`


## 测试

```bash
# 插件本地测试
npm test
```