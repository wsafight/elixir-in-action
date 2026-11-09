---
order: 22
title: HTTP 就是 TCP 上的一段文本
description: 在 Plug 和 Cowboy 登场之前，用 :gen_tcp 亲手写一遍。HTTP 协议本身只有几十行代码那么薄。
part: 4
duration: 20
topics: [gen_tcp, socket, HTTP 协议, accept 循环, 每个连接一个进程]
samples:
  - {label: 手写 HTTP 服务, path: code_samples/ch14/socket_http/socket_http.ex}
  - {label: Plug 版本对照, path: code_samples/ch11/todo_web/lib/todo/web.ex}
---

第 20 章里 HTTP 是 Plug.Cowboy 一行 `child_spec` 启动的，快得让人忘了 HTTP 到底是什么。这一章后退一步：用 `:gen_tcp` 亲手写一遍，看一个 HTTP 服务在协议层面到底要干多少事。答案是没多少，所以它才值得被抽象掉。

## 一个连接的三步

`socket_http.ex` 的核心是 `accept_loop`：

```elixir
{:ok, listen_socket} =
  :gen_tcp.listen(port, [:binary, packet: :raw, active: false, reuseaddr: true])

{:ok, socket} = :gen_tcp.accept(listen_socket)
spawn(fn -> handle(socket) end)
```

`:gen_tcp.listen` 开一个监听 socket，`accept` 阻塞等一个连接进来，拿到连接 socket 后 `spawn` 一个进程处理，主循环立刻回去等下一个连接。**每个连接一个进程**，这和 Todo.Server 一份清单一个进程是同一个模式，只是这次进程的生命周期跟着 TCP 连接走。

`packet: :raw` 表示按原始字节读，`active: false` 表示 `recv` 是同步拉取，进程自己决定什么时候要下一段数据，不是运行时推给它。

## 读进来的就是一段文本

`handle` 里 `recv` 拿到的是原始请求字节。HTTP/1.1 请求的第一行是 `GET /hello HTTP/1.1`，方法、路径、版本，空格隔开。后面跟着一堆 `Header: value` 行，空行结束，再往后是 body（GET 一般没有）。

```elixir
{:ok, request} = :gen_tcp.recv(socket, 0, 5000)
[request_line | _] = String.split(request, "\r\n")
[_method, path, _version] = String.split(request_line, " ")
```

`\r\n` 是 HTTP 的换行符（CRLF），不是 `\n`。`String.split` 拆出来的 `request_line` 就是方法、路径、协议版本三个值。

## 响应也是文本

返回时拼一段符合 HTTP 格式的字节：

```elixir
response =
  "HTTP/1.1 #{status} #{reason(status)}\r\n" <>
    "Content-Type: text/plain\r\n" <>
    "Content-Length: #{byte_size(body)}\r\n" <>
    "Connection: close\r\n" <>
    "\r\n" <>
    body
```

`Content-Length` 必须准确，客户端靠它知道读到哪算完。`Connection: close` 告诉客户端这段对话到此为止，服务端发完就 `:gen_tcp.close(socket)`，连接进程随之退出。没有 keep-alive，没有并发复用，一个连接，一个请求，一个响应，结束。

`curl` 对着这个服务发请求，拿到的就是正常的 HTTP 响应。协议是公开的文本格式，只要字节拼对了，任何客户端都认。

## 为什么还需要 Plug 和 Cowboy

这个手写版本能工作，但离生产还差得远：没有路由（只有一个 `case path`）、没有 header 解析、没有 query string 处理、没有 keep-alive、没有 SSL、没有超时管理、没有连接数上限。`todo_web` 里那个 `Todo.Web` 模块做的事，`match`/`dispatch`、参数解析、错误响应，正是这一章没写的部分。

手写一遍的价值在于：当你读到 `Plug.Cowboy.child_spec(scheme: :http, options: [port: 5454], plug: __MODULE__)` 时，知道 "Cowboy 替你做了 accept 循环和 socket 管理，Plug 替你做了路由和参数解析"，剩下的 `plug: __MODULE__` 只是把"拿到 conn 之后怎么办"这件事留给你。

## 动手验证

```sh
cd code_samples/ch14/socket_http
iex -r socket_http.ex
```

```elixir
iex> SocketHttp.start(8080)
Listening on :8080
```

另一个终端：

```sh
curl http://localhost:8080/hello
curl http://localhost:8080/anything-else
```

第一个返回 `Hello!`，第二个返回 `Not Found`。再用浏览器或 `curl -v` 看响应头，`Content-Length` 和 `Connection: close` 都是手写拼进去的。

**练习**：给 `SocketHttp` 加一条 `/echo?name=...` 路由，从 query string 里解析 `name` 参数返回 `Hello, #{name}`，体会"手写解析"在路由变多时代价有多大，然后翻到 `Todo.Web` 看 Plug 是怎么做的。
