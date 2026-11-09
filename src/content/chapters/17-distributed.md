---
order: 17
title: 当系统跨越一个节点
description: 连接两个 BEAM 节点，理解全局名字、跨节点写入与确认承诺。连得上只是起点，失败和一致性才是分布式的日常问题。
part: 4
duration: 32
topics: [节点, 分布式 Erlang, global, RPC, multicall]
samples:
  - {label: todo_distributed·清单服务, path: code_samples/ch12/todo_distributed/lib/todo/server.ex}
  - {label: todo_distributed·缓存, path: code_samples/ch12/todo_distributed/lib/todo/cache.ex}
  - {label: todo_distributed·数据库, path: code_samples/ch12/todo_distributed/lib/todo/database.ex}
  - {label: todo_distributed·worker, path: code_samples/ch12/todo_distributed/lib/todo/database_worker.ex}
  - {label: todo_distributed·运行时配置, path: code_samples/ch12/todo_distributed/config/runtime.exs}
  - {label: todo_distributed·系统入口, path: code_samples/ch12/todo_distributed/lib/todo/system.ex}
---

在单节点中，一个 PID 把许多通信细节藏了起来。跨节点之后，接口看起来差不多，故障却多了：目标可能崩溃，网络可能断开，回复可能迟到，节点可能只完成了部分工作。

本章的目标是看懂配套示例做了什么，以及它还没有承诺什么。

## 先让两个节点互相认识

进入 todo_distributed 项目，先执行一次 `mix deps.get`。在该目录打开两个终端，分别运行：

```sh
TODO_HTTP_PORT=5454 iex --sname todo1 --cookie todo-learning -S mix
```

```sh
TODO_HTTP_PORT=5456 iex --sname todo2 --cookie todo-learning -S mix
```

端口不同，避免两个应用争用同一个 HTTP 监听地址。节点名也必须不同。cookie 在这里作为本地实验的共享值，不应该照搬到对外暴露的环境。

启动参数逐个看：`--sname todo1` 给这个 BEAM 起短名字 `todo1@主机名`（`--name` 是长名字版本，用完整域名）；`--cookie todo-learning` 是两节点互认的暗号，cookie 不一致的节点连不上；`-S mix` 照旧启动应用。

在两个 IEx 中分别运行 `Node.self()`，记下第二个节点的完整名字。然后在第一个节点连接它：

```elixir
iex(todo1@your-host)1> Node.self()
:"todo1@your-host"
iex(todo1@your-host)2> Node.connect(:"todo2@your-host")
true
iex(todo1@your-host)3> Node.list()
[:"todo2@your-host"]
iex(todo1@your-host)4> Node.list([:this, :visible])
[:"todo1@your-host", :"todo2@your-host"]
```

注意 IEx 提示符本身变成了 `iex(todo1@your-host)`——节点名已经烙进提示符里。`Node.self()` 返回当前节点的完整名字；`Node.connect` 成功返回 `true`；`Node.list()` 只列"别的"已连接节点，不含自己。连接是自动传递的：A 连上 B，B 也就出现在 A 的 `Node.list()` 中。

请用 `Node.self()` 观察到的真实主机名替换 `your-host`。如果 `Node.connect` 返回 `false`，先检查三件事：两个节点的 cookie 是否完全一致；是否一个用了 `--sname` 而另一个用了 `--name`（短名字和长名字模式不能互通）；主机名是否解析得到。跨机器实验时，还要确认两个节点在同一网络里，防火墙没有挡住 Erlang 端口映射服务。

## 远端消息仍然经过进程

要在远端节点做点事，最直接的是 `Node.spawn_link`——指定节点名和一个函数，它先连上那个节点，再让对方跑这个函数，返回一个挂在远端节点上的 PID：

```elixir
pid = Node.spawn_link(:"todo2@your-host", fn -> IO.puts("hi") end)
send(pid, :some_message)
```

`Node.spawn_link` 返回的 PID 挂在远端节点上，`node(pid)` 能看到它属于哪个节点。它适合做实验，不适合做正式通信——`spawn_link` 出来的进程不归任何监督者管，link 跨了节点也只能在"整个远端节点死掉"时通知你。

另一个更常用的工具是 `:rpc.call`：在远端节点执行一个函数并把结果带回来，相当于一次同步的远程函数调用：

```elixir
iex(todo1@your-host)> :rpc.call(:"todo2@your-host", Node, :self, [])
:"todo2@your-host"
iex(todo1@your-host)> :rpc.call(:"todo2@your-host", File, :cwd, [])
{:ok, "/path/to/todo_distributed"}
```

四个参数是节点、模块、函数、参数列表。远端节点执行 `Node.self()`，结果跨网络送回来。失败时返回 `{:badrpc, reason}` 而不是抛异常，调用方要自己分支处理。`Todo.Database.store` 用的 `:rpc.multicall` 是它的广播版，后面会看到。

更常规的路线是：进程在远端由监督树正常启动，本地只拿 PID 发消息。一旦拿到远端 PID，`send` 和 `GenServer.call` 的写法和本节点完全一样，只是多了一个网络跳数。

注册名字跨节点用 `:global`：`GenServer.start_link(__MODULE__, arg, name: {:global, {__MODULE__, name}})` 在整个连通集群里唯一。`:global.whereis_name/1` 从任意节点都能查回同一个 PID——它背后是一次集群范围的查找，比本地 `Process.whereis` 慢，但在"谁负责这个清单"这个问题上给出唯一答案。本示例的 Todo.Server 走的就是这条路——下一节看代码。

在连通的节点之间，`GenServer.call` 也能跨过节点边界。但网络传输、目标节点存活和调用超时，都会成为通信成本与失败来源。

本示例利用这个能力，让请求可以转发到清单所在的节点。它并没有自动完成公网服务发现、跨区域部署或网络分区恢复策略。

可以把分布式 Erlang 视为一套通信基础，而不是“加一个节点名就自动获得高可用”。

## global 名字解决谁负责清单

上一部分用本地 Registry 给 Todo.Server 起名，名字只在本节点有效。这一版本改为全局名字：

```elixir
defp global_name(name) do
  {:global, {__MODULE__, name}}
end
```

进程启动时通过 `GenServer.start_link(Todo.Server, name, name: global_name(name))` 注册，`whereis/1` 改用 `:global.whereis_name({__MODULE__, name})` 查找。在连通且名字传播完成的节点集合中，相同清单总能找到同一服务进程。

Cache 的查找逻辑值得逐行看：

```elixir
def server_process(todo_list_name) do
  existing_process(todo_list_name) || new_process(todo_list_name)
end

defp new_process(todo_list_name) do
  case DynamicSupervisor.start_child(__MODULE__, {Todo.Server, todo_list_name}) do
    {:ok, pid} -> pid
    {:error, {:already_started, pid}} -> pid
  end
end
```

先查全局名字，查不到就在本节点的 DynamicSupervisor 下启动。两个节点可能同时为 `"alice"` 走到 `start_child`，这时 global 注册表只让一个赢，另一个收到 `{:error, {:already_started, pid}}`，直接拿到赢家的 PID。换句话说，唯一性是在注册那一刻决定的，不是由调用者的提前检查保证的。

还要注意失败时的去向。`already_started` 返回的 PID 可能在远端节点，调用者拿到的是远端进程的引用，后续 `call` 要跨网络完成。

名字唯一性依赖当前连接关系和全局注册机制。网络分区、节点重新连接时的冲突处理，都需要另行理解。不要把名字服务当作业务数据的一致性协议。

## 写入路径改成了同步确认

这一版本的 `Todo.Server.add_entry/2` 改用 `GenServer.call`。回调里先计算新清单，再调用 `Todo.Database.store`，最后才回复 `:ok`：

```elixir
def handle_call({:add_entry, new_entry}, _, {name, todo_list}) do
  new_list = Todo.List.add_entry(todo_list, new_entry)
  Todo.Database.store(name, new_list)
  {:reply, :ok, {name, new_list}, expiry_idle_timeout()}
end
```

数据库 worker 的 `store` 也是同步 `call`，写文件用 `File.write!`，因此单个 worker 的确认比前几章的“已发出 cast”更靠近实际写入完成。

不过，系统级成功还得继续往外看。`Todo.Database.store/2` 的实现是：

```elixir
{_results, bad_nodes} =
  :rpc.multicall(
    __MODULE__,
    :store_local,
    [key, data],
    :timer.seconds(5)
  )

Enum.each(bad_nodes, &IO.puts("Store failed on node #{&1}"))
:ok
```

`:rpc.multicall` 向当前已知的所有节点调用 `store_local`，返回 `{results, bad_nodes}`。这段代码把 `results` 丢弃，只把失败的节点打印出来，然后无条件返回 `:ok`。也就是说：一个副本失败，只换来一行日志；所有副本都失败，调用者得到的仍然是 `:ok`。

因此，即使 API 回复成功，也不能推导出所有节点都持有同样的数据。确认链上最弱的承诺，决定了调用者实际获得的保证。

## 副本与恢复之间还有距离

数据库目录按节点名字前缀分开，这是 `child_spec/1` 里做的：

```elixir
[name_prefix, _] = "#{node()}" |> String.split("@")
db_folder = "#{Keyword.fetch!(db_settings, :db_folder)}/#{name_prefix}/"
```

`todo1@host` 写 `./persist/todo1/`，`todo2@host` 写 `./persist/todo2/`。同一台机器、同一项目目录可以起多个节点，文件不会混在一起。

但这也意味着节点名就是数据位置的一部分。换个名字启动节点，它会在新的前缀目录下找数据，旧前缀目录里的文件它看不见。

这个示例向连接中的节点广播存储请求，但没有自动为新加入或离线后恢复的节点补齐历史数据。节点重新上线后，它本地的文件可能落后。

它也没有实现写入冲突合并、版本检查、仲裁、事务或副本修复。教学代码的价值正在于此：把这些问题摊在足够小的范围里，便于逐个讨论。

## 动手验证

在两个节点连通后，从第一个节点请求 `Todo.Cache.server_process("alice")`，在第二个节点调用同样的函数。比较 `node(pid)`，观察服务实际运行在哪个节点。

再添加一条测试数据，观察每个节点对应的数据目录。随后停止一个节点，在另一个节点新增不同条目，再启动原节点。请不要预设它能自动补齐数据，而是检查实际文件与查询结果。

第二个实验：先用 `Todo.Cache.server_process("alice")` 让清单落在某个节点上，再在那个节点里 `Process.exit(pid, :kill)`。从另一节点查询 `"alice"`，观察新进程在哪个节点重建、数据是否从本节点的目录加载。

**练习**：列出三个不同的“成功”：请求已收到、负责清单的进程已更新、所有副本已持久化。然后在当前代码中，为每一个成功找出确认位置。找不到的承诺，就不能对调用者做出保证。

下一章把这套系统打包成 release，离开开发终端运行。
