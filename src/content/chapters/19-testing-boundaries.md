---
order: 19
title: 测进程、磁盘和 HTTP 边界
description: 测试越靠近边界越要小心：共享监督树、真实文件、不开端口的 HTTP，这一章处理"有副作用"的测试。
part: 3
duration: 26
topics: [setup_all, async, 测试隔离, 真实文件, Plug.Test]
samples:
  - {label: 缓存测试, path: code_samples/ch09/dynamic_workers/test/todo/cache_test.exs}
  - {label: HTTP 测试, path: code_samples/ch11/todo_web/test/http_server_test.exs}
  - {label: release HTTP 测试, path: code_samples/ch13/todo_release/test/http_server_test.exs}
  - {label: 测试入口, path: code_samples/ch11/todo_web/test/test_helper.exs}
---

上一章的测试测的是纯函数，`Todo.List`、`Geometry` 输入进去输出出来，和谁并行都安全。这一章的测试碰的是"活的东西"：已经在跑的监督树、真实的磁盘文件、HTTP 路由。副作用一进来，测试的写法就要跟着变。

## setup_all：给测试一个能用的系统

`dynamic_workers` 项目的 `test/todo/cache_test.exs` 开头很关键：

```elixir
setup_all do
  {:ok, todo_system_pid} = Todo.System.start_link()
  {:ok, todo_system_pid: todo_system_pid}
end
```

`setup_all` 在这个模块所有 test 之前跑一次，返回的上下文注入每个 test。`persistence` 测试里 `Process.exit(john, :kill)` 之后再查同名清单，断言的是数据真的从磁盘回来了，这件事只有在监督树已经启动的前提下才有意义。

`setup` 和 `setup_all` 的区别在执行次数：`setup` 每个 test 前都跑，`setup_all` 一个模块只跑一次。共享一套启动好的系统用 `setup_all`；每个 test 要干净数据时回到 `setup`，重建一遍便宜的状态。

## async 不是免费的

`cache_test` 没写 `async: true` 的原因是共享资源：测试起真实监督树、读写真实 `./persist` 目录，两个 `async: true` 的模块并行就会互相覆盖状态。`list_test` 可以 `async: true`，因为它只碰 `Todo.List` 这种纯函数，没有进程、没有文件，和谁并行都安全。判断能不能标 `async: true`，就看这个测试要不要碰"别人也想要的东西"。

这是测试隔离最容易被低估的地方：`async: true` 让测试跑得快，但前提是测试碰到的每份资源都是自己独占的。`./persist` 目录、注册到名字的进程、占用的端口，都是不能共享的典型。

## 测试会碰真实磁盘

`todo_web` 和 `todo_release` 项目的 `test/test_helper.exs` 都在 `ExUnit.start()` 之前加了一段：

```elixir
db_settings = Application.fetch_env!(:todo, :database)
db_folder = Path.join(Keyword.fetch!(db_settings, :db_folder), "nonode")
File.rm_rf!(db_folder)
File.mkdir_p!(db_folder)
```

它们读应用配置里的数据目录前缀，清掉再重建，避免上一次测试留下的文件污染断言。`todo_env` 的 `runtime.exs` 在 `:test` 环境用 `TODO_TEST_DB_FOLDER`，也是同一个目的：测试不该和开发共用 `./persist`。

这个段落的反面也要记住：`mix test` 会碰真实文件，别在 `mix test` 跑着的时候对同一个项目手动 `iex -S mix` 改东西，共享 `./persist` 的代价在两边都存在。

## 断言进程消息

`assert_receive` 的默认用法是"等一条消息进来"：

```elixir
test "server replies entries" do
  Todo.Server.entries(pid, ~D[2026-11-09])
  assert_receive {:todo_entries, _}, 1000
end
```

如果消息不来，1000ms 后断言失败。`assert_received` 不带等待，查一下邮箱有没有，用来断言"发完之后邮箱里不该有"也很方便。

监督树相关的断言更特殊：`Process.exit(john, :kill)` 之后不能立刻断言，因为重启需要时间。`cache_test.exs` 里用的是 `assert_eventually` 风格的等待，配套代码里对应 `assert_receive`/`Process.sleep` 配合的方式，核心都是"给失败留出恢复时间再断言"。

## 用 Plug.Test 测路由，不开端口

`todo_web` 和 `todo_release` 里的 `http_server_test.exs` 是同一套写法：

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

`import Plug.Test` 引入 `conn/3`，手工构造一个请求 `conn`：`conn(:get, "/entries?list=x&date=2018-12-19")` 返回一个 `%Plug.Conn{}`，方法、路径、query string 都填好。配套的 `get`/`post` 辅助函数再把它喂给 `Todo.Web.call/2`，这就是第 23 章会讲的"Plug 只需要 `init/1` 和 `call/2`"的好处，测试不需要网络就能完整走一遍路由。

断言的三段很清楚：`resp.status` 是 HTTP 状态码，`resp.resp_body` 是响应体字符串，`get(...)` 的返回值同型。整个用例没起 HTTP 服务器，没有端口监听，没有真正的 TCP。前面说的"共享 `./persist` 目录"那套注意事项也适用，所以这里也是 `async: false`。

这等于把路由层从网络里拆出来单独测：断言的是 Plug 管线对这个 `conn` 返回了什么，而不是浏览器能不能通。第 23 章会沿这条路继续，把错误响应的测试也补进去。

## 测试地图

| 测试对象 | 测试方式 | 例子 |
| --- | --- | --- |
| 纯函数（Todo.List、Geometry） | `test` + `assert`，可直接 `async: true` | `list_test.exs`、`tests.exs` |
| 脚本 `.ex` 文件 | `test_script` 宏，加载后卸模块 | 前几个章目录的 `tests.exs` |
| 有监督树的进程 | `setup_all` 起系统，断言跨重启行为 | `cache_test.exs` |
| HTTP 边界 | `Plug.Test` 构造 conn 调 router | `http_server_test.exs` |
| 全部测试回归 | `test_all.exs` 统一跑 | `test_all.exs` |

## 动手验证

在示例代码根目录运行 `elixir test_all.exs`，看一遍它扫过的测试数量。再单独进入 dynamic_workers 项目跑 `mix test --trace`，`cache_test` 和 `list_test` 会标出各自是同步还是异步执行，`--trace` 会把每个 test 的运行顺序打出来，能直观看出哪些在并行。

**练习**：为第 6 章的 `MultiDict` 写一个 `multi_dict_test.exs`，放在那个示例的 `test/` 目录下用 `elixir` 直接跑。断言 `add` 之后 `get` 返回倒序列表，再试空 key。然后给 `update_entry` 的编号保护补一个测试，验证传入改了 `id` 的 updater 时，行为符合你的约定。
