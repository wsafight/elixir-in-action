---
order: 18
title: 测试，从脚本开始
description: 先用 ExUnit 写出第一个断言，再看配套代码怎么用一层薄宏把 .ex 脚本也变成测试。
part: 3
duration: 22
topics: [ExUnit, test, assert, test_script, 模块隔离]
samples:
  - {label: 脚本测试宏, path: code_samples/test_helper.exs}
  - {label: 早期脚本测试, path: code_samples/ch02/test/tests.exs}
  - {label: 递归练习测试, path: code_samples/ch03/test/tests.exs}
  - {label: 全部测试入口, path: code_samples/test_all.exs}
---

前面每个章目录里都有一批测试，但散落在 `.exs` 脚本里，没有被集中讲过。这一章先把 ExUnit 这个框架本身认清：怎么写一个能跑的测试，断言失败长什么样，以及配套代码里那个 `test_script` 宏到底替我们做了什么。

## ExUnit 的最小骨架

任何测试文件都从三件套开始：`ExUnit.start()` 启动框架，模块里 `use ExUnit.Case` 声明测试模块，模块里用 `test "名字" do ... end` 写用例。

```elixir
ExUnit.start()

defmodule MyTest do
  use ExUnit.Case

  test "it works" do
    assert 1 + 1 == 2
  end
end
```

`mix test` 或直接 `elixir this_file.exs` 都会跑它。输出里一个点代表一个用例通过，`F` 或红色报告代表失败，失败时 ExUnit 会打出 `assert` 的左右两个值，左值是你断言的表达式，右值是期望值，对比是排错的第一手信息。

Mix 项目会把 `ExUnit.start()` 放在 `test/test_helper.exs`，`mix test` 自动先加载它；单文件 `.exs` 脚本要自己在文件顶部调用一次。少了这行，`test` 宏注册了却不跑，这是新手最常踩的坑。

## test_script 宏：把 .ex 文件也变成测试

配套代码里最早的一份 `tests.exs`（第 2 章用过的那份）包了一层自己的宏：

```elixir
defmodule Test do
  use ExUnit.Case, async: false
  import TestHelper

  test_script "geometry" do
    assert 6 == Geometry.rectangle_area(3, 2)
  end
end
```

`test_script` 定义在 `test_helper.exs` 里，展开后干的事只有三步：

```elixir
defmacro test_script(script_name, opts) do
  quote do
    test unquote(script_name) do
      modules = Code.require_file("#{__DIR__}/../" <> unquote(script_name) <> ".ex")

      try do
        unquote(opts[:do])
      after
        Enum.each(modules, &:code.purge(elem(&1, 0)))
        Enum.each(modules, &:code.delete(elem(&1, 0)))
      end
    end
  end
end
```

`quote`/`unquote` 是宏的写法，先不拆；运行时真正干活的只有三行：

1. `Code.require_file(".../#{script_name}.ex")` 把被测脚本加载进来，返回它定义了哪些模块
2. `try do ... after ... end` 包住断言块，`after` 保证无论断言成败，清理都执行
3. `Enum.each(modules, ...)` 对每个加载进来的模块先 `:code.purge` 再 `:code.delete`，从 VM 里完全卸掉

`test_script "geometry" do ... end` 展开后等于：加载 `../geometry.ex`，跑断言块，结束后把这个文件定义的模块全部卸掉。

为什么要卸载？前几章反复提醒过：同目录下会有 `geometry.ex` 和 `geometry_invalid_input.ex` 都定义 `Geometry` 模块，一个测试加载了一份，下一个测试再加载就会被覆盖。测试跑完把模块清走，后面的 `test_script` 才能从干净状态开始。Mix 项目不走这条路：`lib/` 下的模块编译一次就在 VM 里常驻，测试直接用，不需要 require_file，也就不需要卸载。这就是为什么 `test_script` 只出现在早期脚本测试里。

`import TestHelper` 让 `test_script` 宏能在本模块里用；`use ExUnit.Case, async: false` 里 `async` 控制这个模块能不能和别的测试模块并行跑，共享同一个文件系统或模块名字的测试不能并行。

## 断言的几个常用形状

`assert` 是最基本的：`assert result == 42`，失败时 ExUnit 报出左值右值。反向用 `refute`，"这个表达式一定是假的"，比 `assert not` 读起来更直接。

想断言错误被抛出，用 `assert_raise`：

```elixir
test "missing shape raises" do
  assert_raise FunctionClauseError, fn ->
    Geometry.area({:triangle, 1, 2, 3})
  end
end
```

要断言一条消息真的送到了，用 `assert_receive`（可带超时），或不等就查邮箱的 `assert_received`：

```elixir
test "server replies entries" do
  TodoServer.entries(pid, ~D[2026-11-09])
  assert_receive {:todo_entries, _}, 1000
end
```

断言日志，用 `ExUnit.CaptureLog` 的 `capture_log`；断言 `IO.puts` 这类标准输出，用 `ExUnit.CaptureIO` 的 `capture_io`，它把输出接住返回成字符串，断言这段输出里有没有该出现的东西。

配套里 `ch02/test/tests.exs` 到 `ch06/test/tests.exs` 用的都是 `test_script` 这一套：被测的是 `.ex` 脚本，测试文件用 `elixir` 直接跑：

```sh
cd code_samples/ch02
elixir test/tests.exs
```

每个文件可以独立执行，本章的例子都不需要 Mix 项目环境。`test_all.exs` 把它们收进一次调用：`Path.wildcard("./ch??/test/*.exs")` 找到所有 `elixir` 测试脚本，逐个 `System.cmd("elixir", [test_file])`；`Path.wildcard("./ch??/*/mix.exs")` 找到所有 Mix 项目，进去 `mix deps.get` 再 `mix test`。失败通过 `{:error, output}` 传递，`run_while_ok` 遇到第一个错误就停。

## 动手验证

```sh
cd code_samples/ch03
elixir test/tests.exs
```

输出里每个 `test_script` 对应一个点；断言失败的用例打出 `assert` 的左右值对比。

**练习**：给第 6 章的 `TodoList` 写一个 `list_test.exs`，放在 `test/` 目录下用 `elixir` 直接跑。断言 `add_entry` 之后 `entries` 返回包含该条目的列表，再断言 `entries` 按日期过滤、空日期返回空列表。
