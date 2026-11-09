---
order: 15
title: 把系统做成一个应用
description: 用 OTP Application 统一启动，用 Poolboy 换一套工作池模型，再把 HTTP 边界接进来，最后把环境差异交给配置。
part: 4
duration: 32
topics: [Application, mod 启动回调, Poolboy, transaction, Plug, 运行时配置]
samples:
  - {label: todo_app·应用入口, path: code_samples/ch11/todo_app/lib/todo/application.ex}
  - {label: todo_app·项目配置, path: code_samples/ch11/todo_app/mix.exs}
  - {label: todo_poolboy·数据库路由, path: code_samples/ch11/todo_poolboy/lib/todo/database.ex}
  - {label: todo_poolboy·worker, path: code_samples/ch11/todo_poolboy/lib/todo/database_worker.ex}
  - {label: todo_web·路由, path: code_samples/ch11/todo_web/lib/todo/web.ex}
  - {label: todo_env·运行时配置, path: code_samples/ch11/todo_env/config/runtime.exs}
---

前面的系统已经有监督树，却需要在 IEx 里手动调用 `Todo.System.start_link()`。本章让"启动应用"变成一个统一的动作，再换一套工作池模型，接进 HTTP，最后把环境差异从代码里挪出去。

## Application 回调返回顶层监督者

`todo_app` 项目的 `Todo.Application` 很短：

```elixir
defmodule Todo.Application do
  use Application

  @impl Application
  def start(_, _) do
    Todo.System.start_link()
  end
end
```

配套的 `mix.exs` 在 `application/0` 里声明：

```elixir
def application do
  [
    extra_applications: [:logger],
    mod: {Todo.Application, []}
  ]
end
```

`mod: {Todo.Application, []}` 告诉 OTP：启动这个应用时，调用 `Todo.Application.start(:normal, [])`，它必须返回 `{:ok, pid}`，这个 pid 就是顶层 supervisor。从这棵树的根往下，所有进程都被当作这个应用的一部分。`extra_applications: [:logger]` 让 `:logger` 应用在 `:todo` 启动之前先启动——`IO`/`Logger` 的输出就靠它。

编译时，Mix 还会为每个应用生成一个 `todo.app` 资源文件（在 `_build/.../lib/todo/ebin/` 下），里面记录模块列表、依赖的应用、`mod:` 参数。`Application.started_applications/0` 在 IEx 里能看到当前跑着的所有应用：

```elixir
iex> Application.started_applications() |> Enum.map(&elem(&1, 0))
[:logger, :kernel, :stdlib, :elixir, :todo, ...]
```

进入 todo_app 项目，执行 `mix deps.get` 和 `iex -S mix`，这次不用手动调 `Todo.System.start_link()`——`iex -S mix` 会先启动应用，监督树自己就起来了。再手动调一次会得到 `{:error, {:already_started, ...}}` 之类的冲突，名字已经被占。

`mix.exs` 里还有一行 `start_permanent: Mix.env() == :prod`，控制应用停止时是否拉起整个 BEAM。开发环境保持默认值，prod 才要 permanent——这是后面发布章再展开的事情，先知道开关在 `mix.exs` 里。

## 依赖怎么进 mix.exs

`todo_poolboy` 的 `deps` 里多了一行：

```elixir
defp deps do
  [
    {:poolboy, "~> 1.5"},
    ...
  ]
end
```

每个依赖是一个 `{包名, 版本约束}` 元组。`~> 1.5` 允许 1.x 的最新补丁和小版本，不允许跳到 2.x。`mix deps.get` 按这个列表从 Hex 拉代码，`mix deps.tree` 能看到间接依赖。写完 `deps` 之后跑一次 `deps.get`，编译产物才会出现在 `_build` 里，`iex -S mix` 才能加载到。

## 换一个池模型：Poolboy 的借和还

第 9 章的工作池按 key 哈希选固定 worker：`:erlang.phash2(key, 3)` 决定一个 key 永远去同一个 worker。`todo_poolboy` 项目换了思路，用 Poolboy 库管理一组通用 worker：

```elixir
def child_spec(_) do
  File.mkdir_p!(@db_folder)

  :poolboy.child_spec(
    __MODULE__,
    [
      name: {:local, __MODULE__},
      worker_module: Todo.DatabaseWorker,
      size: 3
    ],
    [@db_folder]
  )
end
```

`Todo.Database` 自己不再 `use GenServer`，它的 `child_spec/1` 返回的是 Poolboy 的监督规格：3 个 `Todo.DatabaseWorker`，池注册在 `Todo.Database` 这个名字下。

调用方用 `:poolboy.transaction` 借一个 worker：

```elixir
def store(key, data) do
  :poolboy.transaction(
    __MODULE__,
    fn worker_pid -> Todo.DatabaseWorker.store(worker_pid, key, data) end
  )
end
```

transaction 期间独占一个 worker，函数返回就归还。它的底层就是两个动作：`:poolboy.checkout` 从池里拿一个 PID，`:poolboy.checkin` 用完还回去；`transaction` 只是包了个壳，帮你在异常时也保证归还。worker 每次拿到的 key 可能不同——这个池不关心"同 key 同 worker"，它只保证同时最多三个数据库操作。

两种池模型解决的不是同一个问题：

| 模型 | 保证 | 适合 |
| --- | --- | --- |
| `phash2` 固定路由 | 同 key 请求落到同 worker，顺序可控 | 同一清单的读写必须串行 |
| Poolboy 借用 | 同时使用的资源数量有上限 | 限制对有限资源（磁盘、外部连接）的并发 |

配套示例里 store 用 cast、get 用 call，transaction 的匿名函数发出消息就返回，worker 随即归还——消息处理和归还之间没有同步。所以"借了又还"不等于"写盘已完成"。第 17 章会把这个差距继续放大。

## HTTP 作为应用的一个子进程

`todo_web` 项目在 `Todo.System` 的子进程列表里加了 `Todo.Web`：

```elixir
[
  Todo.Metrics,
  Todo.ProcessRegistry,
  Todo.Database,
  Todo.Cache,
  Todo.Web
]
```

`Todo.Web` 的 `child_spec` 是 Plug.Cowboy 提供的：

```elixir
Plug.Cowboy.child_spec(
  scheme: :http,
  options: [port: 5454],
  plug: __MODULE__
)
```

Cowboy 是 HTTP 服务器，Plug 是请求处理的约定。`plug: __MODULE__` 表示请求交给 `Todo.Web` 这个 Plug.Router 处理。监督者启动它时，HTTP 服务器就监听上了；它挂了，监督者重启它。

`Todo.Web` 里用 `use Plug.Router` 和两行 plug 声明：

```elixir
plug(:match)
plug(:dispatch)
```

`match` 和 `dispatch` 是 `use Plug.Router` 带的两个内置 plug。`match` 只看方法和路径，找到第一个匹配的路由块记下来；`dispatch` 再执行那块代码。`get "/entries"`、`post "/add_entry"`、`match _`（兜底 404）都是在这个框架里注册的，下一章会把 `web.ex` 整段拆开看。

路由内部仍然调 `Todo.Cache.server_process` 和 `Todo.Server`——HTTP 是系统的一层入口，业务状态不搬到这里。同一个 Todo 系统，IEx 能查，`mix test` 能测，浏览器也能问。

## 亲手发一次请求

进入 todo_web 项目，`mix deps.get` 然后 `iex -S mix`。服务监听 5454。另一个终端：

```sh
curl -G \
  --data-urlencode 'list=alice' \
  --data-urlencode 'date=2026-11-09' \
  --data-urlencode 'title=Read Elixir' \
  'http://localhost:5454/add_entry'

curl -G \
  --data-urlencode 'list=alice' \
  --data-urlencode 'date=2026-11-09' \
  'http://localhost:5454/entries'
```

查询结果应包含 `2026-11-09 Read Elixir`。

注意这里故意用 `-G` 把参数放进 query string：路由读的是 `conn.params`，它只解析 URL query，不解析请求体。发一个 JSON body 过去，这些参数根本不会出现。

## 把环境差异交给配置

`todo_env` 项目给这套系统加了 `config/runtime.exs`：

```elixir
import Config

http_port =
  if config_env() != :test,
    do: System.get_env("TODO_HTTP_PORT", "5454"),
    else: System.get_env("TODO_TEST_HTTP_PORT", "5455")

config :todo, http_port: String.to_integer(http_port)
```

`import Config` 把 `config` 宏拿进来；`config_env()` 返回当前环境（`:dev`、`:test`、`:prod`）；`config :todo, http_port: ...` 把值写进 `:todo` 应用的环境，之后 `Application.get_env(:todo, :http_port)` 能读回。环境变量在外面设置，进到代码里时已经是整数——类型转换就放在这一层做。

三个环境变量——端口、数据目录、空闲过期时间——在应用启动时读进来，转换成正确类型，写进应用环境。`Todo.Web` 的 `child_spec` 改成从应用环境取端口：

```elixir
options: [port: Application.fetch_env!(:todo, :http_port)]
```

测试环境用独立变量和独立目录，跑 `mix test` 不会和还在跑的 IEx 抢 5454，也不会往 `./persist` 里写测试数据。这个区分是靠 `config_env()` 拿到的——`mix` 在 `mix test` 下自动把环境设成 `:test`，所以 `TODO_TEST_*` 那套变量只在跑测试时生效；手动 `MIX_ENV=test iex -S mix` 也能进入同一套。

配置在启动期读取——不是每次请求时查，也不是改环境变量就能影响已运行的进程。改端口要重启。

## 动手验证

在 todo_env 项目下：

```sh
mix deps.get
TODO_HTTP_PORT=5460 TODO_DB_FOLDER=./local-data iex -S mix
```

`curl http://localhost:5460/entries?list=x&date=2026-11-09` 应返回空文本和 200。退出后不加环境变量重启，端口回到 5454——这就是"配置在启动时进入系统"的样子。

**练习**：对比 `todo_poolboy` 和第 9 章 `pool_supervision` 的 `Todo.Database`，列出两个版本各自的"保证"和"代价"。如果产品要求同一清单的写严格有序，哪个模型更合适？能不能在 Poolboy 上自己加回去？

下一章沿这个 HTTP 边界往深走：错误响应、测试、以及请求参数到底该被验证到什么程度。
