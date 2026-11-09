defmodule Todo.System do
  def start_link do
    Supervisor.start_link(
      [
        Todo.Metrics,
        Todo.Database,
        Todo.Cache,
        Todo.Web
      ],
      strategy: :one_for_one,
      name: __MODULE__
    )
  end
end
