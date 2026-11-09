defmodule HttpServerTest do
  use ExUnit.Case, async: false
  import Plug.Test

  test "no entries" do
    assert get("/entries?list=test_1&date=2018-12-19").status == 200
    assert get("/entries?list=test_1&date=2018-12-19").resp_body == ""
  end

  test "adding an entry" do
    resp = post("/add_entry?list=test_2&date=2018-12-19&title=Dentist")

    assert resp.status == 200
    assert resp.resp_body == "OK"
    assert get("/entries?list=test_2&date=2018-12-19").resp_body == "2018-12-19 Dentist"
  end


  test "unknown path returns 404" do
    resp = get("/nonexistent")
    assert resp.status == 404
  end

  test "empty list returns an empty body, still a 200" do
    resp = get("/entries?list=empty_#{System.unique_integer([:positive])}&date=2018-12-19")
    assert resp.status == 200
    assert resp.resp_body == ""
  end

  defp get(path) do
    Todo.Web.call(conn(:get, path), Todo.Web.init([]))
  end

  defp post(path) do
    Todo.Web.call(conn(:post, path), Todo.Web.init([]))
  end
end
