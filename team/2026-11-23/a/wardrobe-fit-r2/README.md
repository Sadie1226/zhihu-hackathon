# 已批准服装 r2 · T/S/P/F 采用版

E原件保留在 `../../../2026-11-22/e/wardrobe-v5/`（源dfa1095）；本目录由A独立新增，不覆盖E当天交付。用户已通过本次8件贴合调整及帽镜r2效果；场景/任意组合/正式页面与生图并未据此全部通过。

本目录33项：T6/S9/P9/F9，F09从新版选项、清单、图层与预览中直接删除。原E备份中的F09不动。

**正式规则：** 不允许裸装；T与S恰好选一件；每类最多一件；T除F外与S/P双向互斥；P最多一件、可不选；F沿用身份表情要求，不随状态切换。选T清S/P，选S清T；T模式下先选S才能选P，P可卸下。

建议四键为outfit/cloth/accessory/face，尚未修改正式K契约。清单的modeRules/default为C修订输入，不可直接发送给当前旧API。

层序：P19双翼→底身→F→T或S→其他P；只有一个P。F01采用原中性底身，不重复叠眼；其他F使用去眼底身再叠表情。层序为A本轮判断，浏览器与服务端应消费同一计划。

调整：T01右移；T02保留帽子、微调围巾衣身；S01/S05/S06/S08贴合；P13/P16采用用户替换素材并等比缩小定位；F09删除。参数见adjustments.json，图像before-after.jpg及accessory-r2-before-after.jpg。素材均已烘焙为1024同画布，运行时偏移(0,0)，不能再次应用调整参数。

运行 `python render.py --verify`：33图层hash/尺寸，864合法选择规则，8非法输入拒绝。枚举不是864组视觉验收。原960多槽规则不再使用。

`python render.py --assembly '{"outfit":null,"cloth":"S02-leaf-cape","accessory":null,"face":"F01-neutral"}' --output example.png`

仅提供本期采用素材与可复跑渲染；正式共享Dog、四键迁移/旧装配兼容由A/C接续。不得用假jacket/happy或透明空衣绕过当前校验。
