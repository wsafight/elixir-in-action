defmodule Todo.DatabaseWorker do
  use GenServer

  def start_link(db_folder) do
    GenServer.start_link(__MODULE__, db_folder)
  end

  def store(pid, key, data) do
    GenServer.call(pid, {:store, key, data})
  end

  def get(pid, key) do
    GenServer.call(pid, {:get, key})
  end

  @impl GenServer
  def init(db_folder) do
    IO.puts("Starting database worker.")
    {:ok, db_folder}
  end

  @impl GenServer
  def handle_call({:store, key, data}, _, db_folder) do
    # Write to a temporary file and rename it over the target. Rename is
    # atomic, so readers never see a partially written or empty file if
    # the worker dies mid-write.
    target = file_name(db_folder, key)
    File.write!(target <> ".tmp", :erlang.term_to_binary(data))
    File.rename!(target <> ".tmp", target)

    {:reply, :ok, db_folder}
  end

  def handle_call({:get, key}, _, db_folder) do
    data =
      case File.read(file_name(db_folder, key)) do
        {:ok, ""} -> nil
        {:ok, contents} -> :erlang.binary_to_term(contents)
        _ -> nil
      end

    {:reply, data, db_folder}
  end

  defp file_name(db_folder, key) do
    Path.join(db_folder, to_string(key))
  end
end
