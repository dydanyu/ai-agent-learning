# LangChain 使用 MCP 过程及实现原理详解

> 基于 `langchain-mcp.mjs` 与 `my-mcp-server.mjs` 的源码分析

---

## 整体架构

```
用户 Query
   │
   ▼
LangChain Agent (langchain-mcp.mjs)
   │  ① 启动子进程
   │  ② 通过 stdio 通信
   ▼
MCP Server (my-mcp-server.mjs)
   │  提供工具: query_user
   ▼
模拟数据库 (database)
```

整个系统分为三层：**LangChain 客户端层**、**MCP 协议层**、**工具服务层**。

---

## 第一层：MCP Server 的实现原理

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// ...
const server = new McpServer({ name: "my-mcp-server", version: "1.0.0" });
```

### 核心概念

**MCP Server** 是一个独立进程，它通过标准化协议对外暴露工具（Tools）和资源（Resources）。

### 1. 注册工具（Tool）

```js
server.registerTool(
  "query_user",
  {
    description: "查询用户信息",
    inputSchema: {
      userId: z.string().describe("用户 ID，例如: 001, 002, 003"),
    },
  },
  async ({ userId }) => {
    // ... 业务逻辑
  },
);
```

| 字段 | 说明 |
|---|---|
| `name` | 工具唯一标识符，LLM 通过名字来调用 |
| `description` | **关键字段**，LLM 根据描述决定何时调用此工具 |
| `inputSchema` | 用 Zod 定义参数类型，MCP SDK 自动转成 JSON Schema 告知 LLM |
| 返回格式 | 固定为 `{ content: [{ type: "text", text: "..." }] }` |

### 2. 注册资源（Resource）

```js
server.registerResource(
  "使用指南",
  "docs://guide",
  { description: "MCP Server 使用指南", mimeType: "text/plain" },
  async () => { /* 返回文档内容 */ },
);
```

资源是只读数据（文档、配置等），通过 URI 寻址，与工具（可执行操作）区分。

### 3. 通信传输层

```js
const transport = new StdioServerTransport();
await server.connect(transport);
```

`StdioServerTransport` 意味着该 Server 通过 **stdin/stdout** 与外部通信。MCP 还支持 HTTP/SSE 传输，但本地场景用 stdio 最简洁。

---

## 第二层：LangChain MCP 适配层的工作原理

```js
const mcpClient = new MultiServerMCPClient({
  mcpServers: {
    "my-mcp-server": {
      command: "node",
      args: ["/Users/.../my-mcp-server.mjs"],
    },
  },
});

const tools = await mcpClient.getTools();
const modelWithTools = model.bindTools(tools);
```

### 关键过程解析

**步骤 1：启动子进程**

`MultiServerMCPClient` 读取配置后，用 `child_process.spawn("node", ["my-mcp-server.mjs"])` 启动 MCP Server 进程，并建立 **stdio 管道**连接。

**步骤 2：协议握手（MCP Initialize）**

客户端发送 `initialize` 请求，服务端返回自身能力声明（支持的工具、资源等），完成握手。消息格式为 **JSON-RPC 2.0**：

```json
// Client -> Server
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": {...} } }

// Server -> Client
{ "jsonrpc": "2.0", "id": 1, "result": { "capabilities": { "tools": {} } } }
```

**步骤 3：获取工具列表（tools/list）**

```js
const tools = await mcpClient.getTools();
```

客户端发送 `tools/list` 请求，MCP Server 返回所有注册工具的元数据（名称、描述、inputSchema）。`@langchain/mcp-adapters` 将这些元数据**自动转换**为 LangChain 的 `StructuredTool` 对象。

**步骤 4：绑定工具到模型**

```js
const modelWithTools = model.bindTools(tools);
```

`bindTools` 将工具的 JSON Schema 描述注入到每次 LLM 请求的 `tools` 字段中，告诉模型"你有哪些工具可以用"。

---

## 第三层：Agent 推理循环（ReAct 模式）

```js
async function runAgentWithTools(query, maxIterations = 30) {
  const messages = [new HumanMessage(query)];

  for (let i = 0; i < maxIterations; i++) {
    const response = await modelWithTools.invoke(messages);
    messages.push(response);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return response.content; // 无工具调用 → 最终答案
    }

    for (const toolCall of response.tool_calls) {
      const foundTool = tools.find((t) => t.name === toolCall.name);
      const toolResult = await foundTool.invoke(toolCall.args);
      messages.push(new ToolMessage({
        content: String(toolResult),
        tool_call_id: toolCall.id
      }));
    }
  }
}
```

这是标准的 **ReAct（Reason + Act）** 循环，详细流程如下：

```
Round 1:
  messages: [HumanMessage("请查询用户 001 的信息")]
       ↓ LLM 思考：需要调用 query_user 工具
  response: AIMessage { tool_calls: [{ name: "query_user", args: { userId: "001" }, id: "call_xyz" }] }
       ↓ 推入 messages

Round 2:
  执行 foundTool.invoke({ userId: "001" })
       ↓ MCP Client 发送 tools/call 请求到 MCP Server
       ↓ Server 查数据库，返回用户信息
  messages 追加: ToolMessage { content: "用户信息：...", tool_call_id: "call_xyz" }

Round 3:
  messages: [Human, AI(tool_call), ToolMessage(结果)]
       ↓ LLM 看到工具结果，生成自然语言回复
  response: AIMessage { content: "用户 001 的信息如下：姓名 John Doe ..." }
       ↓ tool_calls 为空 → 返回最终答案
```

### 消息链的关键作用

多轮对话中 `messages` 数组是**完整的上下文记忆**，每次都把完整历史传给 LLM：

| 消息类型 | 作用 |
|---|---|
| `HumanMessage` | 用户输入 |
| `AIMessage` (含 tool_calls) | LLM 决定调用哪个工具 |
| `ToolMessage` | 工具执行结果，绑定 `tool_call_id` |
| `AIMessage` (含 content) | 最终自然语言回复 |

> `tool_call_id` 是工具调用与结果的**绑定键**，LLM 用它关联"我调用了什么"和"结果是什么"。

---

## 完整数据流图

```
用户: "请查询用户 001 的信息"
          │
          ▼
┌─────────────────────────────────────────┐
│  LangChain Client (langchain-mcp.mjs)   │
│                                         │
│  1. messages = [HumanMessage]           │
│  2. modelWithTools.invoke(messages)     │
│     → 请求 OpenAI API                   │
│       (携带 tools: [query_user schema]) │
│                                         │
│  3. 收到 tool_calls 响应                │
│  4. foundTool.invoke({userId:"001"})    │
│     ↓                                   │
│  ┌──────────────────────────────────┐   │
│  │  @langchain/mcp-adapters         │   │
│  │  将 invoke 转化为 MCP 协议请求    │   │
│  └──────────┬───────────────────────┘   │
│             │ JSON-RPC over stdio       │
└─────────────┼───────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  MCP Server Process (my-mcp-server.mjs) │
│                                         │
│  收到: tools/call { name:"query_user",  │
│                     args:{userId:"001"} │
│  执行: database.users["001"]            │
│  返回: { content: [{type:"text",        │
│           text:"用户信息：..."}] }      │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  LangChain Client                       │
│                                         │
│  5. 追加 ToolMessage(结果)              │
│  6. 再次 invoke(完整 messages)          │
│  7. LLM 生成最终回复                    │
│  8. 输出给用户                          │
└─────────────────────────────────────────┘
```

---

## 核心设计原则总结

| 原则 | 体现 |
|---|---|
| **进程隔离** | MCP Server 是独立子进程，崩溃不影响主程序 |
| **协议标准化** | JSON-RPC 2.0 + MCP 规范，任何 MCP Client 可对接任何 MCP Server |
| **Schema 驱动** | Zod Schema → JSON Schema → LLM 理解参数格式，全自动 |
| **对话即记忆** | messages 数组携带完整上下文，LLM 天然具备多步推理能力 |
| **工具与模型解耦** | `bindTools` 只是描述注入，执行完全在客户端侧，LLM 只负责"决策" |

---

## Resources 的使用场景与用法

### Resources vs Tools 的本质区别

| | Tools | Resources |
|---|---|---|
| 性质 | **可执行操作**（动词） | **可读数据**（名词） |
| 类比 | REST API 的 POST/PUT | REST API 的 GET |
| LLM 能否自动调用 | ✅ LLM 自主决策调用 | ❌ **LLM 不能自动调用** |
| 谁来调用 | Agent 推理循环 | **Host 应用**（如 Cursor）或开发者手动获取 |

### 使用场景

Resources 的核心定位是：**给 MCP Client（Host）提供背景知识/上下文数据**，而不是给 LLM 直接用的工具。

**场景 1：Cursor 等 IDE 读取上下文**

Cursor 在启动时会调用 `resources/list` 列出所有资源，然后把相关内容注入到对话的 System Prompt 中，让 LLM 了解背景信息。比如 `docs://guide` 就会被 Cursor 用来理解这个 MCP Server 能做什么。

**场景 2：开发者手动获取并注入上下文**

```js
// 手动读取资源，作为 System Prompt 注入
const resource = await mcpClient.readResource("my-mcp-server", "docs://guide");

const messages = [
  new SystemMessage(resource.contents[0].text),  // 注入资源内容
  new HumanMessage(query),
];
```

**场景 3：动态数据资源（带参数的 URI 模板）**

Resources 支持 URI 模板，可以按需读取不同数据：

```js
// Server 注册带参数的资源模板
server.registerResourceTemplate(
  "用户档案",
  "user://{userId}/profile",       // URI 模板
  { description: "用户详细档案", mimeType: "application/json" },
  async ({ userId }) => {
    return {
      content: [{
        uri: `user://${userId}/profile`,
        mimeType: "application/json",
        text: JSON.stringify(database.users[userId])
      }]
    };
  }
);

// Client 按 userId 读取
const profile = await mcpClient.readResource("my-mcp-server", "user://001/profile");
```

### 在当前代码中如何使用 Resources

目前 `langchain-mcp.mjs` 只用了 Tools，如需加入 Resources，可以这样改造：

```js
import { SystemMessage } from "@langchain/core/messages";

// 1. 获取资源列表
const resourceList = await mcpClient.listResources("my-mcp-server");

// 2. 读取具体资源内容
const guide = await mcpClient.readResource("my-mcp-server", "docs://guide");

// 3. 作为 SystemMessage 注入，给 LLM 提供背景知识
async function runAgentWithTools(query) {
  const messages = [
    new SystemMessage(guide.contents[0].text),  // 背景知识
    new HumanMessage(query),
  ];
  // ... 后续推理循环不变
}
```

### 使用建议

```
Resources ──→ 静态/半静态的背景数据 ──→ 由 Host/开发者主动读取 ──→ 注入 System Prompt
Tools     ──→ 动态操作能力         ──→ 由 LLM 自主决策调用   ──→ 执行业务逻辑
```

- 把**不变的规则、文档、配置**放 Resource（如 API 使用说明、业务规则）
- 把**需要执行、查询、写入**的操作放 Tool（如查数据库、发邮件）
- 如果数据**经常变动且 LLM 需要按需获取**，直接做成 Tool 更合适
