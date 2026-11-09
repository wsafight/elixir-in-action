---
order: 7
title: 进程，让状态活起来
description: 从 spawn、send 和 receive 出发，让一个进程持有 TodoList。理解消息、状态循环与并发的边界。
part: 2
duration: 36
topics: [进程, 消息传递, receive, 状态循环, 邮箱, make_ref]
samples:
  - { label: '进程加法器', path: code_samples/ch05/calculator.ex }
  - { label: '清单服务器', path: code_samples/ch05/todo_server.ex }
  - { label: '无状态数据库服务器', path: code_samples/ch05/database_server.ex }
  - { label: '有状态数据库服务器', path: code_samples/ch05/stateful_database_server.ex }
  - { label: '串行瓶颈实验', path: code_samples/ch05/process_bottleneck.ex }
---

上一章的清单是一个值：调用者计算出新清单，再把它传给下一个函数。现在换一种组织方式，让一个进程保管清单，其他进程只发"新增条目"或"查询日期"这样的消息。

数据依然不可变。改变的是谁来保存它：每次循环都带着一份新状态继续跑。

## 一个最小的有状态进程

`calculator.ex` 用一个进程当加法器，是看懂"客户端函数 + 服务端循环"这个分层的最小例子：

```elixir
def start do
  spawn(fn -> loop(0) end)
end

def add(server_pid, value), do: send(server_pid, {:add, value})

defp loop(current_value) do
  new_value =
    receive do
      {:value, caller} ->
        send(caller, {:response, current_value})
        current_value

      {:add, value} ->
        current_value + value
      # ... :sub, :mul, :div 同理
    end

  loop(new_value)
end
```

这里有两层，先分清它们再看代码会省很多事：

- `start`、`add`、`value` 这些公开函数运行在**调用者的进程**里，只负责发消息和等回复；
- `loop/1` 运行在 `spawn` 出来的**服务器进程**里，一条消息进来，算出新状态，尾递归进入下一轮。

逐行过一遍。`start/0` 里 `spawn(fn -> loop(0) end)` 创建一个 BEAM 进程，这个进程拿到的第一件事就是执行 `loop(0)`，初始状态 `0` 作为参数塞进去，返回值是新进程的 PID。

`loop/1` 是这个进程的一生：`receive` 阻塞着等消息，`{:value, caller}` 匹配上时把当前值回发给调用者（`send(caller, ...)`）然后状态原样带进下一轮；`{:add, value}` 匹配上时算出 `current_value + value`。`receive` 的返回值是匹配分支的值，被绑到 `new_value`，最后一行 `loop(new_value)` 尾递归，这行结束本轮，函数从头再来，新状态成了参数。

发送是异步的：`add` 发完 `send` 就返回，不确认对方处理没有。`value` 需要结果，所以协议多一步：发消息时带上 `self()` 让服务端知道回谁，然后自己 `receive` 等 `{:response, value}`。这套"请求带调用者 PID，回复单独发回"的形状，后面每个服务器都长这样。

## 先认识当前这个进程

打开 IEx，跑一个不依赖示例文件的小实验：

```elixir
iex> parent = self()
#PID<0.109.0>
iex> worker = spawn(fn -> send(parent, {:hello, self()}) end)
#PID<0.112.0>
iex> receive do
...>   {:hello, pid} -> pid == worker
...> after
...>   1000 -> :timeout
...> end
true
```

逐行看。`self()` 返回当前进程的 PID，IEx 会话自己就运行在一个进程里，`#PID<0.109.0>` 是它的编号。`spawn(fn -> ... end)` 创建第二个 BEAM 进程，`spawn` 的返回值是这个新进程的 PID `worker`。新进程一启动就执行那个 `fn`：往 `parent` 发一条 `{:hello, self()}`，发完函数结束，进程也自然退出。

第三行开始是 IEx 进程这边的 `receive`：等邮箱里第一条能匹配 `{:hello, pid}` 的消息，匹配上了比较 `pid == worker`，就是刚创建的那个 PID。`after 1000` 是超时兜底：一秒内没收到匹配的消息就走 `:timeout` 分支，不会永远卡死。通常得到 `true`。

顺手再看两个进程相关的工具函数：

```elixir
iex> Process.alive?(worker)
false
iex> Process.alive?(self())
true
iex> Process.exit(self(), :normal)
true
```

`Process.alive?` 查进程还在不在：`worker` 发完消息就结束了，返回 `false`。`Process.exit(pid, reason)` 给进程发退出信号，第二个参数 `:normal` 是"正常退出"，进程收到会终止（除非它捕获退出信号，第 13 章讲）。最后一行杀的是自己，所以下一条 `iex>` 提示符里的 PID 已经换了：IEx 会话进程死掉了，外层又给你开了一个新的。

BEAM 进程不是操作系统进程。每个进程有自己的状态与邮箱，由运行时负责调度，进程之间不靠直接修改彼此的数据来沟通。一个节点的普通脚本可以跑出几十万个这种进程。

## 邮箱和 receive 的约定

`send(pid, message)` 把一个 Elixir 值塞进目标进程的邮箱。发送动作不等于对方已经处理，更不等于业务操作成功。

`receive` 按模式从邮箱里找第一条能匹配的消息。没匹配上的消息留在邮箱里。如果协议设计得太宽泛，或者消息之间缺少区分标记，邮箱会悄悄堆积旧消息。读不认识的进程代码时，可以先用 `Process.info(pid, :messages)` 看邮箱里有什么。

来自同一发送者、发往同一接收者的消息保持发送顺序。不同发送者之间，不要假设存在某个全局顺序。许多"先写后读"实验的结论，都取决于这一区别。

## 一个 TodoServer 的循环

`todo_server.ex` 把同样的形状套在清单上。`start/0` 创建新进程，把 `TodoList.new()` 作为初始状态交给 `loop/1`。循环做三步：接收消息、算新状态、尾调用下一轮。

```elixir
defp loop(todo_list) do
  new_todo_list =
    receive do
      message -> process_message(todo_list, message)
    end

  loop(new_todo_list)
end
```

这里的 `receive` 只写一个兜底模式 `message`，不管什么消息都先接住，交给 `process_message/2` 分类。这个函数是三个分句的纯函数，按消息形状分派：

```elixir
defp process_message(todo_list, {:add_entry, new_entry}) do
  TodoList.add_entry(todo_list, new_entry)
end

defp process_message(todo_list, {:entries, caller, date}) do
  send(caller, {:todo_entries, TodoList.entries(todo_list, date)})
  todo_list
end

defp process_message(todo_list, _), do: todo_list
```

三条分句对应三种消息。遇到 `{:add_entry, entry}`，调用第五章的纯函数 `TodoList.add_entry` 得到新清单，返回值就是下一轮的状态。遇到 `{:entries, caller, date}`，先给调用者回发 `{:todo_entries, ...}`，再把**原**清单交给下一轮，查询没有改变状态。第三条 `_` 兜底所有不认识的消息：不打断循环，但也不更新状态，哑消息悄悄被吞掉，这是简单协议的代价之一。

数据与协议的边界很清楚：业务规则全在 `TodoList` 的纯函数里，进程只负责持有状态和收发消息。你可以不启动任何进程就测试新增、筛选和更新，也可以单独测试进程的通信协议。

有一点消息机制管不到：`send` 发完就走，对方进程死了你也不知道。如果 A 的退出应当影响 B，或者 B 只是想收到"A 死了"的通知，那要靠第 13 章讲的链接和监控。它们是两件事，先记住这个差别。

## 不带状态和带状态的区别

`database_server.ex` 和 `stateful_database_server.ex` 是另一个对照组。前者是一个"只转发"的循环：收到 `{:run_query, caller, query_def}`，模拟跑两秒查询，把结果发回去。它没有状态，循环里不传任何东西。

后者在启动时生成一个随机数当"连接句柄"，存进 `loop/1` 的参数里，每条消息的处理都带着它：

```elixir
defp loop(connection) do
  receive do
    {:run_query, caller, query_def} ->
      query_result = run_query(connection, query_def)
      send(caller, {:query_result, query_result})
  end

  loop(connection)
end
```

模式一样：状态只是循环函数的参数，每轮递归带出新值。换成真实代码里，这个参数可以是连接、缓存、定时器引用，或者任何一份不可变数据。

## 请求与响应还缺什么

当前 `entries/2` 先发送 `{:entries, self(), date}`，再最多等 5000 毫秒收 `{:todo_entries, entries}`。

这个协议足以展示机制，但回复没有唯一请求标记。如果一次查询超时，迟到回复仍可能进入邮箱，下一次查询就有可能误读它。两个调用者共享同一个 IEx 进程做实验时更容易撞上。更完整的手写协议会用 `make_ref()` 给每次请求一个唯一引用：

```elixir
def entries(todo_server, date) do
  ref = make_ref()
  send(todo_server, {:entries, self(), ref, date})

  receive do
    {:todo_entries, ^ref, entries} -> entries
  after
    5000 -> {:error, :timeout}
  end
end
```

`make_ref()` 造一个全局唯一的引用值，当次请求的身份证。请求带上它，服务端回包时原样带回；`receive` 里写 `{:todo_entries, ^ref, entries}`，`^ref` 是 pin 运算符，表示"必须等于已经绑定的 `ref`"，不是新绑定。这样旧请求的迟到回复对不上模式，留在邮箱里也不会被误收。

超时也不代表远端操作被取消。调用者只是停止等待。查询重试一次问题不大；但转账、写文件这类操作，就得想清楚重试会不会重复执行。

这些通用问题，正是下一章引入 GenServer 的理由。

## 并发不是把所有事放进一个进程

`process_bottleneck.ex` 的服务器每处理一条消息先睡一秒。启动它，再从多个进程同时发请求，所有调用者都会排队。入口能接收任意多的消息，不代表内部工作可以并行。

一个进程一次只做一件事。进程划分要围绕状态归属、失败边界和负载特点：给每个小函数都开一个进程，只会增加协议和协调成本；把所有独立状态塞进一个进程，又会制造串行瓶颈。

## 动手验证

```sh
iex -r todo_server.ex
```

在 IEx 中执行：

```elixir
iex> server = TodoServer.start()
#PID<0.112.0>
iex> TodoServer.add_entry(server, %{date: ~D[2026-11-09], title: "第一次发送消息"})
:ok
iex> TodoServer.entries(server, ~D[2026-11-09])
[%{date: ~D[2026-11-09], id: 1, title: "第一次发送消息"}]
```

`add_entry` 的返回值是 `:ok`，`send` 只是投递成功，不代表服务端处理完了。`entries` 返回包含该条目的列表。这里新增和查询都从同一个 IEx 进程发出，所以前面说的消息顺序保证适用；别把这个实验推广成多个客户端之间的同步保证。

再试试 `calculator.ex`：

```elixir
iex> calc = Calculator.start()
#PID<0.114.0>
iex> Calculator.add(calc, 10)
:ok
iex> Calculator.mul(calc, 3)
:ok
iex> Calculator.value(calc)
30
```

应当得到 `30`。`add` 和 `mul` 都立即返回 `:ok`，它们是异步的；只有 `value` 会等回复。

**练习**：创建两个 TodoServer，分别加入不同条目，验证状态互不影响。再用 `Process.exit(server, :kill)` 杀掉一个，看另一个还能不能查询，并记下：目前没有任何机制会自动重建被杀掉的服务。

本章一直在显式传 PID：`TodoServer.entries(server, date)`。进程一多，记 PID 就成了负担，第 10 章给进程起名字。配套测试用 `elixir tests.exs` 可以核对本章脚本。
