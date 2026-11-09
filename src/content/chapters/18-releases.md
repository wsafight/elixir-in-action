---
order: 18
title: 交付一个可以运行的系统
description: 用 Mix release 打包应用，通过运行时配置与容器明确部署边界。学习的最后一步，是让程序离开开发终端仍能运行。
part: 4
duration: 28
topics: [Mix release, 运行时配置, Docker, 发布验证]
samples:
  - {label: release·项目配置, path: code_samples/ch13/todo_release/mix.exs}
  - {label: release·运行时配置, path: code_samples/ch13/todo_release/config/runtime.exs}
  - {label: release·系统入口, path: code_samples/ch13/todo_release/lib/todo/system.ex}
  - {label: release·Dockerfile, path: code_samples/ch13/todo_release/Dockerfile}
  - {label: release·HTTP 测试, path: code_samples/ch13/todo_release/test/http_server_test.exs}
---

开发时，我们从 IEx 启动应用，随手查看状态，也随时能改代码。交付之后，应用需要一个明确入口、一套可配置的运行参数，以及可重复执行的验证流程。

本章把前面的系统整理成 release。

## release 打包了什么

Mix release 将应用、依赖与运行所需的组件整理成一个发布目录。它提供启动、停止、远程连接等脚本，使目标环境不必依赖项目源码和开发时的 Mix 命令来启动。

进入 todo_release 项目，按顺序运行：

```sh
mix deps.get
mix test
MIX_ENV=prod mix release
```

`mix.exs` 里 `cli.preferred_envs: [release: :prod]` 已经声明 release 默认用 prod 环境，所以 `mix release` 本身也行；这里显式写 `MIX_ENV=prod` 是为了不依赖这个默认值。

构建完成后，发布目录位于 `_build/prod/rel/todo`。打开看看，大致是：

```text
_build/prod/rel/todo/
├── bin/
│   ├── todo          # 启动脚本
│   └── todo.bat
├── erts-17.x/        # 内嵌的 Erlang 运行时
├── lib/              # 应用与各依赖的 .beam 文件
├── releases/
│   ├── 0.1.0/        # 本次 release 的启动脚本与 sys.config
│   └── RELEASES
└── releases/start_erl.data
```

几个值得记住的点：`erts` 是打包进去的 Erlang 运行时，目标机器不必再装 Erlang；`lib/` 下按应用分目录放 `.beam` 文件，`releases/0.1.0` 存的是启动这个版本的描述文件；`bin/todo` 是统一入口。

## bin/todo 的几种启动方式

同一个脚本有不同的子命令，对应不同的运行形态：

```sh
_build/prod/rel/todo/bin/todo start       # 后台 daemon 启动，终端立即返回
_build/prod/rel/todo/bin/todo start_iex   # 前台启动并挂一个 IEx
_build/prod/rel/todo/bin/todo daemon      # 后台运行（无交互）
_build/prod/rel/todo/bin/todo remote      # 连进正在运行的节点的 IEx
_build/prod/rel/todo/bin/todo stop        # 停止后台节点
_build/prod/rel/todo/bin/todo eval "Todo.Cache.server_process(\"x\")"  # 在运行节点上执行一段代码
```

`start`/`daemon` 让应用在后台跑，终端可以做别的事；`start_iex` 适合学习和手动验证，退出 IEx 节点也退；`remote` 是排障入口——它连进已经跑着的节点给你一个 IEx，你查到的 `Node.self()`、监督树、ETS 表都是那个活节点里的，不是新起的进程。`eval` 不挂终端，执行完就返回。

daemon 模式下确认应用活着的最简单办法：

```sh
_build/prod/rel/todo/bin/todo remote
```

```elixir
iex(todo@hostname)1> Application.started_applications() |> Enum.map(&elem(&1, 0))
[:runtime_tools, :logger, :kernel, :stdlib, :elixir, ..., :todo]
```

能看到 `:todo` 在列表里，说明整个监督树已经由应用入口拉起，不需要任何人手动调 `Todo.System.start_link()`。具体的运维方式要和进程管理器、部署环境配合，而不是靠某个人一直开着终端。

## 构建环境与运行环境分开

构建时需要源码、编译器、依赖下载等工具；运行时主要需要编译产物与兼容的系统环境。release 减少了运行阶段的开发工具需求，但不代表产物能跨任意操作系统或 CPU 架构直接执行。

如果应用使用本地库或 NIF，还要检查对应的系统依赖。示例 Dockerfile 中的构建镜像和运行镜像都采用同一 Debian 系列，就是为了让这条边界更加可控。

示例里固定的镜像标签只服务于配套演示，不一定是当前生产环境的推荐版本。实际升级要结合依赖兼容性重新构建和验证。

另外，`mix.exs` 的 `application/0` 里把 `:runtime_tools` 加进了 `extra_applications`，这样 release 里可以跑 `:observer`、`:recon` 之类的运行时工具——前面第 12、13 章用到的观测手段，在 release 里同样能用。

## 让配置在启动时进入系统

`config/runtime.exs` 读取以下环境变量：

| 变量 | 含义 | 示例默认值 |
| --- | --- | --- |
| `TODO_HTTP_PORT` | HTTP 监听端口 | `5454` |
| `TODO_DB_FOLDER` | 数据目录前缀 | `./persist` |
| `TODO_SERVER_EXPIRY` | 清单进程空闲过期秒数 | 非 dev 环境为 `60` |

测试还有独立的 `TODO_TEST_HTTP_PORT` 与 `TODO_TEST_DB_FOLDER`。配置脚本把字符串转换成端口整数和毫秒时长，再放入应用环境。

你可以在启动 release 时覆盖配置：

```sh
TODO_HTTP_PORT=5460 \
TODO_DB_FOLDER=./release-data \
TODO_SERVER_EXPIRY=120 \
_build/prod/rel/todo/bin/todo start
```

`runtime.exs` 的读取发生在每次启动时，不是构建时。同一个 release，换一组环境变量就是另一种配置，不需要重新 `mix release`。

区分环境靠的是 `MIX_ENV`。`mix test` 自动进 `:test`，`iex -S mix` 默认 `:dev`，`MIX_ENV=prod mix release` 进 `:prod`。`config_env()` 在 `runtime.exs` 里返回当前环境，应用据此决定读 `TODO_HTTP_PORT` 还是 `TODO_TEST_HTTP_PORT`——同一文件，三种走法。

数据目录该由部署环境管理，不能只放在随时会被替换的发布目录里。配置改了以后，也要确认应用在哪个启动阶段读取它，而不是假定改环境变量会影响已在运行的进程。

## 容器把系统环境一起描述出来

示例的 Dockerfile 使用两个阶段，核心结构是：

```dockerfile
FROM hexpm/elixir:... AS builder
# 装 Hex、rebar，复制源码
# mix deps.get / mix deps.compile / mix release → 产出 _build/prod/rel/todo

FROM debian:bookworm-slim
# 只复制 _build/prod/rel/todo 到 /app
# 补 openssl 和 locales 两个运行依赖
CMD ["/app/bin/todo", "start_iex"]
```

第一阶段的镜像里有完整的编译工具链（Elixir、Erlang 编译器、Hex），它只在构建时用；第二阶段从干净的 Debian 起步，只拿走 release 产物——最终镜像里没有 mix、没有源码、没有编译器，体积和安全面都小很多。`COPY --from=builder` 是阶段间传递产物的语法。

在项目目录运行以下命令，可以在具备 Docker 的本机进行实验：

```sh
docker build -t elixir-todo .
docker run --rm -it \
  -p 5454:5454 \
  -v todo-data:/todo/persist \
  elixir-todo
```

示例默认命令是 `start_iex`，所以这里使用交互终端。命名卷用来保留数据目录；实际部署还要明确节点名字与目录命名的关系，因为数据库会在目录下按节点前缀组织文件——上一个例子中节点名一旦变化，原先 `persist/<node>/` 下的文件就读不到了。

容器可以重建，数据不行。发布产物随时能再生成，用户数据则需要自己的保存和备份策略。

## 验证应该覆盖用户看见的行为

`test/http_server_test.exs` 使用 Plug.Test 构造连接，直接验证路由返回：

```elixir
defp get(path) do
  Todo.Web.call(conn(:get, path), Todo.Web.init([]))
end
```

这种测试不起真实端口、不打开监听，跑得快也能定位路由问题，但不能证明真实端口已经监听，也不能证明容器网络配置正确。换到 release 模式下跑，才能覆盖“启动脚本写对了没有”“运行时依赖齐不齐”这类部署层面的事。

发布后还应做一次真实 HTTP 验证：新增一条容易辨认的测试条目，再从查询接口读回来。接着重启应用，确认数据加载路径符合预期。

```sh
curl -G \
  --data-urlencode 'list=release-check' \
  --data-urlencode 'date=2026-11-09' \
  'http://localhost:5454/entries'
```

空清单会返回空文本，仍然是一次成功请求。检查时不要把“没有内容”误判成服务没有运行，应当同时观察状态码与响应语义。

## 把一路走来的设计串起来

Todo.List 负责纯粹的数据变换，Todo.Server 持有运行中的清单，Cache 找到或创建服务，数据库管理保存路径与文件操作，监督树组织生命周期，Application 提供统一入口，Web 提供网络边界，release 则把整个应用交到运行环境。

这些层次不是为了让文件更多，而是为了让每个问题都有一个清楚的位置。遇到故障时，你可以沿着边界追问：输入是否有效？消息是否到达？状态是否更新？文件是否写好？恢复是否完成？

**最后一个练习**：从空目录构建 release，启动、写入、查询、停止、再次启动，再查询。将每一步使用的版本、环境变量与数据目录记录下来。如果另一个人能根据你的记录复现实验，这份记录就是这个系统第一份运行手册。

到这里，应用已经能离开开发终端了。下一章回过头，把一次请求从 HTTP 到磁盘的完整旅程走一遍。
