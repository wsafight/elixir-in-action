defmodule Todo.CacheTest do
  use ExUnit.Case

  setup_all do
    ensure_system_running()
    :ok
  end

  setup do
    # Other tests stop and restart the system; make sure it is back up
    # before each test so test order can't matter.
    ensure_system_running()
    wait_until_cache_ready()
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

  test "crashed server leaves a stale pid" do
    # Servers are not linked to the cache in this version, so a crash leaves
    # its dead pid in the map and server_process keeps returning it. This is
    # the known limitation that linked and registered versions fix later.
    alice = Todo.Cache.server_process("alice_cache")
    Process.exit(alice, :kill)

    Process.sleep(50)
    assert alice == Todo.Cache.server_process("alice_cache")
  end

  test "repeated start_link is a no-op" do
    {:ok, first} = Todo.System.start_link()
    {:ok, second} = Todo.System.start_link()
    assert first == second
    assert Process.alive?(first)
  end

  test "persistence" do
    john = Todo.Cache.server_process("john")
    Todo.Server.add_entry(john, %{date: ~D[2018-12-20], title: "Shopping"})
    assert 1 == length(Todo.Server.entries(john, ~D[2018-12-20]))

    # add_entry's store is a cast, so it is only queued. A synchronous get on
    # the same database forces ordering: once it returns, the write has been
    # processed and the file is on disk.
    assert %Todo.List{} = Todo.Database.get("john")

    {:ok, supervisor} = Todo.System.start_link()
    Supervisor.stop(supervisor)
    wait_until_stopped()
    ensure_system_running()
    wait_until_cache_ready()

    entries =
      "john"
      |> Todo.Cache.server_process()
      |> Todo.Server.entries(~D[2018-12-20])

    assert [%{date: ~D[2018-12-20], title: "Shopping"}] = entries
  end

  # start_link links the supervisor to whoever calls it, and a supervisor
  # exits when its parent does — even on a normal exit. So we start it from a
  # detached process instead of the test process; otherwise every test that
  # restarted the system would leave it parented to a process that is about
  # to die, and the whole tree would disappear shortly after the test ends.
  defp ensure_system_running do
    case Process.whereis(Todo.System) do
      nil ->
        spawn(fn ->
          Todo.System.start_link()
          Process.sleep(:infinity)
        end)

      pid ->
        if Process.alive?(pid), do: :ok, else: ensure_system_running()
    end

    wait_until_system_ready()
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

  # A stopped cache needs a beat to be restarted by the supervisor; polling
  # avoids a fixed sleep that can race on slower machines.
  defp wait_until_cache_ready(tries \\ 200)
  defp wait_until_cache_ready(0), do: :ok

  defp wait_until_cache_ready(tries) do
    if Process.whereis(Todo.Cache) != nil do
      :ok
    else
      Process.sleep(10)
      wait_until_cache_ready(tries - 1)
    end
  end

  # The cache name lingers briefly after Supervisor.stop returns; restarting
  # before it is gone makes the new child collide with the dying one. The
  # database is started unlinked inside init, so it may legitimately stay up.
  defp wait_until_stopped(tries \\ 200)
  defp wait_until_stopped(0), do: :ok

  defp wait_until_stopped(tries) do
    if Process.whereis(Todo.Cache) == nil do
      :ok
    else
      Process.sleep(10)
      wait_until_stopped(tries - 1)
    end
  end
end
