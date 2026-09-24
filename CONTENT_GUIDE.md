# 课文写作规范

课程大纲与元数据在 `src/content/curriculum.ts`，正文放在 `src/content/lessons/<stage-id>/<slug>.md`，文件名必须等于大纲里的 `slug`。

## 读者与语气

- 读者：会用 Linux 命令行、但没系统学过存储的工程师或应届生，按阶段一路学到能设计和运维生产存储集群。
- 语言：简体中文。专有名词第一次出现时给英文原词，例如"页缓存（Page Cache）"。命令、参数、指标名保持英文（`iostat`、`await`、`HEALTH_WARN`）。
- 先讲"为什么需要它"，再讲"它是什么"，最后"怎么用"和"生产里要注意什么"。
- 有观点：给出明确的建议和经验法则（"没有基线的调优都是玄学"），而不是罗列选项。
- 每个概念尽量配一个能在单台 Linux 虚拟机里真实运行的例子（loop 设备、虚拟盘都算）。阶段 4、5 的生产内容明确说明需要的环境（节点数、盘、网络）。
- 不要空话套话，不要"总而言之"式的收尾段。

## 文件结构

```markdown
# 课文标题（与 curriculum.ts 中 title 一致，页面会自动隐藏这一行）

开篇 1～2 段：这一课解决什么问题，学完能做什么。

## 二级标题 …（进入右侧目录）
### 三级标题 …（进入右侧目录）

## 动手练习
1. …（可操作的小任务，3～5 条）

## 自测
<details>
<summary>问题一？</summary>

答案（summary 后面空一行，答案里可以用 Markdown）。

</details>

## 参考资料
- [Linux 内核文档：xxx](https://docs.kernel.org/...)
```

## 可用的 Markdown 扩展

- 代码块带文件名：` ```ini title="job.fio" `。支持高亮的语言：bash/sh/console、yaml、json、ini/toml、c（bpftrace 脚本也用 `c`）、go、python、text。
- 提示框（blockquote 第一行写类型，可选自定义标题）：

  ```markdown
  > [!TIP] 可选的标题
  > 内容……
  ```

  类型：`NOTE` 说明、`TIP` 提示、`WARNING` 注意、`DANGER` 危险、`LAB` 动手实验、`PROD` 生产实践、`QUEST` 闯关挑战。
- 表格用 GFM 语法；架构图、I/O 路径图用 ` ```text ` 代码块画 ASCII 图。
- 课程之间互相引用用站内链接：`[页缓存](/learn/page-cache)`。容量计算器在 `/calculator`。

## 内容来源

- Brendan Gregg《Systems Performance, 2nd Edition》：方法论（第 2 章）、可观测工具（第 4 章）、文件系统（第 8 章）、磁盘（第 9 章）、基准测试（第 12 章）、BPF（第 15 章）。用自己的话讲解并注明出处，不要大段翻译原文。
- 团队实践仓库 `k8s-in-action` 的 `storage/` 目录（cephadm、Rook、Ceph CSI、GPFS、Weka、VAST、XSKY、JuiceFS、3FS、elbencho 等）。引用时去掉内部域名、内部 IP 和公司名，改成 `example.com`、`192.168.x.x` 这类通用示例。
- 官方文档：Linux 内核文档、Ceph 文档（https://docs.ceph.com/）、Kubernetes 文档（https://kubernetes.io/zh-cn/docs/）、IBM Storage Scale 文档等，链接要真实存在。
- 版本号：组件版本写"截至本文写作时"的版本并提醒读者以官方发布为准。
