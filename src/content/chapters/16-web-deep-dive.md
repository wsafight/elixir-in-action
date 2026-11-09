---
order: 16
title: HTTP 边界往里再走一层
description: 拆开 Plug.Router 的 match 和 dispatch，给缺参数、坏日期一个体面的 400，再用 Plug.Test 把路由测试补齐。
part: 4
duration: 30
topics: [Plug.Router, match/dispatch, fetch_query_params, 参数校验, 错误响应, Plug.Test]
samples:
  - {label: todo_web·路由, path: code_samples/ch11/todo_web/lib/todo/web.ex}
  - {label: HTTP 路由测试, path: code_samples/ch11/todo_web/test/http_server_test.exs}
  - {label: todo_env·运行时配置, path: code_samples/ch11/todo_env/config/runtime.exs}
  - {label: release HTTP 测试, path: code_samples/ch13/todo_release/test/http_server_test.exs}
---

上一章把 `Todo.Web` 挂进了监督树。这一章只盯着 `web.ex` 这一个文件，把两条路由、参数处理、错误路径和测试一层层拆开。

## 一个 Plug 只要两个函数

在拆 `Todo.Web` 之前先把规格说清楚：Plug 的约定只要求两个函数。`init/1` 拿配置返回处理过的选项，`call/2` 拿到这个选项和 `%Plug.Conn{}`，返回新的 conn。

```elixir
def init(options), do: options

def call(conn, _opts) do
  conn
  |> put_resp_content_type("text/plain")
  |> send_resp(200, "Hello World!\n")
end
```

监督树启动时调 `init` 一次；每次请求进来调 `call`。`Plug.Test` 测的就是这个 `call/2`——它不看网络，只看函数返回值，所以测试里 `Todo.Web.call(conn, Todo.Web.init([]))` 就能复现 Cowboy 的请求路径。

## match 和 dispatch 在做什么

```elixir
plug(:match)
plug(:dispatch)
```

每个进来的 `Plug.Conn` 先过 `match`：按方法和路径找下面定义的某个 `get`/`post`/`match` 块，把命中的那个记进 conn。再过 `dispatch`：真正执行那块代码，发送响应。

这个两段式意味着路由可以有副作用也可以在中间被改写——`match` 之后、`dispatch` 之前插一个 plug，就能拿到"将要去哪个路由"的信息。示例没用到，但这是 Plug.Router 比"一串 if-else"多一点的地方。

plug 是按声明顺序串起来的管道，位置不同效果不同。日志 plug 放最前，`Plug.Parsers` 要在需要 `conn.body_params` 的路由之前，自己写的校验 plug 放在 `match` 之前，就能先挡掉不合法请求再走匹配：

```elixir
plug(Plug.Logger)
plug(Plug.Parsers, parsers: [:urlencoded])
plug(VerifyRequest, fields: ["content"], paths: ["/upload"])
plug(:match)
plug(:dispatch)
```

每个 plug 都可以只对自己关心的路径动手，不关心的直接 `conn` 透传。`Todo.Web` 里只有 `:match` 和 `:dispatch` 两段，是因为它把"怎么进"留给了监督树，把"怎么走"留在路由里。

`match _` 兜住所有没匹配到的请求，返回 `404 not found`。

## fetch_query_params 不是自动的

`/entries` 路由的完整实现只有几行，逐行拆开：

```elixir
get "/entries" do
  conn = Plug.Conn.fetch_query_params(conn)
  list_name = Map.fetch!(conn.params, "list")
  date = Date.from_iso8601!(Map.fetch!(conn.params, "date"))

  list_name
  |> Todo.Cache.server_process()
  |> Todo.Server.entries(date)
  |> Enum.map(&"#{&1.date} #{&1.title}")
  |> Enum.join("\n")
  |> then(&send_resp(conn |> put_resp_content_type("text/plain"), 200, &1))
end
```

第一行把 URL query 解析进 `conn.params`；接下来两个 `Map.fetch!` 取 `list` 和 `date` 两个参数，日期用 `Date.from_iso8601!` 转成 `%Date{}`。管道部分走回业务系统：`Todo.Cache.server_process` 按清单名找到（或新建）对应进程的 PID，`Todo.Server.entries` 向它同步查询当日条目，然后两条 `Enum` 把条目列表压成"一行一条"的纯文本，最后 `send_resp` 带着 `text/plain` 响应头回 200。

`conn.params` 不是开箱就有的。`fetch_query_params/1` 解析 URL 的 query string，把结果塞进 `conn.params`，返回新的 conn。少了这一行，`Map.fetch!(conn.params, "list")` 拿到的就是个空 map，直接抛 `KeyError`。

这也解释了为什么这个示例只认 query string：请求体没有被任何 parser plug 处理过。`curl -d` 发的 body 会原样躺在那里，没人读。要接 JSON，得加 `Plug.Parsers` 并声明 `:json` 解码器，这个示例没做。

## ! 后缀函数的代价

两个 `Map.fetch!` 和一个 `Date.from_iso8601!` 用的是 bang 版本：缺参数抛 `KeyError`，日期不合法抛 `ArgumentError`。Cowboy 接到异常会回 500。

对调用方来说，500 是"服务器出错了"，但其实是"你的请求缺东西"。400 才是对的：问题在请求，不在服务器。

把 bang 版本换成普通版本，错误就成了可以处理的返回值：

```elixir
post "/add_entry" do
  conn = Plug.Conn.fetch_query_params(conn)

  with {:ok, list} <- Map.fetch(conn.params, "list"),
       {:ok, title} <- Map.fetch(conn.params, "title"),
       {:ok, date_str} <- Map.fetch(conn.params, "date"),
       {:ok, date} <- Date.from_iso8601(date_str) do
    list
    |> Todo.Cache.server_process()
    |> Todo.Server.add_entry(%{title: title, date: date})

    send_resp(conn, 200, "OK")
  else
    _ -> send_resp(conn, 400, "bad request")
  end
end
```

`with` 把四个可能失败的步骤串起来，任何一个返回 `:error` 或不匹配，就进 `else` 分支回 400。这是第 4 章练过的写法，现在它出现在一个真实的 HTTP 边界上。

这不是配套示例里的代码——是一个教学改动，演示路由层怎么把"可预期的坏请求"和"内部异常"分开。

## add_entry 的 200 不承诺持久化

```elixir
list_name
|> Todo.Cache.server_process()
|> Todo.Server.add_entry(%{title: title, date: date})

send_resp(conn, 200, "OK")
```

`Todo.Server.add_entry` 是 `GenServer.cast`——消息进邮箱就返回 `:ok`。HTTP 层立刻回 200，此时 Todo.Server 可能还没处理到这条消息，更别提 `Todo.Database.store` 那次 cast 有没有走到文件。

如果客户端把 200 当作"数据已保存"，它会读到旧数据。示例用返回体 `"OK"` 也表达了同样的事：它只承诺"请求被收下了"，不承诺"写完了"。

要让 200 真的有分量，得把 `add_entry` 改成 `GenServer.call`，让 Todo.Server 在落盘之后回复——这是第 17 章 `todo_distributed` 里已经做过的改动，可以对照着看。

## Plug.Test：不开端口测路由

todo_web 的 `test/http_server_test.exs` 复用了第 14 章介绍的思路：

```elixir
defmodule HttpServerTest do
  use ExUnit.Case, async: false
  import Plug.Test

  test "adding an entry" do
    resp = post("/add_entry?list=test_2&date=2018-12-19&title=Dentist")
    assert resp.status == 200
    assert get("/entries?list=test_2&date=2018-12-19").resp_body ==
             "2018-12-19 Dentist"
  end

  defp get(path) do
    Todo.Web.call(conn(:get, path), Todo.Web.init([]))
  end
end
```

`conn(:get, path)` 构造一个完整的 `Plug.Conn` 结构，方法、路径、host 都齐了。`Todo.Web.call/2` 是 Plug.Router 的入口函数，和 Cowboy 收到真实请求时调的是同一个——只是绕过了网络层。

在 IEx 里手动走一遍这条路更直观（项目根下 `iex -S mix`）：

```elixir
iex> conn = Plug.Test.conn(:get, "/entries?list=x&date=2018-12-19")
%Plug.Conn{method: "GET", request_path: "/entries", params: %Plug.Conn.Unfetched{}, ...}
iex> resp = Todo.Web.call(conn, Todo.Web.init([]))
%Plug.Conn{status: 200, resp_body: "", state: :sent, ...}
iex> resp.resp_body
""
```

`conn/3` 返回的 `Plug.Conn` 里 `params` 还是 `%Plug.Conn.Unfetched{}`——"还没解析"的占位值，正好解释了为什么路由里必须先调 `fetch_query_params`。`call/2` 回来后 `state` 变成 `:sent`，`status` 和 `resp_body` 就是测试里断言的两个字段；空清单时 body 是空字符串。

这让测试跑得快，也让断言落在边界上：测的是"这个 Plug 对这样的 conn 返回什么"，不是"端口能不能连"。

`async: false` 的原因在 `test_helper.exs` 里：测试起的是真实监督树，用的真实 `./persist` 目录，多个测试文件并行会互相踩。`todo_env` 引入 `TODO_TEST_DB_FOLDER` 之后，测试目录和开发目录分开，但同一份测试内部仍然共享一个运行中的系统。

## content-type 也是接口的一部分

```elixir
conn
|> Plug.Conn.put_resp_content_type("text/plain")
|> Plug.Conn.send_resp(200, formatted_entries)
```

两行响应头看着像装饰，实际上决定了客户端怎么解释 body。`/entries` 回 `text/plain`，curl 直接打印；"OK" 也是 `text/plain`。如果哪天想换成 JSON，客户端会按 `application/json` 来解——这时不只是改 `send_resp` 的字符串，还得把 `put_resp_content_type` 换掉，并想好日期、标题的转义方式。

响应体的拼装也在路由里：`Enum.map(&"#{&1.date} #{&1.title}")` 加 `Enum.join("\n")`，把条目压成一行一条的纯文本。格式简单是教学选择，不是协议约束——换成 JSON 数组，这个函数就变成序列化器了。

## 一个能落地的练习

给 `/add_entry` 加 400 校验，同时补测试。测试放 `test/http_server_test.exs`：

```elixir
test "bad date returns 400" do
  resp = post("/add_entry?list=x&date=not-a-date&title=t")
  assert resp.status == 400
end
```

跑 `mix test` 确认新断言通过，再回看：之前那个 500 的路径是不是被 `with`/`else` 挡住了？

## 动手验证

进入 todo_web 项目：

```sh
mix deps.get && iex -S mix
```

发几个故意缺的请求：

```sh
curl -i 'http://localhost:5454/add_entry?list=x&date=bad&title=t'
curl -i 'http://localhost:5454/add_entry?list=x'
curl -i 'http://localhost:5454/nonexistent'
```

看状态码分别是 500、500、404。然后照上面的 `with` 版本改路由，重启，再发一遍——前两个应变成 400。

**练习**：给 `GET /entries` 的 `date` 也换成 `Date.from_iso8601` + 400。再想一步：如果产品要 JSON API，`Todo.Web` 需要加哪几样东西？（提示：`Plug.Parsers`、一个 JSON 库、`conn.body_params` 代替 `conn.params`。）列出改动清单，先不实现。
