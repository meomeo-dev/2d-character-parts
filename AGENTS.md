# 项目级代理指南 (Project Agent Guide)

## 项目定位

这是一个本机优先的 2D 角色创作 Studio：它生成和组合角色部件，提供带记忆的
陪伴对话，制作雪碧图动画，并生成桌面宠物 (desktop pet) 图集。

- `server/` 是当前 Web 服务主实现：TypeScript、Hono、AI SDK、Sharp 与 gifenc。
- `templates/` 是无打包步骤的静态前端；浏览器直接加载 HTML、CSS 和 ES modules。
- `scripts/` 保留 Python CLI 与历史行为参照；不要把新的 Web API 实现回迁到
  `scripts/studio.py`。
- 真实外部生成、搜索与嵌入服务可消耗额度。单元测试必须使用 mock，不调用真实服务。

## 目录与职责

- `server/index.ts`：唯一的应用装配入口。保持注册顺序为 CORS、认证、功能路由、
  静态资源；不要在功能修改中随意改变该顺序。
- `server/routes/`：HTTP 边界 (HTTP boundary)。在此解析与校验请求，返回稳定的
  状态码和 JSON 形状；可复用逻辑放到相邻的领域模块。
- `server/` 根目录：图像、LLM、提示词、Provider 和向量记忆等可测试的领域逻辑。
  使用 ESM 导入，并保留相对导入中的 `.ts` 扩展名。
- `server/pet/contract.ts`：桌面宠物固定图集的唯一几何契约 (single source of truth)。
  组合、校验、检查、打包模块必须从这里导出尺寸、行和帧数，不能复制魔术数字。
- `templates/studio.html`：主 Studio 壳；`templates/panels/` 中的模块由
  `templates/panels/index.js` 动态挂载。新增面板时同时增加挂载、DOM 容器和可达入口。
- `config/parts_layout.json` 与 `config/character_profile.json`：角色部件 DAG、布局和
  提示词数据源。它们同时被 Node 服务和 Python CLI 使用。
- `scripts/` 与 `tests/`：Python 行为参照、CLI 和 Pytest 覆盖。修改共享的提示词或
  布局语义时，检查两侧实现是否仍保持一致。
- `parts/`、`animations/`、`pets/`：运行期生成物。保留各目录的 `.gitkeep`，不要提交
  生成的图像、图集、动画或运行记录。
- `docs/`：流式图像协议等实现说明。协议或可观察行为改变时同步维护对应文档。

## 变更约束

- TypeScript 受 `strict` 与 `noUncheckedIndexedAccess` 约束。先缩窄 `unknown`，再使用；
  不以断言绕过不可信的请求、文件或上游响应。
- 新增 `/api/*` 路由必须通过现有认证中间件；不得新增绕过 Bearer token 或会话 cookie
  的 API、模板、部件、动画或宠物静态资源路径。
- 默认监听地址必须保持 `127.0.0.1`。改动 CORS 时只允许明确的来源，不能回退到通配符
  或回显任意 `Origin`。
- Provider 响应、日志、错误信息和测试夹具不得泄露 API key、`AUTH_TOKEN` 或完整
  `runtime_settings.json`。读取 Provider 配置时继续只暴露脱敏状态和末四位提示。
- `config/runtime_settings.json`、向量记忆与生成资产均为本地运行状态，不是可提交配置。
  新增设置时补充 `config/runtime_settings.example.json`，并保持密钥可选且不回显。
- 图像生成流和重试逻辑必须保持可取消、可测试的边界。为上游格式、重试或回退行为的
  变更添加 mock 覆盖，不要用真实 API 验证。
- 修改宠物图集时，将固定几何、透明像素、未用格和行帧数视为不可分割的契约；同步更新
  `contract`、组合、校验、检查、打包及其测试。
- 修改部件布局或角色提示词时，保留 DAG 依赖、部件 ID、左右互斥和覆盖层对齐语义。
  同时检查 Node 与 Python 的提示词测试及相关模板是否需要更新。

## 测试与验证

按受影响范围执行验证；涉及共享契约、路由、Provider、图像处理或配置时运行完整套件：

```bash
npm run typecheck
npm test
python3 -m pytest tests -q
```

- TypeScript 测试使用 Node 内置测试运行器；保持测试文件位于 `server/**/*.test.ts`，并用
  `node:assert/strict` 和模块 mock 隔离外部服务。
- Python 测试位于 `tests/`；Python 实现改动应至少运行对应测试文件，例如
  `python3 -m pytest tests/test_prompts.py -q`。
- 提交前可运行 `pre-commit run --all-files`。它会执行 Ruff、格式化、JSON/YAML 检查、
  密钥扫描、Bandit、Mypy 与 Python 测试。
- 文档或配置修改也要执行 `git diff --check`，并确认 JSON 可解析。不要把测试生成的
  输出目录、密钥或大二进制文件带入差异。

## 任务记录

对于非琐碎任务，先在 `.todo_tasks/` 创建本批次 JSON，再开始调查或修改；文件名使用
`YYYYMMDD_<domain>_<scope>_<concept>_<verb-title>.json`。任务条目至少包含负责人、状态、
优先级、依赖、涉及文件与简洁说明；同名 Markdown 文件记录执行报告。除非当前任务明确
延续或引用，不读取历史任务记录。

## 交付前检查

- 只保留与任务相关的源码、测试、配置或文档变更。
- 复查路径、路由、JSON 字段和静态资源 URL 是否与现有约定一致。
- 将实际执行的验证命令及其结果简洁报告；未运行的检查必须说明原因。
