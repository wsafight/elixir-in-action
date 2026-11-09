defmodule Todo.DatabaseTest do
  use ExUnit.Case, async: false

  setup_all do
    # App-based projects already run the whole tree under Todo.System.
    # Standalone ones need an explicit start. Probe the top-level system (or,
    # in ch07, the cache itself) rather than the database: intermediate
    # processes come and go during restarts, so they are a poor signal for
    # "is the system up".
    #
    # The start happens in a detached process: a started supervisor exits
    # when its parent does, so linking it to this (soon-to-die) setup process
    # would tear the whole tree down when the module finishes.
    spawn(fn ->
      cond do
        Code.ensure_loaded?(Todo.System) ->
          Todo.System.start_link()

        Process.whereis(Todo.Cache) == nil ->
          apply(Todo.Cache, :start, [])

        true ->
          :ok
      end

      Process.sleep(:infinity)
    end)

    wait_until_up()
    :ok
  end

  test "store and get round-trip" do
    key = "db_test_#{System.unique_integer([:positive])}"
    value = %{date: ~D[2018-12-19], title: "Round trip"}

    Todo.Database.store(key, value)
    Process.sleep(50)

    assert Todo.Database.get(key) == value
  end

  test "missing key returns nil" do
    assert Todo.Database.get("missing_#{System.unique_integer([:positive])}") == nil
  end

  test "empty file is treated as missing" do
    key = "empty_#{System.unique_integer([:positive])}"
    File.write!(Path.join(db_folder(), key), "")

    assert Todo.Database.get(key) == nil
  end

  defp db_folder do
    "#{File.cwd!()}/persist"
  end

  defp wait_until_up(tries \\ 200)
  defp wait_until_up(0), do: :ok

  defp wait_until_up(tries) do
    if Process.whereis(Todo.Database) != nil do
      :ok
    else
      Process.sleep(10)
      wait_until_up(tries - 1)
    end
  end
end
