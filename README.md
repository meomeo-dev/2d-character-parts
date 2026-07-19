# 2D Character Parts — 2D 角色骨骼动画部件工具

2D 角色的**创建 · 陪伴 · 动作**一体化工具。三大能力：

1. **创建 2D 角色**（Create）：将角色拆分为 19 个独立 Sprite 部件（透明底），通过 DAG 管线分阶段生成，支持参考图引导的 img2img。
2. **对话陪伴**（Companion）：带记忆的 LLM 陪伴对话，通过 Vercel AI Gateway 多 provider 切换，工具调用可驱动 2D 动作与联网搜索/抓取（Jina）。
3. **动作动画**（Animation）：文字/网格 → 图像大模型逐帧重绘 → 切帧组 GIF 的雪碧图动画生成。

图像生成默认走 **OpenAI gpt-image**（generate/edit，自定义 base_url/key/model），保留 OpenRouter / SiliconFlow 作为可选后端。

## 目录结构

```
2d-character-parts/
├── README.md
├── .gitignore
├── .pre-commit-config.yaml
├── config/
│   ├── parts_layout.json             # 18 个部件的坐标、尺寸、分组、DAG 管线
│   └── character_profile.json        # 角色外观 + 质量/负面/AR 预设
├── scripts/
│   ├── generate_prompts.py           # CLI 提示词生成器（19 条带互斥约束的 prompt）
│   ├── generate_template.py          # SVG 网格目录模板生成
│   ├── compose_parts.py              # 独立部件 PNG → 完整精灵图合成
│   ├── openrouter.py                 # OpenRouter API 客户端（原生/聊天模式）
│   └── studio.py                     # 本地 Studio 服务器（API 代理 + 配置面板）
├── templates/
│   ├── exploded_view.svg             # 网格目录 SVG 模板
│   ├── viewer.html                   # 离线静态预览
│   └── studio.html                   # Canvas 编辑器（lil-gui 控制面板 + 调用日志）
└── parts/                            # 生成图片输出目录
    └── .gitkeep
```

## 快速开始

### 方式 A：Studio Web UI（推荐，Node / AI SDK 后端）

后端已迁移到 **Node + [AI SDK v7](https://sdk.vercel.ai)**（hono 服务）：chat 与图像生成统一走 ai-sdk（`@ai-sdk/openai-compatible`），prompt 生成 / 抠图 / 合成 / GIF 由 sharp + gifenc 实现。

```bash
# 1. 安装依赖（首次；含 sharp 原生二进制）
npm install

# 2. 启动 Studio（默认 127.0.0.1:8765）
npm start                 # = tsx server/index.ts
PORT=8080 npm start       # 自定义端口
# → 浏览器打开 http://localhost:8765

# 3. 在 ⚙ Settings → 🔌 Providers 里配置（无需环境变量，持久化到 config/runtime_settings.json）：
#    - LLM：Base URL / API Key / Model（provider→model 二级选择，点"⟳ 拉取模型"）
#    - Image：图像生成 base_url / key / model（gpt-image 等）
#    - Jina：向量记忆 embed + 联网搜索/抓取的 key
#    也可用环境变量：AI_GATEWAY_API_KEY / OPENAI_API_KEY / JINA_API_KEY
```

> **模型说明**：LLM Base URL 只需填代理根（如 `https://ai-gateway.vercel.sh/v1`）；
> ai-sdk 会自行拼 `/chat/completions`、`/images/generations`。模型列举独立处理
> （自动尝试 `/models` 与 `/v1/models`），无 key 也能列出开放网关的模型。

开发命令：`npm run typecheck`（tsc strict）、`npm test`（node --test，65 用例）。

> **Legacy**：`scripts/*.py`（原 `python3 scripts/studio.py`）暂作行为参照 / fallback 保留，不再是主入口。

### 方式 B：命令行批量生成

```bash
export OPENROUTER_API_KEY=sk-or-xxx
python3 scripts/openrouter.py --batch
# 按 DAG 管线分 6 阶段生成：全局参考 → 躯干 → 下肢 → 上肢 → 头部 → 表情
```

## CLI 命令参考

```
python3 scripts/generate_prompts.py                    # 全部 19 条（分栏）
python3 scripts/generate_prompts.py --batch             # 纯文本模式
python3 scripts/generate_prompts.py --list              # 部件清单
python3 scripts/generate_prompts.py --global            # 全局参考图
python3 scripts/generate_prompts.py head                # 单个部件

python3 scripts/generate_template.py                    # 生成 SVG 模板
python3 scripts/compose_parts.py                        # 合成精灵图

python3 scripts/openrouter.py --prompt "cat" --output test.png  # 单张生成
python3 scripts/openrouter.py --batch                          # DAG 管线批量
python3 scripts/openrouter.py --list-models                    # 查看可用模型

python3 scripts/studio.py                              # 启动 Studio UI 服务器
python3 scripts/studio.py --port 8080                  # 自定义端口
python3 scripts/studio.py --model <model-id>           # 指定默认模型
```

## DAG 管线（6 阶段）

| Stage | 名称 | 部件 | 依赖 | 模型 |
|-------|------|------|------|------|
| 0 | 全局参考 | global_reference | — | seedream-4.5 (t2i) |
| 1 | 躯干 | torso | global_ref | gemini-3.1-flash (img2img) |
| 2 | 下肢 | thigh_L/R, calf_L/R, foot_L/R | torso | gemini-3.1-flash |
| 3 | 上肢 | upper_arm_L/R, forearm_L/R, hand_L/R | torso | gemini-3.1-flash |
| 4 | 头部 | head | torso | gemini-3.1-flash |
| 5 | 表情 | expr_happy_eyes, expr_closed_eyes, expr_smile_mouth, expr_surprised_mouth | head | gemini-3.1-flash |

## OpenRouter API 集成

| 项目 | 值 |
|------|----|
| Endpoint | `POST https://openrouter.ai/api/v1/chat/completions` |
| 认证 | `Authorization: Bearer <OPENROUTER_API_KEY>` |
| Stage 0 模型 | `bytedance-seed/seedream-4.5` (原生 t2i) |
| Stage 1-5 模型 | `google/gemini-3.1-flash-image-preview` (img2img with refs) |
| 全局图片尺寸 | 9:16 (2K) |
| 部件图片尺寸 | 1:1 (1K) |

## 每条提示词结构

```
Positive:   masterpiece, best quality, ...              ← 质量标签
            anime style, clean lineart, flat shading    ← 风格
            1girl, head only, front view, silver hair   ← 主体描述（按部件定制 + 视角）
            transparent background, alpha channel       ← 透明底 Sprite

Negative:   lowres, bad anatomy, ...                    ← 389 字符基础负面
            no other parts, no overlap, ...             ← 部件互斥约束（每部件 10-32 条）

AR:         1:1 (部件) / 9:16 (全局参考 45° 侧视)
```

在 `config/character_profile.json` 中修改任意字段，所有 19 条提示词自动联动。

## Sprite 设计标准

- **视角**：所有部件部件使用**正视图**（front view）；全局参考图使用 **45° 侧视微俯角**
- **透明底**：所有 Sprite 部件必须在透明画布上渲染，方便引擎合成
- **部件互斥**：每个部件的 negative prompt 严格排除相邻/重叠部位，确保拼接无冲突
- **表情层**：眼睛 Sprite 仅含眼+眉（透明底），嘴部 Sprite 仅含鼻+嘴（透明底），覆盖在空白面部基础层上

## 布局示意

```
第1行 ─────────────────────────────────────────
┌──────────┐  ┌──────────────┐  ┌─────────────┐
│   头部   │  │    躯干      │  │ 表情 2×2     │
│ 180×170  │  │   260×340    │  │ 4 个小网格   │
└──────────┘  └──────────────┘  └─────────────┘

第2行（上肢）────────────────────────────────────
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌────┐ ┌────┐
│左上臂│ │右上臂│ │左前臂│ │右前臂│ │左手│ │右手│
│90×160│ │90×160│ │80×145│ │80×145│70×70│70×70│

第3行（下肢）────────────────────────────────────
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│左大腿│ │右大腿│ │左小腿│ │右小腿│ │左脚  │ │右脚  │
│95×155│ │95×155│ │85×140│ │85×140│ │90×35 │ │90×35 │
```

## 依赖

- Python 3.8+
- Pillow（合成精灵图时需要）
- OpenRouter API Key（自动化生成时需要）

## 开发

```bash
# 安装 pre-commit 钩子
pre-commit install

# 手动运行所有检查
pre-commit run --all-files
```

## 环境变量与 Provider 配置

三类外部服务的 key 通过环境变量或 `config/runtime_settings.json`（git-ignored，见 `config/runtime_settings.example.json`）配置，由 `scripts/providers.py` 统一解析。**key 只经 provider 层读取并放入 Authorization 头，绝不写入日志或响应体。**

| 服务 | 环境变量 | 默认 base_url | 默认模型 |
|------|----------|---------------|----------|
| LLM（对话）| `AI_GATEWAY_API_KEY` | `https://ai-gateway.vercel.sh/v1` | `openai/gpt-5.5`（用 `GET /v1/models` 查实时 ID）|
| 图像（角色/动画）| `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-image-1` |
| 向量/搜索/抓取 | `JINA_API_KEY` | `api.jina.ai` / `s.jina.ai` / `r.jina.ai` | `jina-embeddings-v3` / `jina-reranker-v3` |

```bash
export AI_GATEWAY_API_KEY=...    # 对话 LLM（多 provider：openai/deepseek/xai/google/anthropic 等）
export OPENAI_API_KEY=sk-...     # gpt-image 图像生成
export JINA_API_KEY=jina_...     # 向量记忆 + 联网搜索/抓取
python3 scripts/studio.py        # 默认绑 127.0.0.1:8765
```

## 对话陪伴（Companion）

- 后端路由：`POST /api/chat`（对话轮 + tool-calling → effects）、`POST /api/memory/compress`（记忆压缩）、`GET /api/health`。
- LLM 经 AI Gateway OpenAI 兼容端点，模型格式 `provider/model`；工具调用产出 `effects`（`motion_play` / `face_set` / `motion_stop`）由前端 `Sprite2DController` 消费，映射到 2D 动画 clip。
- 记忆：`memory-engine.js`（recentMessages / relationshipDiary / stableProfile）+ Jina 向量召回（`POST /api/memory/add` · `/api/memory/retrieve`），localStorage 持久化（`studio_chat_v1`）。
- 联网工具：`web_search` / `web_read`（Jina `s.jina.ai` / `r.jina.ai`），也可直接 `POST /api/search` · `/api/read`。
- persona 取自 `config/character_profile.json` 的 `persona` 字段。前端面板挂载于 `#chat-panel`（`templates/panels/chat-panel.js`）。

## 动作动画（Animation）

- 后端路由：`POST /api/animate`（idea/description + 网格参数 → gpt-image 生成 sprite sheet → 切帧组 GIF）、`GET /api/animations`、`GET /animations/<file>`。
- 移植自参考项目：网格模板 `create_grid_image` → `build_prompt`（img2img 结构参考）→ `slice_and_gif`（行优先切帧 + Pillow GIF）+ 续写 `synthesize_continuation_grid`；时序记录 `AnimationStore`（`animations/history.json`）。
- idea → 英文动作描述扩写走对话 LLM（AI Gateway）。前端面板挂载于 `#animation-panel`（`templates/panels/animation-panel.js`）。

## 安全（Security）

- 服务器**默认绑定 `127.0.0.1`**。`/api/chat`、`/api/animate`、`/api/search` 等是**无鉴权代理**，会消耗你的 API 额度；仅在可信网络用 `--host 0.0.0.0` 暴露（会打印警告）。
- API key 不落盘（除非显式经 `/api/settings` 写入 `runtime_settings.json`）、不回显。
