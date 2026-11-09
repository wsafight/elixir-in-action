---
order: 13
title: 用数字说话
description: 用 :timer.tc 和一个并发压测器比较 GenServer 与 ETS 的吞吐。测量值要经得起追问，结论才站得住。
part: 3
duration: 28
topics: [benchmark, timer.tc, Benchee, 吞吐, 延迟, 并发]
samples:
  - {label: 并发压测器, path: code_samples/ch10/key_value/lib/bench.ex}
  - {label: 进程版 KV, path: code_samples/ch10/key_value/lib/key_value.ex}
  - {label: ETS 版 KV, path: code_samples/ch10/key_value/lib/ets_key_value.ex}
  - {label: 串行瓶颈实验, path: code_samples/ch05/process_bottleneck.ex}
---

上一章末尾留下了两个数字：`Bench.run(KeyValue)` 和 `Bench.run(EtsKeyValue)`。EtsKeyValue 快多少，取决于压测怎么写；而这一章关心的是，bench.ex 自己会不会说谎。

## 先把计时单位弄明白

BEAM 里最基础的测量函数是 `:timer.tc`，它包住一个函数，返回 `{microseconds, result}`——**微秒**，不是毫秒：

```elixir
iex> :timer.tc(fn -> Process.sleep(1000) end)
{1000127, :ok}
```

一百万微秒等于一秒。`bench.ex` 最后除以这个时间、乘上一百万，再把操作总数除回去，才算出"每秒多少次"这个指标：

```elixir
throughput = round(1_000_000 * total_operations / time)
```

前面 `1_000_000` 把微秒折算回秒，`total_operations` 是所有进程做完的 `put` 加 `get` 总和。别拿这个时间直接当结论——它只说明被测段花了多久，还得看规模。

## bench.ex 的两层结构

压测器 `bench.ex` 分上下两层。外层负责并发：

```elixir
0..(concurrency - 1)
|> Enum.map(
  &start_load_process(module, &1 * items_per_process, items_per_process, num_updates)
)
|> Enum.map(&Task.await(&1, :infinity))
```

`0..(concurrency - 1)` 起多少个数字，就起多少个 `Task.async` 进程，每个进程领一段互不重叠的 key 区间。`Task.await(&1, :infinity)` 把这一批进程全部收齐才往下走——没有这一步，计时会在进程还没跑完时就结束。

内层是实际压测的循环：

```elixir
defp perform_updates(_module, _start_item, _end_item, 0), do: :ok

defp perform_updates(module, start_item, end_item, value) do
  update_items(module, start_item, end_item, value)
  perform_updates(module, start_item, end_item, value - 1)
end
```

两个子句配合：`perform_updates` 每跑一轮，先调 `update_items` 把整段 key 遍历一遍，然后 `value - 1` 递归自己，直到 `value` 减到 0。

文件注释里专门解释了为什么这里不用 `Enum` 或 `for`：迭代本身会引入分配和函数调用，压测的不是存储而是 Enum。双层手写递归把开销压到最小，测出来的差才属于被测对象。

`Bench.run(module, opts)` 的两个关键参数：`concurrency` 决定起几个并发进程（默认 1），`num_updates` 决定每个进程把整段 key 重写几遍（默认 10）。key 总量固定一百万，除以 `concurrency` 得到每个进程分到的区间 `items_per_process`。

## 跑出来的数字差别在哪

进入 key_value 项目，执行 `mix deps.get` 和 `iex -S mix`，然后：

```elixir
iex> Bench.run(KeyValue)

142380 operations/sec

iex> Bench.run(EtsKeyValue)

1523341 operations/sec

iex> Bench.run(EtsKeyValue, concurrency: 10)

11053925 operations/sec
```

（数字依机器不同会有出入，看趋势不看绝对值。）

`KeyValue` 的吞吐基本不随 `concurrency` 变化。一百万次 put/get 全部排队进入一个 GenServer 的邮箱，外面压多少个进程，里面还是一次处理一条。

`EtsKeyValue` 的吞吐随并发明显上升，直到撞上 BEAM 调度器和内存总线的极限。

差别不在“ETS 是底层实现所以快”，而在排队模型：`KeyValue` 的瓶颈是单个进程的邮箱，`EtsKeyValue` 的写入分散到整张表，`:public` + `write_concurrency: true` 允许不同进程同时操作不同 key。

## 测量会骗人的几种方式

bench.ex 已经替你挡掉了几个坑：key 区间不重叠（不会把锁竞争误算成实现差）、双层递归不用 Enum（不把测量工具本身算进去）、`:timer.tc` 只包被测段（不含启动开销）。

它没挡掉的，你得自己注意：

- **预热**。刚启动的 VM 调度器和 ETS 表都在爬坡，第一组数字通常偏低。跑一次再丢一次，取后面的。
- **同环境**。换台机器、换个 Erlang 版本、换个负载背景，数字会变。比较要拿同一轮里的两个结果，不是两个日期里的。
- **数据规模**。一百万 key 的分布和十个 key 不同，hash 冲突、缓存行、GC 压力都不一样。拿 bench 当参数时，先确认规模跟你的场景同量级。
- **写比例**。这里每次操作是 put + get 一比一。真实读写比偏哪边，结论会跟着偏。

## 排队的延迟不是吞吐

回到第 6 章的 `process_bottleneck.ex`：一个每秒睡一秒的循环，接再多请求，吞吐也锁死在一秒一个。但它的响应时间可能远差于一秒——后面的请求在邮箱里排着队。

```elixir
receive do
  {caller, msg} ->
    Process.sleep(1000)
    send(caller, {:response, msg})
end
```

吞吐（每秒能完成多少）和延迟（一个请求等多久）是两条不同的曲线。GenServer 串行模型下，延迟会随并发线性变长；ETS 把并发摊开，延迟曲线才压得住。

这就是为什么压测报告里"每秒 X 次"不够，还得看分布：如果第十个请求等了十秒，平均吞吐好看也没用。

## 还有一个数字藏在测试里

key_value 项目自己的 `key_value_test.exs` 顺手给两种实现做了功能对照：

```elixir
test "key value" do
  KeyValue.start_link()
  KeyValue.put(:foo, 1)
  assert KeyValue.get(:foo) == 1
end

test "ets key value" do
  EtsKeyValue.start_link()
  EtsKeyValue.put(:foo, 1)
  assert EtsKeyValue.get(:foo) == 1
end
```

功能层面两者完全等价——`put` 后 `get` 都能拿到值。差别只出现在压测的那组数字里。

这也解释了为什么 `key_value` 项目把两种实现放在一起：API 一模一样，调用方无感知，性能特性天差地别。换实现的成本是"要不要改部署和监督关系"，不是"要不要改业务代码"。


## 测量之前先问对问题

bench.ex 这类工具的回答是“在这个写法下，谁更快”。它不会替你回答：

- 这个操作在你的系统里热吗？
- 访问模式是均匀还是几个 key 集中？
- 持久化、复制、崩溃恢复这些语义，快的那个实现给不给？

KeyValue 换成 EtsKeyValue，换来的是吞吐，丢掉的是顺序保证（不同进程的写入不再有单一仲裁点）和对崩溃后状态的直接控制。拿数字做决策之前，先确认你在比较的是同一组承诺。

## 动手验证

```elixir
Bench.run(KeyValue, concurrency: 1)
Bench.run(KeyValue, concurrency: 8)
Bench.run(EtsKeyValue, concurrency: 1)
Bench.run(EtsKeyValue, concurrency: 8)
Bench.run(EtsKeyValue, concurrency: 32)
```

观察 `KeyValue` 的数字是否基本不动，`EtsKeyValue` 的曲线在哪里开始变平。变平的位置大致反映你的调度器数量和内存带宽，不是代码的新瓶颈。

再试一组：把 `num_updates` 调到 1，百万 key 只写一遍。这时 ETS 的优势还在，但内存分配和冷启动的占比变高，差距比默认参数下小。

## 手写 bench 之外还有库

`bench.ex` 是把测量逻辑手写了一遍。同样的活交给 Benchee 库会更省事——它替你处理预热、多轮取统计量、偏差报告，输出也更规整：

```elixir
Benchee.run(%{
  "process kv" => fn -> KeyValue.put(:x, 1); KeyValue.get(:x) end,
  "ets kv"     => fn -> EtsKeyValue.put(:x, 1); EtsKeyValue.get(:x) end
})
```

跑完打印出来的表大概长这样：

```text
Name              ips      average   deviation   median     99th %
ets kv         8.42 K      118.7 μs   ±31.40%   103.2 μs    890.4 μs
process kv     0.14 K     7031.2 μs   ±12.10%  6890.5 μs   11230.0 μs

Comparison:
ets kv         8.42 K
process kv     0.14 K - 59.24x slower
```

列的含义：`ips` 是每秒调用次数，越高越好；`average`/`median` 是单次调用的平均/中位耗时；`deviation` 是标准差百分比，越大说明抖动越厉害；`99th %` 是最慢的那 1% 调用的耗时——平均好看但 99 百分位差很多时，说明尾部延迟比想象严重。

输出自带 warmup 轮（默认 2 秒）先热身，再计时 5 秒取统计量，正好踩中我们前面说的预热坑。

这个例子的跑法很简单：`mix.exs` 的 `deps` 加 `{:benchee, "~> 1.0", only: :dev}`，`mix deps.get`，然后把上面这段写进 `benchmark.exs`，`mix run` 就行。`only: :dev` 把它留在开发环境，不打进 release。

手写 bench 没有白写——它教会你"什么算进时间、什么不算"，这是读懂任何 benchmark 输出的前提。库只是把这个想法做扎实了。

**练习**：改 bench.ex，让每个进程只读写同一个 key（把区间改成 `start_item` 一个值）。这时 `EtsKeyValue` 还能随并发提升吗？再改一半进程只 `get`、一半只 `put`，看读写分离会不会改变曲线的形状。
