---
order: 11
title: 设计一棵监督树
description: 把固定基础设施与动态业务进程分开，再用 Registry 给进程稳定的名字，让重启不再依赖旧 PID。
part: 3
duration: 40
topics: [监督树, Registry, DynamicSupervisor, child_spec, 重启策略]
samples:
  - { label: 'pool_supervision·系统入口', path: code_samples/ch09/pool_supervision/lib/todo/system.ex }
  - { label: 'pool_supervision·数据库', path: code_samples/ch09/pool_supervision/lib/todo/database.ex }
  - { label: 'pool_supervision·进程注册表', path: code_samples/ch09/pool_supervision/lib/todo/process_registry.ex }
  - { label: 'pool_supervision·数据库 worker', path: code_samples/ch09/pool_supervision/lib/todo/database_worker.ex }
  - { label: 'dynamic_workers·缓存', path: code_samples/ch09/dynamic_workers/lib/todo/cache.ex }
  - { label: 'dynamic_workers·清单服务', path: code_samples/ch09/dynamic_workers/lib/todo/server.ex }
---

上一章中，一部分恢复依靠链接传播到 Cache。它能工作，却可能让无关的清单一起重建。更精细的监督结构，应当让失败只影响真正需要一起恢复的部分。

本章从 `supervise_database` 走到 `pool_supervision`，最后进入 `dynamic_workers`。这些是演进阶段，不要把不同阶段的模块混装成一个项目。

## 区分固定子进程与动态子进程

Registry、数据库工作池，是系统启动时就知道需要的基础设施。用户清单的数量与名字，则要在运行时才能确定。

固定子进程适合放进普通 Supervisor 的启动列表。动态创建和删除的清单进程，适合由 DynamicSupervisor 管理。二者都参与监督，但建立子进程的时机不同。

把它们画成结构，可以更容易检查职责：

```text
Todo.System
├── Todo.ProcessRegistry
├── Todo.Database
│   ├── DatabaseWorker 1
│   ├── DatabaseWorker 2
│   └── DatabaseWorker 3
└── Todo.Cache
    ├── Todo.Server("alice")
    └── Todo.Server("bob")
```

这是后期动态版本的职责示意。第三个 `dynamic_workers` 项目中的 Cache 已经承担动态监督者的角色，而不是早期保存 PID 映射的普通 GenServer。

## child_spec 是启动说明书

监督者需要知道如何启动一个子进程，因此每个受监督组件都有 child specification——一张告诉监督者"怎么拉起这个进程"的 map。`dynamic_workers` 的 `Todo.Cache` 自定义了它：

```elixir
def child_spec(_arg) do
  %{
    id: __MODULE__,
    start: {__MODULE__, :start_link, []},
    type: :supervisor
  }
end
```

三个字段各管一件事。`id` 是监督者内部的标识，同一个父监督者里不能有重复 id；`start` 是 `{模块, 函数, 参数}` 三元组，告诉监督者"拉起我时调 `Todo.Cache.start_link()`"；`type: :supervisor` 标记这是棵子树的根而不是普通 worker，监督者区分它和普通子进程。还有个 `restart` 字段这里没写，默认 `:permanent`（死了就重启），后面小节专门展开。

通常 `use GenServer` 可以提供默认 `child_spec`——`start` 自动指向 `__MODULE__.start_link`，`id` 默认是模块名。当启动方式不同，模块就像上面这样自定义。

同一个父监督者中的子规格必须有不同的 `id`。数据库有多个相同模块的 worker，所以 `pool_supervision` 用 `Supervisor.child_spec` 将编号写入子规格：

```elixir
defp worker_spec(worker_id) do
  default_worker_spec = {Todo.DatabaseWorker, {@db_folder, worker_id}}
  Supervisor.child_spec(default_worker_spec, id: worker_id)
end
```

`{Todo.DatabaseWorker, {@db_folder, worker_id}}` 是 child_spec 的简写——模块名加上 `start_link` 要收的参数。`Supervisor.child_spec(..., id: worker_id)` 把 id 从默认的模块名换成 `1`/`2`/`3`，三个同模块的 worker 才各有身份。子规格里的 ID 属于监督结构，并不等于进程的注册名字，更不等于 PID。把这三个身份分开，很多疑问就消失了。

## 给进程一个可以重新解析的名字

数据库 worker 重启后会获得新 PID。如果调用者永久缓存旧 PID，监督者即使重建成功，请求仍然找错目标。

`Todo.ProcessRegistry` 自己就是一个包得很薄的模块，核心三行：

```elixir
def start_link do
  Registry.start_link(keys: :unique, name: __MODULE__)
end

def via_tuple(key) do
  {:via, Registry, {__MODULE__, key}}
end
```

`Registry.start_link` 启动一张本地注册表，`keys: :unique` 保证一个 key 同一时刻只对应一个进程——重复注册会被拒，这就是第 8 章手写 `insert_new` 的官方版。`via_tuple/1` 只是帮调用者拼出 `{:via, Registry, {Todo.ProcessRegistry, key}}` 这个三元组，让业务侧不用记格式。

`pool_supervision` 的数据库 worker 用 `{Todo.DatabaseWorker, worker_id}` 作为键——key 可以是任何项，这里用"模块 + 编号"拼出稳定标识。`start_link` 里 `name: via_tuple(worker_id)` 让 OTP 在启动成功后自动往注册表里登记。之后调用方只要知道 `worker_id`，`GenServer.call(via_tuple(worker_id), ...)` 就每次都现查当前 PID——worker 重启多少次调用者都不用改。

对应的，`choose_worker` 从"问协调进程要 PID"退化成一个纯函数：

```elixir
defp choose_worker(key) do
  :erlang.phash2(key, @pool_size) + 1
end
```

这就是第 9 章说的"路由也有成本"的解法：名字稳定之后，路由可以在调用者进程里算完，不用再同步过一道协调进程。

Registry 解决名字解析，不会替你监督目标，也不是跨节点注册表。它自身的恢复与依赖者的恢复关系同样需要设计——它是 `Todo.System` 的第一个子进程，早于所有依赖它的组件启动。

## 动态创建也要处理竞争

两个请求可能同时要求创建 `"alice"` 清单。仅仅先查询"是否存在"，再决定创建，并不能消除中间的竞争窗口。

`dynamic_workers` 的 Cache 本身就是 DynamicSupervisor——`start_link` 里 `DynamicSupervisor.start_link(name: __MODULE__, strategy: :one_for_one)`，注册表式地把自己名字登记成 `Todo.Cache`。每次 `server_process` 都直接启动子进程：

```elixir
DynamicSupervisor.start_child(__MODULE__, {Todo.Server, todo_list_name})
```

`start_child/2` 的两个参数：第一个是 DynamicSupervisor（这里用注册名 `__MODULE__` 代替 PID），第二个是 child_spec 简写 `{Todo.Server, todo_list_name}`——"按 `Todo.Server` 的说明书、拿这个名字当 `start_link` 参数去起"。和静态 Supervisor 的差别是：子进程不在启动列表里，而是每次调用才现场拉起。

`Todo.Server` 这边靠 via 注册唯一名字兜底。两个请求同时进来，两次 `start_child` 都会真的去 `GenServer.start_link`，但第二个在 `Process.register`/via 登记那一步撞上"key 已被占"——`start_link` 返回的不是 `{:ok, pid}`，而是 `{:error, {:already_started, pid}}`。所以 Cache 的 `server_process` 用 `case` 接住两种返回：

```elixir
case DynamicSupervisor.start_child(Todo.Cache, {Todo.Server, name}) do
  {:ok, pid} -> pid
  {:error, {:already_started, pid}} -> pid
end
```

两种结果返回的 `pid` 都是同一个进程——注册表保证了"同名只留一份"。唯一性约束落在启动动作本身（注册表拒绝重名），比调用者先查再建可靠得多：查和建之间没有窗口。

## temporary 是有意选择

`child_spec` 里的 `restart` 有三个值，先把它们摆齐再谈选择：

| 值 | 监督者的行为 |
| --- | --- |
| `:permanent` | 子进程一退出就重启（默认值） |
| `:temporary` | 从不重启 |
| `:transient` | 只在异常退出时重启，`{:stop, :normal}` 不重启 |

动态版本的 `Todo.Server` 写在 `use` 行上：

```elixir
use GenServer, restart: :temporary
```

`restart:` 选项透传给自动生成的 `child_spec`，告诉监督者"这个子进程死了别拉起来"。`:temporary` 意味着无论退出原因是什么，监督者都不立即重启它——不管是 `raise` 还是 `:normal`，死了就是死了。

这个选择和 DynamicSupervisor 的职责是对齐的：动态子进程的数量和名字由运行时决定，监督者只管"拉起来"这件事，不背"随时保持 N 个存活"的职责。恢复靠另一条路——下次请求同名清单时，`server_process` 再走 `start_child`，重新创建进程，再从文件加载清单。这是按需恢复，不是立即恢复。

进程是可以重建的运行载体，持久数据才是恢复的依据。所以下一章的空闲过期才说得通：不活跃的清单没有必要永远占着一个进程。

重试也不是无限的。监督者带 `max_restarts`（默认 3）和 `max_seconds`（默认 5）：窗口内重启超过上限，监督者自己也退出，把失败往上传。所以"监督者兜底"不等于死循环重试——第 10 章练习里那个持续崩溃的场景，最后就是整棵树倒下。

另外注意 `DynamicSupervisor` 只支持 `:one_for_one`：动态子进程数量不定，没法表达"一起重启"。想重启一组动态进程，得重新设计它们的归属，而不是指望策略。

## `init` 里别做慢活

`dynamic_workers` 的 `Todo.Server.init/1` 返回 `{:ok, {name, nil}, {:continue, :init}}`，真正的文件加载放在 `handle_continue/2` 里。

原因是 `start_link` 会阻塞到 `init` 返回。清单一多，启动期同步读盘会让"创建服务"这一步越来越慢——调用者在等，监督者也在等。`continue` 让进程先注册好名字、进入循环，再异步完成重活；慢的部分不再挡启动。

这是 `handle_continue` 的典型用法，也回应了第 7 章那句"`init` 成功才返回"的另一半代价。

## 动手验证

进入 `dynamic_workers` 项目目录，执行 `mix deps.get`、`mix test` 与 `iex -S mix`。手动启动：

```elixir
iex> {:ok, supervisor} = Todo.System.start_link()
{:ok, #PID<0.112.0>}
iex> first = Todo.Cache.server_process("alice")
#PID<0.118.0>
iex> first == Todo.Cache.server_process("alice")
true
iex> Process.exit(first, :kill)
true
iex> Todo.Cache.server_process("alice")
#PID<0.131.0>
```

同一个名字第二次解析，拿到的是同一个 PID——`start_child` 撞上 `already_started` 直接返回旧进程。`:kill` 杀掉它之后，再请求同名清单会拿到**新** PID——这次重建是被访问触发的，不是监督者主动拉起来的。

**练习**：用多个 Task 同时请求同名清单，把返回的 PID 放进 `MapSet`。在没有其他故障的情况下，应当只有一个唯一 PID。再想一想：如果 Registry 自身崩溃，名字与仍存活的业务进程之间会发生什么？选择监督策略时，要把这种依赖算进去。
