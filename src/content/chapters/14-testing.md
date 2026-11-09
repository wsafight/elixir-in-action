---
order: 14
title: 测试，从脚本到系统
description: 用 ExUnit 把前面散落的测试串起来：怎么断言、怎么隔离、怎么测一个进程，又怎么测整个 HTTP 边界。
part: 3
duration: 30
topics: [ExUnit, test_script, assert, setup_all, 测试隔离, Plug.Test]
samples:
  - {label: 脚本测试宏, path: code_samples/test_helper.exs}
  - {label: 早期脚本测试, path: code_samples/ch02/test/tests.exs}
  - {label: 全套测试入口, path: code_samples/test_all.exs}
  - {label: 缓存测试, path: code_samples/ch11/todo_web/test/todo/cache_test.exs}
  - {label: 清单测试, path: code_samples/ch11/todo_web/test/todo/list_test.exs}
  - {label: HTTP 测试, path: code_samples/ch11/todo_web/test/http_server_test.exs}
  - {label: release HTTP 测试, path: code_samples/ch13/todo_release/test/http_server_test.exs}
---

前面每个项目的 `test/` 目录里都有一批测试，但都分散在各章的语境里。这一章把它们当成一套完整的东西来看：ExUnit 怎么组织断言，整套示例怎么把散落各处的测试收进一次 `mix test` 或 `elixir` 调用。

## ExUnit 的最小骨架

任何测试文件都从三件套开始：`ExUnit.start()` 启动框架，模块里 `use ExUnit.Case` 声明测试模块，模块里用 `test "名字" do ... end` 写用例。Mix 项目会把 `ExUnit.start()` 放在 `test/test_helper.exs`，`mix test` 自动先加载它；单文件脚本要自己在文件顶部 `ExUnit.start()` 一次。

```elixir
ExUnit.start()

defmodule MyTest do
  use ExUnit.Case

  test "it works" do
    assert 1 + 1 == 2
  end
end
```

`mix test` 或直接 `elixir this_file.exs` 都会跑它。输出里一个点代表一个用例通过，`F` 或红色报告代表失败，失败时 ExUnit 会打出 `assert` 的左右两个值。

配套测试里最早的一份 `tests.exs`（第 2 章用过的那份）就从这套骨架出发，再多包了一层自己的宏：

```elixir
defmodule Test do
  use ExUnit.Case, async: false
  import TestHelper

  test_script "geometry" do
    assert 6 == Geometry.rectangle_area(3, 2)
  end
end
```

`use ExUnit.Case, async: false` 里 `async` 控制这个模块能不能和别的测试模块并行跑；`import TestHelper` 把 `test_script` 宏拿进来用。模块第一行 `Code.require_file("#{__DIR__}/../../test_helper.exs")` 是手动执行 `ExUnit.start()`——没有它，`test` 宏注册了却不会跑。

## test_script 宏：把脚本变成测试

`test_helper.exs` 里定义了一个很薄的宏：

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

逐行看展开后做了什么。`quote`/`unquote` 是 Elixir 的宏写法：外面这层 `quote` 把代码变成 AST 模板，里面的 `unquote` 把参数填进去。运行时干活的只有三行：

1. `Code.require_file(".../#{script_name}.ex")` 把被测脚本加载进来，返回这个文件定义了哪些模块
2. `try do ... after ... end` 包住断言块，保证无论断言成功失败，清理都会执行
3. `Enum.each(modules, ...)` 对每个加载进来的模块先 `:code.purge`（把运行中的代码版本踢出去）再 `:code.delete`（从 VM 里删掉），完全卸载

`test_script "geometry" do ... end` 展开后等于：加载 `../geometry.ex`，跑断言块，结束后把这个文件定义的模块全部卸掉。

卸载是为了隔离。前面几章反复提醒过：同目录下会有 `geometry.ex` 和 `geometry_invalid_input.ex` 都定义 `Geometry` 模块，一个测试加载了一份，下一个测试再加载就会被覆盖。测试跑完把模块清走，后面的 `test_script` 才能从干净状态开始。

而 `mix test` 项目不走这条路：`lib/` 下的模块编译一次就在 VM 里常驻，测试直接用，不需要 require_file，也就不需要卸载。这就是为什么 `test_script` 只出现在早期脚本测试里。

## 测试文件的两类写法

前几章用的就是这种 `test_script` 包装：被测的是 `.ex` 脚本，测试文件用 `elixir` 直接跑：

```sh
elixir test/tests.exs
```

`mix test` 项目里用的则是普通 `test` 宏，配合 `test/test_helper.exs` 里那行 `ExUnit.start()`，框架自动处理模块加载。

todo_web 项目里的 `test/todo/list_test.exs` 是典型的混合：模块里是纯函数 `Todo.List` 的断言，但它们跑在一个启动过监督树的环境里：

```elixir
test "empty list" do
  assert Todo.List.size(Todo.List.new()) == 0
end
```

`Todo.List` 不需要进程，可以直接测；一旦要测到 `Todo.Server` 或 `Todo.Cache`，就得先有监督树在跑。

`describe` 块可以把相关的 test 聚在一起，阅读时清楚，也给 `describe` 一级的 `setup` 留位置：

```elixir
describe "entries" do
  test "empty date returns empty list" do ...
  test "add then query returns the entry" do ...
end
```

## 断言的几个常用形状

`assert` 是最基本的：`assert result == 42`，失败时 ExUnit 报出左值右值。反向用 `refute`——"这个表达式一定是假的"，比 `assert not` 读起来更直接。

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

断言日志，用 `ExUnit.CaptureLog` 的 `capture_log`；断言 `IO.puts` 这类标准输出，用 `ExUnit.CaptureIO` 的 `capture_io`——它把输出接住返回成字符串，断言这段输出里有没有该出现的东西。

## setup_all：给测试一个能用的系统

dynamic_workers 项目的 `test/todo/cache_test.exs` 开头很关键：

```elixir
setup_all do
  {:ok, todo_system_pid} = Todo.System.start_link()
  {:ok, todo_system_pid: todo_system_pid}
end
```

`setup_all` 在这个模块所有 test 之前跑一次，返回的上下文会注入每个 test。`persistence` 测试里 `Process.exit(john, :kill)` 之后再查同名清单，断言的是数据真的从磁盘回来了——这件事只有在监督树已经启动的前提下才有意义。

`setup` 和 `setup_all` 的区别在执行次数：`setup` 每个 test 前都跑，`setup_all` 一个模块只跑一次。共享一套启动好的系统时用 `setup_all`；每个 test 要干净数据时回到 `setup`，重建一遍便宜的状态。

`cache_test` 没写 `async: true` 的原因是共享资源：测试起真实监督树、读写真实 `./persist` 目录，两个 `async: true` 的模块并行就会互相覆盖状态。`list_test` 可以 `async: true`，因为它只碰 `Todo.List` 这种纯函数——没有进程、没有文件，和谁并行都安全。判断能不能标 `async: true`，就看这个测试要不要碰"别人也想要的东西"。

## 测试会碰真实磁盘

todo_web 和 todo_release 项目的 `test/test_helper.exs` 都在 `ExUnit.start()` 之前加了一段：

```elixir
db_settings = Application.fetch_env!(:todo, :database)
db_folder = Path.join(Keyword.fetch!(db_settings, :db_folder), "nonode")
File.rm_rf!(db_folder)
File.mkdir_p!(db_folder)
```

它们读取应用配置里的数据目录前缀，清掉再重建，避免上一次测试留下的文件污染断言。`todo_env` 的 `runtime.exs` 在 `:test` 环境用 `TODO_TEST_DB_FOLDER`，也是同一个目的：测试不该和开发共用 `./persist`。

## 一个脚本扫完所有测试

`test_all.exs` 是统一的测试入口，在示例代码根目录下运行：

```sh
elixir test_all.exs
```

它做两件事：

- `Path.wildcard("./ch??/test/*.exs")` 找到所有用 `elixir` 直接跑的测试脚本，逐个 `System.cmd("elixir", [test_file])`。
- `Path.wildcard("./ch??/*/mix.exs")` 找到所有 Mix 项目，进去 `mix deps.get` 再 `mix test`。

失败通过 `{:error, output}` 传递，`run_while_ok` 遇到第一个错误就停，末尾非 0 退出码让 CI 能接住。

平时学习时，先跑当前章节的测试。整套 `test_all.exs` 跑下来要下载全部依赖、启动全部项目，时间和网络成本都明显更高。

## 用 Plug.Test 测路由，不开端口

todo_web 和 todo_release 里的 `http_server_test.exs` 是同一套写法：

```elixir
defmodule HttpServerTest do
  use ExUnit.Case, async: false
  import Plug.Test

  test "adding an entry" do
    resp = post("/add_entry?list=test_2&date=2018-12-19&title=Dentist")

    assert resp.status == 200
    assert resp.resp_body == "OK"
    assert get("/entries?list=test_2&date=2018-12-19").resp_body ==
             "2018-12-19 Dentist"
  end

  defp get(path) do
    Todo.Web.call(conn(:get, path), Todo.Web.init([]))
  end
end
```

`import Plug.Test` 引入 `conn/3`，手工构造一个请求 `conn`：`conn(:get, "/entries?list=x&date=2018-12-19")` 返回一个 `%Plug.Conn{}`，方法、路径、query string 都填好。配套的 `get`/`post` 辅助函数再把它喂给 `Todo.Web.call/2`——这就是第 16 章会讲的 "Plug 只需要 `init/1` 和 `call/2`" 的好处，测试不需要网络就能完整走一遍路由。

断言的三段很清楚：`resp.status` 是 HTTP 状态码，`resp.resp_body` 是响应体字符串，`get(...)` 的返回值同型。整个用例没起 HTTP 服务器，没有端口监听，没有真正的 TCP——第 14 章前面说的"共享 `./persist` 目录"那套注意事项也适用，所以这里也是 `async: false`。

这等于把路由层从网络里拆出来单独测：断言的是 Plug 管线对这个 `conn` 返回了什么，而不是浏览器能不能通。第 16 章会沿这条路继续，把错误响应的测试也补进去。

## 测试地图

| 测试对象 | 测试方式 | 例子 |
| --- | --- | --- |
| 纯函数（Todo.List、Geometry） | `test` + `assert`，可直接 `async: true` | `list_test.exs`、`tests.exs` |
| 脚本 `.ex` 文件 | `test_script` 宏，加载后卸模块 | 前几个章目录的 `tests.exs` |
| 有监督树的进程 | `setup_all` 起系统，断言跨重启行为 | `cache_test.exs` |
| HTTP 边界 | `Plug.Test` 构造 conn 调 router | `http_server_test.exs` |
| 全部测试回归 | `test_all.exs` 统一跑 | `test_all.exs` |

## 动手验证

在示例代码根目录运行 `elixir test_all.exs`，看一遍它扫过的测试数量。再单独进入 dynamic_workers 项目跑 `mix test --trace`，`cache_test` 和 `list_test` 会标出各自是同步还是异步执行。

**练习**：为第 5 章的 `MultiDict` 写一个 `multi_dict_test.exs`，放在那个示例的 `test/` 目录下用 `elixir` 直接跑。断言 `add` 之后 `get` 返回倒序列表，再试空 key。然后给第 5 章练习里写的 `update_entry` 编号保护补一个测试，验证传入改了 `id` 的 updater 时，行为符合你的约定。
