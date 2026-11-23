# E11 三类模板与样张收口包 · 11/23 v1

**交付状态：整理与规格检查完成，模板和新增Moment待A/C采用。未推送仓库，未验证正式生图链路。**

## 从哪里看

- [三类样张总览](review/sample-overview.png)
- [逐项检查结论](review/1123-E11-check-results-v1.md)
- [Gift模板](templates/1123-E11-Gift-template-v8-review.md)
- [Moment模板](templates/1123-E11-Moment-template-v8-review.md)
- [Scene模板](templates/1123-E11-Scene-template-v8-review.md)
- [来源、生成与后处理记录](records/1123-E11-generation-provenance-v1.md)
- [给A/C的确认请求](1123-E-给AC-请求-E11模板与样张采用确认-v1.md)
- [给WB的归档推送指令](1123-E-给WB-请求-E11归档推送-v1.md)

## 配套样张

| 类型 | 文件 | 身份 |
|---|---|---|
| Gift | samples/gift-shell-64w.png | 仓库原样图，原生成日志缺失 |
| Moment无角色 | samples/moment-shell-legacy-1200w.png | 仓库原构图夹具，非有角色验证 |
| Moment有角色 | samples/moment-r2-shell-candidate-1200w.png | 新生成r2叶披肩候选，非真实经历 |
| Scene室外 | samples/scene-bookstore-exterior-750w.png | 已交书店外景复用 |
| Scene室内 | samples/scene-bookstore-interior-750w.png | 已交书店内景复用 |

新Moment从r2清单读取S02/F01并程序合成参考，生成与修订提示词在records。初次输出、修订原图、原始用户图50/51/55/56与规范副本保留sources。未暴露的工具模型版本、seed、旧生成日期等不补造。

scene-inventory-14.json仅列原12+新2的交付来源，原12图不重复打包，本轮不重复验收。实际页面未接线及裁切问题沿用WB独立报告，不能因新图尺寸正确而记页面通过。96色是部分样张本地处理参数，不强加为全项目标准。

v8候选依据v7整理并按本轮用户决定修订旧配额、暂停地、动物例外和r2规则；不是A/C正式批准文本。AI来源标识应由产品界面保留，本包去除图片内水印不改变AI生成来源。
