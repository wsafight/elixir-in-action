---
order: 14
title: 把数据库也监督起来
description: 监督树不能只罩住缓存。把数据库拉进列表，让它带的 worker 也一起被重建，失败的影响面从这一版才开始真正变小。
part: 3
duration: 24
topics: [监督范围, start_link 链式启动, worker 生命周期, 子树]
samples:
  - {label: supervise_database·系统入口, path: code_samples/ch09/supervise_database/lib/todo/system.ex}
  - {label: supervise_database·数据库, path: code_samples/ch09/supervise_database/lib/todo/database.ex}
  - {label: supervise_database·worker, path: code_samples/ch09/supervise_database/lib/todo/database_worker.ex}
  - {label: supervise_database·缓存, path: code_samples/ch09/supervise_database/lib/todo/cache.ex}
---

上一章 `supervised_todo_cache` 只监督了 `Todo.Cache`，数据库和 worker 还活在监督树外面，失败全靠链接传递。`supervise_database` 把这一步走完：`Todo.Database` 进了监督者的子进程列表，它内部的三个 worker 由 `start_link` 拉起。这一步的关键不是"多管了一个进程"，而是监督树开始成形成"子树"：子树内部的失败先被子树消化，不再往外传。

## 监督列表里的顺序

`Todo.System` 现在启动两个子进程：

```elixir
Supervisor.start_link(
  [Todo.Database, Todo.Cache],
  strategy: :one_for_one,
  name: __MODULE__
)
```

`Todo.Database` 排在前面不是随意：它是 `Todo.Cache` 的间接依赖，清单进程写数据要过它。`one_for_one` 策略下，数据库挂了只重启数据库，缓存不动；反过来缓存挂了，数据库也不受影响。"先启动数据库"这个顺序暗含"缓存起来时数据库应该已在"的依赖关系，监督者会按这个顺序拉起。

## start_link 让失败被圈在子树里

`Todo.Database` 的 `init` 里用 `start_link` 拉起三个 worker：

```elixir
defp start_workers() do
  for index <- 1..3, into: %{} do
    {:ok, pid} = Todo.DatabaseWorker.start_link(@db_folder)
    {index - 1, pid}
  end
end
```

`start_link` 让每个 worker 和 `Todo.Database` 建链。一个 worker 崩了，异常沿链接打到 `Todo.Database`，`Todo.Database` 没有开 `trap_exit`，会跟着死。这看起来是"失败传播"，但传播到 `Todo.Database` 就停了：监督者收到 `Todo.Database` 的退出信号，按 `one_for_one` 重启它，`init` 重新跑，三个 worker 重新拉起。

这就是"子树"的意思。worker 的死归 `Todo.Database` 管，`Todo.Database` 的死归顶层监督者管。失败在子树内部消化，不是像 `todo_links` 那样沿链接一直传出去拖死一大片。

`todo_links` 里那种"死一个拖一片"的粗暴传播没有了。失败被圈进 `Todo.Database` 子树，重启的代价是一个子树而不是整个系统。

## 清单进程还在监督树外面

`Todo.Server` 的创建仍然在 `Todo.Cache.server_process` 里动态发生，Cache 用 `start_link` 拉起它。但这次是"业务进程挂在缓存名下"，而不是"基础设施挂在监督者名下"。`Todo.Server` 挂了，Cache 会收到退出信号（它也链着），但 Cache 不会主动去重启它，重启靠下一次 `server_process` 同名请求触发。

这个版本是个中间态：基础设施（数据库、缓存）被监督者管住了，业务动态进程（清单）还没被独立监督。下一章会把这两者正式分开，固定部分归 Supervisor，动态部分归 DynamicSupervisor。

## 失败影响面对照

| 版本 | 数据库挂了 | worker 挂了 | 清单进程挂了 |
| --- | --- | --- | --- |
| `todo_links` | 链接传播到 Cache | 链接传播到 Database 再往上 | Cache 不管，死了就死了 |
| `supervised_todo_cache` | 不受监督，靠链接 | `start` 拉起，没有链接，死了没人知 | 同上 |
| `supervise_database` | 监督者重启 | `start_link` 传死 Database，监督者重建整个子树 | Cache 收到信号，重建靠下次请求 |
| `pool_supervision`（下一章） | 监督者重启 | 监督者直接按 `child_spec` 重启 | DynamicSupervisor 按 `:temporary` 规则处理 |

`supervise_database` 的关键变化是"worker 有人管了"。之前 `supervised_todo_cache` 里 worker 是 `start`（不建链），死了连个 `{:EXIT, ...}` 都没有，数据库根本不知道；现在 `start_link` 建链，死讯传到 `Todo.Database`，整个子树跟着重建。

## 动手验证

```sh
cd code_samples/ch09/supervise_database
mix deps.get
iex -S mix
```

```elixir
iex> {:ok, _} = Todo.System.start_link()
iex> db_pid = Process.whereis(Todo.Database)
iex> Process.exit(db_pid, :kill)
iex> Process.whereis(Todo.Database)
# 新 PID，监督者重启了它
```

再往深走，`Process.whereis` 查不到 `Todo.DatabaseWorker` 的注册名。它没有注册，PID 存在 `Todo.Database` 的状态里。手动杀一个 worker（先 `Process.list` 找出来），观察 `Todo.Database` 是否跟着死，体会 `start_link` 和 `start` 的差异。

**练习**：在 `iex` 里找到 `Todo.Database` 的 PID，杀掉，确认它重启。再想：`Todo.Cache` 里 `Todo.Server.start_link` 建的是 Cache ↔ 清单的链，清单挂了 Cache 会不会跟着死？这和 `Todo.Database` ↔ worker 的链有什么不同？
