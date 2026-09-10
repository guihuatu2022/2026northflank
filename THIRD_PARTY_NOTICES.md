# 第三方组件声明

本镜像重新分发了以下第三方软件。

## sing-box

- 项目地址：<https://github.com/SagerNet/sing-box>
- 版本：由构建参数 `SING_BOX_VERSION` 固定（见 `Dockerfile`）
- 版权：Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>
- 许可证：**GNU 通用公共许可证 v3.0 或更高版本**
  （完整文本见 `third_party/sing-box-LICENSE`）

### 源码获取（GPL 义务）

sing-box 采用 GPL 授权，因此任何收到本镜像的人都有权获得对应的源代码。任一
已发布镜像中实际构建的那个版本，其完整源码位于：

    https://github.com/SagerNet/sing-box/tree/<SING_BOX_VERSION>

某个镜像所用的 `SING_BOX_VERSION` 取值，记录在
`.github/workflows/build.yml` 中。

本仓库自身新增的代码（`front/` 这个 gateway 与 `worker/` 脚本）的源码，就在
本仓库内公开发布。

### 上游附加条款

sing-box 的许可证还附带一条额外条件（原文）：

> In addition, no derivative work may use the name or imply association with
> this application without prior consent.

（中文大意：此外，未经事先同意，任何衍生作品不得使用本应用的名称，也不得暗示
与本应用存在关联。）

本项目**不隶属于**、也**未获得** SagerNet 或 sing-box 项目的背书或赞助。请勿
以任何暗示官方关系的方式重命名本镜像。

## 运行时基础镜像

- `gcr.io/distroless/static` —— Apache License 2.0
  （<https://github.com/GoogleContainerTools/distroless>）

## 仅构建期使用

- Go 工具链与 Alpine Linux 只出现在构建阶段，不会重新分发到最终镜像中。
