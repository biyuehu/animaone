# TODO

- [ ] 记忆金字塔层级汇总闭环：实现由下而上（topic -> day -> week -> month）聚合压缩机制，避免长期运行后底层的 topic 节点无限堆叠导致 Token 溢出与宏观时间线丢失（参考 `reference/src/memory/summarizer.ts`）。
- [ ] /shut 等机械指令功能
