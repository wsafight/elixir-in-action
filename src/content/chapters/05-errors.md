---
order: 5
title: 出错了怎么办
description: 输入不合法、文件不存在、日期解析失败。先学会 Elixir 的两种失败表达方式，再决定代码该用哪一种。
part: 1
duration: 24
topics: [错误值, ok/error 元组, 异常, raise, try/rescue, 输入验证]
samples:
  - {label: 带兜底的面积计算, path: code_samples/ch03/geometry_invalid_input.ex}
  - {label: 数值分类（带类型守卫）, path: code_samples/ch03/test_num2.ex}
  - {label: 分数结构体, path: code_samples/ch04/fraction.ex}
  - {label: CSV 导入器, path: code_samples/ch04/todo_import.ex}
---

第 2 章见过两次失败：`Rectangle.area(4, "5")` 抛了 `ArithmeticError`，`{:ok, value} = {:error, :missing}` 抛了 `MatchError`。它们都是异常，代码走到这里停了，堆栈往上抛。但 Elixir 里还有另一种失败：函数正常返回，返回值自己写着"我没成功"。这两种失败在书里会反复碰到，先分清它们。

## 第一种失败：返回值本身就是错误

`geometry_invalid_input.ex` 给面积计算加了第四种情况：

```elixir
def area(unknown) do
  {:error, {:unknown_shape, unknown}}
end
```

不认识的形状不抛异常，返回 `{:error, {:unknown_shape, unknown}}`。调用方拿到的不是崩溃，是一个可以继续往下传的普通数据。这就是 `{:ok, result}` / `{:error, reason}` 约定的全貌：成功和失败都是返回值，调用者用模式匹配或 `case` 分路。

标准库里到处都是这个形状：

```elixir
iex> File.read("不存在.txt")
{:error, :enoent}
iex> Date.from_iso8601("2026-13-45")
{:error, :invalid_date}
iex> Map.fetch(%{a: 1}, :b)
:error
```

`Map.fetch` 的形状稍有不同：失败是 `:error`，成功是 `{:ok, value}`。第 6 章 `update_entry` 里 `case Map.fetch(...)` 写的就是这两个分支。读别人的代码先看返回值约定：返回 `{:ok, x}`/`{:error, r}`、`:ok`/`:error`、还是直接给值？

错误值适合"调用者预期会失败、需要自己决定怎么办"的场景。一个用户名是否已被占用，文件是否已存在，这些是业务问题，不是事故。

## 第二种失败：异常中断当前计算

`todo_import.ex` 的 `create_entries` 里写着：

```elixir
date = Date.from_iso8601!(date_string)
```

注意叹号。`from_iso8601` 返回 `{:ok, date}` 或 `{:error, _}`，`from_iso8601!` 要么直接给出 `Date`，要么抛 `ArgumentError` 中断整个函数。CSV 导入器选了叹号版，判断依据很直接：一行日期坏了，整个导入就不该继续。这不是"某条数据没查到"，是输入文件本身不合格。

`Fraction.value/1` 也是这个选择：

```elixir
def value(%Fraction{a: a, b: b}) do
  a / b
end
```

`b` 是 `0` 时没有分支、没有返回值约定，直接撞 `ArithmeticError`。这不是疏忽。`Fraction.new(1, 0)` 本来就不该被构造出来，构造它的人犯了错，让错的人负责比替所有调用者兜底更诚实。

两种失败的区别一句话：错误值是正常结果的一种，异常是"这不该发生"。选哪个不看怕不怕崩，看"这个失败属不属于本函数的约定"。

## 两种失败在边界处相遇

一个模块对外给约定（错误值），对内允许异常，是很常见的分层：

```elixir
def entries(todo_list, date_string) do
  case Date.from_iso8601(date_string) do
    {:ok, date} -> {:ok, query_entries(todo_list, date)}
    {:error, _} -> {:error, :invalid_date}
  end
end
```

HTTP 边界上就全是这种写法。第 23 章会看到路由把 `Map.fetch!` 的异常挡在外面，换成 400。边界内部随便抛，边界对外只给错误值，这样调用者永远拿到可处理的东西。

异常本身用 `try/rescue` 能接住，但配套示例里几乎没有，因为接异常不是主流姿势。需要接住外部不稳定因素（网络、第三方库）时写法是：

```elixir
try do
  risky_operation()
rescue
  e in ArgumentError -> {:error, e.message}
end
```

更常见的惯用做法是尽量不接，异常往上走，走到进程边界，交给第 13 章讲的监督者处理。`try/after` 更常用：不救结果，只保证清理一定执行，第 18 章 `test_script` 卸载模块就用的它。

## 让坏输入在更早的地方停下

`test_num2.ex` 的守卫就是一种提前拒绝：

```elixir
def test(x) when is_number(x) and x < 0, do: :negative
```

`when` 把"参数必须是什么"写在函数头上，不满足守卫的调用连函数体都进不去，直接 `FunctionClauseError`。守卫能写 `is_number`、`is_atom`、`is_binary`、`> < >= <=` 这类检查，不能写自定义函数。它管的是参数形状，不是业务规则。

什么时候用哪种手段，可以粗略这样排：

| 失败来源 | 处理方式 |
| --- | --- |
| 参数形状不对（传字符串给数学函数） | 守卫 + 函数头匹配，失败即 `FunctionClauseError` |
| 业务可预期的失败（文件不存在、名字被占） | `{:error, reason}` 返回值 |
| 本不该发生的编程错误（除零、非法日期格式） | 叹号函数 / 不处理，让异常发生 |
| 整个子系统的失败 | 留给进程边界，第 13 章 |

## 动手验证

```sh
cd code_samples/ch03
iex -r geometry_invalid_input.ex
```

```elixir
iex> Geometry.area({:circle, 3})
28.26
iex> Geometry.area({:triangle, 1, 2, 3})
{:error, {:unknown_shape, {:triangle, 1, 2, 3}}}
iex> Geometry.area(nil)
{:error, {:unknown_shape, nil}}
```

返回错误值的好处在这里：调用者可以继续写 `case` 决定怎么办，而不是被异常打断。

再看一个反例。同样的目录下，`iex -r todo_import.ex` 配合一个不存在的文件：

```elixir
iex> TodoList.CsvImporter.import("不存在.csv")
** (File.Error) could not read file ...
```

`File.stream!` 和 `from_iso8601!` 一路向上抛。对"导入一份文件"这个动作来说，文件都不存在，确实没有可继续的路径。

**练习**：给 `Fraction` 的 `new/2` 加守卫，让 `Fraction.new(1, 0)` 在构造时就失败，而不是到 `value/1` 才除零。再写一版 `safe_value/1`，分母为零时返回 `{:error, :zero_denominator}`，体会"约定内失败"和"约定外失败"的分界线在哪。
