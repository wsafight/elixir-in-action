---
order: 16
title: 进程之外，还有这些工具
description: 比较 Task、Agent、ETS 与空闲回收。工具的选择应当来自状态、吞吐和生命周期，而不是代码行数。
part: 3
duration: 38
topics: [Task, Agent, ETS, insert_new, 超时, handle_continue, 运行指标]
samples:
  - {label: 进程版 KV, path: code_samples/ch10/key_value/lib/key_value.ex}
  - {label: ETS KV 实现, path: code_samples/ch10/key_value/lib/ets_key_value.ex}
  - {label: 并发压测器, path: code_samples/ch10/key_value/lib/bench.ex}
  - {label: 指标采集循环, path: code_samples/ch10/todo_metrics/lib/todo/metrics.ex}
  - {label: 空闲过期清单服务, path: code_samples/ch10/todo_cache_expiry/lib/todo/server.ex}
  - {label: Agent 版清单服务, path: code_samples/ch10/todo_agent/lib/todo/server.ex}
  - {label: ETS 注册表, path: code_samples/ch10/process_registry/ets.ex}
---

GenServer 是重要的基础，但不是所有问题都需要手写一组回调。本章的几个项目分别探索更具体的工具：一次任务、一个状态容器、一张共享表，以及进程何时应该结束。

## Task 把一段工作放进进程

先在 IEx 里看最小的用法：`Task.async` 起一个进程去算，`Task.await` 等它把结果送回来：

```elixir
iex> task = Task.async(fn -> Enum.sum(1..1000) end)
%Task{owner: #PID<0.105.0>, pid: #PID<0.118.0>, ref: #Reference<0.0.0.153>}
iex> Task.await(task)
500500
```

`Task.async` 返回一个 `%Task{}` 结构，三个字段分别是发起者 PID、任务进程 PID、消息的关联引用。`Task.await` 默认等 5000 毫秒，超时会抛异常并带走当前进程；传 `:infinity` 表示无限等。任务进程和发起者之间有链接，任务崩溃也会让发起者退出，这也是 Task 适合放监督树下的原因。

`todo_metrics` 的 `Todo.Metrics` 用 Task 干的是另一种活：不是"算一次拿回结果"，而是"一直跑"：

```elixir
defmodule Todo.Metrics do
  use Task

  def start_link(_arg) do
    Task.start_link(&loop/0)
  end
end
```

`use Task` 提供了 child_spec，所以 `Todo.Metrics` 可以直接写进监督树的子进程列表。`Task.start_link` 把新进程链到调用者（监督者）身上，它崩溃会被当作子进程失败处理。`loop/0` 先睡十秒，收集 `:erlang.memory(:total)` 和进程数，`IO.inspect` 之后递归调用自己，这个 Task 永远不返回。

两种用法的差别记住一句话就够：要结果用 `async/await`，要常驻用 `start_link` 进监督树。

周期性指标的价值不在单个数字，而在趋势：持续上涨的进程数、邮箱长度或内存，才可能暴露生命周期和排队问题。当前示例只把两个数字打印到终端，没有存储，没有告警，也没有区分哪些进程在涨。它展示的是“在哪里采集数据”，不是一套监控方案。

## Agent 适合围绕一个状态做变换

`todo_agent` 把 Todo.Server 改成 Agent。Agent 就是一个"包着 GenServer 的状态容器"：进程里存一个值，所有操作都是"给我函数，我把它应用到状态上"。

```elixir
def entries(todo_server, date) do
  Agent.get(todo_server, fn {_name, todo_list} ->
    Todo.List.entries(todo_list, date)
  end)
end
```

传进 `Agent.get` 的匿名函数接收当前状态 `{name, todo_list}`，返回的 `Todo.List.entries(...)` 就是调用者拿到的结果，状态本身没变。和它配套的两个操作：

- `Agent.update(pid, fn state -> new_state end)`：用新状态替换旧状态，返回 `:ok`，调用者等函数跑完
- `Agent.cast(pid, fn state -> new_state end)`：同一件事，但消息发完调用者就走，不等

`add_entry` 在示例里用 `cast`：把 `Todo.List.add_entry` 的结果塞回状态，顺手把 `Todo.Database.store` 也调了。对比第 9 章的 GenServer 版本：消息元组、`handle_call`/`handle_cast` 回调、回复元组都不见了，只剩一个直接变换状态的匿名函数。

代码更短，但关键语义并没有消失。Agent 仍然是一个串行处理状态操作的进程，传给 `get`/`cast`/`update` 的函数都在 Agent 进程内执行。配套示例把 `Todo.Database.store` 直接放进了 `add_entry` 的 cast 里：文件写入期间，这份清单的所有其他操作都得排队。写法简化了，阻塞模型没有变。

当通信协议、生命周期、超时处理或消息种类变复杂时，GenServer 的显式回调通常更好表达。选 Agent 的理由不该只是它省了几行。

## ETS 让访问避开单个服务器邮箱

`key_value` 项目里有两个对照实现。`KeyValue` 是普通的 GenServer 键值存储，`put` 走 cast、`get` 走 call，所有操作都排进同一个邮箱。`EtsKeyValue` 同样用 GenServer 启动，但 `put/2` 和 `get/1` 直接操作表：

```elixir
:ets.insert(EtsKeyValue, {key, value})
:ets.lookup(EtsKeyValue, key)
```

表在 `init` 里由 `:ets.new` 创建，标记为 `:named_table` 和 `:public`：

```elixir
:ets.new(__MODULE__, [:named_table, :public, write_concurrency: true])
```

`:named_table` 让表可以按名字（这里是模块名 `EtsKeyValue`）访问，不用记标识符；`:public` 放开读写权限；`write_concurrency` 优化并发写。

这把两种职责分开了：GenServer 只管创建表和它的生命周期，多个调用进程直接执行数据操作，请求不再经过服务器邮箱排队。`:public` 允许任何进程访问这张表，也把“谁能写、写什么”的约束交给了 API 和调用者的纪律。

## 表的类型和常用操作

ETS 表的类型在建表时定死，四种：

- `:set`（默认）：一键一值，键唯一
- `:ordered_set`：同上，但键按 Erlang 项序排好，可以范围遍历
- `:bag`：一键可挂多个对象，同一对象不重复
- `:duplicate_bag`：一键可挂多个对象，允许重复

Todo 项目用到的都是 `:set`：一个清单名对一个值，重复键没意义。在 IEx 里过一遍最常用的四个操作：

```elixir
iex> table = :ets.new(:demo, [:set, :public])
#Reference<0.0.0.101>
iex> :ets.insert(table, {:alice, 42})
true
iex> :ets.lookup(table, :alice)
[{:alice, 42}]
iex> :ets.insert_new(table, {:alice, 99})
false
iex> :ets.match_delete(table, {:_, :alice})
true
```

`insert` 无条件写，同键覆盖；`lookup` 按键查，返回元组列表（`:set` 最多一条）；`insert_new` 只在键不存在时写，返回 `true/false`，"先查再写"的竞态窗口就靠它关掉；`match_delete` 用匹配模式批量删，`{_, :alice}` 表示"第二个元素是 `:alice` 的都删"。

访问权限三档，跟模块的公开私有很像：`:public` 谁都能读写，`:protected` 只有拥有者能写（默认值），`:private` 只有拥有者能读。`EtsKeyValue` 用 `:public`，因为它本来就想让访问者直接操作；如果是注册表那种有严格约束的表，`protected` 加 `insert_new` 就更合适，`process_registry/ets.ex` 里用的就是这个思路。

多进程同时写会引来资源竞争。两个进程各读一个计数器、自增、写回，结果只算了一次自增。`:ets.update_counter/3` 为这种场景提供原子的读加写；更复杂的复合操作，还是得由拥有者进程串行收消息来做。`:public` 表把"串行"让渡给了调用方纪律，换来的是吞吐。

表默认随拥有者退出而消失。读写快，不代表数据持久；表有名字，也不代表它跨节点共享。

## 同一个 GenServer，两种完全不同的角色

`key_value` 里两个模块都叫 `use GenServer`，做的事却不一样。`KeyValue` 把所有状态操作都收进回调；`EtsKeyValue` 的回调几乎什么都没处理，真正的读写发生在调用进程里。

第 10 章的 `SimpleRegistry` 也用过同一个模式：GenServer 只负责 `trap_exit`、接收 `:EXIT` 消息、清理表里的死进程，注册和查询直接走 ETS。

判断一个 GenServer 是“状态的执行者”还是“资源的管理者”，看 API 函数里有没有 `GenServer.call/cast` 就够了。

## 空闲超时是一种生命周期策略

`todo_cache_expiry` 的 Todo.Server 在回调返回值里多带一个超时参数。先看它收到 `:timeout` 消息后的处理：

```elixir
def handle_info(:timeout, {name, todo_list}) do
  IO.puts("Stopping to-do server for #{name}")
  {:stop, :normal, {name, todo_list}}
end
```

`{:stop, reason, state}` 告诉 GenServer 停止运行循环：`reason` 是退出原因（`:normal` 表示正常退出，不被当作崩溃处理），最后一项是留给日志或终止回调的最终状态。

超时的来源在回调返回值末尾：`handle_call`、`handle_cast`、`handle_continue` 都返回 `{:reply, result, state, @expiry_idle_timeout}` 这类四元组，末尾的毫秒数是"在收不到下一条消息时等多久"。持续访问不断重置这个窗口；一旦十秒没有消息，`:timeout` 进邮箱，走到上面这个 `handle_info`，进程正常退出。

这里的超时不是每隔十秒响一次的独立计时器，它只在"上一次回调返回后没有新消息"时才触发。

`init` 也顺手改进了：`{:ok, {name, nil}, {:continue, :init}}` 先把进程立起来，磁盘加载挪到 `handle_continue` 里做。`{:continue, term}` 让 `init` 一返回就立刻调用 `handle_continue`，中间不会穿插别的消息；监督者能更快拿到 `{:ok, pid}`，慢活留到下一步。

配合 `restart: :temporary`，退出后不会立刻被监督者拉起。下一次访问，再创建进程并加载数据，才实现了真正的按需回收。

## 一张表，怎么比较这些工具

`key_value` 项目附带一个 `bench.ex`，能直接给两种实现跑出数字：

```elixir
{time, _} =
  :timer.tc(fn ->
    0..(concurrency - 1)
    |> Enum.map(&start_load_process(module, ...))
    |> Enum.map(&Task.await(&1, :infinity))
  end)
```

它用 `Task.async` 起一批并发进程，每个进程循环做 `put` 和 `get`，`:timer.tc` 记录整段耗时，最后折算成每秒操作数。`concurrency` 决定同时压多少进程，`num_updates` 决定每个 key 被覆盖多少次。

进入 key_value 项目，执行 `mix deps.get` 和 `iex -S mix`：

```elixir
Bench.run(KeyValue)
Bench.run(EtsKeyValue)
Bench.run(EtsKeyValue, concurrency: 10)
```

`KeyValue` 的数字几乎不随并发涨，因为所有请求都排在一个邮箱里；`EtsKeyValue` 随并发上升。差多少、什么时候到头，下一章专门讲怎么测、怎么信。

## 一个小型选型表

| 需求 | 优先理解的工具 | 仍需考虑 |
| --- | --- | --- |
| 一次独立计算并收集结果 | Task | 超时、链接、失败传播 |
| 简单串行状态操作 | Agent | 阻塞、操作复杂度 |
| 自定义服务协议与生命周期 | GenServer | 邮箱、同步调用关系 |
| 同节点高频共享键值访问 | ETS | 表归属、原子操作、数据恢复 |
| 不活跃业务实体回收 | GenServer 超时 | 访问竞争、持久化、按需重建 |

这里没有“永远最快”的一项。少量操作时，清晰的状态边界往往更重要。需要优化时，要基于实际访问模式测量，不只比较一个脱离场景的微基准。

## 动手验证

进入 todo_cache_expiry 项目，执行 `mix deps.get` 和 `iex -S mix`，再启动 `Todo.System.start_link()`。取出一份清单 PID，十秒内不再访问它，稍后检查 `Process.alive?(pid)`。

然后重新请求同名清单，对比新旧 PID。再持续每隔几秒查询一次，观察空闲过期是否延后。

**练习**：如果某个周期性的内部消息也进入 Todo.Server，它会如何影响空闲判断？“没有业务访问”和“没有任何消息”并不是同一件事。若产品真正需要前者，你可能需要记录最后业务访问时间，而不只依赖普通 receive 超时。

工具箱变大了，选择标准反而更简单：谁拥有状态？访问是否串行？资源何时释放？失败后从哪里恢复？
