defmodule Todo.CacheTest do
  use ExUnit.Case

  setup_all do
    # start_link links the supervisor to whoever calls it, and a supervisor
    # exits when its parent does — even on a normal exit. Starting it from a
    # detached process keeps the tree alive after this setup process ends.
    spawn(fn ->
      Todo.System.start_link()
      Process.sleep(:infinity)
    end)

    wait_until_system_ready()
    :ok
  end

  test "server_process" do
    bob_pid = Todo.Cache.server_process("bob")

    assert bob_pid != Todo.Cache.server_process("alice")
    assert bob_pid == Todo.Cache.server_process("bob")
  end

  test "to-do operations" do
    jane = Todo.Cache.server_process("jane")
    Todo.Server.add_entry(jane, %{date: ~D[2018-12-19], title: "Dentist"})
    entries = Todo.Server.entries(jane, ~D[2018-12-19])

    assert [%{date: ~D[2018-12-19], title: "Dentist"}] = entries
  end

  test "persistence" do
    john = Todo.Cache.server_process("john")
    Todo.Server.add_entry(john, %{date: ~D[2018-12-20], title: "Shopping"})
    assert 1 == length(Todo.Server.entries(john, ~D[2018-12-20]))

    Process.exit(john, :kill)

    entries =
      "john"
      |> Todo.Cache.server_process()
      |> Todo.Server.entries(~D[2018-12-20])

    assert [%{date: ~D[2018-12-20], title: "Shopping"}] = entries
  end
  defp wait_until_system_ready(tries \\ 200)
  defp wait_until_system_ready(0), do: :ok

  defp wait_until_system_ready(tries) do
    if Process.whereis(Todo.System) != nil do
      :ok
    else
      Process.sleep(10)
      wait_until_system_ready(tries - 1)
    end
  end

end
