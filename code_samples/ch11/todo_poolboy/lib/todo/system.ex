defmodule Todo.System do
  def start_link do
    Supervisor.start_link(
      [
        Todo.Metrics,
        Todo.ProcessRegistry,
        Todo.Database,
        Todo.Cache
      ],
      strategy: :one_for_one,
      name: __MODULE__
    )
  end
end
