---
order: 12
title: 把进程连成系统
description: 用 Mix 组织项目，让多个 Todo 服务共享缓存与持久化能力，再从单进程瓶颈推导出工作池。
part: 2
duration: 40
topics: [缓存, 持久化, 工作池, 名字解析, term_to_binary]
samples:
  - { label: 'todo·清单服务', path: code_samples/ch07/todo/lib/todo/server.ex }
  - { label: 'todo_cache·缓存', path: code_samples/ch07/todo_cache/lib/todo/cache.ex }
  - { label: 'persistable_todo_cache·缓存', path: code_samples/ch07/persistable_todo_cache/lib/todo/cache.ex }
  - { label: 'persistable_todo_cache·数据库', path: code_samples/ch07/persistable_todo_cache/lib/todo/database.ex }
  - { label: 'todo_cache_pooling·数据库', path: code_samples/ch07/todo_cache_pooling/lib/todo/database.ex }
  - { label: 'todo_cache_pooling·数据库 worker', path: code_samples/ch07/todo_cache_pooling/lib/todo/database_worker.ex }
---

一个服务进程能保管一份清单，但真正的应用要管很多份。我们还希望：按名字找到某份清单、重启之后继续读数据、不同清单的磁盘操作别全挤在一个队列里。

上一章认识了 Mix 的结构，这一章在同一套骨架里加新进程。配套示例里有四个项目是递进的快照，阅读顺序可以沿着这条线走，但别混着编译，它们都自称 `:todo`。

## 四个项目的关系

| 项目 | 相比上一个加了什么 | 关键问题 |
| --- | --- | --- |
| `todo` | 把第 6-9 章的 TodoList + TodoServer 搬进 Mix 结构 | 一份清单一个进程，多份靠多次启动 |
| `todo_cache` | 加 `Todo.Cache`：名字到 PID 的映射，第一次请求时建服务 | 同名清单怎么只建一次 |
| `persistable_todo_cache` | 加 `Todo.Database`：新增条目时落盘到 `./persist` | 进程退出后数据怎么还在 |
| `todo_cache_pooling` | 把数据库拆成 3 个 `Todo.DatabaseWorker`，按 key 路由 | 磁盘 IO 怎么不串行排队 |

## 四个项目都沿用同一套目录结构

上一章看过 `mix.exs`、 `lib/`、`test/` 的布局。这里四个项目共用同一结构，但每个都在 `lib/todo/` 里加了新模块，对应功能表里的那一步。这个阶段还没有应用自动启动树：`iex -S mix` 加载完代码后，仍要按当前版本的 API 手动启动系统入口。

## 每一份清单有自己的进程

`Todo.Cache` 维护"清单名字到 PID"的映射。第一次请求某个名字时创建 `Todo.Server`；之后再请求同名清单，就返回已经存在的进程。

```elixir
def handle_call({:server_process, todo_list_name}, _, todo_servers) do
  case Map.fetch(todo_servers, todo_list_name) do
    {:ok, todo_server} ->
      {:reply, todo_server, todo_servers}

    :error ->
      {:ok, new_server} = Todo.Server.start()
      {:reply, new_server, Map.put(todo_servers, todo_list_name, new_server)}
  end
end
```

`handle_call` 里是个"查表 + 缺了才建"的分支。`Map.fetch` 返回 `{:ok, pid}` 就是已有清单，把 PID 回给调用者、状态原样；`:error` 是这个名字还没建过，于是 `Todo.Server.start()` 起一个新进程，`Map.put` 把 `名字 => PID` 记进 `todo_servers` 这张 map，再回复。这张 map 就是缓存的状态：进程退出就丢，重启后每张清单都得重新"认领"一次。

这让一个进程对应一份独立业务状态：同一份清单的修改串行执行，不同清单可以分别跑。这个边界比"所有请求共用一个服务器"更贴近问题本身。

注意 `server_process` 是 `call`，两次请求同时进来时，第二个会排队，所以它看到的映射一定包含第一个刚建好的 PID。创建动作串行化是这里的一个隐含前提；如果哪天把 `server_process` 改成 `cast` 或者放到多个进程里跑，同名清单就可能被建两次。第 15 章的 `already_started` 分支，处理的就是竞态没有被完全消除的版本。

`persistable_todo_cache` 的入口是 `Todo.Cache.start/0` 和 `Todo.Cache.server_process(cache_pid, name)`，要显式传缓存 PID。后面的章节会调整接口，别跨版本混用。

```elixir
iex> {:ok, cache} = Todo.Cache.start()
{:ok, #PID<0.112.0>}
iex> alice = Todo.Cache.server_process(cache, "alice")
#PID<0.114.0>
iex> alice == Todo.Cache.server_process(cache, "alice")
true
```

第二行拿到的是新进程 PID，名字 `"alice"` 第一次出现，缓存里还没有。第三行再要一次同名清单，缓存查表返回的还是同一个 PID，`==` 得 `true`。

## 文件让数据跨过进程生命周期

`Todo.Database` 把 Elixir 项转成二进制，写进 `./persist` 下的文件；读取时反向转换。`Todo.Server` 启动时按清单名取数据，取不到就建新的。

```elixir
def handle_cast({:store, key, data}, state) do
  target = file_name(key)
  File.write!(target <> ".tmp", :erlang.term_to_binary(data))
  File.rename!(target <> ".tmp", target)

  {:noreply, state}
end

def handle_call({:get, key}, _, state) do
  data =
    case File.read(file_name(key)) do
      {:ok, ""} -> nil
      {:ok, contents} -> :erlang.binary_to_term(contents)
      _ -> nil
    end

  {:reply, data, state}
end
```

写入是 `cast`，发完不等确认：`term_to_binary` 把任意 Elixir 项（map、struct、tuple 都行）压成一段二进制，`file_name` 算出 `./persist/<key>` 的路径。写分两步：先写 `<key>.tmp`，再 `File.rename!` 原子地换到正式文件名，worker 中途死掉，读者看到的要么是旧文件要么是新文件，不会是一半内容或空文件。读取是 `call`，因为调用者要拿数据：`File.read` 成功就把二进制还原回 Elixir 项（`binary_to_term`），文件不存在、读不到、或是个空文件（上一次写失败留下的残骸）都给 `nil`。注意这个实现里，"键不存在"和"键存在但值是 nil"是同一种结果。

这里要分清两个生命周期：进程里的当前值，和磁盘上最近一次保存的值。进程退出会丢掉内存，但已经写好的文件还在。缓存那张 map 也一样：进程一死，`"alice" => PID` 的映射就没了。名字到 PID 的映射属于易失状态，但 `./persist` 里的数据属于持久状态，两者各归各的死法。

文件路径以项目运行时的工作目录为基础。换个目录运行，就会得到另一份 `persist`，数据并没有神秘消失。

示例只适合可信的本地数据：没有事务、没有路径校验、没有版本迁移，也别把来自不可信来源的二进制直接交给 `binary_to_term` 解码。

服务器一侧的接法在两处回调里：

```elixir
def init(name) do
  {:ok, {name, nil}, {:continue, :init}}
end

def handle_continue(:init, {name, nil}) do
  todo_list = Todo.Database.get(name) || Todo.List.new()
  {:noreply, {name, todo_list}}
end

def handle_cast({:add_entry, new_entry}, {name, todo_list}) do
  new_list = Todo.List.add_entry(todo_list, new_entry)
  Todo.Database.store(name, new_list)
  {:noreply, {name, new_list}}
end
```

状态从上一版的 `todo_list` 变成了二元组 `{name, todo_list}`，进程现在同时记得"我是谁"和"我装着什么"。`init` 返回 `{:ok, {name, nil}, {:continue, :init}}`，三元组的第三项 `{:continue, :init}` 是 OTP 的延后指令：`init` 先返回让进程跑起来，紧接着 OTP 会调 `handle_continue(:init, ...)`。磁盘读取放在这里做，是因为 `init` 阻塞会卡住 `start` 的调用方；把慢的初始化推给 `handle_continue`，就不挡启动。

`handle_continue` 里 `Todo.Database.get(name) || Todo.List.new()`：磁盘上有旧数据就用它，没有（`nil`）就新建空清单，`||` 取第一个非 `nil`/`false` 的值。`handle_cast` 每次新增完都顺手 `Todo.Database.store(name, new_list)` 落一份，写路径是异步 cast，读路径在启动时一次读完。

## 一个数据库进程会成为队列

最简单的 `Todo.Database` 在一个 GenServer 里读写文件。就算有一百个 `Todo.Server`，磁盘请求还是经过同一个数据库进程，逐条处理。

`todo_cache_pooling` 把文件工作分给三个 `Todo.DatabaseWorker`。`Todo.Database.init` 里用 `for` 一口气起三个 worker、把 `0 => pid`、`1 => pid`、`2 => pid` 存成 map；路由只需要一步：

```elixir
:erlang.phash2(key, 3)
```

`phash2` 给任意 Elixir 项算一个哈希值，第二个参数是取模上限，`phash2("alice", 3)` 永远给出 `0`、`1` 或 `2` 里的同一个数。哈希一致，同一个 key 就总落到同一个工作进程，同一份文件的操作仍然有序；不同 key 落到不同 worker，磁盘 IO 才有机会真的并行。

这不是轮询调度，也不保证负载均匀：一个热门清单占了大部分流量，它所在的工作进程照样很忙。分区解决的是"别把所有请求挤在一个队列里"，不是"流量自动摊平"。

## 路由也可能有成本

本章的 `choose_worker/1` 还要同步问数据库协调进程拿 worker PID，拿到后调用者才直接和 worker 通信。文件操作移出协调进程减轻了它的负担，但路由查询仍然经过它。

第 15 章会改进这个结构：worker 用 `{模块, worker_id}` 在 Registry 里注册稳定名字，路由算出编号后直接按名字发消息，不再依赖 PID 查找。这也是为什么第 10 章的名字机制值得单独拿出来讲。

另外，异步写入只是把请求发出去。"请求已排队"不能解释成"数据已持久化"；跨进程读写时，要检查顺序来自谁的保证。

## 动手验证

进入 `persistable_todo_cache` 项目目录，跑 `mix deps.get` 和 `iex -S mix`。启动缓存，建一份名字好认的清单，加条目后查询，再到项目目录下看 `persist` 里的文件。

退出 IEx，重新启动项目和缓存，查同名清单。这个实验能说明写完的文件可以重新加载，但不能证明任意时刻崩溃都不丢数据。

**练习**：画出一次新增请求经过的模块和进程，普通函数调用画实线，跨进程消息画虚线。再在图上标出：如果 Cache 退出、`Todo.Server` 退出、`DatabaseWorker` 退出，分别由谁处理？目前的答案并不完整，第 13 章就从这里开始。
