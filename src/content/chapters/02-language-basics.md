---
order: 2
title: 从表达式开始
description: 在 IEx 中建立最初的手感：表达式有返回值，数据不可变，函数由模块、名字与参数个数共同确定。
part: 1
duration: 22
topics: [IEx, 不可变数据, 模块, 函数, 模式匹配, atom]
samples:
  - { label: '矩形面积', path: code_samples/ch02/geometry.ex }
  - { label: '两个 arity 的矩形', path: code_samples/ch02/arity_demo.ex }
  - { label: '双入口计算器', path: code_samples/ch02/arity_calc.ex }
  - { label: '私有函数', path: code_samples/ch02/private_fun.ex }
---

学习一门语言，不一定要先记住所有类型。先回答两个问题：一段代码算出了什么？这个值接下来流向哪里？在 Elixir 里，表达式算出值，函数把值传下去，正好对应这两个问题。

## 在 IEx 里观察一个值

启动 `iex`，逐行执行，注意每行下面的返回值：

```elixir
iex> width = 3
3
iex> height = 4
4
iex> area = width * height
12
```

Elixir 里几乎所有东西都是表达式，表达式算完就是一个值，赋值也有返回值，`width = 3` 这行算出的值就是 `3`。函数体通常以最后一个表达式的结果作为返回值，所以简单函数不需要写 `return`。

再观察一个列表：

```elixir
iex> original = [1, 2, 3]
[1, 2, 3]
iex> extended = [0 | original]
[0, 1, 2, 3]
iex> {original, extended}
{[1, 2, 3], [0, 1, 2, 3]}
```

第二行把 `0` 接到 `original` 的头部，产出新列表 `extended`；`original` 本身没变。`|` 是"头与尾"的分隔符，`[x | rest]` 的意思是"第一个元素是 x，剩下的是 rest"。想往尾部加得用 `++`，比如 `original ++ [4]`，但链表往尾加要走到头，下一章会展开这个代价。

`{original, extended}` 是一组花括号包住的元组（tuple），固定几个位置的打包；最后一行的值就是这对新旧列表本身。这种"不改旧值、另算一份"的不可变性，后面会成为进程隔离和状态推理的地基。

## 常用数据先认一遍

几何函数之外，几个高频类型值得先在 IEx 里摸一遍：

```elixir
:ok                     # atom，常用作状态标签
{:ok, 42}               # 元组，固定大小的打包
[1, 2, 3]               # 链表，按下标访问要遍历
%{login: "a", age: 3}   # 映射，键值结构
```

`%{key: value}` 这种写法只给 atom 键用；普通键写 `%{1 => "one"}`。映射可以用 `map[:key]` 或 `Map.get` 取值，前者在键不存在时直接报错，后者允许给默认值。`map[:missing]` 是 `nil`，`Map.get(map, :missing, "fallback")` 是你自己说了算。

还有一种"列表装着元组"的形状叫 keyword list：`[name: "todo", port: 5454]` 等价于 `[{:name, "todo"}, {:port, 5454}]`，只是 atom 在前冒号紧贴。map 键值无序、键唯一；keyword list 有顺序、同一个键可以出现多次。函数的可选参数、配置项都长这样，后面 `mix.exs` 里的 `deps`、`Supervisor.start_link(children, strategy: :one_for_one)` 都是这个形状。

日期这类值有专门的符号。`~D[2026-11-09]` 是一个 `Date` 结构体，`~T` 是时间，`~N` 是日期时间。Todo 示例里的日期统一走 `~D` 与 `Date.from_iso8601`。

布尔值 `true`、`false` 本身是 atom。`and`、`or`、`not` 只接受布尔值；想容忍 `nil` 和别的真值，用 `&&`、`||`、`!`。

`@` 开头的是模块属性，写在模块顶部当常量或元数据用：`@moduledoc "..."` 是文档，`@db_folder "./persist"` 是常量，`@impl true` 标记"这是某个 behaviour 的回调实现"。第一次读到 `@xxx` 先分清它属于哪一种。

字符串值得单独说。双引号的 `"hello"` 不是字符数组，是一段 UTF-8 编码的二进制：`"héllo"` 里 `é` 占两个字节，`byte_size/1` 数的是字节，`String.length/1` 数的才是字符。单引号的 `'hello'` 是另一种类型 charlist，存的是码点列表，主要留给 Erlang 接口用，平时写字符串用双引号。`?Z` 取单个字符的码点，`<<>>` 语法按位组二进制，`s <> <<0>>` 能把一段字符串拼出它的原始字节。在 IEx 里试一次，"字符串是字节"这回事就看清了。

## 绑定名字，不是修改对象

Elixir 允许重新绑定一个变量：

```elixir
count = 1
count = count + 1
count
```

结果是 `2`。这并不意味着整数 `1` 被改成了 `2`，而是名字 `count` 在后续代码中指向了另一个值。不要把变量重新绑定和共享对象的原地修改混在一起。

`=` 还是匹配运算符。左边可以描述右边必须满足的形状：

```elixir
iex> {:ok, value} = {:ok, 42}
{:ok, 42}
iex> value
42
iex> {:ok, value} = {:error, :missing}
** (MatchError) no match of right hand side value: {:error, :missing}
```

第一行的 `=` 不是"赋值等于号"，是匹配，左边写下一个形状，让右边对上。`{:ok, value}` 的意思是"右边必须是一个两元素元组、第一个位置是 `:ok`，第二个位置叫什么我接管"。形状对上了，`value` 才被绑定。第二行查询就是 `42`。第三行右边变成了 `{:error, :missing}`，形状对不上，抛 `MatchError`，这就是"失败不是默默通过"。

`=` 的左边可以非常具体：`{_, value}` 用 `_` 跳过不关心的位置，`[head | tail]` 拆列表，`%{date: d}` 从 map 里抓 `:date` 键。当失败是正常业务结果时，下一章的多分支匹配比这种"要么成功要么崩"更合适。

## 从 Geometry 读懂一个模块

"矩形面积"示例 `geometry.ex` 的核心逻辑只有一个函数：

```elixir
defmodule Geometry do
  def rectangle_area(a, b) do
    a * b
  end
end
```

逐行拆：`defmodule` 开一个模块，模块名大写开头；`def` 在里面定义一个公开函数；`do ... end` 包住函数体，`a * b` 是最后一行，也就是返回值；两个 `end` 分别收尾函数和模块。整个文件读完，得到一个 `Geometry` 模块，里面只有一个函数 `rectangle_area/2`。

模块组织相关函数，也提供名字空间。调用 `Geometry.rectangle_area(3, 4)` 时，模块、函数名和参数数量一起决定目标，`Rectangle.area(3, 4)` 进不了 `Geometry`。

这里的参数没有写类型，不代表任何输入都能成功。乘法要求数字操作数。传入 `"3"` 会在运行时产生算术错误。后续可以通过模式、守卫、验证函数和测试，让输入约定更加明确。

## 参数个数也是函数身份

"两个 arity 的矩形"示例 `arity_demo.ex` 定义了两个 `Rectangle.area`：

```elixir
defmodule Rectangle do
  def area(a), do: area(a, a)
  def area(a, b), do: a * b
end
```

这一版是 `do:` 的单行写法，`do:` 和 `do ... end` 是同一个意思，一行的逻辑习惯写 `do:`，多行的写 `do ... end`，别当成两种语法。

`area/1` 与 `area/2` 是不同函数。`/1` 和 `/2` 表示 arity，也就是参数个数。调用 `Rectangle.area(5)` 时，先进入单参数版本，再由它调用双参数版本，最终得到 `25`。

这种写法把正方形视为特殊的矩形：入口可以方便，计算规则保持集中。`arity_calc.ex` 的 `Calculator.add/1` 和 `add/2` 使用了相同思路。

默认参数也能生成不同 arity 的函数入口，但阅读已有源码时，先数参数个数，比只看函数名更可靠。

## 小函数怎样接起来

管道运算符 `|>` 将左侧结果传给右侧函数的第一个参数：

```elixir
"  elixir  "
|> String.trim()
|> String.upcase()
```

结果是 `"ELIXIR"`。也就是数据依次经过两个变换步骤。每一行都接受一个输入，产出下一个输入。

管道并不自动并行，也不会创建新进程。它只改变表达式的书写顺序。到第三章处理文件流时，这种数据变换的写法会更加明显。

公开函数用 `def`，内部辅助函数用 `defp`。`private_fun.ex` 里，`double/1` 外部可以调，`sum/2` 写成 `defp`，IEx 里 `TestPrivate.sum(1, 2)` 会直接报 `UndefinedFunctionError`，外部只能走入口。读这个示例时，关注外部调用者需要知道什么，以及哪些步骤可以留在模块内部。好的边界会减少调用者需要理解的细节。

模块名可以带点号，`TodoList.CsvImporter` 就是 `TodoList` 和 `CsvImporter` 拼起来的 atom。点号不提供真正的层级，只是约定：读到 `Todo.Database` 时，它和 `Todo` 的关系体现在名字里，不在语言机制里。

## 匿名函数与成功的形状

不挂在模块上的函数写成 `fn ... end`：

```elixir
add = fn a, b -> a + b end
add.(2, 3)
```

调用匿名函数要在函数名和参数之间加点，`add.(2, 3)`，因为 `add` 是个变量，不是函数名。`fn` 里可以再套 `fn`，变量可以捕获外层作用域。简写形式 `&(a + b)` 里的 `&1`、`&2` 就是前几个参数，`add = &(&1 + &2)` 和上面的写法等价。

Elixir 表达成功与失败的习惯写法是 `{:ok, result}` 和 `{:error, reason}`。它们不是语法，只是调用者约定俗成的返回形状：调用方拿到结果先用模式匹配拆开，再决定往下走还是处理失败。`File.read` 就是这么返回的；后面第 4 章的 `with` 就是为这一串"要么成功、要么停住"的步骤准备的。

还有一类函数是"出了错就抛"的版本，名字后面加叹号：`File.read!` 拿不到文件会直接抛 `File.Error`，而不是返回 `{:error, reason}`。读代码时把这两个形状分开：`xxx` 返回普通值和错误值，`xxx!` 要么直接给结果、要么异常退出。

## 动手验证

在 `arity_demo.ex` 所在目录运行：

```sh
iex -r arity_demo.ex
```

在 IEx 里跑一次完整的会话（提示符 `iex>` 后面的都是你自己输的）：

```elixir
iex> Rectangle.area(4)
16
iex> Rectangle.area(4, 5)
20
iex> Rectangle.area(4, "5")
** (ArithmeticError) bad argument in arithmetic expression
```

前两行分别走 `area/1` 和 `area/2`，输出就是各自的返回值。第三行给 `area/2` 传了字符串，乘法拒绝运算，整个表达式抛 `ArithmeticError`，没有类型标注不等于什么都能传。

配套的 `tests.exs` 用 `elixir tests.exs` 直接跑，可以核对现有行为。

**练习**：在自己的临时文件中实现 `perimeter/1` 和 `perimeter/2`。先画出单参数版本到双参数版本的调用关系，再写函数。最后想一想：负数边长应该算出结果、返回错误，还是直接拒绝调用？这是输入约定问题，不是语法问题。

读到这里，你应该能够解释：重新绑定为什么不等于修改数据，以及 `Rectangle.area/1` 与 `Rectangle.area/2` 为什么是两个函数。
