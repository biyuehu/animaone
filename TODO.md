# TODO

- [ ] 增加安全机制：
  - [ ] 入站消息过滤与脱敏：在进入大模型 `contents` 历史记录与上下文之前，过滤严重违规词汇（涉黄、暴恐、违禁药物及敏感器官词），避免恶意输入污染整个会话滑动窗口导致触发 Google 的 `PROHIBITED_CONTENT` 封锁拒答。
  - [ ] 异常熔断自愈：当遭遇 `promptFeedback.blockReason === 'PROHIBITED_CONTENT'` 时，自动剔除最近一轮的可疑入站内容并降级重试，防止上下文瘫痪死锁。
- [ ] 记忆金字塔层级汇总闭环：实现由下而上（topic -> day -> week -> month）聚合压缩机制，避免长期运行后底层的 topic 节点无限堆叠导致 Token 溢出与宏观时间线丢失（参考 `reference/src/memory/summarizer.ts`）。
- [ ] 数据库批量写入事务保护：将多条概念联想边（`memory_links`）插入以及消息持久化与滑动修剪包裹进 `db.transaction`，避免并发或密集消息时逐条 fsync 拖慢主线程并保证原子性（参考 `reference/src/memory/repository.ts`）。
