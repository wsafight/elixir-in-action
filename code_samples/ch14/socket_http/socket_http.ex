defmodule SocketHttp do
  # A minimal HTTP server built directly on :gen_tcp.
  # Demonstrates that HTTP is just text over TCP: accept a connection,
  # read the request line, respond with headers + body.
  #
  # Run:  iex -r socket_http.ex
  #       SocketHttp.start(8080)
  #       curl http://localhost:8080/hello

  def start(port) do
    {:ok, listen_socket} =
      :gen_tcp.listen(port, [:binary, packet: :raw, active: false, reuseaddr: true])

    IO.puts("Listening on :#{port}")
    accept_loop(listen_socket)
  end

  defp accept_loop(listen_socket) do
    {:ok, socket} = :gen_tcp.accept(listen_socket)
    spawn(fn -> handle(socket) end)
    accept_loop(listen_socket)
  end

  defp handle(socket) do
    case :gen_tcp.recv(socket, 0, 5000) do
      {:ok, request} ->
        [request_line | _] = String.split(request, "\r\n")
        [_method, path, _version] = String.split(request_line, " ")
        respond(socket, path)
        :gen_tcp.close(socket)

      {:error, _reason} ->
        :gen_tcp.close(socket)
    end
  end

  defp respond(socket, path) do
    {status, body} =
      case path do
        "/" -> {200, "Hello from raw TCP"}
        "/hello" -> {200, "Hello!"}
        _ -> {404, "Not Found"}
      end

    response =
      "HTTP/1.1 #{status} #{reason(status)}\r\n" <>
        "Content-Type: text/plain\r\n" <>
        "Content-Length: #{byte_size(body)}\r\n" <>
        "Connection: close\r\n" <>
        "\r\n" <>
        body

    :gen_tcp.send(socket, response)
  end

  defp reason(200), do: "OK"
  defp reason(404), do: "Not Found"
end
