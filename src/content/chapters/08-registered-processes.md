---
order: 8
title: 给进程起名字
description: 从传 PID 到注册名字。比较 atom 注册、Registry 和两种手写注册表的实现代价。
part: 2
duration: 28
topics: [Process.register, Registry, via, ETS, 名字解析, trap_exit]
samples:
  - { label: '注册名字的清单服务器', path: code_samples/ch05/registered_todo_server.ex }
  - { label: 'GenServer 注册表', path: code_samples/ch10/process_registry/gen_server.ex }
  - { label: 'ETS 注册表', path: code_samples/ch10/process_registry/ets.ex }
---

到目前为止，调用 `TodoServer.entries/2` 都得带着 PID。PID 是唯一但临时的标识：进程一重启就换，调用者得跟着换，跨节点时更是没法记。

给进程一个稳定的名字，调用方就不用关心后面是谁在跑。

## 先把 PID 换成 atom

`registered_todo_server.ex` 在 `start/0` 里多做了一步：

```elixir
spawn(fn ->
  Process.register(self(), :todo_server)
  loop(TodoList.new())
end)
```

`Process.register(self(), :todo_server)` 把当前进程的 PID 和 atom `:todo_server` 绑进 VM 的全局名字表。登记完，任何进程拿这个 atom 就能发消息，不需要先知道 PID。这一步必须在新进程里做（`spawn` 的 `fn` 里调 `self()` 拿到的才是新进程的 PID）。

客户端 API 跟着变了——参数列表里没有 PID 了：

```elixir
def add_entry(new_entry) do
  send(:todo_server, {:add_entry, new_entry})
end

def entries(date) do
  send(:todo_server, {:entries, self(), date})

  receive do
    {:todo_entries, entries} -> entries
  after
    5000 -> {:error, :timeout}
  end
end
```

`send(:todo_server, ...)` 的第一个参数直接写 atom：发送时 VM 拿 atom 去名字表里查出当前绑定的 PID 再投递，查不到就抛 `ArgumentError`。`entries/1` 除了 `self()` 带回程票，和上一版一模一样；变化只在"怎么找到服务器"。

`Process.whereis(:todo_server)` 是反查：atom 进、PID 出，没注册返回 `nil`。`Process.registered()` 列出当前节点所有已注册名字。

代价也直接：名字是 atom，全 VM 一张表，**一个名字同一时刻只能绑定一个进程**。再 `Process.register(self(), :todo_server)` 会抛 `ArgumentError`。想跑两个清单服务，就得想别的命名办法。

另外，atom 表不回收。用 `String.to_atom("user_123")` 给每个用户动态起名，等于写了一张只进不出的表——动态名字要走 `String.to_existing_atom`，或者干脆别用 atom。

## via 元组：把查名字交给注册表

OTP 不强迫你用 atom。`GenServer.start` 和 `call/cast` 都接受 `{:via, registry, {name, key}}` 这种形式：注册表 `name` 用 `key` 找到当前进程。

```elixir
{:via, Registry, {Todo.ProcessRegistry, "alice"}}
```

读这个三元组：`:via` 是固定标签，告诉 OTP"别直接找 PID，走注册表"；`Registry` 是注册表模块（Elixir 自带）；`{Todo.ProcessRegistry, "alice"}` 是"在哪个注册表里、用什么 key 查"——`Todo.ProcessRegistry` 是某个 Registry 进程自己的名字，`"alice"` 是这次要解析的业务 key。每次调用都现查一次，所以 key 可以是任意 Elixir 项，不限 atom。

`Registry` 是 Elixir 自带的本地注册表，本身也是一个 GenServer，底层表就是 ETS。启动时传 `keys: :unique` 保证一个 key 只对应一个进程（也有 `:duplicate` 模式允许一对多）。进程侧用 via 注册：

```elixir
GenServer.start_link(Todo.Server, "alice",
  name: {:via, Registry, {Todo.ProcessRegistry, "alice"}})
```

`name:` 参数告诉 OTP 启动成功后往哪儿登记。之后 `GenServer.call({:via, Registry, {Todo.ProcessRegistry, "alice"}}, ...)` 就能找到它——进程重启拿到新 PID，调用者无感。这就是第 9 章和第 11 章项目里"清单名 → 进程"的真正实现，这里先看它背后的机制。

## 自己写一个：GenServer 版注册表

`process_registry/gen_server.ex` 用一张 map 做注册表，`register` 和 `whereis` 都是同步 `call`：

```elixir
def handle_call({:register, key, pid}, _, process_registry) do
  case Map.get(process_registry, key) do
    nil ->
      Process.link(pid)
      {:reply, :ok, Map.put(process_registry, key, pid)}

    _ ->
      {:reply, :error, process_registry}
  end
end
```

这个回调跑的是"查重 + 占位"两步：key 还没被占（`Map.get` 返回 `nil`），先 `Process.link(pid)` 和新进程建链，再 `Map.put` 把 `key => pid` 塞进注册表，回 `:ok`；key 已存在就回 `:error`——不重试、不覆盖，一人一个名字。

关键在于垃圾回收。`init` 里有一行 `Process.flag(:trap_exit, true)`——默认情况下进程收到退出信号会跟着死，`trap_exit` 让信号变成一条普通消息 `{:EXIT, pid, reason}` 进邮箱。注册成功后 `Process.link(pid)` 建链，被注册进程一死，注册表就收到 `{:EXIT, pid, reason}`，`handle_info` 里把所有指向这个 PID 的条目删掉。不清理的话，名字会指向一个死进程——第 10 章会专门讨论这种"缓存里躺着死 PID"的事故。

`handle_info` 是第三个回调类型：`handle_call`/`handle_cast` 之外的"没走 GenServer 协议"的消息（退出信号、超时、`send` 直发的消息）都由它接住。`SimpleRegistry` 里它只匹配一种：

```elixir
def handle_info({:EXIT, pid, _reason}, process_registry) do
  {:noreply, deregister_pid(process_registry, pid)}
end
```

`deregister_pid` 扫整张 map，`Enum.reject` 删掉值等于这个 PID 的所有条目，重建一张干净的注册表。

这是个串行实现：所有注册和查询都排队过同一个进程。注册表本身成了瓶颈时，就得换数据结构。

## ETS 版：查询不进服务器邮箱

`process_registry/ets.ex` 把同样的职责搬进 ETS 表，读和写都可以绕过 GenServer 邮箱：

```elixir
def init(_) do
  Process.flag(:trap_exit, true)
  :ets.new(__MODULE__, [:named_table, :public, read_concurrency: true, write_concurrency: true])
  {:ok, nil}
end
```

`init` 里建表：`:ets.new/2` 创建一张 ETS 表，第一个参数是表名（直接用模块名），第二个参数是选项列表：`:named_table` 让表能用名字引用、`:public` 允许任何进程读写（不写 `:protected`）、两个 `*_concurrency` 是给 VM 的并发提示。ETS 是 VM 内置的内存键值表，不属于任何单个进程的状态——表挂在进程上，但访问不经过进程邮箱，这是它和 map 版本最大的区别。

```elixir
def register(key) do
  Process.link(Process.whereis(__MODULE__))

  if :ets.insert_new(__MODULE__, {key, self()}) do
    :ok
  else
    :error
  end
end

def whereis(key) do
  case :ets.lookup(__MODULE__, key) do
    [{^key, pid}] -> pid
    [] -> nil
  end
end
```

`register/1` 和 `whereis/1` 直接调 `:ets` 函数。注意没有 `GenServer.call`：查询在调用者自己的进程里完成，不进注册表服务器排队。`:ets.lookup` 返回的是"匹配的条目列表"（ETS 底层是多行表），所以匹配 `[{^key, pid}]`，`^key` pin 住传入的 key，`pid` 才是要取的部分。

两处细节值得盯住：

- `insert_new` 只在 key 不存在时插入，一步完成"查重 + 占位"，避免两个进程同时注册同一个名字的竞态；
- `register` 里先 `Process.link` 再插入——如果顺序反过来，一个进程可能注册成功但注册表不知道它的存在，死后留下孤儿条目。

清理还是走 `handle_info({:EXIT, pid, _})`——注册表服务器仍然开着 `trap_exit` 收退出消息，但删条目的方式换成了 `:ets.match_delete(__MODULE__, {:_, pid})`：按模式反查删除，`:_` 是"任意 key"，`pid` 是值的部分。

代价同样写在了源码注释里：这个版本没有处理"一个进程注册多个名字"的情况，unlink 逻辑也省略了——作者留了 Registry 官方实现的链接，说明这是教学版，不是完整版。

## 三个层级的取舍

| 方案 | 名字范围 | 查名字成本 | 主要坑 |
| --- | --- | --- | --- |
| `Process.register` + atom | 全 VM 唯一 | 直接发消息 | 一个名字一个进程；atom 不回收 |
| `Registry` + via | 全 VM，按 key | 每次调用查一次 ETS | 单节点；依赖 Registry 自身存活 |
| `:global` | 跨节点 | 跨节点同步 | 第 17 章专门讲 |

本地服务优先考虑 atom 或 `Registry`。只有确实要跨节点解析，才上 `:global`——下一章会再遇到它。

插一句背景，免得名字和职责混起来：这一章讲的是"怎么找到进程"，OTP 还内置了两种"进程本身是什么"的现成选择——`Task` 管一段一次性工作，`Agent` 管一份只被读写的状态。它们本质上都是包好的 GenServer，第 12 章会展开；注册和 `via` 对它们同样适用。

## 动手验证

```sh
iex -r registered_todo_server.ex
```

```elixir
iex> TodoServer.start()
#PID<0.112.0>
iex> Process.whereis(:todo_server)
#PID<0.112.0>
iex> TodoServer.add_entry(%{date: ~D[2026-11-09], title: "带名字的进程"})
:ok
iex> TodoServer.entries(~D[2026-11-09])
[%{date: ~D[2026-11-09], id: 1, title: "带名字的进程"}]
iex> TodoServer.start()
** (EXIT from #PID<0.109.0>) shell process exited with reason: {:already_registered, #PID<0.112.0>}
```

`TodoServer.start()` 返回的还是 PID，但 `whereis` 现在能拿名字反查回同一个 PID。`add_entry`/`entries` 的调用不再传 PID——名字在模块里写死了。第二次 `start` 直接撞死：`:already_registered` 就是"一个名字一个进程"的冲突，实验里三秒撞上。

`Process.registered()` 会列出当前节点所有已注册 atom——除了 `:todo_server`，你还能看到 `IEx` 自己的几个内置注册名。

**练习**：写一个测试同时 `spawn` 两个 `registered_todo_server.ex` 里的 `start/0`，观察第二个 `Process.register` 抛什么错。再想：如果注册表进程本身崩了（比如 `Process.exit(Process.whereis(:todo_server), :kill)`），`whereis` 会返回什么？名字和还存活的业务进程之间，谁来负责重建对应关系？这个问题会在第 11 章的监督结构里得到完整答案。
