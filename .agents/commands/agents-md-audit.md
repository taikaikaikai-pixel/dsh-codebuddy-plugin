---
description: 对账 AGENTS.md 与仓库实况（构建/测试/CI/文档分层），防漂移。触发：/agents-md-audit，或"审计 AGENTS.md"、"AGENTS.md 对账"。
---

# AGENTS.md 实况对账

核心原则：AGENTS.md 是薄索引——**≤150 行 / ≤12KB**，深度内容一律 link out。逐行问：
"删掉这行 agent 会犯错吗？"不会就删或下沉到下层文档。先例：commit 90cd0cf（CI 模板
与项目实况漂移）。

按序执行：

1. **预算闸门**：跑 `node scripts/verify-agents-md.mjs`（行数/字节/引用路径/踩坑编号连续性）。
   红 ⇒ 先修红再继续。
2. **命令对账**：「常用命令」每条仍存在且语义一致（对比 `scripts/` 目录、`package.json`
   scripts、`.github/workflows/node.js.yml`）；CI 里跑的命令必须能在本文或
   wiki/09-run-and-test.md 找到。
3. **链接对账**：文档地图与架构表「裁判文档」列指向的文件都存在且仍覆盖所声称的主题
   （抽查标题与节目录，不用全文读）。
4. **编号对账**：踩坑速查 `#N` 集合 == docs/pitfalls.md 编号集（脚本已查，人工复核
   标签是否还概括得对）。
5. **复述检测**：找出复述了下层文档细节的无链接长段落（>150 字）——压成一句话 + 指针；
   反向检查：本文删除某节后，事实在下层文档仍找得到（零信息丢失）。
6. **口径时效**：搜索硬编码的数量/版本口径（模型数、断言数、"#1–#N" 区间），凡是会
   增长的口径一律改成指针或交由断言锁定。
7. **修复与落点**：漂移按维护纪律分流——事实 → docs/rules/，坑 → docs/pitfalls.md，
   命令用法 → wiki/09，UI 回归知识 → .agents/skills/dsh-ui-regression/；本文只留指针。
   改动后复跑第 1 步确认全绿，并在 CHANGELOG 记条目。
