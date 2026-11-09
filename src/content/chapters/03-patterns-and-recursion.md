---
order: 3
title: 模式匹配与数据流
description: 让数据的形状决定代码的路径，再用递归、Enum 和 Stream 表达一连串清晰的变换。
part: 1
duration: 32
topics: [模式匹配, 守卫, 递归, 尾递归, Enum, Stream, for 推导]
samples:
  - { label: '多形状面积', path: code_samples/ch03/geometry.ex }
  - { label: '数值分类（简单版）', path: code_samples/ch03/test_num.ex }
  - { label: '数值分类（带类型守卫）', path: code_samples/ch03/test_num2.ex }
  - { label: '递归练习集', path: code_samples/ch03/recursion_practice.ex }
  - { label: '倒序打印自然数', path: code_samples/ch03/natural_nums.ex }
  - { label: '求和递归', path: code_samples/ch03/sum_list.ex }
  - { label: '求和尾递归', path: code_samples/ch03/sum_list_tc.ex }
  - { label: '文件行流练习', path: code_samples/ch03/enum_streams_practice.ex }
---

很多程序花了大量代码判断“我收到的是什么”。在 Elixir 中，可以把这种判断放到函数入口。函数头不只是列出参数，还描述它接受的数据形状。

## 让函数头描述情况

"多形状面积"示例 `geometry.ex` 为不同形状定义了不同的 `area/1` 分支。同一个函数名写了三遍，每一遍叫一个函数子句（clause）：

```elixir
def area({:rectangle, a, b}), do: a * b
def area({:square, a}), do: a * a
def area({:circle, r}), do: r * r * 3.14159
```

逐行看：每个 `def` 的参数位置不是变量名，而是一个"必须长成这样"的形状。`{:rectangle, a, b}` 要求传进来的是三元素元组、第一项必须是 atom `:rectangle`，对上以后 `a` 和 `b` 才拿到值。`{:square, a}` 是两元素元组，`{:circle, r}` 也是。三个子句共用一个名字 `area/1`，靠的是输入的形状区分走哪一支。

矩形、正方形、圆形分别写成带标签的元组——第一位置是 atom 当标签，后面跟该形状需要的边：

```elixir
{:rectangle, 3, 4}
{:square, 5}
{:circle, 2}
```

调用 `Geometry.area({:circle, 2})` 时，三个子句从上往下试：第一个形状对不上（第二个子句才两元素），第二个子句要求 `{:square, _}` 也对不上，落到第三个，`r` 绑成 `2`。多个函数子句按定义顺序尝试匹配，将具体情况写在前面、宽泛的兜底放在后面。如果都不匹配，就会出现 `FunctionClauseError`。

配套的 `geometry_invalid_input.ex` 选择返回 `{:error, {:unknown_shape, unknown}}`。未知输入究竟是调用错误，还是预期内的失败？函数接口应该明确表达自己的选择。

## 守卫进一步限制输入

模式擅长检查结构，守卫擅长增加有限的条件。`test_num.ex` 用守卫写数值分类：

```elixir
def test(x) when x < 0 do
  :negative
end

def test(x) when x == 0 do
  :zero
end

def test(x) when x > 0 do
  :positive
end
```

`when` 是守卫，接在函数头后面、函数体之前，把"形状以外"的条件补上：这里的参数 `x` 可以是任意类型，但 `x < 0` 必须成立才进这个子句。三个子句从上到下试，`"abc"` 走到 `x < 0` 失败（守卫不通过不是异常，是换下一个子句），`x == 0` 也失败，落在 `x > 0`——字符串比数字大，会被当成正数。

`test_num.ex` 和 `test_num2.ex` 的差别值得停一下：后者给每个边界条件都加了 `is_number(x)`。这不是代码重复，而是在回答"非数字进来怎么办"——第一个版本假设了调用方只传数字。

守卫只允许一组受限操作，`is_number`、`>`、`<`、`and` 这类。不能在里面调用普通业务函数。复杂的验证应该放进函数体，用 `case` 或 `with` 组织——下一章专门讲它们。

## 先把匹配写顺手

函数头匹配之前，先把 `=` 当成匹配运算符用顺。`=` 左边不是"赋值目标"，而是一个待匹配的形状：

```elixir
{:ok, contents} = {:ok, "abc"}
[head | tail] = [1, 2, 3]
%{login: name} = %{login: "mike", age: 3}
```

三行都成立：`contents` 得到 `"abc"`，`head`/`tail` 拆出 `1` 和 `[2, 3]`，`name` 是 `"mike"`。左边写死的那部分（`:ok`、`%{login: _}`）必须和右边一致，否则 `MatchError`。已绑定的变量想再参与匹配要加 `^`，`^name = "mike"` 是断言而不是重新赋值。

列表匹配还有几种常用形状：`[a, b | rest]` 取前两个加尾部，`[single]` 只接受单元素列表，`[x | _]` 丢掉尾部。函数头写 `[head | tail]` 是这些形状的入口用法。

## 把列表拆成头和尾

列表 `[1, 2, 3]` 可以匹配成 `[head | tail]`，其中 `head` 是 `1`，`tail` 是 `[2, 3]`。空列表单独处理，非空列表就继续处理更短的尾部。

`sum_list.ex` 的递归正是这个结构：

```elixir
def sum([]), do: 0

def sum([head | tail]) do
  head + sum(tail)
end
```

两行就讲完了求和。第一行是终止条件：列表空了就返回 `0`。第二行处理非空列表，`[head | tail]` 把列表拆成"第一个元素 + 剩下所有"，`sum(tail)` 对更短的列表继续调用自己，最后把头部加回来。

跑一次 `sum([1, 2, 3])` 看展开过程——每一步都只剩一个更小的问题：

```text
sum([1, 2, 3])
= 1 + sum([2, 3])
= 1 + (2 + sum([3]))
= 1 + (2 + (3 + sum([])))
= 1 + (2 + (3 + 0))
= 6
```

每步调用都等下一层算完才轮到自己加。列表有几层就嵌几层调用，最后那个 `0` 停住递归。**递归要有终止条件，也要在每一步靠近终止条件。**

链表从头部拆取和插入很自然，按位置访问则需要遍历。若不断使用 `result ++ [item]` 往尾部追加，可能反复走过已有结果。累积到头部、最后反转一次，通常更符合链表的结构。

## 再看几个递归练习

`recursion_practice.ex` 里还有三个小递归函数。`list_len` 数长度，和 `sum` 一样"每剥一层头加一"；`range` 构造 `[from | range(from + 1, to)]`，每步往列表头部接一个新元素；`positive` 用守卫过滤，只有 `head > 0` 才把它留下。三个函数形状相同：空列表给终止值，非空列表拆头再处理尾部。

`natural_nums.ex` 递到另一面：先递归到 `1`，再一路 `IO.puts` 打回来。输出顺序是 1 到 n，不是 n 到 1。追踪一次 `print(3)` 就能看见：递归先走到最深那一层，返回值再顺着调用栈一个个回来。

这些练习不必背下来。只需要记住形状：终止条件先写，递减的输入接着写，每步要么缩小问题、要么完成一步动作。

## 尾递归把中间结果带在身上

`sum_list_tc.ex` 增加了累加器：

```elixir
def sum(list), do: do_sum(0, list)

defp do_sum(current_sum, []), do: current_sum

defp do_sum(current_sum, [head | tail]) do
  new_sum = head + current_sum
  do_sum(new_sum, tail)
end
```

三行都在做同一件事的不同写法：`sum/1` 是入口，把所有工作转交给私有函数 `do_sum/2`，并塞了一个初始值 `0`——这个 `0` 就是累加器，一路往下带着跑。`do_sum` 的两个子句：列表空了就返回累加器（算完了）；非空就拆头、更新累加器、递归尾巴。

和上一节的差别在最后一行：`sum_list.ex` 是 `head + sum(tail)`，递归回来还要做加法，每一层都得等；这里最后一行就是 `do_sum(new_sum, tail)` 本身，函数执行完这行就结束了，不用留任何东西等返回——这就是尾递归。这种形式尤其适合没有终点的进程循环。

但不要把“所有递归都必须改成尾递归”当成规则。可读性、数据构造方式和实际测量都该考虑。多数时候 `Enum` 已经足够清楚。

## Enum 立即处理，Stream 描述处理

能用 `Enum` 写清的地方，一般不自己写递归。`Enum.map` 对每个元素做变换、`Enum.filter` 留下满足条件的、`Enum.reduce` 把集合折叠成一个值——三个能组合出大部分列表操作：

```elixir
[1, 2, 3, 4] |> Enum.map(&(&1 * 2))           # [2, 4, 6, 8]
[1, 2, 3, 4] |> Enum.filter(&(rem(&1, 2) == 0)) # [2, 4]
[1, 2, 3, 4] |> Enum.reduce(0, &+/2)           # 10
```

`for` 推导是另一种写法：`for x <- list, x > 0, do: x * 2` 等价于"过滤再 map"。`x <- list` 是生成器，后面跟过滤条件；生成器还能直接做模式匹配，`for {:ok, v} <- [ok: 1, error: 2], do: v` 只挑出 `:ok` 的项。想产出列表以外的东西加 `into:`，`for {k, v} <- kw, into: %{}, do: {k, v}` 把关键字列表收成 map。短变换用推导更清楚，链长了还是 `|>` 好读。

`enum_streams_practice.ex` 从 `File.stream!()` 开始读取文件，再去掉每行末尾的换行符。`Stream.map` 构建惰性变换，直到有消费者枚举它时才执行。

`lines_lengths!/1` 最后调用 `Enum.map`，因此返回一个长度列表。`longest_line_length!/1` 先构建长度流，再用 `Enum.max` 消费整个流。所谓惰性，并不意味着求最大值可以不看全部输入。

```sh
iex -r enum_streams_practice.ex
```

然后执行（示例目录下带一份 `test_file`）：

```elixir
EnumStreams.lines_lengths!("test/test_file")
EnumStreams.words_per_line!("test/test_file")
```

预期分别是 `[3, 7, 11]` 和 `[1, 2, 3]`。`String.length` 数的是字符，不是 UTF-8 的字节数；涉及中文时，别拿 `byte_size` 当字符长度用。

## 动手验证

先用 `elixir tests.exs` 跑配套的测试文件。再为你自己的文件试试最长行查询。如果文件为空，`Enum.max/1` 没有最大值可返回，示例会抛出错误。这是这个实现需要留意的输入边界。

**练习**：给空文件制定一个返回约定：`nil`、`0`，还是 `{:error, :empty_file}`？先决定调用者怎么处理，再实现。接着用 `Stream.filter` 去掉空白行，注意这样会改变“每行词数”的结果与原始行号之间的对应关系。

回看本章，先看数据的形状，再找终止条件，最后确认数据在哪个步骤被真正消费。下一章把"分支和失败"从函数头里再拆出来，讲 `case`、`cond`、`with` 的分工。
