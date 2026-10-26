# TODO

- [ ] 增加安全机制：
  - [ ] 入站消息过滤与脱敏：在进入大模型 `contents` 历史记录与上下文之前，过滤严重违规词汇（涉黄、暴恐、违禁药物及敏感器官词），避免恶意输入污染整个会话滑动窗口导致触发 Google 的 `PROHIBITED_CONTENT` 封锁拒答。
  - [ ] 异常熔断自愈：当遭遇 `promptFeedback.blockReason === 'PROHIBITED_CONTENT'` 时，自动剔除最近一轮的可疑入站内容并降级重试，防止上下文瘫痪死锁。
