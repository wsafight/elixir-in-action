---
order: 5
title: 用数据构建 Todo
description: 一个 Map 如何长成结构体。跟着四个版本的清单示例，看数据形状怎样一步步承担业务。
part: 1
duration: 34
topics: [结构体, Map, 纯函数, TodoList, MultiDict, Enum.reduce, 文件流]
samples:
  - { label: '清单 v1（日期为键）', path: code_samples/ch04/simple_todo.ex }
  - { label: '清单 v2（抽出 MultiDict）', path: code_samples/ch04/todo_multi_dict.ex }
  - { label: '清单 v3（条目为 map）', path: code_samples/ch04/todo_entry_map.ex }
  - { label: '分数结构体', path: code_samples/ch04/fraction.ex }
  - { label: '清单 v4（编号为键）', path: code_samples/ch04/todo_crud.ex }
  - { label: '清单构造器', path: code_samples/ch04/todo_builder.ex }
  - { label: 'CSV 导入器', path: code_samples/ch04/todo_import.ex }
---

到目前为止，我们还没有需要常驻的服务。待办清单先是一个值，新增、更新和删除则是从旧值计算新值的函数。先让业务逻辑脱离进程，之后才容易决定状态应该由谁保存。

配套示例里有四个版本的 TodoList。它们不是随手堆的，每一版都在解决上一版解决不了的问题。这一章按演进顺序读。

## 第一版：一个 Map 就够了

`simple_todo.ex` 是最朴素的清单：键是日期，值是标题列表。

```elixir
defmodule TodoList do
  def new(), do: %{}

  def add_entry(todo_list, date, title) do
    Map.update(todo_list, date, [title], fn titles -> [title | titles] end)
  end

  def entries(todo_list, date) do
    Map.get(todo_list, date, [])
  end
end
```

三个函数都很短，逐个看。`new/0` 返回空 map `%{}`：清单就是一个 map，没有结构体、没有初始化仪式。`add_entry/3` 是唯一的改动入口，核心是 `Map.update/4`：第一个参数是要改的 map，第二个是键，第三个是"键不存在时的初值" `[title]`，第四个是"键存在时的更新函数" `fn titles -> [title | titles] end`，把新标题接到已有列表头部。两种情况都用这一行覆盖，不需要先查在不在。

```sh
iex -r simple_todo.ex
```

```elixir
iex> todos = TodoList.new() |> TodoList.add_entry(~D[2026-11-09], "Dentist")
%{~D[2026-11-09] => ["Dentist"]}
iex> TodoList.entries(todos, ~D[2026-11-09])
["Dentist"]
iex> TodoList.entries(todos, ~D[2026-11-10])
[]
```

第一行的返回值就是整个 map：`%{"日期" => ["标题"]}`。`|>` 把 `new()` 的结果塞进 `add_entry` 的第一个参数，链条读起来是"先建空清单，再往里面加一条"。后面两行查日期，一个有值一个返回 `[]`——`entries/2` 不挑情况，拿不到就用默认值兜底。

这版能记多条同日待办，但有三件事说不出来：条目没有编号，删一条、改一条都无从引用；条目只有标题，加个优先级就没地方放；"键对应多个值"这个模式写死在 TodoList 里，别处要用得再抄一遍。

## 第二版：把"一键多值"抽出去

`todo_multi_dict.ex` 把键到多值列表的映射抽成 `MultiDict` 模块：

```elixir
defmodule MultiDict do
  def new(), do: %{}

  def add(dict, key, value) do
    Map.update(dict, key, [value], &[value | &1])
  end

  def get(dict, key) do
    Map.get(dict, key, [])
  end
end
```

`MultiDict` 三个函数就是 `simple_todo` 里那三个的翻版，只是参数名换了：`dict` 是那张 map，`key` 是日期，`value` 是标题。抽象掉的是"key 对应一个列表"这个模式本身。

`add` 里那串 `&[value | &1]` 是匿名函数的简写：`&1` 是第一个参数，展开就是 `fn list -> [value | list] end`。`Map.update` 调用它时会把当前键上的旧值传进来。

TodoList 自己只剩三行转发：`new` 调 `MultiDict.new()`，`add_entry` 调 `MultiDict.add/3`，`entries` 调 `MultiDict.get/2`。数据怎么存的细节归 MultiDict 管。

这次抽象的意义不在省行数，在于给这个结构起了名字、圈了边界。以后要改存储——比如同一天内的排序——只动 MultiDict。

## 第三版：条目从标题长成 map

`todo_entry_map.ex` 里，`MultiDict` 原样保留，TodoList 的值从字符串变成了条目：

```elixir
def add_entry(todo_list, entry) do
  MultiDict.add(todo_list, entry.date, entry)
end
```

现在条目可以带 `%{date: ..., title: ...}` 甚至更多字段。代价是查询的粒度还是日期：同一天的事揉在一个列表里，想改其中一条，得先找到它再整个塞回去。

日期字段本身用的是 `Date` 结构体，只管年月日。`~D[2026-11-09]` 是字面量写法，`Date.from_iso8601("2026-11-09")` 解析字符串，返回 `{:ok, date}` 或 `{:error, _}`——第 16 章的 HTTP 边界就靠它区分合法输入和坏输入。如果以后要给条目加"几点几分"，那是 `NaiveDateTime`（不带时区）或 `DateTime`（带时区，但默认只有 UTC 数据库）的地盘，和 `Date` 是三个不同模块。

到这一步，"按日期当键"的代价浮出来了。日期适合做查询，不适合做身份——同日多条、条目改名、删除某条，都需要一个稳定的东西指认"是哪一条"。这个东西就是编号。

## 第四版：编号为键，日期变回普通字段

`todo_crud.ex` 把结构翻过来：

```elixir
defstruct next_id: 1, entries: %{}
```

`defstruct` 声明一个结构体：它本质上是带固定字段集合的 map，字段在编译期就确定。`next_id: 1` 是字段名加默认值——新清单还没分配过编号，下一次分配的是 `1`；`entries` 仍然是"键 → 条目"的 map，但键换成了编号，日期降格成条目的一个普通字段。

在这之前，`fraction.ex` 先演示了结构体本身：

```elixir
defmodule Fraction do
  defstruct a: nil, b: nil
end
```

两行就看完：`defstruct` 声明两个字段 `a` 和 `b`，默认值都是 `nil`。`Fraction.new(3, 4)` 之类的函数会返回 `%Fraction{a: 3, b: 4}`——`%Fraction{...}` 是这个结构体值的样子，模块名写在 `%` 后面、花括号前面。`Fraction.add/2` 不修改输入，而是返回另一个 `%Fraction{}`。Todo 沿用同一个思路。

结构体提供明确的字段集合，`%TodoList{next_id: 2}` 合法，`%TodoList{nxt_id: 2}` 在编译期就报错——拼错字段名当场被编译器拦住，这是 struct 比裸 map 多出来的东西。但它不会自动验证业务约束：不保证分母非零，也不保证一个 Todo 条目具有合法日期。构造函数和边界验证仍然有自己的工作。

## 新增就是计算下一个清单

`add_entry/2` 先把编号放进条目，再更新映射，最后返回新结构体：

```elixir
entry = Map.put(entry, :id, todo_list.next_id)
new_entries = Map.put(todo_list.entries, todo_list.next_id, entry)

%TodoList{
  todo_list
  | entries: new_entries,
    next_id: todo_list.next_id + 1
}
```

三步连起来读。第一步给条目补编号：`Map.put/3` 往 map 里塞键值对，条目的 `:id` 字段设为当前 `next_id`——也就是说 `1` 号条目诞生在这一行。第二步把这条编号的条目塞进 `entries` map，键就是刚分配的编号。第三步用 `%{todo_list | ...}` 语法生成新结构体：以旧清单为底，只替换 `entries` 和 `next_id` 两个字段，`next_id` 自增到 `2`。竖线 `|` 左边是"以谁为底"，右边列要覆盖的字段。

`Map.put/3` 是"覆盖式写入"，同名键会换掉旧值；`Map.update/4` 是"给个函数变"，需要旧值。`%TodoList{... | ...}` 的竖线只许改已声明字段，想加新字段编译就拦下。

```sh
iex -r todo_crud.ex
```

```elixir
iex> original = TodoList.new()
%TodoList{next_id: 1, entries: %{}}
iex> updated = TodoList.add_entry(original, %{date: ~D[2026-11-09], title: "读懂结构体"})
%TodoList{entries: %{1 => %{date: ~D[2026-11-09], id: 1, title: "读懂结构体"}}, next_id: 2}
iex> TodoList.entries(original, ~D[2026-11-09])
[]
iex> TodoList.entries(updated, ~D[2026-11-09])
[%{date: ~D[2026-11-09], id: 1, title: "读懂结构体"}]
```

前两行的返回值把内部结构全摊开：`original` 是空的 `%TodoList{}`，`updated` 的 `entries` 里多了一条 `1 => %{...}`。后两行对照最说明问题——查询旧清单 `original` 返回 `[]`，它根本没动过；新条目只存在于 `updated` 里。这就是"不可变"四个字落在代码里的样子。

## 查询不应该悄悄改变状态

`entries/2` 取出映射中的所有条目，再按日期筛选。它只返回结果，不碰清单本身。

注意，`Map.values` 的枚举顺序不应当被当成业务上的排序保证。如果界面要求按编号、创建时间或标题显示，需要明确调用 `Enum.sort_by`。不能因为一次 IEx 输出看起来有序，就把它写进接口承诺。

这个版本的按日期查询需要检查全部条目。数据量不大时，它足够简单。数据量大时，要先测量，再考虑日期索引，以及索引与主数据如何一起更新。

## 把变化交给一个函数

`update_entry/3` 接受 `updater_fun`。模块负责找到旧条目，调用者负责描述怎么改：

```elixir
def update_entry(todo_list, entry_id, updater_fun) do
  case Map.fetch(todo_list.entries, entry_id) do
    :error ->
      todo_list

    {:ok, old_entry} ->
      new_entry = updater_fun.(old_entry)
      new_entries = Map.put(todo_list.entries, new_entry.id, new_entry)
      %TodoList{todo_list | entries: new_entries}
  end
end
```

`Map.fetch` 和 `Map.get` 的区别在返回值：`fetch` 拿不到键返回 `:error`，拿到返回 `{:ok, 值}`——两种结果被包进不同形状的元组，正好交给 `case` 拆。`:error` 分支把原清单原样返回，`{:ok, old_entry}` 分支才继续：`updater_fun.(old_entry)` 用点号调用匿名函数，让调用者的变换跑在旧条目上；然后用**新条目的 id** 当键塞回 `entries`，更新整个结构体。

调用现场长这样：

```elixir
updated = TodoList.update_entry(updated, 1, fn entry ->
  %{entry | title: "再读一遍结构体"}
end)
```

`%{entry | title: ...}` 是 map 的更新语法（map 和结构体共用竖线写法）：以 `entry` 为底，只换 `title`。这样就不必为改标题、改日期分别设计一套查找流程。找不到编号时，当前实现返回原清单，这也是一种接口选择。

这里还藏着一个适合练习的约束：`todo_crud.ex` 使用更新后条目的 `id` 作为映射键，却没有阻止 updater 修改 `id`。如果 updater 把 `1` 改成 `2`，旧键可能仍留在映射中。**updater 能改任何字段，所以需要明确哪些字段允许改变。**

`todo_builder.ex` 和 `todo_crud.ex` 的 TodoList 完全一样，只是演示 `new/1` 的另一种用法：传一串条目，折叠成清单。

```elixir
def new(entries \\ []) do
  Enum.reduce(
    entries,
    %TodoList{},
    &add_entry(&2, &1)
  )
end
```

`new/1` 的 `\\ []` 是默认参数：不传参数时 `entries` 就是 `[]`，一个函数顶 `new/0` 和 `new/1` 两个入口。函数体是一次 `Enum.reduce`——三个参数分别是集合、初始累加器、折叠函数。这里的折叠函数是 `&add_entry(&2, &1)`：`&1` 是当前元素（一条待办），`&2` 是累加器（到目前为止的清单），`add_entry(&2, &1)` 调出来就是 `add_entry(清单, 条目)`——reduce 把"元素在前"的回调签名适配回 `add_entry` 的"清单在前"。

跑一遍就很直观：`Enum.reduce` 从空 `%TodoList{}` 出发，每来一条就调一次 `add_entry` 换一个新清单，最后返回折叠完的清单。这个"列表进、结构出"的入口，正好被下面的导入器用上。

## 从一串变换导入文件

`todo_import.ex` 让文件流依次经过去换行、拆字段、解析日期、构造条目，再由 `TodoList.new/1` 折叠成完整清单：

```elixir
def import(file_name) do
  file_name
  |> read_lines
  |> create_entries
  |> TodoList.new()
end
```

`import/1` 是一条管道：文件名先进 `read_lines` 变成惰性行流，再进 `create_entries` 变成条目流，最后交给 `TodoList.new/1`——就是上一节那个 `Enum.reduce` 入口，一次折叠成清单。

前两步各自是一个私有函数：

```elixir
defp read_lines(file_name) do
  file_name
  |> File.stream!()
  |> Stream.map(&String.trim_trailing(&1, "\n"))
end

defp create_entries(lines) do
  Stream.map(
    lines,
    fn line ->
      [date_string, title] = String.split(line, ",")
      date = Date.from_iso8601!(date_string)
      %{date: date, title: title}
    end
  )
end
```

`File.stream!/1` 不把文件读进内存，返回一个流，一个"被枚举时才逐行吐数据"的惰性结构。`Stream.map/2` 在流上再叠一个变换：每行出来时去掉尾部换行 `String.trim_trailing(&1, "\n")`。注意这是 `Stream.map` 不是 `Enum.map`：前者只记下变换、不执行，等下游真正枚举时才跑。

`create_entries` 同样是个 `Stream.map`，每行干三件事：`String.split(line, ",")` 按逗号拆成两截，匹配 `[date_string, title]` 一次绑定两个变量；`Date.from_iso8601!` 把 `"2026-11-09"` 这种字符串解析成 `Date` 结构体——叹号版本解析失败直接抛异常；最后组装成 `%{date: ..., title: ...}` 的条目 map。整个链条没有中间变量、没有临时列表，数据像水一样流过三段管道，在最后一步 `Enum.reduce` 才真正消费。

这个 CSV 导入器用的是简单的 `String.split(line, ",")`。它没有处理标题中的逗号、带引号字段或无效日期，够配套样例用，但不是通用 CSV 解析器。流式读取也不代表最终清单不占内存：构建好的所有条目仍然保存在结果中。

```sh
iex -r todo_import.ex
```

在 IEx 中运行 `TodoList.CsvImporter.import("todos.csv")`（示例目录下带一份 `todos.csv`），先观察实际数据，再读导入链上的每一步。

## 动手验证

用 `elixir tests.exs` 跑配套测试，再在自己的副本中补上一个测试：更新标题之后，条目编号和条目数量都不应改变。

**练习**：给 `update_entry/3` 设计编号保护——拒绝编号变化，或在调用 updater 后强制保留原编号，两种方式给调用者的错误处理体验不同，先写下你的约定。再回去做第二件事：给 `MultiDict` 补一个 `delete(dict, key)`，或者反过来，把条目标题当成键，建一个"标题 → 日期列表"的 MultiDict，看看查询接口要怎么变。

下一章开始，这份不可变的 TodoList 会被一个进程持有。业务函数不需要知道进程的存在，因为现在的核心一直保持在纯函数里。到第 9 章搬进 Mix 项目时，模块会改叫 `Todo.List`——同一套代码，换了一个带名字空间的名字。
