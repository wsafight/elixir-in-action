---
order: 4
title: 分支不止函数头
description: 模式匹配走不通的地方，交给 case、cond 和 with。顺便看看守卫能写什么、不能写什么。
part: 1
duration: 24
topics: [case, cond, with, 守卫, 短路]
samples:
  - { label: '数值分类（简单版）', path: code_samples/ch03/test_num.ex }
  - { label: '数值分类（带类型守卫）', path: code_samples/ch03/test_num2.ex }
  - { label: '用户字段提取（with 版）', path: code_samples/ch03/user_extraction.ex }
  - { label: '用户字段提取（汇总版）', path: code_samples/ch03/user_extraction_2.ex }
  - { label: '递归练习集', path: code_samples/ch03/recursion_practice.ex }
---

上一章把分支写在函数头上：一个函数好几个子句，谁匹配谁执行。这条路走不通的时候有两种，条件写在数据形状之外，比如大小比较；或者函数体中间要根据结果再分一次支。这一章补齐这三处。

## 守卫给函数头加条件

`test_num.ex` 判断一个数的符号：

```elixir
defmodule TestNum do
  def test(x) when x < 0, do: :negative
  def test(x) when x == 0, do: :zero
  def test(x) when x > 0, do: :positive
end
```

形状描述不了的约束，写在 `when` 后面。三个子句按顺序尝试，守卫不通过就试下一个。

旁边的 `test_num2.ex` 定义了同名模块，守卫里多了一句 `is_number(x)`：

```elixir
def test(x) when is_number(x) and x < 0, do: :negative
```

不带这句，`TestNum.test("abc")` 会直接抛异常：字符串和 `0` 也能比大小（Erlang 项有全局排序），但 `x < 0` 对字符串为假时守卫只是不通过，而 `x > 0` 对字符串竟然成立，`"abc"` 会被当成正数。加上 `is_number` 之后，非数字输入落到三个子句之外，报 `FunctionClauseError`，错误更早暴露。

两个文件都叫 `TestNum`，**一次只加载一个**，先加载的那个会被覆盖。

```sh
iex -r test_num2.ex
```

```elixir
TestNum.test(-3)    # :negative
TestNum.test("abc") # FunctionClauseError
```

守卫不是任意表达式。它只能用一小撮运算符和函数：`is_number`、`is_binary`、`and`、`or`、`>`、`length`、`elem` 这类。自己写的普通函数不能进守卫，守卫跑在函数头匹配阶段，要求快而且不能失败到一半。复杂校验放到函数体里。

## case 在函数体里继续匹配

函数头只能对入口参数分支，中间结果要分支就用 `case`：

```elixir
case File.read("todos.csv") do
  {:ok, contents} -> contents
  {:error, reason} -> "读不到：#{reason}"
end
```

这是教学实验，不是配套示例里的代码。`case` 和函数头子句共用同一套匹配规则：`File.read` 返回什么，就依次对到每一个分支的形状上，第一个匹配上的分支执行并给整个 `case` 定值。`{:ok, contents}` 这个分支的意思是"必须是一个两元素元组、第一项是 `:ok`，第二项交给 `contents`"；`{:error, reason}` 同理。哪一个都没匹配上，抛 `CaseClauseError`。

`->` 左边是形状，右边是这个分支返回的值。`#{reason}` 是字符串插值，把 `reason` 拼进文本，`"读不到：enoent"` 这种。

`case` 用在函数体中间，处理前面算出来的值；函数头只能对入口参数分支。写法不同，判断逻辑一回事。

`recursion_practice.ex` 里的 `positive/1` 展示了守卫和递归的合体：

```elixir
def positive([head | tail]) when head > 0 do
  [head | positive(tail)]
end

def positive([_ | tail]) do
  positive(tail)
end
```

头元素大于零就留下，否则跳过。守卫筛选、递归前进，两件事各归各的位置。

## cond 按条件而不是按形状走

`case` 匹配形状，`cond` 判断条件，一串布尔表达式，谁为真走谁。比如一个教学实验里的登录校验：

```elixir
defmodule LoginCheck do
  def check(user, password) do
    cond do
      is_nil(user) -> {:error, :user_not_found}
      user.password != password -> {:error, :wrong_password}
      user.locked -> {:error, :locked}
      true -> {:ok, user}
    end
  end
end
```

`cond` 的每一行左边是普通布尔表达式，不是模式。`is_nil(user)`、`user.password != password`、`user.locked` 自上而下逐个求值，第一个为真的分支胜出；全都为假就抛 `CondClauseError`，所以最后一行写 `true`，它永远成立，相当于 `else`。

条件之间没有共同的数据形状可匹配时，`cond` 比硬凑模式更清楚。不过能匹配就先匹配：`cond` 的分支互不相干，读起来要逐个想条件覆盖；函数头和 `case` 的分支共享一个值，排他关系一目了然。

顺便把两种循环也在这一页交代掉：Elixir 没有 `while` 和 `until`。"反复做"有两种写法，确定次数或确定数据的，交给 `Enum` 和递归函数；没有终点的，比如进程的消息循环，就是上一章那种永不返回的尾递归。`Enum.reduce_while` 处理"满足条件就提前停"的情形，返回值 `{:halt, acc}` 切断遍历。

`if`/`unless` 是 `cond` 的单分支写法：`if x > 0, do: :positive` 和只有一个条件的 `cond` 等价。真要用就写单个判断，出现第二个条件就换回 `cond`，`if` 套 `else` 再套 `else`，三层以后就没法读了。

## with 把依赖的一串步骤拉直

`user_extraction.ex` 要从一个 map 里取出 login、email、password 三个字段，任何一个缺失都算失败：

```elixir
def extract_user(user) do
  with {:ok, login} <- extract_login(user),
       {:ok, email} <- extract_email(user),
       {:ok, password} <- extract_password(user) do
    {:ok, %{login: login, email: email, password: password}}
  end
end
```

`with` 接的是一串 `<-`，每个 `<-` 的左边是模式、右边是表达式，看起来像在赋值，实际上每行都是一次匹配。`{:ok, login} <- extract_login(user)` 的意思是"调用 `extract_login`，结果必须匹配 `{:ok, login}`"。三步全对上，`do` 块里的最终值才是这个 `with` 的返回。

哪一行对不上，`with` 就停：不执行后面的步骤，整个表达式的值就是那个不匹配的结果本身。比如 `extract_email` 返回 `{:error, "email missing"}`，`with` 把第三个参数 `password` 跳过，直接把这个错误交出去。不用 `with`，同样的逻辑要嵌套三层 `case`，每一步的成功分支里写下一次匹配，主路径缩进越来越深，错误处理散在各层。

`with` 还能接 `else` 分支处理"某个步骤没匹配上"的情形，`else` 里写的就是各失败形状的分支，匹配哪个就走哪个，等于把失败也拉进模式匹配的地盘。没有 `else` 时，失败值原样返回，这就是当前版本的做法。

```sh
iex -r user_extraction.ex
```

```elixir
iex> UserExtraction.extract_user(%{"login" => "mike", "email" => "m@x.com", "password" => "pw"})
{:ok, %{login: "mike", email: "m@x.com", password: "pw"}}

iex> UserExtraction.extract_user(%{"login" => "mike"})
{:error, "email missing"}
```

传全了三个字段，三次匹配都过，返回 `{:ok, %{...}}`。只传 `login`，第二步 `extract_email` 返回 `{:error, "email missing"}`，`with` 短路，`password` 根本没轮到，`with` 的结果就是那个错误。错误信息只告诉你第一个出问题的字段。

## 同一个问题的第二种报错方式

`user_extraction_2.ex` 是同一个模块名 `UserExtraction` 的另一版实现，所以两个文件一次也只能加载一个，后加载的覆盖前一个，和第 3 章那对 `test_num` 是同一情况。思路完全换了：

```elixir
case Enum.filter(
       ["login", "email", "password"],
       &(not Map.has_key?(user, &1))
     ) do
  [] -> {:ok, %{login: user["login"], email: user["email"], password: user["password"]}}
  missing_fields -> {:error, "missing fields: #{Enum.join(missing_fields, ", ")}"}
end
```

拆开看：`Enum.filter` 在三个字段名里筛出"map 里没有的"，`&(not Map.has_key?(user, &1))` 对每个名字检查 map 里有没有这个键。结果交给 `case`：`[]` 说明三个字段全在，一次 `%{...}` 组装成功值；`missing_fields` 是缺了的字段名列表，`Enum.join` 拼进错误串。

先把缺的字段全找出来，一个不缺才组装结果，缺就一次列全。同样传 `%{"login" => "mike"}`，这版返回 `{:error, "missing fields: email, password"}`，对比上一版的 `{:error, "email missing"}`，这次调用者一次拿全了缺什么。

两版都对，报错的粒度不同：第一版适合逐步校验、每步错误要带上下文；第二版适合表单式输入，调用者一次拿全缺失清单再提示。写接口之前先想清楚调用者拿到 `{:error, _}` 之后要做什么，决定的是错误值的形状，不只是字符串。

## 动手验证

在示例文件所在目录：

```sh
iex -r test_num2.ex
iex -r user_extraction_2.ex
```

在两个 IEx 里分别试边界输入：非数字、空 map、字段全缺的 map。再试着给 `user_extraction.ex` 的 `with` 加第四步 `{:ok, age} <- extract_age(user)`，写一个小函数让 age 可选，`with` 里混进"可有可无"的步骤时，`case` 反而更清楚，体会一下边界。

**练习**：用 `cond` 重写 `user_extraction_2.ex` 的错误汇总，要求字段为空字符串 `""` 也算缺失；再想想：`with` 的 `else` 分支能把每个失败步骤归到各自的错误值，给 `extract_user` 加上 `else`，让三种缺失各报各的。
