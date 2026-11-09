---
order: 21
title: Poolboy：借出式工作池
description: 上一个版本的工作池按 key 路由固定 worker；Poolboy 换一个思路，有限资源，用完就还。
part: 4
duration: 20
topics: [Poolboy, transaction, checkout/checkin, 借出式并发, child_spec]
samples:
  - {label: todo_poolboy·数据库路由, path: code_samples/ch11/todo_poolboy/lib/todo/database.ex}
  - {label: todo_poolboy·worker, path: code_samples/ch11/todo_poolboy/lib/todo/database_worker.ex}
  - {label: todo_poolboy·应用入口, path: code_samples/ch11/todo_poolboy/lib/todo/application.ex}
---

第 12 章的工作池按 key 哈希选固定 worker：`:erlang.phash2(key, 3)` 决定一个 key 永远去同一个 worker。`todo_poolboy` 项目换了思路，用 Poolboy 库管理一组通用 worker。这个池不关心"同 key 同 worker"，它只保证同时最多三个数据库操作。

## 依赖怎么进 mix.exs

`todo_poolboy` 的 `deps` 里多了一行：

```elixir
defp deps do
  [
    {:poolboy, "~> 1.5"},
    ...
  ]
end
```

每个依赖是一个 `{包名, 版本约束}` 元组。`~> 1.5` 允许 1.x 的最新补丁和小版本，不允许跳到 2.x。`mix deps.get` 按这个列表从 Hex 拉代码，`mix deps.tree` 能看到间接依赖。写完 `deps` 之后跑一次 `deps.get`，编译产物才会出现在 `_build` 里，`iex -S mix` 才能加载到。

## Todo.Database 不再自己 GenServer

`Todo.Database` 的 `child_spec` 换了写法，返回的不是自己的监督规格，是 Poolboy 的：

```elixir
def child_spec(_) do
  File.mkdir_p!(@db_folder)

  :poolboy.child_spec(
    __MODULE__,
    [
      name: {:local, __MODULE__},
      worker_module: Todo.DatabaseWorker,
      size: 3
    ],
    [@db_folder]
  )
end
```

`__MODULE__` 是池的注册名（`Todo.Database`），`worker_module` 是干活用的模块，`size: 3` 是池里 worker 的数量。`[@db_folder]` 是传给 `Todo.DatabaseWorker.start_link/1` 的参数。监督者启动这个 child 时，Poolboy 自己拉起 3 个 worker，名字登记在 `Todo.Database` 下。

## transaction：借一个，用完还

调用方不再和 `Todo.Database` 的进程通信，改成向池借一个 worker：

```elixir
def store(key, data) do
  :poolboy.transaction(
    __MODULE__,
    fn worker_pid -> Todo.DatabaseWorker.store(worker_pid, key, data) end
  )
end
```

`transaction` 期间独占一个 worker，匿名函数返回就归还。底层是两个动作：`:poolboy.checkout` 从池里拿一个 PID，`:poolboy.checkin` 用完还回去；`transaction` 只是包了个壳，帮你在异常时也保证归还。

worker 每次拿到的 key 可能不同。这个池只保证"同时最多三个"，不保证"同 key 同 worker"。顺序来自调用者自己：如果同一个 key 的两次写操作真的需要有序，靠的不是池，是调用者的调用顺序。

## 两种池模型的差别

| 模型 | 保证 | 适合 |
| --- | --- | --- |
| `phash2` 固定路由 | 同 key 请求落到同 worker，顺序可控 | 同一清单的读写必须串行 |
| Poolboy 借用 | 同时使用的资源数量有上限 | 限制对有限资源（磁盘、外部连接）的并发 |

配套示例里 `store` 用 `cast`、`get` 用 `call`，transaction 的匿名函数发出消息就返回，worker 随即归还，消息处理和归还之间没有同步。所以"借了又还"不等于"写盘已完成"。第 24 章会把这个差距继续放大。

## 动手验证

```sh
cd code_samples/ch11/todo_poolboy
mix deps.get
iex -S mix
```

```elixir
iex> Todo.Database.store("alice", %{entries: []})
:ok
iex> Todo.Database.get("alice")
%{entries: []}
```

`store` 和 `get` 都是 `transaction` 的形式，每次调用借一个 worker，跑完归还。IEx 里 `Process.registered` 能查到 `Todo.Database` 这个名字，但它指向的是 Poolboy 池进程，不是某一个 worker。

**练习**：对比 `todo_poolboy` 和第 12 章 `pool_supervision` 的 `Todo.Database`，列出两个版本各自的"保证"和"代价"。如果产品要求同一清单的写严格有序，哪个模型更合适？能不能在 Poolboy 上自己加回去？
