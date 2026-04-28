# 协议示例

这个脚本主要用于演示 runnerx 的能力：

- 所有内置输入类型（string / number / boolean / enum / multi-enum / file / password）
- 基于 `when` 的字段联动（仅当 `format` 为 `table` 时显示"表格行数"）
- `@@runnerx` 协议：
  - `progress` 推进顶部进度条
  - `log` 输出带级别的日志（绿/黄/红）
  - `result` 渲染结构化结果（表格 / JSON / 文本）

## 协议格式速查

```
@@runnerx progress {"value": 0.5, "message": "..."}
@@runnerx log {"level": "info|warn|error", "message": "..."}
@@runnerx result {"type":"table","title":"...","columns":["a","b"],"rows":[[1,2]]}
@@runnerx result {"type":"image","path":"/abs/preview.png","label":"..."}
@@runnerx result {"type":"file","path":"/abs/output.mp3","label":"..."}
@@runnerx result {"type":"json","data":{...},"label":"..."}
@@runnerx result {"type":"text","data":"...","label":"..."}
```

不带 `@@runnerx` 前缀的行会作为普通 stdout / stderr 滚到下方控制台。
