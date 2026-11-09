---
order: 10
title: 让失败成为设计的一部分
description: 进程隔离让失败可以被限制，链接让故障能够传播，监督者则把重建流程变成系统的日常能力。
part: 3
duration: 36
topics: [链接, 监控, Supervisor, 故障恢复, trap_exit, :DOWN]
samples:
  - { label: 'todo_links·缓存', path: code_samples/ch08/todo_links/lib/todo/cache.ex }
  - { label: 'todo_links·数据库', path: code_samples/ch08/todo_links/lib/todo/database.ex }
  - { label: 'supervised_todo_cache·系统入口', path: code_samples/ch08/supervised_todo_cache/lib/todo/system.ex }
  - { label: 'supervised_todo_cache·缓存', path: code_samples/ch08/supervised_todo_cache/lib/todo/cache.ex }
---

进程隔离让一个进程可以独立失败，但"独立失败"不等于"系统仍然正确"。如果缓存里留着一个已经死掉的 PID，请求照样会失败。恢复是被设计出来的，不是被等出来的。

本章从退出信号开始，逐步把恢复责任放到监督者手里。

先把两种失败分开。进程内部的普通异常，用 `try/rescue` 就够了：

```elixir
try do
  Keyword.fetch!(opts, :source_file) |> File.read!()
rescue
  e in KeyError -> {:error, "missing :source_file option"}
  e in File.Error -> {:error, "unable to read source file"}
end
```

`try` 包住可能抛异常的代码：`Keyword.fetch!` 拿不到键抛 `KeyError`，`File.read!` 读不到文件抛 `File.Error`。`rescue` 按错误类型逐个匹配：`e in KeyError` 的意思是"如果抛的是 `KeyError`，把它绑到 `e` 走这一支"。两个分支都不抛异常，而是把错误降级成 `{:error, reason}` 的普通返回值，救回来了就当业务结果接着走。

`try` 还能挂 `after` 块，无论成不成功都执行，常用来关文件、放锁：

```elixir
{:ok, file} = File.open("todos.csv")
try do
  IO.read(file, :line)
after
  File.close(file)
end
```

Elixir 的约定是：可预期的业务错误用 `{:error, reason}` 返回值走模式匹配，救不了的才抛异常。链接和监控处理的是另一层——异常已经越过了单个进程，影响到别的进程的生死。

## 链接描述命运关联

两个进程建立链接之后，一个进程的退出会作为退出信号影响另一个。链接是双向的——谁链接谁无所谓，信号两边都能传。`start_link` 把启动和建链接合成一步，避免先启动再链接之间出现空隙——进程可能在那条缝里死掉。

在 IEx 里直接看三种退出原因的区别：

```elixir
iex> spawn_link(fn -> :ok end)
#PID<0.112.0>
iex> self()
#PID<0.109.0>
```

`spawn_link` 起了一个立刻正常退出的进程，理由是 `:normal`——`self()` 还是那个 PID，IEx 没受影响：正常退出不传播。

```elixir
iex> spawn_link(fn -> raise "boom" end)
** (EXIT from #PID<0.109.0>) shell process exited with reason: an exception was raised:
    ** (RuntimeError) boom
```

`raise` 让新进程异常退出，信号沿链接打到 IEx，IEx 会话进程被拉死，外层又给你开了个新的——括号里的 PID 换了。

链接的实际行为取决于三件事，别把它简化成"一个死，全跟着死"：

- 退出原因。`:normal` 不传播，异常（`raise`、`exit/1` 的非 `:normal` 理由、`throw`）才传播；
- `trap_exit`。开了它的进程把退出信号变成普通 `{:EXIT, pid, reason}` 消息进邮箱，自己不死——`Process.flag(:trap_exit, true)` 打开，第 8 章的注册表就是靠它活下来收尸的；
- `:kill`。它无视 `trap_exit`，收到它的进程一定终止（`:kill` 也是唯一能确定杀死一个进程的方式）。`Process.exit(pid, :kill)` 就是用它。

监督者就是开着 `trap_exit` 的进程：子进程死了它收 `{:EXIT, ...}`，按自己的重启策略处理，而不是跟着死。

在 `todo_links` 版本里，Cache 启动并链接数据库和 `Todo.Server`：依赖的异常退出会沿链接打到缓存，不会让它握着无效状态继续跑。

链接负责传播关系，本身不会重新启动任何东西。

## 监控描述观察关系

监控是单向的。监控方收到目标退出后的 `:DOWN` 消息，可以决定清理映射、记录原因或触发别的行为，不需要与目标一起退出。

在单独的 IEx 里跑：

```elixir
iex> {pid, reference} = spawn_monitor(fn -> receive do :stop -> :ok end end)
{#PID<0.112.0>, #Reference<0.1234567.8901234.567890>}
iex> send(pid, :stop)
:stop
iex> receive do
...>   {:DOWN, ^reference, :process, ^pid, reason} -> reason
...> after
...>   1000 -> :timeout
...> end
:normal
```

`spawn_monitor` 一步做两件事：`spawn` 起进程、`Process.monitor` 建立监控，返回 `{PID, 引用}`。那个 `reference` 是这次监控的唯一票据：同一个进程可以被监控多次，每次的 `reference` 都不同。

新进程收到的 `:stop` 让它走到 `receive` 的尽头正常退出。监控方不等对方死透，但会收到一条 `{:DOWN, ref, :process, pid, reason}`。形状是固定的四元组：`:DOWN` 是信号、`ref` 对上刚才的票据、`:process` 说明监控的是进程、`reason` 是退出原因。`:normal` 说明对方是正常走掉的，不是崩掉的。

`^reference` 和 `^pid` 是 pin 匹配——写死"必须等于刚才那个引用/PID"，防止把别的监控的通知当成本次结果。这正是"发起方自己验身份"的版本，比"凡是 `:DOWN` 就接住"严谨得多。

链接和监控的差别在这个实验里看得很清：被监控方死掉，监控方只收一条消息，活得好好的；被链接方死掉，监控方要是没 `trap_exit` 会跟着死。想知道"它结束了没有"，用监控；想表达一组进程同生共死，用链接和监督。

## 监督者负责重新建立进程

`supervised_todo_cache/lib/todo/system.ex` 很短：

```elixir
Supervisor.start_link(
  [Todo.Cache],
  strategy: :one_for_one,
  name: __MODULE__
)
```

三行参数拆开读：`[Todo.Cache]` 是子进程规范列表，写清监督者启动后要拉起哪些进程。这里写的是模块名 `Todo.Cache`，OTP 会拿它当"启动说明书"：`use GenServer` 时注入的 `child_spec/1` 默认让监督者去调 `Todo.Cache.start_link()`。`strategy: :one_for_one` 是重启策略，"一个子进程死了，只重启那一个"（其他策略后面讲）。`name: __MODULE__` 把监督者自己登记成 `Todo.System`——之后可以用名字找到它（比如 `Supervisor.which_children(Todo.System)`），重复调用 `Todo.System.start_link` 会拿到 `{:error, {:already_started, pid}}` 而不是再起一棵重复的树。`start_link` 把监督者链接到调用进程，所以监督者和启动它的进程也是同生共死关系。

顶层监督者直接监督的是 `Todo.Cache`。在 `supervised_todo_cache` 中，Cache 启动数据库和清单进程时仍用未链接的 `start`，监督范围只覆盖 Cache 本身——Cache 重启，不代表它之前创建的清单进程也已经退出。

`todo_links` 版本进一步建立了链接，让相关进程的异常能够传播；但它们仍不是各自独立受监督的工作单元。下一章会把这些恢复职责整理成更清楚的树。

`Supervisor` 知道子进程怎么启动、什么时候该重启、用什么策略恢复。它不需要知道条目怎么更新，也不该在自身保存业务状态。

## 重启策略不是数据恢复策略

`:one_for_one` 表示一个子进程失败时，按重启规则处理该子进程。`:one_for_all` 会把同组子进程一起重启，`:rest_for_one` 则重启失败子进程及其后启动的子进程。

三种策略各对应一种依赖关系。`:one_for_one` 适合"子进程互相独立、死一个换一个"——比如若干张清单各自独立。`:one_for_all` 适合"子进程彼此依赖、一个坏了其余的也失效"——比如 A 的 PID 被 B 记着了，A 一死 B 手里的 PID 就废，不如全换。`:rest_for_one` 适合"启动顺序有先后依赖"——后启动的依赖先启动的，前面死了就把后面的也换掉，保持依赖链干净。

选策略看实际依赖和旧状态是否仍然有效，不看哪个名字更像"高可用"。无论哪种策略，都不会自动把内存数据变成持久数据。

监督者还有一层保护：`max_restarts` 和 `max_seconds`——默认 3 秒内最多重启 3 次。短时间反复死说明问题不在进程本身（比如依赖的外部服务挂了），继续重启只是空转，监督者会认输、自己也退出。这就是为什么监督者不是"无条件重试的无限循环"。

新进程有新 PID，也可能从磁盘重建状态。如果某次异步写入还没完成就崩溃，重启后的状态仍可能比崩溃前旧。监督恢复的是运行结构，数据完整性还需要别的设计。

## 在实验里制造一次失败

进入 `supervised_todo_cache` 项目目录，执行 `mix deps.get` 与 `iex -S mix`。然后：

```elixir
iex> {:ok, supervisor} = Todo.System.start_link()
{:ok, #PID<0.112.0>}
iex> old_cache = Process.whereis(Todo.Cache)
#PID<0.115.0>
iex> Process.exit(old_cache, :kill)
true
iex> Process.whereis(Todo.Cache)
#PID<0.125.0>
```

`:kill` 无视 `trap_exit`，Cache 当场死透。监督者收到它的退出信号后按 `:one_for_one` 重启，几毫秒后 `whereis` 再查，拿到的是**新** PID。这里的"稍后"很重要：重启是一个过程，不能在发送退出信号的同一时刻假设它已完成。

实验时保留 IEx 会话与监督者的链接关系。如果你继续杀死顶层监督者，IEx 本身也可能受到退出信号影响。学习故障边界，最好一次只改变一个条件。

## 为什么接受失败反而更可靠

"让它崩溃"不是忽略输入验证，也不是遇到任何业务错误都杀死进程。可预期的失败仍应该通过明确返回值表达——`File.read` 的 `{:error, reason}`、`Map.fetch` 的 `:error` 都是这种约定，调用者用 `case`/`with` 就能处理，不需要崩溃。

它强调的是：当进程已经处于无法可靠继续的状态时，一次清晰的失败和重建，往往比在半损坏状态下继续执行更容易推理。一个不认识的异常把进程搞死了，监督者按 `start_link` 里那张"启动说明书"再造一个干净的出来——比重启前的旧状态更接近"刚启动时的正确状态"。前提是你已经定义了恢复入口、依赖关系和数据来源。

这个模式的反直觉之处在于：可靠性不是"永远不失败"，是"每次失败都能被圈定范围并按预定方式重建"。错误处理的对象也因此分层——单进程内的异常用 `try/rescue`，跨进程的生死用链接/监控，恢复用监督者，三层各自管自己的那一段。

**练习**：把进程之间的链接画出来。分别预测 `Todo.Server`、Cache 和顶层监督者异常退出的影响，再用实验核对。如果 Cache 死了，它名下的清单进程还在吗？反过来呢——哪个方向容易出错，取决于链接和 `start_link` 各自挂在哪。若系统持续启动失败，监督者也会达到 `max_restarts` 限制并退出；不要把监督者想象成无条件重试的无限循环。

下一章会缩小失败的影响范围，让数据库、缓存与动态工作进程各自拥有更清楚的恢复职责。
