---
order: 7
title: 把通用部分交给 GenServer
description: 从手写服务器抽象走到 OTP。分清客户端 API、服务端回调，以及 call、cast 和状态之间的关系。
part: 2
duration: 38
topics: [OTP, GenServer, call, cast, 回调, behaviour, "@impl"]
samples:
  - { label: '手写通用服务器', path: code_samples/ch06/server_process.ex }
  - { label: '区分 call 与 cast 的版本', path: code_samples/ch06/server_process_cast.ex }
  - { label: '清单版手写抽象', path: code_samples/ch06/server_process_todo.ex }
  - { label: 'KV 版 GenServer', path: code_samples/ch06/key_value_gen_server.ex }
  - { label: 'GenServer 清单服务器', path: code_samples/ch06/todo_server.ex }
---

第六章的服务器包含两类逻辑：一类是待办清单的新增和查询，另一类是启动进程、等待消息、发回响应。服务器一多，第二类就会不断重复。

GenServer 提供了一套通用的服务器协议：你描述状态和回调，OTP 负责消息收发、同步等待、超时这些公共管道。

## 先看手写抽象解决了什么

"通用服务器循环"示例已经把循环抽成了一个模块。它的 `loop/2` 不认识任何业务，只认识一个契约：回调模块提供 `init/0` 和 `handle_call/2`，循环负责保存状态、转发请求、回复调用者：

```elixir
defp loop(callback_module, current_state) do
  receive do
    {request, caller} ->
      {response, new_state} =
        callback_module.handle_call(request, current_state)

      send(caller, {:response, response})
      loop(callback_module, new_state)
  end
end
```

同一个文件里的 `KeyValueStore` 只写业务：`init` 返回 `%{}`，`handle_call({:put, key, value}, state)` 返回 `{结果, 新状态}`。

下一个示例 `server_process_cast.ex` 再进一步，把消息分成两种。`loop/2` 里两个分支：

```elixir
defp loop(callback_module, current_state) do
  receive do
    {:call, request, caller} ->
      {response, new_state} =
        callback_module.handle_call(request, current_state)

      send(caller, {:response, response})
      loop(callback_module, new_state)

    {:cast, request} ->
      new_state = callback_module.handle_cast(request, current_state)
      loop(callback_module, new_state)
  end
end
```

`{:call, request, caller}` 分支多一步：先调业务回调拿到 `{response, new_state}`，再 `send(caller, ...)` 给调用者回复，所以 `call` 是"要回复的请求"。`{:cast, request}` 分支只更新状态，不发回复，`cast` 是"扔过去就不管的请求"。调用侧也对应分开：`call/2` 发完 `{:call, request, self()}` 立刻 `receive` 等 `{:response, response}`；`cast/2` 发完就返回。

同一个文件里的 `KeyValueStore` 现在只剩四块业务：`init/0` 返回初始状态，`handle_call({:get, key}, state)` 返回 `{结果, 状态}`，`handle_cast({:put, key, value}, state)` 只返回新状态。循环、消息格式、回复路径全归 `ServerProcess` 管。

读这些文件时不必死记自定义协议。它们让你看清几个问题：服务器为什么需要统一的初始化格式？谁负责保存下一份状态？哪一层知道调用者是谁？GenServer 的回调签名，就是这些职责经过约定后的接口。

## 用回调描述状态变化

`todo_server.ex` 用 `use GenServer` 声明行为，再实现几个核心回调：

```elixir
def init(_) do
  {:ok, TodoList.new()}
end

def handle_cast({:add_entry, new_entry}, todo_list) do
  new_state = TodoList.add_entry(todo_list, new_entry)
  {:noreply, new_state}
end

def handle_call({:entries, date}, _, todo_list) do
  {:reply, TodoList.entries(todo_list, date), todo_list}
end
```

三个回调各干一件事，签名是约定好的。`init/1` 在进程刚启动时跑，参数是 `start` 传进来的初始化参数（这里用 `_` 忽略），返回 `{:ok, 初始状态}`——`TodoList.new()` 成为这个进程的第一份状态。

`handle_cast({:add_entry, new_entry}, todo_list)` 处理"不需要回复"的消息：两个参数——消息本身、当前状态。算出 `new_state` 后返回 `{:noreply, new_state}`，意思是"不给调用者回话，但下一轮循环带这份新状态"。

`handle_call({:entries, date}, _, todo_list)` 三个参数：消息、调用者标识（`{from_pid, ref}`，这里 `_` 忽略）、当前状态。返回三元组 `{:reply, 结果, 新状态}`——`结果`发给等回复的调用者，`新状态`进下一轮。

`{:noreply, new_state}` 和 `{:reply, result, state}` 不是直接抛给函数调用者的业务结果，而是交给 GenServer 运行循环的"下一步指令"——你这个回调返回的元组，会被 OTP 的通用循环接着拆开用。

回调能返回的形状还有几种：

| 返回值 | 含义 |
| --- | --- |
| `{:reply, reply, new_state}` | 回复调用者，继续跑 |
| `{:noreply, new_state}` | 不回复，继续跑 |
| `{:stop, reason, new_state}` | 正常停掉进程（`handle_call` 中是 `{:stop, reason, reply, state}`） |
| `{:noreply, state, timeout}` | 空闲超时，到点触发 `handle_info(:timeout, ...)` |
| `{:noreply, state, {:continue, arg}}` | 初始化后接着跑 `handle_continue` |

`handle_call` 的第二个参数是 `{from_pid, ref}`，标识这次调用。多数情况用 `_` 忽略；需要"先返回、后回复"时才用它调 `GenServer.reply`。

"KV 版 GenServer" 示例 `key_value_gen_server.ex` 是同一骨架的最小实现，四十行以内覆盖全部要素：

```elixir
defmodule KeyValueStore do
  use GenServer

  def start, do: GenServer.start(KeyValueStore, nil)
  def put(pid, key, value), do: GenServer.cast(pid, {:put, key, value})
  def get(pid, key), do: GenServer.call(pid, {:get, key})

  def init(_), do: {:ok, %{}}
  def handle_cast({:put, key, value}, state), do: {:noreply, Map.put(state, key, value)}
  def handle_call({:get, key}, _, state), do: {:reply, Map.get(state, key), state}
end
```

上半部分是客户端包装：调用方只管 `KeyValueStore.put(pid, :a, 1)`，不知道里面是 `cast` 还是 `call`。下半部分是服务端回调：`init` 给空 map 当状态，`handle_cast` 存键值对返回 `{:noreply, 新状态}`，`handle_call` 取键值对返回 `{:reply, 结果, 原状态}`——查询不改状态，所以第三项还是 `state`。想看清 GenServer 的轮廓，从它开始比从 Todo 开始更省眼神。

## `use GenServer` 注入了什么

`use GenServer` 展开时给模块注入几样东西：一个默认的 `init/1`、所有 `handle_*` 回调的兜底实现（比如没写的 `handle_info` 只是记条日志）、一个 `child_spec/1`（第 11 章监督树要用到的"启动说明书"），以及一行 `@behaviour GenServer`——把模块登记成 GenServer 的"实现方"。

回调可以被覆盖，是因为它们只是普通函数。`handle_call` 你写就按你的跑，不写就跑注入的默认版本（默认抛异常）。

GenServer 本身在语言里的身份是一个 behaviour——行为就是一组 `@callback` 声明的约定：模块声明 `@behaviour GenServer`（`use GenServer` 替你做了），编译器就检查它是否真的实现了约定的回调。`init` 和 `handle_*` 前面那些 `@impl` 标记就是这个检查在起作用：标注了 `@impl` 说明"这个函数实现的是 behaviour 约定的回调"，名字或参数写错会在编译期报警，而不是运行时才崩。标注不强制，但所有 OTP 代码都建议写上。自定义一套接口也可以用同样的机制：在抽象模块里写 `@callback`，实现方打 `@impl`。

`use GenServer` 不会替你启动进程，它只是把模块打扮成"能被 OTP 启动的服务器"。启动还是要显式调：`GenServer.start(TodoServer, nil)` 或 `GenServer.start_link`——`start` 和 `start_link` 的差别在第 10 章展开，前者只启动，后者启动时同时和调用进程建链。

## 客户端 API 在谁的进程里运行

`TodoServer.add_entry/2` 写在服务器模块里，但从 IEx 调用时，它先在 IEx 进程里跑，调 `GenServer.cast` 把消息递过去。`handle_cast/2` 才在服务器进程里执行。

一次 `call` 走完两个进程：`TodoServer.entries(server, date)` 在调用进程（比如 IEx）里执行，内部调 `GenServer.call`，它做的事等价于"`make_ref` 造引用、发 `{:call, ...}` 消息、阻塞等带同引用的回复"；消息进服务器进程邮箱，轮到它时 OTP 的循环拆出请求，调 `handle_call({:entries, date}, from, 状态)`；回调返回 `{:reply, 结果, 状态}`，循环把`结果`包进回复消息发回 `from` 里的 PID；调用进程的 `receive` 匹配到，函数才返回。同步不是魔法，是"发完就等"被 OTP 写进了通用循环里。

同一个模块可以同时装着客户端包装函数和服务端回调，文件位置决定不了代码在哪个进程执行。读 OTP 代码时，把"在哪个进程执行"标在调用链上。

## call 与 cast 是不同的承诺

| 接口 | 调用者何时继续 | 适合描述什么 |
| --- | --- | --- |
| `GenServer.call` | 收到回复、超时或调用失败 | 需要结果或明确确认的操作 |
| `GenServer.cast` | 消息发出后即可继续 | 不需要同步结果的通知 |

`cast` 不等于"后台任务一定成功"，也不给服务器增加并行能力，它只是让调用者不等待——发出去的消息甚至可能在服务器崩溃后丢失而无人察觉。

`call` 默认 5 秒超时，可以传第三个参数改：`GenServer.call(pid, req, 10_000)`。超时或服务器退出时，调用者跟着退出（抛出 `exit`），除非你显式 `try/catch`。而回调里返回的 `{:error, reason}` 是普通业务回复，跟协议层的退出不是一回事——前者对方收到了、后者对方根本没来得及处理。

还要分清"状态已更新"和"已可靠落盘"。即使用 `call`，如果回调只是排队了一次异步写入，回复也证明不了文件已经写好。第 17 章会再次遇到这个问题。

## 保持回调短小

一个 GenServer 同一时间只执行一个回调。在 `handle_call` 里睡十秒，后面的消息就排十秒队。把耗时工作塞进回调，并不会因为名字里有 Server 就自动变快。

也别让回调同步 `call` 自己：当前回调在等回复，而能发出回复的请求还躺在自己的邮箱里——死锁。两个服务器互相同步 `call`，会绕出同样的环。可以在 IEx 里试：`GenServer.call(self(), :x)` 会直接卡到超时。

进程适合拥有和协调状态；与状态无关的耗时工作，可以交给另一个工作进程，但结果、超时和失败怎么回到原流程，仍然要你设计。

## 动手验证

```sh
iex -r todo_server.ex
```

```elixir
iex> {:ok, server} = TodoServer.start()
{:ok, #PID<0.112.0>}
iex> TodoServer.add_entry(server, %{date: ~D[2026-11-09], title: "读懂回调"})
:ok
iex> TodoServer.entries(server, ~D[2026-11-09])
[%{date: ~D[2026-11-09], id: 1, title: "读懂回调"}]
```

启动结果变成了 `{:ok, pid}`——`GenServer.start` 在 `init` 成功后才返回，比裸 `spawn` 多一层明确的启动约定。`add_entry` 返回 `:ok`（`cast` 发完就完）；`entries` 走 `call`，拿到的是 `handle_call` 返回三元组中间那个值——`{:reply, 结果, 状态}` 里只有 `结果` 被递回调用者，状态留在了服务器进程里。

**练习**：在自己的副本里把新增改成 `call`，让它回复 `:ok`——客户端 API 和回调都要改。然后想：这个确认能保证什么？能保证进程崩溃后数据还在吗？不能，本章的状态仍然只在内存里。

配套测试用 `elixir tests.exs` 跑。到这里，你应该能说清楚"客户端包装函数"和"服务端回调"的区别，也能解释为什么 `use GenServer` 不只是少写几行。
