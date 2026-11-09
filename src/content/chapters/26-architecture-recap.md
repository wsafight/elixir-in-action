---
order: 26
title: 回看整个系统
description: 把一次请求从 HTTP 到磁盘的旅程走一遍，再回头检查每一层做出的承诺。这是收束，也是下一章失败路径的起点。
part: 5
duration: 28
topics: [调用链, 同步边界, 失败路径, 进程归属, 开放问题]
samples:
  - {label: 分布式·HTTP 入口, path: code_samples/ch12/todo_distributed/lib/todo/web.ex}
  - {label: 分布式·缓存, path: code_samples/ch12/todo_distributed/lib/todo/cache.ex}
  - {label: 分布式·清单服务, path: code_samples/ch12/todo_distributed/lib/todo/server.ex}
  - {label: 分布式·数据库, path: code_samples/ch12/todo_distributed/lib/todo/database.ex}
  - {label: 分布式·worker, path: code_samples/ch12/todo_distributed/lib/todo/database_worker.ex}
  - {label: release·系统入口, path: code_samples/ch13/todo_release/lib/todo/system.ex}
---

前面二十五章各自讲了一个零件。这一章把它们串起来：问一个具体问题：`POST /add_entry` 之后，数据经过哪些进程、在哪些地方可能丢？再看这个系统还有哪些事没做。

## 一次请求的完整旅程

假设两个节点已连通，请求打在监听 `5454` 的节点上，发往 `POST /add_entry?list=alice&date=2026-11-09&title=Read`。按调用顺序，每一跳都是这样：

| 跳 | 在哪执行（模块 · 进程） | 做了什么 | 同步/异步 | 失败会怎样 |
| --- | --- | --- | --- | --- |
| 1. `Todo.Web` 路由 | `Todo.Web` · Cowboy 连接进程 | 解析 query params，`Map.fetch!`、`Date.from_iso8601!` | 同步（同一进程内） | 参数缺失或日期非法：异常，返回 500 |
| 2. `Todo.Cache.server_process("alice")` | `Todo.Cache` · Cowboy 连接进程 | 查 global 注册表，不存在则 `DynamicSupervisor.start_child` | 同步 | 启动失败：异常向上抛；已被创建：拿到 `already_started` 的 PID |
| 3. `Todo.Server.add_entry` | `Todo.Server` · **清单进程**（可能在远端节点） | `GenServer.call`，把 `{:add_entry, ...}` 发给清单进程 | 同步（默认 5s 超时） | 进程崩溃或超时：调用者退出，Cowboy 返回 500 |
| 4. `Todo.List.add_entry` | `Todo.List` · 清单进程内 | 纯函数，算出新的 `%Todo.List{}` | 同步（同一进程内） | 异常：回调崩溃，进程重启 |
| 5. `Todo.Database.store` | `Todo.Database` · 清单进程内 | `:rpc.multicall` 把 `store_local` 发到所有已知节点 | 同步（5s 超时） | `bad_nodes` 只打日志，不影响返回 `:ok` |
| 6. `store_local` → poolboy | `Todo.DatabaseWorker` · **借出的 worker 进程** | `Todo.DatabaseWorker.store` 是一个 `call`，借池执行 | 同步 `call` | worker 崩溃：这次借用的调用失败，回调异常 |
| 7. `File.write!` + `File.rename!` | `:file` · worker 进程内 | 写 `./persist/<node>/alice` | 同步 | 磁盘错误：异常向上，回调崩溃 |

数一遍进程边界：请求在 Cowboy 的连接进程里出生，跨进清单进程（第 3 跳），再跨进一个借出的 worker（第 6 跳），还可能跨节点（第 3、5 跳）。七跳里只有三次真正换了进程，其余只是函数调用。第 2 跳里，新建进程是被访问触发的：`Todo.Server` 配 `restart: :temporary`，监督者不会自动拉起退出的清单，只有下一次 `server_process` 才会重建它。第 3、5、6 跳都是同步 `call`，意味着一路上任何一环卡住，Cowboy 连接都在等，默认超时是 5 秒，不是 HTTP 层的某个时限。

这套链路可以在 IEx 里亲眼验证。两个节点连通后，在发起请求的节点：

```elixir
iex(todo1@your-host)> pid = Todo.Cache.server_process("alice")
#PID<18337.109.0>
iex(todo1@your-host)> node(pid)
:"todo2@your-host"
iex(todo1@your-host)> :global.whereis_name({Todo.Server, "alice"})
#PID<18337.109.0>
```

PID 前面的大于 0 的段号（`18337`）说明这是远端进程的引用，`node(pid)` 确认它活在 `todo2` 上：第 2、3 跳的两行代码，把这个进程从"不存在"变成"另一个节点上的活进程"，后续 `GenServer.call` 就跨过网络送达。`:global.whereis_name` 从发起节点也能查回同一个 PID，这就是 global 注册表在做的事。

再看状态在谁手里。清单只在 `Todo.Server` 的回调状态里，没有任何请求把它复制到别处。数据库文件是落盘副本，但 `store` 写完返回 `:ok`，只说明当前节点的 worker 尝试写了文件，`bad_nodes` 里的失败会被忽略。这意味着"写成功"的承诺，停在了每个节点自己的磁盘调用上，没有跨节点确认。

## 如果中间断掉呢

把链路上最常见的两种断法走一遍，比记住表更有用。

**清单进程在第 3 跳后崩溃**（比如在 `handle_call` 里抛了异常）：`GenServer.call` 的调用方，也就是 Cowboy 连接进程，收到 exit 信号一起退出，HTTP 返回 500。`restart: :temporary` 让监督者不拉起它；下一次 `server_process("alice")` 重建进程，`init`/`handle_continue` 从磁盘读回最近一次写成功（`File.write!` + `File.rename!`）的内容。崩溃前还没落盘的条目，永久丢了，这正是第 5-7 跳把 `store` 做成同步的原因：把"丢"的窗口压到最小，但消不掉。

**整个 `todo2` 节点下线**（网络断、机器关）：`:global.whereis_name` 查到的 PID 失效，挂在它上面的 `call` 直接 `:exit`。`server_process("alice")` 在 `todo1` 上重新创建进程，但新进程读的是 `todo1` 本地的 `./persist/todo1/alice` 目录，那是上一章"节点名前缀"决定的，文件可能落后或不存在。于是出现一种教科书级的分布式症状：**服务没断，数据回退了**。这正是为什么"还能查到"和"数据是最新的"是两件事。

这两段推演说明同一个道理：错误路径不是异常分支，是系统语义的一部分。读别人的 OTP 系统时，问"失败会怎样"比问"成功路径怎么写"更能看清设计。

## 全书做过的几个核心抉择

把前面章节的选择排在一起，它们其实回答同一组问题：

| 抉择 | 示例里选了什么 | 换一边会怎样 |
| --- | --- | --- |
| 状态隔离还是共享 | 每份清单一个进程 | 共享一张表会引来锁与同步问题，也少了失败边界 |
| `call` 还是 `cast` | add_entry 用 `call` | 用 `cast` 更快返回，但"写入完成"没有确认点 |
| Registry 还是 global | global 名字 | 本地 Registry 只对本节点唯一，跨节点会重复创建 |
| 重启策略 | `:temporary` + 按需重建 | `:permanent` 重启更积极，但空闲清单会一直占着进程 |
| 固定路由还是借用池 | `phash2` 固定分到 worker | poolboy 借用池限制并发，但同一 key 不保证同一 worker |
| 进程还是 ETS | 进程持有状态 | ETS 读写更快，但表的拥有者一退出数据就没了 |

没有哪一边天然正确。第 17 章的 `Bench` 跑过同一数据的两种实现，进程版的吞吐并不总是输，选型依赖访问模式，不是教条。

## 这本书没教什么

这份代码停在"能跑、能讲清楚"的程度，下面这些缺口都有意留着，每条一句话，知道自己在缺什么比假装不缺重要得多：

- **副本一致性**：`store` 只管广播，不管写没写成功、几个副本同意，真正的一致性要协议来保障，不是靠"多发几次"。
- **仲裁**：两个节点同时认领 `"alice"` 时谁来当唯一权威，需要多数派或单主决策，示例靠 `:global` 的运气。
- **冲突合并**：两个节点同时改同一清单，后写的覆盖先写的，没有版本号也没有合并策略。
- **补齐历史数据**：离线节点重新上线后落后，需要有人主动追平。
- **备份与恢复**：文件只是持久化，不是备份；备份要能复制到别的存储上，并且真正恢复过一次才算数。
- **限流与超时分层**：所有 `call` 都是默认 5s 超时，没有按调用类型区分，也没有入口限流。
- **热更新**：`mix release` 生成的 release 支持 `:relup` 升级路径（不重启换代码），但示例没走到那一步。
- **集群的认证与加密**：`--cookie` 只是本地实验的共享值，跨公网部署需要证书、TLS 或更严格的网络隔离。
- **持久化格式演进**：文件里是 `:erlang.term_to_binary` 的字节，结构变了就要考虑兼容与迁移。

每一条都是一个可以继续追的方向。开源世界里的 Phoenix、Mnesia、libcluster、Ra 分别在不同的方向上给出了更完整的答案。

## 交付清单

如果你要把这个系统交给别人维护，下面几行每一项都应该有明确的答案：

```text
[ ] 从空目录 clone 到 release 能跑，不需要口口相传的依赖
[ ] 数据目录有独立卷/目录，不在发布目录里
[ ] 新增、查询、重启后数据恢复，各验证过一次
[ ] mix test 在 CI 或本机能过
[ ] 环境变量有默认值也有文档
[ ] 节点名、cookie、端口的来历写得清楚
[ ] 第二个人能不看聊天记录把系统跑起来
```

`[ ]` 里的每一项都是这条主线上的检查点，不是附加题。

**最后一个练习**：打开 todo_release 里的 `web.ex`，从 `post "/add_entry"` 一路追到 `database_worker.ex` 的 `File.write!`，数清楚经过了几次进程边界、哪几步可以失败。然后把结果对着本章开头那张调用链表核对一遍，如果某个环节你说不清失败会怎样，回到对应章节再看一次。

到这里，书读完了。接下来去读你最感兴趣的那段源码，把它讲给别人听。
