---
order: 11
title: 第一次用 Mix
description: 从单个 .ex 文件走进 Mix 项目：目录怎么摆、命令在哪跑、模块名为什么要改名。工程化的第一步。
part: 2
duration: 20
topics: [Mix, 项目结构, mix.exs, iex -S mix, 名字空间]
samples:
  - {label: todo·项目配置, path: code_samples/ch07/todo/mix.exs}
  - {label: todo·清单数据结构, path: code_samples/ch07/todo/lib/todo/list.ex}
  - {label: todo·清单服务, path: code_samples/ch07/todo/lib/todo/server.ex}
  - {label: todo·清单服务测试, path: code_samples/ch07/todo/test/todo/server_test.exs}
---

到上一章为止，所有示例都是单个 `.ex` 文件，`iex -r` 加载进来就能玩。`ch07` 开始换了一种组织方式：目录里出现了 `mix.exs`、`lib/`、`test/`，这是 Mix 项目。这一章先把 Mix 这个工具本身认识一遍，下一章再去看项目里多出来的那些进程。

## Mix 是 Elixir 的工程入口

Mix 是随 Elixir 一起安装的工具，管四件事：建项目骨架、编译、跑测试、拉依赖。前面的章节你只用过 `iex -r`，现在第一次见到这几个命令：

```sh
cd code_samples/ch07/todo
mix test          # 跑 test/ 下所有测试
iex -S mix        # 编译并加载整个项目，再进 IEx
```

`mix test` 和 `iex -S mix` 都必须在项目目录里跑，它们靠 `mix.exs` 认出"这里是个项目"。`iex -r file.ex` 是加载单个文件，`iex -S mix` 是加载整个项目：所有 `lib/` 下的模块编译一遍进 VM，名字空间、模块之间的调用关系一次就位。

第一次进新项目，先跑一遍 `mix deps.get`。如果 `mix.exs` 里声明了外部依赖（比如后面几章的 `:poolboy`、`:plug`），这条命令把它们从 Hex 拉到 `deps/`。当前 `ch07/todo` 的 `deps` 是空的，可以跳过；遇到 `can't find dependency` 再回来跑。

## 目录的三个固定位置

打开 `ch07/todo/`，结构只有三层：

```
todo/
├── mix.exs              # 项目自述：名字、版本、依赖
├── lib/
│   └── todo/
│       ├── list.ex      # 纯函数：Todo.List
│       └── server.ex    # 进程：Todo.Server
└── test/
    ├── test_helper.exs  # ExUnit.start()
    └── todo/
        └── server_test.exs
```

约定很简单：`lib/` 放代码，`test/` 放测试，`mix.exs` 是入口。`lib/todo/` 目录名对应 `Todo` 名字空间，`list.ex` 里就是 `Todo.List`，`server.ex` 里就是 `Todo.Server`。文件路径和模块名对齐是 Mix 项目的习惯，不是强制，但所有示例都遵守。

`mix.exs` 里最核心的两段：

```elixir
def project do
  [
    app: :todo,
    version: "0.1.0",
    elixir: "~> 1.20",
    deps: deps()
  ]
end

def application do
  [extra_applications: [:logger]]
end
```

`project/0` 是项目自述：应用名 `:todo`、版本号、`~> 1.20` 是"1.20 及以上、小于 2.0"的 Elixir 版本约束，`deps` 列出外部依赖（现在空着）。`application/0` 描述应用怎么启动，现在只声明了需要 `:logger`，没有 `mod:` 入口，所以 `iex -S mix` 加载完代码后进程还没有跑起来，要手动 `Todo.Server.start()`。下一章会讲这个结构怎么演化，第 20 章会补上 `mod:` 那一半。

## 同一套代码，换了个名字

对比第 6 章的 `todo_server.ex` 和这里的 `lib/todo/server.ex`，函数体几乎一样：

```elixir
def entries(todo_server, date) do
  GenServer.call(todo_server, {:entries, date})
end
```

但模块名从 `TodoList`、`TodoServer` 变成了 `Todo.List`、`Todo.Server`，同一个 `Todo` 名字空间下的两个模块。改名的原因和 Mix 无关，是工程规模的信号：单文件里模块少，名字短就行；项目里模块一长串，带点号的名字让"这是 Todo 系统里的哪个件"一眼可辨。

另一个变化藏在测试目录：`server_test.exs` 用 `mix test` 跑，不需要 `test_script` 宏，模块已经编译进项目了，测试直接用。对比一下第 2 章那种 `elixir tests.exs` 跑单文件测试的路子：脚本是"临时加载"，项目是"编译常驻"，到第 18 章会专门拆这个区别。

## 动手验证

```sh
cd code_samples/ch07/todo
mix test
iex -S mix
```

```elixir
iex> {:ok, pid} = Todo.Server.start()
{:ok, #PID<0.118.0>}
iex> Todo.Server.add_entry(pid, %{date: ~D[2026-11-09], title: "Read"})
:ok
iex> Todo.Server.entries(pid, ~D[2026-11-09])
[%{date: ~D[2026-11-09], id: 1, title: "Read"}]
```

注意这一步没有 `Todo.Cache`、`Todo.Database`。`ch07/todo` 是最小形态：一个 `Todo.Server` 管一份清单，和第 6 章那个单文件的功能等价，只是住进了 Mix 的目录结构。下一章起的每个项目都在这套骨架上加东西：缓存、持久化、池。

**练习**：在 `iex -S mix` 里试 `Todo.List.new() |> Todo.List.add_entry(%{date: ~D[2026-11-09], title: "x"}) |> Todo.List.size()`，纯函数那部分在 Mix 项目里照样能直接调用。再想想：`Todo.Server` 和 `Todo.List` 的边界（一个管进程，一个管数据）在单文件版本里是怎么体现的？
