defmodule Todo.System do
  def start_link do
    # Starting an already running system is a no-op: callers get the existing
    # supervisor instead of an {:error, {:already_started, _}} exit. This keeps
    # repeated start_link calls safe (e.g. in tests).
    case Supervisor.start_link(
           [Todo.Cache],
           strategy: :one_for_one,
           name: __MODULE__
         ) do
      {:error, {:already_started, pid}} -> {:ok, pid}
      other -> other
    end
  end
end
