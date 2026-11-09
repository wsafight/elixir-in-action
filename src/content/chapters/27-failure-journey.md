---
order: 27
title: 失败路径，再走一遍
description: 同一个请求，每一跳都可能失败。把第 26 章的旅程反过来走一遍，看每一层的失败承诺兑现得怎么样。
part: 5
duration: 26
topics: [失败路径, 超时, 监督重启, 数据一致性, 卡住排查]
samples:
  - {label: 分布式·清单服务, path: code_samples/ch12/todo_distributed/lib/todo/server.ex}
  - {label: 分布式·数据库, path: code_samples/ch12/todo_distributed/lib/todo/database.ex}
  - {label: 分布式·worker, path: code_samples/ch12/todo_distributed/lib/todo/database_worker.ex}
  - {label: 运行时配置, path: code_samples/ch13/todo_release/config/runtime.exs}
---

上一章跟着 `POST /add_entry` 走了一遍成功路径。这一章反过来：假设每一跳都可能失败，看每一层的失败会发生什么、恢复到什么程度、什么丢了。这是 Part 3 所有概念的总验收，读完你应该能在任意一跳说出"它挂了会怎样"。

## 第一跳：Cowboy 连接进程挂了

请求刚进 `Todo.Web`，Cowboy 的连接进程在解析参数时抛异常，`Map.fetch!` 拿不到键、`Date.from_iso8601!` 拒了非法日期。连接进程是 Cowboy 自己的，每个请求一个，死了只影响这一次请求。HTTP 层不 retry，客户端收到 500。

这里的关键是：连接进程死了，Todo 系统完全不知道。`Todo.Cache` 的映射里不会留下这个死 PID，因为请求还没走到那一步。这是最简单的失败，边界上的失败被边界消化。

## 第二跳：Cache 挂了

`Todo.Cache` 是 DynamicSupervisor，挂了顶层监督者按 `one_for_one` 重启。正在处理的 `server_process` 调用失败，调用者拿到退出；已经在跑的清单进程不受影响，它们不归 Cache 管，归 `Todo.Server` 自己。

这里有个细节：Cache 的 DynamicSupervisor 状态本身也是易失的，它内部那张 `child_spec` 不记清单进程，清单进程死了 Cache 不知道。Cache 重启后 `server_process("alice")` 会重新 `start_child`，靠 via 注册撞到 `already_started` 拿到旧 PID。注册表（Registry）保住的是"名字 → 当前 PID"的映射，不是"哪些进程存在过"。

## 第三跳：清单进程挂了

`Todo.Server` 是 `restart: :temporary`，死了监督者不拉。下一次 `server_process` 触发 `start_child` 重建。重建时 `init` 里 `Todo.Database.get(name)` 从磁盘恢复最近一次落盘的状态。

失败窗口在这里：进程死掉和下一次 `server_process` 之间，那张清单不存在。请求打到中间这段空白，会拿到 `start_child` 重建后的新进程，`Todo.Database.get` 拉回旧数据，调用方看到的是"延迟后恢复"，不是"崩溃"。前提是 `Todo.Database` 的数据还完整。

## 第四跳：写磁盘的 worker 挂了

`Todo.Database` 的 `handle_call` 里 `store` 是 `cast`，发完就走。worker 挂了，`Todo.Database` 收到 `{:EXIT, ...}` 也跟着死，监督者重建子树。这次写入失败了，但失败在调用者拿到 `:ok` 之后，`cast` 的回复和"写完了"是两回事。清单进程状态已经更新，磁盘没落，重启后从磁盘恢复的是旧数据。这就是"异步写入的已确认幻觉"，系统告诉你 `:ok`，不是"已持久化"。

`get` 是 `call`，失败路径清晰一些：worker 挂了 `call` 超时或失败，调用者拿到的是明确的错误。

## 第五跳：磁盘挂了

`File.write!` 抛 `File.Error`，worker 回调崩溃，按上面的链路上溯。`File.rename!` 的原子性保证只覆盖"写完之前死了不留下半个文件"，不覆盖"磁盘满了写不进去"。这是兜底失效的一种：临时文件机制只在"写到了一半死"时有用，写之前就失败还是失败。

## 第六跳：跨节点挂了

`Todo.Cache.server_process` 找到的是远端 PID，`GenServer.call` 跨节点发出。节点断了，`call` 超时（默认 5s），调用者拿到 `{:exit, {:timeout, ...}}`。`:rpc.multicall` 发给所有节点的 `store_local`，坏节点只进 `bad_nodes` 日志，不影响本地 `:ok` 返回，数据在远端没写，本地告诉你成功了。

这是分布式特有的失败：调用者不知道对端是"没收到"还是"收到了没回"。`GenServer.call` 的超时返回并不区分这两种。

## 失败路径总表

| 跳 | 失败方 | 调用者看到 | 数据状态 | 恢复靠 |
| --- | --- | --- | --- | --- |
| 1. Web 路由 | Cowboy 进程 | 500 | 未进入系统 | Cowboy 重启连接进程 |
| 2. Cache | DynamicSupervisor | `call` 失败 | 清单进程不受影响 | 顶层监督者重启 Cache |
| 3. 清单进程 | `Todo.Server` | `call` 失败或超时 | 磁盘最近一次落盘 | 下次 `server_process` 重建 |
| 4. 写 worker | `DatabaseWorker` | `cast` 无感知 / `call` 失败 | 内存已更新，磁盘没落 | `Todo.Database` 子树重建 |
| 5. 磁盘 | `File` 层 | worker 崩溃 | `.tmp` 残留或部分写 | `File.rename!` 原子性挡一半 |
| 6. 跨节点 | 远端节点 | `call` 超时 | 远端没落盘 | 网络恢复后下次写重试 |

## 卡住的时候怎么办

失败之外还有一种常见状态：代码没报错，就是慢、就是不返回、就是结果不对。三个随手工具：

```elixir
iex> Process.whereis(Todo.Cache)        # 这个进程还在吗？
iex> Process.list() |> length()         # VM 里现在多少进程？
iex> Process.info(pid, :message_queue_len)  # 它的邮箱堆了多少？
```

`Process.whereis` 查注册名还在不在；`Process.info(pid, :message_queue_len)` 查邮箱长度，一个 GenServer 卡住时邮箱通常堆着没处理的消息；`self()` 告诉你"我是谁"，`Process.alive?(pid)` 告诉你"它还在不在"。`:observer.start()` 打开图形界面看监督树、进程列表、ETS 表，比 `Process.list` 直观，但需要桌面环境。

## 动手验证

在 `todo_distributed` 项目下两个节点连通后：

1. 杀掉 `Todo.Cache`，再请求同名清单，重建了吗？PID 变了吗？
2. `Process.exit` 一个 `DatabaseWorker`，再 `Process.whereis(Todo.Database)`，数据库重启了吗？
3. 手动 `Node.disconnect(:another_node)`，再 `add_entry`，超时多久？写入计数有没有差？

**练习**：给 26 章的七跳表加一列"失败后的数据一致性"，每一跳失败时，调用者拿到的响应和磁盘上的实际状态是否一致？哪些跳会产生"调用者以为成功、数据没落"的窗口？
