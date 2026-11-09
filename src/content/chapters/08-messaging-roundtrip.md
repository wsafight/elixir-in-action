---
order: 8
title: 消息是怎么一来一回的
description: 拆开一次请求-响应，看清 send、receive、邮箱和超时各自做了什么。手写一遍，下一章的 GenServer.call 就没有魔法了。
part: 2
duration: 26
topics: [消息往返, 邮箱, selective receive, receive after, self, monitor]
samples:
  - {label: 进程加法器, path: code_samples/ch05/calculator.ex}
  - {label: 清单服务器, path: code_samples/ch05/todo_server.ex}
  - {label: 有状态数据库服务器, path: code_samples/ch05/stateful_database_server.ex}
---

上一章的进程会收消息、改状态、回消息。这一章放慢速度，把"一来一回"拆开看：一次 `call` 到底是怎么变成两条消息、一次等待、一个超时的。看懂了这套手动拼装，下一章 GenServer 帮你做的那些事就没有任何魔法。

## 一次往返是两条消息加一个等待

`calculator.ex` 里 `value/1` 的完整动作：

```elixir
def value(server_pid) do
  send(server_pid, {:value, self()})

  receive do
    {:response, value} ->
      value
  end
end
```

三步：第一步 `send` 把自己的 PID（`self()`）塞进消息发出去；第二步 `receive` 挂起，等邮箱里出现匹配 `{:response, value}` 的消息；第三步匹配上，`value` 被绑定，函数返回。服务器那头做的事对称：`receive` 取出 `{:value, caller}`，`send(caller, {:response, current_value})` 回一条。

"请求-响应"不是语言提供的机制，是双方程序员共同遵守的约定：调用方在消息里带上 `self()`，服务方回发一个带标签的元组。`self()` 在这里的作用和 HTTP 请求里的 "reply-to" 一样，告诉对方"回给谁"。

## 邮箱是先进先出，receive 是有条件的读

每个进程都有一个邮箱，`send` 往队尾塞，`receive` 从头找。**`receive` 不是取走第一条消息，是取走第一条能匹配的消息**。不匹配的留在邮箱里，等下一次 `receive` 再来看，这个特性叫 selective receive，消息的顺序不一定等于处理的顺序。

在 IEx 里自己就是进程，可以直接验证：

```elixir
iex> send(self(), :first)
iex> send(self(), :second)
iex> receive do
...>   :second -> :got_second
...> end
:got_second
iex> receive do
...>   :first -> :got_first
...> end
:got_first
```

`:second` 后进邮箱，先被取走，因为 `receive` 的匹配模式只要它。`:first` 在邮箱里一直等到有人愿意收。这个行为和队列直觉相反，理解之后再看 GenServer 的 `handle_info` 会顺很多。

邮箱还有另一面：没有边界。给一个每秒只能处理一条消息的进程发一万条，九千九百九十九条就在邮箱里排队，内存跟着涨。第 7 章末尾 `process_bottleneck.ex` 演示的就是这种堆积，生产端永远可以发，消费端有自己的速度。

## 等不到消息怎么办：receive after

`todo_server.ex` 的 `entries/2` 在 `receive` 后面挂了一个 `after`：

```elixir
receive do
  {:todo_entries, entries} -> entries
after
  5000 -> {:error, :timeout}
end
```

`after` 是 `receive` 的超时分支：5000 毫秒内没有匹配的消息进来，就走这条路，返回 `{:error, :timeout}`。没有 `after` 的 `receive` 会等**永远**。服务器死了、消息丢了、网络断了，调用方都卡在那里。

这也解释了一个容易误解的细节：超时到了，不代表请求没到达服务器，只代表调用者不等了。服务器可能正在处理，过会儿回一条 `{:todo_entries, ...}` 过来。这条迟到的消息会进调用者的邮箱，没人读，躺到进程结束。手写往返时这是个小坑，`GenServer.call` 内部用引用（reference）给每条响应打标，迟到的消息能被认出来丢弃，这就是为什么该让 OTP 来做这件事。

## 谁活着，谁死了：消息管不到的部分

`send` 发完就返回，对方活着没有，你不知道。验证进程状态要用别的工具：

```elixir
iex> pid = spawn(fn -> :ok end)
#PID<0.118.0>
iex> Process.alive?(pid)
false
```

`Process.alive?/1` 查一个 PID 现在还活着没有。`spawn` 里那个函数一跑完进程就结束了，所以是 `false`。`Process.whereis(:name)` 查注册名字对应的 PID，名字没注册就返回 `nil`。第 13 章会反复用这对工具确认"这个进程还在不在"。

"发消息"和"关心对方死活"是两件独立的事。想让 A 的死能通知到 B，要 `Process.link`（死了拉对方一起死）或 `Process.monitor`（死了给监控方发一条 `:DOWN` 消息）。它们也是靠消息传递实现的，只是发送方换成了运行时系统。这是第 13 章的核心，现在只要记住：`send` 本身不承担任何可靠性承诺。

## 把这套约定装进一个函数

`TodoServer.entries/2` 和 `Calculator.value/1` 重复了同一个模式：发消息、等响应、超时兜底。如果给这个模式起个名字，它就叫 `call`；如果给"发了不等"起个名字，它就叫 `cast`。`stateful_database_server.ex` 里两个都用了：

```elixir
def store(server_pid, key, data) do
  send(server_pid, {:store, key, data})
end

def get(server_pid, key) do
  send(server_pid, {:get, self(), key})

  receive do
    {:response, data} -> data
  after
    5000 -> {:error, :timeout}
  end
end
```

`store` 是 `cast`：写完不等，调用者拿不到"写完了"的确认。`get` 是 `call`：发起方挂起，等数据库进程回 `{:response, data}`。下一章开始，这两个词就不再是"写法"，是 GenServer 的正式 API。但你已经知道每个 `call` 背后到底在干什么了。

## 动手验证

```sh
cd code_samples/ch05
iex -r calculator.ex
```

```elixir
iex> pid = Calculator.start()
#PID<0.118.0>
iex> Calculator.add(pid, 10)
{:add, 10}
iex> Calculator.value(pid)
10
iex> send(pid, {:value, self()})
{:value, #PID<0.104.0>}
iex> receive do x -> x end
{:response, 10}
```

最后两行是手动模拟 `value/1` 的内部动作：发消息带 `self()`，然后 `receive` 自己收响应。`Calculator.value/1` 干的就是这件事，只是包在函数里。

**练习**：给 `TodoServer` 加一条 `{:size, caller}` 消息，让服务器返回清单的条目数。然后故意把一个不存在的 PID 传给 `entries/2`，观察 `after` 分支什么时候触发，体会"超时兜底"在保护谁。
